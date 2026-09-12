/** 打绿色包，输出 release/dsh-remote-<version>-<zipTag>.zip；条目直接放在 zip 根目录，没有版本目录层。
 *
 * 支持 --target=<目标>（可重复或逗号分隔）、all、--skip-build 和 --skip-exe。
 * 目标共用 staging，按命令顺序串行部署；跨平台目标在裁剪前、本机目标在裁剪后冒烟。
 */
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
  pruneToTarget,
  storeHasTarget,
} from './pack/platform.mjs'
import {
  buildWindowsExecutable,
  smokeTestPackage,
  smokeTestWindowsExecutable,
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

/** 打一个目标；每次重新 deploy，避免上一目标的裁剪污染下一目标。 */
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

  const missingPluginFiles = context.dshPluginFiles.filter(relative => !existsSync(inPackage(context, relative)))
  if (missingPluginFiles.length !== 0) {
    fail(
      `产物里缺少 dsh 插件文件：${missingPluginFiles.join('、')}`,
      '插件靠 packages/launcher/package.json 里的 workspace 依赖被 deploy 进来；缺了 launcher 会拒绝启动 dsh。',
    )
  }

  const missingConciseProfileBundleFiles = context.conciseProfileBundleFiles
    .filter(relative => !existsSync(inPackage(context, relative)))
  if (missingConciseProfileBundleFiles.length !== 0) {
    fail(
      `产物里缺少 concise-mode profile bundle 文件：${missingConciseProfileBundleFiles.join('、')}`,
      'concise-mode 不是 launcher overlay；请确认 workspace 依赖已被 deploy，且 profile bundle 的 dist/index.js 已构建。',
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

  if (isHost) smokeTestPackage(context)
  else say(`跳过裁剪后的入口自检：${key} 的包在本机（${context.hostTarget}）跑不了。`)

  if (target.platform === 'win32' && withExecutable) smokeTestWindowsExecutable(context)

  const treeBytes = directorySize(context.packageDir)
  say(`打包前目录大小 ${formatSize(treeBytes)}`)

  const output = join(context.release, `${prefix}-${target.zipTag}.zip`)
  rmSync(output, { force: true })
  say(`写入 ${output}`)
  const zipBytes = await createZip(context, output, target.files, withExecutable)
  rmSync(context.staging, { recursive: true, force: true })

  const entryHint = target.platform === 'win32'
    ? (withExecutable ? `双击 ${context.winExecutable}（常驻通知区域）或 pwsh -File .\\start.ps1` : '用 pwsh -File .\\start.ps1（本次没有打进 dsh-remote.exe）')
    : '跑 ./start.sh'
  return { key, label: target.label, output, zipBytes, entryHint }
}

const built = []
const skipped = []
for (const key of requestedTargets) {
  // 目标共用暂存目录，必须逐个处理，不能并行删除彼此的文件。
  // oxlint-disable-next-line no-await-in-loop：共享暂存目录必须串行处理。
  const result = await buildTarget(key)
  if (result === undefined) skipped.push(key)
  else built.push(result)
}

if (built.length === 0) {
  fail('一个包都没打出来。', UNLOCK_CROSS_BUILD_HINT)
}

console.log(`
[pack] 完成，${built.length} 个包`)
for (const item of built) {
  console.log(`       ${item.key}（${item.label}） ${formatSize(item.zipBytes)}
         文件: ${item.output}
         解压后: ${item.entryHint}`)
}
if (skipped.length !== 0) {
  console.log(`       跳过: ${skipped.join('、')}（本机没有这些平台的原生二进制）
       ${UNLOCK_CROSS_BUILD_HINT}`)
}
console.log('       dsh 的原生依赖按平台安装，别发错平台。\n')
