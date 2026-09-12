import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-models-catalog',
    entry: ['src/index.ts'],
    hostDeps: {
      neverBundle: [/^@earendil-works\//, /^@deepseek-ai\//],
    },
    client: true,
    clientEntry: { client: 'src/client/index.tsx' },
  }),
)
