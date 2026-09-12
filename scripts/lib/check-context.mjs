import { cleanupCheckHome, defaultDshHome, prepareCheckHome } from './check-home.mjs'
import { startDsh as startDshProcess, stopDsh as stopDshProcess, withDsh as withDshProcess } from './check-dsh.mjs'
import {
  browserHeaders as makeBrowserHeaders,
  callApi as callApiRequest,
  callChannel as callChannelRequest,
  exchangeToken as exchangeTokenRequest,
  fetchClientBundle as fetchClientBundleRequest,
  findClientBundleUrl as findClientBundleUrlRequest,
  rpcRequest as rpcRequestBase,
} from './check-http.mjs'

/**
 * 运行一套真实 dsh 浏览器冒烟的公共生命周期。
 * 启动、token 交换、首页与 client bundle 读取以及进程清理由这里负责，具体契约由回调断言。
 *
 * `startedAssertions` 在 dsh 打印 token 后调用，`exchangeAssertions` 紧跟 token 交换，
 * `bundleAssertions` 收到首页、bundle URL 和已读取的 bundle，`liveAssertions` 负责 RPC 等活体检查。
 * `headers` 可以直接传 headers，也可以根据当前状态返回 headers；`exchange` 为 false 时保留传入的 cookie。
 */
export async function runLiveDshCheck(context, {
  exchange = true,
  cookie: initialCookie,
  headers,
  startedAssertions,
  exchangeAssertions,
  bundleAssertions,
  liveAssertions,
} = {}) {
  if (context === null || typeof context !== 'object') {
    throw new TypeError('runLiveDshCheck 需要 dsh 检查上下文')
  }

  const started = await context.startDsh()
  try {
    const state = {
      context,
      child: started.child,
      token: started.token,
      cookie: initialCookie,
      exchange: undefined,
      headers: undefined,
      indexResponse: undefined,
      index: undefined,
      url: null,
      bundle: undefined,
      bundleBody: undefined,
    }

    if (typeof startedAssertions === 'function') await startedAssertions(state)

    if (exchange) {
      const exchanged = await context.exchangeToken(state.token)
      state.exchange = exchanged.response
      state.cookie = exchanged.cookie
      if (typeof exchangeAssertions === 'function') await exchangeAssertions(state)
    }

    state.headers = typeof headers === 'function'
      ? await headers(state)
      : headers ?? context.browserHeaders(state.cookie)
    state.indexResponse = await fetch(`${context.base}/`, { headers: state.headers })
    state.index = await state.indexResponse.text()
    state.url = typeof context.findClientBundleUrl === 'function'
      ? context.findClientBundleUrl(state.index) ?? null
      : null

    if (state.url !== null && state.url !== undefined) {
      if (typeof context.fetchClientBundle !== 'function') {
        throw new TypeError('runLiveDshCheck 找不到 fetchClientBundle')
      }
      state.bundle = await context.fetchClientBundle(state.url, state.cookie)
      state.bundleBody = await state.bundle.text()
    }

    if (typeof bundleAssertions === 'function') await bundleAssertions(state)
    if (typeof liveAssertions === 'function') await liveAssertions(state)
    return state
  } finally {
    await context.stopDsh(started.child)
  }
}

/**
 * 创建真实 dsh 冒烟脚本共用的运行上下文。
 * 绑定隔离 home 的准备、dsh 启停、浏览器 headers/token cookie、bundle 定位与读取，
 * 以及带统一 URL、headers 和 RPC 信封的通道/API 调用；调用脚本只保留插件契约断言。
 */
export function createCheckContext({
  dshBin,
  profile,
  overlays = [],
  home,
  cwd,
  sourceHome = defaultDshHome(),
  port,
  trustedHost = `127.0.0.1:${port}`,
  packageId,
  channel,
  rpcId,
  tokenPattern,
  timeoutMs,
  timeoutMessage,
  exitMessage,
  errorMessage,
  onMissingProfile = (source) => {
    console.error(`找不到 profile ${source}，先跑一次 pnpm dev 让它被创建。`)
    process.exit(1)
  },
  cleanup = true,
}) {
  const authority = `127.0.0.1:${port}`
  const base = `http://${authority}`

  if (cleanup) process.on('exit', () => cleanupCheckHome(home))

  const prepareHome = () => prepareCheckHome({
    home,
    profile,
    sourceHome,
    onMissingProfile,
  })

  const resolveOverlays = () => typeof overlays === 'function' ? overlays() : overlays

  const startDsh = () => startDshProcess({
    dshBin,
    profile,
    overlays: resolveOverlays(),
    home,
    cwd,
    port,
    trustedHost,
    tokenPattern,
    timeoutMs,
    timeoutMessage,
    exitMessage,
    errorMessage,
  })

  const browserHeaders = (cookie) => makeBrowserHeaders({ authority, base, cookie })
  const exchangeToken = (token) => exchangeTokenRequest({ base, authority, token })
  const fetchClientBundle = (url, cookie) => fetchClientBundleRequest({ base, authority, url, cookie })
  const findClientBundleUrl = packageId === undefined
    ? undefined
    : (index) => findClientBundleUrlRequest(index, packageId)

  const callChannel = channel === undefined
    ? undefined
    : (endpoint, payload, cookie) => callChannelRequest({
      base,
      authority,
      channel,
      endpoint,
      payload,
      cookie,
      ...(rpcId === undefined ? {} : { rpcId }),
    })

  const callApi = (endpoint, args, cookie, requestRpcId) => callApiRequest({
    base,
    authority,
    endpoint,
    args,
    cookie,
    ...(requestRpcId === undefined ? {} : { rpcId: requestRpcId }),
  })

  const rpcRequest = ({ path, method, payload, cookie, requestRpcId, headers }) => rpcRequestBase({
    url: `${base}${path}`,
    authority,
    base,
    method,
    payload,
    cookie,
    ...(requestRpcId === undefined && rpcId === undefined ? {} : { rpcId: requestRpcId ?? rpcId }),
    ...(headers === undefined ? {} : { headers }),
  })

  const withDsh = (run) => withDshProcess({
    dshBin,
    profile,
    overlays: resolveOverlays(),
    home,
    cwd,
    port,
    trustedHost,
    tokenPattern,
    timeoutMs,
    timeoutMessage,
    exitMessage,
    errorMessage,
  }, run)

  return {
    home,
    profile,
    port,
    authority,
    base,
    prepareHome,
    startDsh,
    stopDsh: stopDshProcess,
    withDsh,
    browserHeaders,
    exchangeToken,
    fetchClientBundle,
    findClientBundleUrl,
    ...(channel === undefined ? {} : { callChannel }),
    callApi,
    rpcRequest,
  }
}