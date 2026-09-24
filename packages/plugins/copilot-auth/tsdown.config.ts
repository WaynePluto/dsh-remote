import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-station/dsh-plugin-copilot-auth',
    entry: ['src/index.ts'],
    hostDeps: { neverBundle: [/^@earendil-works\//] },
    client: true,
    clientEntry: { client: 'src/client/index.tsx' },
    clientModuleTable: [
      'react',
      'react/jsx-runtime',
      '@deepseek-ai/dsh-client-ui-primitives',
      'react-dom',
    ],
  }),
)
