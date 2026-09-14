/* oxlint-disable no-await-in-loop -- 检查脚本按依赖和构建产物顺序执行，失败时保留第一个原因。 */
import { readFileSync } from 'node:fs'
import { createContext as createVmContext, runInContext } from 'node:vm'
import { pathToFileURL } from 'node:url'


/**
 * 所有检查上下文共用的空 disposer，避免每个脚本各自造一份形状相同的函数。
 */
export const inspectionNoop = () => {}

function trackInspectionDisposer(disposers, disposer) {
  if (typeof disposer === 'function' && Array.isArray(disposers)) disposers.push(disposer)
}

/**
 * 创建宿主工件的 Cordis 最小上下文。
 * `stubs` 放插件专属服务，`fields` 放额外的顶层字段；共同的连接、代理、effect、get
 * 骨架始终由这里生成。没有传 events 时不添加 on，避免把当前脚本没有提供的服务伪装出来。
 */
export function createHostInspectionContext({
  cleanup,
  channels = [],
  events,
  disposers,
  stubs = {},
  fields = {},
  get = () => undefined,
}) {
  if (typeof cleanup !== 'function') throw new TypeError('createHostInspectionContext 需要 cleanup')

  const context = {
    ...fields,
    ...stubs,
    connection: { rpc: { handle: (channel) => { channels.push(channel); return inspectionNoop } } },
    agents: { get: () => undefined },
    effect: (run) => {
      const dispose = run()
      trackInspectionDisposer(disposers, dispose)
      cleanup(dispose)
      return inspectionNoop
    },
    get,
  }
  if (events !== undefined) {
    context.on = (event) => { events.push(event); return inspectionNoop }
  }
  return context
}

/**
 * 创建浏览器工件的 Cordis 最小上下文。
 * 座位、文案命名空间和可选 disposer 都由调用方持有，插件专属能力通过 fields/locale/slots
 * 显式传入；没有提供的字段仍然不存在，未知依赖会和真实页面一样失败。
 */
export function createClientInspectionContext({
  seats = [],
  namespaces = [],
  disposers,
  fields = {},
  locale = {},
  slots = {},
}) {
  return {
    ...fields,
    effect: (run) => {
      const dispose = run()
      trackInspectionDisposer(disposers, dispose)
      return inspectionNoop
    },
    locale: {
      ...locale,
      register: (namespace) => { namespaces.push(namespace); return inspectionNoop },
    },
    slots: {
      ...slots,
      inject: (_name, run) => { run() },
      register: (options) => { seats.push(options); return inspectionNoop },
    },
  }
}
/**
 * 在受限页面模块表中加载 client bundle，并执行真实 factory。
 * 模拟 window.__ModuleLoader__.load，核对 package id，记录 factory 请求的 external；
 * 每个 external 都必须由 externalShims 提供，否则通过统一错误回调失败。
 */
export function loadClientBundle({
  bundle,
  packageId,
  externalShims,
  sandbox = {},
  missingLoader = () => new Error('bundle 没有调用 window.__ModuleLoader__.load'),
  idMismatch = (actual, expected) => new Error(`bundle 自称 ${actual}，应当是 ${expected}`),
  unknownExternal = (id) => new Error(`bundle 要求页面模块表之外的模块：${id}`),
}) {
  const source = readFileSync(bundle, 'utf8')
  let loaded = null
  const pageWindow = {
    ...sandbox.window,
    __ModuleLoader__: { load: (entry) => { loaded = entry } },
  }
  const context = createVmContext({ ...sandbox, window: pageWindow, console: sandbox.console ?? console })
  runInContext(source, context, { filename: bundle })
  if (loaded === null) throw missingLoader()
  if (loaded.id !== packageId) throw idMismatch(loaded.id, packageId)

  const externals = []
  const exports = loaded.factory((id) => {
    externals.push(id)
    const hasShim = externalShims instanceof Map
      ? externalShims.has(id)
      : Object.hasOwn(externalShims, id)
    if (!hasShim) throw unknownExternal(id)
    return externalShims instanceof Map ? externalShims.get(id) : externalShims[id]
  })
  return { source, loaded, exports, externals }
}

/**
 * 加载宿主构建产物并运行一次 apply，统一处理动态导入、错误收集和 disposer 清理；
 * 注册表、工具、通道和 schema 断言仍由调用方通过 createContext 保留。
 *
 * createContext 会收到错误数组和清理注册函数。清理函数只接收真实 disposer，
 * 默认在检查结束后按逆序执行；传入 autoCleanup:false 时由返回值的 cleanup 执行，失败会被收集后重新抛出。
 */
export async function inspectHostBundle({
  entry,
  load = (specifier) => import(specifier),
  createContext,
  applyArgs = [],
  autoCleanup = true,
}) {
  if (typeof createContext !== 'function') throw new TypeError('inspectHostBundle 需要 createContext')

  const errors = []
  const cleanups = []
  const cleanup = (disposer) => {
    if (typeof disposer === 'function') cleanups.push(disposer)
    return () => {}
  }
  const recordError = (error) => {
    errors.push(error)
    return error
  }

  let module
  let context
  let firstError
  let cleanupsRun = false
  const runCleanups = async () => {
    if (cleanupsRun) return
    cleanupsRun = true
    for (let index = cleanups.length - 1; index >= 0; index -= 1) {
      try {
        await cleanups[index]()
      } catch (error) {
        errors.push(error)
        if (firstError === undefined) firstError = error
      }
    }
    if (firstError !== undefined) throw firstError
  }
  try {
    module = await load(pathToFileURL(entry).href)
    context = await createContext({ errors, cleanup, recordError })
    if (typeof module?.apply !== 'function') throw new TypeError(`宿主 bundle 没有导出 apply：${entry}`)
    const resolvedArgs = typeof applyArgs === 'function' ? await applyArgs(module) : applyArgs
    const args = resolvedArgs === undefined ? [] : Array.isArray(resolvedArgs) ? resolvedArgs : [resolvedArgs]
    await module.apply(context, ...args)
  } catch (error) {
    firstError = error
    errors.push(error)
  } finally {
    if (autoCleanup) await runCleanups()
  }

  if (firstError !== undefined) throw firstError
  return { module, context, errors, cleanups, cleanup: runCleanups }
}

/**
 * 统一 client bundle 的读取、ModuleLoader/factory 执行和 external 错误处理。
 * 这里集中完成受限 vm、loader、factory 与 external shim 的通用验证，buildContext
 * 只负责各插件自己的 apply、座位、命名空间和注入断言，并可返回任意检查报告。
 */
export function inspectClientBundle({
  bundle,
  packageId,
  externalShims,
  buildContext,
  ...loaderOptions
}) {
  if (typeof buildContext !== 'function') throw new TypeError('inspectClientBundle 需要 buildContext')
  const report = loadClientBundle({ bundle, packageId, externalShims, ...loaderOptions })
  return buildContext(report)
}
