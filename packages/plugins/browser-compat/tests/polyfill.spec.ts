import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { iteratorInjection, iteratorPolyfill } from '../src/index.js'

type GlobalWithIterator = { Iterator?: unknown }

/**
 * polyfill 行为断言，以脚本字符串维护：同一份断言分别在“真实进程里安装的
 * polyfill”与“序列化注入文本在全新 realm 里的执行结果”上运行。
 * 全新 realm 的 V8 自带原生 Iterator helpers，因此注入前必须先删掉。
 */
const BEHAVIOR_SCRIPT = `
  const I = globalThis.Iterator
  const results = []
  const range = () => I.from([1, 2, 3, 4, 5])
  results.push(range().filter(x => x % 2 === 1).map(x => x * 10).toArray())
  results.push(range().take(2).toArray())
  results.push(range().take(0).toArray())
  results.push(range().drop(4).toArray())
  results.push(I.from([1, 2]).flatMap(x => [x, x * 10]).toArray())
  results.push(range().reduce((a, b) => a + b))
  results.push(range().reduce((a, b) => a + b, 10))
  const seen = []
  range().forEach(x => seen.push(x))
  results.push(seen)
  results.push(range().some(x => x === 4), range().some(x => x === 9))
  results.push(range().every(x => x < 10), range().every(x => x < 4))
  results.push(range().find(x => x > 3))
  results.push(I.from(['a', 'b']).join('-'))
  results.push([...I.from([1, 2])])
  results.push([...I.from([1, 2]).map(x => x * 2).drop(1)])
  let closedByShortCircuit = false
  const closeable = {
    [Symbol.iterator]() {
      let i = 0
      return {
        next: () => i < 3 ? { done: false, value: i++ } : { done: true, value: undefined },
        return: () => { closedByShortCircuit = true; return { done: true, value: undefined } },
      }
    },
  }
  results.push(I.from(closeable).some(x => x === 1), closedByShortCircuit)
  let closedByTake = false
  const closeableTake = {
    [Symbol.iterator]() {
      let i = 0
      return {
        next: () => i < 3 ? { done: false, value: i++ } : { done: true, value: undefined },
        return: () => { closedByTake = true; return { done: true, value: undefined } },
      }
    },
  }
  results.push(I.from(closeableTake).take(1).toArray(), closedByTake)
  let reducedEmpty = null
  try { I.from([]).reduce((a, b) => a + b) } catch (error) { reducedEmpty = error instanceof TypeError }
  results.push(reducedEmpty)
  let constructed = null
  try { new I() } catch (error) { constructed = error instanceof TypeError }
  results.push(constructed)
  // pdf.js 形态回归：上游 bundle 顶层的这句探测在旧 WebKit 上抛
  // “Can't find variable: Iterator”；垫上全局后必须能执行到底。
  let pdfjsProbe = null
  try {
    if (typeof I.prototype.join !== 'function') I.prototype.join = function (separator) {
      return [...this].join(separator)
    }
    pdfjsProbe = I.from(['x', 'y']).join('+')
  } catch { pdfjsProbe = 'threw' }
  results.push(pdfjsProbe)
  // 裸迭代器（只有 next，没有 Symbol.iterator）也必须能被 Iterator.from 接住。
  const bareCounter = (() => { let i = 0; return () => i < 2 ? { done: false, value: i++ } : { done: true, value: undefined } })()
  results.push(I.from({ next: bareCounter }).map(x => x + 1).toArray())
  results
`

const EXPECTED = [
  [10, 30, 50],
  [1, 2],
  [],
  [5],
  [1, 10, 2, 20],
  15,
  25,
  [1, 2, 3, 4, 5],
  true, false,
  true, false,
  4,
  'a-b',
  [1, 2],
  [4],
  true, true,
  [0], true,
  true,
  true,
  'x+y',
  [1, 2],
]

/** 在全新 realm 里删除原生 Iterator、执行注入文本，再运行行为断言。 */
function runInjectedText(text: string): unknown[] {
  const script = `delete globalThis.Iterator; ${text} ${BEHAVIOR_SCRIPT}`
  const results = vm.runInContext(script, vm.createContext({}))
  expect(results).toEqual(EXPECTED)
  return results
}

describe('iterator polyfill behavior', () => {
  beforeEach(() => {
    delete (globalThis as GlobalWithIterator).Iterator
    iteratorPolyfill()
  })

  afterEach(() => {
    delete (globalThis as GlobalWithIterator).Iterator
  })

  it('matches the iterator-helpers subset this deployment relies on', () => {
    // new Function 在当前 realm 执行：断言打到 beforeEach 安装的 polyfill 上。
    expect(new Function(`${BEHAVIOR_SCRIPT} return results`)()).toEqual(EXPECTED)
  })

  it('does not touch an existing native implementation', () => {
    const marker = { alreadyHere: true }
    ;(globalThis as GlobalWithIterator).Iterator = marker
    iteratorPolyfill()
    expect((globalThis as GlobalWithIterator).Iterator).toBe(marker)
  })
})

describe('serialized injection text', () => {
  it('installs the same behavior when executed as a page script', () => {
    runInjectedText(iteratorInjection().text)
  })
})

const distIndex = fileURLToPath(new URL('../dist/index.js', import.meta.url))

describe.skipIf(!existsSync(distIndex))('built dist stays self-contained after minification', () => {
  it('serializes from the bundle and still works in a fresh realm', async () => {
    const { iteratorInjection: fromDist } = await import(distIndex)
    runInjectedText(fromDist().text)
  })
})
