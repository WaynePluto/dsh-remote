/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`:hover`、`:focus-visible`、`prefers-reduced-motion`、`style`、`--dsw-alias-border-l2`、`turn-process`、`--dsh-content-font-size-secondary`、`gradient-shadow-text.css:56`、`--dsw-*`） */

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const ROW_CLASS = 'dshx-exec-process'

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`<style>`） */
export const ROW_STYLE_MARKER = 'data-dsh-plugin-exec-process-chrome'

/* 背景和布局 */
export function rowStylesheet(): string {
  return `
.${ROW_CLASS} {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: 0;
  padding: 5px 12px;
  /* 细边框 */
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: 8px;
  /* 背景和布局 */
  background: var(--dsw-alias-bg-base, #fff);
  color: var(--dsw-alias-label-secondary, #6b7280);
  cursor: pointer;
  text-align: left;
  font: inherit;
  font-size: var(--dsh-content-font-size-secondary, 13px);
  line-height: calc(20px + var(--dsh-content-font-delta-secondary, 0px));
}

.${ROW_CLASS}[data-open] {
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff));
}

.${ROW_CLASS}:hover {
  border-color: var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.36));
  color: var(--dsw-alias-label-primary, #111827);
}

/* 背景和布局 */

.${ROW_CLASS}__label {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* 背景和布局 */
.${ROW_CLASS}__status {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 背景和布局 */
.${ROW_CLASS}__action {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}

/* 背景和布局 */
.${ROW_CLASS}__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 3px;
  background: var(--dsw-alias-label-secondary, #6b7280);
  animation: dshx-exec-process-pulse 1.4s ease-in-out infinite;
}

.${ROW_CLASS}__action[data-running] {
  color: var(--dsw-alias-label-secondary, #6b7280);
}

@keyframes dshx-exec-process-pulse {
  0%, 100% { opacity: 0.25; }
  50% { opacity: 1; }
}

.${ROW_CLASS}__chevron {
  flex: none;
  width: 14px;
  height: 14px;
  margin-left: auto;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
  transform: rotate(-90deg);
  transition: transform 100ms ease;
}

.${ROW_CLASS}[data-open] .${ROW_CLASS}__chevron {
  transform: rotate(0deg);
}

@media (prefers-reduced-motion: reduce) {
  .${ROW_CLASS}__chevron {
    transition: none;
  }

  .${ROW_CLASS}__dot {
    animation: none;
  }
}
`.trim()
}

/** 测试契约：此处说明本测试锁定的行为和回归边界。 */
export interface StyleHost {
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  readonly head: unknown
}

/** 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`undefined`） */
export function installRowStyles(host: StyleHost | undefined): () => void {
  if (host === undefined) return () => {}
  const element = host.createElement('style')
  element.setAttribute(ROW_STYLE_MARKER, '')
  element.textContent = rowStylesheet()
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)
  return () => { element.remove() }
}
