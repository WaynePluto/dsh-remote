/**
 * The Host half against a fake undici, so the suite can assert the one thing
 * that matters and cannot be observed from outside: which dispatcher the
 * process is left holding, and whether the environment ever leaks into it.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

/** Every agent the code under test constructed, with the options it passed. */
const agents: { opts: Record<string, unknown>; closed: boolean }[] = []

/** The dispatcher the process currently holds; `original` is what it started with. */
const original = { name: 'original' }
let installed: unknown = original

vi.mock('undici', () => ({
  Agent: class {
    readonly kind = 'fresh-plain-agent'
  },
  EnvHttpProxyAgent: class {
    readonly opts: Record<string, unknown>
    constructor(opts: Record<string, unknown>) {
      this.opts = opts
      agents.push({ opts, closed: false })
    }

    async close(): Promise<void> {
      const record = agents.find(agent => agent.opts === this.opts)
      if (record !== undefined) record.closed = true
    }
  },
  // Reads the live value on purpose: the bug this suite guards against was a
  // dispatcher owner that trusted its own memory instead of the process.
  getGlobalDispatcher: () => installed,
  setGlobalDispatcher: (next: unknown) => { installed = next },
}))

const {
  assertServiceable,
  BAD_PAYLOAD_CODE,
  dispatch,
  normalizeBypass,
  parseProxyUrl,
  proxyFault,
  ProxyDispatcher,
  runTest,
  UNKNOWN_ENDPOINT_CODE,
  apply,
} = await import('../src/index.js')

/** A settings section with the fields this plugin owns. */
function settings(overrides: Partial<{ enabled: boolean; url: string; bypass: string }> = {}) {
  return { enabled: false, url: '', bypass: 'localhost,127.0.0.1', ...overrides }
}

beforeEach(() => {
  agents.length = 0
  installed = original
})

describe('validating the section', () => {
  it('accepts an http or https proxy address', () => {
    expect(parseProxyUrl('http://proxy.test:8080')?.hostname).toBe('proxy.test')
    expect(parseProxyUrl('https://proxy.test:8080')?.hostname).toBe('proxy.test')
  })

  it('supplies the scheme for the bare host:port people actually paste', () => {
    // The regression this fixes: `127.0.0.1:7890` is what a local proxy hands
    // out, and refusing it produced a page that silently reverted every edit.
    expect(parseProxyUrl('127.0.0.1:7890')?.toString()).toBe('http://127.0.0.1:7890/')
    expect(parseProxyUrl('proxy.test:8080')?.toString()).toBe('http://proxy.test:8080/')
    expect(parseProxyUrl(' proxy.test:8080 ')?.hostname).toBe('proxy.test')
    expect(parseProxyUrl('192.168.1.10:3128')?.hostname).toBe('192.168.1.10')
  })

  it('still refuses an address that could not be a proxy', () => {
    expect(parseProxyUrl('')).toBeUndefined()
    // A scheme that IS written must be one we can dial.
    expect(parseProxyUrl('socks5://proxy.test:1080')).toBeUndefined()
    expect(parseProxyUrl('ftp://proxy.test')).toBeUndefined()
    expect(parseProxyUrl('http://')).toBeUndefined()
    expect(parseProxyUrl('   ')).toBeUndefined()
  })

  it('refuses credentials in the address, which the settings surface would echo back', () => {
    expect(parseProxyUrl('http://user:secret@proxy.test:8080')).toBeUndefined()
    expect(parseProxyUrl('http://user@proxy.test:8080')).toBeUndefined()
    expect(parseProxyUrl('user:secret@proxy.test:8080')).toBeUndefined()
  })

  it('refuses a bad address even while the proxy is switched off', () => {
    expect(() => { assertServiceable(settings({ url: 'socks5://nope:1' })) }).toThrow('is not a proxy address')
  })

  it('refuses being switched on with no address', () => {
    expect(() => { assertServiceable(settings({ enabled: true })) }).toThrow('no address')
  })

  it('accepts a switched-off section with no address', () => {
    expect(() => { assertServiceable(settings()) }).not.toThrow()
  })

  it('answers the page with the same verdict it throws at every other writer', () => {
    // One rule set, two shapes: the browser half decides BEFORE writing because
    // a refused `SettingsScope.mutate` resolves rather than rejecting, so the
    // Host's message never reaches the page.
    expect(proxyFault(settings({ url: 'socks5://nope:1' }))).toBe('badUrl')
    expect(proxyFault(settings({ enabled: true }))).toBe('needUrl')
    expect(proxyFault(settings({ enabled: true, url: '127.0.0.1:7890' }))).toBeUndefined()
    expect(proxyFault(settings())).toBeUndefined()
  })

  it('normalizes a bypass list people actually type', () => {
    expect(normalizeBypass(' localhost, 127.0.0.1 \n ::1 ,, ')).toBe('localhost,127.0.0.1,::1')
    expect(normalizeBypass('   ')).toBe('')
  })
})

describe('owning the global dispatcher', () => {
  it('makes "off" mean direct, rather than handing control back to an ambient proxy', () => {
    // The deployment preloads an environment proxy into this process, so
    // "restore what was here" would have meant "keep proxying" — which is the
    // bug this asserts against: the page said direct, the request did not.
    const ambientProxy = { name: 'ambient env proxy' }
    installed = ambientProxy
    const dispatcher = new ProxyDispatcher()
    expect(dispatcher.apply(settings({ enabled: true, url: 'http://proxy.test:8080' })).via)
      .toBe('http://proxy.test:8080/')
    dispatcher.apply(settings({ enabled: false, url: 'http://proxy.test:8080' }))
    expect(dispatcher.current().via).toBeNull()
    expect(installed).not.toBe(ambientProxy)
    expect((installed as { kind?: string }).kind).toBe('fresh-plain-agent')
  })

  it('asserts a direct connection while off, so an ambient proxy cannot make the page lie', () => {
    // Consequence worth stating: once this plugin is loaded, an environment
    // proxy installed by anything else stops taking effect while the switch is
    // off. That is the point — the page is the single source of truth — but it
    // means the UI must be configured, not just present.
    const dispatcher = new ProxyDispatcher()
    expect(dispatcher.apply(settings())).toEqual({ via: null, bypass: 'localhost,127.0.0.1' })
    expect(agents).toEqual([])
    expect((installed as { kind?: string }).kind).toBe('fresh-plain-agent')
  })

  it('installs an agent whose every option is explicit, so the environment cannot leak in', () => {
    const dispatcher = new ProxyDispatcher()
    dispatcher.apply(settings({ enabled: true, url: 'http://proxy.test:8080', bypass: 'localhost, ::1' }))
    expect(agents).toHaveLength(1)
    expect(agents[0]?.opts).toEqual({
      httpProxy: 'http://proxy.test:8080/',
      httpsProxy: 'http://proxy.test:8080/',
      noProxy: 'localhost,::1',
    })
    expect(installed).not.toBe(original)
  })

  it('does not rebuild the agent when a write changes nothing it reads', () => {
    const dispatcher = new ProxyDispatcher()
    const on = settings({ enabled: true, url: 'http://proxy.test:8080' })
    dispatcher.apply(on)
    dispatcher.apply({ ...on })
    expect(agents).toHaveLength(1)
  })

  it('swaps the agent when the address changes, and closes the old one', () => {
    const dispatcher = new ProxyDispatcher()
    dispatcher.apply(settings({ enabled: true, url: 'http://one.test:8080' }))
    dispatcher.apply(settings({ enabled: true, url: 'http://two.test:8080' }))
    expect(agents).toHaveLength(2)
    expect(agents[0]?.closed).toBe(true)
  })

  it('installs a fresh direct agent when switched off, and stops reporting a proxy', () => {
    const dispatcher = new ProxyDispatcher()
    dispatcher.apply(settings({ enabled: true, url: 'http://proxy.test:8080' }))
    dispatcher.apply(settings({ enabled: false, url: 'http://proxy.test:8080' }))
    // NOT `original`: switching off is a statement about what the process must
    // do, not an instruction to hand control back to whatever was here first.
    expect((installed as { kind?: string }).kind).toBe('fresh-plain-agent')
    expect(dispatcher.current().via).toBeNull()
  })

  it('restores the dispatcher it found on disposal, so unloading leaves no trace', async () => {
    const dispatcher = new ProxyDispatcher()
    dispatcher.apply(settings({ enabled: true, url: 'http://proxy.test:8080' }))
    await dispatcher.dispose()
    expect(installed).toBe(original)
    expect(agents[0]?.closed).toBe(true)
  })
})

describe('surviving a reload while the proxy is on', () => {
  // The bug this section exists for, reproduced against real undici before it
  // was fixed: rebuilding the plugin while the proxy was enabled made the new
  // incarnation adopt the OLD incarnation's proxy agent as the thing to
  // "restore", so switching the proxy off reinstalled the proxy — while the
  // page reported a direct connection for a request that went through it.
  it('never adopts one of its own agents as the restore target', () => {
    const first = new ProxyDispatcher()
    first.apply(settings({ enabled: true, url: 'http://proxy.test:8080' }))

    // A reload: the new owner is constructed while the old agent is installed.
    const second = new ProxyDispatcher()
    second.apply(settings({ enabled: false, url: 'http://proxy.test:8080' }))

    expect(second.current().via).toBeNull()
    // Whatever it restored, it is not a proxy agent of ours.
    expect(agents.some(agent => agent.opts === (installed as { opts?: unknown }).opts)).toBe(false)
  })

  it('reports what the process actually does, not what it last asked for', () => {
    const first = new ProxyDispatcher()
    first.apply(settings({ enabled: true, url: 'http://proxy.test:8080' }))

    // A fresh owner that never applied anything still tells the truth, because
    // it reads the live dispatcher rather than its own memory.
    expect(new ProxyDispatcher().current().via).toBe('http://proxy.test:8080/')
  })

  it('re-installs the proxy when the live dispatcher drifted away from the settings', () => {
    const dispatcher = new ProxyDispatcher()
    const on = settings({ enabled: true, url: 'http://proxy.test:8080' })
    dispatcher.apply(on)
    // Something else replaced the dispatcher behind our back.
    installed = original
    dispatcher.apply(on)
    expect(agents).toHaveLength(2)
    expect(dispatcher.current().via).toBe('http://proxy.test:8080/')
  })
})

describe('the test endpoint', () => {
  /** A dispatcher reporting one proxy, without touching the global one. */
  function proxied(): InstanceType<typeof ProxyDispatcher> {
    const dispatcher = new ProxyDispatcher()
    dispatcher.apply(settings({ enabled: true, url: 'http://proxy.test:8080' }))
    return dispatcher
  }

  it('reports the status, the elapsed time, and which proxy carried it', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204, body: { cancel } })))
    const result = await runTest(proxied(), 'https://example.test/probe')
    expect(result).toMatchObject({ ok: true, status: 204, via: 'http://proxy.test:8080/' })
    // The body is never read: the default target is a multi-megabyte document.
    expect(cancel).toHaveBeenCalled()
  })

  it('answers with the failure instead of throwing, because a failed test is an answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('connect ECONNREFUSED') }))
    const result = await runTest(new ProxyDispatcher(), 'https://example.test/probe')
    expect(result).toMatchObject({ ok: false, via: null, error: 'connect ECONNREFUSED' })
  })

  it('refuses an address that is not http(s) before any request is made', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect((await runTest(new ProxyDispatcher(), 'file:///etc/passwd')).ok).toBe(false)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses an unknown endpoint and a payload with no url', async () => {
    const dispatcher = new ProxyDispatcher()
    const unknown = await dispatch(dispatcher, 'nope', { url: 'https://example.test' })
    expect(unknown.ok ? undefined : unknown.error.code).toBe(UNKNOWN_ENDPOINT_CODE)
    const bad = await dispatch(dispatcher, 'test', {})
    expect(bad.ok ? undefined : bad.error.code).toBe(BAD_PAYLOAD_CODE)
  })
})

describe('mounting', () => {
  it('applies the stored section at load and follows every later write', () => {
    let watcher: ((next: ReturnType<typeof settings>) => void) | undefined
    const scope = {
      get: () => settings({ enabled: true, url: 'http://boot.test:8080' }),
      watch: (callback: (next: ReturnType<typeof settings>) => void) => { watcher = callback; return () => {} },
    }
    const ctx = {
      settings: { register: vi.fn(() => scope) },
      connection: { rpc: { handle: vi.fn(() => () => {}) } },
      effect: vi.fn((factory: () => unknown) => { factory() }),
      logger: { info: vi.fn() },
    } as unknown as Context

    apply(ctx)
    expect(agents[0]?.opts).toMatchObject({ httpProxy: 'http://boot.test:8080/' })

    watcher?.(settings({ enabled: true, url: 'http://changed.test:8080' }))
    expect(agents[1]?.opts).toMatchObject({ httpProxy: 'http://changed.test:8080/' })
  })
})
