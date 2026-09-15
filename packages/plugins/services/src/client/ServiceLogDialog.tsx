/** services 日志 Modal；日志读取与八向拖动不再占用 panel 主组件。 */

import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button, IconFullscreenOutline16, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { DialogFullscreenButton } from '@dsh-remote/plugin-ui'
import type { ServiceLogsResult } from '../shared.js'
import { fill } from './locales.js'
import type { ServicesKey } from './locales.js'
import { LogMoveHandle, LogResizeHandle } from './dialog-resize.js'
import type { LogDialogResizeDirection } from './log-dialog.js'
import { LOG_DIALOG_CLASS, LOG_DIALOG_FULLSCREEN_ATTR } from './log-dialog.js'
import { logBoxStyle, logPathStyle } from './styles.js'

/** 日志 Modal 所需的输入。 */
export interface ServiceLogDialogProps {
  openLog: string | null
  log: ServiceLogsResult | null
  translate: (key: ServicesKey) => string
  onClose: () => void
  onRefresh: () => void
  fullscreen: boolean
  onToggleFullscreen: () => void
  onLogResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: LogDialogResizeDirection) => void
  onLogMovePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
  directions: readonly LogDialogResizeDirection[]
}

/**
 * 日志放在 dsh 自己居中的 dialog，而不是行下方；Modal 提供遮罩、Escape 关闭和 body portal。
 * `data-dsh-services-log-body` 与 LogResizeHandle 是拖动适配器的 DOM 接缝。
 */
export function ServiceLogDialog({
  openLog,
  log,
  translate,
  onClose,
  onRefresh,
  fullscreen,
  onToggleFullscreen,
  onLogResizePointerDown,
  onLogMovePointerDown,
  directions,
}: ServiceLogDialogProps) {
  const fullscreenLabel = translate(fullscreen ? 'exitFullscreen' : 'enterFullscreen')
  return (
    <Modal
      open={openLog !== null}
      onClose={onClose}
      className={LOG_DIALOG_CLASS}
      title={fill(translate('logTitle'), { name: openLog ?? '' })}
      closeLabel={translate('close')}
      footer={(
        <Button variant="outline" size="sm" onClick={onRefresh}>
          {translate('refresh')}
        </Button>
      )}
    >
      {/* null 时也渲染固定尺寸 box，保留日志和路径到达前的占位高度。 */}
      <div style={logPathStyle} title={log?.file ?? ''}>{log?.file ?? ''}</div>
      <pre style={logBoxStyle} data-dsh-services-log-body="">
        {log === null
          ? translate('loadingLogs')
          : log.tail === '' ? translate('emptyLog') : log.tail}
      </pre>
      {/* 全屏开关贴在 Modal 自带 close 按钮左侧；样式由 logDialogRule 提供。 */}
      <DialogFullscreenButton
        dataAttribute={LOG_DIALOG_FULLSCREEN_ATTR}
        label={fullscreenLabel}
        onToggle={onToggleFullscreen}
        icon={<IconFullscreenOutline16 size={14} />}
      />
      {/* 全屏时尺寸已拉满：拖动与八向 resize 都没有意义，一并隐藏。 */}
      {!fullscreen && <LogMoveHandle onPointerDown={onLogMovePointerDown} />}
      {!fullscreen && directions.map(direction => (
        <LogResizeHandle key={direction} direction={direction} onPointerDown={onLogResizePointerDown} />
      ))}
    </Modal>
  )
}
