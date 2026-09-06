import { defineConfig } from 'tsdown'

/** Package name, as the browser module table keys this plugin's factory. */
const ID = '@dsh-remote/dsh-plugin-turn-retry'

/**
 * Specifiers the dsh page shares into its frozen module table
 * (`packages/client/web/src/platform.ts` → `PLATFORM_MODULES`). Only these may
 * stay imports in the browser bundle; anything else must be inlined or the
 * loader throws at boot.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is on that list, which is what lets
 * this plugin draw its dock card with dsh's own icon set instead of a text
 * glyph that would not match the panels beside it.
 */
const MODULE_TABLE = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']

export default defineConfig([
  // Host half: the module dsh-overlay.yml inserts.
  //
  // Everything under @deepseek-ai stays external so this plugin talks to the
  // exact service instances dsh is running — a second copy of the session,
  // agent, or llm packages baked into this bundle would be a different set of
  // classes than the ones `ctx` hands out.
  //
  // zod is deliberately NOT external: the projection registry only ever calls
  // `.parse()` on the schema we hand it (`ErasedDefinition` in
  // `packages/session/session-projection/src/index.ts`), so a bundled copy is
  // duck-type compatible and this package does not have to track dsh's zod.
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
