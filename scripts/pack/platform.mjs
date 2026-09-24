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

/** 收集 node_modules 里名字匹配任一模式的包（含嵌套 node_modules），返回包名与目录。 */
function listMatchingPackages(context, patterns) {
  const matches = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const full = join(directory, entry.name)
      if (entry.name.startsWith('@')) {
        visit(full)
        continue
      }
      const manifestPath = join(full, 'package.json')
      if (!existsSync(manifestPath)) continue
      let name
      try {
        name = JSON.parse(readFileSync(manifestPath, 'utf8')).name ?? entry.name
      } catch {
        continue
      }
      if (patterns.some(pattern => pattern.test(name))) matches.push({ name, directory: full })
      const nested = join(full, 'node_modules')
      if (existsSync(nested)) visit(nested)
    }
  }
  visit(join(context.packageDir, 'node_modules'))
  return matches
}

/** 变体裁剪：删除名字命中变体排除清单的包，返回被删包名（去重）。 */
export function pruneToVariant(context, variant) {
  const matches = listMatchingPackages(context, variant.excludes)
  for (const { directory } of matches) rmSync(directory, { recursive: true, force: true })
  return [...new Set(matches.map(match => match.name))]
}

/** 变体验收：full 必须真的带着引擎类重组件，lite 必须一个不剩。 */
export function checkVariantTree(context, variantKey, variant) {
  if (variant.excludes.length === 0) {
    const engines = listMatchingPackages(context, context.heavyEnginePackages)
    if (engines.length === 0) {
      context.fail(
        `${variantKey} 变体里没有找到任何引擎类重组件，full 与 lite 就没有区别了。`,
        '上游改名或调整结构时更新 manifest.mjs 的 HEAVY_ENGINE_PACKAGES。',
      )
    }
    return
  }
  const remaining = listMatchingPackages(context, variant.excludes)
  if (remaining.length !== 0) {
    context.fail(
      `${variantKey} 变体裁剪没有生效，包里还剩：${[...new Set(remaining.map(match => match.name))].join('、')}`,
      'pruneToVariant 按 package.json 的 name 字段删，这几个包可能改了包名。',
    )
  }
}
