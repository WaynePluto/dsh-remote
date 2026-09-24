/**
 * 冒烟：确认 notify 插件两半装上、设置命名空间落地、通道能把通知推到桌面。
 * 真机契约：`approval/request` 与 `user-questions/request` 两个瀑布监听器签名错会启动失败；Windows toast 未注册 AUMID 时可被 API 接受却静默不显示，故脚本真的弹通知并需人眼确认。
 * ⚠️ 运行会在桌面弹一条常驻通知，需要手动关闭。
 * 升级 dsh 后运行：`node scripts/notify-check.mjs [--port 3099]`。
 * 全过程不发模型请求、不写会话。
 */

import { join } from 'node:path'
import { DSH_BIN, DSH_PROFILE, DEV_DIRECTORY, ROOT, dshPluginOverlays } from './local-config.mjs'
import { createCheckContext, runLiveDshCheck } from './lib/check-context.mjs'


const PACKAGE_ID = '@dsh-station/dsh-plugin-notify'
const NAMESPACE = 'dsh-plugin-notify'
// dsh 0.1.7 起设置表单按 profile 行 entry id 寻址，与文案命名空间解耦。
const ENTRY_ID = 'notify'
const CHANNEL = 'notify'
const portArgument = process.argv.indexOf('--port')
const PORT = portArgument === -1 ? 3099 : Number(process.argv[portArgument + 1])
const HOME = join(DEV_DIRECTORY, 'notify-check-home')

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
  channel: CHANNEL,
  tokenPattern: /dsh web:\s*\S+?[?&]token=([\w.-]+)/u,
  timeoutMessage: (output) => 'dsh 60 秒内没有打印访问地址:\n' + output,
  exitMessage: (code, output) => 'dsh 退出（code ' + code + '）：\n' + output,
})
const { prepareHome } = context
async function main() {
  prepareHome()
  await runLiveDshCheck(context, {
    startedAssertions: () => {
      check(true, 'dsh 带全部 --patch 正常启动（两个瀑布监听与设置命名空间都被接受）')
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
        check(bundleBody.includes('settings.section'), 'bundle 里带着设置页的槽注册')
        check(bundleBody.includes(NAMESPACE), 'bundle 读写的是宿主注册的那个设置命名空间')
        check(bundleBody.includes(`/${CHANNEL}`), 'bundle 里带着测试通道的路径')
      }
    },
    liveAssertions: async ({ cookie }) => {
      const described = await context.callApi('settings/describe', {}, cookie)
      const sections = described.body?.result?.value?.namespaces ?? described.body?.result?.value?.sections ?? described.body?.result?.value ?? null
      const rendered = JSON.stringify(sections ?? described.body)
      check(rendered.includes(ENTRY_ID), `设置里出现了本插件的表单条目 ${ENTRY_ID}`, rendered.slice(0, 200))

      const mutated = await context.callApi('settings/mutate', {
        ns: ENTRY_ID,
        ops: [{ op: 'set', path: ['enabled'], value: false }],
      }, cookie)
      check(
        mutated.body?.result?.ok === true,
        '开关能被写入（页面上的那次点击走的就是这条路）',
        JSON.stringify(mutated.body?.result?.error ?? '').slice(0, 200),
      )
      await context.callApi('settings/mutate', { ns: ENTRY_ID, ops: [{ op: 'set', path: ['enabled'], value: true }] }, cookie)

      const unknownEndpoint = await context.callChannel('nope', {}, cookie)
      check(
        unknownEndpoint.body?.result?.ok === false
        && unknownEndpoint.body.result.error?.code === 'notify/unknown-endpoint',
        '未知端点被通道自己挡下',
        JSON.stringify(unknownEndpoint.body).slice(0, 200),
      )

      const unauthenticated = await fetch(`${context.base}/${CHANNEL}/test`, {
        method: 'POST',
        headers: { host: context.authority, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'smoke', method: 'test', payload: {} }),
      })
      check(unauthenticated.status === 401, '没有 cookie 的调用被 dsh 挡在门外', `status ${unauthenticated.status}`)

      const sent = await context.callChannel('test', {}, cookie)
      const value = sent.body?.result?.value
      check(
        sent.status === 200 && sent.body?.result?.ok === true && value?.ok === true,
        '通道发出了一条真实通知',
        JSON.stringify(sent.body).slice(0, 200),
      )
      if (value?.platform !== 'win32') {
        console.log(`[note] 这台机器是 ${value?.platform}，桌面通知在这里本来就不可用。`)
      } else {
        console.log('[看一眼] 桌面右下角现在应该有一条「DSH · 通知测试」的常驻通知，需要你手动关掉。')
        console.log('        如果什么都没出现：先看「专注助手」，再看 Windows 通知设置里有没有 “DeepSeek Harness”。')
      }
    },
  })
  console.log(failures === 0 ? '\n全部通过。' : `\n${failures} 项未通过。`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
