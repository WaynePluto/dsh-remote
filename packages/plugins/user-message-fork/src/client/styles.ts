/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const USER_ROW_CLASS = 'dshx-user-message-fork-user-row'
export const USER_STACK_CLASS = 'dshx-user-message-fork-user-stack'
export const BUBBLE_CLASS = 'dshx-user-message-fork-bubble'
export const REFERENCE_CLASS = 'dshx-user-message-fork-reference'
export const ATTACHMENTS_CLASS = 'dshx-user-message-fork-attachments'
export const FILE_CARD_CLASS = 'dshx-user-message-fork-file-card'
export const FILE_ICON_CLASS = 'dshx-user-message-fork-file-icon'
export const FILE_CONTENT_CLASS = 'dshx-user-message-fork-file-content'
export const FILE_NAME_CLASS = 'dshx-user-message-fork-file-name'
export const FILE_META_CLASS = 'dshx-user-message-fork-file-meta'
export const ACTIONS_CLASS = 'dshx-user-message-fork-actions'
export const ACTION_CLASS = 'dshx-user-message-fork-action'
export const VISUALLY_HIDDEN_CLASS = 'dshx-user-message-fork-visually-hidden'
export const STYLE_MARKER = 'data-dsh-plugin-user-message-fork'

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。 */
export function userMessageForkStyles(): string {
  return `
.${USER_ROW_CLASS} {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}

.${USER_STACK_CLASS} {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
  min-width: 0;
  max-width: min(calc(var(--dsh-chat-content-width, 748px) * 0.702), 82%);
}

.${BUBBLE_CLASS} {
  max-width: 100%;
  background: var(--dsw-specific-bubble, #edf2ff);
  border-radius: 22px;
  padding: 10px 16px;
  font-size: var(--dsh-content-font-size, 14px);
  line-height: calc(22px + var(--dsh-content-font-delta, 0px));
  color: var(--dsw-alias-label-primary, #1f2329);
  white-space: pre-wrap;
  word-break: break-word;
}

.${REFERENCE_CLASS} {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
}

.${ATTACHMENTS_CLASS} {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.${FILE_CARD_CLASS} {
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--dsw-specific-bubble, #edf2ff);
  color: var(--dsw-alias-label-primary, #1f2329);
}

.${FILE_ICON_CLASS} {
  flex: none;
  width: 18px;
  height: 18px;
  margin-right: 8px;
}

.${FILE_CONTENT_CLASS} {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.${FILE_NAME_CLASS} {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${FILE_META_CLASS} {
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(18px + var(--dsh-content-font-delta-secondary, 0px));
}

.${ACTIONS_CLASS} {
  display: flex;
  align-items: center;
  gap: 8px;
  height: calc(28px + var(--dsh-content-font-delta, 0px));
}

.${ACTIONS_CLASS}__time {
  padding-right: 12px;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(24px + var(--dsh-content-font-delta, 0px));
  white-space: nowrap;
}

.${ACTION_CLASS} {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: calc(28px + var(--dsh-content-font-delta, 0px));
  height: calc(28px + var(--dsh-content-font-delta, 0px));
  padding: 6px;
  border: none;
  border-radius: 28px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
  cursor: pointer;
  line-height: 0;
}

.${ACTION_CLASS} svg {
  width: calc(15px + var(--dsh-content-font-delta, 0px));
  height: calc(15px + var(--dsh-content-font-delta, 0px));
}

.${ACTION_CLASS}:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(128, 128, 128, 0.12));
  color: var(--dsw-alias-label-secondary, #4b5563);
}

.${ACTION_CLASS}:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary, #3964fe);
  outline-offset: 2px;
}

.${ACTION_CLASS}[data-unavailable] {
  cursor: default;
  opacity: 0.4;
}

.${ACTION_CLASS}[data-unavailable]:hover {
  background: transparent;
  color: var(--dsw-alias-label-tertiary, #6b7280);
}

.${VISUALLY_HIDDEN_CLASS} {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (hover: hover) {
  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(
    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])
  ) .${ACTIONS_CLASS} {
    opacity: 0;
    transition: opacity 80ms ease;
  }

  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(
    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])
  ):hover .${ACTIONS_CLASS},
  :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering']):has(
    ~ :is([data-chat-flow-kind='user'], [data-chat-flow-kind='steering'])
  ):focus-within .${ACTIONS_CLASS} {
    opacity: 1;
  }
}
`.trim()
}

interface StyleElement {
  textContent: string | null
  setAttribute(name: string, value: string): void
  remove(): void
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
export interface StyleHost {
  createElement(tag: 'style'): StyleElement
  readonly head: unknown
}

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。 */
export function installUserMessageForkStyles(host: StyleHost | undefined): () => void {
  if (host === undefined) return () => {}
  const element = host.createElement('style')
  element.setAttribute(STYLE_MARKER, '')
  element.textContent = userMessageForkStyles()
  const head = host.head as {
    append?: (node: unknown) => void
    appendChild?: (node: unknown) => void
  }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)
  return () => { element.remove() }
}
