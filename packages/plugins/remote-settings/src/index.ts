import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { CHANNEL } from './shared.js'
import { dispatchWorkspaceDirectory } from './workspace-directory.js'

// 保留拆分前的插件身份；Windows 目录打开兼容不改变目标机语义。
export const name = 'dsh-remote-remote-privileged'
export const inject = ['webServer', 'connection']
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

export function transportInjection(): IndexInjection {
  return { kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } }
}

export function installWindowsOpenCompatibility(
  ctx: Context, platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return
  // dsh 0.1.7 移除了 settings/openAgentPresetDirectory RPC（预设改为 profile YAML 声明），
  // 预设目录拦截随之删除；这里只保留 Open In… Explorer 的立即返回与置前通道。
  const dispose = ctx.connection.rpc.handle(CHANNEL,
    async (endpoint, payload, signal) => await dispatchWorkspaceDirectory(endpoint, payload, signal))
  ctx.effect(() => () => { void dispose() }, 'remote-settings: visible Windows workspace opener')
}

export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push(transportInjection())
  })
  installWindowsOpenCompatibility(ctx)
}
