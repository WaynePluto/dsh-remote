import { defineConfig } from 'tsdown'

/** 包名，浏览器模块表用它作为本插件工厂的 key。 */
const ID = '@dsh-remote/dsh-plugin-skills-inspector'

/**
 * dsh 页面共享进冻结模块表的 specifier
 * （`packages/client/web/src/platform.ts` → `PLATFORM_MODULES`）。
 * 只有这些能在浏览器 bundle 里保持 import，其余必须内联，否则 loader 在 boot 时抛错。
 */
const MODULE_TABLE = ['react', 'react/jsx-runtime']

export default defineConfig([
  // 宿主半：dsh-overlay.yml insert 的那个模块。
  {
    name: `${ID}/host`,
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: [/^@deepseek-ai\//] },
    dts: false,
    clean: true,
    outExtensions: () => ({ js: '.js' }),
  },
  // 浏览器半：dsh 客户端模块加载器要求的产物形状，抄自 `packages/client/tsdown.client.ts`
  // 的 `clientBundle`。
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    // clean 会把上面那个配置产出的宿主产物一起抹掉。
    clean: false,
    deps: {
      neverBundle: MODULE_TABLE,
      alwaysBundle: (specifier: string) => !MODULE_TABLE.includes(specifier),
    },
    // React 会读它；CJS bundle 里没有 import.meta 可折叠。
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
