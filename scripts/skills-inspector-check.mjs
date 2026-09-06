/**
 * 冒烟：确认 dsh 真的把 skills-inspector 的两半都装上了，「技能」tab 真的进了会话头部的
 * 视图切换栏，通道也是活的、能吐出真实的技能目录。
 *
 * 这个脚本存在的理由和兄弟插件一样：宿主半靠 `--patch` 叠加层加载，浏览器半靠 dsh 的
 * 客户端模块扫描。两条链路里任何一环变了，dsh 都只会以「fiber FAILED」或「页面少一块」
 * 的形式表现出来，单元测试全绿也看不见。
 *
 * 本插件多几条只有真机能验的东西：
 *   · `conversation.view` 是 **list 槽**，dsh 的 chat(0) / trajectory(10) 与本仓库的
 *     tools-inspector(20) 已经在里面。槽名写错、或者哪天它变成 keyed 槽，
 *     都是**启动即抛错**，不是少一个 tab。
 *   · `ctx.skills.snapshot()` / `get()` 是 dsh 的私有面，签名变了同样是启动即失败。
 *   · **`SkillSummary` 上没有 `path`**（`list()` 投影掉了），精确文件路径只能靠
 *     `skills.get()` 拿 —— 下面对着真 dsh 显式验一次，这是「点击打开本地文件」的地基。
 *   · **技能来源桶**（project-dsh / user-dsh / bundled …）是「全局还是项目级」的
 *     权威答案，dsh 改了枚举这里就该发现。
 *
 * ⚠️ 本插件是**只读观察窗口**：不注册技能、不注册工具、不 restrict、不 guard。
 * 下面显式断言这一点 —— 观察工具一旦有了副作用，它就不再是观察工具了。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/skills-inspector-check.mjs [--port 3098]
 *
 * 全过程不发起任何模型请求，也不写任何会话。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { createContext, runInContext } from 'node:vm'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-skills-inspector'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'skills-inspector-check-home')
/** 宿主产物路径，两处都要用。 */
const HOST_ENTRY = join(ROOT, 'packages', 'plugins', 'skills-inspector', 'dist', 'index.js')

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
 * 端点在 **URL 路径**里，不只是信封里：只打到 `/skills-inspector` 会直接 404，
 * 且信封里的 `method` 必须和路径段一致（docs/02 §10.8）。
 * @param {string} method 端点名。
 * @param {unknown} payload 载荷。
 * @param {string} [cookie] 浏览器 cookie；不传就是未认证调用。
 * @returns {Promise<{ status: number, body: unknown }>} 状态码与解析后的应答。
 */
async function callChannel(method, payload, cookie) {
  const response = await fetch(`${BASE}/skills-inspector/${method}`, {
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
 * 重点断言「什么都没注册」—— 这是只读观察窗口的定义。
 * @returns {Promise<{ channels: string[], events: string[], skills: number, tools: number, restricts: number, guards: number, disposers: number }>}
 */
async function inspectHostBundle() {
  const module = await import(pathToFileURL(HOST_ENTRY).href)

  const channels = []
  const events = []
  let skills = 0
  let tools = 0
  let restricts = 0
  let guards = 0
  let disposers = 0
  const noop = () => {}
  const ctx = {
    skills: {
      register: () => { skills += 1; return noop },
      registerProvider: () => { skills += 1; return noop },
      snapshot: () => Promise.resolve({ skills: [], complete: true }),
      list: () => Promise.resolve([]),
      get: () => Promise.resolve(undefined),
    },
    tools: {
      register: () => { tools += 1; return noop },
      restrict: () => { restricts += 1; return noop },
      guard: () => { guards += 1; return noop },
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
  return { channels, events, skills, tools, restricts, guards, disposers }
}

/**
 * 用宿主产物的 `dispatch()` 走一遍完整投影：仿一个带会话日志的 agent，
 * 验它真的从两条加载路径里回放出了「已加载」。
 *
 * 这是本插件最核心也最容易错的地方：模型加载走 `tool/call`（name=skill，
 * 技能名藏在**原始参数串**里），用户加载走 `user/message`
 * （`source.kind === 'skill-invocation'`）。两条都得数对，失败的那次不能算。
 * @returns {Promise<{ snapshot: object, lookup: object }>} 快照与宿主实际用的 lookup。
 */
async function inspectProjection() {
  const module = await import(pathToFileURL(HOST_ENTRY).href)

  const events = [
    // 模型加载成功
    { type: 'tool/call', data: { callId: 'c1', name: 'skill', arguments: '{"name":"dsh-source"}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    // 模型加载失败 —— 正文从未进上下文，不能算「已加载」
    { type: 'tool/call', data: { callId: 'c2', name: 'skill', arguments: '{"name":"ghost"}' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c2' } }, error: { code: 'X' } } },
    // 模型产出的畸形参数串 —— 绝不能让整个视图崩掉
    { type: 'tool/call', data: { callId: 'c3', name: 'skill', arguments: '{"name":' } },
    // 别的工具，与技能无关
    { type: 'tool/call', data: { callId: 'c4', name: 'read', arguments: '{"name":"git-commit"}' } },
    // 用户 /git-commit
    { type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'git-commit' } } },
  ]
  const agent = { session: { header: { cwd: '/tmp/project' }, snapshotEvents: () => events } }
  let lookup = null
  const ctx = {
    agents: { get: () => agent },
    skills: {
      snapshot: (options) => {
        lookup = options
        return Promise.resolve({
          complete: true,
          skills: [
            {
              name: 'dsh-source',
              description: '定位并  查证\n\ndsh 源码',
              whenToUse: '需要确认 dsh 行为时',
              source: 'project-agents',
              provider: 'local',
              invocation: { modelInvocable: true, userInvocable: true },
              resourceBase: { kind: 'directory', path: '/tmp/project/.agents/skills/dsh-source' },
            },
            {
              name: 'git-commit',
              description: '创建规范 commit',
              source: 'user-dsh',
              provider: 'local',
              invocation: { modelInvocable: false, userInvocable: true },
              resourceBase: { kind: 'directory', path: '/home/me/.dsh/skills/git-commit' },
            },
            {
              name: 'ghost',
              description: '从未成功加载',
              source: 'bundled',
              provider: 'local',
              invocation: { modelInvocable: true, userInvocable: true },
            },
          ],
        })
      },
      get: () => Promise.resolve(undefined),
    },
  }
  const outcome = await module.dispatch(ctx, 'snapshot', { sessionId: 's1' })
  if (outcome.ok !== true) throw new Error(`dispatch 失败：${JSON.stringify(outcome)}`)
  return { snapshot: outcome.value, lookup }
}

/**
 * 在 vm 里加载**浏览器构建产物**，跑一遍 `apply()`，看它到底占了哪个座位。
 *
 * shim 只提供加载器和模块表里那几个允许留成 import 的说明符。插件如果偷偷依赖了别的
 * 全局或别的模块，这里就会当场炸开 —— 那正是页面上会发生的事，只是这里炸得早、也看得见。
 * @returns {{ seats: object[], namespaces: string[], externals: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'skills-inspector', 'dist', 'client.js')
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
    remote: { session: { canOpenWorkspacePath: () => Promise.resolve({ ok: true, value: false }) } },
    get: () => undefined,
  }
  exports.apply(ctx)
  return { seats, namespaces, externals: [...new Set(externals)] }
}

/**
 * 直接对着**真的** dsh 技能注册表验两条本插件赖以成立的事实。
 *
 * 为什么不走 HTTP 通道验这个：技能来自**会话 scope**（agent preset 把 provider 挂在
 * 每会话层），而这个冒烟脚本刻意不创建任何会话 —— 全局层本来就是空的。
 * 所以这里自己搭一个最小注册表 + 文件系统 provider，指向本仓库真实的
 * `.agents/skills`，把两条事实钉死：
 *
 *   1. **`list()` 投影掉了 `path`**（只留 resourceBase），所以列表拿不到精确文件；
 *   2. **`get()` 才给出精确的 `SKILL.md` 路径** —— 「点击打开本地文件」的地基。
 *
 * 这两条一旦被 dsh 改掉，页面会安静地退化成「这个技能没有本地文件」，
 * 而单元测试与 HTTP 冒烟都看不出来。
 * @returns {Promise<{ listed: object｜undefined, loadedPath: string｜undefined }>}
 */
async function verifySkillPath() {
  const paths = [join(ROOT, 'packages', 'launcher')]
  const { default: SkillRegistry } = await import(
    pathToFileURL(require_(paths, '@deepseek-ai/dsh-skill')).href)
  const filesystem = await import(
    pathToFileURL(require_(paths, '@deepseek-ai/dsh-skill-filesystem')).href)
  const { Context } = await import(pathToFileURL(require_(paths, '@deepseek-ai/cordis')).href)

  const ctx = new Context()
  ctx.plugin(SkillRegistry, {})
  // 只看本仓库的 .agents/skills，不去碰用户的全局技能目录。
  ctx.plugin(filesystem.default ?? filesystem, {
    skillDirs: [join(ROOT, '.agents', 'skills')],
    includeUserRoots: false,
  })
  await ctx.start?.()

  const lookup = { cwd: ROOT }
  const listed = (await ctx.skills.list(lookup)).find(skill => skill.name === 'dsh-source')
  const loaded = listed === undefined ? undefined : await ctx.skills.get('dsh-source', lookup)
  return { listed, loadedPath: loaded?.path }
}

/**
 * 从指定目录解析一个包的入口。
 * @param {string[]} paths 解析基准目录。
 * @param {string} id 包名。
 * @returns {string} 入口绝对路径。
 */
function require_(paths, id) {
  return createRequire(join(ROOT, 'package.json')).resolve(id, { paths })
}

async function main() {
  prepareHome()

  // 先验产物，再起 dsh：产物错了就没必要花 60 秒等一个必然失败的启动。
  const artifact = await inspectHostBundle()
  check(artifact.channels.includes('/skills-inspector'), '宿主产物挂上了 /skills-inspector 通道',
    artifact.channels.join('、'))
  check(artifact.events.length === 0,
    '宿主产物不监听任何事件（「已加载」来自回放会话日志，重启后依然准确）',
    artifact.events.join('、') || '（没有）')
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')
  // ⚠️ 这三条是本插件的定义性约束：它是只读观察窗口。
  check(artifact.skills === 0, '宿主产物没有注册任何技能或技能来源（不改变技能目录）',
    `实际 ${artifact.skills} 次`)
  check(artifact.tools === 0, '宿主产物没有注册任何工具', `实际 ${artifact.tools} 个`)
  check(artifact.restricts === 0 && artifact.guards === 0,
    '宿主产物没有调用 tools.restrict/guard（不改变 agent 能看到什么）',
    `restrict ${artifact.restricts}、guard ${artifact.guards}`)

  const { snapshot, lookup } = await inspectProjection()
  // ⚠️ 与 tools-inspector 同一个坑：scope 必须是 agent 本身，否则只读得到全局层。
  check(lookup?.scope !== undefined && lookup?.cwd === '/tmp/project',
    'skills 查询带上了 scope=agent 与 cwd（否则只读得到全局层）', JSON.stringify(Object.keys(lookup ?? {})))
  check(snapshot.total === 3 && snapshot.loaded === 2,
    '从两条加载路径回放出了「已加载」（模型 tool/call + 用户 skill-invocation）',
    JSON.stringify({ total: snapshot.total, loaded: snapshot.loaded }))

  const byName = Object.fromEntries(snapshot.entries.map(entry => [entry.name, entry]))
  check(byName['dsh-source']?.loaded?.by === 'model', '模型加载的那个被记成 model',
    JSON.stringify(byName['dsh-source']?.loaded))
  check(byName['git-commit']?.loaded?.by === 'user', '用户 /名字 加载的那个被记成 user',
    JSON.stringify(byName['git-commit']?.loaded))
  // 失败的加载不算：正文从未进入上下文。
  check(byName['ghost']?.loaded === undefined, '加载失败的技能不算「已加载」',
    JSON.stringify(byName['ghost']?.loaded))
  check(byName['dsh-source']?.description === '定位并 查证 dsh 源码',
    '描述里的换行与连续空白被折成单行', JSON.stringify(byName['dsh-source']?.description))
  check(byName['git-commit']?.modelInvocable === false,
    '「仅用户可调用」这一档被如实投影（disable-model-invocation 技能）')
  check(byName['dsh-source']?.directory === '/tmp/project/.agents/skills/dsh-source',
    '技能目录来自 resourceBase', String(byName['dsh-source']?.directory))
  // 来源桶就是「全局还是项目级」的答案，不该被我们改写。
  const sources = [...new Set(snapshot.entries.map(entry => entry.source))].sort()
  check(sources.join(',') === 'bundled,project-agents,user-dsh',
    '来源桶原样透传（全局 / 项目级的权威答案）', sources.join('、'))

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // `conversation.view` 是 list 槽，dsh 自己的 chat(0)、trajectory(10) 已经在里面。
  check(seat?.name === 'conversation.view', '座位是会话头部那个视图切换栏的 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-skills-inspector', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number' && seat.order > 20,
    'order 排在 chat(0)、trajectory(10) 与「工具」(20) 之后', String(seat?.order))
  // ⚠️ label 必须是 thunk，否则切换语言后 tab 文字不跟着变。
  check(typeof seat?.label === 'function', 'tab 文案是 thunk，跟随语言切换', typeof seat?.label)
  check(client.namespaces.includes('dsh-plugin-skills-inspector'), '文案命名空间也是包名后缀',
    client.namespaces.join('、'))
  const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.includes(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)

  // ⚠️ 「点击打开本地文件」的地基，对着真注册表验（见 verifySkillPath 的注释）。
  try {
    const { listed, loadedPath } = await verifySkillPath()
    check(listed !== undefined, '真注册表里读到了本仓库的 dsh-source 技能')
    check(listed !== undefined && listed.path === undefined,
      'list() 的 SkillSummary 上没有 path（所以列表不能显示精确文件，必须单独 locate）',
      String(listed?.path))
    check(listed?.resourceBase?.kind === 'directory' && typeof listed.resourceBase.path === 'string',
      'list() 只给到技能目录 resourceBase', JSON.stringify(listed?.resourceBase))
    check(typeof loadedPath === 'string' && loadedPath.endsWith('SKILL.md'),
      'get() 给出了精确的 SKILL.md 路径（「点击打开本地文件」靠这条）', String(loadedPath))
  } catch (error) {
    check(false, '真技能注册表可用于验证 path 链路', String(error?.message ?? error))
  }

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
      check(body.includes('/skills-inspector'), 'bundle 里带着宿主那条私有通道的路径')
      check(body.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
      check(body.includes('canOpenWorkspacePath'),
        'bundle 里带着「本机能否打开」的能力探测（远程页面上按钮应当隐藏）')
    }

    // 通道活着，并且真的能从 ctx.skills 读出技能目录 —— 这是本插件的核心产出，
    // 而 dsh 只把技能目录发给模型，没有暴露成任何面向页面的 /api 方法。
    const live = await callChannel('snapshot', { sessionId: 'no-such-session' }, cookie)
    const value = live.body?.result?.value
    check(live.status === 200 && live.body?.result?.ok === true && Array.isArray(value?.entries),
      '/skills-inspector 通道已挂载，且对没有活 agent 的会话退回全局视图',
      JSON.stringify(live.body).slice(0, 200))
    check(typeof value?.complete === 'boolean',
      '快照带着「技能目录是否完整」（有 provider 失败时页面要如实说明）',
      String(value?.complete))
    // 条目形状不该多出未预期的字段，多出来说明 dsh 改了 SkillSummary，投影要跟着复核。
    const allowed = [
      'name', 'description', 'whenToUse', 'source', 'provider', 'directory',
      'modelInvocable', 'userInvocable', 'loaded',
    ]
    const extra = value?.entries?.flatMap(entry =>
      Object.keys(entry).filter(key => !allowed.includes(key))) ?? []
    check(extra.length === 0, '条目形状没有多出未预期的字段', extra.join('、'))

    // 真 dsh 上验一次 locate 的错误分支：不存在的技能名要走到「没有本地文件」，
    // 而不是抛错。（有技能可查的正常分支由下面的 verifySkillPath 直接对着真注册表验，
    // 因为技能来自**会话 scope**，而这个冒烟脚本刻意不创建会话。）
    const missing = await callChannel('locate', { sessionId: 'no-such-session', name: 'definitely-not-a-skill' }, cookie)
    check(missing.body?.result?.ok === true && missing.body.result.value?.path === undefined,
      'locate 对查不到的技能返回「没有路径」而不是抛错',
      JSON.stringify(missing.body).slice(0, 200))

    const malformed = await callChannel('snapshot', {}, cookie)
    check(
      malformed.body?.result?.ok === false
      && malformed.body.result.error?.code === 'skills-inspector/bad-payload',
      '缺少 sessionId 的调用被通道自己挡下',
      JSON.stringify(malformed.body),
    )

    const noName = await callChannel('locate', { sessionId: 'x' }, cookie)
    check(
      noName.body?.result?.ok === false
      && noName.body.result.error?.code === 'skills-inspector/bad-payload',
      '缺少技能名的 locate 被挡下',
      JSON.stringify(noName.body),
    )

    const unknown = await callChannel('reset', { sessionId: 'x' }, cookie)
    check(
      unknown.body?.result?.ok === false
      && unknown.body.result.error?.code === 'skills-inspector/unknown-endpoint',
      '通道上只有 snapshot / locate 两个端点（观察窗口没有写操作）',
      JSON.stringify(unknown.body),
    )

    const unauthenticated = await fetch(`${BASE}/skills-inspector/snapshot`, {
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
