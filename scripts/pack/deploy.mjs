import { spawnSync } from 'node:child_process'
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'

/** 读取 JSON；错误处理由入口传入，模块本身不依赖打包入口。 */
export function readJson(context, path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    context.fail(`读不了 ${path}：${error.message}`)
  }
}

/** Windows 需要通过 shell 启动 pnpm.cmd，其他系统直接启动 pnpm。 */
export function pnpmInvocation(platform = process.platform) {
  return platform === 'win32'
    ? { command: 'pnpm.cmd', shell: true }
    : { command: 'pnpm', shell: false }
}

/** 执行子命令；安静模式只在失败时输出最后一段日志。 */
export function run(context, label, invocation, args, options = {}) {
  const { command, shell } = invocation
  const quiet = options.quiet === true
  context.say(`${label}: ${command} ${args.join(' ')}`)
  const started = Date.now()
  const result = spawnSync(command, args, {
    cwd: context.root,
    stdio: quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell,
    ...(quiet ? { encoding: 'utf8' } : {}),
  })
  if (result.error !== undefined) context.fail(`${label} 启动失败：${result.error.message}`)
  if (result.status !== 0) {
    if (quiet) {
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
        .split('\n').map(line => line.trimEnd()).filter(line => line !== '').slice(-40)
      console.error(`\n[pack] ${label} 的输出（尾 ${output.length} 行）：`)
      for (const line of output) console.error(`       ${line}`)
    }
    context.fail(`${label} 失败（退出码 ${result.status ?? 'null'}）。`)
  }
  if (quiet) context.say(`${label}: 完成，用时 ${Math.round((Date.now() - started) / 1000)}s`)
}

/** 只部署 launcher；relay 与 connector 会随它的生产依赖闭包一起进入。 */
export function deployProduction(context, filter, targetRelative) {
  run(context, `deploy ${filter}`, pnpmInvocation(context.platform), [
    'deploy', '--legacy', '--reporter=append-only', '--filter', filter, '--prod', targetRelative,
  ], { quiet: true })
}

/** pnpm deploy 会在工作区包目录留下空壳，下一轮部署前必须清理。 */
export function cleanStrayDeployMirrors(context) {
  const roots = [join(context.root, 'packages'), join(context.root, 'packages', 'plugins')]
  for (const packagesDir of roots) {
    if (!existsSync(packagesDir)) continue
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const mirror = join(packagesDir, entry.name, context.stagingRootSegment)
      if (!existsSync(mirror)) continue
      rmSync(mirror, { recursive: true, force: true })
    }
  }
}

/** 生成兼容 README.txt 救急命令的两个跳转入口。 */
export function writeStubEntries(context) {
  for (const stub of context.stubEntries) {
    writeFileSync(join(context.packageDir, `dist/${stub.name}`), [
      '// 由 scripts/pack.mjs 生成，不要手改，也不要把真正的 bundle 拷到这里来。',
      '// 这里只有一句跳转：实现就地跑在 node_modules 里，只有从那个目录出发，它自己的',
      '// 依赖才解析得对 —— pnpm 可能把某个版本冲突的传递依赖嵌在它下面。',
      '// 留着这个文件是因为 README.txt 把 `node dist/relay.js init` 写成了救急命令。',
      `import '${stub.target}'`,
      '',
    ].join('\n'))
  }
}

/** 写入包根 manifest，使 dist 下的 JavaScript 按 ESM 解析。 */
export function writeRootManifest(directory, launcherManifest) {
  const manifest = {
    name: launcherManifest.name,
    version: launcherManifest.version,
    private: true,
    type: 'module',
    dependencies: launcherManifest.dependencies,
  }
  writeFileSync(join(directory, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
}
