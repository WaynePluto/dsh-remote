import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node22',
  deps: {
    alwaysBundle: [/^@dsh-station\//],
    // dsh 必须保持不打包：它要以真实的 node_modules 形态存在，
    // profile / 插件机制依赖磁盘上的包目录（见 docs/06-packaging.md §1）
    neverBundle: ['@deepseek-ai/dsh'],
  },
  dts: false,
  clean: true,
  outExtensions: () => ({ js: '.js' }),
})
