import { parseFileAddress } from '@deepseek-ai/dsh-util-workspace-path'
import type {
  PaneId, SidebarRightTabActions, SidebarRightTabInfo, TabId,
} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'

export interface PreviewTabObservation {
  readonly sessionId: string
  readonly paneId: PaneId
  readonly tabId: TabId
  readonly contentId: string
  readonly actions: SidebarRightTabActions
  readonly signal: AbortSignal
  readonly temporary: boolean
}

interface PendingPreview {
  readonly address: string
  readonly permanent: boolean
}

function scopeKey(sessionId: string, paneId: PaneId): string {
  return `${sessionId}\u0000${paneId}`
}

/**
 * Owns only the enhancement's preview intent. The Sidebar layout and tab
 * records remain dsh's source of truth; observations arrive from the public
 * title slot and disappear with their tab occurrence.
 */
export class PreviewTabs {
  private readonly byTab = new Map<TabId, PreviewTabObservation>()
  private readonly pending = new Map<string, PendingPreview>()
  private readonly listeners = new Set<() => void>()

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }

  /** Observe a live text tab title and transfer a pending replacement into it. */
  observe(info: SidebarRightTabInfo): void {
    const parsed = parseFileAddress(info.tab.contentId)
    if (parsed?.scope !== 'session') return
    const previous = this.byTab.get(info.tab.id)
    const scope = scopeKey(parsed.sessionId, info.panel.id)
    const pending = this.pending.get(scope)
    let temporary = previous?.temporary ?? false

    // A temporary tab that is moved to another pane must not remain an
    // implicit replacement target. A replacement creates a new tab id, so the
    // old observation is normally absent; this branch protects drag/move.
    if (previous !== undefined && previous.paneId !== info.panel.id && previous.temporary) temporary = false
    if (previous === undefined && pending !== undefined && pending.address === info.tab.contentId) {
      // A native open may reveal an already existing tab instead of creating
      // the pending one. Never turn that pre-existing tab into a preview tab.
      const existing = [...this.byTab.values()].find(entry => entry.contentId === info.tab.contentId && entry.tabId !== info.tab.id)
      temporary = existing === undefined && !pending.permanent
      this.pending.delete(scope)
    }

    const next: PreviewTabObservation = {
      sessionId: parsed.sessionId,
      paneId: info.panel.id,
      tabId: info.tab.id,
      contentId: info.tab.contentId,
      actions: info.tab.actions,
      signal: info.tab.signal,
      temporary,
    }
    const changed = previous === undefined
      || previous.paneId !== next.paneId
      || previous.contentId !== next.contentId
      || previous.temporary !== next.temporary
      || previous.actions !== next.actions
    this.byTab.set(info.tab.id, next)
    if (changed) this.notify()
  }

  /** Remove an observation only if it still belongs to the same occurrence. */
  unobserve(tabId: TabId, signal: AbortSignal): void {
    const current = this.byTab.get(tabId)
    if (current === undefined || current.signal !== signal) return
    this.byTab.delete(tabId)
    this.notify()
  }

  observation(tabId: TabId): PreviewTabObservation | undefined {
    return this.byTab.get(tabId)
  }

  isTemporary(tabId: TabId): boolean {
    return this.byTab.get(tabId)?.temporary === true
  }

  /** Mark a preview tab permanent without navigating or reloading it. */
  confirm(sessionId: string, paneId: PaneId, address: string): void {
    const candidate = [...this.byTab.values()].find(entry => entry.sessionId === sessionId
      && entry.paneId === paneId && entry.contentId === address)
    if (candidate !== undefined) {
      this.pending.delete(scopeKey(sessionId, paneId))
      if (candidate.temporary) {
        this.byTab.set(candidate.tabId, { ...candidate, temporary: false })
        this.notify()
      }
      return
    }
    this.pending.set(scopeKey(sessionId, paneId), { address, permanent: true })
  }

  /**
   * Open a file as a preview in one pane. Existing native tabs stay native;
   * only a tab observed as temporary can be replaced.
   */
  open(
    sessionId: string,
    paneId: PaneId,
    address: string,
    source: () => void,
  ): void {
    const same = [...this.byTab.values()].find(entry => entry.sessionId === sessionId && entry.contentId === address)
    if (same !== undefined) {
      if (same.paneId === paneId && same.temporary) return
      source()
      return
    }

    const temporary = [...this.byTab.values()].find(entry => entry.sessionId === sessionId
      && entry.paneId === paneId && entry.temporary && !entry.signal.aborted)
    const scope = scopeKey(sessionId, paneId)
    const confirmed = this.pending.get(scope)?.address === address && this.pending.get(scope)?.permanent === true
    this.pending.set(scope, { address, permanent: confirmed })
    try {
      if (temporary !== undefined) {
        temporary.actions.openResource(address, { replaceTab: true })
      } else {
        source()
      }
    } catch {
      this.pending.delete(scope)
    }
  }

  dispose(): void {
    this.byTab.clear()
    this.pending.clear()
    this.listeners.clear()
  }
}

/** Read the session id carried by a native file resource address. */
export function sessionIdOfFileAddress(address: string): string | undefined {
  const parsed = parseFileAddress(address)
  return parsed?.scope === 'session' ? parsed.sessionId : undefined
}
