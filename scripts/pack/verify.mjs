import { spawnSync } from 'node:child_process'
import {
  closeSync,
  existsSync,
  openSync,
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
      '找不到 go 命令，编不出 Windows 的双击入口 dsh-remote.exe。',
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
