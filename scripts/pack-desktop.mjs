/** 打桌面版安装介质（S8.2/S8.3），输出到 release/：
 *   dsh-station-<version>-<平台>-desktop-<variant>.zip      便携 zip（全平台）
 *   dsh-station-<version>-win-x64-desktop-<variant>-setup.exe  NSIS 安装包（Windows）
 *   dsh-station-<version>-linux-x64-desktop-<variant>.deb   deb 安装包（Linux）
 *
 * 桌面二进制依赖系统 WebView/CGO 工具链，只能在对应平台上构建：
 * 本脚本仅支持 target == 本机平台。变体遵循 D21/D22：
 *   full：完整引擎 + 随包 Node（开箱即用）；lite：裁剪引擎 + 系统 Node。
 * 后台载荷与绿色包同一部署管线（pnpm deploy + 插件介质 + 平台裁剪）。
 */
/* oxlint-disable no-await-in-loop -- 目标共用 staging，必须串行部署和验收。 */
import {
  cpSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { ZipArchive } from 'archiver'
import { materializePluginDistributions } from './plugin-distributions.mjs'
import { createManifest, inPackage, UNLOCK_CROSS_BUILD_HINT } from './pack/manifest.mjs'
import { buildDeb } from './pack/deb.mjs'
import {
  cleanStrayDeployMirrors,
  deployProduction,
  pnpmInvocation,
  readJson,
  run,
  writeStubEntries,
} from './pack/deploy.mjs'
import {
  checkPrunedTree,
  checkVariantTree,
  pruneToTarget,
  pruneToVariant,
  storeHasTarget,
} from './pack/platform.mjs'
import { verifyPluginDistributions } from './pack/verify.mjs'
import { directorySize, formatSize } from './pack/archive.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const DESKTOP_SOURCE_DIR = join(ROOT, 'packages', 'desktop')
const INSTALLER_TEMPLATE = join(ROOT, 'packaging', 'desktop-installer.nsi')
const DESKTOP_README = join(ROOT, 'packaging', 'desktop', 'README.txt')
const DESKTOP_INFO_PLIST = join(ROOT, 'packaging', 'desktop', 'Info.plist')
const NODE_MANIFEST_FILE = join(ROOT, 'packaging', 'desktop-node.json')
const TOOLCHAIN_CACHE = join(ROOT, '.dev', 'desktop-toolchain', 'desktop-node')

function fail(message, hint) {
  console.error(`\n[pack-desktop] ${message}`)
  if (hint !== undefined) console.error(`       ${hint}`)
  console.error('')
  process.exit(1)
}

function say(message) {
  console.log(`[pack-desktop] ${message}`)
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
const prefix = `dsh-station-${version}`

const DESKTOP_TARGETS = {
  'win32-x64': { platform: 'win32', arch: 'x64', label: 'Windows x64', zipTag: 'win-x64', executable: 'dsh-station.exe' },
  'linux-x64': { platform: 'linux', arch: 'x64', label: 'Linux x64', zipTag: 'linux-x64', executable: 'dsh-station' },
  'darwin-arm64': { platform: 'darwin', arch: 'arm64', label: 'macOS Apple Silicon', zipTag: 'darwin-arm64', executable: 'dsh-station' },
}

function resolveRequestedTargets() {
  const values = process.argv
    .filter(argument => argument.startsWith('--target='))
    .flatMap(argument => argument.slice('--target='.length).split(','))
    .map(value => value.trim())
    .filter(value => value !== '')
  if (values.length === 0) return [context.hostTarget]
  const unknown = values.filter(value => !(value in DESKTOP_TARGETS))
  if (unknown.length !== 0) {
    fail(`不认识的桌面目标：${unknown.join('、')}`, `可选：${Object.keys(DESKTOP_TARGETS).join('、')}。`)
  }
  return [...new Set(values)]
}

function resolveRequestedVariants() {
  const values = process.argv
    .filter(argument => argument.startsWith('--variant='))
    .flatMap(argument => argument.slice('--variant='.length).split(','))
    .map(value => value.trim())
    .filter(value => value !== '')
  const known = ['full', 'lite']
  if (values.length === 0) return known
  const unknown = values.filter(value => !known.includes(value))
  if (unknown.length !== 0) fail(`不认识的变体：${unknown.join('、')}`, `可选：${known.join('、')}，不指定则全打。`)
  return known.filter(key => values.includes(key))
}

const skipBuild = process.argv.includes('--skip-build')
const skipInstaller = process.argv.includes('--skip-installer')
const requestedTargets = resolveRequestedTargets()
const requestedVariants = resolveRequestedVariants()

for (const targetKey of requestedTargets) {
  const target = DESKTOP_TARGETS[targetKey]
  if (target.platform !== context.platform || target.arch !== context.arch) {
    fail(
      `桌面目标 ${targetKey} 只能在对应平台上构建（当前 ${context.hostTarget}）。`,
      '桌面壳依赖系统 WebView/CGO 工具链，不支持交叉编译；由对应平台的 CI runner 打包。',
    )
  }
}

if (!existsSync(join(DESKTOP_SOURCE_DIR, 'main.go'))) fail('缺少 packages/desktop/。', '这个仓库不完整，或者文件被误删了。')
if (requestedVariants.includes('full') && !existsSync(NODE_MANIFEST_FILE)) {
  fail(`缺少 ${NODE_MANIFEST_FILE}。`, '完整版需要随包 Node 的固定版本与官方哈希。')
}

if (skipBuild) say('跳过构建（--skip-build），直接用现有的 dist/。')
else run(context, 'build', pnpmInvocation(context.platform), ['-r', 'build'])

const missingArtifacts = context.buildArtifacts.filter(path => !existsSync(join(ROOT, ...path.split('/'))))
if (missingArtifacts.length !== 0) {
  fail(`缺少构建产物：${missingArtifacts.join('、')}`, '先运行 pnpm build。')
}

if (context.platform === 'win32') {
  // Windows 资源（图标 + DPI manifest）必须先生成，go build 自动链入。
  const prepare = spawnSync('node', ['scripts/prepare-desktop.mjs'], { cwd: ROOT, stdio: 'inherit' })
  if (prepare.status !== 0) fail('无法准备桌面 Windows 资源（packaging/win-launcher/rsrc_windows_amd64.syso）。')
}

mkdirSync(context.release, { recursive: true })

/** 下载（或复用缓存）随包 Node，并按官方哈希校验后只提取 node + LICENSE。 */
function provisionNodeRuntime(targetKey, destination) {
  const manifest = readJson(context, NODE_MANIFEST_FILE)
  const entry = manifest.platforms[targetKey]
  if (entry === undefined) fail(`desktop-node.json 缺少 ${targetKey} 的运行时条目。`)

  const archiveCache = join(TOOLCHAIN_CACHE, 'archives')
  const archivePath = join(archiveCache, entry.archive)
  mkdirSync(archiveCache, { recursive: true })
  if (!existsSync(archivePath)) {
    say(`下载随包 Node ${manifest.version}（${targetKey}）`)
    const download = spawnSync('curl', ['-sSL', '--retry', '3', '-o', archivePath, entry.url], { stdio: 'inherit' })
    if (download.status !== 0) fail(`下载 ${entry.url} 失败。`, '网络可用时重试；也可手动下载后放到 ' + archiveCache)
  }
  const digest = createHash('sha256').update(readFileSync(archivePath)).digest('hex')
  if (digest !== entry.sha256) {
    fail(
      `${entry.archive} 的 SHA-256 不匹配：得到 ${digest}，期望 ${entry.sha256}。`,
      '删除缓存重试；若官方包哈希变化，更新 packaging/desktop-node.json。',
    )
  }

  const extractDir = join(TOOLCHAIN_CACHE, manifest.version, targetKey)
  if (!existsSync(join(extractDir, ...entry.binary.split('/').slice(1)))) {
    say('解压随包 Node（只取 node 与 LICENSE）')
    const work = mkdtempSync(join(tmpdir(), 'dsh-station-node-'))
    try {
      if (entry.archive.endsWith('.zip')) {
        const extract = spawnSync('powershell', ['-NoProfile', '-Command',
          `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${work}' -Force`], { stdio: 'inherit' })
        if (extract.status !== 0) fail('Expand-Archive 失败。')
      } else {
        const extract = spawnSync('tar', ['-xzf', archivePath, '-C', work], { stdio: 'inherit' })
        if (extract.status !== 0) fail('tar 解压失败。')
      }
      rmSync(extractDir, { recursive: true, force: true })
      mkdirSync(extractDir, { recursive: true })
      cpSync(join(work, ...entry.binary.split('/')), join(extractDir, ...entry.binary.split('/')))
      cpSync(join(work, ...entry.license.split('/')), join(extractDir, ...entry.license.split('/')))
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }

  // 目标布局：runtime/node[/bin]/node + runtime/node/LICENSE
  const isWindows = targetKey.startsWith('win32')
  const binaryDestination = join(destination, isWindows ? 'node.exe' : join('bin', 'node'))
  mkdirSync(join(destination, isWindows ? '.' : 'bin'), { recursive: true })
  copyFileSync(join(extractDir, ...entry.binary.split('/')), binaryDestination)
  copyFileSync(join(extractDir, ...entry.license.split('/')), join(destination, 'LICENSE'))
  if (!isWindows) {
    const chmod = spawnSync('chmod', ['0755', binaryDestination])
    if (chmod.status !== 0 && context.platform === 'linux') fail('无法设置随包 Node 的执行位。')
  }
  return binaryDestination
}

/** 从 ico 里抽出 256px PNG 条目（deb 图标用；ico 的 256 尺寸以 PNG 存储）。 */
function extractIconPng() {
  const icoPath = join(ROOT, 'packaging', 'dsh-station.ico')
  if (!existsSync(icoPath)) return undefined
  const data = readFileSync(icoPath)
  const count = data.readUInt16LE(4)
  let largest = null
  for (let index = 0; index < count; index += 1) {
    const at = 6 + 16 * index
    const width = data[at]
    const size = data.readUInt32LE(at + 8)
    const offset = data.readUInt32LE(at + 12)
    const entry = { width: width === 0 ? 256 : width, size, offset }
    if (largest === null || entry.width > largest.width) largest = entry
  }
  if (largest === null || largest.width !== 256) return undefined
  const png = data.subarray(largest.offset, largest.offset + largest.size)
  if (png.subarray(0, 4).toString('binary') !== '\u0089PNG') return undefined
  const output = join(context.staging, 'dsh-station-icon-256.png')
  writeFileSync(output, png)
  return output
}

function buildDesktopBinary(target, output) {
  say(`编译桌面壳：${target.executable}`)
  const tags = context.platform === 'win32' ? 'production,wv2runtime.error' : 'production'
  const result = spawnSync('go', ['build', '-tags', tags, '-o', output, '.'], {
    cwd: DESKTOP_SOURCE_DIR,
    stdio: 'inherit',
    env: { ...process.env, GOTOOLCHAIN: 'local' },
  })
  if (result.status !== 0) fail('桌面壳编译失败。', '确认本机 Go 与 Wails 依赖可用（见 packages/desktop/README.md）。')
  const bytes = statSync(output).size
  if (bytes < 1024 * 1024) fail(`桌面壳体积异常（${String(bytes)} 字节）。`)
}

function zipDirectory(directory, output) {
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const stream = createWriteStream(output)
  const finished = new Promise((settle, reject) => {
    stream.on('close', settle)
    stream.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', reject)
  })
  archive.pipe(stream)
  const walk = (current, prefix) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name)
      const archiveName = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (context.pnpmBookkeeping.some(pattern => pattern.test(archiveName.replaceAll('\\', '/')))) continue
      if (entry.isDirectory()) walk(absolute, archiveName)
      else {
        const mode = (statSync(absolute).mode & 0o111) !== 0 ? 0o755 : 0o644
        archive.file(absolute, { name: archiveName, mode })
      }
    }
  }
  walk(directory, '')
  return archive.finalize().then(() => finished).then(() => archive.pointer())
}

function runSelfCheck(target, install) {
  const executable = join(install, target.executable)
  const result = spawnSync(executable, ['--selfcheck'], { cwd: install, encoding: 'utf8' })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    fail(`桌面壳自检失败：${output}`, '安装目录布局（package/、runtime/node/）或系统 Node 可能不完整。')
  }
  say(`自检通过：${output.split('\n')[0]}`)
}

/** darwin 的 .app 骨架；返回（可执行文件目录, 载荷目录）。 */
function prepareAppBundle(install, appName = 'DSH 工作站') {
  const contents = join(install, `${appName}.app`, 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  mkdirSync(join(contents, 'Resources'), { recursive: true })
  writeFileSync(join(contents, 'Info.plist'), readFileSync(DESKTOP_INFO_PLIST, 'utf8').replaceAll('{{VERSION}}', version))
  // PkgInfo：Finder 识别 bundle 类型。
  writeFileSync(join(contents, 'PkgInfo'), 'APPL????\n')
  return { executableDirectory: join(contents, 'MacOS'), payloadDirectory: join(contents, 'Resources') }
}

function writeInstallFiles(install, variantKey) {
  copyFileSync(DESKTOP_README, join(install, 'README.txt'))
  const manifest = readJson(context, NODE_MANIFEST_FILE)
  writeFileSync(join(install, 'dsh-station-manifest.json'), `${JSON.stringify({
    name: 'dsh-station-desktop',
    version,
    variant: variantKey,
    dsh: manifest?.version ?? null,
  }, undefined, 2)}\n`)
}

async function buildTarget(targetKey) {
  const target = DESKTOP_TARGETS[targetKey]
  console.log('')
  say(`=== 桌面目标 ${targetKey}（${target.label}）===`)

  if (!storeHasTarget(context, context.targets[targetKey])) {
    fail(
      `本机没有装 ${targetKey} 的原生二进制（找不到 ${context.targets[targetKey].sentinel}），打不了这个包。`,
      UNLOCK_CROSS_BUILD_HINT,
    )
  }

  say('清理暂存目录')
  rmSync(context.staging, { recursive: true, force: true })

  deployProduction(context, '@dsh-station/launcher', `${context.stagingRelative}/package`)
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
  say('写 dist/ 下的跳转入口')
  writeStubEntries(context)
  say(`裁剪 node_modules 到 ${targetKey}`)
  const manifestTarget = context.targets[targetKey]
  const removed = pruneToTarget(context, manifestTarget)
  say(`裁掉 ${removed.length} 项不属于 ${targetKey} 的内容`)
  checkPrunedTree(context, targetKey, manifestTarget)
  verifyPluginDistributions(context)

  const results = []
  for (const variantKey of requestedVariants) {
    const variant = context.variants[variantKey]
    console.log('')
    say(`=== 变体 ${variantKey}（${variant.label}）===`)
    if (variant.excludes.length > 0) {
      const removedEngines = pruneToVariant(context, variant)
      say(`裁掉 ${removedEngines.length} 个引擎类重组件：${removedEngines.join('、')}`)
    }
    checkVariantTree(context, variantKey, variant)
    verifyPluginDistributions(context)

    const install = join(context.staging, 'install')
    rmSync(install, { recursive: true, force: true })
    mkdirSync(install, { recursive: true })
    const isDarwin = target.platform === 'darwin'
    const appBundle = isDarwin ? prepareAppBundle(install) : null
    const layout = isDarwin
      ? {
          payload: join(appBundle.payloadDirectory, 'package'),
          runtime: join(appBundle.payloadDirectory, 'runtime', 'node'),
          executableDirectory: appBundle.executableDirectory,
        }
      : {
          payload: join(install, 'package'),
          runtime: join(install, 'runtime', 'node'),
          executableDirectory: install,
        }
    writeInstallFiles(isDarwin ? appBundle.payloadDirectory : install, variantKey)

    say('部署载荷到安装目录')
    cpSync(context.packageDir, layout.payload, { recursive: true })

    if (variantKey === 'full') {
      provisionNodeRuntime(targetKey, layout.runtime)
    } else {
      // 轻量版自检需要系统 Node；提前给出可读的失败。
      const probe = spawnSync('node', ['--version'], { encoding: 'utf8' })
      if (probe.status !== 0) fail('轻量版自检失败：本机 PATH 上没有系统 node。', '轻量版要求用户自装 Node ≥ 22.19.0。')
    }

    buildDesktopBinary(target, join(layout.executableDirectory, target.executable))
    runSelfCheck(target, layout.executableDirectory)

    const treeBytes = directorySize(install)
    say(`安装目录大小 ${formatSize(treeBytes)}`)

    const portableZip = join(context.release, `${prefix}-${target.zipTag}-desktop-${variant.zipTag}.zip`)
    rmSync(portableZip, { force: true })
    say(`写入 ${portableZip}`)
    const zipBytes = await zipDirectory(install, portableZip)
    results.push({ kind: 'zip', output: portableZip, bytes: zipBytes, variantKey })

    if (target.platform === 'win32' && !skipInstaller) {
      const makensis = spawnSync('makensis', ['-VERSION'], { encoding: 'utf8' })
      if (makensis.status !== 0) {
        say('警告：没有找到 makensis，跳过 NSIS 安装包（只产出便携 zip）。')
        say('       CI 上通过 choco install nsis 安装；本地安装后重跑 --skip-build 可补安装包。')
      } else {
        const setupOutput = join(context.release, `${prefix}-${target.zipTag}-desktop-${variant.zipTag}-setup.exe`)
        const script = join(context.staging, 'desktop-installer.nsi')
        writeFileSync(script, readFileSync(INSTALLER_TEMPLATE, 'utf8')
          .replaceAll('{{OUTPUT}}', setupOutput.replaceAll('/', '\\'))
          .replaceAll('{{INSTALL}}', install.replaceAll('/', '\\'))
          .replaceAll('{{VERSION}}', version))
        const compile = spawnSync('makensis', [script], { stdio: 'inherit' })
        if (compile.status !== 0) fail('NSIS 编译失败。')
        results.push({ kind: 'installer', output: setupOutput, bytes: statSync(setupOutput).size, variantKey })
      }
    }
    if (target.platform === 'linux' && !skipInstaller) {
      say('组装 deb 数据树（/opt/dsh-station + .desktop + 图标）')
      const debData = join(context.staging, 'deb-data')
      rmSync(debData, { recursive: true, force: true })
      mkdirSync(join(debData, 'opt'), { recursive: true })
      mkdirSync(join(debData, 'usr', 'share', 'applications'), { recursive: true })
      mkdirSync(join(debData, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps'), { recursive: true })
      cpSync(install, join(debData, 'opt', 'dsh-station'), { recursive: true })
      writeFileSync(join(debData, 'usr', 'share', 'applications', 'dsh-station.desktop'), [
        '[Desktop Entry]',
        'Type=Application',
        'Name=DSH 工作站',
        'Comment=官方 DeepSeek Harness 的工作站封装',
        'Exec=/opt/dsh-station/dsh-station',
        'Icon=dsh-station',
        'Categories=Development;Utility;',
        'Terminal=false',
        '',
      ].join('\n'))
      const iconPng = extractIconPng()
      if (iconPng !== undefined) {
        copyFileSync(iconPng, join(debData, 'usr', 'share', 'icons', 'hicolor', '256x256', 'apps', 'dsh-station.png'))
      }
      const executablePaths = [join(debData, 'opt', 'dsh-station', target.executable)]
      if (variantKey === 'full') executablePaths.push(join(debData, 'opt', 'dsh-station', 'runtime', 'node', 'bin', 'node'))
      const debOutput = join(context.release, `${prefix}-${target.zipTag}-desktop-${variant.zipTag}.deb`)
      const debBytes = buildDeb({
        data: { directory: debData, target: '', executables: executablePaths },
        control: {
          package: 'dsh-station',
          version: version.replaceAll('-', '+'),
          architecture: 'amd64',
          maintainer: 'dsh-station <dsh-station@users.noreply.github.com>',
          description: 'DSH 工作站 —— 官方 DeepSeek Harness 的桌面封装工作站',
          ...(variantKey === 'full' ? {} : { depends: 'nodejs (>= 22.19.0)' }),
        },
        output: debOutput,
      })
      rmSync(debData, { recursive: true, force: true })
      results.push({ kind: 'installer', output: debOutput, bytes: debBytes, variantKey })
    }
    rmSync(install, { recursive: true, force: true })
  }

  rmSync(context.staging, { recursive: true, force: true })
  return results
}

const built = []
for (const key of requestedTargets) {
  const results = await buildTarget(key)
  built.push(...results)
}

if (built.length === 0) fail('一个桌面介质都没打出来。')

console.log(`
[pack-desktop] 完成，${built.length} 个产物`)
for (const item of built) {
  console.log(`       ${item.variantKey} · ${item.kind}（${formatSize(item.bytes)}）
         文件: ${item.output}`)
}
console.log('       完整版自带 Node 与 Office 引擎；轻量版要求系统 Node ≥ 22.19.0。')
console.log('       macOS/Linux 的实机验收按计划 S10 执行，未验收平台不得宣传为已通过。\n')
