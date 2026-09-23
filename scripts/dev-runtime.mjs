import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcherManifest = JSON.parse(readFileSync(join(root, 'packages', 'launcher', 'package.json'), 'utf8'))
const runtimeDependencies = Object.fromEntries(Object.entries(launcherManifest.dependencies)
  .filter(([name]) => !name.startsWith('@dsh-remote/') || name === '@dsh-remote/plugin-ui')
  .map(([name, version]) => [
    name,
    name === '@dsh-remote/plugin-ui' ? `file:${join(root, 'packages', 'plugin-ui')}` : version,
  ]))
const workspace = parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
const overrides = workspace.overrides ?? {}
const fingerprint = createHash('sha256')
  .update('runtime-schema-4')
  .update(JSON.stringify({ runtimeDependencies, overrides }))
  .digest('hex').slice(0, 16)
// 放在仓库同级目录，避免 dsh 从工作区 node_modules 抢先解析同名插件。
const runtime = join(dirname(root), `.${basename(root)}-runtime`, fingerprint)
const dshBin = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const installAnchor = join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
const pnpmCli = join(runtime, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')

if (!existsSync(dshBin) || !existsSync(installAnchor) || !existsSync(pnpmCli)) {
  const temporary = `${runtime}.${process.pid}.tmp`
  rmSync(temporary, { recursive: true, force: true })
  mkdirSync(temporary, { recursive: true })
  writeFileSync(join(temporary, 'package.json'), `${JSON.stringify({
    name: 'dsh-remote-development-runtime',
    private: true,
    version: '0.0.0',
    dependencies: runtimeDependencies,
    pnpm: { overrides },
  }, undefined, 2)}\n`)
  const sourcePnpm = join(root, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
  const result = spawnSync(process.execPath, [
    sourcePnpm,
    'install',
    '--ignore-workspace',
    '--prod',
    '--ignore-scripts',
    '--dir',
    temporary,
  ], { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`准备隔离 dsh 开发运行时失败（退出码 ${String(result.status)}）`)
  rmSync(runtime, { recursive: true, force: true })
  renameSync(temporary, runtime)
}

const descriptor = { fingerprint, runtime, dshBin, installAnchor, pnpmCli }
mkdirSync(join(root, '.dev'), { recursive: true })
writeFileSync(join(root, '.dev', 'runtime.json'), `${JSON.stringify(descriptor, undefined, 2)}\n`)
console.log(`[dsh-remote] 开发运行时：${runtime}`)
