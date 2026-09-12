import {
  applyDialogMove,
  applyDialogResize,
  clampDialogDimension,
  dialogMoveBounds,
  dialogResizeBounds,
  dialogWidth,
} from '@dsh-remote/plugin-ui'
import type {
  DialogMoveBounds,
  DialogMoveStart,
  DialogRect,
  DialogResizeBounds,
  DialogResizeDirection,
  DialogResizeStart,
} from '@dsh-remote/plugin-ui'

export const LOG_DIALOG_RATIO = 0.8
export const LOG_DIALOG_FALLBACK_PX = 620
export const LOG_DIALOG_CLASS = 'dsh-services-log-dialog'
export const LOG_DIALOG_WIDTH_PROP = '--dsh-services-log-width'
export const LOG_DIALOG_BODY_HEIGHT_PROP = '--dsh-services-log-body-height'
export const LOG_DIALOG_OFFSET_X_PROP = '--dsh-services-log-offset-x'
export const LOG_DIALOG_OFFSET_Y_PROP = '--dsh-services-log-offset-y'
export const LOG_DIALOG_CHROME_PX = 240
export const LOG_DIALOG_ROOT_PADDING_PX = 24
export const LOG_DIALOG_MIN_WIDTH_PX = 300
export const LOG_DIALOG_MIN_BODY_HEIGHT_PX = 110
export const LOG_DIALOG_HEIGHT = 'min(60vh, calc(100vh - ' + String(LOG_DIALOG_CHROME_PX) + 'px))'
export const LOG_PATH_MIN_HEIGHT_PX = 16

/** 业务名称继续保留；几何方向和计算统一由 plugin-ui 提供。 */
export type LogDialogResizeDirection = DialogResizeDirection
export interface LogDialogResizeStart extends DialogResizeStart {}
export interface LogDialogResizeBounds extends DialogResizeBounds {}
export interface LogDialogResizeResult extends LogDialogResizeStart {}

export function clampLogDialogDimension(value: number, min: number, max: number): number {
  return clampDialogDimension(value, min, max)
}

/** 仅把 services 的默认尺寸转交给公共几何实现。 */
export function logDialogResizeBounds(
  start: LogDialogResizeStart,
  direction: LogDialogResizeDirection,
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  rootPaddingPx = LOG_DIALOG_ROOT_PADDING_PX,
  minWidthPx = LOG_DIALOG_MIN_WIDTH_PX,
  minBodyHeightPx = LOG_DIALOG_MIN_BODY_HEIGHT_PX,
): LogDialogResizeBounds {
  return dialogResizeBounds(start, direction, rect, viewportWidth, viewportHeight, rootPaddingPx, minWidthPx, minBodyHeightPx)
}

/** 保留旧的 services 导出名，结果形状不变。 */
export function applyLogDialogResize(
  start: LogDialogResizeStart,
  direction: LogDialogResizeDirection,
  pointerDx: number,
  pointerDy: number,
  bounds: LogDialogResizeBounds,
): LogDialogResizeResult {
  return applyDialogResize(start, direction, pointerDx, pointerDy, bounds)
}

export function logDialogWidth(measured: number): number {
  return dialogWidth(measured, LOG_DIALOG_RATIO, LOG_DIALOG_FALLBACK_PX)
}

export function logDialogRule(): string {
  return (
    '.' +
    LOG_DIALOG_CLASS +
    '{' +
    'width:min(var(' +
    LOG_DIALOG_WIDTH_PROP +
    ', ' +
    String(LOG_DIALOG_FALLBACK_PX) +
    'px), 100%)!important;' +
    'max-width:100%!important;' +
    'transform:translate3d(var(' +
    LOG_DIALOG_OFFSET_X_PROP +
    ', 0px), var(' +
    LOG_DIALOG_OFFSET_Y_PROP +
    ', 0px), 0)!important}' +
    '.' +
    LOG_DIALOG_CLASS +
    ' [data-dsh-services-log-body]{' +
    'height:var(' +
    LOG_DIALOG_BODY_HEIGHT_PROP +
    ', ' +
    LOG_DIALOG_HEIGHT +
    ')!important}' +
    '.' +
    LOG_DIALOG_CLASS +
    ' [data-dsh-services-resize-handle]{pointer-events:auto;touch-action:none;user-select:none}'
  )
}

export function publishLogDialogWidth(
  setProperty: (name: string, value: string) => void,
  width: number,
): void {
  setProperty(LOG_DIALOG_WIDTH_PROP, String(Math.round(width)) + 'px')
}

export interface LogDialogMoveStart extends DialogMoveStart {}
export interface LogDialogMoveBounds extends DialogMoveBounds {}

/** services 的移动边界与公共 dialog 几何保持同一套 clamp 语义。 */
export function logDialogMoveBounds(
  rect: DialogRect,
  viewportWidth: number,
  viewportHeight: number,
  paddingPx = LOG_DIALOG_ROOT_PADDING_PX,
): LogDialogMoveBounds {
  return dialogMoveBounds(rect, viewportWidth, viewportHeight, paddingPx)
}

export function applyLogDialogMove(
  start: LogDialogMoveStart,
  pointerDx: number,
  pointerDy: number,
  bounds: LogDialogMoveBounds,
): LogDialogMoveStart {
  return applyDialogMove(start, pointerDx, pointerDy, bounds)
}
