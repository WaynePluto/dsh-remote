import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // workspace 内部包直接打进产物，绿色包的 node_modules 里不需要它们
  deps: { alwaysBundle: [/^@dsh-remote\//] },
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
})
