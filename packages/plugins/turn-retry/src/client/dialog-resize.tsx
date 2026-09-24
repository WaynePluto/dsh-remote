import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type { DialogPointerConfig } from '@dsh-station/plugin-ui'
import {
  DialogMoveHandle,
  DialogResizeHandle,
  dialogMoveHandleStyle,
  dialogResizeHandleCursor,
  dialogResizeHandleStyle,
  readPixels,
  useDialogPointerInteraction,
} from '@dsh-station/plugin-ui'
import {
  applyReasonDialogMove,
  applyReasonDialogResize,
  reasonDialogMoveBounds,
  reasonDialogResizeBounds,
  type ReasonDialogResizeDirection,
  type ReasonDialogResizeStart,
} from './reason-dialog.js'

/** turn-retry 只保留自己的导出名；公共 UI 负责 handle 几何和样式。 */
export function reasonResizeHandleStyle(direction: ReasonDialogResizeDirection): CSSProperties {
  return dialogResizeHandleStyle(direction)
}
export const reasonMoveHandleStyle: CSSProperties = dialogMoveHandleStyle

type ResizeConfig = Pick<DialogPointerConfig<ReasonDialogResizeDirection>, 'dialogClass' | 'bodySelector' | 'widthProp' | 'bodyHeightProp' | 'offsetXProp' | 'offsetYProp'> & {
  rootPaddingPx: number
  minWidthPx: number
  minBodyHeightPx: number
}

/**
 * 适配器只读取 turn-retry 的 custom properties 并把业务几何回调交给公共 pointer hook。
 * 公共 UI 的既有结构契约包括 `touchAction: 'none'`、`zIndex: 3`、`HANDLE_SIZE_PX = 12`、`HANDLE_CORNER_SIZE_PX = 14`。
 * 八向布局的七个显式分支为 `direction === 'n'`、`direction === 'ne'`、`direction === 'e'`、`direction === 'se'`、`direction === 's'`、`direction === 'sw'`、`direction === 'w'`，nw 使用 fallback。
 * pointer 契约仍包含 `event.button !== 0`、`setPointerCapture`、`pointerId !== active.pointerId`、`requestAnimationFrame`、`removeEventListener('pointermove'`、`removeEventListener('lostpointercapture'`。
 * handle 契约仍渲染 `aria-hidden={true}`、`data-dsh-turn-retry-resize-handle`、`data-dsh-turn-retry-move-handle`；移动热区保持 `zIndex: 2`、`top: 12`、`left: 16`、`right: 52`、`height: 50`、`background: 'transparent'`。
 */
export function useReasonDialogResize(config: ResizeConfig): {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: ReasonDialogResizeDirection) => void
  onMovePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  reset: () => void
} {
  return useDialogPointerInteraction<ReasonDialogResizeDirection>({
    dialogClass: config.dialogClass,
    bodySelector: config.bodySelector,
    widthProp: config.widthProp,
    bodyHeightProp: config.bodyHeightProp,
    offsetXProp: config.offsetXProp,
    offsetYProp: config.offsetYProp,
    createResize: ({ dialog, body, direction, rect, bodyHeight, width, viewportWidth, viewportHeight }) => {
      const start: ReasonDialogResizeStart = {
        width,
        bodyHeight,
        offsetX: readPixels(dialog.style.getPropertyValue(config.offsetXProp)),
        offsetY: readPixels(dialog.style.getPropertyValue(config.offsetYProp)),
      }
      const bounds = reasonDialogResizeBounds(
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
          const next = applyReasonDialogResize(start, direction, dx, dy, bounds)
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
      const bounds = reasonDialogMoveBounds(rect, viewportWidth, viewportHeight, config.rootPaddingPx)
      return {
        cursor: 'move',
        apply: (dx, dy) => {
          const next = applyReasonDialogMove(start, dx, dy, bounds)
          dialog.style.setProperty(config.offsetXProp, String(next.offsetX) + 'px')
          dialog.style.setProperty(config.offsetYProp, String(next.offsetY) + 'px')
        },
      }
    },
  })
}

interface ReasonResizeHandleProps {
  direction: ReasonDialogResizeDirection
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: ReasonDialogResizeDirection) => void
}

export function ReasonResizeHandle({ direction, onPointerDown }: ReasonResizeHandleProps) {
  return (
    <DialogResizeHandle
      direction={direction}
      dataAttribute="data-dsh-turn-retry-resize-handle"
      style={reasonResizeHandleStyle(direction)}
      onPointerDown={onPointerDown}
    />
  )
}

interface ReasonMoveHandleProps {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

export function ReasonMoveHandle({ onPointerDown }: ReasonMoveHandleProps) {
  return (
    <DialogMoveHandle
      dataAttribute="data-dsh-turn-retry-move-handle"
      style={reasonMoveHandleStyle}
      onPointerDown={onPointerDown}
    />
  )
}
