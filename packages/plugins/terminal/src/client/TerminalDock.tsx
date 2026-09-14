/**
 * composer 上方的可折叠 terminal panel。
 *
 * TerminalPanel 保留 dock 的 DOM 结构；状态、轮询和样式分别位于同目录的职责模块。
 *
 * @module @dsh-remote/dsh-plugin-terminal/client/TerminalDock
 */

import {
  Button, IconApiOutline14, IconChevronDownOutline14, IconChevronUpOutline14, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { terminalLabel } from '../shared.js'
import type { TerminalPanelProps } from './terminal-dock.types.js'
import {
  bodyStyle, chevronStyle, errorStyle, headerStyle, inputClass, inputRowStyle, inputStyles, leadStyle,
  MONO, noteStyle, rootStyle, screenStyle, summaryStyle, summaryTextStyle, tabsStyle, titleStyle,
} from './terminal-dock.styles.js'
import { useTerminalPanel } from './use-terminal-panel.js'

export { LIST_POLL_MS, SCREEN_POLL_MS } from './use-terminal-polling.js'
export type { TerminalDockInjected, TerminalPanelProps } from './terminal-dock.types.js'

/**
 * 不依赖 slot plumbing 的 panel body，便于测试直接渲染。
 * @param props - conversation、Host 操作和 locale seat。
 * @returns panel；当前 conversation 没有 terminal 时返回空。
 */
export function TerminalPanel(props: TerminalPanelProps) {
  const {
    translate, collapsed, setCollapsed, terminals, selected, selectTerminal, draft, setDraft,
    note, pending, screenRef, onScroll, send, interrupt, onKeyDown, current, summary, body,
  } = useTerminalPanel(props)

  // 本 conversation 从未打开 terminal：完全不显示 panel。composer 上方的永久空框会浪费垂直空间。
  if (terminals.length === 0) return null

  return (
    <section style={rootStyle} aria-label={translate('title')} data-dsh-terminal-panel="">
      <style>{inputStyles}</style>
      <button
        type="button"
        style={headerStyle}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(value => !value) }}
      >
        {/* dsh dock card 都用 outline glyph 开头、用共用 disclosure chevron 结束；收起向上、展开向下。 */}
        <span aria-hidden style={leadStyle}><IconApiOutline14 /></span>
        <span style={titleStyle}>{translate('title')}</span>
        <span style={summaryStyle}><span style={summaryTextStyle}>{summary}</span></span>
        <span aria-hidden style={chevronStyle}>
          {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>

      {!collapsed && (
        <div style={bodyStyle}>
          {terminals.length > 1 && (
            <div style={tabsStyle} role="tablist">
              {terminals.map(entry => (
                <Pill
                  key={entry.id}
                  role="tab"
                  aria-selected={entry.id === selected}
                  active={entry.id === selected}
                  style={entry.id === selected ? undefined : { fontFamily: MONO }}
                  onClick={() => { selectTerminal(entry.id) }}
                >
                  {terminalLabel(entry)}
                </Pill>
              ))}
            </div>
          )}

          <pre ref={screenRef} style={screenStyle} onScroll={onScroll} data-dsh-terminal-screen="">
            {body}
          </pre>

          {current !== undefined && current.running
            ? (
                <div style={inputRowStyle}>
                  <input
                    className={inputClass}
                    type="password"
                    value={draft}
                    aria-label={translate('inputLabel')}
                    placeholder={translate('inputPlaceholder')}
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    disabled={pending !== undefined}
                    onChange={event => { setDraft(event.target.value) }}
                    onKeyDown={onKeyDown}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== undefined || props.actions?.onSend === undefined}
                    onClick={() => { send(draft, true) }}
                  >
                    {draft === '' ? translate('sendEmpty') : translate('send')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending !== undefined || props.actions?.onInterrupt === undefined}
                    onClick={interrupt}
                  >
                    {pending === 'interrupt' ? translate('interrupting') : translate('interrupt')}
                  </Button>
                </div>
              )
            : <div style={noteStyle}>{translate('exitedHint')}</div>}

          {note !== undefined && <div style={note.bad ? errorStyle : noteStyle}>{note.text}</div>}
          <div style={noteStyle}>{translate('hint')}</div>
        </div>
      )}
    </section>
  )
}
