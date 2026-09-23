import catalog from '../../../plugin-catalog.json' with { type: 'json' }

/** 随 dsh-remote 发行、由 profile 安装和升级的一个 Bundle。 */
export interface PluginComponent {
  readonly name: string
  readonly rowId: string
  /** false 表示该组件与 Bundle 静态覆盖共同构成原子能力，只能停用整个 Bundle。 */
  readonly toggleable?: boolean
}

export interface PluginDistribution {
  readonly name: string
  readonly source: string
  readonly components: readonly PluginComponent[]
}

/** 壳级常驻 overlay，不进入第三方插件生命周期。 */
export interface ShellPlugin {
  readonly name: string
  readonly source: string
}

interface PluginCatalog {
  readonly schemaVersion: 1
  readonly shell: readonly ShellPlugin[]
  readonly distributions: readonly PluginDistribution[]
}

if (catalog.schemaVersion !== 1) throw new Error(`不支持的插件清单版本：${String(catalog.schemaVersion)}`)

/** 插件分组、顺序与源码位置的唯一权威清单。 */
export const PLUGIN_CATALOG: PluginCatalog = { ...catalog, schemaVersion: 1 }

/** 默认安装与配套升级的第三方 Bundle，数组顺序也是默认层序。 */
export const PLUGIN_DISTRIBUTIONS: readonly PluginDistribution[] = PLUGIN_CATALOG.distributions

/** 所有分发 Bundle 的包名。 */
export const DISTRIBUTION_PACKAGE_NAMES: readonly string[] = PLUGIN_DISTRIBUTIONS.map(item => item.name)
