import type { ReactNode } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ISidebarRight, SidebarRightTabMenuOwnerProps, TabId } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Translate } from './locales.js'

const SLOT = 'sidebar.right.tab.menu.item'
const REGISTRATION_ID = 'dsh-remote-files-tab-context-actions'

type MenuProps = PropsRuntime<typeof SLOT>

function paneForTab(tabId: TabId): HTMLElement | undefined {
  if (typeof document === 'undefined') return undefined
  return [...document.querySelectorAll<HTMLElement>('[data-dockkit-pane]')]
    .find(pane => [...pane.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
      .some(tab => tab.dataset.dockkitTab === tabId))
}

function tabIdsInPane(pane: HTMLElement): TabId[] {
  return [...pane.querySelectorAll<HTMLElement>('[data-dockkit-tab]')]
    .map(tab => tab.dataset.dockkitTab as TabId | undefined)
    .filter((tabId): tabId is TabId => tabId !== undefined)
}

function stillInPane(pane: HTMLElement, tabId: TabId): boolean {
  return tabIdsInPane(pane).includes(tabId)
}

function menuButton(
  label: string,
  id: string,
  disabled: boolean,
  onClick: () => void,
): ReactNode {
  return (
    <button
      type="button"
      role="menuitem"
      className="dsh-files-tab-menu-item"
      data-files-tab-menu={id}
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  )
}

function TabContextActions({ tab, dismiss, sidebar, t }: MenuProps & {
  readonly tab: SidebarRightTabMenuOwnerProps['tab']
  readonly dismiss: SidebarRightTabMenuOwnerProps['dismiss']
  readonly sidebar: ISidebarRight
  readonly t: Translate
}): ReactNode {
  const pane = paneForTab(tab.id)
  if (pane === undefined) return null
  const ids = tabIdsInPane(pane)
  const canAct = stillInPane(pane, tab.id)
  const closeMany = (targets: readonly TabId[]): void => {
    if (!canAct || !stillInPane(pane, tab.id)) return
    dismiss()
    for (const target of targets) {
      if (!stillInPane(pane, target)) continue
      try { sidebar.close(target) } catch { /* The pane/session may have gone away between the snapshot and the action. */ }
    }
  }
  return (
    <>
      {menuButton(t('closeOthers'), 'close-others', !canAct || ids.length <= 1, () => {
        closeMany(ids.filter(id => id !== tab.id))
      })}
      {menuButton(t('closeAll'), 'close-all', !canAct || ids.length === 0, () => {
        closeMany(ids)
      })}
    </>
  )
}

/** Register the two pane-local bulk close actions in the native tab menu. */
export function installTabContextActions(ctx: Context, sidebar: ISidebarRight, t: Translate): () => void {
  return ctx.slots.inject(SLOT, () => ctx.slots.register(
    { name: SLOT, id: REGISTRATION_ID },
    (props: MenuProps): ReactNode => {
      const owner = props as unknown as SidebarRightTabMenuOwnerProps
      return <TabContextActions {...props} tab={owner.tab} dismiss={owner.dismiss} sidebar={sidebar} t={t} />
    },
  ))
}
