import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-yolo-mode',
    entry: ['src/index.ts'],
    hostDeps: { neverBundle: [/^@deepseek-ai\//] },
    client: false,
    hostName: '@dsh-remote/dsh-plugin-yolo-mode',
  }),
)
