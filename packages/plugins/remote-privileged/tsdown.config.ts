import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // dsh imports this file directly from disk (the overlay names ./dist/index.js),
  // so the build must stay a single dependency-free module.
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
})
