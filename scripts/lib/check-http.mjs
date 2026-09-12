import { randomUUID } from 'node:crypto'

/**
 * 构造浏览器视角的 Host、Origin 与可选 cookie。
 * 所有冒烟请求共用 loopback authority、Origin 和 same-origin 标记，cookie 只在认证请求中加入。
 */
export function browserHeaders({ authority, base, cookie }) {
  return {
    host: authority,
    origin: base,
    'sec-fetch-site': 'same-origin',
    ...(cookie === undefined ? {} : { cookie }),
  }
}

/**
 * 从 dsh token 交换响应中提取浏览器 cookie。
 * 读取响应的 Set-Cookie，只保留每项的 name=value，并合并成后续 fetch 使用的 cookie 头。
 */
export function responseCookie(response) {
  return (response.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ')
}

/**
 * 用 token 交换 dsh 浏览器 cookie。
 * 以浏览器 headers 访问首页、手动保留重定向响应，并返回原始响应与解析出的 cookie。
 */
export async function exchangeToken({ base, authority, token }) {
  const response = await fetch(`${base}/?token=${token}`, {
    redirect: 'manual',
    headers: browserHeaders({ authority, base }),
  })
  return { response, cookie: responseCookie(response) }
}

/**
 * 找到首页启动数据中指定插件的 client bundle URL。
 * 从插件 id 在 __DSH_BOOT__ 中的位置继续读取 url，避免调用脚本重复实现 bundle 定位规则。
 */
export function findClientBundleUrl(index, packageId) {
  const idAt = index.indexOf(`"id":"${packageId}"`)
  return idAt === -1 ? null : /"url":"([^"]+)"/u.exec(index.slice(idAt))?.[1] ?? null
}

/**
 * 读取响应正文，并尽量解析 JSON。
 * JSON 响应返回对象，非 JSON 响应原样返回文本，统一 RPC 调用方的读取方式。
 */
export async function responseBody(response) {
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/**
 * 发送一个 dsh 风格的 RPC 请求。
 * 用 POST JSON 发送 `{ type: "client-request", rpcId, method, payload }` 信封，
 * 复用浏览器 headers，并返回状态码和解析后的响应正文。
 */
export async function rpcRequest({
  url,
  authority,
  base,
  method,
  payload,
  cookie,
  rpcId = 'smoke',
  headers,
}) {
  const response = await fetch(url, {
    method: 'POST',
    headers: headers ?? {
      ...browserHeaders({ authority, base, cookie }),
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  return { status: response.status, body: await responseBody(response) }
}

/**
 * 调用插件通道的指定端点。
 * URL 使用 `${channel}/${endpoint}`，并让信封 method 与 endpoint 保持一致。
 */
export function callChannel({ base, authority, channel, endpoint, payload, cookie, rpcId = 'smoke' }) {
  return rpcRequest({
    url: `${base}/${channel}/${endpoint}`,
    authority,
    base,
    method: endpoint,
    payload,
    cookie,
    rpcId,
  })
}

/**
 * 调用 dsh /api 的一元 RPC。
 * URL 使用 `/api/${endpoint}`，并把 args 放进 dsh 约定的 payload；可为请求指定 rpcId。
 */
export function callApi({ base, authority, endpoint, args, cookie, rpcId = randomUUID() }) {
  return rpcRequest({
    url: `${base}/api/${endpoint}`,
    authority,
    base,
    method: endpoint,
    payload: { args },
    cookie,
    rpcId,
  })
}

/**
 * 认证后读取插件浏览器 bundle。
 * 将启动数据中的相对 URL 解析到当前 dsh origin，使用同一组浏览器 headers 与 cookie。
 */
export function fetchClientBundle({ base, authority, url, cookie }) {
  return fetch(new URL(url.replaceAll('&amp;', '&'), base), {
    headers: browserHeaders({ authority, base, cookie }),
  })
}
