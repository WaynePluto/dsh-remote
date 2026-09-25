/** 统一发布入口（D22 四端矩阵），产物统一输出到 release/：
 *
 *   node scripts/release.mjs [--target=<win32-x64|linux-x64|darwin-arm64|all>] [--variant=<lite|full>] [其余参数透传]
 *
 *   --target=all（默认）    本机平台桌面版 + Linux 服务版 zip（lite/full 全打）
 *   --variant=lite / full   只打指定变体；lite 不下载随包 Node，full 首次下载后缓存
 *
 * 对应 package.json 的命令：release（= all）与各平台按变体拆分的
 * release:win:lite / release:win:full / release:mac:lite / release:mac:full /
 * release:linux:lite / release:linux:full（linux 两个变体都附带服务版 zip）。
 * 桌面壳依赖系统 WebView/CGO，只能打本机平台，其余平台的桌面介质由 release 工作流的
 * 原生 runner 产出；服务版 zip 可从任意平台交叉打包。构建只做一次，两个打包脚本
 * 共用 --skip-build；--skip-installer 等其余参数原样透传。
 */
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { pnpmInvocation, run } from './pack/deploy.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const RELEASE_TARGETS = new Set(['win32-x64', 'linux-x64', 'darwin-arm64'])
const SERVER_TARGET = 'linux-x64'

function fail(message, hint) {
  console.error(`\n[release] ${message}`)
  if (hint !== undefined) console.error(`       ${hint}`)
  console.error('')
  process.exit(1)
}

function say(message) {
  console.log(`[release] ${message}`)
}

const context = { root: ROOT, fail, say, platform: process.platform }

const releaseArguments = process.argv.slice(2)
const requested = releaseArguments.find(argument => argument.startsWith('--target='))?.slice('--target='.length) ?? 'all'
if (requested !== 'all' && !RELEASE_TARGETS.has(requested)) {
  fail(`不认识的发布目标：${requested}`, `可选：${[...RELEASE_TARGETS].join('、')}，或者 all（默认）。`)
}

const hostTarget = `${process.platform}-${process.arch}`
if (requested !== 'all' && requested !== hostTarget) {
  // 与 pack-desktop 的判定一致，但在构建前就报，不白跑一次完整构建。
  fail(
    `发布目标 ${requested} 的桌面介质只能在对应平台上构建（当前 ${hostTarget}）。`,
    '桌面壳依赖系统 WebView/CGO 工具链，不支持交叉编译；在对应平台的机器或 CI 原生 runner 上执行。',
  )
}
const desktopTarget = requested === 'all' ? hostTarget : requested
if (!RELEASE_TARGETS.has(desktopTarget)) {
  fail(
    `本机是 ${desktopTarget}，不在桌面发布目标里（${[...RELEASE_TARGETS].join('、')}）。`,
    '桌面版只支持 win32-x64 / linux-x64 / darwin-arm64。',
  )
}
const withServerZip = requested === 'all' || requested === SERVER_TARGET

const skipBuild = releaseArguments.includes('--skip-build')
const variantArgument = releaseArguments.find(argument => argument.startsWith('--variant='))
const requestedVariantLabel = variantArgument?.slice('--variant='.length) ?? 'lite/full'
if (skipBuild) say('跳过构建（--skip-build），直接用现有的 dist/。')
else run(context, 'build', pnpmInvocation(context.platform), ['-r', 'build'])

// 两个打包脚本共用 release/.staging，必须顺序执行；--skip-build 复用上面的一次构建。
const forwarded = releaseArguments.filter(
  argument => !argument.startsWith('--target=') && argument !== '--skip-build',
)
const sharedArguments = ['--skip-build', ...forwarded]
run(context, `桌面版 ${desktopTarget}（setup + portable）`, { command: process.execPath, shell: false }, [
  'scripts/pack-desktop.mjs', `--target=${desktopTarget}`, ...sharedArguments,
])
if (withServerZip) {
  run(context, `服务版 zip（${SERVER_TARGET}）`, { command: process.execPath, shell: false }, [
    'scripts/pack.mjs', `--target=${SERVER_TARGET}`, ...sharedArguments,
  ])
}

const produced = [`桌面版 ${desktopTarget}（setup + portable × ${requested === 'all' ? 'lite/full' : requestedVariantLabel}）`]
if (withServerZip) produced.push(`服务版 zip ${SERVER_TARGET}（${requested === 'all' ? 'lite/full' : requestedVariantLabel}）`)
console.log(`
[release] 完成，已写入 release/：
       ${produced.join('\n       ')}
       其余发布端需在对应平台执行 release:<平台>:<lite|full>，或由 release 工作流的原生 runner 打包。
       完整版首次打包会下载随包 Node（之后缓存在 .dev/desktop-toolchain，不再重复下载）。\n`)
