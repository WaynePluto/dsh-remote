/**
 * 冒烟：确认 dsh 真的把 notify 插件的两半都装上了，设置命名空间真的落了地，
 * 通道真的能把一条通知推到这台机器的桌面上。
 *
 * 这个脚本存在的理由和兄弟插件一样：宿主半靠 `--patch` 叠加层加载，浏览器半靠 dsh 的
 * 客户端模块扫描，任何一环变了都只表现为「fiber FAILED」或「页面少一块」，单元测试
 * 全绿也看不见。本插件另有两条只有真机能验的东西：
 *
 *   · 它在 `approval/request` 与 `user-questions/request` 两个**瀑布**上挂了监听器。
 *     签名对不上是启动即失败，不是运行时才报错。
 *   · **Windows toast 会静默失败。** 未注册 AUMID 的 toast 可以被 API 接受却什么都不显示，
 *     宿主侧观察不到。所以这个脚本会真的弹一条通知，最后一条要靠你自己的眼睛判定。
 *
 * ⚠️ 跑这个脚本会在你的桌面上弹出一条常驻通知，需要你手动关掉。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/notify-check.mjs [--port 3099]
 *
 * 全过程不发起任何模型请求，也不写任何会话。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-notify'
const NAMESPACE = 'dsh-plugin-notify'
const CHANNEL = 'notify'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'notify-check-home')

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
 * 打一次 dsh 的 `/api` 一元 RPC。
 * @param {string} endpoint 形如 `settings/describe`。
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
 * 调一次本插件的通道。
 *
 * ⚠️ 端点在 **URL 路径**里，不只是信封里：dsh 用 `endpointFromPath` 从
 * `${channel}/${endpoint}` 解析（`packages/client/connection/src/rpc-host.ts:259-267`），
 * 只打到 `/notify` 会直接 404；信封里的 `method` 还必须和路径段一致。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: any }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/${CHANNEL}/${method}`, {
    method: 'POST',
    headers: { ...browserHeaders(cookie), 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method, payload }),
  })
  const text = await response.text()
  let body = text
  try { body = JSON.parse(text) } catch { /* 非 JSON 原样保留 */ }
  return { status: response.status, body }
}

async function main() {
  prepareHome()
  const { child, token } = await startDsh()
  try {
    // 这一条最重：两个瀑布的监听器签名对不上、设置命名空间注册被拒，
    // 都会让 fiber FAILED，dsh 就永远走不到打印地址这一步。
    check(true, 'dsh 带全部 --patch 正常启动（两个瀑布监听与设置命名空间都被接受）')

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
      check(body.includes('settings.section'), 'bundle 里带着设置页的槽注册')
      check(body.includes(NAMESPACE), 'bundle 读写的是宿主注册的那个设置命名空间')
      // 两半必须对同一个通道说话，否则测试按钮会安静地 404。
      check(body.includes(`/${CHANNEL}`), 'bundle 里带着测试通道的路径')
    }

    // 设置命名空间真的落了地，而且默认是开着的 —— 这是用户唯一会去改的那一格。
    const described = await api('settings/describe', {}, cookie)
    const sections = described.body?.result?.value?.sections ?? described.body?.result?.value ?? null
    const rendered = JSON.stringify(sections ?? described.body)
    check(rendered.includes(NAMESPACE), '设置里出现了本插件的命名空间', rendered.slice(0, 200))

    const mutated = await api('settings/mutate', {
      ns: NAMESPACE,
      ops: [{ op: 'set', path: ['enabled'], value: false }],
    }, cookie)
    check(
      mutated.body?.result?.ok === true,
      '开关能被写入（页面上的那次点击走的就是这条路）',
      JSON.stringify(mutated.body?.result?.error ?? '').slice(0, 200),
    )
    await api('settings/mutate', { ns: NAMESPACE, ops: [{ op: 'set', path: ['enabled'], value: true }] }, cookie)

    const unknownEndpoint = await callChannel('nope', {}, cookie)
    check(
      unknownEndpoint.body?.result?.ok === false
      && unknownEndpoint.body.result.error?.code === 'notify/unknown-endpoint',
      '未知端点被通道自己挡下',
      JSON.stringify(unknownEndpoint.body).slice(0, 200),
    )

    const unauthenticated = await fetch(`${BASE}/${CHANNEL}/test`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'test', payload: {} }),
    })
    check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)

    // 最后一条：真的弹一条。宿主只能报告「通知器返回了成功」——toast 是否真的画在
    // 屏幕上，只有人眼能判定，所以这里同时打印一句提示。
    const sent = await callChannel('test', {}, cookie)
    const value = sent.body?.result?.value
    check(
      sent.status === 200 && sent.body?.result?.ok === true && value?.ok === true,
      '通道发出了一条真实通知',
      JSON.stringify(sent.body).slice(0, 200),
    )
    if (value?.platform !== 'win32') {
      console.log(`[note] 这台机器是 ${value?.platform}，桌面通知在这里本来就不可用。`)
    } else {
      console.log('[看一眼] 桌面右下角现在应该有一条「DSH · 通知测试」的常驻通知，需要你手动关掉。')
      console.log('        如果什么都没出现：先看「专注助手」，再看 Windows 通知设置里有没有 “DeepSeek Harness”。')
    }
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
