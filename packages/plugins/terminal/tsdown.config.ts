import { defineConfig } from 'tsdown'

/** Package name, as the browser module table keys this plugin's factory. */
const ID = '@dsh-remote/dsh-plugin-terminal'

/**
 * Specifiers the dsh page shares into its frozen module table
 * (`packages/client/web/src/platform.ts` → `PLATFORM_MODULES`). Only these may
 * stay imports in the browser bundle; anything else must be inlined or the
 * loader throws at boot.
 */
const MODULE_TABLE = ['react', 'react/jsx-runtime']

export default defineConfig([
  // Host half: the module dsh-overlay.yml inserts.
  //
  // Everything under @deepseek-ai stays external so this plugin talks to the
  // exact service instances dsh is running. That matters more here than in the
  // sibling plugins: this one MOUNTS three dsh packages with `ctx.plugin()`, so
  // a bundled second copy of `dsh-terminal` would publish a `ctx.terminals`
  // whose `Service` base class is not the one dsh's own loader knows.
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
  // Browser half: the artifact shape dsh's client module loader requires,
  // reproduced from `packages/client/tsdown.client.ts` (`clientBundle`).
  {
    name: `${ID}/client`,
    entry: { client: 'src/client/index.tsx' },
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    dts: false,
    // clean would wipe the host artifact emitted by the config above.
    clean: false,
    deps: {
      neverBundle: MODULE_TABLE,
      alwaysBundle: (specifier: string) => !MODULE_TABLE.includes(specifier),
    },
    // React reads this; a CJS bundle carries no import.meta to fold it from.
    define: { 'process.env.NODE_ENV': JSON.stringify('production') },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
