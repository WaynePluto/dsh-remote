/**
 * 冒烟：确认 exec-process 插件下发到页面，构建 bundle 会注册三个分段座位。
 * 本插件只有浏览器半；`conversation.chat.node` keyed 槽要以非默认 priority 影子覆盖 dsh 的 `turn-process`，同 priority 注册会抛错（`packages/client/ui-slots/src/index.ts:836-842`）并带走整个 web UI；`uiConversation.events.register` 重名也抛错。
 * 因此必须对构建产物实际执行 `apply()` 并检查三段注册结果，而不是只测源码。
 * 升级 dsh 后运行：`node scripts/exec-process-check.mjs [--port 3097]`。
 * 全过程不发模型请求、不写会话。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import {
  createClientInspectionContext,
  inspectClientBundle as inspectClientArtifact,
  inspectionNoop,
} from './lib/check-client-bundle.mjs'


const PACKAGE_ID = '@dsh-remote/dsh-plugin-exec-process'
const CLIENT_BUNDLE = join(ROOT, 'packages', 'plugins', 'exec-process', 'dist', 'client.js')
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'exec-process-check-home')

let failures = 0



function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

/**
 * 检查 exec-process 浏览器构建产物注册的消息定义、座位和可撤销副作用。
 *
 * @returns {{ definitions: string[], seats: {key?: string, priority?: number, locale?: string}[], namespaces: string[], disposers: number }}
 */
function inspectBundle() {
  return inspectClientArtifact({
    bundle: CLIENT_BUNDLE,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', {
        useEffect: inspectionNoop,
        useCallback: inspectionNoop,
        useMemo: inspectionNoop,
        useSyncExternalStore: inspectionNoop,
        createElement: inspectionNoop,
      }],
      ['react/jsx-runtime', { jsx: inspectionNoop, jsxs: inspectionNoop, Fragment: inspectionNoop }],
      ['@deepseek-ai/dsh-client-ui-primitives', { IconChevronDownOutline14: inspectionNoop }],
    ]),
    unknownExternal: (id) => new Error('bundle 要求页面模块表之外的模块：' + id),
    buildContext: ({ exports }) => {
      const definitions = []
      const seats = []
      const namespaces = []
      const disposers = []
      const ctx = createClientInspectionContext({
        seats,
        namespaces,
        disposers,
        fields: {
          uiConversation: { events: { register: (definition) => { definitions.push(definition.kind); return inspectionNoop } } },
        },
      })
      exports.apply(ctx)
      return { definitions, seats, namespaces, disposers: disposers.length }
    },
  })
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
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
async function main() {
  const bundleReport = inspectBundle()
  check(
    bundleReport.definitions.includes('exec-process') && bundleReport.definitions.includes('exec-process-user'),
    '产物里的 apply() 注册了首段与用户消息分段定义',
    JSON.stringify(bundleReport.definitions),
  )
  const row = bundleReport.seats.find(seat => seat.key === 'exec-process')
  check(
    row?.name === 'conversation.chat.node' && row?.locale === 'dsh-plugin-exec-process',
    '产物把「执行过程」行注册进了 conversation.chat.node',
    JSON.stringify(row),
  )
  const userRow = bundleReport.seats.find(seat => seat.key === 'exec-process-user')
  check(
    userRow?.name === 'conversation.chat.node' && userRow?.locale === 'dsh-plugin-exec-process',
    '产物把用户消息后的「执行过程」行注册进了 conversation.chat.node',
    JSON.stringify(userRow),
  )

  const shadow = bundleReport.seats.find(seat => seat.key === 'turn-process')
  check(
    typeof shadow?.priority === 'number' && shadow.priority !== 0,
    'dsh 自己的 turn-process 是用非默认 priority 影子覆盖的（同 priority 会抛错并带走整个 web UI）',
    JSON.stringify(shadow),
  )
  check(
    bundleReport.disposers >= 6,
    '产物里的 apply() 至少登记了 6 个可撤销副作用（含用户分段与 frame controller）',
    `${bundleReport.disposers} 个可撤销副作用`,
  )

  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动')
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
        check(bundleBody.includes('conversation.chat.node'), 'bundle 里带着会话消息流的槽注册')
        check(bundleBody.includes('data-chat-flow-key'), 'bundle 里带着折叠所依赖的 dsh 行标识属性')
        check(bundleBody.includes('--dshx-exec-process-push-'), 'bundle 里带着吸顶推出所依赖的自定义属性前缀')
        check(bundleBody.includes('position: sticky'), 'bundle 里带着吸顶规则本身')
        check(bundleBody.includes('--dsw-specific-tip'), 'bundle 里包含展开标题背景 token --dsw-specific-tip')
        check(bundleBody.includes('--dsw-alias-border-l2'), 'bundle 里包含更强 frame 边框 token --dsw-alias-border-l2')
        check(
          bundleBody.includes('data-dsh-plugin-exec-process-frame'),
          'bundle 里包含展开内容外框样式表标记 data-dsh-plugin-exec-process-frame',
        )
      }
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
