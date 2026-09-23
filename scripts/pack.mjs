/** 打绿色包，输出 release/dsh-remote-<version>-<zipTag>-<variant>.zip；条目直接放在 zip 根目录，没有版本目录层。
 *
 * 支持 --target=<目标>（可重复或逗号分隔）、all、--variant=<core|full>（可重复或逗号分隔，默认全打）、
 * --skip-build 和 --skip-exe。变体没有无后缀的默认包：full 带引擎类重组件（Office 预览），
 * core 裁掉它们。目标共用 staging，按命令顺序串行部署；同一目标先打 full 再打 core
 * （core 的裁剪是破坏性的）；跨平台目标在裁剪前、本机目标在裁剪后冒烟。
 */
/* oxlint-disable no-await-in-loop -- 打包目标共用 staging，必须串行部署和验收。 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { materializePluginDistributions } from './plugin-distributions.mjs'
import { createManifest, inPackage, UNLOCK_CROSS_BUILD_HINT } from './pack/manifest.mjs'
import {
  cleanStrayDeployMirrors,
  deployProduction,
  pnpmInvocation,
  readJson,
  run,
  writeRootManifest,
  writeStubEntries,
} from './pack/deploy.mjs'
import {
  checkPrunedTree,
  checkVariantTree,
  pruneToTarget,
  pruneToVariant,
  storeHasTarget,
} from './pack/platform.mjs'
import {
  buildWindowsExecutable,
  smokeTestPackage,
  smokeTestWindowsExecutable,
  verifyPluginDistributions,
} from './pack/verify.mjs'
import {
  createZip,
  directorySize,
  formatSize,
} from './pack/archive.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const skipBuild = process.argv.includes('--skip-build')
const skipExe = process.argv.includes('--skip-exe')

function fail(message, hint) {
  console.error(`\n[pack] ${message}`)
  if (hint !== undefined) console.error(`       ${hint}`)
  console.error('')
  process.exit(1)
}

function say(message) {
  console.log(`[pack] ${message}`)
}

const context = {
  ...createManifest(ROOT, { platform: process.platform, arch: process.arch }),
  fail,
  say,
  execPath: process.execPath,
  env: process.env,
}

const launcherManifest = readJson(context, join(ROOT, 'packages/launcher/package.json'))
const version = launcherManifest.version
if (typeof version !== 'string' || version === '') fail('packages/launcher/package.json 里没有 version。')
const prefix = `dsh-remote-${version}`

/** 解析 target 参数；all 宽松跳过缺少二进制的目标，显式目标硬失败。 */
function resolveRequestedTargets() {
  const known = Object.keys(context.targets)
  const values = process.argv
    .filter(argument => argument.startsWith('--target='))
    .flatMap(argument => argument.slice('--target='.length).split(','))
    .map(value => value.trim())
    .filter(value => value !== '')

  if (values.length === 0) {
    if (!(context.hostTarget in context.targets)) {
      fail(
        `本机是 ${context.hostTarget}，不在支持的发行目标里（${known.join('、')}）。`,
        '用 --target=<triple> 显式指定一个。',
      )
    }
    return { keys: [context.hostTarget], lenient: false }
  }
  if (values.includes('all')) return { keys: known, lenient: true }

  const unknown = values.filter(value => !(value in context.targets))
  if (unknown.length !== 0) {
    fail(`不认识的目标：${unknown.join('、')}`, `可选：${known.join('、')}，或者 all。`)
  }
  return { keys: [...new Set(values)], lenient: false }
}

const { keys: requestedTargets, lenient } = resolveRequestedTargets()
context.lenient = lenient

/** 解析 variant 参数；默认全打，且按 VARIANTS 声明顺序执行（full 在 core 前，core 的裁剪不可逆）。 */
function resolveRequestedVariants() {
  const ordered = Object.keys(context.variants)
  const values = process.argv
    .filter(argument => argument.startsWith('--variant='))
    .flatMap(argument => argument.slice('--variant='.length).split(','))
    .map(value => value.trim())
    .filter(value => value !== '')
  if (values.length === 0) return ordered
  const unknown = values.filter(value => !(value in context.variants))
  if (unknown.length !== 0) {
    fail(`不认识的变体：${unknown.join('、')}`, `可选：${ordered.join('、')}，不指定则全打。`)
  }
  return ordered.filter(key => values.includes(key))
}

const requestedVariants = resolveRequestedVariants()

for (const file of context.allPackagingFiles) {
  if (existsSync(join(context.packaging, file.name))) continue
  fail(`缺少 packaging/${file.name}。`, '这个仓库不完整，或者文件被误删了。')
}

const needsExecutable = requestedTargets.some(key => context.targets[key].platform === 'win32') && !skipExe
if (needsExecutable && !existsSync(join(context.winLauncherDir, 'main.go'))) {
  fail('缺少 packaging/win-launcher/main.go。', '这个仓库不完整，或者文件被误删了。')
}
if (needsExecutable && !existsSync(join(context.winLauncherDir, context.winIconResource))) {
  fail(
    `缺少 packaging/win-launcher/${context.winIconResource}（exe 的内嵌图标与高 DPI 清单）。`,
    '跑 node packaging/make-icons.mjs 重新生成它；缺了只会得到一个默认图标、高分屏上发糊的 exe，从产物上看不出来。',
  )
}

if (skipBuild) say('跳过构建（--skip-build），直接用现有的 dist/。')
else run(context, 'build', pnpmInvocation(context.platform), ['-r', 'build'])

const missingArtifacts = context.buildArtifacts.filter(path => !existsSync(join(ROOT, ...path.split('/'))))
if (missingArtifacts.length !== 0) {
  fail(`缺少构建产物：${missingArtifacts.join('、')}`, '先运行 pnpm build。')
}

mkdirSync(context.release, { recursive: true })

/** 打一个目标；每次重新 deploy，避免上一目标的裁剪污染下一目标。
 * 平台相关步骤只做一遍，随后按声明顺序对每个变体裁剪并各写一个 zip。 */
async function buildTarget(key) {
  const target = context.targets[key]
  const isHost = target.platform === context.platform && target.arch === context.arch
  const withExecutable = target.platform === 'win32' && !skipExe

  console.log('')
  say(`=== 目标 ${key}（${target.label}）===`)

  if (!storeHasTarget(context, target)) {
    const message = `本机没有装 ${key} 的原生二进制（找不到 ${target.sentinel}），打不了这个包。`
    if (!context.lenient) fail(message, UNLOCK_CROSS_BUILD_HINT)
    say(`跳过 ${key}：${message}`)
    return undefined
  }

  say('清理暂存目录')
  rmSync(context.staging, { recursive: true, force: true })

  deployProduction(context, '@dsh-remote/launcher', `${context.stagingRelative}/package`)
  cleanStrayDeployMirrors(context)

  if (!existsSync(join(context.packageDir, 'node_modules'))) {
    fail('pnpm deploy 没有产出 node_modules。', '看上面 deploy 的输出；网络不通时 pnpm 无法解析依赖。')
  }

  say('清理 deploy 带过来的源码与配置')
  for (const entry of readdirSync(context.packageDir, { withFileTypes: true })) {
    if (context.keepAtPackageRoot.has(entry.name)) continue
    rmSync(join(context.packageDir, entry.name), { recursive: true, force: true })
  }

  if (!existsSync(inPackage(context, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
    fail('产物里没有随包携带的 dsh（node_modules/@deepseek-ai/dsh/lib/bin.js）。', 'launcher 在运行时会找它，缺了整个包就是废的。')
  }

  say('生成并验收 plugins/ 第三方插件安装目录')
  materializePluginDistributions({ root: ROOT, output: join(context.packageDir, context.pluginMediaDirectory) })
  verifyPluginDistributions(context)

  const missingShellOverlayFiles = context.shellOverlayFiles
    .filter(relative => !existsSync(inPackage(context, relative)))
  if (missingShellOverlayFiles.length !== 0) {
    fail(
      `产物里缺少壳级 overlay 文件：${missingShellOverlayFiles.join('、')}`,
      'remote-privileged 必须保留为 launcher 的生产依赖，否则 connection 注入无法启动。',
    )
  }

  say('写 dist/ 下的跳转入口')
  writeStubEntries(context)

  const missingEntries = context.runtimeEntries
    .filter(entry => !existsSync(inPackage(context, entry.path)))
    .map(entry => entry.path)
  if (missingEntries.length !== 0) {
    fail(
      `产物里缺少可执行入口：${missingEntries.join('、')}`,
      'relay 与 connector 是靠 packages/launcher/package.json 里的 workspace 依赖被 deploy 进来的，别把它们从那里删掉。',
    )
  }

  say(`复制 ${key} 的启动脚本、README 与示例配置`)
  for (const file of target.files) {
    copyFileSync(join(context.packaging, file.name), join(context.packageDir, file.name))
  }
  writeRootManifest(context.packageDir, launcherManifest)

  if (target.platform === 'win32') {
    if (skipExe) say('跳过编译 dsh-remote.exe（--skip-exe）；这个包在 Windows 上只能用 start.ps1 启动。')
    else buildWindowsExecutable(context)
  }

  if (!isHost) smokeTestPackage(context)

  say(`裁剪 node_modules 到 ${key}`)
  const removed = pruneToTarget(context, target)
  say(`裁掉 ${removed.length} 项不属于 ${key} 的内容`)
  checkPrunedTree(context, key, target)
  verifyPluginDistributions(context)

  if (isHost) smokeTestPackage(context)
  else say(`跳过裁剪后的入口自检：${key} 的包在本机（${context.hostTarget}）跑不了。`)

  if (target.platform === 'win32' && withExecutable) smokeTestWindowsExecutable(context)

  const entryHint = target.platform === 'win32'
    ? (withExecutable ? `双击 ${context.winExecutable}（常驻通知区域）或 pwsh -File .\\start.ps1` : '用 pwsh -File .\\start.ps1（本次没有打进 dsh-remote.exe）')
    : '跑 ./start.sh'

  const results = []
  for (const variantKey of requestedVariants) {
    const variant = context.variants[variantKey]
    console.log('')
    say(`=== 变体 ${variantKey}（${variant.label}）===`)
    if (variant.excludes.length > 0) {
      const removedEngines = pruneToVariant(context, variant)
      say(`裁掉 ${removedEngines.length} 个引擎类重组件：${removedEngines.join('、')}`)
      // 变体裁剪动过树，本机目标重新自检一遍；跨平台目标本来就只能在目标机上跑。
      if (isHost) smokeTestPackage(context)
    }
    checkVariantTree(context, variantKey, variant)
    verifyPluginDistributions(context)

    const treeBytes = directorySize(context.packageDir)
    say(`打包前目录大小 ${formatSize(treeBytes)}`)

    const output = join(context.release, `${prefix}-${target.zipTag}-${variant.zipTag}.zip`)
    rmSync(output, { force: true })
    say(`写入 ${output}`)
    const zipBytes = await createZip(context, output, target.files, withExecutable)
    results.push({ key, variant: variantKey, label: `${target.label}（${variant.label}）`, output, zipBytes, entryHint })
  }

  rmSync(context.staging, { recursive: true, force: true })
  return results
}

const built = []
const skipped = []
for (const key of requestedTargets) {
  // 目标共用暂存目录，必须逐个处理，不能并行删除彼此的文件。
  // oxlint-disable-next-line no-await-in-loop：共享暂存目录必须串行处理。
  const results = await buildTarget(key)
  if (results === undefined) skipped.push(key)
  else built.push(...results)
}

if (built.length === 0) {
  fail('一个包都没打出来。', UNLOCK_CROSS_BUILD_HINT)
}

console.log(`
[pack] 完成，${built.length} 个包`)
for (const item of built) {
  console.log(`       ${item.key} · ${item.variant}（${item.label}） ${formatSize(item.zipBytes)}
         文件: ${item.output}
         解压后: ${item.entryHint}`)
}
if (skipped.length !== 0) {
  console.log(`       跳过: ${skipped.join('、')}（本机没有这些平台的原生二进制）
       ${UNLOCK_CROSS_BUILD_HINT}`)
}
console.log('       dsh 的原生依赖按平台安装，别发错平台。')
console.log('       同一平台的 core/full 是同一个程序：core 只少了 Office 预览引擎，打开 Office 预览会报转换不可用。\n')
