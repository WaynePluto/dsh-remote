import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isBuiltin } from 'node:module'

/** dsh 页面冻结模块表中所有插件都可以共享的基础模块。 */
export const DEFAULT_CLIENT_MODULE_TABLE = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
]

/**
 * 允许清单条目：字符串精确匹配（含 entry 的子路径）、正则 test 或谓词函数。
 * tsdown 会把 package.json 里声明的 dependencies 默认外部化，由绿色包的
 * node_modules 在运行时提供，所以宿主清单要并入这些声明依赖。
 */
function isAllowedExternal(id, allowed) {
  return allowed.some((entry) => {
    if (typeof entry === 'string') return id === entry || id.startsWith(`${entry}/`)
    if (typeof entry === 'function') return entry(id)
    if (entry instanceof RegExp) return entry.test(id)
    return false
  })
}

/** 从 cwd 向上找最近的 package.json，取其 dependencies 的键。构建时 cwd 就是插件包根。 */
function declaredRuntimeDependencies() {
  let dir = process.cwd()
  for (;;) {
    const file = join(dir, 'package.json')
    if (existsSync(file)) {
      try {
        return Object.keys(JSON.parse(readFileSync(file, 'utf8')).dependencies ?? {})
      } catch {
        return []
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return []
    dir = parent
  }
}

/**
 * 模块图里的裸包名 id 就是外部化模块：被打进 bundle 的模块 id 一定是解析后的
 * 文件路径或 \0 虚拟模块。相对/绝对路径、Windows 盘符、UNC 与含冒号的
 * 非 node 协议 id（如 rolldown:runtime）都不算包名。
 */
function isBarePackageSpecifier(id) {
  if (id.startsWith('.') || id.startsWith('/') || id.startsWith('\\') || id.startsWith('\0')) return false
  if (/^[A-Za-z]:[\\/]/.test(id)) return false
  if (id.includes('\\')) return false
  return true
}

/**
 * 把“解析失败被当成外部依赖”的静默漂移变成构建错误。
 *
 * rolldown 解析不到裸包名时只给一条 UNRESOLVED_IMPORT warning 就外部化：
 * 浏览器产物会 require 页面冻结模块表之外的模块，宿主产物会依赖一个
 * 没进绿色包的模块，都要拖到线上才炸。这里在 generateBundle 时核对模块图里的
 * 裸包名：客户端只放行 neverBundle 模块表；宿主另放行 node 内建与
 * package.json 声明的 dependencies（tsdown 默认外部化它们，运行时由
 * 绿色包 node_modules 提供），其余一律 this.error。
 */
export function createExternalDriftGuard(label, allowed, { allowNodeBuiltins = false } = {}) {
  return {
    name: `dsh-station-external-drift/${label}`,
    generateBundle() {
      const offenders = new Set()
      for (const id of this.getModuleIds()) {
        if (!isBarePackageSpecifier(id)) continue
        if (!id.includes(':')) {
          if (allowNodeBuiltins && isBuiltin(id)) continue
        } else if (id.startsWith('node:')) {
          if (allowNodeBuiltins) continue
        } else {
          continue
        }
        if (isAllowedExternal(id, allowed)) continue
        offenders.add(id)
      }
      if (offenders.size > 0) {
        const list = [...offenders].join('、')
        this.error(
          `${label} 把 ${list} 留成了外部依赖，但它们不在 neverBundle 清单里；`
          + '通常是 workspace 依赖没有 pnpm install 出链接或依赖未声明，宿主会缺包、浏览器会引用页面模块表之外的模块。',
        )
      }
    },
  }
}

function createHostConfig(options) {
  const hostOptions = options.hostOptions ?? {}
  const hostName = options.hostName === false ? undefined : options.hostName ?? `${options.id}/host`
  const host = {
    ...hostOptions,
    ...(hostName === undefined ? {} : { name: hostName }),
    entry: options.entry,
    format: hostOptions.format ?? 'esm',
    platform: hostOptions.platform ?? 'node',
    target: hostOptions.target ?? 'node22',
    deps: options.hostDeps,
    dts: hostOptions.dts ?? false,
    clean: hostOptions.clean ?? true,
    outExtensions: hostOptions.outExtensions ?? (() => ({ js: '.js' })),
    plugins: [
      ...(hostOptions.plugins ?? []),
      createExternalDriftGuard(
        hostName ?? options.id,
        [...(options.hostDeps?.neverBundle ?? []), ...declaredRuntimeDependencies()],
        { allowNodeBuiltins: true },
      ),
    ],
  }
  return host
}

/** 按包的显式边界生成宿主配置，必要时追加浏览器配置。 */
export function createPluginBuildConfig(options) {
  const host = createHostConfig(options)
  if (!options.client) return host

  const clientOptions = options.clientOptions ?? {}
  const moduleTable = options.clientModuleTable ?? DEFAULT_CLIENT_MODULE_TABLE
  const clientDeps =
    options.clientDeps ?? {
      neverBundle: [...moduleTable],
      alwaysBundle: (specifier) => !moduleTable.includes(specifier),
    }

  return [
    host,
    {
      ...clientOptions,
      name: `${options.id}/client`,
      entry: options.clientEntry,
      format: clientOptions.format ?? 'cjs',
      platform: clientOptions.platform ?? 'browser',
      target: clientOptions.target ?? 'es2022',
      dts: clientOptions.dts ?? false,
      clean: clientOptions.clean ?? false,
      deps: clientDeps,
      define: {
        'process.env.NODE_ENV': JSON.stringify('production'),
        ...clientOptions.define,
      },
      plugins: [
        ...(clientOptions.plugins ?? []),
        createExternalDriftGuard(`${options.id}/client`, clientDeps.neverBundle ?? []),
      ],
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}
