import type { CSSProperties } from 'react'

/** 可用于八个边/角的对话框方向。业务插件只负责把它适配到自己的类型名。 */
export const DIALOG_RESIZE_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
export type DialogResizeDirection = (typeof DIALOG_RESIZE_DIRECTIONS)[number]
export type DialogDirection = DialogResizeDirection

/** 几何计算只需要的矩形字段，避免把 DOMRect 带进纯计算接口。 */
export interface DialogRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface DialogResizeStart {
  width: number
  bodyHeight: number
  offsetX: number
  offsetY: number
}

export interface DialogResizeBounds {
  minWidth: number
  maxWidth: number
  minBodyHeight: number
  maxBodyHeight: number
}

export interface DialogResizeResult extends DialogResizeStart {}

export interface DialogMoveStart {
  offsetX: number
  offsetY: number
}

export interface DialogMoveBounds {
  minDx: number
  maxDx: number
  minDy: number
  maxDy: number
}

/** 在上下界顺序不可靠时也保持稳定的数字 clamp。 */
export function clampDialogDimension(value: number, min: number, max: number): number {
  const lower = Math.min(min, max)
  const upper = Math.max(min, max)
  return Math.min(upper, Math.max(lower, value))
}

function directionSign(direction: DialogResizeDirection, axis: 'x' | 'y'): number {
  if (axis === 'x') return direction.includes('e') ? 1 : direction.includes('w') ? -1 : 0
  return direction.includes('s') ? 1 : direction.includes('n') ? -1 : 0
}

/** 按活动边与 viewport 计算 resize 的宽高界限。 */
export function dialogResizeBounds(
  start: DialogResizeStart,
  direction: DialogResizeDirection,
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  rootPaddingPx = 24,
  minWidthPx = 300,
  minBodyHeightPx = 110,
): DialogResizeBounds {
  const availableWidth = Math.max(0, viewportWidth - rootPaddingPx * 2)
  const chromeHeight = Math.max(0, rect.bottom - rect.top - start.bodyHeight)
  const availableBodyHeight = Math.max(0, viewportHeight - rootPaddingPx * 2 - chromeHeight)
  const horizontalRoom = direction.includes('e')
    ? viewportWidth - rootPaddingPx - rect.right
    : direction.includes('w')
      ? rect.left - rootPaddingPx
      : 0
  const verticalRoom = direction.includes('s')
    ? viewportHeight - rootPaddingPx - rect.bottom
    : direction.includes('n')
      ? rect.top - rootPaddingPx
      : 0
  const maxWidth = start.width + Math.max(0, horizontalRoom)
  const maxBodyHeight = start.bodyHeight + Math.max(0, verticalRoom)
  return {
    minWidth: Math.min(minWidthPx, availableWidth, maxWidth),
    maxWidth,
    minBodyHeight: Math.min(minBodyHeightPx, availableBodyHeight, maxBodyHeight),
    maxBodyHeight,
  }
}

/** 根据 pointer 位移应用 resize，并补偿相反边，保持 dialog 中心锚定。 */
export function applyDialogResize(
  start: DialogResizeStart,
  direction: DialogResizeDirection,
  pointerDx: number,
  pointerDy: number,
  bounds: DialogResizeBounds,
): DialogResizeResult {
  const xSign = directionSign(direction, 'x')
  const ySign = directionSign(direction, 'y')
  const width = clampDialogDimension(start.width + pointerDx * xSign, bounds.minWidth, bounds.maxWidth)
  const bodyHeight = clampDialogDimension(start.bodyHeight + pointerDy * ySign, bounds.minBodyHeight, bounds.maxBodyHeight)
  const appliedWidthDelta = width - start.width
  const appliedBodyDelta = bodyHeight - start.bodyHeight
  return {
    width,
    bodyHeight,
    offsetX: start.offsetX + (xSign * appliedWidthDelta) / 2,
    offsetY: start.offsetY + (ySign * appliedBodyDelta) / 2,
  }
}

/** 按 viewport padding 计算 move 的四个方向界限。 */
export function dialogMoveBounds(
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  paddingPx = 24,
): DialogMoveBounds {
  return {
    minDx: paddingPx - rect.left,
    maxDx: viewportWidth - paddingPx - rect.right,
    minDy: paddingPx - rect.top,
    maxDy: viewportHeight - paddingPx - rect.bottom,
  }
}

/** 应用 move 位移，并把整个 dialog 限制在 viewport padding 内。 */
export function applyDialogMove(
  start: DialogMoveStart,
  pointerDx: number,
  pointerDy: number,
  bounds: DialogMoveBounds,
): DialogMoveStart {
  return {
    offsetX: start.offsetX + clampDialogDimension(pointerDx, bounds.minDx, bounds.maxDx),
    offsetY: start.offsetY + clampDialogDimension(pointerDy, bounds.minDy, bounds.maxDy),
  }
}

/** 将 measured width 按业务比例换算；未测量时使用业务提供的 fallback。 */
export function dialogWidth(measured: number, ratio: number, fallback: number): number {
  return measured > 0 ? measured * ratio : fallback
}

/** 从 inline style 读取一个 px custom property；非法值与缺失值都按 0 处理。 */
export function readPixels(value: string): number {
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : 0
}

/** 将 DOMRect 缩成几何函数所需的纯数据。 */
export function dialogRect(rect: Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom'>): DialogRect {
  return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
}

/** 方向对应的 cursor；业务适配器不需要再各自维护一份表。 */
export function dialogResizeHandleCursor(direction: DialogResizeDirection): string {
  if (direction === 'n' || direction === 's') return 'ns-resize'
  if (direction === 'e' || direction === 'w') return 'ew-resize'
  if (direction === 'ne' || direction === 'sw') return 'nesw-resize'
  return 'nwse-resize'
}

const HANDLE_SIZE_PX = 12
const HANDLE_CORNER_SIZE_PX = 14

/** 八个 handle 的公共尺寸、层级和触控样式。 */
export function dialogResizeHandleStyle(direction: DialogResizeDirection): CSSProperties {
  const base: CSSProperties = {
    position: 'absolute',
    zIndex: 3,
    touchAction: 'none',
    userSelect: 'none',
    cursor: dialogResizeHandleCursor(direction),
    pointerEvents: 'auto',
  }
  if (direction === 'n') return { ...base, top: 0, left: HANDLE_CORNER_SIZE_PX, right: HANDLE_CORNER_SIZE_PX, height: HANDLE_SIZE_PX }
  if (direction === 'ne') return { ...base, top: 0, right: 0, width: HANDLE_CORNER_SIZE_PX, height: HANDLE_CORNER_SIZE_PX }
  if (direction === 'e') return { ...base, top: HANDLE_CORNER_SIZE_PX, right: 0, bottom: HANDLE_CORNER_SIZE_PX, width: HANDLE_SIZE_PX }
  if (direction === 'se') return { ...base, right: 0, bottom: 0, width: HANDLE_CORNER_SIZE_PX, height: HANDLE_CORNER_SIZE_PX }
  if (direction === 's') return { ...base, left: HANDLE_CORNER_SIZE_PX, right: HANDLE_CORNER_SIZE_PX, bottom: 0, height: HANDLE_SIZE_PX }
  if (direction === 'sw') return { ...base, left: 0, bottom: 0, width: HANDLE_CORNER_SIZE_PX, height: HANDLE_CORNER_SIZE_PX }
  if (direction === 'w') return { ...base, top: HANDLE_CORNER_SIZE_PX, left: 0, bottom: HANDLE_CORNER_SIZE_PX, width: HANDLE_SIZE_PX }
  return { ...base, top: 0, left: 0, width: HANDLE_CORNER_SIZE_PX, height: HANDLE_CORNER_SIZE_PX }
}

/** 公共透明移动热区；resize handle 的 z-index 更高。 */
export const dialogMoveHandleStyle: CSSProperties = {
  position: 'absolute',
  zIndex: 2,
  top: 12,
  left: 16,
  right: 52,
  height: 50,
  background: 'transparent',
  cursor: 'move',
  touchAction: 'none',
  userSelect: 'none',
  pointerEvents: 'auto',
}

