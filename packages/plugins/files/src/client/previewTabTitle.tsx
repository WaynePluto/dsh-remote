import { useEffect, useLayoutEffect, useSyncExternalStore, type ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarRightTabInfo, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { ImageZoomOverlay, type ImageZoomStore } from './imageZoomOverlay.js'
import type { PreviewTabs } from './previewTabs.js'
import type { Translate } from './locales.js'

export const TEXT_PREVIEW_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview'
export const TITLE_SLOT = 'sidebar.right.pane.tab.title'

type NativeTitle = (props: Record<string, unknown>) => ReactNode

function isTemporaryTitle(manager: PreviewTabs, tabId: TabId): boolean {
  return manager.isTemporary(tabId)
}

function enhancedTitle(manager: PreviewTabs, entry: StoredEntry, imageStates: ImageZoomStore, translate: Translate): NativeTitle {
  const NativeTitle = entry.component as NativeTitle
  return function EnhancedTitle(rawProps: Record<string, unknown>): ReactNode {
    const props = rawProps as { readonly useTabInfo: () => SidebarRightTabInfo }
    const info = props.useTabInfo()
    const { tab } = info
    const temporary = useSyncExternalStore(
      listener => manager.subscribe(listener),
      () => isTemporaryTitle(manager, tab.id),
      () => false,
    )

    useLayoutEffect(() => {
      manager.observe(info)
    }, [manager, tab.contentId, tab.id, info.panel.id, tab.actions, tab.signal])
    useEffect(() => () => { manager.unobserve(tab.id, tab.signal) }, [manager, tab.id, tab.signal])

    const native = <NativeTitle {...rawProps} />
    const sessionId = sessionIdOfTitle(tab.contentId)
    if (sessionId === undefined) return native
    return (
      <>
        <span
          className={temporary ? 'dsh-files-preview-tab-title dsh-files-preview-tab-title-temporary' : 'dsh-files-preview-tab-title'}
          data-files-preview-tab-title={tab.id}
          data-files-preview-temporary={temporary || undefined}
          onDoubleClick={event => {
            event.preventDefault()
            event.stopPropagation()
            manager.confirm(sessionId, info.panel.id, tab.contentId)
          }}
        >
          {native}
        </span>
        <ImageZoomOverlay
          tabId={tab.id}
          paneId={info.panel.id}
          address={tab.contentId}
          signal={tab.signal}
          states={imageStates}
          t={translate}
        />
      </>
    )
  }
}

function sessionIdOfTitle(address: string): string | undefined {
  const prefix = 'dsh-resource://file/session/'
  if (!address.startsWith(prefix)) return undefined
  const end = address.search(/[?#]/)
  const encoded = address.slice(prefix.length, end === -1 ? undefined : end).split('/')[0]
  if (encoded === undefined || encoded === '') return undefined
  try { return decodeURIComponent(encoded) } catch { return undefined }
}

function nativeTitleEntry(entries: readonly StoredEntry[]): StoredEntry | undefined {
  return entries.find(entry => entry.options.key === TEXT_PREVIEW_ID && (entry.options.priority ?? 0) >= 0)
}

function registerWrappedTitle(ctx: Context, entry: StoredEntry, manager: PreviewTabs, imageStates: ImageZoomStore, translate: Translate): () => void {
  const options: Record<string, unknown> = {
    name: TITLE_SLOT,
    key: TEXT_PREVIEW_ID,
    priority: -1,
    ...(entry.locale === undefined ? {} : { locale: entry.locale }),
    ...(entry.store === undefined ? {} : { store: entry.store }),
    ...(entry.inject === undefined ? {} : { inject: entry.inject }),
  }
  const slots = ctx.slots as unknown as {
    register: (options: Record<string, unknown>, component: NativeTitle) => () => void
  }
  return slots.register(options, enhancedTitle(manager, entry, imageStates, translate))
}

/** Shadow only the native text title, keeping its icon/name and tab hook. */
export function installPreviewTitleEnhancement(ctx: Context, manager: PreviewTabs, imageStates: ImageZoomStore, translate: Translate): () => void {
  let native: StoredEntry | undefined
  let disposeWrapped: (() => void) | undefined
  let stopped = false
  const reconcile = (): void => {
    if (stopped) return
    const candidate = nativeTitleEntry(ctx.slots.entries(TITLE_SLOT) as readonly StoredEntry[])
    if (candidate === native) return
    disposeWrapped?.()
    disposeWrapped = undefined
    native = candidate
    if (candidate !== undefined) disposeWrapped = registerWrappedTitle(ctx, candidate, manager, imageStates, translate)
  }
  const disposeSubscription = ctx.slots.subscribe(TITLE_SLOT, reconcile)
  reconcile()
  return () => {
    stopped = true
    disposeSubscription()
    disposeWrapped?.()
    disposeWrapped = undefined
    native = undefined
  }
}
