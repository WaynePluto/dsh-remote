#!/usr/bin/env node
/**
 * 本机等价验证：构造 Host / Origin / sec-fetch-site / Cookie 请求本机 dsh，判定 `/api` browser-trust fence 与浏览器认证两道门。
 * 依据 dsh 0.1.2-alpha.2：`packages/client/connection/src/api-request-trust.ts` 只读 headers、不看 socket.remoteAddress；`packages/client/connection/src/rpc-host.ts` 先 fence（403）后认证（401）；`packages/client/connection/src/browser-auth.ts` 用 `GET /?token=` 换绑定 authority 的 `dsh-auth-*` cookie，且无 loopback 豁免。
 * 旧 `PRIVILEGED_METHODS` 在 0.1.2 已删除，本脚本据此断言。
 * 用法：`node scripts/m0-fence-check.mjs --token <dsh 启动时打印的 token> [--port 3080] [--fake-host pc1.dsh.example.com]`。
 * token 来自：`dsh web: http://127.0.0.1:3080/?token=<token>`。
 */

import http from 'node:http'
import { randomBytes, randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback
}

const PORT = Number(readArg('port', '3080'))
const LOOPBACK = `127.0.0.1:${PORT}`
const FAKE = readArg('fake-host', 'pc1.dsh.example.com')
const TOKEN = readArg('token', undefined)

/** 一次普通 HTTP 请求，返回 { status, body, headers }。 */
function request({ method = 'GET', path = '/', headers = {}, body }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: PORT, method, path, headers },
      (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8').slice(0, 200),
        }))
      },
    )
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

/** 一次 WebSocket 升级尝试，返回 { status }（101 = 升级成功）。 */
function upgrade({ path, headers = {} }) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: PORT,
      method: 'GET',
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        'sec-websocket-version': '13',
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve({ status: res.statusCode ?? 101, body: '' })
    })
    req.on('response', (res) => {
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8').slice(0, 120),
      }))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * 用 token 换一个绑定到指定 authority 的 dsh cookie。
 * cookie 名是 `dsh-auth-<base64url(sha256(authority))>`，所以每个 Host 都要单独换一次。
 */
async function mintCookie(authority) {
  if (TOKEN === undefined) return undefined
  const res = await request({ path: `/?token=${encodeURIComponent(TOKEN)}`, headers: { host: authority } })
  const setCookie = res.headers['set-cookie']?.[0]
  if (res.status !== 303 || setCookie === undefined) return undefined
  return setCookie.split(';', 1)[0]
}

/** dsh 0.1.2 的 RPC 端点是 `<service>/<method>`；`$events/result` 是 gateway 自带的一元端点。 */
const RPC_ENDPOINT = '$events/result'

const rpcBody = method => JSON.stringify({
  type: 'client-request',
  rpcId: randomUUID(),
  method,
  payload: {},
})

const apiCall = (method, headers) => ({
  method: 'POST',
  path: `/api/${method}`,
  headers: { 'content-type': 'application/json', ...headers },
  body: rpcBody(method),
})

if (TOKEN === undefined) {
  console.error('\n[警告] 没有 --token：dsh 0.1.2 的浏览器认证会让所有 /api 用例停在 401，无法体现 fence 行为。')
  console.error('       token 见 dsh 启动输出的 `dsh web: http://127.0.0.1:<port>/?token=<token>`。\n')
}

const loopbackCookie = await mintCookie(LOOPBACK)
const fakeCookie = await mintCookie(FAKE)
const withLoopbackCookie = loopbackCookie === undefined ? {} : { cookie: loopbackCookie }
const withFakeCookie = fakeCookie === undefined ? {} : { cookie: fakeCookie }

const cases = [
  {
    name: 'GET /（Host=loopback，无 cookie）',
    expect: '401（dsh 自己的浏览器认证，无 loopback 豁免）',
    run: () => request({ path: '/', headers: { host: LOOPBACK } }),
  },
  {
    name: 'GET /?token=…（Host=loopback）',
    expect: '303 + Set-Cookie: dsh-auth-*',
    run: () => request({ path: `/?token=${encodeURIComponent(TOKEN ?? '')}`, headers: { host: LOOPBACK } }),
  },
  {
    name: 'GET /（Host=loopback + cookie）',
    expect: '200',
    run: () => request({ path: '/', headers: { host: LOOPBACK, ...withLoopbackCookie } }),
  },
  {
    name: `GET /（Host=${FAKE} + 对应 cookie）`,
    expect: '200（index 不过 /api fence）',
    run: () => request({ path: '/', headers: { host: FAKE, ...withFakeCookie } }),
  },
  {
    name: `POST /api/${RPC_ENDPOINT}（Host=loopback + cookie）`,
    expect: '非 403/401（过了两道门）',
    run: () => request(apiCall(RPC_ENDPOINT, { host: LOOPBACK, origin: `http://${LOOPBACK}`, ...withLoopbackCookie })),
  },
  {
    name: `POST /api/${RPC_ENDPOINT}（Host=loopback，无 cookie）`,
    expect: '401',
    run: () => request(apiCall(RPC_ENDPOINT, { host: LOOPBACK, origin: `http://${LOOPBACK}` })),
  },
  {
    name: `模式 A：POST /api/${RPC_ENDPOINT}（Host=${FAKE} + cookie）`,
    expect: '未声明 trustedHosts → 403；声明后 → 非 403/401',
    run: () => request(apiCall(RPC_ENDPOINT, {
      host: FAKE,
      origin: `https://${FAKE}`,
      'sec-fetch-site': 'same-origin',
      ...withFakeCookie,
    })),
  },
  {
    name: `旧特权方法 POST /api/settings.describe（Host=${FAKE} + cookie）`,
    expect: '不再固定 403：声明 trustedHosts 后与普通端点同等（404 = 方法已不存在）',
    run: () => request(apiCall('settings.describe', { host: FAKE, origin: `https://${FAKE}`, ...withFakeCookie })),
  },
  {
    name: `Origin 不匹配：POST /api/${RPC_ENDPOINT}（Host=${FAKE}, Origin=evil）`,
    expect: '403',
    run: () => request(apiCall(RPC_ENDPOINT, { host: FAKE, origin: 'https://evil.example.com', ...withFakeCookie })),
  },
  {
    name: `sec-fetch-site: cross-site（Host=${FAKE}）`,
    expect: '403',
    run: () => request(apiCall(RPC_ENDPOINT, {
      host: FAKE,
      origin: `https://${FAKE}`,
      'sec-fetch-site': 'cross-site',
      ...withFakeCookie,
    })),
  },
  {
    name: 'GET /api/remote.mux（不带 Upgrade, Host=loopback + cookie）',
    expect: '404（升级路由只认 upgrade 请求）',
    run: () => request({ path: '/api/remote.mux', headers: { host: LOOPBACK, ...withLoopbackCookie } }),
  },
  {
    name: 'WS 升级 /api/remote.mux（Host=loopback + cookie）',
    expect: '101',
    run: () => upgrade({ path: '/api/remote.mux', headers: { host: LOOPBACK, origin: `http://${LOOPBACK}`, ...withLoopbackCookie } }),
  },
  {
    name: `WS 升级 /api/remote.mux（Host=${FAKE} + cookie）`,
    expect: '未声明 trustedHosts → 403；声明后 → 101',
    run: () => upgrade({ path: '/api/remote.mux', headers: { host: FAKE, origin: `https://${FAKE}`, ...withFakeCookie } }),
  },
  {
    name: `WS 升级 /api/remote.mux（Host=${FAKE}，无 cookie）`,
    expect: '401（fence 通过后仍要 dsh 自己的 cookie）',
    run: () => upgrade({ path: '/api/remote.mux', headers: { host: FAKE, origin: `https://${FAKE}` } }),
  },
]

const rows = []
for (const c of cases) {
  try {
    const { status, body } = await c.run()
    rows.push({ name: c.name, expect: c.expect, got: String(status), note: body.replace(/\s+/g, ' ').slice(0, 60) })
  } catch (error) {
    rows.push({ name: c.name, expect: c.expect, got: 'ERROR', note: String(error.message).slice(0, 60) })
  }
}

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)))
console.log(`\n目标: http://127.0.0.1:${PORT}   伪造 Host: ${FAKE}   cookie: ${loopbackCookie === undefined ? '未取得' : '已取得'}\n`)
console.log(`| ${pad('用例', 60)} | ${pad('预期', 52)} | 实际 | 响应片段 |`)
console.log(`|${'-'.repeat(62)}|${'-'.repeat(54)}|------|----------|`)
for (const r of rows) {
  console.log(`| ${pad(r.name, 60)} | ${pad(r.expect, 52)} | ${r.got} | ${r.note} |`)
}
console.log('')
