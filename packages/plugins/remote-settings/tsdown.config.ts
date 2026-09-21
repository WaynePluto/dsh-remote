import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-remote-settings',
    entry: ['src/index.ts'],
    hostDeps: {},
    client: false,
    hostName: false,
  }),
)
