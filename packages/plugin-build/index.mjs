/** dsh 页面冻结模块表中所有插件都可以共享的基础模块。 */
export const DEFAULT_CLIENT_MODULE_TABLE = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/dsh-client-ui-primitives',
]

function createHostConfig(options) {
  const hostOptions = options.hostOptions ?? {}
  const host = {
    ...hostOptions,
    ...(options.hostName === false ? {} : { name: options.hostName ?? `${options.id}/host` }),
    entry: options.entry,
    format: hostOptions.format ?? 'esm',
    platform: hostOptions.platform ?? 'node',
    target: hostOptions.target ?? 'node22',
    deps: options.hostDeps,
    dts: hostOptions.dts ?? false,
    clean: hostOptions.clean ?? true,
    outExtensions: hostOptions.outExtensions ?? (() => ({ js: '.js' })),
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
      outputOptions: {
        entryFileNames: 'client.js',
        banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(options.id)}, factory: (require) => {`,
        footer: 'return module.exports; } });',
        intro: 'var module = { exports: {} }; var exports = module.exports;',
      },
    },
  ]
}
