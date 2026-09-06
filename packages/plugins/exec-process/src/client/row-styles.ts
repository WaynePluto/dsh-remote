/**
 * The row's own chrome, as one static stylesheet.
 *
 * A real stylesheet rather than inline styles because the row needs `:hover`,
 * `:focus-visible`, a rotating chevron, a pulsing running dot and a
 * `prefers-reduced-motion` opt-out — none of which a `style` attribute can
 * express. This plugin's browser bundle carries no CSS pipeline (dsh's client
 * module loader takes one JS artifact), so the sheet is a string installed at
 * apply time and removed with the fiber.
 *
 * EVERY COLOUR AND METRIC COMES FROM dsh's OWN LADDER. The row is a rounded
 * outline in dsh's `--dsw-alias-border-l2`, the same hairline colour its
 * `turn-process` control uses, and its text rides dsh's SECONDARY font axis
 * (`--dsh-content-font-size-secondary`, `gradient-shadow-text.css:56`) — the
 * "one step under the body" tier every flow-row title and summary uses. Riding
 * that axis rather than hard-coding 13px is what keeps the row in proportion
 * when the reader changes the transcript font size in settings.
 *
 * ⚠ Theme variable names are checked against dsh's token set: a misspelled
 * `--dsw-*` does not fail, it silently falls back to the literal after the
 * comma (docs/02 §8.6). Every fallback here is therefore a sane value on its
 * own, not a placeholder.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/row-styles
 */

/** Class prefix owned by this plugin; namespaced so nothing can collide. */
export const ROW_CLASS = 'dshx-exec-process'

/** Marker attribute set on this module's `<style>`, for diagnostics. */
export const ROW_STYLE_MARKER = 'data-dsh-plugin-exec-process-chrome'

/**
 * The stylesheet text.
 * @returns CSS for the row, its fields, its chevron and its running dot.
 */
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
  /*
   * A closed outline rather than dsh's single hairline: a lone bottom line
   * reads as "the end of the message above" and left the process summary
   * visually glued to the agent's own words. The box is the smallest chrome
   * that says "this is a control, not prose".
   */
  border: 0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28));
  border-radius: 8px;
  /*
   * Opaque, always: this element is also what the reader sees while the row is
   * stuck to the top of the scroller, and a transparent sticky lets the
   * content scrolling underneath show straight through it. Hover therefore
   * moves the BORDER and the text, never the background.
   */
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

/*
 * STICKING LIVES IN ./sticky-push.ts, NOT HERE.
 *
 * An expanded segment can be dozens of rows tall and this header is the only
 * control that closes it, so without sticking "collapse again" means scrolling
 * all the way back up to find it. But a plain sticky rule would pin it for the
 * rest of the conversation: a sticky element is released by the bottom of its
 * containing block, and this header's containing block is the whole message
 * column, not the segment it summarizes. Releasing it on time needs a measured
 * offset per frame, so the whole sticky rule is published there instead — as
 * one rule per open header, keyed by the wrapper's own data-chat-flow-key.
 *
 * What stays here is the consequence for THIS element: while stuck it is what
 * the reader sees over the scrolling transcript, so its background must be
 * opaque and hover may move the border and the text but never the background.
 */

.${ROW_CLASS}__label {
  flex: 0 0 auto;
  white-space: nowrap;
}

/* Keep the complete count summary at its intrinsic width on an ordinary row.
   It may shrink only when the fixed label, summary and trailing indicators are
   themselves wider than the row; min-width:0 then prevents narrow viewports
   from overflowing and gives that exceptional case an ellipsis. */
.${ROW_CLASS}__status {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* The action starts at a zero flex basis and grows into whatever remains after
   the fixed label and intrinsic-width summary. It is therefore the first and,
   in everyday layouts, only field that loses characters. */
.${ROW_CLASS}__action {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--dsw-alias-label-tertiary, #9ca3af);
}

/*
 * Still running.
 *
 * The dot is a SIBLING of the text rather than a generated box inside it, and
 * that is the whole point: as a flex item of the row it is centred
 * geometrically by the row's own align-items, while a generated inline box
 * could only be placed against the text baseline plus half the LATIN
 * x-height - visibly high next to CJK glyphs. Leaving the text alone in its own
 * element also keeps its ellipsis, which making that element a flex container
 * would have silently killed.
 *
 * The field also steps up one colour tier: "what it is doing now" outranks
 * "what it did last".
 */
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

/** The document surface this installer needs; narrowed so tests can fake it. */
export interface StyleHost {
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  readonly head: unknown
}

/**
 * Install the row stylesheet for as long as the caller keeps it.
 * @param host - the document; `undefined` outside a browser.
 * @returns a disposer removing the sheet.
 */
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
