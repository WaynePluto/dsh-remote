/**
 * 冒烟：确认 user-message-fork 构建产物下发并注册正确的消息行，
 * 并对 dsh 的 `conversation.chat.node/user` keyed cell 使用非默认 priority 影子覆盖。
 * 不发模型请求、不写用户会话；dsh 使用隔离的临时 home。
 * 升级 dsh 或修改插件后运行：`node scripts/user-message-fork-check.mjs [--port 3098]`。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import { inspectClientBundle as inspectClientArtifact } from './lib/check-client-bundle.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-user-message-fork'
const CLIENT_BUNDLE = join(ROOT, 'packages', 'plugins', 'user-message-fork', 'dist', 'client.js')
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'user-message-fork-check-home')

let failures = 0
const NOOP = () => {}

function check(ok, what, detail) {
  if (!ok) failures += 1
  console.log(`${ok ? '[ok]  ' : '[fail]'} ${what}${detail === undefined ? '' : ` — ${detail}`}`)
}

function inspectBundle() {
  return inspectClientArtifact({
    bundle: CLIENT_BUNDLE,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', {
        useCallback: NOOP,
        useEffect: NOOP,
        useId: () => 'smoke-id',
        useMemo: (factory) => factory(),
        useRef: () => ({ current: null }),
        useState: (initial) => [initial, NOOP],
      }],
      ['react/jsx-runtime', { Fragment: NOOP, jsx: NOOP, jsxs: NOOP }],
      ['@deepseek-ai/dsh-client-ui-primitives', {
        DocumentFileIcon: NOOP,
        IconBranchOutline16: NOOP,
        IconCheckOutline16: NOOP,
        IconCopyOutline16: NOOP,
        JsonBlock: NOOP,
        Tooltip: NOOP,
        fileSizeText: () => '',
        projectUserText: () => null,
        writeClipboard: async () => true,
      }],
    ]),
    unknownExternal: (id) => new Error('bundle 要求页面模块表之外的模块：' + id),
    buildContext: ({ source, exports }) => {
      const registrations = []
      const namespaces = []
      let disposers = 0
      const ctx = {
        effect: (run) => {
          const dispose = run()
          if (typeof dispose === 'function') disposers += 1
          return NOOP
        },
        locale: { register: (namespace) => { namespaces.push(namespace); return NOOP } },
        sessions: {},
        slots: {
          inject: (_name, run) => { run() },
          register: (options) => { registrations.push(options); return NOOP },
        },
      }
      exports.apply(ctx)
      return { registrations, namespaces, disposers, bundle: source }
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
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址：\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context

async function main() {
  const report = inspectBundle()
  const user = report.registrations.find(entry => entry.key === 'user')
  check(user?.name === 'conversation.chat.node', '产物把 user renderer 注册进 conversation.chat.node', JSON.stringify(user))
  check(user?.priority === -1, 'user renderer 使用 priority -1 影子覆盖 dsh 默认 renderer', JSON.stringify(user))
  check(report.namespaces.includes('dsh-plugin-user-message-fork'), '产物注册了自己的文案命名空间')
  check(report.disposers >= 2, '产物 apply() 注册了文案和样式两个可撤销副作用', `${report.disposers} 个`)
  check(report.bundle.includes('sessions.fork'), 'bundle 包含 sessions.fork 调用')
  check(report.bundle.includes('setDraft'), 'bundle 包含输入框 setDraft 回填')

  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（没有 keyed priority 冲突）')
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(cookie !== '', 'token 换到了 dsh 浏览器 cookie', `status ${exchange.status}`)
    },
    bundleAssertions: ({ index, url, bundle, bundleBody }) => {
      const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
      check(idAt !== -1, '首页 __DSH_BOOT__ 里有本插件的行')

      if (url !== null) {
        check(bundle.ok, '插件 browser bundle 能取到', `status ${bundle.status}`)
        check(bundleBody.includes('__ModuleLoader__.load'), 'bundle 是 dsh loader 认识的工件格式')
        check(bundleBody.includes('conversation.chat.node'), 'bundle 带着消息流 keyed 槽注册')
        check(bundleBody.includes('priority:-1') || bundleBody.includes('priority: -1'), 'bundle 带着非默认 shadow priority')
        check(bundleBody.includes('setDraft'), '下发 bundle 保留输入框回填路径')
      }
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
