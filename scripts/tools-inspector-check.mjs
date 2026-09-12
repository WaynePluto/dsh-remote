/**
 * 冒烟：确认 tools-inspector 两半装上，「工具」tab 进入会话头部视图栏，通道能输出真实工具表。
 * 真机契约：`conversation.view` 是 list 槽（已有 chat(0)/trajectory(10)，写错或变 keyed 会启动抛错）；`ctx.tools.schemas(scope)` 签名必须匹配，且 dsh `packages/core/tools/src/index.ts:1247` 的 `schemaOf` 只返回 name/description/parameters，多出字段需复核。
 * ⚠️ 只读观察窗口：不注册工具、不 restrict、不 guard；有副作用就不再是观察工具。
 * 升级 dsh 后运行：`node scripts/tools-inspector-check.mjs [--port 3099]`。
 * 全过程不发模型请求、不写会话。
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

const PACKAGE_ID = '@dsh-remote/dsh-plugin-tools-inspector'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'tools-inspector-check-home')

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
  trustedHost: '127.0.0.1',
  packageId: PACKAGE_ID,
  channel: 'tools-inspector',
  tokenPattern: /token=([\w-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有就绪。输出：\n' + output,
  exitMessage: (code, output) => 'dsh 退出，code ' + code + '。输出：\n' + output,
})
const { prepareHome } = context
/**
 * 检查 tools-inspector 宿主构建产物的通道与只读注册约束。
 *
 * 重点断言「什么都没注册」—— 这是本插件与兄弟插件相反的地方。
 * @returns {Promise<{ channels: string[], events: string[], tools: number, restricts: number, guards: number, disposers: number }>}
 */
async function inspectHostBundle() {
  const entry = join(ROOT, 'packages', 'plugins', 'tools-inspector', 'dist', 'index.js')
  const channels = []
  const events = []
  const disposers = []
  let tools = 0
  let restricts = 0
  let guards = 0
  const inspection = await inspectHostArtifact({
    entry,
    createContext: ({ cleanup }) => createHostInspectionContext({
      cleanup,
      channels,
      events,
      disposers,
      stubs: {
        tools: {
          register: () => { tools += 1; return inspectionNoop },
          restrict: () => { restricts += 1; return inspectionNoop },
          guard: () => { guards += 1; return inspectionNoop },
          schemas: () => [],
        },
      },
    }),
  })
  return { channels, events, tools, restricts, guards, disposers: disposers.length, module: inspection.module }
}
/**
 * 用宿主产物的 `dispatch()` 走一遍完整链路：仿一个带会话日志的 agent，
 * 验它真的从 `tool/call` 事件里回放出了调用次数。
 *
 * 使用含历史的日志确认统计覆盖整个会话，不依赖进程内累加。
 * @returns {Promise<object>} 一份快照。
 */
async function inspectProjection(module) {

  const events = [
    { type: 'tool/call', data: { callId: 'c1', name: 'read' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c1' } } } },
    { type: 'tool/call', data: { callId: 'c2', name: 'read' } },
    { type: 'tool/result', data: { message: { source: { callId: 'c2' } }, error: { code: 'BOOM' } } },
  ]
  const agent = { session: { snapshotEvents: () => events } }
  const ctx = {
    agents: { get: () => agent },
    tools: {
      schemas: () => [
        { name: 'ralph', description: 'loop' },
        { name: 'read', description: 'Read  a\n\nfile', parameters: { properties: { p: {}, q: {} }, required: ['p'] } },
      ],
    },
  }
  const outcome = module.dispatch(ctx, 'snapshot', { sessionId: 's1' })
  if (outcome.ok !== true) throw new Error(`dispatch 失败：${JSON.stringify(outcome)}`)
  return outcome.value
}

/**
 * 检查 tools-inspector 浏览器构建产物的视图座位、命名空间和 external 依赖。
 *
 * @returns {{ seats: object[], namespaces: string[], externals: string[] }}
 */
function inspectClientBundle() {
  const bundle = join(ROOT, 'packages', 'plugins', 'tools-inspector', 'dist', 'client.js')
  return inspectClientArtifact({
    bundle,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', { useState: inspectionNoop, useEffect: inspectionNoop, useCallback: inspectionNoop, useMemo: inspectionNoop, createElement: inspectionNoop }],
      ['react/jsx-runtime', { jsx: inspectionNoop, jsxs: inspectionNoop, Fragment: inspectionNoop }],
      ['@deepseek-ai/dsh-client-ui-primitives', { Input: inspectionNoop }],
    ]),
    unknownExternal: (id) => new Error('bundle 要求页面模块表之外的模块：' + id),
    buildContext: ({ exports, externals }) => {
      const seats = []
      const namespaces = []
      const ctx = createClientInspectionContext({
        seats,
        namespaces,
        locale: { bind: () => (key => key) },
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
  check(artifact.channels.includes('/tools-inspector'), '宿主产物挂上了 /tools-inspector 通道',
    artifact.channels.join('、'))
  check(artifact.events.length === 0,
    '宿主产物不再监听任何事件（计数改为回放会话日志，重启后依然准确）',
    artifact.events.join('、') || '（没有）')
  check(artifact.disposers >= 1, '通道注册是可撤销的（挂在 ctx.effect 上）')
  // ⚠️ 这三条是本插件的定义性约束：它是只读观察窗口。
  check(artifact.tools === 0, '宿主产物没有注册任何工具（观察窗口不该改变工具表）',
    `实际 ${artifact.tools} 个`)
  check(artifact.restricts === 0 && artifact.guards === 0,
    '宿主产物没有调用 tools.restrict/guard（不改变 agent 能看到什么）',
    `restrict ${artifact.restricts}、guard ${artifact.guards}`)

  const snapshot = await inspectProjection(artifact.module)
  check(snapshot.registered === 2 && snapshot.used === 1 && snapshot.totalCalls === 2,
    '从会话日志的 tool/call 回放出了调用次数（不是进程内累加）', JSON.stringify({
      registered: snapshot.registered, used: snapshot.used, totalCalls: snapshot.totalCalls,
    }))
  check(snapshot.entries[0]?.name === 'read' && snapshot.entries[1]?.name === 'ralph',
    '已用的排在未用的前面', snapshot.entries.map(entry => entry.name).join('、'))
  check(snapshot.entries[0]?.description === 'Read a file',
    '描述里的换行与连续空白被折成单行', JSON.stringify(snapshot.entries[0]?.description))
  check(snapshot.entries[0]?.fullDescription === 'Read  a\n\nfile',
    '展开区保留工具的完整原始描述', JSON.stringify(snapshot.entries[0]?.fullDescription))
  check(snapshot.entries[0]?.failures === 1, '失败次数被单独计出')
  // 只有两档状态：dsh 没有 deferred tool loading（docs/dsh/runtime.md）。
  const statuses = [...new Set(snapshot.entries.map(entry => entry.status))].sort()
  check(statuses.every(status => status === 'used' || status === 'unused'),
    '状态只有 used / unused 两档（dsh 没有工具延迟加载）', statuses.join('、'))

  const client = inspectClientBundle()
  check(client.seats.length === 1, '浏览器产物只占一个座位', `共 ${client.seats.length} 个`)
  const seat = client.seats[0]
  // `conversation.view` 是 list 槽，dsh 自己的 chat(0)、trajectory(10) 已经在里面。
  check(seat?.name === 'conversation.view', '座位是会话头部那个视图切换栏的 list 槽', String(seat?.name))
  check(seat?.id === 'dsh-plugin-tools-inspector', '条目 id 用的是包名后缀', String(seat?.id))
  check(typeof seat?.order === 'number' && seat.order > 10,
    'order 排在 dsh 自带的 chat(0) 与 trajectory(10) 之后', String(seat?.order))
  // ⚠️ label 必须是 thunk，否则切换语言后 tab 文字不跟着变。
  check(typeof seat?.label === 'function', 'tab 文案是 thunk，跟随语言切换', typeof seat?.label)
  check(client.namespaces.includes('dsh-plugin-tools-inspector'), '文案命名空间也是包名后缀',
    client.namespaces.join('、'))
  const PLATFORM_MODULES = [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives',
  ]
  const offTable = client.externals.filter(id => !PLATFORM_MODULES.includes(id))
  check(offTable.length === 0, '浏览器产物只 require 页面模块表里的说明符',
    offTable.length === 0 ? client.externals.join('、') : `表外：${offTable.join('、')}`)

  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（槽注册与通道挂载都被接受）')
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
        check(bundleBody.includes('conversation.view'), 'bundle 里带着视图切换栏的槽注册')
        check(bundleBody.includes('/tools-inspector'), 'bundle 里带着宿主那条私有通道的路径')
        check(bundleBody.includes('visibilitychange'), 'bundle 里带着「页面不可见就停止轮询」的那半逻辑')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const live = await context.callChannel('snapshot', { sessionId: 'no-such-session' }, cookie)
      const value = live.body?.result?.value
      check(live.status === 200 && live.body?.result?.ok === true && Array.isArray(value?.entries),
        '/tools-inspector 通道已挂载，且对没有活 agent 的会话退回全局视图',
        JSON.stringify(live.body).slice(0, 200))
      check((value?.registered ?? 0) > 0, '快照里真的读到了工具', `registered=${value?.registered}`)
      const extra = value?.entries?.flatMap(entry =>
        Object.keys(entry).filter(key =>
          !['name', 'description', 'fullDescription', 'status', 'calls', 'failures', 'params', 'required'].includes(key))) ?? []
      check(extra.length === 0, '条目形状没有多出未预期的字段', extra.join('、'))

      const malformed = await context.callChannel('snapshot', {}, cookie)
      check(
        malformed.body?.result?.ok === false
        && malformed.body.result.error?.code === 'tools-inspector/bad-payload',
        '缺少 sessionId 的调用被通道自己挡下',
        JSON.stringify(malformed.body),
      )

      const unknown = await context.callChannel('reset', { sessionId: 'x' }, cookie)
      check(
        unknown.body?.result?.ok === false
        && unknown.body.result.error?.code === 'tools-inspector/unknown-endpoint',
        '通道上只有 snapshot 一个端点（观察窗口没有写操作）',
        JSON.stringify(unknown.body),
      )

      const unauthenticated = await fetch(`${context.base}/tools-inspector/snapshot`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'snapshot', payload: { sessionId: 'x' } }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
