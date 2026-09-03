/**
 * Collapse a fold's rows without touching a single React-owned node.
 *
 * WHY A STYLESHEET AND NOT THE DOM. The rows this plugin folds belong to dsh:
 * they are `ChatNodeSeat` wrappers, mounted and reconciled by dsh's transcript.
 * Writing an attribute on them would work right up until dsh re-rendered that
 * seat — `useSearchableHidden` sets and CLEARS `hidden` on exactly those
 * wrappers (`packages/client/ui-chat/src/client/chat/searchable-hidden.ts`), so
 * an attribute-based fold would be racing dsh's own layout effect for the same
 * element. A stylesheet keyed by the identity dsh already prints on each
 * wrapper (`data-chat-flow-key`, ChatNodeSeat.tsx:129) has no such race: this
 * module owns one `<style>` element and nothing else.
 *
 * WHY NOT `display: none`. dsh finds the reader's position by binary-searching
 * the ordered rows for the first one whose bottom is below the viewport top
 * (`ChatView.tsx:93-104`). `display: none` gives a row an all-zero rect, which
 * breaks the ordering that search assumes and can restore the wrong scroll
 * position after paging. Collapsing to zero height instead keeps every row's
 * top monotonic, so the search still lands where it should — and
 * `content-visibility: hidden` still skips the layout and paint work of the
 * hidden subtree, which is the whole point on a turn with sixty tool cards.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/hidden-rows
 */

/** Attribute dsh prints on every Chat node wrapper, carrying the node key. */
export const FLOW_KEY_ATTRIBUTE = 'data-chat-flow-key'

/** Marker attribute set on this module's own `<style>`, for diagnostics. */
export const STYLE_MARKER = 'data-dsh-plugin-exec-process'

/**
 * The declarations that collapse one folded row.
 *
 * `!important` throughout because the column's own spacing rule
 * (`.column > :not([hidden])… ~ :not([hidden])…` in ChatView.module.css) has a
 * specificity of 0-7-0 and would otherwise keep a 16px gap for every hidden
 * row — sixty of them would leave a thousand-pixel blank where the fold is.
 */
const COLLAPSED_DECLARATIONS = [
  'height:0!important',
  'min-height:0!important',
  'margin:0!important',
  'padding:0!important',
  'border-width:0!important',
  'overflow:hidden!important',
  'pointer-events:none!important',
  'content-visibility:hidden',
].join(';')

/**
 * dsh's own marker on a reasoning row (`ReasoningRow.tsx:33`).
 *
 * A semantic attribute rather than a hashed CSS-module class, so it survives a
 * rebuild of dsh's stylesheets; only a rename of the variant itself would break
 * it, and the failure mode is a thinking box that stops hiding.
 */
export const THINK_SELECTOR = '[data-variant="think"]'

/**
 * Escape one attribute value for a double-quoted CSS attribute selector.
 * @param value - the raw `data-chat-flow-key` value.
 * @returns the value with `\` and `"` escaped.
 */
export function escapeAttributeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

/**
 * @param key - Chat node key.
 * @returns the attribute selector matching that row's wrapper.
 */
export function flowKeySelector(key: string): string {
  return `[${FLOW_KEY_ATTRIBUTE}="${escapeAttributeValue(key)}"]`
}

/**
 * Build the stylesheet text for one fold.
 *
 * Two kinds of rule, because a fold hides two kinds of thing. Whole rows are
 * the process itself. The second kind exists because the row that CLOSES a
 * segment — a formal message, or the turn's finalized answer — stays visible
 * while the thinking printed inside it does not: that reasoning is the last
 * step of the work, not part of the answer. dsh draws exactly the same line
 * (`AssistantNodeView.tsx:23-27` hides inline reasoning while its own fold is
 * closed) and simply never reaches it in a long session.
 *
 * `display:none` is right here and wrong for a row: this is an element INSIDE a
 * row, so it never disturbs the ordered row rects dsh binary-searches, and only
 * `display:none` also removes the 16px flex gap dsh's assistant body would keep
 * for an empty box.
 *
 * @param keys - Chat node keys whose entire row collapses, in any order.
 * @param reasoningKeys - Chat node keys whose inline thinking collapses.
 * @returns CSS text; the empty string when there is nothing to collapse.
 */
export function collapsedRowsCss(
  keys: readonly string[],
  reasoningKeys: readonly string[] = [],
): string {
  const rules: string[] = []
  if (keys.length > 0) {
    rules.push(`${keys.map(flowKeySelector).join(',\n')} {\n  ${COLLAPSED_DECLARATIONS};\n}`)
  }
  if (reasoningKeys.length > 0) {
    const scopes = reasoningKeys.map(flowKeySelector)
    // The wrapper carries the gap, so hide the wrapper where `:has()` exists.
    rules.push(`${scopes.map(scope => `${scope} div:has(> ${THINK_SELECTOR})`).join(',\n')} {\n  display:none!important;\n}`)
    // Independent rule, therefore an independent parse: a browser without
    // `:has()` drops only the rule above and still hides the box itself.
    rules.push(`${scopes.map(scope => `${scope} ${THINK_SELECTOR}`).join(',\n')} {\n  display:none!important;\n}`)
  }
  return rules.join('\n\n')
}

/** The document surface this controller needs; narrowed so tests can fake it. */
export interface StyleHost {
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  readonly head: { append(node: never): void } | { appendChild(node: never): void }
}

/** One live fold registration keyed by an owner id. */
export interface CollapsedRowsController {
  /**
   * Publish what one owner currently collapses.
   * @param owner - stable owner id (one per session, turn and segment).
   * @param keys - node keys whose entire row collapses; empty clears them.
   * @param reasoningKeys - node keys whose inline thinking collapses.
   */
  set(owner: string, keys: readonly string[], reasoningKeys?: readonly string[]): void
  /**
   * Drop one owner's registration.
   * @param owner - the owner id passed to {@link CollapsedRowsController.set}.
   */
  clear(owner: string): void
  /** Remove the stylesheet and forget every owner. */
  dispose(): void
  /** @returns the CSS currently installed; for tests and diagnostics. */
  css(): string
}

/** What one owner hides. */
interface OwnerEntry {
  readonly rows: readonly string[]
  readonly reasoning: readonly string[]
}

/**
 * @param left - the entry already registered, when any.
 * @param right - the entry being registered.
 * @returns whether both hide exactly the same keys in the same order.
 */
function sameEntry(left: OwnerEntry | undefined, right: OwnerEntry): boolean {
  return left !== undefined
    && left.rows.length === right.rows.length
    && left.reasoning.length === right.reasoning.length
    && left.rows.every((key, index) => key === right.rows[index])
    && left.reasoning.every((key, index) => key === right.reasoning[index])
}

/**
 * Create the single stylesheet every「执行过程」row writes its fold into.
 *
 * One element for all folds rather than one per row: a session with forty
 * turns would otherwise add forty `<style>` nodes to `<head>`, and the browser
 * re-resolves style against all of them on every toggle.
 *
 * @param host - the document; injected so tests need no DOM.
 * @returns the controller, or a no-op one when there is no document.
 */
export function createCollapsedRowsController(host: StyleHost | undefined): CollapsedRowsController {
  if (host === undefined) {
    return { set: () => {}, clear: () => {}, dispose: () => {}, css: () => '' }
  }
  const element = host.createElement('style')
  element.setAttribute(STYLE_MARKER, '')
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)

  const owners = new Map<string, OwnerEntry>()
  let text = ''

  const render = (): void => {
    const rows: string[] = []
    const reasoning: string[] = []
    for (const entry of owners.values()) {
      rows.push(...entry.rows)
      reasoning.push(...entry.reasoning)
    }
    const next = collapsedRowsCss(rows, reasoning)
    if (next === text) return
    text = next
    element.textContent = next
  }

  return {
    set: (owner, keys, reasoningKeys = []) => {
      if (keys.length === 0 && reasoningKeys.length === 0) {
        if (owners.delete(owner)) render()
        return
      }
      const next: OwnerEntry = { rows: [...keys], reasoning: [...reasoningKeys] }
      // A streaming turn republishes its node list on every animation frame;
      // without this the sheet would be rebuilt sixty times a second only to
      // find it had not changed.
      if (sameEntry(owners.get(owner), next)) return
      owners.set(owner, next)
      render()
    },
    clear: (owner) => {
      if (owners.delete(owner)) render()
    },
    dispose: () => {
      owners.clear()
      text = ''
      element.remove()
    },
    css: () => text,
  }
}
