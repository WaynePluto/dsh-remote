/**
 * composer 上方的可折叠 services panel。
 * 页面按 {@link POLL_MS} 轮询，Host 每次做 registry 与 OS reconciliation；uptime 以 Host snapshot 时钟为基准，再加页面本地经过时间。
 * 服务退出属于正常状态，panel 只展示当前存活服务；已停止服务的日志仍由 `service_logs` 读取。
 *
 * @module @dsh-station/dsh-plugin-services/client/ServicesDock
 */

import { useCallback, useEffect } from 'react'
import { IconApiOutlineMedium, IconChevronDownOutlineMedium, IconChevronUpOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import { ServiceLogDialog } from './ServiceLogDialog.js'
import { ServiceRow } from './ServiceRow.js'
import { installLogDialogStyles } from './styles.js'
import {
  chevronStyle,
  headerStyle,
  leadStyle,
  listStyle,
  rootStyle,
  summaryStyle,
  summaryTextStyle,
  titleStyle,
  errorStyle,
} from './styles.js'
import { useServicesState, POLL_MS } from './use-services-state.js'
import type { ServicesPanelProps } from './types.js'
import type { ServicesKey } from './locales.js'
import type { LogDialogResizeDirection } from './log-dialog.js'

export { POLL_MS }
export type { ServicesDockInjected, ServicesPanelProps } from './types.js'

/** Modal 中的八向尺寸方向，保留旧 DOM 的顺序和拖动行为。 */
const LOG_RESIZE_DIRECTIONS = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const satisfies readonly LogDialogResizeDirection[]

/** 不把 services 与 terminal 合并；这个 panel 只消费 services 自己的 RPC actions。 */
/** 日志 DOM 由 ServiceLogDialog 负责，继续保留 data-dsh-services-log-body、LogMoveHandle 和 LogResizeHandle 接缝。 */
export function ServicesPanel({ sessionId, actions, t }: ServicesPanelProps) {
  const translate = useCallback((key: ServicesKey): string => t?.(key) ?? key, [t])
  const state = useServicesState({ sessionId, actions, translate })

  // panel 生命周期内只安装一个 stylesheet；宽度通过 custom property 传递，打开 dialog 不会重建 stylesheet。
  useEffect(() => installLogDialogStyles(), [])

  const {
    collapsed,
    setCollapsed,
    error,
    busy,
    openLog,
    log,
    services,
    summary,
    rootRef,
    elapsed,
    act,
    showLog,
    closeLog,
    logFullscreen,
    toggleLogFullscreen,
    onLogResizePointerDown,
    onLogMovePointerDown,
  } = state

  // 没有存活服务就完全不显示 panel，也不显示“0 个停止”条；空 panel 不占用每个 turn 的垂直空间。
  if (services.length === 0) return null

  return (
    <section ref={rootRef} style={rootStyle} aria-label={translate('title')} data-dsh-services-panel="">
      <button
        type="button"
        style={headerStyle}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(value => !value) }}
      >
        {/* 复用 dsh 自己的 14px glyph set，leading 和标题均由 flex cell 居中。 */}
        <span aria-hidden style={leadStyle}><IconApiOutlineMedium /></span>
        <span style={titleStyle}>{translate('title')}</span>
        <span style={summaryStyle}><span style={summaryTextStyle}>{summary}</span></span>
        {/* 收起使用向上图标，展开使用向下图标，与 dsh todo panel 相同。 */}
        <span aria-hidden style={chevronStyle}>
          {collapsed ? <IconChevronUpOutlineMedium /> : <IconChevronDownOutlineMedium />}
        </span>
      </button>

      {!collapsed && (
        <ul style={listStyle}>
          {services.map(service => (
            <ServiceRow
              key={service.name}
              service={service}
              busy={busy[service.name]}
              actions={actions}
              translate={translate}
              elapsed={elapsed}
              onShowLog={showLog}
              onAction={act}
            />
          ))}
          {error !== null && <li style={errorStyle}>{error}</li>}
        </ul>
      )}

      <ServiceLogDialog
        openLog={openLog}
        log={log}
        translate={translate}
        onClose={closeLog}
        onRefresh={() => { if (openLog !== null) showLog(openLog) }}
        fullscreen={logFullscreen}
        onToggleFullscreen={toggleLogFullscreen}
        onLogResizePointerDown={onLogResizePointerDown}
        onLogMovePointerDown={onLogMovePointerDown}
        directions={LOG_RESIZE_DIRECTIONS}
      />
    </section>
  )
}
