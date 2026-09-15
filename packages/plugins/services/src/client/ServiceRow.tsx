/** services panel 的单行视图；操作回调仍由状态 hook 提供。 */

import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ServiceView } from '../shared.js'
import type { ServicesKey } from './locales.js'
import { factsStyle, nameStyle, rowActionsStyle, rowStyle, warnStyle } from './styles.js'
import type { Busy, ServicesDockInjected } from './types.js'

/** 单行渲染所需的输入。 */
export interface ServiceRowProps {
  service: ServiceView
  busy: Busy
  actions?: Partial<ServicesDockInjected> | undefined
  translate: (key: ServicesKey) => string
  elapsed: (service: ServiceView) => string
  onShowLog: (name: string) => void
  onAction: (name: string, kind: 'stop' | 'restart') => void
}

/** 渲染一个运行中服务的名称、事实和操作按钮。 */
export function ServiceRow({ service, busy, actions, translate, elapsed, onShowLog, onAction }: ServiceRowProps) {
  // 每个服务只占一行；命令等 facts 超长时在中间省略，完整内容通过 title 提供。
  const facts = [
    service.port === undefined ? undefined : `:${String(service.port)}`,
    `pid ${String(service.pid)}`,
    elapsed(service),
    service.command,
  ].filter(Boolean).join('  ')
  return (
    <li style={{ minWidth: 0 }}>
      <div style={rowStyle}>
        <span style={nameStyle} title={service.name}>{service.name}</span>
        <span style={factsStyle} title={facts}>{facts}</span>
        <span style={rowActionsStyle}>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined}
            onClick={() => { onShowLog(service.name) }}
          >
            {translate('logs')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined || actions?.onRestart === undefined}
            onClick={() => { onAction(service.name, 'restart') }}
          >
            {busy === 'restart' ? translate('restarting') : translate('restart')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== undefined || actions?.onStop === undefined}
            onClick={() => { onAction(service.name, 'stop') }}
          >
            {busy === 'stop' ? translate('stopping') : translate('stop')}
          </Button>
        </span>
      </div>
      {service.identity === 'unknown' && (
        <div style={warnStyle}>{translate('unknownIdentity')}</div>
      )}
    </li>
  )
}


