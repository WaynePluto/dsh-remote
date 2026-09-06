/**
 * 冒烟：确认 dsh 真的把 tools-inspector 的两半都装上了，「工具」tab 真的进了会话头部的
 * 视图切换栏，通道也是活的、能吐出真实的工具表。
 *
 * 这个脚本存在的理由和兄弟插件一样：宿主半靠 `--patch` 叠加层加载，浏览器半靠 dsh 的
 * 客户端模块扫描。两条链路里任何一环变了，dsh 都只会以「fiber FAILED」或「页面少一块」
 * 的形式表现出来，单元测试全绿也看不见。
 *
 * 本插件多两条只有真机能验的东西：
 *   · `conversation.view` 是 **list 槽**，dsh 的 chat(0) / trajectory(10) 已经在里面。
 *     槽名写错、或者哪天它变成 keyed 槽，都是**启动即抛错**，不是少一个 tab。
 *   · `ctx.tools.schemas(scope)` 是 dsh 的私有面之一，签名变了同样是启动即失败。
 *     而它的返回值**只有** name / description / parameters 三个字段
 *     （dsh `packages/core/tools/src/index.ts:1247` 的 `schemaOf`）——下面显式断言这件事，
 *     多出字段说明 dsh 改了投影，投影逻辑要跟着复核。
 *
 * ⚠️ 本插件是**只读观察窗口**：不注册工具、不 restrict、不 guard。下面显式断言这一点 ——
 * 观察工具一旦有了副作用，它就不再是观察工具了。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/tools-inspector-check.mjs [--port 3099]
 *
 * 全过程不发起任何模型请求，也不写任何会话。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-tools-inspector'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'tools-inspector-check-home')

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
  const args = [
    DSH_BIN, '--profile', DSH_PROFILE,
    ...overlays.flatMap(overlay => ['--patch', overlay]),
    '--no-open', '--host', '127.0.0.1', '--port', String(PORT), '--trusted-host', '127.0.0.1',
  ]
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: HOME },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return await new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      reject(new Error(`dsh 60 秒内没有就绪。输出：\n${output}`))
    }, 60_000)
    const scan = (chunk) => {
      output += chunk
      const found = /token=([\w-]+)/u.exec(output)
      if (found) {
        clearTimeout(timer)
        resolve({ child, token: found[1] })
      }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`dsh 退出，code ${code}。输出：\n${output}`))
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
 * 端点在 **URL 路径**里，不只是信封里：只打到 `/tools-inspector` 会直接 404，
 * 且信封里的 `method` 必须和路径段一致（docs/02 §10.8）。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: unknown }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/tools-inspector/${method}`, {
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

/**
 * 在本进程里加载**宿主构建产物**，跑一遍 `apply()`，看它到底碰了什么。
 *
 * 这一步跑的是**要发出去的字节**：走 tsdown 的 externals 配置、走真实的模块图。
 * 重点断言「什么都没注册」—— 这是本插件与兄弟插件相反的地方。
 * @returns {Promise<{ channels: string[], events: string[], tools: number, restricts: number, guards: number, disposers: number }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'tools-inspector', 'dist', 'index.js')
  const module = await import(pathToFileURL(entry).href)

  const channels = []
  const events = []
  let tools = 0
  let restricts = 0
  let guards = 0
  let disposers = 0
  const noop = () => {}
  const ctx = {
    tools: {
      register: () => { tools += 1; return noop },
      restrict: () => { restricts += 1; return noop },
      guard: () => { guards += 1; return noop },
      schemas: () => [],
    },
    connection: { rpc: { handle: (channel) => { channels.push(channel); return noop } } },
    agents: { get: () => undefined },
    on: (event) => { events.push(event); return noop },
    effect: (run) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers += 1
      return noop
    },
    get: () => undefined,
  }
  module.apply(ctx)
  return { channels, events, tools, restricts, guards, disposers }
}

/**
 * 用宿主产物的 `dispatch()` 走一遍完整链路：仿一个带会话日志的 agent，
 * 验它真的从 `tool/call` 事件里回放出了调用次数。
 *
 * 这是本插件最容易错的地方 —— 第一版用进程内累加，结果重启就归零、历史一次都数不出来。
 * 这里用一份**含历史**的假日志把正确行为钉住。
 * @returns {Promise<object>} 一份快照。
 */
async function inspectProjection() {
  const entry = join(ROOT, 'packages', 'plugins', 'tools-inspector', 'dist', 'index.js')
  const module = await import(pathToFileURL(entry).href)

  const events = [
    { type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    { type: 'tool/call', data: { callId: 'c2', name: 'read' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c2' } }, error: { code: 'BOOM' } } },
  ]
  const agent = { session: { snapshotEvents: () => events } }
  const ctx = {
    agents: { get: () => agent },
    tools: {
      schemas: () => [
        { name: 'ralph', description: 'loop' },
        { name: 'read', description: 'Read  a\n\nfile', parameters: { properties: { p: {}, q: {} }, required: ['p'] } },
      ],
    },
  }
  const outcome = module.dispatch(ctx, 'snapshot', { sessionId: 's1' })
  if (outcome.ok !== true) throw new Error(`dispatch 失败：${JSON.stringify(outcome)}`)
  return outcome.value
}

/**
 * 在 vm 里加载**浏览器构建产物**，跑一遍 `apply()`，看它到底占了哪个座位。
 *
 * shim 只提供加载器和模块表里那几个允许留成 import 的说明符。插件如果偷偷依赖了别的
 * 全局或别的模块，这里就会当场炸开 —— 那正是页面上会发生的事，只是这里炸得早、也看得见。
 * @returns {{ seats: object[], namespaces: string[], externals: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'tools-inspector', 'dist', 'client.js')
  const source = readFileSync(bundle, 'utf8')
  let loaded = null
  const noop = () => {}
  const sandbox = { window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } }, console }
  runInContext(source, createContext(sandbox), { filename: bundle })
  if (loaded === null) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
  if (loaded.id !== PACKAGE_ID) throw new Error(`bundle 自称 ${loaded.id}，应当是 ${PACKAGE_ID}`)
  const externals = []
  const exports = loaded.factory((id) => {
    externals.push(id)
    if (id === 'react') {
      return { useState: noop, useEffect: noop, useCallback: noop, useMemo: noop, createElement: noop }
    }
    if (id === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: noop }
    throw new Error(`bundle 要求页面模块表之外的模块：${id}`)
  })

  const seats = []
  const namespaces = []
  const ctx = {
    effect: (run) => { run(); return noop },
    locale: { register: (ns) => { namespaces.push(ns); return noop }, bind: () => (key => key) },
    slots: {
      inject: (_name, run) => { run() },
      register: (options) => { seats.push(options); return noop },
    },
    get: () => undefined,
  }
  exports.apply(ctx)
  return { seats, namespaces, externals: [...new Set(externals)] }
}

async function main() {
  prepareHome()

  // 先验产物，再起 dsh：产物错了就没必要花 60 秒等一个必然失败的启动。
  const artifact = await inspectHostBundle()
  check(artifact.channels.includes('/tools-inspector'), '宿主产物挂上了 /tools-inspector 通道',
    artifact.channels.join('、'))
  check(artifact.events.length === 0,
    '宿主产物不再监听任何事件（计数改为回放会话日志，重启后依然准确）',
    artifact.events.join('、') || '（没有）')
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')
  // ⚠️ 这三条是本插件的定义性约束：它是只读观察窗口。
  check(artifact.tools === 0, '宿主产物没有注册任何工具（观察窗口不该改变工具表）',
    `实际 ${artifact.tools} 个`)
  check(artifact.restricts === 0 && artifact.guards === 0,
    '宿主产物没有调用 tools.restrict/guard（不改变 agent 能看到什么）',
    `restrict ${artifact.restricts}、guard ${artifact.guards}`)

  const snapshot = await inspectProjection()
  check(snapshot.registered === 2 && snapshot.used === 1 && snapshot.totalCalls === 2,
    '从会话日志的 tool/call 回放出了调用次数（不是进程内累加）', JSON.stringify({
      registered: snapshot.registered, used: snapshot.used, totalCalls: snapshot.totalCalls,
    }))
  check(snapshot.entries[0]?.name === 'read' && snapshot.entries[1]?.name === 'ralph',
    '已用的排在未用的前面', snapshot.entries.map(entry => entry.name).join('、'))
  check(snapshot.entries[0]?.description === 'Read a file',
    '描述里的换行与连续空白被折成单行', JSON.stringify(snapshot.entries[0]?.description))
  check(snapshot.entries[0]?.failures === 1, '失败次数被单独计出')
  // 只有两档状态：dsh 没有 deferred tool loading（docs/02 §15.2）。
  const statuses = [...new Set(snapshot.entries.map(entry => entry.status))].sort()
  check(statuses.every(status => status === 'used' || status === 'unused'),
    '状态只有 used / unused 两档（dsh 没有工具延迟加载）', statuses.join('、'))

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // `conversation.view` 是 list 槽，dsh 自己的 chat(0)、trajectory(10) 已经在里面。
  check(seat?.name === 'conversation.view', '座位是会话头部那个视图切换栏的 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-tools-inspector', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number' && seat.order > 10,
    'order 排在 dsh 自带的 chat(0) 与 trajectory(10) 之后', String(seat?.order))
  // ⚠️ label 必须是 thunk，否则切换语言后 tab 文字不跟着变。
  check(typeof seat?.label === 'function', 'tab 文案是 thunk，跟随语言切换', typeof seat?.label)
  check(client.namespaces.includes('dsh-plugin-tools-inspector'), '文案命名空间也是包名后缀',
    client.namespaces.join('、'))
  const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.includes(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)

  const { child, token } = await startDsh()
  try {
    check(true, 'dsh 带全部 --patch 正常启动（槽注册与通道挂载都被接受）')

    const exchange = await fetch(`${BASE}/?token=${token}`, { redirect: 'manual', headers: browserHeaders() })
    const cookie = (exchange.headers.getSetCookie?.() ?? []).map(entry => entry.split(';')[0]).join('; ')
    check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)

    const index = await (await fetch(`${BASE}/`, { headers: browserHeaders(cookie) })).text()
    const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
    check(idAt !== -1, '首页的 __DSH_BOOT__ 里有本插件的行')
    const url = idAt === -1 ? null : /"url":"([^"]+)"/u.exec(index.slice(idAt))?.[1] ?? null

    if (url !== null) {
      const bundle = await fetch(new URL(url.replaceAll('&amp;', '&'), BASE), { headers: browserHeaders(cookie) })
      const body = await bundle.text()
      check(bundle.ok, '插件 bundle 能取到', `status ${bundle.status}`)
      check(body.includes('__ModuleLoader__.load'), 'bundle 是加载器认识的工件格式')
      check(body.includes('conversation.view'), 'bundle 里带着视图切换栏的槽注册')
      check(body.includes('/tools-inspector'), 'bundle 里带着宿主那条私有通道的路径')
      check(body.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
    }

    // 通道活着，并且真的能从 ctx.tools 读出工具表 —— 这是本插件的核心产出，
    // 而 dsh 没有把工具表暴露成任何 /api 方法，所以只有这条路验得到。
    const live = await callChannel('snapshot', { sessionId: 'no-such-session' }, cookie)
    const value = live.body?.result?.value
    check(live.status === 200 && live.body?.result?.ok === true && Array.isArray(value?.entries),
      '/tools-inspector 通道已挂载，且对没有活 agent 的会话退回全局视图',
      JSON.stringify(live.body).slice(0, 200))
    check((value?.registered ?? 0) > 0, '快照里真的读到了工具', `registered=${value?.registered}`)
    // ⚠️ schemas() 只投影三个字段；多出来说明 dsh 改了投影，本插件要跟着复核。
    const extra = value?.entries?.flatMap(entry =>
      Object.keys(entry).filter(key =>
        !['name', 'description', 'status', 'calls', 'failures', 'params', 'required'].includes(key))) ?? []
    check(extra.length === 0, '条目形状没有多出未预期的字段', extra.join('、'))

    const malformed = await callChannel('snapshot', {}, cookie)
    check(
      malformed.body?.result?.ok === false
      && malformed.body.result.error?.code === 'tools-inspector/bad-payload',
      '缺少 sessionId 的调用被通道自己挡下',
      JSON.stringify(malformed.body),
    )

    const unknown = await callChannel('reset', { sessionId: 'x' }, cookie)
    check(
      unknown.body?.result?.ok === false
      && unknown.body.result.error?.code === 'tools-inspector/unknown-endpoint',
      '通道上只有 snapshot 一个端点（观察窗口没有写操作）',
      JSON.stringify(unknown.body),
    )

    const unauthenticated = await fetch(`${BASE}/tools-inspector/snapshot`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'snapshot', payload: { sessionId: 'x' } }),
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
