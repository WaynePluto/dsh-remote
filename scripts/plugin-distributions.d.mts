export interface PluginComponentDescriptor {
  readonly name: string
  readonly rowId: string
  readonly toggleable?: boolean
}

export interface GeneratedPluginDistribution {
  readonly name: string
  readonly version: string
  readonly directory: string
  readonly components: readonly PluginComponentDescriptor[]
}

export interface PluginDistributionCatalog {
  readonly schemaVersion: 1
  readonly shell: readonly { readonly name: string, readonly source: string }[]
  readonly distributions: readonly {
    readonly name: string
    readonly source: string
    readonly components: readonly PluginComponentDescriptor[]
  }[]
}

export function readPluginCatalog(root?: string): PluginDistributionCatalog
export function materializePluginDistributions(options?: {
  readonly root?: string
  readonly output?: string
}): { readonly output: string, readonly plugins: readonly GeneratedPluginDistribution[] }
