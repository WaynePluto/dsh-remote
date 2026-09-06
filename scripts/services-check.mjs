/**
 * 冒烟：确认 dsh 真的把 services 插件的两半都装上了，工具真的注册进去了，通道也是活的。
 *
 * 这个脚本存在的理由和兄弟插件一样：宿主半靠 `--patch` 叠加层加载，浏览器半靠 dsh 的
 * 客户端模块扫描。两条链路里任何一环变了，dsh 都只会以「fiber FAILED」或「页面少一块」
 * 的形式表现出来，单元测试全绿也看不见。
 *
 * 本插件比兄弟插件多两条只有真机能验的东西：
 *   · 它往 `ctx.tools` 注册了五个工具。工具名撞车（dsh 将来自带同名工具、或者别的插件
 *     先占了）是**启动即抛错**（`tools.register` 对重名直接 throw），不是少一个工具。
 *   · 它的工具 schema 由 `defineTool` 在注册时转换并校验；schema 写错同样是启动即失败。
 * 所以「dsh 正常启动并打印带 token 的地址」这一条在这里的分量比别处更重。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/services-check.mjs [--port 3099]
 *
 * 全过程不发起任何模型请求，不写任何会话，也不启动任何常驻服务。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-services'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'services-check-home')

/** 本插件注册的全部工具名，必须和 src/index.ts 保持一致。 */
const TOOL_NAMES = ['service_start', 'service_list', 'service_logs', 'service_stop', 'service_restart']

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
 * `${channel}/${endpoint}` 解析，只打到 `/services` 会直接 404；信封里的 `method`
 * 还必须和路径段一致，否则报错（docs/02 §10.8）。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: unknown }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/services/${method}`, {
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
 * 在本进程里加载**宿主构建产物**，跑一遍 `apply()`，看它到底注册了什么。
 *
 * 为什么必须做这一步：dsh **没有**把工具表暴露成任何 `/api` 方法（`packages/api/**`
 * 里搜不到 `tools.describe` 之类的东西），所以「五个工具真的在模型看得见的那张表里」
 * 从外面根本观察不到。而这恰恰是本插件最核心的产出。
 *
 * 单元测试跑的是源码，这一步跑的是**要发出去的字节**：走 tsdown 的 externals 配置、
 * 走真实的 `defineTool`（schema 转换与校验都发生在这里）、走真实的 `ctx.tools.register`
 * 语义。dsh 能启动只证明注册没抛错，证明不了注册了哪五个。
 * @returns {Promise<{ tools: {name: string, parameters: object, description: string}[], channels: string[], disposers: number }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'services', 'dist', 'index.js')
  const module = await import(pathToFileURL(entry).href)

  const tools = []
  const channels = []
  let disposers = 0
  const noop = () => {}
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return noop } },
    connection: { rpc: { handle: (channel) => { channels.push(channel); return noop } } },
    agents: { get: () => undefined },
    effect: (run) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers += 1
      return noop
    },
    get: () => undefined,
  }
  module.apply(ctx, { approvalInConfinedSandbox: true })
  return { tools, channels, disposers }
}

/**
 * 在 vm 里加载**浏览器构建产物**，跑一遍 `apply()`，看它到底占了哪个座位。
 *
 * shim 只提供加载器和模块表里那几个允许留成 import 的说明符。插件如果偷偷依赖了别的
 * 全局或别的模块，这里就会当场炸开 —— 那正是页面上会发生的事，只是这里炸得早、也看得见。
 * `apply()` 本身不渲染 React，只注册文案和座位，所以 shim 不需要真的 React。
 *
 * ⚠️ `@deepseek-ai/dsh-client-ui-primitives` 是本插件**故意**留成外部的：它在 dsh 的
 * `PLATFORM_MODULES` 里（`packages/client/web/src/platform.ts`），页面会把 `Modal` 和
 * 图标连同它们**已经加载的 CSS** 一起交给我们，好过自己再实现一套、并且和 dsh 自己的
 * 面板慢慢走偏。代价是：它哪天从那张表里消失，页面会在加载本插件时抛错 ——
 * 所以下面显式断言「要的东西恰好都在表里」。
 * @returns {{ seats: object[], namespaces: string[], externals: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'services', 'dist', 'client.js')
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
      return { useState: noop, useEffect: noop, useCallback: noop, useMemo: noop, useRef: () => ({}), createElement: noop }
    }
    if (id === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: noop }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        Modal: noop, IconApiOutline14: noop,
        IconChevronUpOutline14: noop, IconChevronDownOutline14: noop,
      }
    }
    throw new Error(`bundle 要求页面模块表之外的模块：${id}`)
  })

  const seats = []
  const namespaces = []
  const ctx = {
    effect: (run) => { run(); return noop },
    locale: { register: (ns) => { namespaces.push(ns); return noop } },
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
  const registered = artifact.tools.map(tool => tool.name)
  const missing = TOOL_NAMES.filter(tool => !registered.includes(tool))
  check(missing.length === 0, '宿主产物的 apply() 注册了全部五个 service_* 工具',
    missing.length === 0 ? `实际：${registered.join('、')}` : `缺 ${missing.join('、')}`)
  check(registered.length === TOOL_NAMES.length, '没有多注册别的工具', `共 ${registered.length} 个`)
  check(artifact.channels.includes('/services'), '宿主产物挂上了 /services 通道',
    artifact.channels.join('、'))
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')
  // schema 由 defineTool 在注册时转换；转坏了这里就不是一个合法的 JSON Schema 对象。
  const startTool = artifact.tools.find(tool => tool.name === 'service_start')
  check(
    startTool?.parameters?.type === 'object'
    && startTool.parameters.properties?.command?.type === 'string'
    && Array.isArray(startTool.parameters.required)
    && startTool.parameters.required.includes('command'),
    'service_start 的参数 schema 是合法的 JSON Schema 且 command 必填',
    JSON.stringify(startTool?.parameters?.required),
  )
  // 描述里必须写明它绕过沙箱，否则模型没有理由预期一次批准提问。
  check(
    (startTool?.description ?? '').includes('outside the sandbox'),
    'service_start 的描述告诉模型它跑在沙箱之外',
  )

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // list 槽靠 order 排先后；`conversation.input.dock` 不是 keyed 槽，所以不会和
  // dsh 自己的 todo（0）、队列（20）或本仓库的重试横幅（30）抢同一个格子。
  check(seat?.name === 'conversation.input.dock', '座位是输入框上方那个 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-services', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number', '声明了 order，不靠注册先后决定位置', String(seat?.order))
  check(client.namespaces.includes('dsh-plugin-services'), '文案命名空间也是包名后缀',
    client.namespaces.join('、'))
  // dsh 分享给页面的模块表，抄自 packages/client/web/src/platform.ts。
  const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.includes(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)
  check(client.externals.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'Modal 与图标是向页面借的，没有被打进 bundle 变成第二份')

  const { child, token } = await startDsh()
  try {
    // 这一条最重：五个工具的注册（含重名检测与 schema 转换）都发生在 apply() 里，
    // 任何一个被拒都会让 fiber FAILED，dsh 就永远走不到打印地址这一步。
    check(true, 'dsh 带全部 --patch 正常启动（五个工具注册与通道挂载都被接受）')

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
      check(body.includes('/services'), 'bundle 里带着宿主那条私有通道的路径')
      // 面板靠轮询活着；这个常量没打进去说明客户端半被摇树摇错了。
      check(body.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
    }

    // 工具真的进了模型看得见的那张表 —— 这一条在 dsh 启动前已经用产物验过了
    // （dsh 没有把工具表暴露成 API，从外面观察不到）。这里只补一句它没白启动。

    // 通道活着：一个没有活 agent 的会话应当拿到一份空快照，而不是 404 或 500。
    const list = await callChannel('list', { sessionId: 'no-such-session' }, cookie)
    check(
      list.status === 200 && list.body?.result?.ok === true && list.body.result.value?.cwd === null,
      '/services 通道已挂载，且对没有活 agent 的会话返回空快照',
      JSON.stringify(list.body),
    )

    const malformed = await callChannel('list', {}, cookie)
    check(
      malformed.body?.result?.ok === false
      && malformed.body.result.error?.code === 'services/bad-payload',
      '缺少 sessionId 的调用被通道自己挡下',
      JSON.stringify(malformed.body),
    )

    // 面板刻意没有 start 端点：造一个服务要带命令，那是被批准门管着的工具的事。
    const start = await callChannel('start', { sessionId: 'x', name: 'y' }, cookie)
    check(
      start.body?.result?.ok === false
      && start.body.result.error?.code === 'services/unknown-endpoint',
      '通道上没有 start 端点（创建服务只能走带批准门的工具）',
      JSON.stringify(start.body),
    )

    const unauthenticated = await fetch(`${BASE}/services/list`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'list', payload: { sessionId: 'x' } }),
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
