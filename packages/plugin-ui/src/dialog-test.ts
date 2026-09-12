export interface DialogTestExpect {
  toBe(expected: unknown): void
  toEqual(expected: unknown): void
  toMatchObject(expected: unknown): void
}

export interface DialogTestApi<TDirection extends string> {
  expect: (actual: unknown) => DialogTestExpect
  applyResize: (start: { width: number; bodyHeight: number; offsetX: number; offsetY: number }, direction: TDirection, dx: number, dy: number, bounds: { minWidth: number; maxWidth: number; minBodyHeight: number; maxBodyHeight: number }) => { width: number; bodyHeight: number; offsetX: number; offsetY: number }
  resizeBounds: (start: { width: number; bodyHeight: number; offsetX: number; offsetY: number }, direction: TDirection, rect: { left: number; right: number; top: number; bottom: number }, width: number, height: number) => unknown
  applyMove: (start: { offsetX: number; offsetY: number }, dx: number, dy: number, bounds: unknown) => { offsetX: number; offsetY: number }
  moveBounds: (rect: { left: number; right: number; top: number; bottom: number }, width: number, height: number) => unknown
}

/** 共享 services/turn-retry 的纯几何回归断言，业务适配器只负责提供命名函数。 */
export function assertDialogGeometry<TDirection extends string>(api: DialogTestApi<TDirection>, directions: readonly TDirection[]): void {
  const bounds = { minWidth: 300, maxWidth: 800, minBodyHeight: 110, maxBodyHeight: 600 }
  const start = { width: 500, bodyHeight: 300, offsetX: 10, offsetY: -4 }
  for (const direction of directions) {
    const next = api.applyResize(start, direction, 20, 30, bounds)
    const xSign = direction.includes('e') ? 1 : direction.includes('w') ? -1 : 0
    const ySign = direction.includes('s') ? 1 : direction.includes('n') ? -1 : 0
    api.expect(next.width - start.width).toBe(20 * xSign)
    api.expect(next.bodyHeight - start.bodyHeight).toBe(30 * ySign)
    api.expect(next.offsetX - start.offsetX).toBe(((next.width - start.width) * xSign) / 2)
    api.expect(next.offsetY - start.offsetY).toBe(((next.bodyHeight - start.bodyHeight) * ySign) / 2)
  }
  const clamped = api.applyResize(start, 'se' as TDirection, 1000, 1000, bounds)
  api.expect(clamped).toEqual({ width: 800, bodyHeight: 600, offsetX: 160, offsetY: 146 })
  const position = api.resizeBounds(start, 'se' as TDirection, { left: 100, right: 600, top: 80, bottom: 480 }, 800, 900)
  api.expect(position).toEqual({ minWidth: 300, maxWidth: 676, minBodyHeight: 110, maxBodyHeight: 696 })
  const edge = api.resizeBounds(start, 'se' as TDirection, { left: 276, right: 776, top: 176, bottom: 576 }, 800, 600)
  api.expect(api.applyResize(start, 'se' as TDirection, 100, 100, edge as never)).toEqual(start)
  api.expect(api.applyResize(start, 'se' as TDirection, -100, -100, edge as never)).toEqual({ width: 400, bodyHeight: 200, offsetX: -40, offsetY: -54 })
  const compact = { width: 240, bodyHeight: 80, offsetX: 10, offsetY: -4 }
  const compactEdge = api.resizeBounds(compact, 'se' as TDirection, { left: 236, right: 476, top: 56, bottom: 376 }, 500, 400)
  api.expect(compactEdge).toEqual({ minWidth: 240, maxWidth: 240, minBodyHeight: 80, maxBodyHeight: 80 })
  api.expect(api.applyResize(compact, 'se' as TDirection, 100, 100, compactEdge as never)).toEqual(compact)
  const topEdge = api.resizeBounds(start, 'nw' as TDirection, { left: 24, right: 524, top: 24, bottom: 424 }, 800, 600)
  api.expect(api.applyResize(start, 'nw' as TDirection, -100, -100, topEdge as never)).toEqual(start)
  api.expect(api.applyResize(start, 'nw' as TDirection, 100, 100, topEdge as never)).toEqual({ width: 400, bodyHeight: 200, offsetX: 60, offsetY: 46 })

  const moveBounds = api.moveBounds({ left: 100, right: 600, top: 80, bottom: 480 }, 800, 600)
  api.expect(moveBounds).toEqual({ minDx: -76, maxDx: 176, minDy: -56, maxDy: 96 })
  const moved = api.applyMove({ offsetX: 10, offsetY: -4 }, 1000, -1000, moveBounds)
  api.expect(moved).toEqual({ offsetX: 186, offsetY: -60 })
  const first = api.applyMove({ offsetX: 10, offsetY: -4 }, 30, 20, moveBounds)
  api.expect(first).toEqual({ offsetX: 40, offsetY: 16 })
  const secondBounds = api.moveBounds({ left: 130, right: 630, top: 100, bottom: 500 }, 800, 600)
  api.expect(api.applyMove(first, -50, 40, secondBounds)).toEqual({ offsetX: -10, offsetY: 56 })
}
