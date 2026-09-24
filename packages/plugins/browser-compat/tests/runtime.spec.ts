import { expect, it } from 'vitest'
import vm from 'node:vm'
import { browserRuntimeBootstrap, iteratorInjection } from '../src/index.js'

/** 在隔离页面里提供足够小的 AbortController 模型，验证注入脚本不是只在 Node 原生 API 上通过。 */
const RUNTIME_HARNESS = `
  class FakeSignal {
    constructor() { this.aborted = false; this.reason = undefined; this.listeners = [] }
    addEventListener(type, listener, options) {
      if (type === 'abort') this.listeners.push({ listener, once: options && options.once === true })
    }
    removeEventListener(type, listener) {
      if (type === 'abort') this.listeners = this.listeners.filter(item => item.listener !== listener)
    }
    dispatch(reason) {
      if (this.aborted) return
      this.aborted = true
      this.reason = reason
      const current = this.listeners.slice()
      for (const item of current) {
        item.listener()
        if (item.once) this.removeEventListener('abort', item.listener)
      }
    }
  }
  class FakeController {
    constructor() { this.signal = new FakeSignal() }
    abort(reason) { this.signal.dispatch(reason) }
  }
  globalThis.AbortSignal = FakeSignal
  globalThis.AbortController = FakeController
  delete Promise.withResolvers
  globalThis.Iterator = undefined
  globalThis.console = { error() {}, warn() {} }
  globalThis.CSS = { supports() { return true } }
  globalThis.structuredClone = () => ({})
  globalThis.ReadableStream = function ReadableStream() {}
  globalThis.__DSH_STATION_BROWSER_COMPAT__ = undefined;
  ${iteratorInjection().text}
  const first = new AbortController()
  const second = new AbortController()
  const combined = AbortSignal.any([first.signal, second.signal])
  second.abort('second reason')
  const deferred = Promise.withResolvers()
  deferred.resolve('resolved')
  const values = {
    combinedAborted: combined.aborted,
    combinedReason: combined.reason,
    resolved: undefined,
    capabilities: globalThis.__DSH_STATION_BROWSER_COMPAT__.getSnapshot().capabilities,
  }
  deferred.promise.then(value => { values.resolved = value })
  console.error('captured error')
  console.error('captured error')
  console.warn('captured warning')
  values
`

it('installs AbortSignal/Promise compatibility and records a bounded bridge snapshot', async () => {
  const context = vm.createContext({})
  const values = vm.runInContext(RUNTIME_HARNESS, context) as {
    combinedAborted: boolean
    combinedReason: unknown
    resolved: unknown
    capabilities: readonly { id: string, status: string }[]
  }
  await new Promise<void>(resolve => setTimeout(resolve, 0))
  const resolved = vm.runInContext(
    'globalThis.__DSH_STATION_BROWSER_COMPAT__.getSnapshot().entries[0].message',
    context,
  )
  expect(values.combinedAborted).toBe(true)
  expect(values.combinedReason).toBe('second reason')
  expect(resolved).toBe('captured error')
  expect(vm.runInContext('globalThis.__DSH_STATION_BROWSER_COMPAT__.getSnapshot().entries.length', context)).toBe(2)
  expect(vm.runInContext('globalThis.__DSH_STATION_BROWSER_COMPAT__.getSnapshot().entries[0].count', context)).toBe(2)
  vm.runInContext("for (let i = 0; i < 205; i++) globalThis.__DSH_STATION_BROWSER_COMPAT__.recordMessage('compatibility', 'unique-' + i)", context)
  expect(vm.runInContext('globalThis.__DSH_STATION_BROWSER_COMPAT__.getSnapshot().entries.length', context)).toBe(200)
  expect(values.capabilities.find(item => item.id === 'AbortSignal.any')?.status).toBe('polyfilled')
  expect(values.capabilities.find(item => item.id === 'Promise.withResolvers')?.status).toBe('polyfilled')
})

it('keeps the standalone runtime bootstrap idempotent', () => {
  const bootstrap = `(${browserRuntimeBootstrap.toString()})();`
  const context = vm.createContext({})
  const result = vm.runInContext(`
    globalThis.console = { error() {}, warn() {} };
    ${bootstrap}
    const first = globalThis.__DSH_STATION_BROWSER_COMPAT__;
    first.clear();
    ${bootstrap}
    ({ same: first === globalThis.__DSH_STATION_BROWSER_COMPAT__, count: first.getSnapshot().entries.length })
  `, context) as { same: boolean, count: number }
  expect(result).toEqual({ same: true, count: 0 })
})
