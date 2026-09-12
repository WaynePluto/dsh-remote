import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import type { Context } from '@deepseek-ai/cordis'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  ISidebarRight, SidebarRightTabInfo,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { FilesSnapshot } from '../shared.js'
import { contextMenuRow, FileContextMenu, type ContextMenuTarget } from './FileContextMenu.js'
import { clearNativeRows, decorateNativeRows } from './gitDecorations.js'
import { openInPreviewPane, type PreviewPaneRef } from './paneNavigation.js'
import type { PreviewTabs } from './previewTabs.js'
import type { Translate } from './locales.js'
import { workspaceRelativePath } from './treePath.js'

export const NATIVE_FILES_ID = '@deepseek-ai/dsh-client-ui-sidebar-files'
export const FILES_BODY_SLOT = 'sidebar.right.pane.tab'

type NativeComponent = (props: Record<string, unknown>) => ReactNode

export interface GitSnapshotFace {
  readonly load: (signal: AbortSignal) => Promise<FilesSnapshot>
  readonly t: Translate
}

interface NativeEnhancementProps extends Record<string, unknown> {
  readonly useTabInfo: () => SidebarRightTabInfo
  readonly sessionId: SessionId
  readonly useSessions: <Selected>(selector: (state: unknown) => Selected) => Selected
  readonly filesEnhancement: GitSnapshotFace
  readonly previewTabs: PreviewTabs
}

interface SessionStateLike {
  readonly byId?: Record<string, { readonly cwd?: string } | undefined>
}

function cwdOf(
  useSessions: NativeEnhancementProps['useSessions'],
  sessionId: SessionId,
): string | undefined {
  return useSessions((value: unknown) => (value as SessionStateLike).byId?.[sessionId]?.cwd)
}

function rowFromEvent(event: React.SyntheticEvent<HTMLDivElement>): HTMLElement | undefined {
  return contextMenuRow(event.target)
}

/**
 * Build a component which renders the exact native FilesBody with its original
 * store, locale and injected face, adding only an outer event/observation seam.
 */
function enhancedComponent(
  entry: StoredEntry,
  sidebar: ISidebarRight,
): NativeComponent {
  const NativeBody = entry.component as NativeComponent
  return function EnhancedNativeFilesBody(rawProps: Record<string, unknown>): ReactNode {
    const props = rawProps as NativeEnhancementProps
    const tabInfo = props.useTabInfo()
    const { tab } = tabInfo
    const rootRef = useRef<HTMLDivElement | null>(null)
    const paneRef = useRef<PreviewPaneRef>({ current: undefined })
    const gitRevision = useRef(0)
    const [git, setGit] = useState<FilesSnapshot | undefined>()
    const [gitLoading, setGitLoading] = useState(true)
    const [gitFailure, setGitFailure] = useState(false)
    const [contextTarget, setContextTarget] = useState<ContextMenuTarget | undefined>()
    const workspaceRoot = cwdOf(props.useSessions, props.sessionId)
    const face = props.filesEnhancement
    const previewTabs = props.previewTabs
    const refreshGit = useCallback((): void => {
      const revision = ++gitRevision.current
      setGitLoading(true)
      setGitFailure(false)
      void (async () => {
        try {
          const value = await face.load(tab.signal)
          if (tab.signal.aborted || revision !== gitRevision.current) return
          setGit(value)
          setGitLoading(false)
        } catch {
          if (tab.signal.aborted || revision !== gitRevision.current) return
          setGit(undefined)
          setGitFailure(true)
          setGitLoading(false)
        }
      })()
    }, [face, tab.signal])

    useEffect(() => {
      refreshGit()
      return () => {
        gitRevision.current += 1
        const root = rootRef.current
        if (root !== null) clearNativeRows(root)
      }
    }, [refreshGit])

    useEffect(() => {
      const root = rootRef.current
      if (root === null) return undefined
      const decorate = (): void => { decorateNativeRows(root, git, face.t) }
      decorate()
      const observer = typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(decorate)
      observer?.observe(root, { childList: true, subtree: true })
      return () => {
        observer?.disconnect()
        clearNativeRows(root)
      }
    }, [face.t, git])

    const openContextMenu = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
      const row = rowFromEvent(event)
      const absolute = row?.dataset.filesPath
      if (row === undefined || absolute === undefined || workspaceRoot === undefined) return
      event.preventDefault()
      const button = row.querySelector<HTMLButtonElement>('button')
      const relative = workspaceRelativePath(workspaceRoot, absolute)
      if (relative === undefined) return
      setContextTarget({ path: relative, x: event.clientX, y: event.clientY, focus: button })
    }, [workspaceRoot])

    const openContextFromKeyboard = useCallback((event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      const row = rowFromEvent(event)
      const absolute = row?.dataset.filesPath
      if (row === undefined || absolute === undefined || workspaceRoot === undefined) return
      const relative = workspaceRelativePath(workspaceRoot, absolute)
      if (relative === undefined) return
      event.preventDefault()
      const rect = row.querySelector<HTMLButtonElement>('button')?.getBoundingClientRect() ?? row.getBoundingClientRect()
      setContextTarget({ path: relative, x: rect.left + Math.min(rect.width, 16), y: rect.bottom, focus: row.querySelector('button') })
    }, [workspaceRoot])

    const openFile = useCallback((absolute: string, permanent: boolean): void => {
      if (workspaceRoot === undefined) return
      const address = fileAddressFor(props.sessionId, workspaceRoot, absolute)
      const opened = openInPreviewPane(
        sidebar,
        tabInfo,
        props.sessionId,
        workspaceRoot,
        absolute,
        paneRef.current,
        paneId => previewTabs.open(String(props.sessionId), paneId, address, () => {
          tabInfo.tab.actions.openResource(address, { paneId })
        }),
      )
      if (opened && permanent) {
        previewTabs.confirm(String(props.sessionId), paneRef.current.current ?? tabInfo.panel.id, address)
      }
    }, [previewTabs, props.sessionId, sidebar, tabInfo, workspaceRoot])

    const onClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
      const row = rowFromEvent(event)
      if (row?.dataset.filesEntry !== 'file') return
      const absolute = row.dataset.filesPath
      if (absolute === undefined || workspaceRoot === undefined) return
      openFile(absolute, false)
      event.preventDefault()
      event.stopPropagation()
    }, [openFile, workspaceRoot])

    const onDoubleClickCapture = useCallback((event: React.MouseEvent<HTMLDivElement>): void => {
      const row = rowFromEvent(event)
      if (row?.dataset.filesEntry !== 'file') return
      const absolute = row.dataset.filesPath
      if (absolute === undefined || workspaceRoot === undefined) return
      openFile(absolute, true)
      event.preventDefault()
      event.stopPropagation()
    }, [openFile, workspaceRoot])

    const closeContextMenu = useCallback((): void => { setContextTarget(undefined) }, [])
    const native = <NativeBody {...rawProps} />
    return (
      <div
        ref={rootRef}
        className="dsh-files-native-enhancement"
        data-files-enhancement
        onClickCapture={onClickCapture}
        onDoubleClickCapture={onDoubleClickCapture}
        onContextMenu={openContextMenu}
        onKeyDown={openContextFromKeyboard}
        onClick={event => {
          const target = event.target
          if (target instanceof Element && target.closest('[data-files-reload]') !== null) refreshGit()
        }}
      >
        {!gitLoading && (gitFailure || git?.git.available === false) && (
          <div className="dsh-files-native-note" role="status">{face.t('gitUnavailable')}</div>
        )}
        {!gitLoading && git?.git.truncated === true && (
          <div className="dsh-files-native-note" role="status">{face.t('gitTruncated')}</div>
        )}
        {native}
        <FileContextMenu
          target={contextTarget}
          workspaceRoot={workspaceRoot}
          t={face.t}
          onClose={closeContextMenu}
        />
      </div>
    )
  }
}

function nativeInject(
  entry: StoredEntry,
  loadGit: (sessionId: SessionId, signal: AbortSignal) => Promise<FilesSnapshot>,
  translate: Translate,
  previewTabs: PreviewTabs,
): StoredEntry['inject'] {
  const original = entry.inject
  return ((...args: never[]) => {
    const native = original === undefined
      ? {}
      : (original as unknown as (...values: unknown[]) => Record<string, unknown>)(...args as unknown[])
    const sessionId = args[0] as unknown as SessionId
    return {
      ...native,
      filesEnhancement: {
        load: (signal: AbortSignal) => loadGit(sessionId, signal),
        t: translate,
      } satisfies GitSnapshotFace,
      previewTabs,
    }
  }) as StoredEntry['inject']
}

function registerWrappedEntry(
  ctx: Context,
  entry: StoredEntry,
  sidebar: ISidebarRight,
  loadGit: (sessionId: SessionId, signal: AbortSignal) => Promise<FilesSnapshot>,
  translate: Translate,
  previewTabs: PreviewTabs,
): () => void {
  const options: Record<string, unknown> = {
    name: FILES_BODY_SLOT,
    key: NATIVE_FILES_ID,
    priority: -1,
    ...(entry.store === undefined ? {} : { store: entry.store }),
    ...(entry.locale === undefined ? {} : { locale: entry.locale }),
    inject: nativeInject(entry, loadGit, translate, previewTabs),
  }
  const slots = ctx.slots as unknown as {
    register: (options: Record<string, unknown>, component: NativeComponent) => () => void
  }
  return slots.register(options, enhancedComponent(entry, sidebar))
}

/** Find the live builtin body, excluding any extension already installed. */
export function nativeFilesEntry(entries: readonly StoredEntry[]): StoredEntry | undefined {
  return entries.find(entry => entry.options.key === NATIVE_FILES_ID && (entry.options.priority ?? 0) >= 0)
}

/**
 * Install the native body wrapper for the lifetime of the caller's plugin.
 * Reconciles against slot mutations so native HMR/unload does not leave a stale
 * wrapper. The native type definition and title remain untouched.
 */
export function installNativeFilesEnhancement(
  ctx: Context,
  sidebar: ISidebarRight,
  loadGit: (sessionId: SessionId, signal: AbortSignal) => Promise<FilesSnapshot>,
  translate: Translate,
  previewTabs: PreviewTabs,
): () => void {
  let native: StoredEntry | undefined
  let disposeWrapped: (() => void) | undefined
  let stopped = false
  const reconcile = (): void => {
    if (stopped) return
    const candidate = nativeFilesEntry(ctx.slots.entries(FILES_BODY_SLOT) as readonly StoredEntry[])
    if (candidate === native) return
    disposeWrapped?.()
    disposeWrapped = undefined
    native = candidate
    if (candidate !== undefined) {
      disposeWrapped = registerWrappedEntry(ctx, candidate, sidebar, loadGit, translate, previewTabs)
    }
  }
  const disposeSubscription = ctx.slots.subscribe(FILES_BODY_SLOT, reconcile)
  reconcile()
  return () => {
    stopped = true
    disposeSubscription()
    disposeWrapped?.()
    disposeWrapped = undefined
    native = undefined
  }
}
