import { defineConfig } from 'tsdown'
import { createPluginBuildConfig } from '../../plugin-build/index.mjs'

/** 简洁模式预设配置包只生成宿主入口，不生成普通插件的浏览器半。 */
export default defineConfig(
  createPluginBuildConfig({
    id: '@dsh-remote/dsh-plugin-concise-mode',
    entry: ['src/index.ts'],
    hostDeps: {},
    client: false,
    hostName: false,
  }),
)
