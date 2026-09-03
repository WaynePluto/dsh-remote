/**
 * 冒烟：确认代理插件的设置写入在**真 dsh** 上真的能通过。
 *
 * 这个脚本是为一个具体的线上 bug 写的，值得说清楚它在验什么：
 *
 * 用户报「代理页面存不了、开关也勾不上」。根因有两层，都只有真机能验：
 *   1. 宿主校验器只接受带协议的地址，于是最常见的 `127.0.0.1:7890` 被拒；
 *   2. 而 `SettingsScope.mutate` 在**宿主拒绝时是 resolve 而不是 reject**
 *      （dsh 的 packages/client/ui-settings/src/client/settings-scope.ts:132-135），
 *      它只是悄悄把宿主状态重新载入。页面于是把「被拒绝」显示成了「已保存」，
 *      同时把用户刚输入的内容一起丢掉 —— 看起来就是「存不进去」。
 *
 * 单元测试能覆盖第 1 层的纯函数，但「宿主到底收不收这一次写入」只有真的打一次
 * `/api/settings/mutate` 才算数，所以有了这个脚本。
 *
 *   node scripts/proxy-check.mjs [--port 3097]
 *
 * 全程不发起任何出网请求，也不改用户的 DSH_HOME（用临时 home）。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-proxy'
const NAMESPACE = 'dsh-plugin-proxy'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
const HOME = join(DEV_DIRECTORY, 'proxy-check-home')

let failures = 0

/**
 * 记录一条检查结果。
 * @param {boolean} ok 是否通过。
 * @param {string} what 检查项。
 * @param {string} [detail] 补充信息。
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
  const child = spawn(process.execPath, [
    DSH_BIN,
    '--profile', DSH_PROFILE,
    ...dshPluginOverlays().flatMap(overlay => ['--patch', overlay]),
    '--no-open',
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--trusted-host', AUTHORITY,
  ], { cwd: ROOT, env: { ...process.env, DSH_HOME: HOME }, stdio: ['ignore', 'pipe', 'pipe'] })

  let output = ''
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error(`dsh 60 秒内没有打印访问地址：\n${output}`)) }, 60_000)
    const scan = (chunk) => {
      output += String(chunk)
      const match = /dsh web:\s*\S+?[?&]token=([\w.-]+)/u.exec(output)
      if (match === null) return
      clearTimeout(timer)
      resolve({ child, token: match[1] })
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`dsh 退出（code ${code}）：\n${output}`)) })
  })
}

/** 浏览器视角的请求头：模式 A 下 Host 就是被信任的 authority。 */
function browserHeaders(cookie) {
  return { host: AUTHORITY, origin: BASE, 'sec-fetch-site': 'same-origin', ...cookie === undefined ? {} : { cookie } }
}

/**
 * 打一次 dsh 的 `/api` 一元 RPC。
 *
 * 端点是 `<service>/<method>`，实参是**按参数名的对象**放在 `payload.args` 里
 * （dsh 的 packages/api/gateway/src/client/index.ts:443、:494-521）。
 * @param {string} endpoint 形如 `settings/mutate`。
 * @param {Record<string, unknown>} args 按参数名的实参。
 * @param {string} cookie 浏览器 cookie。
 * @returns {Promise<{ status: number, body: any }>} 状态码与解析后的应答。
 */
async function api(endpoint, args, cookie) {
  const response = await fetch(`${BASE}/api/${endpoint}`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args } }),
  })
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样保留，报错时更有用 */ }
  return { status: response.status, body }
}

/**
 * 往代理命名空间写一次。
 * @param {string} cookie 浏览器 cookie。
 * @param {Array<{op: string, path: string[], value?: unknown}>} ops 路径操作。
 * @returns {Promise<{ ok: boolean, detail: string }>} 宿主是否接受。
 */
async function mutate(cookie, ops) {
  const { body } = await api('settings/mutate', { ns: NAMESPACE, ops }, cookie)
  const ok = body?.result?.ok === true
  return { ok, detail: JSON.stringify(body?.result?.error ?? body?.result?.value?.user ?? body).slice(0, 160) }
}

async function main() {
  prepareHome()
  const { child, token } = await startDsh()
  try {
    check(true, 'dsh 带全部 --patch 正常启动')

    const exchange = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual', headers: browserHeaders() })
    const cookie = (exchange.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
    check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)

    const index = await (await fetch(`${BASE}/`, { headers: browserHeaders(cookie) })).text()
    check(index.includes(`"id":"${PACKAGE_ID}"`), '首页的 __DSH_BOOT__ 里有代理插件的行')

    const described = await api('settings/describe', {}, cookie)
    const namespaces = described.body?.result?.value?.namespaces ?? []
    check(
      Array.isArray(namespaces) && namespaces.some(entry => entry?.ns === NAMESPACE),
      `宿主注册了设置命名空间 ${NAMESPACE}`,
      JSON.stringify(namespaces.map(entry => entry?.ns)).slice(0, 160),
    )

    // ★ 这条就是用户报的 bug：最常见的本地代理写法必须能存进去。
    const bare = await mutate(cookie, [{ op: 'set', path: ['url'], value: '127.0.0.1:7890' }])
    check(bare.ok, '宿主接受不带协议的 127.0.0.1:7890（回归用例）', bare.detail)

    // 存进去之后再打开开关，也必须被接受 —— 「勾不上」是同一个 bug 的另一面。
    const enable = await mutate(cookie, [{ op: 'set', path: ['enabled'], value: true }])
    check(enable.ok, '地址存好之后可以打开开关', enable.detail)

    // 护栏仍在：真正无法拨号的地址照旧被拒。
    const socks = await mutate(cookie, [{ op: 'set', path: ['url'], value: 'socks5://127.0.0.1:1080' }])
    check(!socks.ok, '宿主仍然拒绝拨不通的 socks5 地址', socks.detail)

    const creds = await mutate(cookie, [{ op: 'set', path: ['url'], value: 'http://user:secret@proxy.test:8080' }])
    check(!creds.ok, '宿主仍然拒绝地址里带凭据', creds.detail)

    // 开着代理却把地址清空，必须被拒（否则进程会静默失去出网能力）。
    const cleared = await mutate(cookie, [{ op: 'set', path: ['url'], value: '' }])
    check(!cleared.ok, '开关开着时不允许把地址清空', cleared.detail)
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
