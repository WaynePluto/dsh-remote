/**
 * dsh-remote 插件：为缺少新 Web 平台 API 的浏览器垫平 dsh 前端运行所需的最低集合。
 *
 * 背景：dsh 前端官方 bundle（如 `@deepseek-ai/dsh-client-ui-sidebar-documentpreview`
 * 内联的 pdf.js）会在模块顶层引用 `Iterator` 全局（ES2025 Iterator helpers）。
 * Safari 18.4 之前的 WebKit 没有这个全局，模块求值直接抛
 * “Can't find variable: Iterator”，整个插件加载失败，dsh Web UI 无法启动。
 * 本插件通过 `webserver/index-inject` 的内联 script 行在页面启动前安装
 * Iterator helpers 的等价实现；原生实现已存在时不做任何事。
 *
 * 只在 dsh-remote-web profile 生效，不改官方 web profile，也不触碰 relay
 * 的字节转发（铁律 3、铁律 9）。
 *
 * @module @dsh-remote/dsh-plugin-browser-compat
 */

import type { Context } from '@deepseek-ai/cordis'
// 合并，使 `webserver/index-inject` 出现在本模块 Events 视图中。仅类型导入，
// 产出的插件仍是无依赖单文件。
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-browser-compat'

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
  const globalObject = globalThis as { Iterator?: unknown }
  if (typeof globalObject.Iterator !== 'undefined') return

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

  function abstractBase(): void {
    throw new TypeError('Iterator is not a constructor')
  }
  const Iterator = abstractBase as unknown as { readonly prototype: unknown }
  Object.defineProperty(Iterator, 'prototype', { value: iteratorPrototype, writable: false, configurable: false })
  Object.defineProperty(iteratorPrototype, 'constructor', { value: Iterator, writable: true, configurable: true })
  Object.defineProperty(iteratorPrototype, Symbol.toStringTag, { value: 'Iterator', writable: false, configurable: true })
  Object.defineProperty(Iterator, 'from', { value: iteratorFrom, writable: true, configurable: true })
  globalObject.Iterator = Iterator
}

/** 本插件注入的行：始终是 head 位置的内联脚本。 */
export type IteratorScriptInjection = Extract<IndexInjection, { kind: 'script' }>

/**
 * 注入 dsh 页面 index.html 的内联 script 行。
 *
 * `{@link iteratorPolyfill}` 的函数体经 `toString()` 序列化——构建压缩只会
 * 改短标识符，自包含性由测试在构建产物上直接执行注入文本兜底。
 * `placement: 'head'` 的经典脚本按表执行且先于页面模块加载，因此垫片
 * 一定先于引用 `Iterator` 的 combo bundle 求值。
 */
export function iteratorInjection(): IteratorScriptInjection {
  return { kind: 'script', placement: 'head', text: `(${iteratorPolyfill.toString()})();` }
}

/** 进程与运行时契约：注入表在每次渲染 index.html 时重新收集，每次都要追加本行。 */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push(iteratorInjection())
  })
}
