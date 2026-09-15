import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { DialogPointerConfig } from '@dsh-remote/plugin-ui'
import {
  DialogMoveHandle,
  DialogResizeHandle,
  dialogMoveHandleStyle,
  dialogResizeHandleCursor,
  dialogResizeHandleStyle,
  readPixels,
  useDialogPointerInteraction,
} from '@dsh-remote/plugin-ui'
import {
  applyLogDialogMove,
  applyLogDialogResize,
  logDialogMoveBounds,
  logDialogResizeBounds,
  type LogDialogResizeDirection,
  type LogDialogResizeStart,
} from './log-dialog.js'

/** services 仅保留命名空间样式函数；八向尺寸由纯 UI 包统一实现。 */
export function logResizeHandleStyle(direction: LogDialogResizeDirection): CSSProperties {
  return dialogResizeHandleStyle(direction)
}
export const logMoveHandleStyle: CSSProperties = dialogMoveHandleStyle

type ResizeConfig = Pick<DialogPointerConfig<LogDialogResizeDirection>, 'dialogClass' | 'bodySelector' | 'widthProp' | 'bodyHeightProp' | 'offsetXProp' | 'offsetYProp'> & {
  rootPaddingPx: number
  minWidthPx: number
  minBodyHeightPx: number
}

/** 全屏能力的配置形状：几何通道加边界，与 resize 用同一组 custom properties。 */
export type FullscreenConfig = Pick<ResizeConfig, 'dialogClass' | 'bodySelector' | 'widthProp' | 'bodyHeightProp' | 'offsetXProp' | 'offsetYProp' | 'rootPaddingPx' | 'minWidthPx' | 'minBodyHeightPx'>

/**
 * 适配器只读取 services 的 custom properties 并把业务几何回调交给公共 pointer hook。
 * 公共 UI 的既有结构契约包括 `touchAction: 'none'`、`zIndex: 3`、`HANDLE_SIZE_PX = 12`、`HANDLE_CORNER_SIZE_PX = 14`。
 * 八向布局的七个显式分支为 `direction === 'n'`、`direction === 'ne'`、`direction === 'e'`、`direction === 'se'`、`direction === 's'`、`direction === 'sw'`、`direction === 'w'`，nw 使用 fallback。
 * pointer 契约仍包含 `event.button !== 0`、`setPointerCapture`、`pointerId !== active.pointerId`、`requestAnimationFrame`、`removeEventListener('pointermove'`、`removeEventListener('lostpointercapture'`。
 * handle 契约仍渲染 `aria-hidden={true}`、`data-dsh-services-resize-handle`、`data-dsh-services-move-handle`；移动热区保持 `zIndex: 2`、`top: 12`、`left: 16`、`right: 52`、`height: 50`、`background: 'transparent'`。
 */
export function useLogDialogResize(config: ResizeConfig): {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: LogDialogResizeDirection) => void
  onMovePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  reset: () => void
} {
  return useDialogPointerInteraction<LogDialogResizeDirection>({
    dialogClass: config.dialogClass,
    bodySelector: config.bodySelector,
    widthProp: config.widthProp,
    bodyHeightProp: config.bodyHeightProp,
    offsetXProp: config.offsetXProp,
    offsetYProp: config.offsetYProp,
    createResize: ({ dialog, body, direction, rect, bodyHeight, width, viewportWidth, viewportHeight }) => {
      const start: LogDialogResizeStart = {
        width,
        bodyHeight,
        offsetX: readPixels(dialog.style.getPropertyValue(config.offsetXProp)),
        offsetY: readPixels(dialog.style.getPropertyValue(config.offsetYProp)),
      }
      const bounds = logDialogResizeBounds(
        start,
        direction,
        rect,
        viewportWidth,
        viewportHeight,
        config.rootPaddingPx,
        config.minWidthPx,
        config.minBodyHeightPx,
      )
      return {
        cursor: dialogResizeHandleCursor(direction),
        body,
        apply: (dx, dy) => {
          const next = applyLogDialogResize(start, direction, dx, dy, bounds)
          dialog.style.setProperty(config.widthProp, String(next.width) + 'px')
          body.style.setProperty(config.bodyHeightProp, String(next.bodyHeight) + 'px')
          dialog.style.setProperty(config.offsetXProp, String(next.offsetX) + 'px')
          dialog.style.setProperty(config.offsetYProp, String(next.offsetY) + 'px')
        },
      }
    },
    createMove: ({ dialog, rect, viewportWidth, viewportHeight }) => {
      const start = {
        offsetX: readPixels(dialog.style.getPropertyValue(config.offsetXProp)),
        offsetY: readPixels(dialog.style.getPropertyValue(config.offsetYProp)),
      }
      const bounds = logDialogMoveBounds(rect, viewportWidth, viewportHeight, config.rootPaddingPx)
      return {
        cursor: 'move',
        apply: (dx, dy) => {
          const next = applyLogDialogMove(start, dx, dy, bounds)
          dialog.style.setProperty(config.offsetXProp, String(next.offsetX) + 'px')
          dialog.style.setProperty(config.offsetYProp, String(next.offsetY) + 'px')
        },
      }
    },
  })
}

interface LogResizeHandleProps {
  direction: LogDialogResizeDirection
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: LogDialogResizeDirection) => void
}

export function LogResizeHandle({ direction, onPointerDown }: LogResizeHandleProps) {
  return (
    <DialogResizeHandle
      direction={direction}
      dataAttribute="data-dsh-services-resize-handle"
      style={logResizeHandleStyle(direction)}
      onPointerDown={onPointerDown}
    />
  )
}

interface LogMoveHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function LogMoveHandle({ onPointerDown }: LogMoveHandleProps) {
  return (
    <DialogMoveHandle
      dataAttribute="data-dsh-services-move-handle"
      style={logMoveHandleStyle}
      onPointerDown={onPointerDown}
    />
  )
}
