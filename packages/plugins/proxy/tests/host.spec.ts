import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getGlobalDispatcher, fetch as undiciFetch } from 'undici'
import { installProxyFromEnvironment, proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import { assertServiceable, Config, readConfig, resolveMode } from '../src/settings.js'
import { ProxyDispatcher } from '../src/dispatcher.js'
import type { Context } from '@deepseek-ai/cordis'
import { apply, dispatch, runTest } from '../src/index.js'

const TARGET = new URL('http://proxy-target.invalid/resource')
const LOOPBACK = new URL('http://127.0.0.1:1/')
let server: Server
let proxyUrl: string
let seen: string[]
let launcherDispose: (() => Promise<void>) | undefined
let plugin: ProxyDispatcher
let base: ReturnType<typeof getGlobalDispatcher>

function lookup(values: Record<string, string>) {
  return { get: (name: string) => values[name] === undefined ? undefined : { value: values[name] } }
}

function settings(mode?: 'environment' | 'plugin' | 'direct', url = '') {
  return { mode, url, bypass: 'localhost, 127.0.0.1, ::1' }
}

async function hasRoute(expected: string | null): Promise<void> {
  const route = proxyRouteFor(TARGET)
  expect(route.proxied ? route.proxy : null).toBe(expected)
  expect(plugin.route(TARGET)).toBe(expected)
  if (expected !== null) {
    if (!route.proxied) throw new Error('expected a proxied route')
    expect(getGlobalDispatcher()).toBe(route.dispatcher)
    // 官方 web-fetch 的代理分支把同一个 route.dispatcher 显式交给 undici.fetch。
    expect((await undiciFetch(TARGET, { dispatcher: route.dispatcher })).status).toBe(200)
    // 原生 fetch 则从同一个全局 dispatcher 取路由。
    expect((await fetch(TARGET)).status).toBe(200)
    expect(seen.splice(0)).toEqual([TARGET.href, TARGET.href])
  }
}

beforeEach(async () => {
  base = getGlobalDispatcher()
  seen = []
  server = createServer((req, res) => {
    seen.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('proxy')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  launcherDispose = await installProxyFromEnvironment(lookup({ HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl }), () => {})
  plugin = new ProxyDispatcher()
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await plugin.dispose()
  await launcherDispose?.()
  expect(getGlobalDispatcher()).toBe(base)
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('three outbound modes over the official launcher policy', () => {
  it('defaults to the launch environment without mounting a second policy', async () => {
    await plugin.apply(settings())
    await hasRoute(proxyUrl)
    expect(proxyRouteFor(LOOPBACK)).toEqual({ proxied: false })
  })

  it('plugin URL wins for both paths, honors bypass, then returns to environment', async () => {
    const other = createServer((req, res) => { seen.push(`other:${req.url}`); res.end('other') })
    await new Promise<void>(resolve => other.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(other.address() as AddressInfo).port}/`
    try {
      await plugin.apply(settings('plugin', url))
      const route = proxyRouteFor(TARGET)
      expect(route).toMatchObject({ proxied: true, proxy: url })
      if (!route.proxied) throw new Error('missing route')
      expect(getGlobalDispatcher()).toBe(route.dispatcher)
      expect((await fetch(TARGET)).status).toBe(200)
      expect((await undiciFetch(TARGET, { dispatcher: route.dispatcher })).status).toBe(200)
      expect(seen.splice(0)).toEqual([`other:${TARGET.href}`, `other:${TARGET.href}`])
      expect(proxyRouteFor(LOOPBACK)).toEqual({ proxied: false })
      await plugin.apply({ ...settings('plugin', url), bypass: 'proxy-target.invalid' })
      expect(proxyRouteFor(TARGET)).toEqual({ proxied: false })
      await plugin.apply(settings('environment', url))
      await hasRoute(proxyUrl)
    } finally {
      await new Promise<void>(resolve => other.close(() => resolve()))
    }
  })

  it('force direct takes precedence over launcher policy and unload restores it', async () => {
    await plugin.apply(settings('direct', proxyUrl))
    expect(proxyRouteFor(TARGET)).toEqual({ proxied: false })
    expect(plugin.route(TARGET)).toBeNull()
    expect(getGlobalDispatcher()).not.toBe(proxyRouteFor(LOOPBACK))
    await plugin.dispose()
    await hasRoute(proxyUrl)
  })

  it('serializes rapid writes and unload without restoring a stale dispatcher', async () => {
    const writes = [plugin.apply(settings('plugin', proxyUrl)), plugin.apply(settings('direct', proxyUrl)),
      plugin.apply(settings('plugin', proxyUrl))]
    await Promise.all(writes)
    await hasRoute(proxyUrl)
    await plugin.dispose()
    await hasRoute(proxyUrl)
    await expect(plugin.apply(settings('direct'))).rejects.toThrow('disposed')
  })

  it('a rejected write keeps the current policy and allows another update', async () => {
    // 写入校验先于切换；失败不能改掉原先的直连层。
    await plugin.apply(settings('direct'))
    await expect(plugin.apply(settings('plugin', 'socks5://invalid:99'))).rejects.toThrow()
    expect(proxyRouteFor(TARGET)).toEqual({ proxied: false })
    await plugin.apply(settings('environment'))
    await hasRoute(proxyUrl)
  })
})

describe('legacy configuration and validation', () => {
  it('maps old enabled/url combinations without persisting a new mode', () => {
    expect(resolveMode({ enabled: true, url: proxyUrl, bypass: '' })).toBe('plugin')
    expect(resolveMode({ enabled: false, url: proxyUrl, bypass: '' })).toBe('direct')
    expect(resolveMode({ enabled: false, url: '', bypass: '' })).toBe('environment')
    expect(resolveMode({ enabled: true, mode: 'direct', url: proxyUrl, bypass: '' })).toBe('direct')
    const parsed = readConfig(Config({ enabled: false, url: proxyUrl, bypass: 'keep.me' }) as never)
    expect(parsed).toMatchObject({ url: proxyUrl, bypass: 'keep.me', mode: undefined })
    expect(readConfig(Config({ mode: 'environment', enabled: true, url: proxyUrl }) as never).mode).toBe('environment')
    expect(() => Config({ mode: 'unknown' } as never)).toThrow()
  })

  it('rejects invalid writes with the same validation as the client', () => {
    expect(() => assertServiceable(settings('plugin'))).toThrow('needs a proxy address')
    expect(() => assertServiceable(settings('direct', 'socks5://bad:99'))).toThrow('not a proxy address')
    expect(() => assertServiceable(settings('plugin', 'http://user:secret@proxy.test:80'))).toThrow()
    expect(() => assertServiceable(settings('plugin', '127.0.0.1:7890'))).not.toThrow()
  })

  it('test endpoint reports the requested URL route, including a bypass and failure', async () => {
    await plugin.apply(settings())
    vi.stubGlobal('fetch', vi.fn(async () => ({ status: 204, body: { cancel: vi.fn() } })))
    expect(await runTest(plugin, TARGET.href)).toMatchObject({ ok: true, via: proxyUrl })
    expect((await runTest(plugin, LOOPBACK.href)).via).toBeNull()
    expect((await runTest(plugin, 'file:///etc/passwd')).ok).toBe(false)
    expect((await dispatch(plugin, 'nope', {})).ok).toBe(false)
    expect((await dispatch(plugin, 'test', {})).ok).toBe(false)
  })
})


describe('Cordis volatile lifecycle', () => {
  it('rejects candidate writes, switches on updates, and unmounts the official layer', async () => {
    let config = { mode: undefined as 'environment' | 'plugin' | 'direct' | undefined,
      enabled: true, url: proxyUrl, bypass: '' }
    const fiber = {}
    const callbacks = new Map<string, (...args: unknown[]) => unknown>()
    let cleanup: (() => Promise<void>) | undefined
    const ctx = {
      fiber,
      logger: { info: vi.fn(), error: vi.fn() },
      on: (name: string, callback: (...args: unknown[]) => unknown) => { callbacks.set(name, callback) },
      effect: (factory: () => () => Promise<void>) => { cleanup = factory() },
      connection: { rpc: { handle: () => () => {} } },
    } as unknown as Context
    const refs = {
      mode: { get: () => config.mode }, enabled: { get: () => config.enabled },
      url: { get: () => config.url }, bypass: { get: () => config.bypass },
    }
    apply(ctx, refs as never)
    await vi.waitFor(() => expect(proxyRouteFor(TARGET).proxied).toBe(true))
    const hook = callbacks.get('internal/config')
    expect(hook).toBeDefined()
    expect(() => hook?.call(fiber, {}, () => ({ mode: 'plugin', url: '', bypass: '' })))
      .toThrow('needs a proxy address')
    expect(hook?.call({}, {}, () => 'other-fiber')).toBe('other-fiber')
    config = { mode: 'direct', enabled: true, url: proxyUrl, bypass: '' }
    callbacks.get('loader/volatile-update')?.()
    await vi.waitFor(() => expect(proxyRouteFor(TARGET)).toEqual({ proxied: false }))
    await cleanup?.()
    await hasRoute(proxyUrl)
  })
})
