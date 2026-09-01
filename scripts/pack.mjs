/**
 * 打绿色包：产出 release/dsh-remote-<version>-<platform>-<arch>.zip。
 *
 * 用法:
 *   node scripts/pack.mjs                     打本机平台的包（先跑 pnpm -r build）
 *   node scripts/pack.mjs --target=win32-x64  指定目标平台（可重复）
 *   node scripts/pack.mjs --target=all        三个目标都跑一遍
 *   node scripts/pack.mjs --skip-build        复用现有 dist/，调试打包本身时用
 *   node scripts/pack.mjs --skip-exe          这台机器没有 Go，明知故犯地打一个没有
 *                                             dsh-remote.exe 的 Windows 包
 *
 * 产出的目录结构（带 * 的按目标平台取舍，见 TARGETS）：
 *
 *   dsh-remote-<version>/
 *     dsh-remote.exe *                        Windows 的双击入口（托盘程序），由 Go 交叉编译
 *                                           （图标与高 DPI 清单内嵌在 exe 里，不再带 .ico 文件）
 *     start.ps1 *  start.sh *               终端入口，各平台只放自己那个
 *     README.txt  dsh-remote.config.example.json
 *     package.json                          只为声明 "type": "module"
 *     dist/index.js  proxy-bootstrap.js     launcher 本体，deploy 直接放好的
 *     dist/relay.js  connector.js           一行的跳转入口，见 STUB_ENTRIES
 *     node_modules/                         一次解析产出的整棵运行时依赖树
 *       @dsh-remote/relay/dist/cli.js         relay 与 connector 就地运行，
 *       @dsh-remote/connector/dist/cli.js     不拍平到 dist/
 *       @dsh-remote/dsh-plugin-<名字>          dsh 插件：dsh-overlay.yml 与 dist/index.js
 *                                           必须待在一起（overlay 用相对路径引用它）
 *       @deepseek-ai/dsh/                   随包携带的 dsh
 *
 * 为什么每个目标只 deploy 一次：relay 和 connector 都是 launcher 真实的运行时依赖
 * （launcher 把它们 spawn 成子进程），所以一次
 * `pnpm deploy --filter=@dsh-remote/launcher --prod` 就能把三个进程的依赖一起解析
 * 出来。旧做法是分别 deploy launcher 和 relay 再把两棵 node_modules 拍平合并，
 * 它建立在「同一个 lockfile 里同名包只会有一个版本」这个假设上 —— 而这个假设是
 * 错的：pino 要 real-require@0.2.0，thread-stream 要 real-require@1.0.0，扁平的
 * node_modules 放不下两个版本，合并只能报错收场。交给 pnpm 做一次解析，它会把
 * 冲突的那个嵌到 thread-stream/node_modules 底下，谁要哪个版本自然拿到哪个。
 *
 * 由此而来的约束：@dsh-remote/relay 落在 node_modules/@dsh-remote/relay 下，它自己的
 * 依赖可能就嵌在它目录里。把 cli.js 拷到扁平的 dist/ 会让它从错误的位置往上找
 * 依赖，所以两个子进程一律就地运行，launcher 也按这个位置去找它们
 * （packages/launcher/src/relay.ts 与 connector.ts 里的 candidates 列表）。
 *
 * 全仓自己的三个包零原生模块，但 dsh 的依赖带按平台安装的预编译二进制
 * （sharp / koffi / node-addon-require-builtin / ripgrep），所以包必须分平台。
 *
 * 跨平台打包已经解锁：根 package.json 里配了 `pnpm.supportedArchitectures`，一次
 * pnpm install 就把声明的各个平台的二进制都拉进来，再由 pruneToTarget 按包的
 * os/cpu/libc 字段裁到单一目标。当前声明的是 win32/linux/darwin 与 x64/arm64 的组合
 * （libc 只要 glibc），三个发行目标在一台机器上全都能打；代价是开发机 node_modules 变大。
 */

import { spawnSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'
import { ZipArchive } from 'archiver'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PACKAGING = join(ROOT, 'packaging')
const RELEASE = join(ROOT, 'release')

/**
 * 暂存区放在 release/ 下面，因为它已经在 .gitignore 里。
 * 位置不能随便挪：pnpm deploy 的目标路径只能是相对路径（见 deployProduction）。
 */
const STAGING_RELATIVE = 'release/.staging'
/** deploy 留下的空壳都在这一层，cleanStrayDeployMirrors 靠它定位。 */
const STAGING_ROOT_SEGMENT = STAGING_RELATIVE.split('/')[0]
const STAGING = join(ROOT, ...STAGING_RELATIVE.split('/'))
/** 组装出来的包根目录，最终整棵进 zip。 */
const PACKAGE_DIR = join(STAGING, 'package')

/** 三个平台都要的包根文件。 */
const COMMON_PACKAGING_FILES = [
  { name: 'README.txt', mode: 0o644 },
  { name: 'dsh-remote.config.example.json', mode: 0o644 },
]

/** Windows 专属的包根文件。dsh-remote.exe 不在这里，它是现编的；
 *  图标也不在这里，它已经作为资源链进了 exe。 */
const WINDOWS_PACKAGING_FILES = [
  { name: 'start.ps1', mode: 0o644 },
]

/** Linux / macOS 专属的包根文件。 */
const POSIX_PACKAGING_FILES = [
  // 0755：zip 里不带执行位的话，Linux/macOS 用户解压出来只能 sh ./start.sh
  { name: 'start.sh', mode: 0o755 },
]

/** 仓库里必须存在的 packaging/ 文件（三个集合的并）。 */
const ALL_PACKAGING_FILES = [
  ...COMMON_PACKAGING_FILES,
  ...WINDOWS_PACKAGING_FILES,
  ...POSIX_PACKAGING_FILES,
]

/** Windows 双击入口的 Go 源码目录，产物直接编译进包根。 */
const WIN_LAUNCHER_DIR = join(PACKAGING, 'win-launcher')
const WIN_EXECUTABLE = 'dsh-remote.exe'

/**
 * 内嵌资源（COFF 对象文件）：图标 + 高 DPI 应用程序清单。go build 会自动链包目录
 * 下的 *.syso，但文件不在时它只会默默地编出一个顶着默认图标、在高分屏上发糊的 exe，
 * 所以在这里拦。由 packaging/make-icons.mjs 生成后提交。
 */
const WIN_ICON_RESOURCE = 'rsrc_windows_amd64.syso'

/**
 * 支持的发行目标。key 就是文件名里的平台后缀，也是 `--target=` 的取值。
 *
 * `sentinel` 是一个只在该平台安装的包（dsh → sharp 的预编译二进制），用来回答
 * 「这棵依赖树里到底有没有这个平台的二进制」—— 没有就说明这台机器现在打不了
 * 这个包，必须当场拦住（见 targetBinariesPresent）。
 */
const TARGETS = {
  'win32-x64': {
    platform: 'win32',
    arch: 'x64',
    label: 'Windows x64',
    files: [...COMMON_PACKAGING_FILES, ...WINDOWS_PACKAGING_FILES],
    sentinel: '@img/sharp-win32-x64',
  },
  'linux-x64': {
    platform: 'linux',
    arch: 'x64',
    label: 'Linux x64',
    files: [...COMMON_PACKAGING_FILES, ...POSIX_PACKAGING_FILES],
    sentinel: '@img/sharp-linux-x64',
  },
  'darwin-arm64': {
    platform: 'darwin',
    arch: 'arm64',
    label: 'macOS Apple Silicon',
    files: [...COMMON_PACKAGING_FILES, ...POSIX_PACKAGING_FILES],
    sentinel: '@img/sharp-darwin-arm64',
  },
}

/** 本机的 triple。不带 --target 时就打它。 */
const HOST_TARGET = `${process.platform}-${process.arch}`

/**
 * 带预编译二进制的包里，按平台分目录存放的那几个（目录名就是 <platform>-<arch>）。
 * 它们不是独立的 npm 包，没有 os/cpu 字段可读，只能点名裁。
 * 路径相对包根，用 / 分隔。
 */
const PREBUILD_DIRECTORIES = ['node_modules/node-pty/prebuilds']

/**
 * 编出来的 exe 至少该有这么大。一个 stripped 的 Go 空程序（windows/amd64）就接近
 * 2 MB，1 MB 这条线不是在量功能，只是用来识破空文件和写了一半的产物。
 */
const WIN_EXECUTABLE_MIN_BYTES = 1024 * 1024

/**
 * PE 可选头里的 subsystem 取值：2 = Windows GUI。托盘程序必须是它，编成 3（控制台）
 * 的话双击会先弹出一个黑窗口，正是这次改造要消灭的东西。
 */
const WIN_SUBSYSTEM_GUI = 2

/**
 * deploy 之后允许留在包根的目录，其余（源码、测试、工具配置）一律删掉。
 * package.json 不在列表里是因为下面会重写一份。
 */
const KEEP_AT_PACKAGE_ROOT = new Set(['dist', 'node_modules'])

/**
 * 打包前必须已经存在的构建产物。
 *
 * deploy 只是原样复制各个包的 dist/，少了文件它不会抱怨，只会安静地产出一个缺胳膊
 * 少腿的包，所以在这里先拦一道并给出「先 pnpm build」的提示。
 */
const BUILD_ARTIFACTS = [
  'packages/launcher/dist/index.js',
  'packages/launcher/dist/proxy-bootstrap.js',
  'packages/relay/dist/cli.js',
  'packages/connector/dist/cli.js',
  'packages/plugins/remote-privileged/dist/index.js',
]

/**
 * dsh-remote 自己的 dsh 插件，在包里必须存在的文件（相对包根，用 / 分隔）。
 *
 * 它们靠 packages/launcher/package.json 的 workspace 依赖被 deploy 进来，和 relay /
 * connector 一样就地运行。overlay 里的 insert 名字是相对路径 `./dist/index.js`，dsh 会
 * 把它锚定到 overlay 所在目录，所以这两个文件必须待在一起，谁都不能拍平到 dist/。
 * 缺了 launcher 会拒绝启动（resolveDshPluginOverlays），但那是用户解压之后才发现，
 * 所以这里先拦一道。
 */
const DSH_PLUGIN_FILES = [
  'node_modules/@dsh-remote/dsh-plugin-remote-privileged/dsh-overlay.yml',
  'node_modules/@dsh-remote/dsh-plugin-remote-privileged/dist/index.js',
]

/**
 * dist/ 里的跳转入口：文件名 -> 被跳转到的真实入口（相对 dist/，用 / 分隔）。
 *
 * launcher 不走这两个文件，它直接 spawn 上面那个真实入口。留着它们只为了
 * README.txt §4 文档化的救急命令 `node dist/relay.js init` 仍然成立。
 */
const STUB_ENTRIES = [
  { name: 'relay.js', target: '../node_modules/@dsh-remote/relay/dist/cli.js' },
  { name: 'connector.js', target: '../node_modules/@dsh-remote/connector/dist/cli.js' },
]

/**
 * 包里会被真正执行的入口，以及一条能证明「它的依赖解析得到」的自检命令。
 * 路径相对包根，用 / 分隔（Node 在 Windows 上也认正斜杠）。
 */
const RUNTIME_ENTRIES = [
  { label: 'launcher', path: 'dist/index.js', check: ['--version'] },
  { label: 'relay', path: 'node_modules/@dsh-remote/relay/dist/cli.js', check: ['--help'] },
  { label: 'connector', path: 'node_modules/@dsh-remote/connector/dist/cli.js', check: ['--help'] },
  { label: 'relay 跳转入口', path: 'dist/relay.js', check: ['--help'] },
  { label: 'connector 跳转入口', path: 'dist/connector.js', check: ['--help'] },
]

function fail(message, hint) {
  console.error(`\n[pack] ${message}`)
  if (hint !== undefined) console.error(`       ${hint}`)
  console.error('')
  process.exit(1)
}

function say(message) {
  console.log(`[pack] ${message}`)
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    fail(`读不了 ${path}：${error.message}`)
  }
}

/** @param relative - 相对包根的路径，用 / 分隔。 */
function inPackage(relative) {
  return join(PACKAGE_DIR, ...relative.split('/'))
}

/**
 * Windows 上 pnpm 是 pnpm.cmd，而 Node 22 出于 CVE-2024-27980 的考虑不再允许
 * 不带 shell 地 spawn .cmd（直接 EINVAL），所以这里连 shell 一起决定。
 */
function pnpmInvocation() {
  return process.platform === 'win32'
    ? { command: 'pnpm.cmd', shell: true }
    : { command: 'pnpm', shell: false }
}

/**
 * 跑一个子命令。
 *
 * quiet 时把它的 stdout/stderr 接过来，只在失败时把尾巴吐出来。给 pnpm deploy 用：
 * 它的进度行靠 \r 原地重写，而这里的 stdout 往往不是个真 TTY（任务面板、重定向、
 * CI），于是每一帧都变成一行被截断的 `Progress: resolved ...`，把 pack 自己的日志
 * 洗到屏幕外。成功时这些输出一条都不值得看，失败时才值钱。
 * @param {{ quiet?: boolean }} [options] - quiet：吸掉输出，失败时再打印。
 */
function run(label, invocation, args, options = {}) {
  const { command, shell } = invocation
  const quiet = options.quiet === true
  say(`${label}: ${command} ${args.join(' ')}`)
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell,
    ...(quiet ? { encoding: 'utf8' } : {}),
  })
  if (result.error !== undefined) fail(`${label} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    if (quiet) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
        .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-40)
      console.error(`\n[pack] ${label} 的输出（尾 ${output.length} 行）：`)
      for (const line of output) console.error(`       ${line}`)
    }
    fail(`${label} 失败（退出码 ${result.status ?? 'null'}）。`)
  }
  if (quiet) say(`${label}: 完成，用时 ${Math.round((Date.now() - started) / 1000)}s`)
}

/**
 * 用 pnpm deploy 产出只含运行时依赖的 node_modules。
 *
 * 三个坑，改这段之前先读完：
 *  1. pnpm 10 默认拒绝非 injected 的 workspace，必须加 --legacy；
 *  2. --legacy 把目标路径当相对路径 join，给绝对路径会拼成
 *     `D:\repo\C:\Users\...` 然后 ENOENT，所以这里只能传相对路径；
 *  3. 它同时会在被部署的那个包目录下留一个同名空壳，用完得清掉。
 *
 * 输出掉地上（quiet），只在失败时回放；--reporter=append-only 是防守：万一以后
 * 改回不捕获，至少不会再刷出满屏半截的进度行。
 * @param {string} filter - 包名，例如 @dsh-remote/launcher。
 * @param {string} targetRelative - 相对仓库根的目标路径，用 / 分隔。
 */
function deployProduction(filter, targetRelative) {
  run(`deploy ${filter}`, pnpmInvocation(), [
    'deploy', '--legacy', '--reporter=append-only', '--filter', filter, '--prod', targetRelative,
  ], { quiet: true })
}

/** 清掉 deploy 在各个包目录里留下的空壳，别让它们在下一次 deploy 时被复制进产物。 */
function cleanStrayDeployMirrors() {
  const roots = [join(ROOT, 'packages'), join(ROOT, 'packages', 'plugins')]
  for (const packagesDir of roots) {
    if (!existsSync(packagesDir)) continue
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const mirror = join(packagesDir, entry.name, STAGING_ROOT_SEGMENT)
      if (!existsSync(mirror)) continue
      rmSync(mirror, { recursive: true, force: true })
    }
  }
}

/** 写 dist/ 下的跳转入口。 */
function writeStubEntries() {
  for (const stub of STUB_ENTRIES) {
    writeFileSync(inPackage(`dist/${stub.name}`), [
      '// 由 scripts/pack.mjs 生成，不要手改，也不要把真正的 bundle 拷到这里来。',
      '// 这里只有一句跳转：实现就地跑在 node_modules 里，只有从那个目录出发，它自己的',
      '// 依赖才解析得对 —— pnpm 可能把某个版本冲突的传递依赖嵌在它下面。',
      '// 留着这个文件是因为 README.txt 把 `node dist/relay.js init` 写成了救急命令。',
      `import '${stub.target}'`,
      '',
    ].join('\n'))
  }
}

/**
 * 交叉编译 packaging/win-launcher/main.go，产出包根的 dsh-remote.exe。
 *
 * 为什么非要带一个原生 exe：双击 .ps1 在 Windows 上不是运行它而是用编辑器打开它，
 * .lnk 快捷方式会把绝对工作目录写死（用户换个地方解压就废），而 PowerShell 7 并不是
 * 系统自带的。一个几 MB 的 shim 把这三件事一起解决掉。
 *
 * 它现在还多做一件事：双击后常驻通知区域（托盘），把 dsh、控制台、连接器放在一个
 * 图标下面，而不是留一个不能关的黑窗口。想在终端里盯着输出，仍然用 start.ps1。
 *
 * 找不到 go 就直接失败，不静默降级：一个缺了主入口的 Windows 包，用户是看不出来的，
 * 只会在双击的时候发现没有东西可以双击。明知故犯要打没有 exe 的包，用 --skip-exe 明说。
 */
function buildWindowsExecutable() {
  const output = inPackage(WIN_EXECUTABLE)
  say(`交叉编译 ${WIN_EXECUTABLE}（GOOS=windows GOARCH=amd64）`)
  const result = spawnSync('go', ['build', '-ldflags=-s -w -H windowsgui', '-o', output, '.'], {
    cwd: WIN_LAUNCHER_DIR,
    stdio: 'inherit',
    // -s -w 去掉符号表和调试信息：没人会去调试它，省一半体积。
    // -H windowsgui：编成 GUI 子系统，双击不再出现控制台窗口。代价是这个程序从此
    //   没有任何可以打印的地方，所以子进程的输出全部写进日志文件（见 logfile.go）。
    // CGO_ENABLED=0：交叉编译时别去找 C 工具链，这段源码也用不到 cgo。
    env: { ...process.env, GOOS: 'windows', GOARCH: 'amd64', CGO_ENABLED: '0' },
  })
  if (result.error?.code === 'ENOENT') {
    fail(
      '找不到 go 命令，编不出 Windows 的双击入口 dsh-remote.exe。',
      '装一个 Go（https://go.dev/dl/）再打包。确实要发一个没有 exe 的包，就显式加 --skip-exe。',
    )
  }
  if (result.error !== undefined) fail(`go build 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    fail(
      `go build 失败（退出码 ${result.status ?? 'null'}）。`,
      `源码在 ${WIN_LAUNCHER_DIR}，上面是 go 自己的输出。`,
    )
  }
}

/**
 * 读 PE 头，用来回答两个问题：这是不是一个 Windows 可执行文件，它是不是 GUI 子系统。
 *
 * 布局：0x00 是 MZ，0x3c 处的 4 字节指向 PE 签名，签名后 20 字节是 COFF 头，
 * 再往后是可选头 —— subsystem 在可选头偏移 68 处，PE32 和 PE32+ 在这个字段之前的
 * 布局完全一致，所以不必先分辨是哪一种。
 * @param path - exe 路径。
 * @returns 出错原因（reason）或 subsystem 取值。
 */
function readPortableExecutable(path) {
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

/**
 * 证明 dsh-remote.exe 是个真东西。
 *
 * 只看文件在不在拦不住空文件和被杀毒软件截胡的半截产物，所以还要看大小、PE 的 MZ
 * 魔数，以及可选头里的 subsystem：托盘程序必须是 GUI 子系统，否则双击照样弹黑窗口。
 *
 * 旧版这里跑的是 `dsh-remote.exe --version`。现在它用 -H windowsgui 编译，没有控制台，
 * 也就没有输出可等 —— 那样跑一遍等于什么都没验。改成 exe 自带的 --selfcheck：不建
 * 窗口、不启动任何子进程，只把 exe → node → dist/index.js 这条链走一遍，用退出码
 * 回答，细节写到（这里被重定向成管道的）stdout/stderr。这条链是全包最容易断的一环，
 * 能验的时候必须验。执行本身仍不能当门槛：在 Linux 上打包时这是个跑不起来的
 * GOOS=windows 二进制。
 */
function smokeTestWindowsExecutable() {
  const path = inPackage(WIN_EXECUTABLE)
  if (!existsSync(path)) {
    fail(`产物里没有 ${WIN_EXECUTABLE}。`, 'go build 报告成功却没留下文件，这不正常。')
  }
  const bytes = statSync(path).size
  if (bytes < WIN_EXECUTABLE_MIN_BYTES) {
    fail(
      `${WIN_EXECUTABLE} 只有 ${bytes} 字节，不像是编出来的程序。`,
      '删掉它重新打包；也看一眼杀毒软件是不是把文件截了。',
    )
  }
  const pe = readPortableExecutable(path)
  if (pe.subsystem === undefined) {
    fail(`${WIN_EXECUTABLE} 不是 Windows 可执行文件（${pe.reason}）。`, '检查 go build 的 GOOS 是不是被环境覆盖成了别的。')
  }
  if (pe.subsystem !== WIN_SUBSYSTEM_GUI) {
    fail(
      `${WIN_EXECUTABLE} 的 PE subsystem 是 ${pe.subsystem}，不是 GUI（${WIN_SUBSYSTEM_GUI}）。`,
      'go build 的 -ldflags 里少了 -H windowsgui，这样双击会先弹出一个控制台窗口。',
    )
  }
  say(`自检 ${WIN_EXECUTABLE}：${Math.round(bytes / 1024)} KB，PE 头正常，subsystem=GUI`)

  if (process.platform !== 'win32') {
    say(`跳过运行 ${WIN_EXECUTABLE}：当前不是 Windows，跑不了 GOOS=windows 的二进制。`)
    return
  }
  say(`自检 ${WIN_EXECUTABLE} --selfcheck`)
  const result = spawnSync(path, ['--selfcheck'], { cwd: PACKAGE_DIR, encoding: 'utf8' })
  if (result.error !== undefined) fail(`自检 ${WIN_EXECUTABLE} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-12)
    fail(
      `${WIN_EXECUTABLE} --selfcheck 退出码 ${result.status ?? 'null'}。`,
      `双击入口是废的，不会写出 zip。它自己的输出：\n       ${output.join('\n       ')}`,
    )
  }
}

/**
 * 真跑一遍包里的每个入口。
 *
 * zip 打成功什么都证明不了：依赖树错了要等到用户双击时才炸。跑一次
 * --version / --help 会把整个 bundle 的 import 图加载一遍，任何一个模块解析不到
 * 都会当场非零退出，所以这是「这棵树自洽」唯一靠得住的证据。
 */
function smokeTestPackage() {
  for (const entry of RUNTIME_ENTRIES) {
    say(`自检 node ${entry.path} ${entry.check.join(' ')}`)
    const result = spawnSync(process.execPath, [entry.path, ...entry.check], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
    })
    if (result.error !== undefined) {
      fail(`自检 ${entry.label} 启动失败：${result.error.message}`)
    }
    if (result.status === 0) continue
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
      .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-12)
    fail(
      `包里的 ${entry.label}（${entry.path}）跑不起来，退出码 ${result.status ?? 'null'}。`,
      `依赖树不自洽，这个包是废的，不会写出 zip。它自己的输出：\n       ${output.join('\n       ')}`,
    )
  }
}

/**
 * 读包的 os / cpu / libc，回答「它属于这个目标平台吗」。
 *
 * npm 的语义：数组里写白名单（`["win32"]`）或黑名单（`["!win32"]`），不写就是不限。
 * libc 只有 Linux 的包会声明（glibc / musl），其它平台的目标直接忽略这一项。
 */
function fieldAllows(values, actual) {
  if (!Array.isArray(values) || values.length === 0) return true
  const denied = values.filter(value => value.startsWith('!')).map(value => value.slice(1))
  if (denied.length !== 0) return !denied.includes(actual)
  return values.includes(actual)
}

function packageMatchesTarget(manifest, target) {
  if (!fieldAllows(manifest.os, target.platform)) return false
  if (!fieldAllows(manifest.cpu, target.arch)) return false
  if (target.platform === 'linux' && !fieldAllows(manifest.libc, 'glibc')) return false
  return true
}

/**
 * 把 node_modules 里不属于目标平台的包删掉，以及 node-pty 那种按平台分目录的预编译产物。
 *
 * 为什么必须裁：开了 `pnpm.supportedArchitectures` 之后，一棵树里会同时存在三个平台的
 * 预编译二进制，不裁就是一个 130 MB 的通吃包；即使现在没开（只装了本机那一份），
 * 这一步也是稳定的空操作，等于把跨平台能力的开关提前接好。
 *
 * node-pty 的 prebuilds/<platform>-<arch>/ 不是独立的 npm 包，没有 os/cpu 可读，只能点名裁。
 */
function pruneToTarget(target) {
  const removed = []

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(directory, entry.name)
      // .bin / .pnpm 之类不是包目录，跳过。
      if (entry.name.startsWith('.')) continue
      if (entry.name.startsWith('@')) {
        visit(full)
        continue
      }
      const manifestPath = join(full, 'package.json')
      if (!existsSync(manifestPath)) continue
      let manifest
      try {
        manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      } catch {
        // 读不懂就当它不分平台，宁可多带不可误删。
        continue
      }
      if (!packageMatchesTarget(manifest, target)) {
        rmSync(full, { recursive: true, force: true })
        removed.push(manifest.name ?? entry.name)
        continue
      }
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) visit(nested)
    }
  }

  visit(join(PACKAGE_DIR, 'node_modules'))

  const keepDirectory = `${target.platform}-${target.arch}`
  for (const relative of PREBUILD_DIRECTORIES) {
    const directory = inPackage(relative)
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keepDirectory) continue
      rmSync(join(directory, entry.name), { recursive: true, force: true })
      removed.push(`${relative}/${entry.name}`)
    }
  }

  return removed
}

/** 这棵树里有没有这个平台的预编译二进制。没有就说明本机根本没装过它。 */
function targetBinariesPresent(target) {
  return existsSync(inPackage(`node_modules/${target.sentinel}`))
}

/**
 * 证明裁剪真的干净：别的平台的哨兵包一个不剩，预编译目录只剩自己那一个。
 *
 * 多带一份别的平台的二进制不会报错，只会默默地把包胀大；少带了才致命——
 * 两者都只能在这里拦，因为跨平台目标在本机压根跑不起来。
 */
function checkPrunedTree(targetKey, target) {
  if (!targetBinariesPresent(target)) {
    fail(
      `裁剪后找不到 ${target.sentinel}，${targetKey} 的原生二进制根本不在这棵树里。`,
      '这个包到了目标机器上会在 dsh 加载原生模块时炸，所以不写 zip。',
    )
  }
  const foreign = Object.entries(TARGETS)
    .filter(([key]) => key !== targetKey)
    .map(([, other]) => other.sentinel)
    .filter(sentinel => existsSync(inPackage(`node_modules/${sentinel}`)))
  if (foreign.length !== 0) {
    fail(
      `裁剪没有生效，包里还剩着别的平台的二进制：${foreign.join('、')}`,
      'pruneToTarget 按 package.json 的 os/cpu 字段删，这几个包可能改了声明方式。',
    )
  }
  const keepDirectory = `${target.platform}-${target.arch}`
  for (const relative of PREBUILD_DIRECTORIES) {
    const directory = inPackage(relative)
    if (!existsSync(directory)) continue
    const left = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    if (!left.includes(keepDirectory)) {
      fail(`${relative} 里没有 ${keepDirectory}，这个平台的 node-pty 预编译产物缺了。`)
    }
    const extra = left.filter(name => name !== keepDirectory)
    if (extra.length !== 0) fail(`${relative} 里还剩着别的平台：${extra.join('、')}`)
  }
}

function directorySize(directory) {
  let bytes = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) bytes += directorySize(path)
    else if (entry.isFile()) bytes += statSync(path).size
  }
  return bytes
}

function formatSize(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 写包根的 package.json。
 *
 * 不能省：Node 用「最近的 package.json 里的 type」判断 .js 是 ESM 还是 CJS，
 * dist/ 旁边没有这个文件的话，`node dist/index.js` 会直接
 * "Cannot use import statement outside a module"。
 * dependencies 照抄 launcher 的，因为 dsh 的 profile fallback 会遍历依赖闭包。
 */
function writeRootManifest(directory, launcherManifest) {
  const manifest = {
    name: launcherManifest.name,
    version: launcherManifest.version,
    private: true,
    type: 'module',
    dependencies: launcherManifest.dependencies,
  }
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}

/**
 * 写 zip。
 *
 * 逐个文件地加而不是整目录塞进去，是为了精确控制 zip 里的内容和权限位：
 * start.sh 必须带 0755，暂存目录里的其它东西一个都不能混进去。
 */
async function createZip(prefix, output, files, withExecutable) {
  // archiver 8 是纯 ESM，只导出具名的 ZipArchive，没有旧版那个默认工厂函数
  const archive = new ZipArchive({ zlib: { level: 6 } })
  const stream = createWriteStream(output)
  const finished = new Promise((settle, reject) => {
    stream.on('close', settle)
    stream.on('error', reject)
    archive.on('error', reject)
    archive.on('warning', reject)
  })
  archive.pipe(stream)
  for (const file of files) {
    archive.file(join(PACKAGE_DIR, file.name), { name: `${prefix}/${file.name}`, mode: file.mode })
  }
  archive.file(join(PACKAGE_DIR, 'package.json'), { name: `${prefix}/package.json`, mode: 0o644 })
  // Windows 不看权限位，0755 只是为了在 Linux/macOS 上解压出来时不至于是个不可执行的怪文件。
  if (withExecutable) {
    archive.file(inPackage(WIN_EXECUTABLE), { name: `${prefix}/${WIN_EXECUTABLE}`, mode: 0o755 })
  }
  archive.directory(join(PACKAGE_DIR, 'dist'), `${prefix}/dist`)
  // node_modules/.bin 下的脚本在 Linux 上要可执行，Windows 的文件系统给不出这个位。
  archive.directory(join(PACKAGE_DIR, 'node_modules'), `${prefix}/node_modules`, (entry) => {
    if (entry.name.includes('/.bin/')) entry.mode = 0o755
    return entry
  })
  await archive.finalize()
  await finished
  return archive.pointer()
}

const skipBuild = process.argv.includes('--skip-build')
const skipExe = process.argv.includes('--skip-exe')

const launcherManifest = readJson(join(ROOT, 'packages/launcher/package.json'))
const version = launcherManifest.version
if (typeof version !== 'string' || version === '') fail('packages/launcher/package.json 里没有 version。')
const prefix = `dsh-remote-${version}`

const UNLOCK_CROSS_BUILD_HINT =
  '这个目标的平台不在根 package.json 的 `pnpm.supportedArchitectures` 里（现在声明的是\n' +
  '       os: win32/linux/darwin，cpu: x64/arm64，libc: glibc）。把它的 os/cpu 加进邻个字段再\n' +
  '       pnpm install，把该平台的预编译二进制拉下来；代价是开发机 node_modules 变大。\n' +
  '       已经配过了还报这个错，先 pnpm install 一次。'

/**
 * 解析 `--target=`：可重复、可逗号分隔，`all` 展开成全部目标，不给就打本机。
 *
 * lenient：`--target=all` 时，本机打不了的目标告警并跳过（三个都打不了才算失败）；
 * 显式点名的目标打不了则直接硬失败 —— 你要的就是它，静静地不产出比报错更坏。
 */
function resolveRequestedTargets() {
  const known = Object.keys(TARGETS)
  const values = process.argv
    .filter(argument => argument.startsWith('--target='))
    .flatMap(argument => argument.slice('--target='.length).split(','))
    .map(value => value.trim())
    .filter(value => value !== '')

  if (values.length === 0) {
    if (!(HOST_TARGET in TARGETS)) {
      fail(
        `本机是 ${HOST_TARGET}，不在支持的发行目标里（${known.join('、')}）。`,
        '用 --target=<triple> 显式指定一个。',
      )
    }
    return { keys: [HOST_TARGET], lenient: false }
  }
  if (values.includes('all')) return { keys: known, lenient: true }

  const unknown = values.filter(value => !(value in TARGETS))
  if (unknown.length !== 0) {
    fail(`不认识的目标：${unknown.join('、')}`, `可选：${known.join('、')}，或者 all。`)
  }
  return { keys: [...new Set(values)], lenient: false }
}

/**
 * 不跑 deploy 就先回答「本机装没装过这个平台的二进制」，避免为一个注定失败的目标
 * 白白花一分钟复制依赖树。认不出布局时一律弃权（返回 true），交给 deploy 后的
 * checkPrunedTree 去拦 —— 这个预检只为省时间，没资格单独否决一次打包。
 *
 * 两种布局都要认：
 *  1. 默认的虚拟 store，包在 node_modules/.pnpm/<name>@<version> 下；
 *  2. node-linker=hoisted（可能来自用户的全局 pnpm 配置），node_modules 是扁平的，
 *     .pnpm 目录仍然存在但只放着 lock.yaml。只看虚拟 store 会在这里把「装了」
 *     误判成「没装」，然后拒绝打一个本可以打出来的包。
 */
function storeHasTarget(target) {
  if (existsSync(join(ROOT, 'node_modules', ...target.sentinel.split('/')))) return true
  const store = join(ROOT, 'node_modules/.pnpm')
  if (!existsSync(store)) return true
  const wanted = `${target.sentinel.replace('/', '+')}@`
  const entries = readdirSync(store, { withFileTypes: true }).filter(entry => entry.isDirectory())
  // 空的 .pnpm（hoisted 布局的残留）说明这里根本不是虚拟 store，别用它下结论。
  if (entries.length === 0) return true
  return entries.some(entry => entry.name.startsWith(wanted))
}

const { keys: requestedTargets, lenient } = resolveRequestedTargets()

for (const file of ALL_PACKAGING_FILES) {
  if (existsSync(join(PACKAGING, file.name))) continue
  fail(`缺少 packaging/${file.name}。`, '这个仓库不完整，或者文件被误删了。')
}

const needsExecutable = requestedTargets.some(key => TARGETS[key].platform === 'win32') && !skipExe
if (needsExecutable && !existsSync(join(WIN_LAUNCHER_DIR, 'main.go'))) {
  fail('缺少 packaging/win-launcher/main.go。', '这个仓库不完整，或者文件被误删了。')
}
if (needsExecutable && !existsSync(join(WIN_LAUNCHER_DIR, WIN_ICON_RESOURCE))) {
  fail(
    `缺少 packaging/win-launcher/${WIN_ICON_RESOURCE}（exe 的内嵌图标与高 DPI 清单）。`,
    '跑 node packaging/make-icons.mjs 重新生成它；缺了只会得到一个默认图标、高分屏上发糊的 exe，从产物上看不出来。',
  )
}

if (skipBuild) say('跳过构建（--skip-build），直接用现有的 dist/。')
else run('build', pnpmInvocation(), ['-r', 'build'])

const missingArtifacts = BUILD_ARTIFACTS.filter(path => !existsSync(join(ROOT, ...path.split('/'))))
if (missingArtifacts.length !== 0) {
  fail(`缺少构建产物：${missingArtifacts.join('、')}`, '先运行 pnpm build。')
}

mkdirSync(RELEASE, { recursive: true })

/**
 * 打一个目标平台的包。返回 zip 信息；lenient 下本机打不了则返回 undefined。
 *
 * 每个目标都重新 deploy 一次：上一轮的裁剪是就地删文件，没有回头路。
 */
async function buildTarget(key) {
  const target = TARGETS[key]
  const isHost = target.platform === process.platform && target.arch === process.arch
  const withExecutable = target.platform === 'win32' && !skipExe

  console.log('')
  say(`=== 目标 ${key}（${target.label}）===`)

  if (!storeHasTarget(target)) {
    const message = `本机没有装 ${key} 的原生二进制（找不到 ${target.sentinel}），打不了这个包。`
    if (!lenient) fail(message, UNLOCK_CROSS_BUILD_HINT)
    say(`跳过 ${key}：${message}`)
    return undefined
  }

  say('清理暂存目录')
  rmSync(STAGING, { recursive: true, force: true })

  // 一次解析、一棵树。三个进程的依赖都在 launcher 的依赖闭包里，见文件头的说明。
  deployProduction('@dsh-remote/launcher', `${STAGING_RELATIVE}/package`)
  cleanStrayDeployMirrors()

  if (!existsSync(join(PACKAGE_DIR, 'node_modules'))) {
    fail('pnpm deploy 没有产出 node_modules。', '看上面 deploy 的输出；网络不通时 pnpm 无法解析依赖。')
  }

  // deploy 会把 launcher 自己的源码、测试、配置一并复制过来，这些都不该进绿色包；
  // dist/ 是它已经放好的构建产物，留着直接用。
  say('清理 deploy 带过来的源码与配置')
  for (const entry of readdirSync(PACKAGE_DIR, { withFileTypes: true })) {
    if (KEEP_AT_PACKAGE_ROOT.has(entry.name)) continue
    rmSync(join(PACKAGE_DIR, entry.name), { recursive: true, force: true })
  }

  if (!existsSync(join(PACKAGE_DIR, 'node_modules/@deepseek-ai/dsh/lib/bin.js'))) {
    fail('产物里没有随包携带的 dsh（node_modules/@deepseek-ai/dsh/lib/bin.js）。', 'launcher 在运行时会找它，缺了整个包就是废的。')
  }

  const missingPluginFiles = DSH_PLUGIN_FILES.filter(relative => !existsSync(inPackage(relative)))
  if (missingPluginFiles.length !== 0) {
    fail(
      `产物里缺少 dsh 插件文件：${missingPluginFiles.join('、')}`,
      '插件靠 packages/launcher/package.json 里的 workspace 依赖被 deploy 进来；缺了 launcher 会拒绝启动 dsh。',
    )
  }

  say('写 dist/ 下的跳转入口')
  writeStubEntries()

  const missingEntries = RUNTIME_ENTRIES.filter(entry => !existsSync(inPackage(entry.path))).map(entry => entry.path)
  if (missingEntries.length !== 0) {
    fail(
      `产物里缺少可执行入口：${missingEntries.join('、')}`,
      'relay 与 connector 是靠 packages/launcher/package.json 里的 workspace 依赖被 deploy 进来的，别把它们从那里删掉。',
    )
  }

  say(`复制 ${key} 的启动脚本、README 与示例配置`)
  for (const file of target.files) {
    copyFileSync(join(PACKAGING, file.name), join(PACKAGE_DIR, file.name))
  }
  writeRootManifest(PACKAGE_DIR, launcherManifest)

  if (target.platform === 'win32') {
    if (skipExe) say('跳过编译 dsh-remote.exe（--skip-exe）；这个包在 Windows 上只能用 start.ps1 启动。')
    else buildWindowsExecutable()
  }

  // 入口自检全部放在写 zip 之前：不过就什么都不产出，绝不让一个坏包留在 release/ 里。
  // 非本机目标在裁剪前跑：那时树里还有本机的二进制，而 JS 依赖图本身与平台无关，
  // 这是跨平台包能拿到的唯一一次真实执行证据。
  if (!isHost) smokeTestPackage()

  say(`裁剪 node_modules 到 ${key}`)
  const removed = pruneToTarget(target)
  say(`裁掉 ${removed.length} 项不属于 ${key} 的内容`)
  checkPrunedTree(key, target)

  if (isHost) smokeTestPackage()
  else say(`跳过裁剪后的入口自检：${key} 的包在本机（${HOST_TARGET}）跑不了。`)

  if (target.platform === 'win32' && withExecutable) smokeTestWindowsExecutable()

  const treeBytes = directorySize(PACKAGE_DIR)
  say(`打包前目录大小 ${formatSize(treeBytes)}`)

  const output = join(RELEASE, `${prefix}-${key}.zip`)
  rmSync(output, { force: true })
  say(`写入 ${output}`)
  const zipBytes = await createZip(prefix, output, target.files, withExecutable)
  rmSync(STAGING, { recursive: true, force: true })

  const entryHint = target.platform === 'win32'
    ? (withExecutable ? `双击 ${WIN_EXECUTABLE}（常驻通知区域）或 pwsh -File .\\start.ps1` : '用 pwsh -File .\\start.ps1（本次没有打进 dsh-remote.exe）')
    : '跑 ./start.sh'
  return { key, label: target.label, output, zipBytes, entryHint }
}

const built = []
const skipped = []
for (const key of requestedTargets) {
  // 目标必须一个一个打：它们共用同一个暂存目录，并行会互相删文件。
  // oxlint-disable-next-line no-await-in-loop
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
         解压后: ${prefix}/ ，${item.entryHint}`)
}
if (skipped.length !== 0) {
  console.log(`       跳过: ${skipped.join('、')}（本机没有这些平台的原生二进制）
       ${UNLOCK_CROSS_BUILD_HINT}`)
}
console.log('       dsh 的原生依赖按平台安装，别发错平台。\n')

