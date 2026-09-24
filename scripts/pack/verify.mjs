import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'

/** 交叉编译 Windows 托盘入口；Go 缺失时由入口统一报错退出。 */
export function buildWindowsExecutable(context) {
  const output = join(context.packageDir, context.winExecutable)
  context.say(`交叉编译 ${context.winExecutable}（GOOS=windows GOARCH=amd64）`)
  const result = spawnSync('go', ['build', '-ldflags=-s -w -H windowsgui', '-o', output, '.'], {
    cwd: context.winLauncherDir,
    stdio: 'inherit',
    // -s -w 去掉符号表；-H windowsgui 隐藏控制台；CGO_ENABLED=0 避免交叉编译依赖 C 工具链。
    env: { ...context.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  })
  if (result.error?.code === 'ENOENT') {
    context.fail(
      '找不到 go 命令，编不出 Windows 的双击入口 dsh-station.exe。',
      '装一个 Go（https://go.dev/dl/）再打包。确实要发一个没有 exe 的包，就显式加 --skip-exe。',
    )
  }
  if (result.error !== undefined) context.fail(`go build 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    context.fail(
      `go build 失败（退出码 ${result.status ?? 'null'}）。`,
      `源码在 ${context.winLauncherDir}，上面是 go 自己的输出。`,
    )
  }
}

/** 读取 PE 的 MZ、PE 签名和 subsystem 字段。 */
export function readPortableExecutable(path) {
  const handle = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(4)
    readSync(handle, buffer, 0, 2, 0)
    if (buffer.toString('latin1', 0, 2) !== 'MZ') return { reason: '开头不是 MZ' }
    readSync(handle, buffer, 0, 4, 0x3c)
    const peOffset = buffer.readUInt32LE(0)
    readSync(handle, buffer, 0, 4, peOffset)
    if (buffer.toString('latin1', 0, 4) !== 'PE\0\0') return { reason: '找不到 PE 签名' }
    readSync(handle, buffer, 0, 2, peOffset + 24 + 68)
    return { subsystem: buffer.readUInt16LE(0) }
  } finally {
    closeSync(handle)
  }
}

/** 检查 Windows exe 的大小、PE 格式、GUI subsystem，并在本机运行自检。 */
export function smokeTestWindowsExecutable(context) {
  const path = join(context.packageDir, context.winExecutable)
  if (!existsSync(path)) {
    context.fail(`产物里没有 ${context.winExecutable}。`, 'go build 报告成功却没留下文件，这不正常。')
  }
  const bytes = statSync(path).size
  if (bytes < context.winExecutableMinBytes) {
    context.fail(
      `${context.winExecutable} 只有 ${bytes} 字节，不像是编出来的程序。`,
      '删掉它重新打包；也看一眼杀毒软件是不是把文件截了。',
    )
  }
  const pe = readPortableExecutable(path)
  if (pe.subsystem === undefined) {
    context.fail(
      `${context.winExecutable} 不是 Windows 可执行文件（${pe.reason}）。`,
      '检查 go build 的 GOOS 是不是被环境覆盖成了别的。',
    )
  }
  if (pe.subsystem !== context.winSubsystemGui) {
    context.fail(
      `${context.winExecutable} 的 PE subsystem 是 ${pe.subsystem}，不是 GUI（${context.winSubsystemGui}）。`,
      'go build 的 -ldflags 里少了 -H windowsgui，这样双击会先弹出一个控制台窗口。',
    )
  }
  context.say(`自检 ${context.winExecutable}：${Math.round(bytes / 1024)} KB，PE 头正常，subsystem=GUI`)

  if (context.platform !== 'win32') {
    context.say(`跳过运行 ${context.winExecutable}：当前不是 Windows，跑不了 GOOS=windows 的二进制。`)
    return
  }
  context.say(`自检 ${context.winExecutable} --selfcheck`)
  const result = spawnSync(path, ['--selfcheck'], { cwd: context.packageDir, encoding: 'utf8' })
  if (result.error !== undefined) context.fail(`自检 ${context.winExecutable} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-12)
    context.fail(
      `${context.winExecutable} --selfcheck 退出码 ${result.status ?? 'null'}。`,
      `双击入口是废的，不会写出 zip。它自己的输出：\n       ${output.join('\n       ')}`,
    )
  }
}

function readJson(context, path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    context.fail(`${label} 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
}

function packageDirectoryName(packageName) {
  return packageName.slice(packageName.lastIndexOf('/') + 1).replace(/^dsh-plugin-/u, '')
}

function componentSource(context, packageName) {
  return join(context.root, 'packages', 'plugins', packageDirectoryName(packageName))
}

function packagePath(root, relative) {
  return join(root, ...relative.replace(/^\.\//u, '').split('/'))
}

/** 对照源码逐文件检查复制结果；这样 presets 下的所有文件也会被完整验收。 */
function checkCopiedPath(context, source, target, label) {
  if (!existsSync(source)) context.fail(`源码缺少 ${label}：${source}`)
  if (!existsSync(target)) context.fail(`发行插件缺少 ${label}：${target}`)
  const sourceStat = statSync(source)
  const targetStat = statSync(target)
  if (sourceStat.isDirectory() !== targetStat.isDirectory()) {
    context.fail(`发行插件里的 ${label} 文件类型不对：${target}`)
  }
  if (sourceStat.isDirectory()) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      checkCopiedPath(context, join(source, entry.name), join(target, entry.name), `${label}/${entry.name}`)
    }
    return
  }
  if (!sourceStat.isFile() || !targetStat.isFile()) {
    context.fail(`发行插件里的 ${label} 不是普通文件：${target}`)
  }
  const sourceBytes = readFileSync(source)
  const targetBytes = readFileSync(target)
  if (!sourceBytes.equals(targetBytes)) context.fail(`发行插件里的 ${label} 与构建产物不一致：${target}`)
}

function checkDistributionPackage(context, source, target, label) {
  const sourceManifestPath = join(source, 'package.json')
  const targetManifestPath = join(target, 'package.json')
  if (!existsSync(targetManifestPath)) context.fail(`发行插件缺少 ${label}/package.json。`)
  const sourceManifest = readJson(context, sourceManifestPath, `${label} 源码 package.json`)
  const targetManifest = readJson(context, targetManifestPath, `${label} 发行 package.json`)
  if (sourceManifest.name !== targetManifest.name || sourceManifest.version !== targetManifest.version) {
    context.fail(`发行插件 ${label} 的包名或版本与源码不一致。`)
  }

  for (const entry of [...sourceManifest.files ?? [], 'README.md']) {
    checkCopiedPath(context, packagePath(source, entry), packagePath(target, entry), `${label}/${entry}`)
  }

  // 即使 package.json 的 files/main/client 被误改，也不能静默漏掉已有运行时产物。
  for (const artifact of [
    { relative: 'dist/index.js', kind: '宿主产物' },
    { relative: 'dist/client.js', kind: '浏览器产物' },
    { relative: 'presets', kind: 'preset 产物' },
  ]) {
    const sourceArtifact = packagePath(source, artifact.relative)
    if (!existsSync(sourceArtifact)) continue
    checkCopiedPath(
      context,
      sourceArtifact,
      packagePath(target, artifact.relative),
      `${label}/${artifact.kind}`,
    )
  }

  const patch = sourceManifest.dsh?.bundle?.patch
  if (typeof patch !== 'string' || !existsSync(packagePath(target, patch))) {
    context.fail(`发行插件 ${label} 缺少 Bundle patch：${String(patch)}`)
  }
  if (sourceManifest.main !== undefined && !existsSync(packagePath(target, sourceManifest.main))) {
    context.fail(`发行插件 ${label} 缺少宿主产物：${String(sourceManifest.main)}`)
  }
  if (sourceManifest.dsh?.client !== undefined) {
    const client = sourceManifest.exports?.['./client']
    if (typeof client !== 'string' || !existsSync(packagePath(target, client))) {
      context.fail(`发行插件 ${label} 缺少浏览器产物：${String(client)}`)
    }
  }
}

/**
 * 验收第三方插件安装介质。每次平台或 variant 裁剪后都重跑，防止裁剪误伤插件目录。
 * 组合包组件从自己的 node_modules 加载，不再假设功能插件位于发行根 node_modules。
 */
export function verifyPluginDistributions(context) {
  const sourceCatalog = readJson(
    context,
    join(context.root, context.pluginCatalogFile),
    context.pluginCatalogFile,
  )
  if (sourceCatalog.schemaVersion !== 1 || !Array.isArray(sourceCatalog.distributions)) {
    context.fail(`${context.pluginCatalogFile} 格式无效。`)
  }
  const mediaRoot = join(context.packageDir, context.pluginMediaDirectory)
  const releaseCatalogPath = join(mediaRoot, 'catalog.json')
  if (!existsSync(releaseCatalogPath)) context.fail('发行包缺少 plugins/catalog.json。')
  const releaseCatalog = readJson(context, releaseCatalogPath, 'plugins/catalog.json')
  if (releaseCatalog.schemaVersion !== 1 || !Array.isArray(releaseCatalog.plugins)) {
    context.fail('plugins/catalog.json 格式无效。')
  }
  if (releaseCatalog.plugins.length !== sourceCatalog.distributions.length) {
    context.fail(
      `plugins/catalog.json 应列出 ${String(sourceCatalog.distributions.length)} 个分发包，实际为 ${String(releaseCatalog.plugins.length)} 个。`,
    )
  }
  if (!existsSync(join(mediaRoot, 'README.txt'))) context.fail('发行包缺少 plugins/README.txt。')

  const expectedDirectories = sourceCatalog.distributions.map(distribution => packageDirectoryName(distribution.name))
  if (new Set(expectedDirectories).size !== expectedDirectories.length) {
    context.fail(`${context.pluginCatalogFile} 含有重复的插件分发目录。`)
  }
  const actualDirectories = readdirSync(mediaRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .toSorted()
  const expectedSorted = expectedDirectories.toSorted()
  if (JSON.stringify(actualDirectories) !== JSON.stringify(expectedSorted)) {
    context.fail(
      `发行 plugins/ 目录不完整：期望 ${expectedSorted.join('、')}；实际 ${actualDirectories.join('、')}。`,
    )
  }

  for (const distribution of sourceCatalog.distributions) {
    const directory = packageDirectoryName(distribution.name)
    const target = join(mediaRoot, directory)
    const source = join(context.root, ...distribution.source.split('/'))
    const sourceManifest = readJson(context, join(source, 'package.json'), `${distribution.name} 源码 package.json`)
    const catalogEntry = releaseCatalog.plugins.find(plugin => plugin.name === distribution.name)
    if (
      catalogEntry === undefined
      || catalogEntry.directory !== directory
      || catalogEntry.version !== sourceManifest.version
      || JSON.stringify(catalogEntry.components) !== JSON.stringify(distribution.components)
    ) {
      context.fail(`plugins/catalog.json 中 ${distribution.name} 的版本、目录或组件清单不正确。`)
    }
    checkDistributionPackage(context, source, target, distribution.name)

    for (const component of distribution.components) {
      if (component.name === distribution.name) continue
      checkDistributionPackage(
        context,
        componentSource(context, component.name),
        join(target, 'node_modules', ...component.name.split('/')),
        `${distribution.name} -> ${component.name}`,
      )
    }
  }
}
/** 运行包内各入口的版本或帮助检查，验证依赖树能完成解析。 */
export function smokeTestPackage(context) {
  for (const entry of context.runtimeEntries) {
    context.say(`自检 node ${entry.path} ${entry.check.join(' ')}`)
    const result = spawnSync(context.execPath, [entry.path, ...entry.check], {
      cwd: context.packageDir,
      encoding: 'utf8',
    })
    if (result.error !== undefined) {
      context.fail(`自检 ${entry.label} 启动失败：${result.error.message}`)
    }
    if (result.status === 0) continue
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-12)
    context.fail(
      `包里的 ${entry.label}（${entry.path}）跑不起来，退出码 ${result.status ?? 'null'}。`,
      `依赖树不自洽，这个包是废的，不会写出 zip。它自己的输出：\n       ${output.join('\n       ')}`,
    )
  }
}
