/**
 * 冒烟：确认 terminal 两半装上、PTY 三件套挂进 web profile、通道可用。
 * 本插件挂载 dsh 的 PTY registry/backend/tool：registry 来自 `new TerminalSessionService(ctx)`，backend 走 `ctx.plugin()`，六个上游 tool 由 wrapper 捕获；解析/版本/`terminals` 冲突都会 fiber FAILED，故启动 token 是关键证明。
 * 六个 `terminal_*` 来自 dsh，本插件只组合 `interactive_terminal`，不重写 PTY；dsh 不提供工具表 API，所以导入宿主产物跑 `apply()`，检查 `ctx.tools.register` 收到的内容。
 * 升级 dsh 后运行：`node scripts/terminal-check.mjs [--port 3098]`。
 * 全过程不发模型请求、不写会话；会实际启动并立即关闭 pwsh/bash PTY。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import {
  createClientInspectionContext,
  createHostInspectionContext,
  inspectClientBundle as inspectClientArtifact,
  inspectHostBundle as inspectHostArtifact,
  inspectionNoop,
} from './lib/check-client-bundle.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-terminal'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'terminal-check-home')

/** dsh 上游六个原名；wrapper 必须确保它们不出现在模型工具表。 */
const UPSTREAM_TOOL_NAMES = [
  'terminal_open', 'terminal_send', 'terminal_read',
  'terminal_signal', 'terminal_close', 'terminal_list',
]
const TOOL_NAMES = [
  'interactive_terminal',
]

/** 本插件通道上的全部端点。 */
const ENDPOINTS = ['list', 'read', 'send', 'interrupt']

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
  channel: 'terminal',
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址：\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
/**
 * 检查 terminal 宿主构建产物的 PTY 挂载、组合工具和通道注册。
 *
 * 为什么必须做这一步：本插件自己一个执行逻辑都没写，六个上游 `terminal_*` 全部来自
 * `@deepseek-ai/dsh-tool-terminal`；registry 是本插件直接实例化的 Service，backend 由
 * `ctx.plugin()` 挂载，tool wrapper 直接调用上游 `apply()`。 「dsh 能启动」只证明没抛错，证明不了这些实现是否都正确挂上、工具表里最后有哪六个。
 * @returns {Promise<{ tools: object[], sections: object[], channels: string[], plugins: unknown[], provided: string[], disposers: number, module: object }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'terminal', 'dist', 'index.js')
  const tools = []
  const sections = []
  const channels = []
  const plugins = []
  const provided = []
  const mountFailures = []
  const disposers = []
  const inspection = await inspectHostArtifact({
    entry,
    applyArgs: (module) => [new module.Config({})],
    createContext: ({ cleanup }) => {
      const makeCtx = () => createHostInspectionContext({
        cleanup,
        channels,
        disposers,
        stubs: {
          tools: { register: (definition) => { tools.push(definition); return inspectionNoop } },
        },
        fields: {
          reflect: { provide: (name) => { provided.push(name) } },
          systemPrompt: { section: (definition) => { sections.push(definition); return inspectionNoop }, getSectionOrder: () => 0 },
          terminals: { registerBackend: () => inspectionNoop, listBackends: () => [], list: () => [] },
          jobs: undefined,
          inject: () => inspectionNoop,
          plugin: (plugin, config) => {
            plugins.push(plugin)
            // 这里只运行对象插件。Service CLASS（registry）带有
            // `Function.prototype.apply`，它不是 apply 钩子；调用它会抛出
            // "cannot be invoked without 'new'"，无法证明任何事情。
            const isObjectPlugin = typeof plugin?.apply === 'function'
              && plugin.apply !== Function.prototype.apply
            if (isObjectPlugin) {
              try {
                plugin.apply(makeCtx(), plugin.Config === undefined ? config : new plugin.Config(config ?? {}))
              } catch (error) {
                mountFailures.push(`${String(plugin.name ?? 'anonymous')}: ${error.message}`)
              }
            }
            return inspectionNoop
          },
        },
        get: (service) => service === 'terminals'
          ? { registerBackend: () => inspectionNoop, listBackends: () => [], list: () => [] }
          : undefined,
      })
      return makeCtx()
    },
  })
  return { tools, sections, channels, plugins, provided, disposers: disposers.length, mountFailures, module: inspection.module }
}
/**
 * 检查 terminal 浏览器构建产物的 dock 座位、命名空间和 external 图标依赖。
 *
 * @returns {{ seats: object[], namespaces: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'terminal', 'dist', 'client.js')
  return inspectClientArtifact({
    bundle,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', { useState: inspectionNoop, useEffect: inspectionNoop, useCallback: inspectionNoop, useMemo: inspectionNoop, useRef: () => ({}), createElement: inspectionNoop }],
      ['react/jsx-runtime', { jsx: inspectionNoop, jsxs: inspectionNoop, Fragment: inspectionNoop }],
      ['@deepseek-ai/dsh-client-ui-primitives', {
        IconApiOutline14: inspectionNoop,
        IconChevronUpOutline14: inspectionNoop, IconChevronDownOutline14: inspectionNoop,
      }],
    ]),
    unknownExternal: (id) => new Error('bundle 要求页面模块表之外的模块：' + id),
    buildContext: ({ exports, externals }) => {
      const seats = []
      const namespaces = []
      const ctx = createClientInspectionContext({
        seats,
        namespaces,
        fields: { get: () => undefined },
      })
      exports.apply(ctx)
      return { seats, namespaces, externals }
    },
  })
}
async function main() {
  prepareHome()

  const artifact = await inspectHostBundle()
  const registered = artifact.tools.map(tool => tool.name)
  const missing = TOOL_NAMES.filter(tool => !registered.includes(tool))
  const leaked = UPSTREAM_TOOL_NAMES.filter(tool => registered.includes(tool))
  const terminalTool = artifact.tools.find(tool => tool.name === 'interactive_terminal')
  const guidance = artifact.sections.find(section => section.name === 'tool:pty')?.text ?? ''
  check(missing.length === 0 && leaked.length === 0 && registered.length === TOOL_NAMES.length, '宿主产物只暴露一个 interactive_terminal 工具',
    missing.length === 0
      ? `实际：${registered.join('、')}`
      : `缺 ${missing.join('、')}${artifact.mountFailures.length === 0 ? '' : `；挂载失败：${artifact.mountFailures.join(' | ')}`}`)
  check(leaked.length === 0, '没有泄漏任何上游 terminal_* 别名', leaked.join('、'))
  check(terminalTool?.description?.includes('ordinary one-shot commands') === true
    && terminalTool.description.includes('pwsh') && terminalTool.description.includes('run_in_background'),
  'interactive_terminal 描述禁止普通一次性命令')
  check(guidance.includes('interactive_terminal') && guidance.includes('ordinary commands') && guidance.includes('persistent shell state') && guidance.includes('pwsh')
    && guidance.includes('run_in_background'), 'PTY 系统指引明确交互终端边界')

  check(artifact.plugins.length === 1 && artifact.provided.includes('terminals'),
    '挂载了 dsh 的 PTY registry / backend / tools（registry 是 Service，backend 是一个 ctx.plugin，tools 由 wrapper 直接捕获）',
    `plugins=${artifact.plugins.length}；services=${artifact.provided.join('、')}`)
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

  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（PTY 三件套挂载与组合工具注册都被接受）')
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
        check(bundleBody.includes('conversation.input.dock'), 'bundle 里带着输入框上方的槽注册')
        check(bundleBody.includes('/terminal'), 'bundle 里带着宿主那条私有通道的路径')
        check(bundleBody.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const list = await context.callChannel('list', { sessionId: 'no-such-session' }, cookie)
      check(
        list.status === 200 && list.body?.result?.ok === true
        && Array.isArray(list.body.result.value?.terminals)
        && list.body.result.value.terminals.length === 0
        && list.body.result.value.unavailable === 'no-agent',
        '/terminal 通道已挂载，且对没有活 agent 的会话如实报 no-agent',
        JSON.stringify(list.body),
      )

      const malformed = await context.callChannel('list', {}, cookie)
      check(
        malformed.body?.result?.ok === false
        && malformed.body.result.error?.code === 'terminal/bad-payload',
        '缺少 sessionId 的调用被通道自己挡下',
        JSON.stringify(malformed.body),
      )

      for (const forbidden of ['open', 'close']) {
        const attempt = await context.callChannel(forbidden, { sessionId: 'x', terminalId: 'pty-1' }, cookie)
        check(
          attempt.body?.result?.ok === false
          && attempt.body.result.error?.code === 'terminal/unknown-endpoint',
          `通道上没有 ${forbidden} 端点（开/关终端只能走模型工具）`,
          JSON.stringify(attempt.body),
        )
      }
      check(ENDPOINTS.length === 4, '通道只有四个端点', ENDPOINTS.join('、'))

      const unauthenticated = await fetch(`${context.base}/terminal/list`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'list', payload: { sessionId: 'x' } }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
