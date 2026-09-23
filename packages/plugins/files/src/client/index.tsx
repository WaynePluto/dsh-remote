import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活 browser half 使用的 locale、slots、session、connection 与 Sidebar merge。
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { FilesEndpoint, FilesSnapshot } from '../shared.js'
import { en, NS, zh, type FilesKey } from './locales.js'
import { ImageZoomStore } from './imageZoomOverlay.js'
import { installNativeFilesEnhancement } from './nativeFilesAdapter.js'
import { installPreviewTitleEnhancement } from './previewTabTitle.js'
import { PreviewTabs } from './previewTabs.js'
import { installTabContextActions } from './tabContextActions.js'
import { installStyles } from './styles.js'

export { en, zh, NS } from './locales.js'
export type { FilesKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { 'dsh-plugin-files': FilesKey }
}

class FilesChannelError extends Error {
  constructor(message: string) { super(message); this.name = 'FilesChannelError' }
}

export const inject = ['slots', 'locale', 'connection', 'sidebarRight']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'files: copy dictionaries')
  ctx.effect(installStyles, 'files: view styles')
  const t = ctx.locale.bind(NS)
  const call = async <T,>(endpoint: FilesEndpoint, payload: object): Promise<T> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new FilesChannelError('no active connection')
    const result = await connection.rpc.call('/files', endpoint, payload)
    if (!result.ok) throw new FilesChannelError(result.error.message)
    return result.value as T
  }
  const loadGit = async (sessionId: SessionId, _signal: AbortSignal): Promise<FilesSnapshot> =>
    await call<FilesSnapshot>('snapshot', { sessionId: String(sessionId) })
  const previewTabs = new PreviewTabs()
  const imageStates = new ImageZoomStore()
  ctx.effect(() => {
    const disposeFiles = installNativeFilesEnhancement(ctx, ctx.sidebarRight, loadGit, t, previewTabs)
    const disposeTitle = installPreviewTitleEnhancement(ctx, previewTabs, imageStates, t)
    const disposeMenu = installTabContextActions(ctx, ctx.sidebarRight, t)
    return () => {
      disposeMenu()
      imageStates.clear()
      disposeTitle()
      disposeFiles()
      previewTabs.dispose()
    }
  }, 'files: native files enhancement')
}
