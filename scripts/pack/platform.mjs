import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'

/** 按 npm 的白名单或黑名单语义判断字段是否允许目标值。 */
export function fieldAllows(values, actual) {
  if (!Array.isArray(values) || values.length === 0) return true
  const denied = values.filter(value => value.startsWith('!')).map(value => value.slice(1))
  if (denied.length !== 0) return !denied.includes(actual)
  return values.includes(actual)
}

export function packageMatchesTarget(manifest, target) {
  if (!fieldAllows(manifest.os, target.platform)) return false
  if (!fieldAllows(manifest.cpu, target.arch)) return false
  if (target.platform === 'linux' && !fieldAllows(manifest.libc, 'glibc')) return false
  return true
}

/** 删除 node_modules 中不属于目标的平台包及按目录保存的预编译产物。 */
export function pruneToTarget(context, target) {
  const removed = []

  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const full = join(directory, entry.name)
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
        // 无法读取的 manifest 按平台无关处理，宁可多带也不误删。
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

  visit(join(context.packageDir, 'node_modules'))

  const keepDirectory = `${target.platform}-${target.arch}`
  for (const relative of context.prebuildDirectories) {
    const directory = join(context.packageDir, ...relative.split('/'))
    if (!existsSync(directory)) continue
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === keepDirectory) continue
      rmSync(join(directory, entry.name), { recursive: true, force: true })
      removed.push(`${relative}/${entry.name}`)
    }
  }

  return removed
}

/** 检查部署树中是否已安装目标平台的 sentinel。 */
export function targetBinariesPresent(context, target) {
  return existsSync(join(context.packageDir, 'node_modules', ...target.sentinel.split('/')))
}

/** 在部署前快速检查本地虚拟 store，无法判断布局时交给部署后检查。 */
export function storeHasTarget(context, target) {
  if (existsSync(join(context.root, 'node_modules', ...target.sentinel.split('/')))) return true
  const store = join(context.root, 'node_modules/.pnpm')
  if (!existsSync(store)) return true
  const wanted = `${target.sentinel.replace('/', '+')}@`
  const entries = readdirSync(store, { withFileTypes: true }).filter(entry => entry.isDirectory())
  if (entries.length === 0) return true
  return entries.some(entry => entry.name.startsWith(wanted))
}

/** 确认裁剪后目标 sentinel 和 node-pty 目录均只保留目标平台。 */
export function checkPrunedTree(context, targetKey, target) {
  if (!targetBinariesPresent(context, target)) {
    context.fail(
      `裁剪后找不到 ${target.sentinel}，${targetKey} 的原生二进制根本不在这棵树里。`,
      '这个包到了目标机器上会在 dsh 加载原生模块时炸，所以不写 zip。',
    )
  }
  const remainingForeign = Object.entries(context.targets)
    .filter(([key]) => key !== targetKey)
    .map(([, other]) => other.sentinel)
    .filter(sentinel => existsSync(join(context.packageDir, 'node_modules', ...sentinel.split('/'))))
  if (remainingForeign.length !== 0) {
    context.fail(
      `裁剪没有生效，包里还剩着别的平台的二进制：${remainingForeign.join('、')}`,
      'pruneToTarget 按 package.json 的 os/cpu 字段删，这几个包可能改了声明方式。',
    )
  }
  const keepDirectory = `${target.platform}-${target.arch}`
  for (const relative of context.prebuildDirectories) {
    const directory = join(context.packageDir, ...relative.split('/'))
    if (!existsSync(directory)) continue
    const left = readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
    if (!left.includes(keepDirectory)) {
      context.fail(`${relative} 里没有 ${keepDirectory}，这个平台的 node-pty 预编译产物缺了。`)
    }
    const extra = left.filter(name => name !== keepDirectory)
    if (extra.length !== 0) context.fail(`${relative} 里还剩着别的平台：${extra.join('、')}`)
  }
}
