/**
 * 冒烟：确认 dsh 真的把 terminal 插件的两半都装上了，PTY 三件套真的挂进了 web profile，
 * 通道也是活的。
 *
 * 这个脚本比兄弟插件多做两件只有真机能验的事，两件都不是可选的：
 *
 *   · **本插件用 `ctx.plugin()` 挂载 dsh 自己的三个包**（`dsh-terminal` /
 *     `-terminal-bash` / `-tool-terminal`）。它们解析不到、版本对不上、或者
 *     `terminals` 服务被别处抢先注册，都是**启动即 fiber FAILED**，单元测试全绿也
 *     看不见。所以「dsh 打印出带 token 的地址」这一条在这里分量最重。
 *   · **六个上游 `terminal_*` 工具来自 dsh；本插件只改名为 `interactive_terminal_*`，不重写执行逻辑**，而 dsh 没有把工具表暴露成
 *     任何 `/api` 方法。要确认它们真的进了模型看得见的那张表，只能把宿主产物 import
 *     进来跑一遍 `apply()`，看 `ctx.tools.register` 到底收到了什么。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/terminal-check.mjs [--port 3098]
 *
 * 全过程不发起任何模型请求，不写任何会话；会真的起一个 pwsh/bash PTY 并立刻关掉。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-terminal'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'terminal-check-home')

/** dsh 上游六个原名；wrapper 必须确保它们不出现在模型工具表。 */
const UPSTREAM_TOOL_NAMES = [
  'terminal_open', 'terminal_send', 'terminal_read',
  'terminal_signal', 'terminal_close', 'terminal_list',
]
const TOOL_NAMES = [
  'interactive_terminal_open', 'interactive_terminal_send', 'interactive_terminal_read',
  'interactive_terminal_signal', 'interactive_terminal_close', 'interactive_terminal_list',
]

/** 本插件通道上的全部端点。 */
const ENDPOINTS = ['list', 'read', 'send', 'interrupt']

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
 * `${channel}/${endpoint}` 解析，只打到 `/terminal` 会直接 404；信封里的 `method`
 * 还必须和路径段一致，否则报错（docs/02 §10.8）。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: unknown }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/terminal/${method}`, {
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
 * 在本进程里加载**宿主构建产物**，跑一遍 `apply()`，看它到底挂了什么。
 *
 * 为什么必须做这一步：本插件自己一个执行逻辑都没写，六个上游 `terminal_*` 全部来自
 * `@deepseek-ai/dsh-tool-terminal`，而**这三个包是本插件用 `ctx.plugin()` 挂进去的**。
 * 「dsh 能启动」只证明没抛错，证明不了挂的是哪三个、工具表里最后有哪六个。
 * @returns {Promise<{ tools: object[], sections: object[], channels: string[], plugins: unknown[], disposers: number, module: object }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'terminal', 'dist', 'index.js')
  const module = await import(pathToFileURL(entry).href)

  const tools = []
  const sections = []
  const channels = []
  const plugins = []
  const mountFailures = []
  let disposers = 0
  const noop = () => {}
  /**
   * 一个足够真实的假 ctx：它会把 `ctx.plugin()` 收到的插件**真的跑一遍**，
   * 因为「六个工具进没进表」正是那三个包的 apply 决定的。
   *
   * `terminals` 在这里是个占位对象：`tool-terminal` 把它声明成硬注入，只有拿得到
   * 才会往 `ctx.tools` 注册；它在工具真正执行时才会去用上面的方法，而这个脚本
   * 一个工具都不执行。
   * @returns {object} 假上下文。
   */
  const makeCtx = () => ({
    tools: { register: (definition) => { tools.push(definition); return noop } },
    connection: { rpc: { handle: (channel) => { channels.push(channel); return noop } } },
    agents: { get: () => undefined },
    systemPrompt: { section: (definition) => { sections.push(definition); return noop }, getSectionOrder: () => 0 },
    terminals: { registerBackend: () => noop, listBackends: () => [], list: () => [] },
    jobs: undefined,
    effect: (run) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers += 1
      return noop
    },
    inject: () => noop,
    get: (service) => service === 'terminals'
      ? { registerBackend: () => noop, listBackends: () => [], list: () => [] }
      : undefined,
    plugin: (plugin, config) => {
      plugins.push(plugin)
      // Only object plugins are run here. A Service CLASS (the registry) carries
      // `Function.prototype.apply`, which is not an apply hook — calling it
      // would throw "cannot be invoked without 'new'" and prove nothing.
      const isObjectPlugin = typeof plugin?.apply === 'function'
        && plugin.apply !== Function.prototype.apply
      if (isObjectPlugin) {
        try {
          plugin.apply(makeCtx(), plugin.Config === undefined ? config : new plugin.Config(config ?? {}))
        } catch (error) {
          mountFailures.push(`${String(plugin.name ?? 'anonymous')}: ${error.message}`)
        }
      }
      return noop
    },
  })
  module.apply(makeCtx(), new module.Config({}))
  return { tools, sections, channels, plugins, disposers, mountFailures, module }
}

/**
 * 在 vm 里加载**浏览器构建产物**，跑一遍 `apply()`，看它到底占了哪个座位。
 *
 * shim 只提供加载器和模块表里那两个允许留成 import 的说明符。插件如果偷偷依赖了别的
 * 全局或别的模块，这里就会当场炸开 —— 那正是页面上会发生的事，只是这里炸得早、也看得见。
 * @returns {{ seats: object[], namespaces: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'terminal', 'dist', 'client.js')
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
    // ⚠️ 故意留成外部：它在 dsh 的 PLATFORM_MODULES 里，页面把图标连同已加载的 CSS
    // 一起交给我们，dock 卡片才跟 dsh 自己的 todo 条目长得一样（AGENTS.md 的 dock 约定）。
    // 代价是它哪天从那张表里消失，页面加载本插件时会抛错 —— 所以下面显式断言。
    if (id === '@deepseek-ai/dsh-client-ui-primitives') {
      return {
        IconApiOutline14: noop,
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
  return { seats, namespaces, externals }
}

async function main() {
  prepareHome()

  // 先验产物，再起 dsh：产物错了就没必要花 60 秒等一个必然失败的启动。
  const artifact = await inspectHostBundle()
  const registered = artifact.tools.map(tool => tool.name)
  const missing = TOOL_NAMES.filter(tool => !registered.includes(tool))
  const leaked = UPSTREAM_TOOL_NAMES.filter(tool => registered.includes(tool))
  const open = artifact.tools.find(tool => tool.name === 'interactive_terminal_open')
  const guidance = artifact.sections.find(section => section.name === 'tool:pty')?.text ?? ''
  check(missing.length === 0 && leaked.length === 0 && registered.length === TOOL_NAMES.length, '宿主产物只暴露六个 interactive_terminal_* 工具',
    missing.length === 0
      ? `实际：${registered.join('、')}`
      : `缺 ${missing.join('、')}${artifact.mountFailures.length === 0 ? '' : `；挂载失败：${artifact.mountFailures.join(' | ')}`}`)
  check(leaked.length === 0, '没有泄漏任何上游 terminal_* 别名', leaked.join('、'))
  check(open?.description?.includes('ordinary one-shot commands') === true
    && open.description.includes('pwsh') && open.description.includes('run_in_background'),
  'interactive_terminal_open 自身描述禁止普通一次性命令')
  check(guidance.includes('interactive_terminal_*') && guidance.includes('one-shot commands')
    && guidance.includes('run_in_background'), 'PTY 系统指引明确交互终端边界')

  check(artifact.plugins.length === 3, '挂载了三个 dsh 包（registry / backend / tools）',
    `共 ${artifact.plugins.length} 个`)
  check(artifact.channels.includes('/terminal'), '宿主产物挂上了 /terminal 通道',
    artifact.channels.join('、'))
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')

  // pwsh 的 argv 是 Windows 上能不能开出终端的分水岭：带上 PSReadLine 会让 dsh 的
  // 就绪探测随机失败（实测 7/10），去掉之后 20/20。这一条锁死默认值。
  const host = artifact.module
  const pwshArgs = host.pwshShellArgs()
  check(pwshArgs.includes('-NoProfile') && pwshArgs.includes('-NoExit'),
    'pwsh argv 带着 -NoProfile 与 -NoExit', pwshArgs.join(' '))
  check(host.PWSH_READLINE_SETUP.includes('Remove-Module PSReadLine'),
    'pwsh 启动时移除 PSReadLine（dsh 的就绪探测会被它的重绘打乱）')
  check(host.backendConfig(new host.Config({}), 'linux').shellArgs === undefined,
    'bash 保持 dsh 自己的默认 argv，不被这套 Windows 修补波及')

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // list 槽靠 order 排先后；`conversation.input.dock` 不是 keyed 槽，所以不会和
  // dsh 自己的 todo（0）、队列（20）或本仓库的服务面板（10）、重试横幅（30）抢格子。
  check(seat?.name === 'conversation.input.dock', '座位是输入框上方那个 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-terminal', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number', '声明了 order，不靠注册先后决定位置', String(seat?.order))
  check(client.namespaces.includes('dsh-plugin-terminal'), '文案命名空间也是包名后缀',
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
    'dock 卡片的图标是向页面借的，没有被打进 bundle 变成第二份')

  const { child, token } = await startDsh()
  try {
    // 这一条最重：三个 dsh 包的挂载、六个工具的注册（含重名检测与 schema 转换）、
    // `terminals` 服务的发布都发生在 apply() 里，任何一个被拒都会让 fiber FAILED，
    // dsh 就永远走不到打印地址这一步。
    check(true, 'dsh 带全部 --patch 正常启动（PTY 三件套挂载与六个工具注册都被接受）')

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
      check(body.includes('conversation.input.dock'), 'bundle 里带着输入框上方的槽注册')
      check(body.includes('/terminal'), 'bundle 里带着宿主那条私有通道的路径')
      // 面板靠轮询活着；这个常量没打进去说明客户端半被摇树摇错了。
      check(body.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
    }

    // 通道活着：一个没有活 agent 的会话应当拿到一份说明原因的空快照，而不是 404 或 500。
    const list = await callChannel('list', { sessionId: 'no-such-session' }, cookie)
    check(
      list.status === 200 && list.body?.result?.ok === true
      && Array.isArray(list.body.result.value?.terminals)
      && list.body.result.value.terminals.length === 0
      && list.body.result.value.unavailable === 'no-agent',
      '/terminal 通道已挂载，且对没有活 agent 的会话如实报 no-agent',
      JSON.stringify(list.body),
    )

    const malformed = await callChannel('list', {}, cookie)
    check(
      malformed.body?.result?.ok === false
      && malformed.body.result.error?.code === 'terminal/bad-payload',
      '缺少 sessionId 的调用被通道自己挡下',
      JSON.stringify(malformed.body),
    )

    // 面板刻意没有 open / close 端点：造一个 shell 是「凭空多出一份能力」，
    // 只能走 turn 里的 interactive_terminal_open（包装上游 terminal_open），那里有转录也有审批栈。
    for (const forbidden of ['open', 'close']) {
      const attempt = await callChannel(forbidden, { sessionId: 'x', terminalId: 'pty-1' }, cookie)
      check(
        attempt.body?.result?.ok === false
        && attempt.body.result.error?.code === 'terminal/unknown-endpoint',
        `通道上没有 ${forbidden} 端点（开/关终端只能走模型工具）`,
        JSON.stringify(attempt.body),
      )
    }
    check(ENDPOINTS.length === 4, '通道只有四个端点', ENDPOINTS.join('、'))

    const unauthenticated = await fetch(`${BASE}/terminal/list`, {
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
