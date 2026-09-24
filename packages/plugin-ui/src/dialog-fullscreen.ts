/**
 * dialog 的全屏（最大化）能力：几何、custom property 读写、按钮样式规则与状态 hook。
 * services 与 turn-retry 的日志/原因弹窗共用同一套实现，插件只提供自己的 class 名和 data 属性。
 *
 * @module @dsh-station/plugin-ui/dialog-fullscreen
 */

import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import type { ReactElement, ReactNode } from 'react'
import { readPixels } from './dialog-geometry.js'

/** 一次完整的 dialog 几何；与拖动 resize 写入的 custom properties 同一组。 */
export interface DialogGeometry {
  width: number
  bodyHeight: number
  offsetX: number
  offsetY: number
}

/** 定位 dialog 及其 body、读写几何所需的配置；是 `DialogPointerConfig` 的几何子集。 */
export interface DialogGeometryConfig {
  dialogClass: string
  bodySelector: string
  widthProp: string
  bodyHeightProp: string
  offsetXProp: string
  offsetYProp: string
}

/** 全屏几何的边界参数；默认值与拖动 resize 的根 padding 保持同一语义。 */
export interface DialogFullscreenBounds {
  rootPaddingPx: number
  minWidthPx: number
  minBodyHeightPx: number
}

/**
 * 全屏按钮贴着 Modal 自带 close 按钮左侧：top 对齐 header padding-top，right =
 * close 右边距 + 宽 + 间距。上游出处 `packages/client/ui-primitives/src/Modal.module.css`
 * 的 `.header`（padding-top 22）与 `.close`（28 宽、右距 14）。
 */
export const DIALOG_FULLSCREEN_TOP_PX = 22
export const DIALOG_FULLSCREEN_RIGHT_PX = 50

/**
 * 全屏几何：宽高拉满 root padding 之内、回到正中。
 * chromeHeight 是卡片除滚动 body 外的实际高度（卡片高 - body 高），与拖动 resize 同口径。
 */
export function dialogFullscreenGeometry(
  viewportWidth: number,
  viewportHeight: number,
  chromeHeight: number,
  rootPaddingPx = 24,
  minWidthPx = 300,
  minBodyHeightPx = 110,
): DialogGeometry {
  return {
    width: Math.max(minWidthPx, viewportWidth - rootPaddingPx * 2),
    bodyHeight: Math.max(minBodyHeightPx, viewportHeight - rootPaddingPx * 2 - chromeHeight),
    offsetX: 0,
    offsetY: 0,
  }
}

/** 找到当前打开的 dialog 及其 body；Modal 遮罩保证同一时刻只有一个。 */
export function findDialog(config: DialogGeometryConfig, root: ParentNode = document): { dialog: HTMLElement, body: HTMLElement } | null {
  const dialog = root.querySelector<HTMLElement>('.' + config.dialogClass)
  const body = dialog?.querySelector<HTMLElement>(config.bodySelector) ?? null
  if (dialog === null || body === null) return null
  return { dialog, body }
}

/** 读取 dialog 当前生效几何（含继承宽度和默认 0 偏移），供全屏前保存。 */
export function readDialogGeometry(config: DialogGeometryConfig, dialog: HTMLElement, body: HTMLElement): DialogGeometry {
  return {
    width: dialog.getBoundingClientRect().width,
    bodyHeight: body.getBoundingClientRect().height,
    offsetX: readPixels(getComputedStyle(dialog).getPropertyValue(config.offsetXProp)),
    offsetY: readPixels(getComputedStyle(dialog).getPropertyValue(config.offsetYProp)),
  }
}

/** 把几何写成元素级 custom properties；与拖动 resize 的 apply 完全同一组属性。 */
export function writeDialogGeometry(config: DialogGeometryConfig, dialog: HTMLElement, body: HTMLElement, geometry: DialogGeometry): void {
  dialog.style.setProperty(config.widthProp, `${String(Math.round(geometry.width))}px`)
  body.style.setProperty(config.bodyHeightProp, `${String(Math.round(geometry.bodyHeight))}px`)
  dialog.style.setProperty(config.offsetXProp, `${String(Math.round(geometry.offsetX))}px`)
  dialog.style.setProperty(config.offsetYProp, `${String(Math.round(geometry.offsetY))}px`)
}

/**
 * 全屏按钮的样式规则：复刻 Modal 的 `.close`（28×28、8px 圆角、transparent 背景、
 * secondary 图标色），hover 用主题 hover token。base 与 hover 同处一条规则，
 * 不用 inline style，避免状态规则被 inline 覆盖。
 */
export function dialogFullscreenButtonRule(
  dialogClass: string,
  dataAttribute: string,
  topPx = DIALOG_FULLSCREEN_TOP_PX,
  rightPx = DIALOG_FULLSCREEN_RIGHT_PX,
): string {
  const selector = '.' + dialogClass + ' [' + dataAttribute + ']'
  return (
    selector +
    '{position:absolute;top:' + String(topPx) + 'px;right:' + String(rightPx) + 'px;z-index:4;' +
    'display:inline-flex;align-items:center;justify-content:center;' +
    'width:28px;height:28px;padding:0;border:none;border-radius:8px;' +
    'background:transparent;cursor:pointer;color:var(--dsw-alias-label-secondary, inherit)}' +
    selector +
    ':hover{background:var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.1))}'
  )
}

export interface DialogFullscreenButtonProps {
  /** 按钮挂到 dialog 上的 data 属性名，同时决定样式规则的匹配目标。 */
  dataAttribute: string
  /** 当前状态对应的无障碍标签，随全屏切换。 */
  label: string
  /** 触发切换的回调。 */
  onToggle: () => void
  /** 图标元素由插件提供：本包不依赖 dsh primitives。 */
  icon: ReactNode
}

/** 与 Modal 关闭按钮同尺寸的自绘全屏开关。 */
export function DialogFullscreenButton({ dataAttribute, label, onToggle, icon }: DialogFullscreenButtonProps): ReactElement {
  return createElement('button', {
    type: 'button',
    [dataAttribute]: '',
    'aria-label': label,
    title: label,
    onClick: onToggle,
  }, icon)
}

export interface DialogFullscreenConfig extends DialogGeometryConfig, DialogFullscreenBounds {
  /** dialog 是否处于打开状态；关闭即退出全屏态，重开从默认尺寸开始。 */
  open: boolean
  /**
   * 当前 dialog 的标识（如 services 的服务名）。切换标识意味着换了一份内容，
   * 全屏态一并复位，避免把上一个内容的尺寸带到新的 dialog 上。
   */
  identity?: string | undefined
}

export interface DialogFullscreenState {
  fullscreen: boolean
  toggle: () => void
}

/**
 * 管理全屏开关：进入前保存当前几何，退出时原样写回。
 * 全屏期间窗口尺寸变化会重新拉满；dialog 关闭时自动复位，不把全屏态带到下一次打开。
 */
export function useDialogFullscreen({
  dialogClass,
  bodySelector,
  widthProp,
  bodyHeightProp,
  offsetXProp,
  offsetYProp,
  rootPaddingPx,
  minWidthPx,
  minBodyHeightPx,
  open,
  identity,
}: DialogFullscreenConfig): DialogFullscreenState {
  const [fullscreen, setFullscreen] = useState(false)
  /** 进入全屏前的几何；退出时原样写回，保证“变回原来的大小”。 */
  const savedRef = useRef<DialogGeometry | null>(null)
  const configRef = useRef<DialogGeometryConfig>({ dialogClass, bodySelector, widthProp, bodyHeightProp, offsetXProp, offsetYProp })
  configRef.current = { dialogClass, bodySelector, widthProp, bodyHeightProp, offsetXProp, offsetYProp }
  const boundsRef = useRef({ rootPaddingPx, minWidthPx, minBodyHeightPx })
  boundsRef.current = { rootPaddingPx, minWidthPx, minBodyHeightPx }

  const applyFullscreen = useCallback((): void => {
    const found = findDialog(configRef.current)
    if (found === null) return
    const bounds = boundsRef.current
    const card = found.dialog.getBoundingClientRect()
    const bodyBox = found.body.getBoundingClientRect()
    writeDialogGeometry(configRef.current, found.dialog, found.body, dialogFullscreenGeometry(
      window.innerWidth,
      window.innerHeight,
      Math.max(0, card.height - bodyBox.height),
      bounds.rootPaddingPx,
      bounds.minWidthPx,
      bounds.minBodyHeightPx,
    ))
  }, [])

  const toggle = useCallback((): void => {
    const found = findDialog(configRef.current)
    if (found === null) return
    if (fullscreen) {
      const saved = savedRef.current
      if (saved !== null) writeDialogGeometry(configRef.current, found.dialog, found.body, saved)
      setFullscreen(false)
      return
    }
    savedRef.current = readDialogGeometry(configRef.current, found.dialog, found.body)
    applyFullscreen()
    setFullscreen(true)
  }, [applyFullscreen, fullscreen])

  // 全屏期间窗口尺寸变化就重新拉满；退出全屏或关闭 dialog 时随依赖清理。
  useEffect(() => {
    if (!fullscreen || !open) return
    const onWindowResize = (): void => { applyFullscreen() }
    window.addEventListener('resize', onWindowResize)
    return () => { window.removeEventListener('resize', onWindowResize) }
  }, [applyFullscreen, fullscreen, open])

  // 关闭或换内容即退出全屏态；重开时从默认尺寸开始。
  useEffect(() => {
    setFullscreen(false)
  }, [open, identity])

  return { fullscreen, toggle }
}
