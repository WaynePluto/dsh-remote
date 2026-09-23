import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { IconChevronDownOutlineMedium, Menu } from '@deepseek-ai/dsh-client-ui-primitives'

interface DepthSelectProps {
  label: string
  hint: string
  labels: readonly string[]
  value: number
  disabled: boolean
  onChange: (value: number) => void
}

const FIELD_CLASS = 'dshx-subagent-depth-field'
const SELECT_CLASS = 'dshx-subagent-depth-select'
// 触发器对齐官方插件字段，弹层直接复用语言选择器所用的 Menu。
const CONTROL_STYLES = `
.${FIELD_CLASS} { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.${FIELD_CLASS} + .${FIELD_CLASS} { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.${FIELD_CLASS}-label {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
}
.${FIELD_CLASS}-menu { display: flex; width: 100%; min-width: 0; }
.${SELECT_CLASS} {
  display: flex;
  align-items: stretch;
  gap: 12px;
  flex: 1;
  min-width: 0;
  box-sizing: content-box;
  height: 34px;
  appearance: none;
  border: 0.5px solid var(--dsw-alias-border-l4);
  border-radius: 8px;
  padding: 0 12px;
  background: var(--dsw-alias-bg-layer-3);
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
}
.${SELECT_CLASS}:focus { outline: none; }
.${SELECT_CLASS}:focus,
.${SELECT_CLASS}[aria-expanded='true'] {
  border-color: var(--dsw-alias-brand-primary);
}
.${SELECT_CLASS}:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.${SELECT_CLASS}-text { display: flex; align-items: center; flex: 1; min-width: 0; }
.${SELECT_CLASS}-text > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.${SELECT_CLASS}-icon {
  display: flex; align-items: center; justify-content: center; flex: none; line-height: 0;
  color: var(--dsw-alias-label-tertiary); pointer-events: none;
}
.${FIELD_CLASS}-hint {
  margin: 0;
  color: var(--dsw-alias-label-tertiary);
  font-size: 12px;
  line-height: 1.5;
}
`

/** 使用官方菜单外观，并在字段内补齐键盘导航与焦点归还。 */
export function DepthSelect({ label, hint, labels, value, disabled, onChange }: DepthSelectProps): ReactNode {
  const id = useId()
  const hintId = `${id}-hint`
  const trigger = useRef<HTMLButtonElement>(null)
  const optionLabels = useRef<(HTMLSpanElement | null)[]>([])
  const focusOnOpen = useRef<number | null>(null)
  const [open, setOpen] = useState(false)
  const menuOpen = open && !disabled

  const focusOption = (index: number): void => {
    optionLabels.current[index]?.closest<HTMLButtonElement>('button')?.focus()
  }

  // Menu 首帧先隐藏并测量位置，定位提交后的下一帧才能可靠聚焦。
  useLayoutEffect(() => {
    if (!menuOpen || focusOnOpen.current === null) return
    const index = focusOnOpen.current
    const frame = requestAnimationFrame(() => {
      optionLabels.current[index]?.closest<HTMLButtonElement>('button')?.focus()
      focusOnOpen.current = null
    })
    return () => { cancelAnimationFrame(frame) }
  }, [menuOpen])

  useEffect(() => {
    if (disabled) setOpen(false)
  }, [disabled])

  const closeAndFocus = (): void => {
    setOpen(false)
    trigger.current?.focus()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (disabled) return
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault()
      // Portal 事件会冒泡到字段，必须在宿主设置页处理 Escape 前消费。
      event.stopPropagation()
      closeAndFocus()
      return
    }
    if (menuOpen && event.key === 'Tab') {
      // 回到正常表单 Tab 顺序，不沿 body 末尾的 portal 节点继续。
      closeAndFocus()
      return
    }
    const arrow = event.key === 'ArrowDown' || event.key === 'ArrowUp'
    if (!arrow && (!menuOpen || (event.key !== 'Home' && event.key !== 'End'))) return
    event.preventDefault()
    event.stopPropagation()
    if (!menuOpen) {
      focusOnOpen.current = event.key === 'ArrowUp' ? labels.length - 1 : value
      setOpen(true)
      return
    }
    const focused = optionLabels.current.findIndex(element => element?.closest('button') === event.target)
    const current = focused < 0 ? value : focused
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? labels.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + labels.length) % labels.length
    focusOption(next)
  }

  return (
    <div className={FIELD_CLASS} onKeyDown={onKeyDown}>
      <style>{CONTROL_STYLES}</style>
      <label className={`${FIELD_CLASS}-label`} htmlFor={id}>{label}</label>
      <Menu
        className={`${FIELD_CLASS}-menu`}
        open={menuOpen}
        portal
        selectedId={String(value)}
        items={labels.map((text, index) => ({
          id: String(index),
          label: <span ref={(element) => { optionLabels.current[index] = element }}>{text}</span>,
          disabled,
        }))}
        onClose={() => { setOpen(false) }}
        onSelect={(selectedId) => {
          if (disabled) return
          onChange(Number(selectedId))
          closeAndFocus()
        }}
        anchor={(
          <button
            ref={trigger}
            id={id}
            type="button"
            className={SELECT_CLASS}
            disabled={disabled}
            aria-label={`${label}: ${labels[value]}`}
            aria-describedby={hintId}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={(event) => {
              focusOnOpen.current = event.detail === 0 ? value : null
              setOpen(current => !current)
            }}
          >
            <span className={`${SELECT_CLASS}-text`}><span>{labels[value]}</span></span>
            <span className={`${SELECT_CLASS}-icon`} aria-hidden="true"><IconChevronDownOutlineMedium /></span>
          </button>
        )}
      />
      <p id={hintId} className={`${FIELD_CLASS}-hint`}>{hint}</p>
    </div>
  )
}
