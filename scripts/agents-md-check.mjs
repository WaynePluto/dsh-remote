/**
 * 冒烟：确认 agents-md 插件的两半都装上了，而且**它编辑的那个文件，正是 dsh 自己
 * 读进上下文的那个文件**。
 *
 * 这个脚本比兄弟插件多做一件事，而且那件事是本插件存在的全部意义：
 *
 *   ⚠️ **本插件的正确性完全依赖一条 dsh 内部的约定** —— 用户级全局提示词位于
 *   `<dshHome>/AGENTS.md`（`packages/context/agent-instructions/src/files.ts:280`
 *   把 `config.dshHome` 与 `USER_GLOBAL_FILE` join 起来，后者定义在同包的
 *   `render.ts:98`，**不在该包的公开入口上**）。这个名字或位置一旦变化，本插件
 *   会安静地编辑一个没有任何人读的文件 —— 页面照常显示「已保存」，模型却永远
 *   收不到。单元测试锁不住这条，因为它锁的是我们自己抄下来的那份常量。
 *
 *   所以这里**反过来验**：通过通道写一段带唯一标记的文字，再问 dsh 自己的
 *   `discoverBaselineInstructionFiles()` 会不会把它算进基线，并核对内容。
 *   这是唯一能证明「写对了地方」的办法。
 *
 * 升级 dsh 后跑一次：
 *
 *   node scripts/agents-md-check.mjs [--port 3097]
 *
 * 全过程不发起任何模型请求，也不写任何会话，且**只碰临时 home**，
 * 不会动你自己的 ~/.dsh/AGENTS.md。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-agents-md'
const NAMESPACE = 'dsh-plugin-agents-md'
const CHANNEL = 'agents-md'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，尤其不碰他真正的 AGENTS.md。 */
const HOME = join(DEV_DIRECTORY, 'agents-md-check-home')
/** 写进文件的唯一标记，用来在 dsh 的基线里找回它。 */
const MARKER = `dsh-remote-agents-md-smoke-${randomUUID()}`

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
 * ⚠️ 端点在 **URL 路径**里，不只是信封里：dsh 用 `endpointFromPath` 从
 * `${channel}/${endpoint}` 解析（`packages/client/connection/src/rpc-host.ts:259-267`），
 * 只打到 `/agents-md` 会直接 404；信封里的 `method` 还必须和路径段一致。
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

/**
 * 问 dsh 自己：它会把哪些文件当作这次会话的基线提示词？
 *
 * 这里刻意**用 dsh 自己的包**（不是我们抄的那份路径），所以它回答的是 dsh 的
 * 真实行为，而不是我们的假设。
 * @returns {Promise<{ ok: boolean, files: {displayPath: string, absolutePath: string}[], reason?: string }>} 发现结果。
 */
async function dshBaselineFiles() {
  try {
    const require = createRequire(join(ROOT, 'packages/launcher/package.json'))
    const specifier = require.resolve('@deepseek-ai/dsh-agent-instructions')
    const module = await import(new URL(`file://${specifier.replaceAll('\\', '/')}`).href)
    const discover = module.discoverBaselineInstructionFiles
    if (typeof discover !== 'function') {
      return { ok: false, files: [], reason: 'dsh 不再导出 discoverBaselineInstructionFiles' }
    }
    // cwd 指向一个空目录，这样发现到的就只剩「用户级全局」那一个来源。
    const empty = join(HOME, 'empty-workspace')
    mkdirSync(empty, { recursive: true })
    const files = await discover({ cwd: empty, dshHome: HOME })
    return { ok: true, files }
  } catch (error) {
    return { ok: false, files: [], reason: String(error?.message ?? error) }
  }
}

async function main() {
  prepareHome()
  const { child, token } = await startDsh()
  try {
    // 通道注册签名对不上会让 fiber FAILED，dsh 就走不到打印地址这一步。
    check(true, 'dsh 带全部 --patch 正常启动（本插件的通道注册被接受）')

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
      check(body.includes('settings.section'), 'bundle 里带着设置页的槽注册')
      check(body.includes(NAMESPACE), 'bundle 用的是本插件的文案命名空间')
      // 两半必须对同一个通道说话，否则保存按钮会安静地 404。
      check(body.includes(`/${CHANNEL}`), 'bundle 里带着编辑通道的路径')
    }

    // 全新的 home 里还没有这个文件；这一格证明「不存在」被如实报告，而不是报错。
    const before = await callChannel('load', {}, cookie)
    check(
      before.status === 200 && before.body?.result?.ok === true && before.body.result.value?.exists === false,
      '全新 home 里读到的是「文件还不存在」而不是一次失败',
      JSON.stringify(before.body).slice(0, 200),
    )

    const text = `# 冒烟\n\n${MARKER}\n`
    const saved = await callChannel('save', { content: text }, cookie)
    check(
      saved.status === 200 && saved.body?.result?.ok === true && saved.body.result.value?.document?.exists === true,
      '保存成功并报告文件已存在',
      JSON.stringify(saved.body).slice(0, 200),
    )

    const after = await callChannel('load', {}, cookie)
    check(
      after.body?.result?.value?.content === text,
      '再读回来的内容和写进去的完全一致',
      JSON.stringify(after.body?.result?.value?.content ?? '').slice(0, 120),
    )

    // ⚠️⚠️ 本脚本的核心：写到磁盘上的位置，是不是 dsh 真正会读的位置。
    const onDisk = join(HOME, 'AGENTS.md')
    check(existsSync(onDisk), '文件落在 <DSH_HOME>/AGENTS.md', onDisk)
    if (existsSync(onDisk)) {
      check(readFileSync(onDisk, 'utf8') === text, '磁盘上的字节和页面提交的一致')
    }

    const baseline = await dshBaselineFiles()
    if (!baseline.ok) {
      check(false, 'dsh 自己的基线发现能被调用（这一条挂了说明 dsh 的接口变了）', baseline.reason)
    } else {
      const hit = baseline.files.find(file => file.absolutePath === onDisk)
      check(
        hit !== undefined,
        '⚠️ dsh 自己的 discoverBaselineInstructionFiles() 把这个文件算进了基线',
        `dsh 认领的是：${JSON.stringify(baseline.files.map(file => file.displayPath))}`,
      )
      if (hit !== undefined) {
        console.log(`[note] dsh 在上下文里把它显示为 ${hit.displayPath}`)
      }
    }

    const unknownEndpoint = await callChannel('nope', {}, cookie)
    check(
      unknownEndpoint.body?.result?.ok === false
      && unknownEndpoint.body.result.error?.code === 'agents-md/unknown-endpoint',
      '未知端点被通道自己挡下',
      JSON.stringify(unknownEndpoint.body).slice(0, 200),
    )

    const badRequest = await callChannel('save', { content: 42 }, cookie)
    check(
      badRequest.body?.result?.ok === false
      && badRequest.body.result.error?.code === 'agents-md/bad-request',
      '非字符串载荷在碰到文件系统之前就被拒',
      JSON.stringify(badRequest.body).slice(0, 200),
    )

    const unauthenticated = await fetch(`${BASE}/${CHANNEL}/load`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'load', payload: {} }),
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
