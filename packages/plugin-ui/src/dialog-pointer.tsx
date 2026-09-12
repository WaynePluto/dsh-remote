import { createElement, useCallback, useEffect, useRef } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import { dialogMoveHandleStyle, dialogRect, dialogResizeHandleStyle } from './dialog-geometry.js'
import type { DialogRect, DialogResizeDirection } from './dialog-geometry.js'

export interface DialogResizeHandleProps<TDirection extends DialogResizeDirection = DialogResizeDirection> {
  direction: TDirection
  dataAttribute: string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: TDirection) => void
  style?: CSSProperties
}

/** 可复用的无障碍 resize handle；data 属性名由插件适配器提供。 */
export function DialogResizeHandle<TDirection extends DialogResizeDirection = DialogResizeDirection>({
  direction,
  dataAttribute,
  onPointerDown,
  style,
}: DialogResizeHandleProps<TDirection>): ReactElement {
  return createElement('div', {
    'aria-hidden': true,
    [dataAttribute]: direction,
    style: style ?? dialogResizeHandleStyle(direction),
    onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
      onPointerDown(event, direction)
    },
  })
}

export interface DialogMoveHandleProps {
  dataAttribute: string
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  style?: CSSProperties
}

/** 可复用的无障碍透明移动热区；data 属性名由插件适配器提供。 */
export function DialogMoveHandle({ dataAttribute, onPointerDown, style }: DialogMoveHandleProps): ReactElement {
  return createElement('div', {
    'aria-hidden': true,
    [dataAttribute]: '',
    style: style ?? dialogMoveHandleStyle,
    onPointerDown,
  })
}

export interface DialogPointerAction {
  cursor: string
  apply: (dx: number, dy: number) => void
  body?: HTMLElement
}

export interface DialogResizeContext<TDirection extends DialogResizeDirection = DialogResizeDirection> {
  dialog: HTMLElement
  body: HTMLElement
  direction: TDirection
  rect: DialogRect
  bodyHeight: number
  width: number
  viewportWidth: number
  viewportHeight: number
}

export interface DialogMoveContext {
  dialog: HTMLElement
  rect: DialogRect
  viewportWidth: number
  viewportHeight: number
}

/**
 * 业务适配器只提供查找器和几何回调；pointer capture、RAF 与全局清理统一在此处。
 * `createResize` / `createMove` 返回 null 时表示当前 dialog 不可交互。
 */
export interface DialogPointerConfig<TDirection extends DialogResizeDirection = DialogResizeDirection> {
  dialogClass: string
  bodySelector: string
  widthProp: string
  bodyHeightProp: string
  offsetXProp: string
  offsetYProp: string
  createResize: (context: DialogResizeContext<TDirection>) => DialogPointerAction | null
  createMove: (context: DialogMoveContext) => DialogPointerAction | null
}

interface ActiveInteraction<TTarget extends HTMLElement> {
  pointerId: number
  target: TTarget
  startX: number
  startY: number
  lastDx: number
  lastDy: number
  frame: number | undefined
  apply: (dx: number, dy: number) => void
  onMove: (event: PointerEvent) => void
  onEnd: (event: PointerEvent) => void
  onBlur: () => void
  onLost: (event: PointerEvent) => void
  previousHtmlUserSelect: string
  previousBodyCursor: string
  previousHtmlCursor: string
}

export interface DialogPointerHandlers<
  TDirection extends DialogResizeDirection = DialogResizeDirection,
  TTarget extends HTMLElement = HTMLDivElement,
> {
  onPointerDown: (event: ReactPointerEvent<TTarget>, direction: TDirection) => void
  onMovePointerDown: (event: ReactPointerEvent<TTarget>) => void
  reset: () => void
}

/**
 * 统一 dialog 的 pointer 生命周期。每个 hook 调用拥有独立 ref，因此多个 dialog 实例不会共享 active 状态。
 * pointerup、pointercancel、blur、lostpointercapture 和 unmount 都会撤销 capture、RAF、监听器与 cursor。
 */
export function useDialogPointerInteraction<
  TDirection extends DialogResizeDirection = DialogResizeDirection,
  TTarget extends HTMLElement = HTMLDivElement,
>(config: DialogPointerConfig<TDirection>): DialogPointerHandlers<TDirection, TTarget> {
  const configRef = useRef(config)
  configRef.current = config
  const activeRef = useRef<ActiveInteraction<TTarget> | null>(null)
  const lastDialogRef = useRef<HTMLElement | null>(null)
  const lastBodyRef = useRef<HTMLElement | null>(null)

  const clearProperties = useCallback(() => {
    const current = configRef.current
    lastDialogRef.current?.style.removeProperty(current.widthProp)
    lastDialogRef.current?.style.removeProperty(current.offsetXProp)
    lastDialogRef.current?.style.removeProperty(current.offsetYProp)
    lastBodyRef.current?.style.removeProperty(current.bodyHeightProp)
  }, [])

  const restoreInteraction = useCallback((active: ActiveInteraction<TTarget>) => {
    activeRef.current = null
    if (active.frame !== undefined) cancelAnimationFrame(active.frame)
    if (active.target.hasPointerCapture(active.pointerId)) {
      try {
        active.target.releasePointerCapture(active.pointerId)
      } catch {}
    }
    document.documentElement.style.userSelect = active.previousHtmlUserSelect
    document.body.style.cursor = active.previousBodyCursor
    document.documentElement.style.cursor = active.previousHtmlCursor
    window.removeEventListener('pointermove', active.onMove)
    window.removeEventListener('pointerup', active.onEnd)
    window.removeEventListener('pointercancel', active.onEnd)
    window.removeEventListener('blur', active.onBlur)
    active.target.removeEventListener('lostpointercapture', active.onLost)
  }, [])

  const flush = useCallback((active: ActiveInteraction<TTarget>) => {
    if (active.frame !== undefined) {
      cancelAnimationFrame(active.frame)
      active.frame = undefined
    }
    active.apply(active.lastDx, active.lastDy)
  }, [])

  const finish = useCallback(
    (event?: PointerEvent) => {
      const active = activeRef.current
      if (active === null) return
      if (event !== undefined && event.pointerId !== active.pointerId) return
      flush(active)
      restoreInteraction(active)
    },
    [flush, restoreInteraction],
  )

  const begin = useCallback(
    (event: ReactPointerEvent<TTarget>, dialog: HTMLElement, action: DialogPointerAction): void => {
      if (event.button !== 0 || activeRef.current !== null) return
      const target = event.currentTarget
      const active: ActiveInteraction<TTarget> = {
        pointerId: event.pointerId,
        target,
        startX: event.clientX,
        startY: event.clientY,
        lastDx: 0,
        lastDy: 0,
        frame: undefined,
        apply: action.apply,
        onMove: (() => {}) as (event: PointerEvent) => void,
        onEnd: (() => {}) as (event: PointerEvent) => void,
        onBlur: () => {},
        onLost: (() => {}) as (event: PointerEvent) => void,
        previousHtmlUserSelect: document.documentElement.style.userSelect,
        previousBodyCursor: document.body.style.cursor,
        previousHtmlCursor: document.documentElement.style.cursor,
      }
      active.onMove = (moveEvent) => {
        if (moveEvent.pointerId !== active.pointerId) return
        active.lastDx = moveEvent.clientX - active.startX
        active.lastDy = moveEvent.clientY - active.startY
        if (active.frame !== undefined) return
        active.frame = requestAnimationFrame(() => {
          active.frame = undefined
          if (activeRef.current === active) active.apply(active.lastDx, active.lastDy)
        })
      }
      active.onEnd = (endEvent) => {
        finish(endEvent)
      }
      active.onBlur = () => {
        finish()
      }
      active.onLost = (lostEvent) => {
        finish(lostEvent)
      }
      activeRef.current = active
      lastDialogRef.current = dialog
      if (action.body !== undefined) lastBodyRef.current = action.body
      document.documentElement.style.userSelect = 'none'
      document.body.style.cursor = action.cursor
      document.documentElement.style.cursor = action.cursor
      target.addEventListener('lostpointercapture', active.onLost)
      window.addEventListener('pointermove', active.onMove)
      window.addEventListener('pointerup', active.onEnd)
      window.addEventListener('pointercancel', active.onEnd)
      window.addEventListener('blur', active.onBlur)
      try {
        target.setPointerCapture(event.pointerId)
      } catch {
        restoreInteraction(active)
        return
      }
      event.preventDefault()
    },
    [finish, restoreInteraction],
  )

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<TTarget>, direction: TDirection) => {
      if (event.button !== 0 || activeRef.current !== null) return
      const current = configRef.current
      const dialog = event.currentTarget.closest<HTMLElement>('.' + current.dialogClass)
      if (dialog === null) return
      const body = dialog.querySelector<HTMLElement>(current.bodySelector)
      if (body === null) return
      const dialogBox = dialog.getBoundingClientRect()
      const bodyHeight = body.getBoundingClientRect().height
      if (dialogBox.width <= 0 || bodyHeight <= 0) return
      const action = current.createResize({
        dialog,
        body,
        direction,
        rect: dialogRect(dialogBox),
        bodyHeight,
        width: dialogBox.width,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
      if (action === null) return
      begin(event, dialog, { ...action, body })
    },
    [begin],
  )

  const onMovePointerDown = useCallback(
    (event: ReactPointerEvent<TTarget>) => {
      if (event.button !== 0 || activeRef.current !== null) return
      const current = configRef.current
      const dialog = event.currentTarget.closest<HTMLElement>('.' + current.dialogClass)
      if (dialog === null) return
      const dialogBox = dialog.getBoundingClientRect()
      const action = current.createMove({
        dialog,
        rect: dialogRect(dialogBox),
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      })
      if (action === null) return
      begin(event, dialog, action)
    },
    [begin],
  )

  const reset = useCallback(() => {
    const active = activeRef.current
    if (active !== null) restoreInteraction(active)
    clearProperties()
  }, [clearProperties, restoreInteraction])

  useEffect(
    () => () => {
      reset()
    },
    [reset],
  )

  return { onPointerDown, onMovePointerDown, reset }
}

