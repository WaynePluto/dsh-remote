/**
 * 冒烟：确认 dsh 真的把 exec-process 插件下发到了页面，而且那份 bundle 真的会注册两个座位。
 *
 * 这个插件和兄弟插件不同：它**没有宿主行为**，全部逻辑都在浏览器半。所以「dsh 启动成功」
 * 在这里只能证明 overlay 装上了，证明不了插件是对的 —— 真正会出事的地方在页面里：
 *
 *   · `conversation.chat.node` 是 keyed 槽，本插件要影子覆盖 dsh 自己的 `turn-process`
 *     条目。**同一 priority 的第二次注册是抛错，不是覆盖**
 *     （dsh `packages/client/ui-slots/src/index.ts:836-842`），而这一抛发生在浏览器插件
 *     激活期间，会把 dsh 的整个 web UI 带走。
 *   · 会话节点定义注册（`uiConversation.events.register`）重名同样是抛错。
 *
 * 所以本脚本比别的冒烟多做一件事：把**构建产物** `dist/client.js` 放进一个带 shim 的 vm 里
 * 真跑一遍 `apply()`，检查它到底注册了什么。单元测试跑的是源码，这一步跑的是要发出去的字节。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/exec-process-check.mjs [--port 3097]
 *
 * 全过程不发起任何模型请求，也不写任何会话。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createContext, runInContext } from 'node:vm'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-exec-process'
const CLIENT_BUNDLE = join(ROOT, 'packages', 'plugins', 'exec-process', 'dist', 'client.js')
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'exec-process-check-home')

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
 * 在 vm 里加载构建产物，跑一遍 apply()，返回它注册了什么。
 *
 * shim 只提供两样东西：加载器（dsh 页面上的 `window.__ModuleLoader__`）和模块表里那两个
 * 允许留成 import 的说明符。插件如果偷偷依赖了别的全局或别的模块，这里就会当场炸开 ——
 * 那正是页面上会发生的事，只是这里炸得早、也看得见。
 * @returns {{ definitions: string[], seats: {key?: string, priority?: number, locale?: string}[], namespaces: string[], disposers: number }}
 */
function inspectBundle() {
  const source = readFileSync(CLIENT_BUNDLE, 'utf8')
  /** @type {{ id: string, factory: (require: (id: string) => unknown) => Record<string, unknown> } | null} */
  let loaded = null
  const noop = () => {}
  const reactShim = {
    useEffect: noop,
    useCallback: noop,
    useMemo: noop,
    useSyncExternalStore: noop,
    createElement: noop,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry) => { loaded = entry } } },
    console,
  }
  runInContext(source, createContext(sandbox), { filename: CLIENT_BUNDLE })
  if (loaded === null) throw new Error('bundle 没有调用 window.__ModuleLoader__.load')
  if (loaded.id !== PACKAGE_ID) throw new Error(`bundle 自称 ${loaded.id}，应当是 ${PACKAGE_ID}`)
  const exports = loaded.factory((id) => {
    if (id === 'react') return reactShim
    if (id === 'react/jsx-runtime') return { jsx: noop, jsxs: noop, Fragment: noop }
    throw new Error(`bundle 要求页面模块表之外的模块：${id}`)
  })

  const definitions = []
  const seats = []
  const namespaces = []
  let disposers = 0
  const ctx = {
    effect: (run) => {
      const dispose = run()
      if (typeof dispose === 'function') disposers += 1
      return noop
    },
    locale: { register: (ns) => { namespaces.push(ns); return noop } },
    uiConversation: { events: { register: (definition) => { definitions.push(definition.kind); return noop } } },
    slots: {
      inject: (_name, run) => { run() },
      register: (options) => { seats.push(options); return noop },
    },
  }
  exports.apply(ctx)
  return { definitions, seats, namespaces, disposers }
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

async function main() {
  // 先验产物本身：不需要 dsh 就能回答「这份 bundle 会注册什么」。
  const bundleReport = inspectBundle()
  check(
    bundleReport.definitions.includes('exec-process'),
    '产物里的 apply() 注册了 exec-process 会话节点定义',
    JSON.stringify(bundleReport.definitions),
  )
  const row = bundleReport.seats.find(seat => seat.key === 'exec-process')
  check(
    row?.name === 'conversation.chat.node' && row?.locale === 'dsh-plugin-exec-process',
    '产物把「执行过程」行注册进了 conversation.chat.node',
    JSON.stringify(row),
  )
  const shadow = bundleReport.seats.find(seat => seat.key === 'turn-process')
  check(
    typeof shadow?.priority === 'number' && shadow.priority !== 0,
    'dsh 自己的 turn-process 是用非默认 priority 影子覆盖的（同 priority 会抛错并带走整个 web UI）',
    JSON.stringify(shadow),
  )
  check(bundleReport.disposers >= 4, '产物里每个副作用都挂在 ctx.effect 上', `${bundleReport.disposers} 个可撤销副作用`)

  prepareHome()
  const { child, token } = await startDsh()
  try {
    check(true, 'dsh 带全部 --patch 正常启动')

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
      check(body.includes('conversation.chat.node'), 'bundle 里带着会话消息流的槽注册')
      check(body.includes('data-chat-flow-key'), 'bundle 里带着折叠所依赖的 dsh 行标识属性')
      // 吸顶整条规则是运行时按行生成的：常量没进产物，等于表头永远吸不住，也永远收不掉。
      check(body.includes('--dshx-exec-process-push-'), 'bundle 里带着吸顶推出所依赖的自定义属性前缀')
      check(body.includes('position: sticky'), 'bundle 里带着吸顶规则本身')
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
