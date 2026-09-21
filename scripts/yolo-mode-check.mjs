/**
 * 固定 YOLO 模式升级/冒烟检查。
 * 先在进程内检查 Host 产物与 Bundle patch 层，再用壳级 overlay 加载隔离真实 dsh 和临时探针；
 * yolo-mode 经 profile 的 bundles 数组以 Bundle 装载（不再走 --patch overlay），探针不发模型请求，
 * 检查实时 Agent 工具 schema，用无害 shell 调用验证冗余提权字段，并在完整配对 test turn 发起一次明确 approval。
 * 升级 dsh 或修改此插件后运行：`node scripts/yolo-mode-check.mjs [--port 3101]`。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEFAULT_PROFILE_BUNDLES, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { cleanupCheckHome, withCheckHome } from './lib/check-home.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import { inspectHostBundle as inspectHostArtifact } from './lib/check-client-bundle.mjs'

const PACKAGE_DIRECTORY = join(ROOT, 'packages', 'plugins', 'yolo-mode')
const HOST_BUNDLE = join(PACKAGE_DIRECTORY, 'dist', 'index.js')
const BUNDLE_PATCH = join(PACKAGE_DIRECTORY, 'cordis.patch.yml')
const YOLO_BUNDLE = '@dsh-remote/dsh-plugin-yolo-mode'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3101 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'yolo-mode-check-home')
const PROBE_DIRECTORY = join(DEV_DIRECTORY, 'yolo-mode-check-probe')
const PROBE_OVERLAY = join(PROBE_DIRECTORY, 'dsh-overlay.yml')
const PROBE_MODULE = join(PROBE_DIRECTORY, 'probe.mjs')

let failures = 0

function noop() {}

function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

function prepareProbe() {
  mkdirSync(PROBE_DIRECTORY, { recursive: true })
  writeFileSync(PROBE_OVERLAY, [
    '- insert:',
    '    - id: yolo-mode-smoke-probe',
    "      name: './probe.mjs'",
    '',
  ].join('\n'))
  writeFileSync(PROBE_MODULE, `
let lastAgent

export const name = 'dsh-remote-yolo-mode-smoke-probe'
export const inject = ['agents', 'tools', 'sandboxPolicy', 'approval', 'connection']

function nextTurn(agent) {
  let latest = 0
  for (const event of agent.session.snapshotEvents()) {
    if (event.type === 'turn/start' && typeof event.data.turn === 'number') latest = Math.max(latest, event.data.turn)
  }
  return latest + 1
}

export function apply(ctx) {
  ctx.on('agent/created', ({ agent }) => { lastAgent = agent })
  ctx.on('agent/disposed', ({ agent }) => { if (lastAgent === agent) lastAgent = undefined })
  const dispose = ctx.connection.rpc.handle('/yolo-mode-probe', async (endpoint) => {
    if (endpoint !== 'inspect') {
      return { ok: false, error: { code: 'probe/unknown-endpoint', message: 'unknown endpoint', details: {} } }
    }
    const agent = lastAgent ?? ctx.agents.list()[0]
    if (agent === undefined) {
      return { ok: false, error: { code: 'probe/no-agent', message: 'session.create did not publish an Agent', details: {} } }
    }
    const schemas = agent.ctx.tools.schemas(agent)
    const names = ['bash', 'pwsh', 'write', 'edit']
    const targets = schemas.filter((schema) => names.includes(schema.name))
    const turn = nextTurn(agent)
    agent.session.append('turn/start', { turn })
    let approval
    let tool
    try {
      approval = await ctx.approval.request({ agent, toolName: 'yolo-mode-smoke', reason: 'fixed YOLO smoke approval' })
      const shell = process.platform === 'win32' ? 'pwsh' : 'bash'
      const argumentsForShell = process.platform === 'win32'
        ? { command: 'Write-Output yolo-mode-smoke', description: 'Run the YOLO smoke command', sandbox_permissions: 'workspace-write', justification: 'stale model fields' }
        : { command: 'printf yolo-mode-smoke', description: 'Run the YOLO smoke command', sandbox_permissions: 'workspace-write', justification: 'stale model fields' }
      tool = await ctx.tools.execute({
        callId: 'yolo-mode-smoke',
        name: shell,
        arguments: argumentsForShell,
        agent,
        signal: new AbortController().signal,
      })
    } finally {
      agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
    }
    const policy = agent.session.snapshotEvents().filter((event) => event.type === 'sandbox/mode' || event.type === 'approval/policy')
    return {
      ok: true,
      value: {
        schemas: targets,
        policy: policy.map((event) => ({ type: event.type, data: event.data })),
        approval,
        toolError: tool?.isError ?? true,
      },
    }
  })
  ctx.effect(() => () => { void dispose() }, 'yolo-mode smoke probe')
}
`)
}

function prepareHome() {
  cleanupCheckHome(HOME)
  const profile = join(HOME, 'profiles', DSH_PROFILE)
  mkdirSync(profile, { recursive: true })
  // 与 launcher/profile.ts 的默认模板同一份 Bundle 清单（local-config 复制，
  // launcher 为权威）：yolo-mode 以 Bundle 层装载，验证的正是发行装载路径，
  // 而不是 --patch overlay。yolo-mode 排在受管清单末位。
  writeFileSync(join(profile, 'package.json'), `${JSON.stringify({
    name: `dsh-profile-${DSH_PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: DEFAULT_PROFILE_BUNDLES } },
  }, null, 2)}\n`)
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
}

async function checkHostArtifact() {
  check(existsSync(HOST_BUNDLE), 'Host bundle dist/index.js 存在', HOST_BUNDLE)
  check(existsSync(BUNDLE_PATCH), 'cordis.patch.yml 存在', BUNDLE_PATCH)
  check(!existsSync(join(PACKAGE_DIRECTORY, 'dist', 'client.js')), 'Host-only 插件没有生成 dist/client.js')
  const manifest = JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8'))
  check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'package.json 声明 dsh.bundle.patch 指向 cordis.patch.yml')
  const overlay = readFileSync(BUNDLE_PATCH, 'utf8')
  check(overlay.includes('mode: danger-full-access'), 'Bundle patch 固定 danger-full-access')
  check(overlay.includes('policy: ask'), 'Bundle patch 固定 approval policy ask')
  check(overlay.includes('- id: permission') && overlay.includes('disabled: true'), 'Bundle patch 禁用 permission Host service')
  check(overlay.includes('- id: ui-permission') && overlay.includes('disabled: true'), 'Bundle patch 禁用 permission client UI')
  check(overlay.indexOf("name: './dist/index.js'") !== -1, 'Bundle patch 使用相对 Host bundle 路径')
  if (!existsSync(HOST_BUNDLE)) return

  const listeners = new Map()
  let cleanup = noop
  const inspection = await inspectHostArtifact({
    entry: HOST_BUNDLE,
    autoCleanup: false,
    createContext: ({ cleanup: registerCleanup }) => {
      const context = {
        agents: { list: () => [] },
        on: (event, listener, options) => {
          listeners.set(event, { listener, options })
          return () => listeners.delete(event)
        },
        effect: (factory) => {
          cleanup = factory()
          registerCleanup(cleanup)
          return cleanup
        },
        logger: { warn: () => {} },
      }
      return context
    },
  })
  const module = inspection.module
  check(Array.isArray(module.inject) && module.inject.includes('sandboxPolicy') && module.inject.includes('approval'), 'Host apply 声明策略与批准服务')
  const answerer = listeners.get('approval/request')
  check(answerer?.options?.prepend === true, 'approval answerer 使用 prepend:true')
  check(await answerer?.listener({}) === 'allowed-once', 'Host answerer 自动返回 allowed-once')
  const controller = new AbortController()
  controller.abort()
  check(await answerer?.listener({ signal: controller.signal }) === 'cancelled', '已取消 approval 返回 cancelled')
  check(!listeners.has('user-questions/request'), '没有认领 user-questions/request')
  await inspection.cleanup()
}

async function checkLiveDsh() {
  await withCheckHome({ home: HOME, prepare: prepareHome }, async () => {
    prepareProbe()
    const context = createCheckContext({
      dshBin: DSH_BIN,
      profile: DSH_PROFILE,
      overlays: () => [...dshPluginOverlays(), PROBE_OVERLAY],
      home: HOME,
      cwd: ROOT,
      port: PORT,
      trustedHost: `127.0.0.1:${PORT}`,
      tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
      timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址：\n' + output,
      exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
      rpcId: 'yolo-mode-smoke',
      cleanup: false,
    })
    await runLiveDshCheck(context, {
      startedAssertions: () => {
        check(true, `真实 dsh 以 Bundle 装载（含 ${YOLO_BUNDLE}）与壳级 overlay + 临时 probe 正常启动`)
      },
      exchangeAssertions: ({ exchange, cookie }) => {
        check(cookie !== '', 'dsh token 换到了浏览器 cookie', `status ${exchange.status}`)
      },
      bundleAssertions: ({ index }) => {
        check(!index.includes('@deepseek-ai/dsh-client-ui-permission-presets'), '首页不再下发原生权限选择器 client bundle')
      },
      liveAssertions: async ({ cookie }) => {
        const call = context.rpcRequest
        const created = await call({ path: '/api/session/create', method: 'session/create', payload: { args: { request: { cwd: ROOT } } }, cookie })
        const sessionId = created.body?.result?.value?.sessionId
        check(created.status === 200 && typeof sessionId === 'string', '真实 dsh 创建了测试 Agent session', JSON.stringify(created.body).slice(0, 240))
        if (typeof sessionId !== 'string') return

        const inspected = await call({ path: '/yolo-mode-probe/inspect', method: 'inspect', payload: {}, cookie })
        const value = inspected.body?.result?.value
        check(inspected.status === 200 && inspected.body?.result?.ok === true, 'probe RPC 通过 dsh 认证与 Host/Origin fence')
        const targetSchemas = Array.isArray(value?.schemas) ? value.schemas : []
        check(targetSchemas.length >= 1, 'probe 观察到了至少一个目标工具 schema', JSON.stringify(targetSchemas.map((schema) => schema.name)))
        check(
          targetSchemas.every((schema) => {
            const properties = schema.parameters?.properties ?? {}
            return properties.sandbox_permissions === undefined && properties.justification === undefined
          }),
          '四个目标工具 schema 均隐藏两个提权字段',
        )
        check(value?.approval === 'allowed-once', '显式 approval/request 自动得到 allowed-once')
        check(
          value?.policy?.at(-2)?.data?.mode === 'danger-full-access'
          && value?.policy?.at(-1)?.data?.policy === 'ask',
          'Agent 历史中的最后策略是 full-access + ask',
          JSON.stringify(value?.policy),
        )
        check(value?.toolError === false, '带冗余提权字段的真实 shell 工具调用成功')
      },
    })
  })
}

async function main() {
  try {
    await checkHostArtifact()
    await checkLiveDsh()
  } catch (error) {
    failures += 1
    console.error(`[fail] yolo-mode smoke aborted: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  } finally {
    cleanupCheckHome(PROBE_DIRECTORY)
    cleanupCheckHome(HOME)
  }
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
