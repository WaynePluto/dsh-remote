/**
 * 冒烟：确认 dsh 真的把 turn-retry 插件的两半都装上了，而且通道是活的。
 *
 * 这个脚本存在的理由和 copilot-auth-check 一样：宿主半靠 `--patch` 叠加层加载，浏览器半
 * 靠 dsh 的客户端模块扫描。两条链路里任何一环变了，dsh 都只会以「fiber FAILED」或
 * 「页面少一块」的形式表现出来，单元测试全绿也看不见。
 *
 * 本插件比兄弟插件多两条只有真机能验的东西：
 *   · 它往 dsh 的 session-projection 注册表里加了一个 key（`turnRetry`）。注册被拒
 *     （比如 stateVersion 冲突、schema 不合法）会让整个 fiber FAILED，而不是少个横幅。
 *   · 它只保留事后 projection + RPC；浏览器 bundle 不应再带“不再提示”。
 * 所以「dsh 正常启动并打印带 token 的地址」这一条在这里的分量比别处更重。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/turn-retry-check.mjs [--port 3098]
 *
 * 全过程不发起任何模型请求，也不写任何会话。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-turn-retry'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'turn-retry-check-home')

let failures = 0

/**
 * 记录一条检查结果。
 * @param {boolean} ok 是否通过。
 * @param {string} what 检查项。
 * @param {string} [detail] 失败时的补充信息。
 */
function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 把用户 home 里的 profile 复制进临时 home，dsh 没有 profile 会拒绝启动。 */
function prepareHome() {
  rmSync(HOME, { recursive: true, force: true })
  const source = join(process.env.DSH_HOME?.trim() || join(homedir(), '.dsh'), 'profiles', DSH_PROFILE)
  if (!existsSync(source)) {
    console.error(`找不到 profile ${source}，先跑一次 pnpm dev 让它被创建。`)
    process.exit(1)
  }
  mkdirSync(join(HOME, 'profiles'), { recursive: true })
  cpSync(source, join(HOME, 'profiles', DSH_PROFILE), { recursive: true })
}

/**
 * 启动 dsh 并等它打印带 token 的地址。
 * @returns {Promise<{ child: import('node:child_process').ChildProcess, token: string }>} 子进程与 launch token。
 */
async function startDsh() {
  const overlays = dshPluginOverlays()
  const child = spawn(process.execPath, [
    DSH_BIN,
    '--profile', DSH_PROFILE,
    ...overlays.flatMap(overlay => ['--patch', overlay]),
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--trusted-host', AUTHORITY,
  ], { cwd: ROOT, env: { ...process.env, DSH_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`dsh 60 秒内没有打印访问地址：\n${output}`))
    }, 60_000)
    const scan = (chunk) => {
      output += String(chunk)
      const match = /dsh web:\s*\S+?[?&]token=([\w.-]+)/u.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve({ child, token: match[1] })
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh 退出（code ${code}）：\n${output}`))
    })
  })
}

/** 浏览器视角的请求头：模式 A 下 Host 就是被信任的 authority。 */
function browserHeaders(cookie) {
  return {
    host: AUTHORITY,
    origin: BASE,
    'sec-fetch-site': 'same-origin',
    ...cookie === undefined ? {} : { cookie },
  }
}

/**
 * 调一次本插件的通道。
 *
 * 端点在 **URL 路径**里，不只是信封里：dsh 用 `endpointFromPath` 从
 * `${channel}/${endpoint}` 解析（`packages/client/connection/src/rpc-host.ts:259-267`），
 * 只打到 `/turn-retry` 会直接 404；信封里的 `method` 还必须和路径段一致，否则报错。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: unknown }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/turn-retry/${method}`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method, payload }),
  })
  const text = await response.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch { /* 非 JSON 就原样保留，失败时打印出来更有用 */ }
  return { status: response.status, body }
}

async function main() {
  prepareHome()
  const { child, token } = await startDsh()
  try {
    // 这一条最重：projection 注册或 RPC 通道挂载被拒，都会让 fiber FAILED，
    // dsh 就永远走不到打印地址这一步。
    check(true, 'dsh 带全部 --patch 正常启动（projection 注册与 RPC 通道被接受）')

    const exchange = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual', headers: browserHeaders() })
    const cookie = (exchange.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
    check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)

    const index = await (await fetch(`${BASE}/`, { headers: browserHeaders(cookie) })).text()
    // 不用正则拼包名（`@` `/` `-` 在 u 模式下不能转义），直接从 id 出现的位置往后找 url。
    const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
    check(idAt !== -1, '首页的 __DSH_BOOT__ 里有本插件的行')
    const url = idAt === -1 ? null : /"url":"([^"]+)"/u.exec(index.slice(idAt))?.[1] ?? null

    if (url !== null) {
      const bundle = await fetch(new URL(url.replaceAll('&amp;', '&'), BASE), { headers: browserHeaders(cookie) })
      const body = await bundle.text()
      check(bundle.ok, '插件 bundle 能取到', `status ${bundle.status}`)
      check(body.includes('__ModuleLoader__.load'), 'bundle 是加载器认识的工件格式')
      check(body.includes('conversation.input.dock'), 'bundle 里带着输入框上方的槽注册')
      check(body.includes('turnRetry'), 'bundle 里读的是宿主发布的那个投影 key')
      // 两半必须对同一个和类型说话：宿主折出 `kind:'stopped'`，浏览器半要有对应的文案分支，
      // 否则「手动停止之后接着做」这半功能会安静地渲染成一个空标题。
      check(body.includes('stoppedTitle'), 'bundle 里带着「上一轮被停止」那一半的文案')
      check(!body.includes('不再提示'), 'bundle 不再包含「不再提示」按钮文案')
    }

    // 通道活着：一个不存在的会话应当被守卫挡下并如实说明原因，而不是 404 或 500。
    const unknown = await callChannel('retry', { sessionId: 'no-such-session' }, cookie)
    check(
      unknown.status === 200 && unknown.body?.result?.ok === true
      && unknown.body.result.value?.started === false,
      '/turn-retry 通道已挂载，且拒绝重试一个不存在的会话',
      JSON.stringify(unknown.body),
    )

    const malformed = await callChannel('retry', {}, cookie)
    check(
      malformed.body?.result?.ok === false
      && malformed.body.result.error?.code === 'turn-retry/bad-payload',
      '缺少 sessionId 的调用被通道自己挡下',
      JSON.stringify(malformed.body),
    )

    const unknownEndpoint = await callChannel('nope', { sessionId: 'x' }, cookie)
    check(
      unknownEndpoint.body?.result?.ok === false
      && unknownEndpoint.body.result.error?.code === 'turn-retry/unknown-endpoint',
      '未知端点被通道自己挡下',
      JSON.stringify(unknownEndpoint.body),
    )

    const unauthenticated = await fetch(`${BASE}/turn-retry/retry`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'retry', payload: { sessionId: 'x' } }),
    })
    check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
  } finally {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } else {
      child.kill('SIGTERM')
    }
  }
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
