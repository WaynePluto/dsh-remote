/**
 * The Host half's decision logic, driven through `dispatch` with a scripted
 * `ctx.terminals` — no PTY, no browser, no HTTP carrier.
 *
 * The one thing a fake cannot prove is that a real shell accepts the bytes;
 * `live.spec.ts` does that against a real PTY.
 *
 * @module @dsh-remote/dsh-plugin-terminal/tests/host
 */

import type { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BAD_PAYLOAD_CODE, Config, INTERNAL_CODE, INTERACTIVE_TERMINAL_GUIDANCE, INTERACTIVE_TERMINAL_OPEN_DESCRIPTION,
  MAX_SEND_LENGTH, NOTES, UPSTREAM_TERMINAL_TOOL_NAMES, apply, applyInteractiveTerminalTools, interactiveTerminalTools,
  PWSH_READLINE_SETUP, UNKNOWN_ENDPOINT_CODE, backendConfig, dispatch, installStartupRetry, isSendActive,
  pwshShellArgs, resetInFlight, resolveDialect, sendToTerminal, snapshot, toView,
} from '../src/index.js'

/**
 * Resolve a configuration the way cordis does before `apply` sees it.
 * @param overrides - the fields a test cares about.
 * @returns the resolved configuration.
 */
function resolved(overrides: Record<string, unknown> = {}): Config {
  return new (Config as unknown as new (value: unknown) => Config)(overrides)
}

/** The resolved configuration every test starts from. */
const config = resolved()

/** One scripted PTY session. */
interface FakeSession {
  sessionId: string
  name?: string
  type: string
  pid?: number
  status: { kind: 'running' } | { kind: 'exited', exitCode: number | null, signal: null }
}

/** A settled send operation the registry would have returned. */
function operation() {
  return { done: Promise.resolve({}), readOutput: () => ({ delta: '', truncated: false }), cancel: () => false }
}

/** Everything the fake registry recorded, so a test can assert on the write. */
interface Recorder {
  sends: { id: string, text: string, submit: boolean }[]
  signals: string[]
}

/**
 * Build a Context that answers exactly what these tests script.
 * @param options - the sessions, the screen, and the failures to inject.
 * @returns the fake context and its recorder.
 */
function fakeContext(options: {
  sessions?: FakeSession[]
  agent?: unknown
  terminals?: boolean
  text?: string
  totalLines?: number
  sendThrows?: unknown[]
  signalThrows?: unknown
} = {}): { ctx: Context, recorder: Recorder } {
  const sessions = options.sessions ?? []
  const recorder: Recorder = { sends: [], signals: [] }
  const throwQueue = [...options.sendThrows ?? []]
  const agent = options.agent === undefined ? { id: 'session-1' } : options.agent
  const registry = {
    list: () => sessions,
    read: () => ({
      text: options.text ?? '',
      totalLines: options.totalLines ?? 0,
      lineBegin: 0,
      lineEnd: 0,
      truncated: false,
    }),
    startSend: (_owner: unknown, id: string, request: { text: string, submit: boolean }) => {
      if (throwQueue.length > 0) throw throwQueue.shift()
      recorder.sends.push({ id, text: request.text, submit: request.submit })
      return operation()
    },
    signal: async (_owner: unknown, id: string) => {
      if (options.signalThrows !== undefined) throw options.signalThrows
      recorder.signals.push(id)
      return await Promise.resolve({ delivered: true as const, targetPgid: 4242 })
    },
  }
  const ctx = {
    get: (name: string) => name === 'terminals' ? (options.terminals === false ? undefined : registry) : undefined,
    agents: { get: () => agent },
  } as unknown as Context
  return { ctx, recorder }
}

/** A running session, as the registry reports one. */
const running: FakeSession = { sessionId: 'pty-1', type: 'shell', status: { kind: 'running' }, pid: 4321 }

beforeEach(() => { resetInFlight() })

describe('installStartupRetry', () => {
  /**
   * A context whose registry fails a scripted number of opens.
   * @param failures - how many attempts throw before one succeeds.
   * @returns the context, the registry, and the attempt record.
   */
  function flakyRegistry(failures: number) {
    const state = { attempts: 0, signals: [] as (AbortSignal | undefined)[] }
    const registry = {
      spawn: async (_owner: unknown, _request: unknown, signal?: AbortSignal) => {
        state.attempts += 1
        state.signals.push(signal)
        if (state.attempts <= failures) throw new Error('PTY shell did not reach readiness before startup timeout')
        return await Promise.resolve({ sessionId: 'pty-1' })
      },
    }
    const ctx = { get: () => registry } as unknown as Context
    return { ctx, registry, state }
  }

  /** A sleep that records instead of waiting. */
  const noSleep = () => vi.fn(async () => { await Promise.resolve() })

  it('retries a flaky open until it succeeds', async () => {
    // dsh's pwsh readiness probe fails intermittently and there is no seam to
    // intercept `terminal_open`, so the retry lives on the registry this plugin
    // mounted. A failed open is not degraded service — it is no terminal.
    const { ctx, registry, state } = flakyRegistry(2)
    const sleep = noSleep()
    installStartupRetry(ctx, resolved({ startupAttempts: 3 }), sleep)
    await expect(registry.spawn({}, {})).resolves.toStrictEqual({ sessionId: 'pty-1' })
    expect(state.attempts).toBe(3)
    expect(sleep).toHaveBeenCalledTimes(2)
  })

  it('gives every attempt its own deadline, so a long send bound is not a long open', async () => {
    const { ctx, registry, state } = flakyRegistry(0)
    installStartupRetry(ctx, resolved({ startupTimeoutMs: 1234 }), noSleep())
    await registry.spawn({}, {})
    expect(state.signals[0]).toBeInstanceOf(AbortSignal)
  })

  it('rethrows the last failure when every attempt fails', async () => {
    const { ctx, registry, state } = flakyRegistry(99)
    installStartupRetry(ctx, resolved({ startupAttempts: 2 }), noSleep())
    await expect(registry.spawn({}, {})).rejects.toThrow('did not reach readiness')
    expect(state.attempts).toBe(2)
  })

  it('never retries past a caller that gave up', async () => {
    const { ctx, registry, state } = flakyRegistry(99)
    installStartupRetry(ctx, resolved({ startupAttempts: 5 }), noSleep())
    await expect(registry.spawn({}, {}, AbortSignal.abort())).rejects.toThrow()
    expect(state.attempts).toBe(0)
  })

  it('restores the original method on teardown', () => {
    const { ctx, registry } = flakyRegistry(0)
    const before = registry.spawn
    const dispose = installStartupRetry(ctx, resolved(), noSleep())
    expect(registry.spawn).not.toBe(before)
    dispose()
    expect(registry.spawn).toBe(before)
  })

  it('does nothing when the registry is not mounted', () => {
    const ctx = { get: () => undefined } as unknown as Context
    expect(() => { installStartupRetry(ctx, resolved(), noSleep())() }).not.toThrow()
  })
})

describe('resolveDialect', () => {
  it('follows the platform when set to auto, exactly as dsh does', () => {
    expect(resolveDialect('auto', 'win32')).toBe('pwsh')
    expect(resolveDialect('auto', 'linux')).toBe('bash')
    expect(resolveDialect('auto', 'darwin')).toBe('bash')
  })

  it('never overrides an explicit dialect', () => {
    expect(resolveDialect('bash', 'win32')).toBe('bash')
    expect(resolveDialect('pwsh', 'linux')).toBe('pwsh')
  })
})

describe('backendConfig', () => {
  it('starts pwsh without PSReadLine at all', () => {
    // Not cosmetic. PSReadLine repaints the input line, which reorders dsh's
    // prompt marker relative to the prompt text the backend waits for, and it
    // writes the user's shell history, which feeds the same bootstrap line back
    // as ghost text on the next run. Measured 500ms apart on one machine:
    // dsh's default argv opened 7 sessions in 10; with this argv, 20 in 20.
    const backend = backendConfig(resolved(), 'win32')
    expect(backend.shellDialect).toBe('pwsh')
    expect(backend.shellArgs).toStrictEqual(pwshShellArgs())
    expect(backend.shellArgs).toContain('-NoProfile')
    // `-NoExit` is what keeps `-Command` from being a one-shot; without it pwsh
    // would run the statement and exit instead of becoming a terminal.
    expect(backend.shellArgs).toContain('-NoExit')
    expect(PWSH_READLINE_SETUP).toContain('Remove-Module PSReadLine')
    // A pwsh without PSReadLine must still reach a prompt rather than printing
    // a red error as the first thing in the transcript.
    expect(PWSH_READLINE_SETUP).toContain('SilentlyContinue')
  })

  it('leaves bash on the defaults dsh itself ships', () => {
    const backend = backendConfig(resolved(), 'linux')
    expect(backend.shellDialect).toBe('bash')
    expect(backend.shellArgs).toBeUndefined()
  })

  it('lets a deployment turn the hardening off', () => {
    expect(backendConfig(resolved({ hardenPwshReadLine: false }), 'win32').shellArgs).toBeUndefined()
  })

  it('passes an explicit argv through untouched, hardening or not', () => {
    const custom = ['-NoLogo', '-NoProfile', '-Login']
    expect(backendConfig(resolved({ shellArgs: custom }), 'win32').shellArgs).toStrictEqual(custom)
    expect(backendConfig(resolved({ shellArgs: custom }), 'linux').shellArgs).toStrictEqual(custom)
  })

  it('forwards the send bound to the backend', () => {
    expect(backendConfig(resolved({ timeoutMs: 1234 }), 'linux').timeoutMs).toBe(1234)
  })
})

describe('isSendActive', () => {
  it('recognises the registry refusal by its published code', () => {
    expect(isSendActive(Object.assign(new Error('busy'), { code: 'SEND_ACTIVE' }))).toBe(true)
  })

  it('does not swallow any other failure', () => {
    expect(isSendActive(new Error('boom'))).toBe(false)
    expect(isSendActive(Object.assign(new Error('x'), { code: 'NO_SESSION' }))).toBe(false)
    expect(isSendActive(undefined)).toBe(false)
    expect(isSendActive('SEND_ACTIVE')).toBe(false)
  })
})

describe('toView', () => {
  it('reports a running session without an exit code', () => {
    const view = toView({ ...running, name: 'build' } as never, false)
    expect(view).toStrictEqual({ id: 'pty-1', name: 'build', type: 'shell', pid: 4321, running: true, sending: false })
  })

  it('carries the exit code once the shell is gone', () => {
    const view = toView({ sessionId: 'pty-2', type: 'shell', status: { kind: 'exited', exitCode: 3, signal: null } } as never, false)
    expect(view).toMatchObject({ id: 'pty-2', running: false, exitCode: 3 })
  })

  it('reports a send this plugin has in flight', () => {
    expect(toView(running as never, true).sending).toBe(true)
  })
})

describe('snapshot', () => {
  it('says which kind of nothing it is showing', () => {
    expect(snapshot(fakeContext({ terminals: false }).ctx, 'session-1', 7)).toStrictEqual({
      terminals: [], unavailable: 'no-service', now: 7,
    })
    expect(snapshot(fakeContext({ agent: undefined as never }).ctx, 'session-1', 7).unavailable).toBeUndefined()
  })

  it('reports no-agent for a conversation with nothing running', () => {
    const ctx = {
      get: () => ({ list: () => [] }),
      agents: { get: () => undefined },
    } as unknown as Context
    expect(snapshot(ctx, 'cold', 7)).toStrictEqual({ terminals: [], unavailable: 'no-agent', now: 7 })
  })

  it('maps the live sessions of the owning agent', () => {
    const { ctx } = fakeContext({ sessions: [running] })
    expect(snapshot(ctx, 'session-1', 7)).toStrictEqual({
      terminals: [{ id: 'pty-1', type: 'shell', pid: 4321, running: true, sending: false }],
      now: 7,
    })
  })
})

describe('dispatch: guards', () => {
  it('refuses an endpoint this channel does not serve', async () => {
    const { ctx } = fakeContext()
    const result = await dispatch(ctx, 'open', { sessionId: 's' }, config)
    expect(result).toMatchObject({ ok: false, error: { code: UNKNOWN_ENDPOINT_CODE } })
  })

  it('refuses a malformed payload before touching the registry', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    const result = await dispatch(ctx, 'send', { sessionId: 's' }, config)
    expect(result).toMatchObject({ ok: false, error: { code: BAD_PAYLOAD_CODE } })
    expect(recorder.sends).toHaveLength(0)
  })

  it('turns an unexpected throw into a coded failure rather than a stack trace', async () => {
    const ctx = {
      get: () => ({ list: () => { throw new Error('registry exploded') } }),
      agents: { get: () => ({ id: 's' }) },
    } as unknown as Context
    const result = await dispatch(ctx, 'list', { sessionId: 's' }, config)
    expect(result).toMatchObject({ ok: false, error: { code: INTERNAL_CODE, message: 'registry exploded' } })
  })
})

describe('dispatch: read', () => {
  it('answers unchanged, and without the screen, when the revision matches', async () => {
    const { ctx } = fakeContext({ sessions: [running], text: 'hello', totalLines: 1 })
    const first = await dispatch(ctx, 'read', { sessionId: 's', terminalId: 'pty-1' }, config)
    const revision = (first as { value: { revision: string } }).value.revision
    expect((first as { value: { text: string } }).value.text).toBe('hello')

    const second = await dispatch(ctx, 'read', { sessionId: 's', terminalId: 'pty-1', revision }, config)
    expect((second as { value: unknown }).value).toMatchObject({ unchanged: true, text: '', running: true })
  })

  it('reports a terminal the registry no longer lists as not running', async () => {
    const { ctx } = fakeContext({ sessions: [], text: 'leftovers', totalLines: 1 })
    const result = await dispatch(ctx, 'read', { sessionId: 's', terminalId: 'pty-9' }, config)
    expect((result as { value: unknown }).value).toMatchObject({ running: false })
  })

  it('renders the "not ready" sentence instead of failing when the service is absent', async () => {
    const { ctx } = fakeContext({ terminals: false })
    const result = await dispatch(ctx, 'read', { sessionId: 's', terminalId: 'pty-1' }, config)
    expect((result as { value: { text: string } }).value.text).toBe(NOTES.noService)
  })
})

describe('sendToTerminal', () => {
  it('writes the text and submits by default', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    const result = await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: 'hunter2' }, config)
    expect(result).toStrictEqual({ ok: true, message: NOTES.sent })
    expect(recorder.sends).toStrictEqual([{ id: 'pty-1', text: 'hunter2', submit: true }])
  })

  it('sends a bare Enter, which is how a prompt gets its default answer', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: '', submit: true }, config)
    expect(recorder.sends).toStrictEqual([{ id: 'pty-1', text: '', submit: true }])
  })

  it('refuses a send that would write nothing at all', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    const result = await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: '', submit: false }, config)
    expect(result).toStrictEqual({ ok: false, message: NOTES.nothingToSend })
    expect(recorder.sends).toHaveLength(0)
  })

  it('caps one send rather than shipping a paste of arbitrary size', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    const result = await sendToTerminal(ctx, {
      sessionId: 's', terminalId: 'pty-1', text: 'x'.repeat(MAX_SEND_LENGTH + 1),
    }, config)
    expect(result).toStrictEqual({ ok: false, message: NOTES.tooLong(MAX_SEND_LENGTH) })
    expect(recorder.sends).toHaveLength(0)
  })

  it('waits out a busy session instead of bouncing the keystroke', async () => {
    // The registry allows one active send and throws on the second. A password
    // typed while the model's own send is still settling must land once the
    // shell frees up, not be lost.
    const busy = Object.assign(new Error('already has an active send'), { code: 'SEND_ACTIVE' })
    const { ctx, recorder } = fakeContext({ sessions: [running], sendThrows: [busy, busy] })
    const wait = vi.fn(async () => { await Promise.resolve() })
    const result = await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: 'pw' }, config, wait)
    expect(result.ok).toBe(true)
    expect(wait).toHaveBeenCalledTimes(2)
    expect(recorder.sends).toStrictEqual([{ id: 'pty-1', text: 'pw', submit: true }])
  })

  it('gives up with busy: true, so the page keeps the draft', async () => {
    const busy = Object.assign(new Error('already has an active send'), { code: 'SEND_ACTIVE' })
    const { ctx, recorder } = fakeContext({
      sessions: [running],
      sendThrows: Array.from({ length: 50 }, () => busy),
    })
    const zeroWait = resolved({ sendWaitMs: 0 })
    const result = await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: 'pw' }, zeroWait)
    expect(result.ok).toBe(false)
    expect(result.busy).toBe(true)
    expect(recorder.sends).toHaveLength(0)
  })

  it('reports any other registry failure verbatim and does not retry it', async () => {
    const gone = Object.assign(new Error('unknown PTY session pty-9'), { code: 'NO_SESSION' })
    const { ctx } = fakeContext({ sessions: [running], sendThrows: [gone] })
    const wait = vi.fn(async () => { await Promise.resolve() })
    const result = await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-9', text: 'x' }, config, wait)
    expect(result).toStrictEqual({ ok: false, message: 'unknown PTY session pty-9' })
    expect(wait).not.toHaveBeenCalled()
  })

  it('marks the session as sending while its operation is in flight', async () => {
    let settle: () => void = () => {}
    const pending = new Promise<void>(resolve => { settle = resolve })
    const ctx = {
      get: () => ({
        list: () => [running],
        startSend: () => ({ done: pending, readOutput: () => ({ delta: '', truncated: false }), cancel: () => false }),
      }),
      agents: { get: () => ({ id: 's' }) },
    } as unknown as Context
    await sendToTerminal(ctx, { sessionId: 's', terminalId: 'pty-1', text: 'x' }, config)
    expect(snapshot(ctx, 's').terminals[0]?.sending).toBe(true)
    settle()
    await pending
    await Promise.resolve()
    expect(snapshot(ctx, 's').terminals[0]?.sending).toBe(false)
  })
})

describe('dispatch: interrupt', () => {
  it('signals the foreground process group and names it', async () => {
    const { ctx, recorder } = fakeContext({ sessions: [running] })
    const result = await dispatch(ctx, 'interrupt', { sessionId: 's', terminalId: 'pty-1' }, config)
    expect((result as { value: unknown }).value).toStrictEqual({ ok: true, message: NOTES.interrupted(4242) })
    expect(recorder.signals).toStrictEqual(['pty-1'])
  })

  it('reports a refusal instead of throwing out of the channel', async () => {
    const { ctx } = fakeContext({ sessions: [running], signalThrows: new Error('session is closing') })
    const result = await dispatch(ctx, 'interrupt', { sessionId: 's', terminalId: 'pty-1' }, config)
    expect((result as { value: unknown }).value).toStrictEqual({ ok: false, message: 'session is closing' })
  })
})
describe('interactive terminal tool wrapper', () => {
  function recordingContext() {
    const tools: { name: string, description?: string }[] = []
    const sections: { name: string, text: string }[] = []
    const ctx = {
      terminals: {},
      tools: { register: (tool: { name: string, description?: string }) => { tools.push(tool) } },
      systemPrompt: {
        getSectionOrder: () => 10,
        section: (section: { name: string, text: string }) => { sections.push(section) },
      },
    } as unknown as Context
    return { ctx, tools, sections }
  }
  it('publishes exactly the six interactive names and no raw terminal names', () => {
    const { ctx, tools, sections } = recordingContext()
    applyInteractiveTerminalTools(ctx)
    expect(tools.map(tool => tool.name)).toStrictEqual(
      UPSTREAM_TERMINAL_TOOL_NAMES.map(name => `interactive_${name}`),
    )
    expect(tools.some(tool => UPSTREAM_TERMINAL_TOOL_NAMES.includes(tool.name as never))).toBe(false)
    const send = tools.find(tool => tool.name === 'interactive_terminal_send') as Record<string, unknown>
    expect(JSON.stringify(send.parameters)).toContain('interactive_terminal_open')
    expect(JSON.stringify(send.parameters)).toContain('interactive_terminal_list')
    expect(typeof send.execute).toBe('function')
    expect(send.output).toBeDefined()
    expect(tools.every(tool => tool.description?.toLowerCase().includes('interactive terminal') === true)).toBe(true)
    expect(sections).toHaveLength(1)
  })
  it('replaces the prompt and open description with the strict one-shot prohibition', () => {
    const { ctx, tools, sections } = recordingContext()
    applyInteractiveTerminalTools(ctx)
    expect(sections[0]?.text).toBe(INTERACTIVE_TERMINAL_GUIDANCE)
    expect(sections[0]?.text).toMatch(/Git, builds, tests, and scripts/)
    expect(sections[0]?.text).toMatch(/always use pwsh or bash/)
    expect(sections[0]?.text).toMatch(/long time is not by itself a reason/)
    expect(sections[0]?.text).toContain('run_in_background')
    const open = tools.find(tool => tool.name === 'interactive_terminal_open')
    expect(open?.description).toBe(INTERACTIVE_TERMINAL_OPEN_DESCRIPTION)
    expect(open?.description).toMatch(/Never use this for ordinary one-shot commands/)
    expect(open?.description).toContain('run_in_background')
  })
  it.each([
    ['missing', UPSTREAM_TERMINAL_TOOL_NAMES.slice(0, -1)],
    ['duplicate', [...UPSTREAM_TERMINAL_TOOL_NAMES.slice(0, -1), 'terminal_open']],
    ['unknown', [...UPSTREAM_TERMINAL_TOOL_NAMES, 'terminal_surprise']],
  ])('fails closed on %s registrations before anything leaks', (_case, names) => {
    const { ctx, tools, sections } = recordingContext()
    const upstream = (facade: Context) => {
      (facade as unknown as { systemPrompt: { section: (value: unknown) => void } }).systemPrompt.section({ name: 'tool:pty', order: 10, text: 'upstream' })
      for (const name of names) (facade as unknown as { tools: { register: (value: unknown) => void } }).tools.register({ name, description: name } as never)
    }
    expect(() => { applyInteractiveTerminalTools(ctx, {}, upstream) }).toThrow(/rejected registrations/)
    expect(tools).toHaveLength(0)
    expect(sections).toHaveLength(0)
  })
  it('preserves upstream inject and Config and is what the main plugin mounts', () => {
    expect(interactiveTerminalTools.inject).toBeDefined()
    expect(interactiveTerminalTools.Config).toBeDefined()
    const plugins: unknown[] = []
    const ctx = {
      plugin: (plugin: unknown) => { plugins.push(plugin) },
      connection: { rpc: { handle: () => () => {} } },
      effect: () => {},
    } as unknown as Context
    apply(ctx, resolved({ mountBackend: false, mountTools: true }))
    expect(plugins).toStrictEqual([interactiveTerminalTools])
  })
})
