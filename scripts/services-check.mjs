/**
 * 冒烟：确认 services 插件两半装上、工具注册、通道可用。
 * 真机契约：五个工具重名时 `tools.register` 直接 throw，`defineTool` 还会在注册时转换/校验 schema；任一失败即启动失败，因此 dsh 打印 token 是关键证明。
 * 升级 dsh 后运行：`node scripts/services-check.mjs [--port 3099]`。
 * 全过程不发模型请求、不写会话、不启动常驻服务。
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


const PACKAGE_ID = '@dsh-remote/dsh-plugin-services'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'services-check-home')

/** 本插件注册的全部工具名，必须和 src/index.ts 保持一致。 */
const TOOL_NAMES = ['service_start', 'service_list', 'service_logs', 'service_stop', 'service_restart']

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
  channel: 'services',
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址：\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
/**
 * 检查 services 宿主构建产物（而非只跑源码）的工具、schema、通道和 disposer 注册。
 * dsh 不通过 `/api` 暴露工具表（`packages/api/**` 中没有 `tools.describe`），
 * 所以外部无法观察模型可见的五个工具；这正是本插件的核心产出。
 * 必须经过真实 `defineTool`（含 schema 转换/校验）和 `ctx.tools.register`；
 * dsh 能启动只证明注册未抛错，不能证明注册的正是这五个工具。
 * @returns {Promise<{ tools: {name: string, parameters: object, description: string}[], channels: string[], disposers: number }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'services', 'dist', 'index.js')
  const tools = []
  const channels = []
  const disposers = []
  await inspectHostArtifact({
    entry,
    applyArgs: [{ approvalInConfinedSandbox: true }],
    createContext: ({ cleanup }) => createHostInspectionContext({
      cleanup,
      channels,
      disposers,
      stubs: {
        tools: { register: (definition) => { tools.push(definition); return inspectionNoop } },
      },
    }),
  })
  return { tools, channels, disposers: disposers.length }
}
/**
 * 检查 services 浏览器构建产物的座位、命名空间和 external primitives 依赖。
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
  return inspectClientArtifact({
    bundle,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', { useState: inspectionNoop, useEffect: inspectionNoop, useCallback: inspectionNoop, useMemo: inspectionNoop, useRef: () => ({}), createElement: inspectionNoop }],
      ['react/jsx-runtime', { jsx: inspectionNoop, jsxs: inspectionNoop, Fragment: inspectionNoop }],
      ['@deepseek-ai/dsh-client-ui-primitives', {
        Modal: inspectionNoop, IconApiOutline14: inspectionNoop,
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
      return { seats, namespaces, externals: [...new Set(externals)] }
    },
  })
}
async function main() {
  prepareHome()

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
  const PLATFORM_MODULES = new Set([
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ])
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.has(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)
  check(client.externals.includes('@deepseek-ai/dsh-client-ui-primitives'),
    'Modal 与图标是向页面借的，没有被打进 bundle 变成第二份')

  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（五个工具注册与通道挂载都被接受）')
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
        check(bundleBody.includes('/services'), 'bundle 里带着宿主那条私有通道的路径')
        check(bundleBody.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const list = await context.callChannel('list', { sessionId: 'no-such-session' }, cookie)
      check(
        list.status === 200 && list.body?.result?.ok === true && list.body.result.value?.cwd === null,
        '/services 通道已挂载，且对没有活 agent 的会话返回空快照',
        JSON.stringify(list.body),
      )

      const malformed = await context.callChannel('list', {}, cookie)
      check(
        malformed.body?.result?.ok === false
        && malformed.body.result.error?.code === 'services/bad-payload',
        '缺少 sessionId 的调用被通道自己挡下',
        JSON.stringify(malformed.body),
      )

      const start = await context.callChannel('start', { sessionId: 'x', name: 'y' }, cookie)
      check(
        start.body?.result?.ok === false
        && start.body.result.error?.code === 'services/unknown-endpoint',
        '通道上没有 start 端点（创建服务只能走带批准门的工具）',
        JSON.stringify(start.body),
      )

      const unauthenticated = await fetch(`${context.base}/services/list`, {
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
