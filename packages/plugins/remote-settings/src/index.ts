import type { Context } from '@deepseek-ai/cordis'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { CHANNEL } from './shared.js'
import { presetDirectoryRequest } from './windows-open-request.js'
import { dispatchWorkspaceDirectory } from './workspace-directory.js'

// 保留拆分前的插件身份；Windows 目录打开兼容不改变目标机语义。
export const name = 'dsh-remote-remote-privileged'
export const inject = ['webServer', 'connection', 'agentPresets', 'settingsController']
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

export function transportInjection(): IndexInjection {
  return { kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } }
}

export function installWindowsOpenCompatibility(
  ctx: Context, platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== 'win32') return
  ctx.on('connection/request', (req, res, next) => presetDirectoryRequest(ctx, req, res, next))
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
