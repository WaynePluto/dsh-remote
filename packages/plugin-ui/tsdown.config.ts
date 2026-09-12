import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  dts: true,
  clean: true,
  // React 由 dsh 的冻结浏览器模块表提供；这个包只在插件构建期被内联。
  deps: { neverBundle: ['react', 'react/jsx-runtime'] },
  outExtensions: () => ({ js: '.js' }),
})
