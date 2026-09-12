import type { DepsConfig, UserConfig } from 'tsdown'

/** dsh 页面冻结模块表中所有插件都可以共享的基础模块。 */
export declare const DEFAULT_CLIENT_MODULE_TABLE: readonly [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
]

type ConfigOverrides = Partial<
  Pick<UserConfig, 'dts' | 'format' | 'platform' | 'target' | 'clean' | 'outExtensions' | 'define'>
>

type CommonOptions = {
  /** 浏览器模块表和加载器使用的插件标识。 */
  id: string
  /** 宿主入口；各插件必须自己声明，避免工厂猜测包结构。 */
  entry: NonNullable<UserConfig['entry']>
  /** 宿主依赖边界；没有依赖时也由调用方显式传入空对象。 */
  hostDeps: DepsConfig
  /** 宿主侧只允许覆盖确有特殊契约的配置。 */
  hostOptions?: ConfigOverrides
  /** false 表示只有宿主产物，true 表示还生成浏览器产物。 */
  client: boolean
  /** 保留宿主配置名称的少数历史例外；false 表示不写入 name。 */
  hostName?: string | false
}

type HostOnlyOptions = CommonOptions & {
  client: false
  clientEntry?: never
  clientModuleTable?: never
  clientDeps?: never
  clientOptions?: never
}

type ClientOptions = CommonOptions & {
  client: true
  /** 浏览器入口也由各包显式传入，避免误把宿主入口打到浏览器。 */
  clientEntry: NonNullable<UserConfig['entry']>
  /** 需要额外或特殊顺序时传入完整模块表；默认值保持 dsh 的基础表。 */
  clientModuleTable?: readonly string[]
  /** 只有确有特殊边界时才替换默认的浏览器外部依赖规则。 */
  clientDeps?: DepsConfig
  /** 浏览器侧只允许覆盖确有特殊契约的配置。 */
  clientOptions?: ConfigOverrides
}

export declare function createPluginBuildConfig(options: HostOnlyOptions): UserConfig
export declare function createPluginBuildConfig(options: ClientOptions): UserConfig[]
