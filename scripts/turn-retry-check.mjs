/**
 * 冒烟：确认 turn-retry 两半装上且通道可用。
 * 真机契约：向 session-projection 注册 `turnRetry`；stateVersion 冲突/schema 非法会让 fiber FAILED，而不是少横幅。
 * 只保留事后 projection + RPC，浏览器 bundle 不应再带「不再提示」，所以 dsh 启动并打印 token 是关键证明。
 * 升级 dsh 后运行：`node scripts/turn-retry-check.mjs [--port 3098]`。
 * 全过程不发模型请求、不写会话。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'


const PACKAGE_ID = '@dsh-remote/dsh-plugin-turn-retry'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3098 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'turn-retry-check-home')

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
  channel: 'turn-retry',
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
async function main() {
  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（projection 注册与 RPC 通道被接受）')
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
        check(bundleBody.includes('turnRetry'), 'bundle 里读的是宿主发布的那个投影 key')
        check(bundleBody.includes('stoppedTitle'), 'bundle 里带着「上一轮被停止」那一半的文案')
        check(bundleBody.includes('dsh-turn-retry-reason-dialog'), 'bundle 里带着与服务日志同尺寸的失败详情弹窗')
        check(bundleBody.includes('overflowX'), 'bundle 里保留失败详情的横向滚动设置')
        check(!bundleBody.includes('不再提示'), 'bundle 不再包含「不再提示」按钮文案')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const unknown = await context.callChannel('retry', { sessionId: 'no-such-session' }, cookie)
      check(
        unknown.status === 200 && unknown.body?.result?.ok === true
        && unknown.body.result.value?.started === false,
        '/turn-retry 通道已挂载，且拒绝重试一个不存在的会话',
        JSON.stringify(unknown.body),
      )

      const malformed = await context.callChannel('retry', {}, cookie)
      check(
        malformed.body?.result?.ok === false
        && malformed.body.result.error?.code === 'turn-retry/bad-payload',
        '缺少 sessionId 的调用被通道自己挡下',
        JSON.stringify(malformed.body),
      )

      const unknownEndpoint = await context.callChannel('nope', { sessionId: 'x' }, cookie)
      check(
        unknownEndpoint.body?.result?.ok === false
        && unknownEndpoint.body.result.error?.code === 'turn-retry/unknown-endpoint',
        '未知端点被通道自己挡下',
        JSON.stringify(unknownEndpoint.body),
      )

      const unauthenticated = await fetch(`${context.base}/turn-retry/retry`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'retry', payload: { sessionId: 'x' } }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
