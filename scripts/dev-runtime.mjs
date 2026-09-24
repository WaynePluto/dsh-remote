import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const root = fileURLToPath(new URL('..', import.meta.url))
const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const launcherManifest = JSON.parse(readFileSync(join(root, 'packages', 'launcher', 'package.json'), 'utf8'))
const runtimeDependencies = Object.fromEntries(Object.entries(launcherManifest.dependencies)
  .filter(([name]) => !name.startsWith('@dsh-station/') || name === '@dsh-station/plugin-ui')
  .map(([name, version]) => [
    name,
    name === '@dsh-station/plugin-ui' ? `file:${join(root, 'packages', 'plugin-ui')}` : version,
  ]))
const workspace = parseYaml(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))
if (workspace.overrides !== undefined) {
  throw new Error('pnpm-workspace.yaml 不应另设 overrides；统一维护根 package.json 的 pnpm.overrides。')
}
const overrides = rootManifest.pnpm?.overrides
if (overrides === undefined || Object.keys(overrides).length === 0) {
  throw new Error('根 package.json 缺少 pnpm.overrides，无法准备一致的 dsh 开发运行时。')
}
const lockedOverrides = parseYaml(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).overrides ?? {}
const drift = [...new Set([...Object.keys(overrides), ...Object.keys(lockedOverrides)])]
  .filter(name => overrides[name] !== lockedOverrides[name])
if (drift.length > 0) {
  throw new Error(`pnpm-lock.yaml 的 overrides 与根 package.json 不一致：${drift.join('、')}；先运行 pnpm install。`)
}
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
    name: 'dsh-station-development-runtime',
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
console.log(`[dsh-station] 开发运行时：${runtime}`)
