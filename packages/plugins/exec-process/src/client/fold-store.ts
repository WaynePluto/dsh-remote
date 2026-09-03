/**
 * Which「执行过程」folds the reader has opened.
 *
 * Default collapsed, deliberately: the whole point of the row is that a turn
 * with sixty tool calls reads as one line until someone asks for more. The
 * state is per session and per turn, lives only in memory, and is not persisted
 * — reopening the page starts collapsed again, which is the same contract dsh's
 * own disclosure has (`createChatStore` starts with an empty `turnProcesses`
 * list, `packages/client/ui-chat/src/client/stores.ts:34`).
 *
 * A module-level store rather than React state because the rows unmount and
 * remount as the transcript window pages, and a fold that reopened itself on
 * every scroll would be worse than no fold at all.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/fold-store
 */

/**
 * Build the store key for one segment of one turn.
 *
 * The anchor is part of the key because a turn holds one fold per formal
 * message it interrupted itself with, and opening one must not open the rest.
 * @param sessionId - owning session.
 * @param turn - owning turn.
 * @param anchorSeq - the segment header's own anchor.
 * @returns a collision-free store key.
 */
export function foldKey(sessionId: string, turn: number, anchorSeq: number): string {
  return `${sessionId}\u0000${String(turn)}\u0000${String(anchorSeq)}`
}

/** Subscribable set of opened folds. */
export interface FoldStore {
  /**
   * @param key - fold key from {@link foldKey}.
   * @returns whether that fold is currently expanded.
   */
  isOpen(key: string): boolean
  /**
   * @param key - fold key from {@link foldKey}.
   * @param open - the requested state.
   */
  setOpen(key: string, open: boolean): void
  /**
   * @param listener - called after any fold changes.
   * @returns the unsubscribe function.
   */
  subscribe(listener: () => void): () => void
  /** Forget every fold; used when the plugin is unloaded. */
  reset(): void
}

/**
 * Create an in-memory fold store.
 * @returns a fresh store instance.
 */
export function createFoldStore(): FoldStore {
  const open = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  return {
    isOpen: key => open.has(key),
    setOpen: (key, next) => {
      if (next === open.has(key)) return
      if (next) open.add(key)
      else open.delete(key)
      notify()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    reset: () => {
      if (open.size === 0) return
      open.clear()
      notify()
    },
  }
}
