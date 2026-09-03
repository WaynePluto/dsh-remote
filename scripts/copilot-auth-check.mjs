/**
 * 冒烟：确认 dsh 真的把 copilot-auth 插件的两半都装上了。
 *
 * 这个脚本存在的理由是 D17 那类问题只会在真机上暴露：宿主半靠 `--patch` 叠加层加载，
 * 浏览器半靠 dsh 的客户端模块扫描（它顺着 overlay 的文件路径往上找 package.json，
 * 读 `dsh.client` 与 exports["./client"]）。两条链路里任何一环变了，dsh 都只会以
 * 「fiber FAILED」或「页面少一块」的形式表现出来，单元测试看不见。
 *
 * 升级 dsh 后跑一次（skill `update-dependencies` 的清单里有这一条）：
 *
 *   node scripts/copilot-auth-check.mjs [--port 3099]
 *
 * 它会用一个独立的 DSH_HOME 启动一个临时 dsh，检查：
 *   1. dsh 正常启动并打印带 token 的地址（说明没有 FAILED fiber）；
 *   2. 首页的 __DSH_BOOT__ 里有本插件的行，且 combo bundle 能取到、内容是
 *      `__ModuleLoader__.load` 工件；
 *   3. `/copilot-auth/status` 通道在带 cookie 时返回未登录状态，不带 cookie 时 401。
 * 全过程不发起任何 GitHub 请求，也不写任何凭据。
 */

import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { DEV_DIRECTORY, DSH_BIN, DSH_PROFILE, ROOT, dshPluginOverlays } from './local-config.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-copilot-auth'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const AUTHORITY = `127.0.0.1:${PORT}`
const BASE = `http://${AUTHORITY}`
/** 独立的 home：不碰用户正在用的 ~/.dsh，也不和正在跑的 dsh 抢会话文件。 */
const HOME = join(DEV_DIRECTORY, 'copilot-auth-check-home')

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

async function main() {
  prepareHome()
  const { child, token } = await startDsh()
  try {
    check(true, 'dsh 带两个 --patch 正常启动')

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
      check(body.includes('settings.models.provider-card'), 'bundle 里带着模型页的扩展槽注册')
    }

    const status = await fetch(`${BASE}/copilot-auth/status`, {
      method: 'POST',
      headers: { ...browserHeaders(cookie), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'status', payload: {} }),
    })
    const answer = await status.json()
    check(status.ok && answer?.result?.ok === true, '/copilot-auth/status 应答成功', JSON.stringify(answer))
    check(answer?.result?.value?.signedIn === false, '未登录状态如实上报')

    const unauthenticated = await fetch(`${BASE}/copilot-auth/status`, {
      method: 'POST',
      headers: { host: AUTHORITY, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'status', payload: {} }),
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
