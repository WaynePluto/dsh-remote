
/** files 插件真实 dsh 冒烟：验证双半装载、槽注册、只读 RPC 与认证。 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from "./local-config.mjs"
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'
import { inspectClientBundle as inspectClientArtifact, inspectHostBundle as inspectHostArtifact } from './lib/check-client-bundle.mjs'

const PACKAGE_ID = "@dsh-remote/dsh-plugin-files"
const CHANNEL = "files"
const argument = process.argv.indexOf("--port")
const PORT = argument === -1 ? 3096 : Number(process.argv[argument + 1])
const HOME = join(DEV_DIRECTORY, "files-check-home")
const HOST_ENTRY = join(ROOT, "packages", "plugins", "files", "dist", "index.js")
const CLIENT_BUNDLE = join(ROOT, "packages", "plugins", "files", "dist", "client.js")
const PACKAGE_MANIFEST = join(ROOT, "packages", "plugins", "files", "package.json")
let failures = 0
const noop = () => {}
function check(ok, what, detail) { if (!ok) failures += 1; console.log(`${ok ? "[ok]  " : "[fail]"} ${what}${detail === undefined ? "" : ` — ${detail}`}`) }

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
  rpcId: 'files-check',
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有就绪：\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
  onMissingProfile: (source) => {
    throw new Error(`找不到 profile ${source}，先运行 pnpm dev 创建它。`)
  },
})
const { prepareHome } = context
async function inspectHostBundle() {
  const channels = []
  let disposers = 0
  await inspectHostArtifact({
    entry: HOST_ENTRY,
    createContext: ({ cleanup }) => {
      const ctx = {
        connection: { rpc: { handle: channel => { channels.push(channel); return noop } } },
        agents: { get: () => undefined },
        effect: run => {
          const dispose = run()
          if (typeof dispose === 'function') disposers += 1
          cleanup(dispose)
          return noop
        },
      }
      return ctx
    },
  })
  return { channels, disposers }
}
function inspectClientBundle() {
  return inspectClientArtifact({
    bundle: CLIENT_BUNDLE,
    packageId: PACKAGE_ID,
    externalShims: new Map([
      ['react', { useState: noop, useEffect: noop, useMemo: noop, createElement: noop }],
      ['react/jsx-runtime', { jsx: noop, jsxs: noop, Fragment: noop }],
      ['react-dom', { createPortal: noop }],
      ['@deepseek-ai/dsh-client-ui-primitives', {}],
    ]),
    unknownExternal: (id) => new Error('bundle requested a non-platform module: ' + id),
    buildContext: ({ source: body }) => ({
      loader: body.includes('__ModuleLoader__.load'),
      sidebar: body.includes('sidebar.right.pane.tab'),
      nativeFilesId: body.includes('@deepseek-ai/dsh-client-ui-sidebar-files'),
      documentPreviewId: body.includes('@deepseek-ai/dsh-client-ui-sidebar-documentpreview'),
      singleEntry: !body.includes('files-pro'),
      nativeGuideUntouched: !body.includes('dsh-remote-files-initial-guide-sentinel') && !body.includes('dsh-files-directory-guide') && !body.includes('sidebar.right.tab.guide'),
      temporaryPreview: body.includes('dsh-files-preview-tab-title-temporary') && body.includes('replaceTab'),
      imageZoom: body.includes('data-files-image-zoom') && body.includes('imageZoomFit'),
      imageZoomPortalGuards: body.includes('dsh-files-image-toolbar') && body.includes('onPointerDown') && body.includes('stopPropagation'),
      tabBulkClose: body.includes('close-others') && body.includes('close-all'),
      gitSnapshot: body.includes('gitUnavailable') && body.includes('snapshot'),
      contextMenu: body.includes('copy-relative-path'),
      noConversationView: !body.includes('conversation.view'),
      channel: body.includes('/files'),
      primitives: body.includes('dsh-client-ui-primitives'),
    }),
  })
}
async function main() {
  prepareHome()
  const manifest = JSON.parse(readFileSync(PACKAGE_MANIFEST, "utf8"))
  check(manifest.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-sidebar-files") === true, "包声明原生 ui-sidebar-files 模块依赖")
  check(manifest.dsh?.client?.inject?.includes("@deepseek-ai/dsh-client-ui-sidebar-documentpreview") === true, "包声明原生 documentpreview 模块依赖")
  const host = await inspectHostBundle()
  check(host.channels.includes("/files"), "宿主产物挂上了 /files 通道", host.channels.join(", "))
  check(host.disposers >= 1, "通道注册挂在可撤销的 ctx.effect 上", String(host.disposers))
  const client = inspectClientBundle()
  check(client.loader, "浏览器产物使用 dsh ModuleLoader 格式")
  check(client.sidebar, "浏览器产物注册 Sidebar tab body")
  check(client.nativeFilesId, "浏览器产物绑定原生 ui-sidebar-files")
  check(client.documentPreviewId, "浏览器产物绑定原生 documentpreview")
  check(client.singleEntry, "浏览器产物不再提供 files-pro 页面入口")
  check(client.nativeGuideUntouched, "浏览器产物不替换原生开始页或插入虚假入口")
  check(client.temporaryPreview, "浏览器产物启用临时预览页签")
  check(client.imageZoom, "浏览器产物启用图片缩放层")
  check(client.imageZoomPortalGuards, "图片缩放 portal 阻止原生 tab 事件吞掉点击")
  check(client.tabBulkClose, "浏览器产物保留当前分栏批量关闭")
  check(client.gitSnapshot, "浏览器产物请求 Git snapshot")
  check(client.contextMenu, "浏览器产物保留目录右键菜单操作")
  check(client.noConversationView, "浏览器产物不再注册 conversation.view")
  check(client.channel, "浏览器产物调用 /files 私有通道")
  check(client.primitives, "浏览器产物复用 external ui-primitives")

  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, "dsh 带全部 --patch 正常启动")
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(exchange.status === 303 && cookie !== "", "token 换到了 dsh 浏览器 cookie", `status ${exchange.status}`)
    },
    bundleAssertions: ({ indexResponse, index, url, bundle }) => {
      const idAt = index.indexOf(`"id":"${PACKAGE_ID}"`)
      check(indexResponse.ok && idAt !== -1, "首页 __DSH_BOOT__ 里有 files 插件行", `status ${indexResponse.status}`)
      if (url !== null) {
        check(bundle.ok, "dsh 能取到 files client bundle", `status ${bundle.status}`)
      } else {
        check(false, "从 __DSH_BOOT__ 找到 files bundle URL")
      }
    },
    liveAssertions: async ({ cookie }) => {
      const snapshot = await context.callChannel("snapshot", { sessionId: "no-such-session" }, cookie)
      check(snapshot.status === 200 && snapshot.body?.result?.ok === false && snapshot.body.result.error?.code === "files/session-not-found", "真实 dsh 通道返回明确的 session-not-found", JSON.stringify(snapshot.body).slice(0, 180))
      const legacyList = await context.callChannel("list", { sessionId: "x", path: "../escape" }, cookie)
      check(legacyList.status === 200 && legacyList.body?.result?.ok === false && legacyList.body.result.error?.code === "files/unknown-endpoint", "旧 list 端点已移除", JSON.stringify(legacyList.body).slice(0, 180))
      const legacyRead = await context.callChannel("read", { sessionId: "x", path: "README.md" }, cookie)
      check(legacyRead.status === 200 && legacyRead.body?.result?.ok === false && legacyRead.body.result.error?.code === "files/unknown-endpoint", "旧 read 端点已移除", JSON.stringify(legacyRead.body).slice(0, 180))
      const unknown = await context.callChannel("write", { sessionId: "x" }, cookie)
      check(unknown.status === 200 && unknown.body?.result?.error?.code === "files/unknown-endpoint", "通道没有写入端点", JSON.stringify(unknown.body).slice(0, 180))
      const unauthenticated = await fetch(`${context.base}/${CHANNEL}/snapshot`, { method: "POST", headers: { host: context.authority, "content-type": "application/json" }, body: JSON.stringify({ type: "client-request", rpcId: "files-check", method: "snapshot", payload: { sessionId: "x" } }) })
      check(unauthenticated.status === 401, "没有 dsh cookie 的 RPC 被挡在认证层", `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? "\n全部通过。" : `\n${failures} 项未通过。`)
  process.exitCode = failures === 0 ? 0 : 1
}

try { await main() } catch (error) { console.error(error instanceof Error ? error.stack : String(error)); process.exitCode = 1 }
