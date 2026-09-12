/**
 * 冒烟：确认代理设置写入在真 dsh 上通过。
 * 回归线上 bug：宿主校验器拒绝无协议 `127.0.0.1:7890`；`SettingsScope.mutate` 被宿主拒绝时 resolve 不 reject（`packages/client/ui-settings/src/client/settings-scope.ts:132-135`），会静默重载状态，把「拒绝」显示成「已保存」并丢掉草稿。
 * 单测只能覆盖纯函数；必须真实调用 `/api/settings/mutate` 才能验证宿主是否接受写入。
 * 运行：`node scripts/proxy-check.mjs [--port 3097]`。
 * 全程不出网、不改用户 DSH_HOME（使用临时 home）。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'

const PACKAGE_ID = '@dsh-remote/dsh-plugin-proxy'
const NAMESPACE = 'dsh-plugin-proxy'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3097 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'proxy-check-home')

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
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
/**
 * 往代理命名空间写一次。
 * @param {string} cookie 浏览器 cookie。
 * @param {Array<{op: string, path: string[], value?: unknown}>} ops 路径操作。
 * @returns {Promise<{ ok: boolean, detail: string }>} 宿主是否接受。
 */
async function mutate(cookie, ops) {
  const { body } = await context.callApi('settings/mutate', { ns: NAMESPACE, ops }, cookie)
  const ok = body?.result?.ok === true
  return { ok, detail: JSON.stringify(body?.result?.error ?? body?.result?.value?.user ?? body).slice(0, 160) }
}

async function main() {
  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动')
    },
    exchangeAssertions: ({ exchange, cookie }) => {
      check(cookie !== '', 'token 换到了 dsh 的浏览器 cookie', `status ${exchange.status}`)
    },
    bundleAssertions: ({ index }) => {
      check(index.includes(`"id":"${PACKAGE_ID}"`), '首页的 __DSH_BOOT__ 里有代理插件的行')
    },
    liveAssertions: async ({ cookie }) => {
      const described = await context.callApi('settings/describe', {}, cookie)
      const namespaces = described.body?.result?.value?.namespaces ?? []
      check(
        Array.isArray(namespaces) && namespaces.some(entry => entry?.ns === NAMESPACE),
        `宿主注册了设置命名空间 ${NAMESPACE}`,
        JSON.stringify(namespaces.map(entry => entry?.ns)).slice(0, 160),
      )

      const bare = await mutate(cookie, [{ op: 'set', path: ['url'], value: '127.0.0.1:7890' }])
      check(
        bare.ok,
        '宿主接受不带协议的 127.0.0.1:7890（回归用例）',
        bare.detail,
      )

      const enable = await mutate(cookie, [{ op: 'set', path: ['enabled'], value: true }])
      check(enable.ok, '地址存好之后可以打开开关', enable.detail)

      const socks = await mutate(cookie, [{ op: 'set', path: ['url'], value: 'socks5://127.0.0.1:1080' }])
      check(!socks.ok, '宿主仍然拒绝拨不通的 socks5 地址', socks.detail)

      const creds = await mutate(cookie, [{ op: 'set', path: ['url'], value: 'http://user:secret@proxy.test:8080' }])
      check(!creds.ok, '宿主仍然拒绝地址里带凭据', creds.detail)

      const cleared = await mutate(cookie, [{ op: 'set', path: ['url'], value: '' }])
      check(!cleared.ok, '开关开着时不允许把地址清空', cleared.detail)
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
