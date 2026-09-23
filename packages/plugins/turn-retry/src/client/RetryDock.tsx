/** composer 上方的 retry/resume banner。它只在 projection 报告未完成 turn 且 session 不在运行时显示；失败原因可展开查看，按钮操作经 RPC 回到 Host。 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
// 使用 dsh primitives 和本插件的 dialog resize helper；布局保持 dock-card 约定。
import { Button, IconFullscreenOutlineMedium, IconRefreshOutlineMedium, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DialogFullscreenButton, useDialogFullscreen } from '@dsh-remote/plugin-ui'
import type { RetryResult, TurnRetryState } from '../shared.js'
import { fill } from './locales.js'
import type { RetryKey } from './locales.js'
import {
  REASON_DIALOG_BODY_HEIGHT_PROP, REASON_DIALOG_CLASS, REASON_DIALOG_FULLSCREEN_ATTR, REASON_DIALOG_HEIGHT, REASON_DIALOG_MIN_BODY_HEIGHT_PX, REASON_DIALOG_MIN_WIDTH_PX, REASON_DIALOG_OFFSET_X_PROP, REASON_DIALOG_OFFSET_Y_PROP, REASON_DIALOG_ROOT_PADDING_PX, REASON_DIALOG_WIDTH_PROP, publishReasonDialogWidth, reasonDialogRule,
  reasonDialogWidth,
} from './reason-dialog.js'
import { ReasonMoveHandle, ReasonResizeHandle, useReasonDialogResize } from './dialog-resize.js'

/** 注入 banner 的 Host 操作。 */
export interface RetryDockInjected {
  /** 请求 Host 继续/重试当前 pending turn。 */
  onRetry: () => Promise<RetryResult>
}

/** RetryResult.reason 到本地化 key 的映射。 */
const REFUSAL_KEYS = {
  busy: 'busy',
  'pending-input': 'pendingInput',
  'not-failed': 'notFailed',
  'no-agent': 'noAgent',
  subagent: 'subagent',
} as const satisfies Record<NonNullable<RetryResult['reason']>, RetryKey>

/** 安装 reason dialog stylesheet。 */
function installReasonDialogStyles(): () => void {
  const element = document.createElement('style')
  element.dataset['dshTurnRetryReasonDialog'] = ''
  element.textContent = reasonDialogRule()
  document.head.append(element)
  return () => { element.remove(); document.documentElement.style.removeProperty(REASON_DIALOG_WIDTH_PROP) }
}

/** 将 dialog 宽度发布到 `<html>` 供 stylesheet 使用。 */
function publishReasonWidth(width: number): void {
  publishReasonDialogWidth(
    (name, value) => { document.documentElement.style.setProperty(name, value) },
    width,
  )
}

/** 复用 dsh dock-card 的 width axis、圆角和边框；reason dialog 只在打开时测量宽度。 */
const CLEARANCE = 'var(--dsh-composer-side-clearance, 16px)'
const INSET = 'var(--dsh-composer-dock-inset, 8px)'
const CARD_MAX = 'var(--dsh-composer-card-max-width, 952px)'

/**
 * 界面契约：banner 的接口、边界和生命周期沿用 dsh dock-card 公共约定。
 * 布局、主题 token、尺寸和 DOM 接缝与 `ui-conversation/.../TodoPanel.module.css:22-24` 对齐。
 * 主题 token 包括 `--dsw-specific-tip`（浅色 `rgb(245,246,247)`、深色 `rgb(53,54,56)`）
 * 及 `--dsw-alias-bg-layer-2`；`0.5px` 边框、`12px` 圆角和 clearance/inset/card-max 尺寸保持一致。
 */
const bannerStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
  flex: 'none',
  margin: '0 auto',
  width: `calc(100% - ${CLEARANCE} * 2 - ${INSET} * 4)`,
  maxWidth: `calc(${CARD_MAX} - ${INSET} * 4)`,
  minWidth: 0,
  boxSizing: 'border-box',
  padding: '6px 12px',
  borderRadius: '12px',
  border: '0.5px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'var(--dsw-specific-tip, rgba(128,128,128,0.1))',
  fontSize: '13px',
  lineHeight: 1.5,
  overflow: 'hidden',
}

/**
 * ⚠️ 表头对齐全部交给 flex，**不写任何固定尺寸**：`align-items:stretch` 把图标格
 * 子和标题拉成同一高度（由这一行最高的内容决定），每个块再自己
 * `display:flex; align-items:center` 居中。盒高不同的两个块只靠
 * `align-items:center` 对齐的是**盒子中心**，图标的几何中心与文字 ink 仍会差出肉
 * 眼可见的一两像素（用户实机反馈）。
 */
const headerRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'stretch',
  gap: '10px',
  flexWrap: 'wrap',
  minWidth: 0,
}

/**
 * ⚠️ 图标的**光学**下移量，不是随手写的数字：flex 把各格拉成等高、各自居中之后，
 * 量真实截图（`sharp` 读墨迹包围盒，1× 无缩放）仍是「文字墨迹中心 y=48.0、图标墨
 * 迹中心 y=46.5」—— 汉字字面在行盒里天然偏下，而 svg 按几何中心摆，这 1.5px 靠
 * flex 补不回来。写成 em（1.5 ÷ 13 ≈ 0.115em）让它跟字号走；用 `transform` 而不是
 * margin，纯视觉位移不参与布局。
 */
const GLYPH_OPTICAL_SHIFT = 'translateY(0.115em)'

/**
 * 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
 * `line-height: 0` 让这一格的高度只由 svg 决定，行盒的半行距不会把图标顶偏。
 */
const leadStyle: CSSProperties = {
  display: 'flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
  transform: GLYPH_OPTICAL_SHIFT,
  color: 'var(--dsw-alias-label-tertiary, #6b7280)',
}

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。*/
const titleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
  overflowWrap: 'anywhere',
}

/** reason dialog 内的固定高度滚动框；保持 `overscrollBehavior: contain`，并复用 dsh 的 surface tokens。 */
const reasonBoxStyle: CSSProperties = {
  height: REASON_DIALOG_HEIGHT,
  flex: 'none',
  overflowY: 'auto',
  overflowX: 'auto',
  overscrollBehavior: 'contain',
  padding: '6px 8px',
  borderRadius: '8px',
  border: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3))',
  background: 'rgba(128,128,128,0.1)',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '12px',
  lineHeight: 1.5,
  // 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。
  // 实现说明：此处记录相关接口、边界和生命周期约束。
  whiteSpace: 'pre',
  overflowWrap: 'normal',
  minWidth: 0,
  maxWidth: '100%',
  boxSizing: 'border-box',
}

const hintStyle: CSSProperties = {
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

const errorStyle: CSSProperties = {
  color: 'var(--dsw-alias-state-error-primary, #dc2626)',
  fontSize: '12px',
  minWidth: 0,
  overflowWrap: 'anywhere',
}

/** retry banner 的渲染 props。 */
export interface RetryDockOwnProps {
  /** 当前 projection；undefined 表示尚未收到。 */
  pending: TurnRetryState | undefined
  /** session 是否仍在运行。 */
  running: boolean
  /** 请求 Host 继续/重试当前 pending turn。 */
  onRetry?: RetryDockInjected['onRetry'] | undefined
  /** 本插件的 locale 函数。 */
  t?: ((key: RetryKey) => string) | undefined
}

/** reason dialog resize 配置；测试和浏览器共用同一选择器与尺寸 contract。 */
const REASON_RESIZE_CONFIG = { dialogClass: REASON_DIALOG_CLASS, bodySelector: '[data-dsh-turn-retry-reason-body]', widthProp: REASON_DIALOG_WIDTH_PROP, bodyHeightProp: REASON_DIALOG_BODY_HEIGHT_PROP, offsetXProp: REASON_DIALOG_OFFSET_X_PROP, offsetYProp: REASON_DIALOG_OFFSET_Y_PROP, rootPaddingPx: REASON_DIALOG_ROOT_PADDING_PX, minWidthPx: REASON_DIALOG_MIN_WIDTH_PX, minBodyHeightPx: REASON_DIALOG_MIN_BODY_HEIGHT_PX }
export function RetryBanner({ pending, running, onRetry, t }: RetryDockOwnProps) {
  const translate = useCallback((key: RetryKey): string => t?.(key) ?? key, [t])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reasonOpen, setReasonOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { onPointerDown: onReasonResizePointerDown, onMovePointerDown: onReasonMovePointerDown, reset: resetReasonResize } = useReasonDialogResize(REASON_RESIZE_CONFIG)
  useEffect(() => installReasonDialogStyles(), [])
  const turn = pending?.turn
  // 全屏开关由公共 hook 管理：进入前保存几何、退出写回、resize 跟随、换轮次或关闭即复位。
  const { fullscreen: reasonFullscreen, toggle: toggleReasonFullscreen } = useDialogFullscreen({
    ...REASON_RESIZE_CONFIG,
    open: reasonOpen,
    identity: turn === undefined ? undefined : String(turn),
  })
  useEffect(() => {
    setError(null)
    setBusy(false)
    resetReasonResize()
    setReasonOpen(false)
  }, [resetReasonResize, turn])

  const retry = useCallback(() => {
    if (onRetry === undefined) return
    setBusy(true)
    setError(null)
    void (async () => {
      try {
        const result = await onRetry()
        // Host 成功创建 notice 后，projection 会在 `turn/start` 清除 pending；失败结果在此处展示。
        if (result.started) return
        const key = result.reason === undefined ? 'failed' : REFUSAL_KEYS[result.reason]
        setError(translate(key))
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      } finally {
        setBusy(false)
      }
    })()
  }, [onRetry, translate])

  const closeReason = useCallback(() => { resetReasonResize(); setReasonOpen(false) }, [resetReasonResize])
  const openReason = useCallback(() => {
    const measured = rootRef.current?.getBoundingClientRect().width ?? 0
    publishReasonWidth(reasonDialogWidth(measured))
    setReasonOpen(true)
  }, [])

  if (pending === null || pending === undefined) return null
  if (running) return null

  const failed = pending.kind === 'failed'
  const title = failed
    ? 'title'
    : pending.cause === 'user' ? 'stoppedTitle' : 'interruptedTitle'
  // 停止的轮次是继续接手而不是重试：“重试”会让人以为要重新运行。
  const action = failed ? (busy ? 'retrying' : 'retry') : (busy ? 'resuming' : 'resume')
  const hasDetails = failed || error !== null

  return (
    <div ref={rootRef} style={bannerStyle} role="status">
      <div style={headerRowStyle}>
        {/* 使用 refresh 图标：retry banner 的动作是重新驱动上一轮，而不是新增普通消息。 */}
        <span aria-hidden style={leadStyle}><IconRefreshOutlineMedium /></span>
        <span style={titleStyle}>{translate(title)}</span>
        {hasDetails && (
          <Button
            variant="outline"
            size="sm"
            aria-haspopup="dialog"
            aria-expanded={reasonOpen}
            onClick={openReason}
          >
            {translate('details')}
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={busy || onRetry === undefined}
          onClick={retry}
        >
          {translate(action)}
        </Button>
      </div>

      {pending.kind === 'failed' && !pending.retryable && (
        <span style={hintStyle}>{translate('hopeless')}</span>
      )}
      {pending.kind === 'stopped' && <span style={hintStyle}>{translate('stoppedHint')}</span>}
      {error !== null && <span style={errorStyle}>{error}</span>}

      <Modal
        open={reasonOpen}
        onClose={closeReason}
        title={translate('detailsTitle')}
        closeLabel={translate('close')}
        className={REASON_DIALOG_CLASS}
      >
        <div style={reasonBoxStyle} data-turn-retry="reason-dialog" data-dsh-turn-retry-reason-body="">
          {failed && (
            <div>{fill(translate('reason'), { code: pending.code, message: pending.message })}</div>
          )}
          {error !== null && <div style={errorStyle}>{error}</div>}
        </div>
        {/* 全屏开关贴在 Modal 自带 close 按钮左侧；样式由 reasonDialogRule 提供。 */}
        <DialogFullscreenButton
          dataAttribute={REASON_DIALOG_FULLSCREEN_ATTR}
          label={translate(reasonFullscreen ? 'exitFullscreen' : 'enterFullscreen')}
          onToggle={toggleReasonFullscreen}
          icon={<IconFullscreenOutlineMedium size={14} />}
        />
        {/* 全屏时尺寸已拉满：拖动与八向 resize 都没有意义，一并隐藏。 */}
        {!reasonFullscreen && <ReasonMoveHandle onPointerDown={onReasonMovePointerDown} />}
        {!reasonFullscreen && ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'].map(direction => <ReasonResizeHandle key={direction} direction={direction as 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw'} onPointerDown={onReasonResizePointerDown} />)}
      </Modal>
    </div>
  )
}
