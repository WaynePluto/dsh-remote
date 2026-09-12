import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Menu, writeClipboard } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './locales.js'
import { absolutePathOf } from './treePath.js'

export interface ContextMenuTarget {
  readonly path: string
  readonly x: number
  readonly y: number
  readonly focus: HTMLButtonElement | null
}

export interface FileContextMenuProps {
  readonly target: ContextMenuTarget | undefined
  readonly workspaceRoot: string | undefined
  readonly t: Translate
  readonly onClose: () => void
}

/** Find a native tree row without mistaking the path header for a row. */
export function contextMenuRow(target: EventTarget | null): HTMLElement | undefined {
  if (!(target instanceof Element)) return undefined
  const row = target.closest<HTMLElement>('[data-files-entry][data-files-path]')
  return row?.dataset.filesPath === undefined ? undefined : row
}

/** The two read-only operations kept from the former files view. */
export function FileContextMenu({ target, workspaceRoot, t, onClose }: FileContextMenuProps): ReactNode {
  const [failure, setFailure] = useState<string | undefined>()
  const restoreFocus = useRef(false)

  useEffect(() => {
    setFailure(undefined)
    restoreFocus.current = false
    if (target === undefined) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') restoreFocus.current = true
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true) }
  }, [target])

  useEffect(() => {
    if (target === undefined) return undefined
    const frame = requestAnimationFrame(() => {
      const menus = [...document.querySelectorAll<HTMLElement>('[role="menu"]')]
      menus.at(-1)?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => { cancelAnimationFrame(frame) }
  }, [target])

  const close = useCallback((): void => {
    const shouldRestore = restoreFocus.current
    onClose()
    if (!shouldRestore) return
    const button = target?.focus
    if (button?.isConnected === true) {
      requestAnimationFrame(() => {
        if (button.isConnected) button.focus()
      })
    }
  }, [onClose, target])

  const select = useCallback(async (id: string): Promise<void> => {
    const current = target
    const root = workspaceRoot
    if (current === undefined || root === undefined) return
    const relative = current.path
    const value = id === 'copy-path' ? absolutePathOf(root, relative) : relative
    if (await writeClipboard(value)) {
      setFailure(undefined)
      restoreFocus.current = true
      close()
    } else {
      setFailure(t('copyFailed'))
    }
  }, [close, t, target, workspaceRoot])

  if (target === undefined || workspaceRoot === undefined) return null
  return (
    <Menu
      open
      portal
      compact
      autoFocus
      anchor={<span aria-hidden="true" />}
      getAnchorRect={() => new DOMRect(target.x, target.y, 0, 0)}
      items={[
        { id: 'copy-path', label: t('copyPath') },
        { id: 'copy-relative-path', label: t('copyRelativePath') },
      ]}
      {...failure === undefined ? {} : { footer: [{ type: 'label' as const, id: 'copy-failure', text: failure }] }}
      onSelect={id => { void select(id) }}
      onClose={close}
    />
  )
}
