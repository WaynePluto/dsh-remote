/**
 * 冒烟：确认 agents-md 插件的两半都装上，且编辑的文件正是 dsh 读进上下文的文件。
 * 核心契约：用户级全局提示词在 `<dshHome>/AGENTS.md`；`packages/context/agent-instructions/src/files.ts:280` 把 `config.dshHome` 与 `USER_GLOBAL_FILE` join，后者见同包 `render.ts:98`，不在公开入口。
 * 约定变化会让页面显示「已保存」却编辑无人读取的文件，模型收不到内容；单测只锁我们抄下来的常量，不能证明位置正确。
 * 因此通过通道写入带唯一标记的文字，再让 dsh 的 `discoverBaselineInstructionFiles()` 发现并核对，这是证明写对位置的唯一办法。
 * 升级 dsh 后运行：`node scripts/agents-md-check.mjs [--port 3097]`。
 * 全过程不发模型请求、不写会话，只碰临时 home，不会动 `~/.dsh/AGENTS.md`。
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'


const PACKAGE_ID = '@dsh-station/dsh-plugin-agents-md'
const NAMESPACE = 'dsh-plugin-agents-md'
const CHANNEL = 'agents-md'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
/** 独立的 home：不碰用户正在用的 ~/.dsh，尤其不碰他真正的 AGENTS.md。 */
const HOME = join(DEV_DIRECTORY, 'agents-md-check-home')
/** 写进文件的唯一标记，用来在 dsh 的基线里找回它。 */
const MARKER = `dsh-station-agents-md-smoke-${randomUUID()}`

let failures = 0


function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

const context = createCheckContext({
  dshBin: DSH_BIN,
  profile: DSH_PROFILE,
  overlays: dshPluginOverlays,
  home: HOME,
  cwd: ROOT,
  port: PORT,
  trustedHost: `127.0.0.1:${PORT}`,
  packageId: PACKAGE_ID,
  channel: CHANNEL,
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
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
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（本插件的通道注册被接受）')
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)
    },
    bundleAssertions: ({ index, url, bundle, bundleBody }) => {
      const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
      check(idAt !== -1, '首页的 __DSH_BOOT__ 里有本插件的行')

      if (url !== null) {
        check(bundle.ok, '插件 bundle 能取到', `status ${bundle.status}`)
        check(bundleBody.includes('__ModuleLoader__.load'), 'bundle 是加载器认识的工件格式')
        check(bundleBody.includes('settings.section'), 'bundle 里带着设置页的槽注册')
        check(bundleBody.includes(NAMESPACE), 'bundle 用的是本插件的文案命名空间')
        check(bundleBody.includes(`/${CHANNEL}`), 'bundle 里带着编辑通道的路径')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const before = await context.callChannel('load', {}, cookie)
      check(
        before.status === 200 && before.body?.result?.ok === true && before.body.result.value?.exists === false,
        '全新 home 里读到的是「文件还不存在」而不是一次失败',
        JSON.stringify(before.body).slice(0, 200),
      )

      const text = `# 冒烟\n\n${MARKER}\n`
      const saved = await context.callChannel('save', { content: text }, cookie)
      check(
        saved.status === 200 && saved.body?.result?.ok === true && saved.body.result.value?.document?.exists === true,
        '保存成功并报告文件已存在',
        JSON.stringify(saved.body).slice(0, 200),
      )

      const after = await context.callChannel('load', {}, cookie)
      check(
        after.body?.result?.value?.content === text,
        '再读回来的内容和写进去的完全一致',
        JSON.stringify(after.body?.result?.value?.content ?? '').slice(0, 120),
      )

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

      const unknownEndpoint = await context.callChannel('nope', {}, cookie)
      check(
        unknownEndpoint.body?.result?.ok === false
        && unknownEndpoint.body.result.error?.code === 'agents-md/unknown-endpoint',
        '未知端点被通道自己挡下',
        JSON.stringify(unknownEndpoint.body).slice(0, 200),
      )

      const badRequest = await context.callChannel('save', { content: 42 }, cookie)
      check(
        badRequest.body?.result?.ok === false
        && badRequest.body.result.error?.code === 'agents-md/bad-request',
        '非字符串载荷在碰到文件系统之前就被拒',
        JSON.stringify(badRequest.body).slice(0, 200),
      )

      const unauthenticated = await fetch(`${context.base}/${CHANNEL}/load`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'load', payload: {} }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
