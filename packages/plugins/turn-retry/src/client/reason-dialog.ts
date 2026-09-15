import {
  applyDialogMove,
  applyDialogResize,
  clampDialogDimension,
  dialogMoveBounds,
  dialogResizeBounds,
  dialogWidth,
  DIALOG_FULLSCREEN_RIGHT_PX,
  DIALOG_FULLSCREEN_TOP_PX,
  dialogFullscreenButtonRule,
} from '@dsh-remote/plugin-ui'
import type {
  DialogMoveBounds,
  DialogMoveStart,
  DialogRect,
  DialogResizeBounds,
  DialogResizeDirection,
  DialogResizeStart,
} from '@dsh-remote/plugin-ui'

export const REASON_DIALOG_CLASS = 'dsh-turn-retry-reason-dialog'
export const REASON_DIALOG_RATIO = 0.8
export const REASON_DIALOG_FALLBACK_PX = 620
export const REASON_DIALOG_WIDTH_PROP = '--dsh-turn-retry-reason-width'
export const REASON_DIALOG_BODY_HEIGHT_PROP = '--dsh-turn-retry-reason-body-height'
export const REASON_DIALOG_OFFSET_X_PROP = '--dsh-turn-retry-reason-offset-x'
export const REASON_DIALOG_OFFSET_Y_PROP = '--dsh-turn-retry-reason-offset-y'
export const REASON_DIALOG_CHROME_PX = 240
export const REASON_DIALOG_ROOT_PADDING_PX = 24
export const REASON_DIALOG_MIN_WIDTH_PX = 300
export const REASON_DIALOG_MIN_BODY_HEIGHT_PX = 110
export const REASON_DIALOG_HEIGHT = 'min(60vh, calc(100vh - ' + String(REASON_DIALOG_CHROME_PX) + 'px))'
/** 全屏按钮紧贴 Modal 自带 close 按钮左侧；几何与样式规则由 plugin-ui 统一提供。 */
export const REASON_DIALOG_FULLSCREEN_TOP_PX = DIALOG_FULLSCREEN_TOP_PX
export const REASON_DIALOG_FULLSCREEN_RIGHT_PX = DIALOG_FULLSCREEN_RIGHT_PX
/** 全屏按钮挂到 dialog 上的 data 属性名。 */
export const REASON_DIALOG_FULLSCREEN_ATTR = 'data-dsh-turn-retry-reason-fullscreen'

/** 业务名称继续保留；reason 只负责适配公共 dialog geometry。 */
export type ReasonDialogResizeDirection = DialogResizeDirection
export interface ReasonDialogResizeStart extends DialogResizeStart {}
export interface ReasonDialogResizeBounds extends DialogResizeBounds {}
export interface ReasonDialogResizeResult extends ReasonDialogResizeStart {}

export function clampReasonDialogDimension(value: number, min: number, max: number): number {
  return clampDialogDimension(value, min, max)
}

/** 仅把 turn-retry 的默认尺寸转交给公共几何实现。 */
export function reasonDialogResizeBounds(
  start: ReasonDialogResizeStart,
  direction: ReasonDialogResizeDirection,
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  rootPaddingPx = REASON_DIALOG_ROOT_PADDING_PX,
  minWidthPx = REASON_DIALOG_MIN_WIDTH_PX,
  minBodyHeightPx = REASON_DIALOG_MIN_BODY_HEIGHT_PX,
): ReasonDialogResizeBounds {
  return dialogResizeBounds(start, direction, rect, viewportWidth, viewportHeight, rootPaddingPx, minWidthPx, minBodyHeightPx)
}

/** 保留旧的 turn-retry 导出名和返回字段。 */
export function applyReasonDialogResize(
  start: ReasonDialogResizeStart,
  direction: ReasonDialogResizeDirection,
  pointerDx: number,
  pointerDy: number,
  bounds: ReasonDialogResizeBounds,
): ReasonDialogResizeResult {
  return applyDialogResize(start, direction, pointerDx, pointerDy, bounds)
}

export function reasonDialogWidth(measured: number): number {
  return dialogWidth(measured, REASON_DIALOG_RATIO, REASON_DIALOG_FALLBACK_PX)
}

export function reasonDialogRule(): string {
  return (
    '.' +
    REASON_DIALOG_CLASS +
    '{' +
    'width:min(var(' +
    REASON_DIALOG_WIDTH_PROP +
    ', ' +
    String(REASON_DIALOG_FALLBACK_PX) +
    'px), 100%)!important;' +
    'max-width:100%!important;' +
    'transform:translate3d(var(' +
    REASON_DIALOG_OFFSET_X_PROP +
    ', 0px), var(' +
    REASON_DIALOG_OFFSET_Y_PROP +
    ', 0px), 0)!important}' +
    '.' +
    REASON_DIALOG_CLASS +
    ' [data-dsh-turn-retry-reason-body]{' +
    'height:var(' +
    REASON_DIALOG_BODY_HEIGHT_PROP +
    ', ' +
    REASON_DIALOG_HEIGHT +
    ')!important}' +
    '.' +
    REASON_DIALOG_CLASS +
    ' [data-dsh-turn-retry-resize-handle]{pointer-events:auto;touch-action:none;user-select:none}' +
    // 全屏按钮的样式与位置由公共包生成；turn-retry 只提供自己的 class 与 data 属性名。
    dialogFullscreenButtonRule(REASON_DIALOG_CLASS, REASON_DIALOG_FULLSCREEN_ATTR)
  )
}

export function publishReasonDialogWidth(
  setProperty: (name: string, value: string) => void,
  width: number,
): void {
  setProperty(REASON_DIALOG_WIDTH_PROP, String(Math.round(width)) + 'px')
}

export interface ReasonDialogMoveStart extends DialogMoveStart {}
export interface ReasonDialogMoveBounds extends DialogMoveBounds {}

/** reason 的移动边界与公共 dialog 几何保持同一套 clamp 语义。 */
export function reasonDialogMoveBounds(
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  paddingPx = REASON_DIALOG_ROOT_PADDING_PX,
): ReasonDialogMoveBounds {
  return dialogMoveBounds(rect, viewportWidth, viewportHeight, paddingPx)
}

export function applyReasonDialogMove(
  start: ReasonDialogMoveStart,
  pointerDx: number,
  pointerDy: number,
  bounds: ReasonDialogMoveBounds,
): ReasonDialogMoveStart {
  return applyDialogMove(start, pointerDx, pointerDy, bounds)
}
