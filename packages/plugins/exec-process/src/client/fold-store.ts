/**
 * 已展开的「执行过程」fold 状态。默认收起且只存在内存中，按 session、turn 和 segment 保存；页面重新打开后恢复收起，符合 dsh disclosure 的约定。
 * 使用模块级 store 而非 React state，因为转录分页会卸载和重新挂载行。
 */

/** 以 session、turn 和表头 anchor 组成内存 fold key。 */
export function foldKey(sessionId: string, turn: number, anchorSeq: number): string {
  return `${sessionId}\u0000${String(turn)}\u0000${String(anchorSeq)}`
}

/** 可订阅的已展开 fold 集合。 */
export interface FoldStore {
  /** 判断指定 key 的 fold 是否展开。 */
  isOpen(key: string): boolean
  /** 设置指定 key 的展开状态；状态变化时通知订阅者。 */
  setOpen(key: string, open: boolean): void
  /** 订阅 fold 状态变化，并返回取消订阅函数。 */
  subscribe(listener: () => void): () => void
  /** 收起全部 fold 并通知订阅者。 */
  reset(): void
}

/** 创建只存在于当前页面内存中的 fold store。 */
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
