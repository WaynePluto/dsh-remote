import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-station/dsh-plugin-proxy',
    entry: ['src/index.ts'],
    // 官方代理模块必须与 dsh 的 web-fetch 共用模块实例，不能内联副本。
    hostDeps: { neverBundle: [/^@deepseek-ai\//] },
    client: true,
    clientEntry: { client: 'src/client/index.tsx' },
  }),
)
