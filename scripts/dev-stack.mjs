/**
 * `pnpm dev` / dev:desktop 的开发栈入口：先确保隔离 dsh 开发运行时存在，
 * 再装载真正的栈主体（dev-stack-main.mjs）。
 *
 * 两段式的原因：local-config 在模块导入时就读取 `.dev/runtime.json`
 * 定位 dsh 与 pnpm，运行时准备必须发生在那些导入求值之前——所以
 * dev-runtime 是独立子进程，而不是栈内部的调用。dev-runtime 自带
 * 指纹缓存，依赖未变化时只是一次很快的检查。
 *
 * 栈主体导入 TypeScript 源码，需要 tsx 加载器：标准入口（pnpm dev、
 * dev:desktop）都带 `--import tsx` 启动本文件；裸 `node` 调用时在这里
 * 重新拉起自身补上，避免静默的模块解析失败。
 */

import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))

if (!process.execArgv.some(argument => argument.includes('tsx'))) {
  const relayed = spawn(process.execPath, ['--import', 'tsx', import.meta.filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
  })
  const forward = (signal) => relayed.kill(signal)
  process.once('SIGINT', () => forward('SIGINT'))
  process.once('SIGTERM', () => forward('SIGTERM'))
  relayed.once('exit', (exitCode) => process.exit(exitCode ?? 1))
} else {
  const runtime = spawn(process.execPath, [join(root, 'scripts', 'dev-runtime.mjs')], {
    cwd: root,
    stdio: 'inherit',
  })
  const code = await new Promise((resolve) => runtime.once('exit', (exitCode) => resolve(exitCode ?? 1)))
  if (code !== 0) {
    console.error(`\n[dsh-station] 准备开发运行时失败（退出码 ${String(code)}），本地栈未启动。`)
    process.exit(code)
  }

  await import('./dev-stack-main.mjs')
}
