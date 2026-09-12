import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-proxy',
    entry: ['src/index.ts'],
    // undici 必须沿用宿主进程的全局分发器注册表，不能内联副本。
    hostDeps: { neverBundle: [/^@deepseek-ai\//, 'undici'] },
    client: true,
    clientEntry: { client: 'src/client/index.tsx' },
  }),
)
