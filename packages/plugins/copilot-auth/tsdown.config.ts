import { defineConfig } from 'tsdown'

/** Package name, as the browser module table keys this plugin's factory. */
const ID = '@dsh-remote/dsh-plugin-copilot-auth'

/**
 * Specifiers the dsh page shares into its frozen module table
 * (`packages/client/web/src/platform.ts` → `PLATFORM_MODULES`). Only these may
 * stay imports in the browser bundle: the loader answers the factory's
 * `require` from that table alone, so anything else must be inlined or it
 * throws at boot. We deliberately use only the two React entries — no
 * cross-plugin value imports, which dsh's own purity gate forbids anyway.
 */
const MODULE_TABLE = ['react', 'react/jsx-runtime']

export default defineConfig([
  // Host half: the module dsh-overlay.yml inserts. pi-ai stays external so the
  // credential format is the one dsh's own llm-pi-ai reads, from one installed
  // copy rather than a second one baked into this bundle.
  {
    name: `${ID}/host`,
    entry: ['src/index.ts'],
    format: 'esm',
    platform: 'node',
    target: 'node22',
    deps: { neverBundle: [/^@earendil-works\//] },
    dts: false,
    clean: true,
    outExtensions: () => ({ js: '.js' }),
  },
  // Browser half: the artifact shape dsh's client module loader requires,
  // reproduced from `packages/client/tsdown.client.ts` (`clientBundle`), which
  // no published preset exposes. A CJS body wrapped in the loader's
  // registration call, whose `require` is the module table.
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
