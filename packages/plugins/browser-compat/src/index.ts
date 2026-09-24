/**
 * dsh-station 插件：为缺少新 Web 平台 API 的浏览器垫平 dsh 前端运行所需的最低集合。
 *
 * 背景：dsh 前端官方 bundle（如 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
 * 内联的 pdf.js）会在模块顶层引用 `Iterator` 全局（ES2025 Iterator helpers）。
 * Safari 18.4 之前的 WebKit 没有这个全局，模块求值直接抛
 * “Can't find variable: Iterator”，整个插件加载失败，dsh Web UI 无法启动。
 * 本插件通过 `webserver/index-inject` 的内联 script 行在页面启动前安装
 * 已确认的 Web API 垫片，并建立只存在于当前页面内存的诊断桥；原生实现已存在时不做任何事。
 *
 * 只在 dsh-station-web profile 生效，不改官方 web profile，也不触碰 relay
 * 的字节转发（铁律 3、铁律 9）。
 *
 * @module @dsh-station/dsh-plugin-browser-compat
 */

import type { Context } from '@deepseek-ai/cordis'
// 合并，使 `webserver/index-inject` 出现在本模块 Events 视图中。仅类型导入，
// 产出的插件仍是无依赖单文件。
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-station-browser-compat'

/** 需要等待 web server：注入表在每次渲染 index.html 时重新收集。 */
export const inject = ['webServer']

/**
 * 安装 Iterator helpers 的等价实现。
 *
 * ⚠️ 本函数体会被 `toString()` 序列化后注入 dsh 页面（见 {@link iteratorInjection}），
 * 因此必须完全自包含：不得引用任何模块级标识符（import、外部常量都不行），
 * 构建器压缩改名没关系，但不得依赖模块作用域。行为对齐 ES2025 iterator-helpers
 * 的常用子集：原型方法 map/filter/take/drop/flatMap/reduce/toArray/forEach/some/
 * every/find/join，以及 `Iterator.from`；规范里“提前退出时通知内层 return”
 * 的 close 语义同样实现。
 */
export function iteratorPolyfill(): void {
  const globalObject = globalThis as {
    Iterator?: unknown
    __DSH_STATION_ITERATOR_POLYFILLED__?: boolean
  }
  interface IteratorLike {
    next(...args: unknown[]): { done?: boolean, value?: unknown }
    return?(value?: unknown): unknown
  }

  /** 内层游标：统一 done 语义，并集中处理提前退出时的 close。 */
  interface Cursor {
    next(): { done?: boolean, value?: unknown }
    close(): void
  }

  /** step 的四种结果：skip 要下一个输入、stop 结束并 close、value 直接产出、emit 展开子迭代。 */
  interface StepOutcome {
    skip?: boolean
    stop?: boolean
    value?: unknown
    emit?: unknown
  }

  function cursorOf(source: unknown): Cursor {
    const sourceRecord = source as { next?: unknown, [Symbol.iterator]?: () => unknown } | null
    const iterator = (
      typeof sourceRecord?.next === 'function'
        ? source
        : sourceRecord?.[Symbol.iterator]?.()
    ) as IteratorLike | undefined
    if (iterator === undefined || typeof iterator.next !== 'function') {
      throw new TypeError('Value is not an iterator or iterable')
    }
    let exhausted = false
    return {
      next(): { done?: boolean, value?: unknown } {
        if (exhausted) return { done: true, value: undefined }
        const result = iterator.next()
        if (result.done) exhausted = true
        return result
      },
      close(): void {
        if (!exhausted) {
          exhausted = true
          iterator.return?.()
        }
      },
    }
  }

  const existingIterator = globalObject.Iterator as {
    from?: unknown
    prototype?: Record<PropertyKey, unknown>
  } | undefined
  const helperNames = ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find']
  const hasNativeHelpers = typeof existingIterator?.from === 'function'
    && helperNames.every(helperName => typeof existingIterator.prototype?.[helperName] === 'function')

  let patchedNativeJoin = false
  if (hasNativeHelpers && existingIterator?.prototype !== undefined
    && typeof existingIterator.prototype.join !== 'function') {
    try {
      Object.defineProperty(existingIterator.prototype, 'join', {
        configurable: true,
        writable: true,
        value: function join(this: unknown, separator?: string): string {
          const source = cursorOf(this)
          const glue = separator ?? ','
          let text = ''
          let first = true
          for (;;) {
            const result = source.next()
            if (result.done) return text
            text = first ? String(result.value) : text + glue + String(result.value)
            first = false
          }
        },
      })
      patchedNativeJoin = true
    } catch {
      // 原生原型不可扩展时继续安装隔离的兼容实现。
    }
  }

  if (hasNativeHelpers && typeof existingIterator?.prototype?.join === 'function') {
    if (patchedNativeJoin) globalObject.__DSH_STATION_ITERATOR_POLYFILLED__ = true
    return
  }

  /** helpers 结果共享的原型：使 map/filter 等可以链式调用。 */
  const iteratorPrototype = {} as Record<PropertyKey, unknown>

  function define(key: PropertyKey, value: unknown): void {
    Object.defineProperty(iteratorPrototype, key, { value, writable: true, configurable: true })
  }

  function helperFrom(source: Cursor, step: (value: unknown) => StepOutcome): unknown {
    let sub: Cursor | undefined
    const handle = {
      next(): { done: boolean, value: unknown } {
        for (;;) {
          if (sub !== undefined) {
            const fromSub = sub.next()
            if (!fromSub.done) return { done: false, value: fromSub.value }
            sub.close()
            sub = undefined
          }
          const fromSource = source.next()
          if (fromSource.done) return { done: true, value: undefined }
          const outcome = step(fromSource.value)
          if (outcome.skip === true) continue
          if (outcome.stop === true) {
            source.close()
            return { done: true, value: undefined }
          }
          if ('emit' in outcome) {
            sub = cursorOf(outcome.emit)
            continue
          }
          return { done: false, value: outcome.value }
        }
      },
      return(value: unknown): { done: boolean, value: unknown } {
        sub?.close()
        source.close()
        return { done: true, value }
      },
    } as Record<PropertyKey, unknown>
    Object.setPrototypeOf(handle, iteratorPrototype)
    return handle
  }

  define(Symbol.iterator, function iterator(this: unknown): unknown {
    return this
  })

  define('map', function map(this: unknown, mapper: (value: unknown) => unknown): unknown {
    return helperFrom(cursorOf(this), value => ({ value: mapper(value) }))
  })

  define('filter', function filter(this: unknown, predicate: (value: unknown) => boolean): unknown {
    return helperFrom(cursorOf(this), value => predicate(value) ? { value } : { skip: true })
  })

  define('take', function take(this: unknown, count: number): unknown {
    let remaining = count
    return helperFrom(cursorOf(this), (value) => {
      if (remaining <= 0) return { stop: true }
      remaining -= 1
      return { value }
    })
  })

  define('drop', function drop(this: unknown, count: number): unknown {
    let remaining = count
    return helperFrom(cursorOf(this), (value) => {
      if (remaining > 0) {
        remaining -= 1
        return { skip: true }
      }
      return { value }
    })
  })

  define('flatMap', function flatMap(this: unknown, mapper: (value: unknown) => unknown): unknown {
    return helperFrom(cursorOf(this), value => ({ emit: mapper(value) }))
  })

  define('reduce', function reduce(
    this: unknown,
    reducer: (accumulator: unknown, value: unknown) => unknown,
    ...initial: unknown[]
  ): unknown {
    const source = cursorOf(this)
    let accumulator: unknown
    if (initial.length > 0) {
      accumulator = initial[0]
    } else {
      const first = source.next()
      if (first.done) throw new TypeError('Reduce of empty iterator with no initial value')
      accumulator = first.value
    }
    for (;;) {
      const result = source.next()
      if (result.done) return accumulator
      accumulator = reducer(accumulator, result.value)
    }
  })

  define('toArray', function toArray(this: unknown): unknown[] {
    const source = cursorOf(this)
    const values: unknown[] = []
    for (;;) {
      const result = source.next()
      if (result.done) return values
      values.push(result.value)
    }
  })

  define('forEach', function forEach(this: unknown, consumer: (value: unknown) => void): void {
    const source = cursorOf(this)
    for (;;) {
      const result = source.next()
      if (result.done) return
      consumer(result.value)
    }
  })

  define('some', function some(this: unknown, predicate: (value: unknown) => boolean): boolean {
    const source = cursorOf(this)
    for (;;) {
      const result = source.next()
      if (result.done) return false
      if (predicate(result.value)) {
        source.close()
        return true
      }
    }
  })

  define('every', function every(this: unknown, predicate: (value: unknown) => boolean): boolean {
    const source = cursorOf(this)
    for (;;) {
      const result = source.next()
      if (result.done) return true
      if (!predicate(result.value)) {
        source.close()
        return false
      }
    }
  })

  define('find', function find(this: unknown, predicate: (value: unknown) => boolean): unknown {
    const source = cursorOf(this)
    for (;;) {
      const result = source.next()
      if (result.done) return undefined
      if (predicate(result.value)) {
        source.close()
        return result.value
      }
    }
  })

  define('join', function join(this: unknown, separator?: string): string {
    const source = cursorOf(this)
    const glue = separator ?? ','
    let text = ''
    let first = true
    for (;;) {
      const result = source.next()
      if (result.done) return text
      text = first ? String(result.value) : text + glue + String(result.value)
      first = false
    }
  })

  function iteratorFrom(value: unknown): unknown {
    if (value !== null && (typeof value === 'object' || typeof value === 'function')) {
      const record = value as { next?: unknown, [Symbol.iterator]?: unknown }
      const inner = typeof record.next === 'function'
        ? value
        : typeof record[Symbol.iterator] === 'function'
          ? (record[Symbol.iterator] as () => unknown)()
          : undefined
      if (inner !== undefined && typeof (inner as IteratorLike).next === 'function') {
        const wrapped = {
          next(...args: unknown[]) {
            return (inner as IteratorLike).next(...args)
          },
          ...typeof (inner as IteratorLike).return === 'function'
            ? {
                return(allocation?: unknown) {
                  return (inner as IteratorLike).return?.(allocation)
                },
              }
            : {},
        } as Record<PropertyKey, unknown>
        Object.setPrototypeOf(wrapped, iteratorPrototype)
        return wrapped
      }
    }
    throw new TypeError('Iterator.from expects an iterable or an iterator')
  }

  // oxlint-disable-next-line consistent-function-scoping -- 该函数必须留在可序列化的补丁函数体内。
  // oxlint-disable-next-line consistent-function-scoping -- 该函数必须留在可序列化的补丁函数体内。
  function abstractBase(): void {
    throw new TypeError('Iterator is not a constructor')
  }
  const Iterator = abstractBase as unknown as { readonly prototype: unknown }
  Object.defineProperty(Iterator, 'prototype', { value: iteratorPrototype, writable: false, configurable: false })
  Object.defineProperty(iteratorPrototype, 'constructor', { value: Iterator, writable: true, configurable: true })
  Object.defineProperty(iteratorPrototype, Symbol.toStringTag, { value: 'Iterator', writable: false, configurable: true })
  Object.defineProperty(Iterator, 'from', { value: iteratorFrom, writable: true, configurable: true })
  globalObject.Iterator = Iterator
  globalObject.__DSH_STATION_ITERATOR_POLYFILLED__ = true
}

/**
 * 安装旧 WebKit 仍会被 dsh 页面使用的 Web API，并建立临时诊断桥。
 *
 * ⚠️ 本函数体也会被 `toString()` 序列化后注入页面，必须完全自包含。
 * 它不保存 Error、Console 参数或请求对象，只保留有界的文本快照；原始
 * console 方法和浏览器事件仍照常工作。
 */
export function browserRuntimeBootstrap(): void {
  const globalObject = globalThis as {
    AbortController?: unknown
    AbortSignal?: unknown
    Promise?: unknown
    Iterator?: unknown
    structuredClone?: unknown
    ReadableStream?: unknown
    queueMicrotask?: unknown
    CSS?: unknown
    console?: unknown
    DOMException?: unknown
    location?: { href?: unknown }
    URL?: unknown
    setTimeout?: (handler: () => void, timeout?: number) => unknown
    clearTimeout?: (handle: unknown) => void
    addEventListener?: (type: string, listener: (event: unknown) => void, options?: unknown) => void
    __DSH_STATION_BROWSER_COMPAT__?: unknown
    __DSH_STATION_ITERATOR_POLYFILLED__?: boolean
  }

  const existing = globalObject.__DSH_STATION_BROWSER_COMPAT__
  if (existing !== null && typeof existing === 'object'
    && (existing as { version?: unknown }).version === 1) return

  interface SignalLike {
    aborted: boolean
    reason?: unknown
    addEventListener: (type: string, listener: () => void, options?: unknown) => void
    removeEventListener: (type: string, listener: () => void) => void
  }

  interface ControllerLike {
    signal: SignalLike
    abort: (reason?: unknown) => void
  }

  interface SignalConstructorLike {
    prototype: Record<PropertyKey, unknown>
    any?: unknown
    timeout?: unknown
  }

  interface ControllerConstructorLike {
    new (): ControllerLike
  }

  interface PromiseConstructorLike {
    new <T>(executor: (
      resolve: (value: T | PromiseLike<T>) => void,
      reject: (reason?: unknown) => void,
    ) => void): Promise<T>
    withResolvers?: unknown
  }

  interface CapabilityLike {
    id: string
    kind: 'js' | 'css'
    required: boolean
    status: 'native' | 'polyfilled' | 'missing'
  }

  interface EntryLike {
    id: number
    level: 'error' | 'warning'
    source: string
    message: string
    stack?: string
    context?: string
    firstAt: number
    lastAt: number
    count: number
  }

  interface SnapshotLike {
    startedAt: number
    entries: readonly EntryLike[]
    capabilities: readonly CapabilityLike[]
  }

  const patched = new Set<string>()
  const controllerConstructor = globalObject.AbortController as ControllerConstructorLike | undefined
  const signalConstructor = globalObject.AbortSignal as SignalConstructorLike | undefined
  const promiseConstructor = globalObject.Promise as PromiseConstructorLike | undefined
  const MAX_ENTRIES = 200
  const MAX_TEXT = 4000
  const startedAt = Date.now()
  const records: EntryLike[] = []
  const fingerprints = new Map<string, EntryLike>()
  const listeners = new Set<() => void>()
  let nextId = 1
  let snapshot: SnapshotLike
  let notificationQueued = false

  const clip = (value: string): string => value.length <= MAX_TEXT
    ? value
    : `${value.slice(0, MAX_TEXT)}…`

  // oxlint-disable-next-line consistent-function-scoping -- 该读取函数必须留在可序列化的 bootstrap 函数体内。
  // oxlint-disable-next-line consistent-function-scoping -- 该读取函数必须留在可序列化的 bootstrap 函数体内。
  const read = (value: unknown, key: string): unknown => {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined
    try { return Reflect.get(value, key) } catch { return undefined }
  }

  const cleanUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string' || value.length === 0) return undefined
    const cut = value.search(/[?#]/u)
    return clip(cut < 0 ? value : value.slice(0, cut))
  }

  const describe = (value: unknown): { message: string, stack?: string } => {
    if (typeof value === 'string') return { message: value }
    if (value === undefined) return { message: 'Unknown browser error' }
    if (value === null) return { message: 'null' }
    const message = read(value, 'message')
    const stack = read(value, 'stack')
    if (typeof message === 'string' && message.length > 0) {
      return {
        message,
        ...typeof stack === 'string' && stack.length > 0 ? { stack } : {},
      }
    }
    try {
      if (typeof value === 'object') {
        const json = JSON.stringify(value)
        if (typeof json === 'string' && json.length > 0) return { message: json }
      }
      return { message: String(value) }
    } catch {
      return { message: 'Unserializable browser error' }
    }
  }

  const notify = (): void => {
    if (notificationQueued) return
    notificationQueued = true
    const run = (): void => {
      notificationQueued = false
      for (const listener of listeners) {
        try { listener() } catch { /* 诊断订阅者不能影响页面。 */ }
      }
    }
    if (typeof globalObject.setTimeout === 'function') globalObject.setTimeout(run, 0)
    else run()
  }

  const publish = (): void => {
    snapshot = { startedAt, entries: records.slice(), capabilities: capabilityRows }
    notify()
  }

  const record = (
    source: string,
    level: 'error' | 'warning',
    message: string,
    stack?: string,
    context?: string,
  ): void => {
    const normalizedMessage = clip(message || 'Unknown browser error')
    const normalizedStack = typeof stack === 'string' && stack.length > 0 ? clip(stack) : undefined
    const normalizedContext = typeof context === 'string' && context.length > 0 ? clip(context) : undefined
    const fingerprint = [source, level, normalizedMessage, normalizedStack ?? '', normalizedContext ?? ''].join('\u0000')
    const now = Date.now()
    const previous = fingerprints.get(fingerprint)
    if (previous !== undefined) {
      previous.lastAt = now
      previous.count += 1
      publish()
      return
    }
    const entry: EntryLike = {
      id: nextId++,
      level,
      source,
      message: normalizedMessage,
      ...normalizedStack === undefined ? {} : { stack: normalizedStack },
      ...normalizedContext === undefined ? {} : { context: normalizedContext },
      firstAt: now,
      lastAt: now,
      count: 1,
    }
    records.push(entry)
    fingerprints.set(fingerprint, entry)
    while (records.length > MAX_ENTRIES) {
      const removed = records.shift()
      if (removed !== undefined) {
        for (const [key, value] of fingerprints) {
          if (value === removed) fingerprints.delete(key)
        }
      }
    }
    publish()
  }

  const recordMessage = (
    source: string,
    message: string,
    context?: string,
    level: 'error' | 'warning' = 'error',
  ): void => { record(source, level, message, undefined, context) }

  const recordError = (source: string, error: unknown, context?: string): void => {
    const described = describe(error)
    record(source, 'error', described.message, described.stack, context)
  }

  const clear = (): void => {
    records.splice(0, records.length)
    fingerprints.clear()
    publish()
  }

  const cssSupports = (...args: string[]): boolean => {
    const css = globalObject.CSS as { supports?: (...values: string[]) => unknown } | undefined
    if (typeof css?.supports !== 'function') return false
    try { return css.supports(...args) === true } catch { return false }
  }

  const capability = (
    id: string,
    kind: 'js' | 'css',
    required: boolean,
    test: () => boolean,
  ): CapabilityLike => ({
    id,
    kind,
    required,
    status: test() ? patched.has(id) ? 'polyfilled' : 'native' : 'missing',
  })

  const abortReason = (exceptionName: string, message: string): unknown => {
    const exception = globalObject.DOMException as { new (message?: string, name?: string): unknown } | undefined
    try { return exception === undefined ? new Error(message) : new exception(message, exceptionName) } catch { return new Error(message) }
  }

  if (promiseConstructor !== undefined && typeof promiseConstructor.withResolvers !== 'function') {
    Object.defineProperty(promiseConstructor, 'withResolvers', {
      configurable: true,
      writable: true,
      value: function withResolvers<T>(): {
        promise: Promise<T>
        resolve: (value: T | PromiseLike<T>) => void
        reject: (reason?: unknown) => void
      } {
        let resolve!: (value: T | PromiseLike<T>) => void
        let reject!: (reason?: unknown) => void
        const promise = new promiseConstructor<T>((nextResolve, nextReject) => {
          resolve = nextResolve
          reject = nextReject
        })
        return { promise, resolve, reject }
      },
    })
    patched.add('Promise.withResolvers')
  }

  if (signalConstructor !== undefined && controllerConstructor !== undefined) {
    if (typeof signalConstructor.any !== 'function') {
      Object.defineProperty(signalConstructor, 'any', {
        configurable: true,
        writable: true,
        value: function any(signals: unknown): SignalLike {
          const list = Array.from(signals as Iterable<unknown>)
          const controller = new controllerConstructor()
          let closed = false
          const attached: { signal: SignalLike, listener: () => void }[] = []
          const cleanup = (): void => {
            for (const item of attached) item.signal.removeEventListener('abort', item.listener)
            attached.splice(0, attached.length)
          }
          const finish = (signal: SignalLike): void => {
            if (closed) return
            closed = true
            cleanup()
            controller.abort(signal.reason)
          }
          for (const value of list) {
            if (value === null || (typeof value !== 'object' && typeof value !== 'function')) {
              throw new TypeError('AbortSignal.any expects AbortSignal values')
            }
            const signal = value as SignalLike
            if (typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function') {
              throw new TypeError('AbortSignal.any expects AbortSignal values')
            }
            if (signal.aborted) {
              finish(signal)
              break
            }
            const listener = (): void => { finish(signal) }
            attached.push({ signal, listener })
            signal.addEventListener('abort', listener, { once: true })
          }
          return controller.signal
        },
      })
      patched.add('AbortSignal.any')
    }
    if (typeof signalConstructor.timeout !== 'function') {
      Object.defineProperty(signalConstructor, 'timeout', {
        configurable: true,
        writable: true,
        value: function timeout(milliseconds: number): SignalLike {
          const delay = Number(milliseconds)
          if (!Number.isFinite(delay) || delay < 0 || delay > 2147483647) {
            throw new RangeError('Delay must be a finite non-negative number')
          }
          const controller = new controllerConstructor()
          const timer = globalObject.setTimeout?.(() => {
            controller.abort(abortReason('TimeoutError', 'The operation timed out'))
          }, delay)
          controller.signal.addEventListener('abort', () => {
            if (timer !== undefined) globalObject.clearTimeout?.(timer)
          }, { once: true })
          return controller.signal
        },
      })
      patched.add('AbortSignal.timeout')
    }
    if (typeof signalConstructor.prototype.throwIfAborted !== 'function') {
      Object.defineProperty(signalConstructor.prototype, 'throwIfAborted', {
        configurable: true,
        writable: true,
        value: function throwIfAborted(this: SignalLike): void {
          if (this.aborted) throw this.reason === undefined
            ? abortReason('AbortError', 'The operation was aborted')
            : this.reason
        },
      })
      patched.add('AbortSignal.throwIfAborted')
    }
  }

  if (globalObject.__DSH_STATION_ITERATOR_POLYFILLED__ === true) patched.add('Iterator helpers')

  const capabilityRows: CapabilityLike[] = [
    capability('AbortSignal.any', 'js', true, () => typeof signalConstructor?.any === 'function'),
    capability('AbortSignal.timeout', 'js', false, () => typeof signalConstructor?.timeout === 'function'),
    capability('AbortSignal.throwIfAborted', 'js', true, () => typeof signalConstructor?.prototype.throwIfAborted === 'function'),
    capability('Promise.withResolvers', 'js', true, () => typeof promiseConstructor?.withResolvers === 'function'),
    capability('Iterator helpers', 'js', true, () => {
      const iterator = globalObject.Iterator as { from?: unknown, prototype?: { join?: unknown } } | undefined
      return typeof iterator?.from === 'function' && typeof iterator?.prototype?.join === 'function'
    }),
    capability('structuredClone', 'js', true, () => typeof globalObject.structuredClone === 'function'),
    capability('ReadableStream', 'js', true, () => typeof globalObject.ReadableStream === 'function'),
    capability('CSS :has()', 'css', false, () => cssSupports('selector(:has(*))')),
    capability('CSS color-mix()', 'css', false, () => cssSupports('color', 'color-mix(in srgb, red, blue)')),
    capability('CSS container queries', 'css', false, () => cssSupports('container-type', 'inline-size')),
    capability('CSS dynamic viewport units', 'css', false, () => cssSupports('height', '100dvh')),
  ]

  snapshot = { startedAt, entries: [], capabilities: capabilityRows }

  const consoleObject = globalObject.console as {
    error?: unknown
    warn?: unknown
  } | undefined
  const installConsole = (methodName: 'error' | 'warn', level: 'error' | 'warning'): void => {
    const original = consoleObject?.[methodName]
    if (typeof original !== 'function' || consoleObject === undefined) return
    const replacement = function (this: unknown, ...args: unknown[]): unknown {
      let result: unknown
      try {
        result = Reflect.apply(original, this, args)
      } finally {
        let stack: string | undefined
        const values = args.map(value => {
          const described = describe(value)
          if (stack === undefined) stack = described.stack
          return described.message
        }).join(' ')
        record(methodName === 'error' ? 'console.error' : 'console.warn', level, values || `console.${methodName}`, stack)
      }
      return result
    }
    try { Reflect.set(consoleObject, methodName, replacement) } catch { /* 某些浏览器的 console 方法不可写。 */ }
  }
  installConsole('error', 'error')
  installConsole('warn', 'warning')

  const addListener = globalObject.addEventListener
  if (typeof addListener === 'function') {
    addListener.call(globalObject, 'error', (event: unknown) => {
      const target = read(event, 'target')
      const tagName = read(target, 'tagName')
      if (typeof tagName === 'string' && target !== globalObject) {
        const url = cleanUrl(read(target, 'currentSrc')) ?? cleanUrl(read(target, 'src')) ?? cleanUrl(read(target, 'href'))
        recordMessage('resource.error', `Resource failed to load${url === undefined ? '' : `: ${url}`}`)
        return
      }
      const filename = cleanUrl(read(event, 'filename'))
      const message = read(event, 'message')
      const error = read(event, 'error')
      recordError('window.error', error ?? (typeof message === 'string' ? message : 'Uncaught browser error'), filename)
    }, true)
    addListener.call(globalObject, 'unhandledrejection', (event: unknown) => {
      recordError('unhandledrejection', read(event, 'reason'))
    })
  }

  const bridge = {
    version: 1 as const,
    getSnapshot: (): SnapshotLike => snapshot,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    clear,
    recordError,
    recordMessage,
  }
  globalObject.__DSH_STATION_BROWSER_COMPAT__ = bridge

  for (const item of capabilityRows) {
    if (item.required && item.status === 'missing') {
      recordMessage('compatibility', `Required browser capability is unavailable: ${item.id}`, undefined, 'error')
    }
  }
}

/** 在页面初始化阶段依次安装 API 垫片和诊断桥；该函数本身不被序列化。 */
export function browserCompatBootstrap(): void {
  iteratorPolyfill()
  browserRuntimeBootstrap()
}

/** 本插件注入的行：始终是 head 位置的内联脚本。 */
export type IteratorScriptInjection = Extract<IndexInjection, { kind: 'script' }>

/**
 * 注入 dsh 页面 index.html 的内联 script 行。
 *
 * 两个函数体分别经 `toString()` 序列化——构建压缩只会改短标识符，
 * 自包含性由测试在构建产物上直接执行注入文本兜底。`placement: 'head'` 的
 * 经典脚本按表执行且先于页面模块加载，因此 Promise/AbortSignal/Iterator
 * 垫片与诊断监听器都先于 dsh combo bundle 求值。
 */
export function iteratorInjection(): IteratorScriptInjection {
  return {
    kind: 'script',
    placement: 'head',
    text: `(${iteratorPolyfill.toString()})();(${browserRuntimeBootstrap.toString()})();`,
  }
}

/** 进程与运行时契约：注入表在每次渲染 index.html 时重新收集，每次都要追加本行。 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push(iteratorInjection())
  })
}
