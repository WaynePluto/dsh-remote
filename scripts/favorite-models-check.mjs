/**
 * 冒烟：确认「常用模型」的 Host/Client 产物、overlay、槽注册和 dsh 认证加载都成立。
 *
 * 用法：node scripts/favorite-models-check.mjs [--port 3098]
 * 只使用临时 DSH_HOME，不发起模型请求，也不修改真实会话或设置。
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import { inspectClientBundle as inspectClientArtifact } from './lib/check-client-bundle.mjs'


const PACKAGE_ID = '@dsh-station/dsh-plugin-favorite-models'
const PACKAGE_DIR = join(ROOT, 'packages', 'plugins', 'favorite-models')
const BUNDLE_PATCH = join(PACKAGE_DIR, 'cordis.patch.yml')
const HOST_BUNDLE = join(PACKAGE_DIR, 'dist', 'index.js')
const CLIENT_BUNDLE = join(PACKAGE_DIR, 'dist', 'client.js')
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'favorite-models-check-home')

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
    missingLoader: () => new Error('client bundle did not call __ModuleLoader__.load'),
    externalShims: new Map([
      ['react', {
        useEffect: NOOP,
        useId: () => 'smoke-id',
        useMemo: (_fn, _deps) => _fn(),
        useRef: (value) => ({ current: value }),
        useState: (value) => [value, NOOP],
        useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
        createElement: NOOP,
      }],
      ['react-dom', { createPortal: (node) => node }],
      ['react/jsx-runtime', { jsx: NOOP, jsxs: NOOP, Fragment: NOOP }],
      ['@deepseek-ai/dsh-client-ui-primitives', {
        Button: NOOP,
        IconCheckOutlineMedium: NOOP,
        IconChevronDownOutlineMedium: NOOP,
        IconChevronRightOutlineMedium: NOOP,
        IconWarningOutlineMedium: NOOP,
        Input: NOOP,
        Tag: NOOP,
        Toast: NOOP,
      }],
    ]),
    idMismatch: (actual) => new Error('client bundle id is ' + actual),
    unknownExternal: (id) => new Error('client bundle requested a non-platform module: ' + id),
    buildContext: ({ source, exports }) => {
      const registrations = []
      const form = {
        getSnapshot: () => ({ status: 'ready', value: { favorites: [] }, writable: true }),
        subscribe: () => NOOP,
        mutate: async () => true,
        set: async () => true,
        unset: async () => true,
      }
      const directory = {
        store: { getSnapshot: () => ({ current: null, routable: null, groups: [], failures: [], status: 'idle', error: null }), subscribe: () => NOOP },
        load: async () => {},
        select: async () => {},
      }
      const ctx = {
        effect: (run) => { run() },
        locale: { register: () => NOOP, bind: () => (key) => key },
        configForms: { get: () => form },
        sessions: { subagentAddress: () => undefined, list: { getSnapshot: () => ({ current: 'session-1' }), subscribe: () => NOOP } },
        modelDirectories: { directoryFor: () => directory },
        slots: {
          inject: (_name, run) => { run() },
          register: (options, component) => { registrations.push({ options, component }); return NOOP },
        },
      }
      exports.apply(ctx)
      return { source, registrations, exports }
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
  onMissingProfile: (source) => {
    console.error('找不到 profile ' + source + '，先运行一次 pnpm dev。')
    process.exit(1)
  },
})
const { prepareHome } = context
async function main() {
  check(existsSync(BUNDLE_PATCH), 'Bundle patch 文件存在')
  check(readFileSync(BUNDLE_PATCH, 'utf8').includes("name: './dist/index.js'"), 'Bundle patch 使用相对 Host 入口')
  check(existsSync(HOST_BUNDLE), 'Host bundle 存在')
  check(existsSync(CLIENT_BUNDLE), 'Client bundle 存在')

  const bundle = inspectBundle()
  const clientInject = bundle.exports?.inject
  check(Array.isArray(clientInject) && clientInject.includes('remote') && clientInject.includes('remote.session'), 'Client export 声明了 remote 和 remote.session 注入', JSON.stringify(clientInject))
  const selector = bundle.registrations.find(item => item.options.name === 'conversation.input.model')
  const footer = bundle.registrations.find(item => item.options.name === 'settings.models.footer')
  check(selector?.options.priority === -1, 'Client 产物以 priority:-1 影子覆盖 conversation.input.model', JSON.stringify(selector?.options))
  check(footer?.options.id === 'dsh-plugin-favorite-models', 'Client 产物注册 settings.models.footer', JSON.stringify(footer?.options))
  check(!bundle.registrations.some(item => item.options.name === 'model'), 'Client 产物没有注册 /model command')
  check(bundle.source.includes('settings.models.footer') && bundle.source.includes('conversation.input.model'), 'Client bundle 带有两个目标槽')
  check(bundle.source.includes('data-dsh-plugin-favorite-models-list') && bundle.source.includes('data-dsh-plugin-favorite-models-actions'), 'Client bundle 带有独立模型列表和固定操作区')
  check(bundle.source.includes('360px') && bundle.source.includes('overflowY'), 'Client bundle 为模型列表保留最大高度滚动区')
  check(bundle.source.includes('data-dsh-plugin-favorite-models-selector'), 'Client bundle 带有带前缀的原生对齐选择器 stylesheet')
  check(bundle.source.includes('--dsw-specific-menu') && bundle.source.includes('--dsw-elevation-prominent'), 'Client bundle 复用原生菜单主题 token')
  check(!bundle.source.includes('--dsw-specific-tip') && !bundle.source.includes('rgba(128,128,128,0.12)'), 'Client bundle 不再包含旧的自定义菜单/选中背景')

  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: async () => {
      check(true, 'dsh 带常用模型 overlay 正常启动')
      const unauthenticated = await fetch(`${context.base}/`, { headers: context.browserHeaders() })
      check(unauthenticated.status === 401, '未认证首页被 dsh 拦截', `status ${unauthenticated.status}`)
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(cookie !== '', 'token 换到了 dsh cookie', `status ${exchange.status}`)
    },
    bundleAssertions: ({ indexResponse, index, url, bundle: clientBundle, bundleBody }) => {
      check(indexResponse.ok, '认证后首页可加载', `status ${indexResponse.status}`)
      const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
      check(idAt !== -1, '首页 __DSH_BOOT__ 包含常用模型插件')

      if (url !== null) {
        check(clientBundle.ok, '常用模型 combo bundle 可认证加载', `status ${clientBundle.status}`)
        check(bundleBody.includes('__ModuleLoader__.load'), 'combo bundle 是 dsh 可识别的 Client 工件')
        check(bundleBody.includes('conversation.input.model') && bundleBody.includes('settings.models.footer'), '下发 bundle 包含槽注册')
      }
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
