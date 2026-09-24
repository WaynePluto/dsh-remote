import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  deps: { alwaysBundle: [/^@dsh-station\//] },
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
})
