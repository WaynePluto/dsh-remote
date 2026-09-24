/**
 * 冒烟：确认 dsh 真的把 copilot-auth 插件的两半都装上了。
 * D17 链路：宿主半靠 `--patch`，浏览器半沿 overlay 路径找 package.json，读取 `dsh.client` 与 `exports["./client"]`；任一变化只会显示 fiber FAILED 或页面缺块，单测看不见。
 * 升级 dsh 后运行：`node scripts/copilot-auth-check.mjs [--port 3099]`。
 * 运行时契约：首页 `__DSH_BOOT__` 有插件行，combo bundle 可取；
 * `/copilot-auth/status` 带 cookie 返回未登录，不带 cookie 返回 401。
 * 全过程不发 GitHub 请求，也不写凭据。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'

const PACKAGE_ID = '@dsh-station/dsh-plugin-copilot-auth'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'copilot-auth-check-home')

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
  channel: 'copilot-auth',
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
async function main() {
  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带两个 --patch 正常启动')
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
        check(bundleBody.includes('settings.models.provider-card'), 'bundle 里带着模型页的扩展槽注册')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const status = await context.callChannel('status', {}, cookie)
      const statusBody = typeof status.body === 'string' ? status.body : JSON.stringify(status.body)
      const answer = typeof status.body === 'string' ? undefined : status.body
      check(status.status >= 200 && status.status < 300 && answer?.result?.ok === true, '/copilot-auth/status 应答成功',
        answer === undefined ? 'status ' + status.status + ': ' + statusBody.slice(0, 200) : JSON.stringify(answer))
      check(answer?.result?.value?.signedIn === false, '未登录状态如实上报')

      const unauthenticated = await fetch(`${context.base}/copilot-auth/status`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'status', payload: {} }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
