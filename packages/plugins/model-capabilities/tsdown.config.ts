import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-model-capabilities',
    entry: ['src/index.ts'],
    hostDeps: { neverBundle: [/^@deepseek-ai\//] },
    client: true,
    clientEntry: { client: 'src/client/index.tsx' },
    clientModuleTable: [
      'react',
      'react/jsx-runtime',
      'react-dom',
      '@deepseek-ai/dsh-client-ui-primitives',
    ],
  }),
)
