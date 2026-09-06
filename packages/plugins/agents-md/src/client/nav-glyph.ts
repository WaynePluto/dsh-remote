/**
 * Give the Global instructions settings page a document glyph instead of the
 * generic gear.
 *
 * dsh's settings shell picks the nav glyph from a hardcoded id → icon map and
 * falls back to the gear for every id it does not know — `navIcon` in
 * `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:27-31` knows
 * exactly `models`, `agent-presets` and `plugins` — and a `settings.section`
 * registration carries only `id` / `order` / `label`. There is no seam for a
 * plugin page to state its own glyph (docs/02 §8.7).
 *
 * The mechanism is the one `packages/plugins/proxy` established and
 * `packages/plugins/notify` refined:
 *
 * - the only DOM write is one `data-` attribute on our own nav button. React
 *   sets and clears the attributes it rendered; one it never rendered survives
 *   every re-render, so nothing here fights the shell's reconciliation.
 * - the whole visual swap lives in a stylesheet: the fallback `<svg>` is hidden
 *   and the button's `::before` paints the glyph as a mask filled with
 *   `currentColor`, so hover / active / dark mode keep working unchanged.
 * - the observer only wakes for an added element whose class names look like
 *   the settings overlay, so a streaming conversation does not pay for it.
 *
 * ⚠️ SIZE. The paths span x 2.75–13.25 and y 1.75–14.25 of the 16×16 box,
 * matching how full dsh's own `IconAlarmClockOutline16` sits (x 1.75–14.25,
 * y 2.5–13.75). A glyph drawn smaller looks fine on its own and visibly
 * shrunken beside its neighbours in the same 16px slot — which is the mistake
 * the bell in `notify` had to be redrawn for.
 *
 * This is coupled to dsh's DOM, deliberately and visibly: it matches the
 * shell's CSS-module class names by suffix. If a dsh upgrade renames or
 * restructures them, the row simply keeps its gear — degraded, never broken.
 *
 * @module @dsh-remote/dsh-plugin-agents-md/client/nav-glyph
 */

import { en, zh } from './locales.js'

/**
 * A document with lines of text on it: the page outline with a folded corner,
 * the fold itself, and three text rules.
 *
 * Drawn rather than imported because a value import of dsh's primitives package
 * is not available to an out-of-tree client bundle (it is not in the browser
 * module table).
 */
const DOCUMENT = [
  { d: 'M9.25 1.75H4.75a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h6.5a1 1 0 0 0 1-1V4.75Z', join: true },
  { d: 'M9.25 1.75v3h3', join: true },
  { d: 'M6 8h4', join: false },
  { d: 'M6 10.5h4', join: false },
  { d: 'M6 5.5h1.5', join: false },
] as const

/** The attribute this module writes on our nav button, and its hook. */
const MARKER = 'data-dsh-plugin-agents-md-nav'

/** Nav button and its label, matched by CSS-module local name. */
const CELL = `button[class*="_navCell"]:not([${MARKER}])`
const LABEL = '[class*="_navLabel"]'

/** Every spelling this plugin registers as its nav label, in any locale. */
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])

/** Class-name fragments worth a rescan: the settings overlay and its cells. */
const INTERESTING = ['_overlay', '_navCell']

/**
 * The stylesheet that does the swap.
 * @returns CSS text, with the glyph inlined as a mask image.
 */
export function stylesheet(): string {
  // Painted black rather than `currentColor`: a mask image has no inherited
  // colour to resolve against, and only the alpha of what is painted matters —
  // the visible colour comes from `background-color` below.
  const paths = DOCUMENT.map(({ d, join }) =>
    `<path d="${d}" fill="none" stroke="#000" stroke-width="1.25" stroke-linecap="round"`
    + `${join ? ' stroke-linejoin="round"' : ''}/>`).join('')
  // width/height are stated so the mask has an intrinsic size in every engine;
  // mask-size below scales it into the 16px slot the shell's own glyphs fill.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">${paths}</svg>`
  // encodeURIComponent escapes every character CSS would otherwise end the
  // url() on ('"', '#', '<'), so the quoting below needs no further care.
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / 16px 16px no-repeat`
  return [
    `[${MARKER}] > svg { display: none; }`,
    `[${MARKER}]::before {`,
    '  content: "";',
    '  flex: none;',
    '  width: 16px;',
    '  height: 16px;',
    '  background-color: currentColor;',
    `  -webkit-mask: ${mask};`,
    `  mask: ${mask};`,
    '}',
  ].join('\n')
}

/**
 * Paint the glyph on our nav row for as long as the caller keeps it.
 * @returns a disposer that removes the stylesheet, the observer, and the
 * attribute — the row is back to dsh's own fallback gear afterwards.
 */
export function installNavGlyph(): () => void {
  /* v8 ignore next -- the host-side test program has no DOM */
  if (typeof document === 'undefined') return () => {}

  const style = document.createElement('style')
  style.textContent = stylesheet()
  document.head.append(style)

  let frame: number | undefined

  /** Mark every not-yet-marked nav cell that carries one of our labels. */
  const mark = (): void => {
    frame = undefined
    for (const cell of document.querySelectorAll(CELL)) {
      const text = cell.querySelector(LABEL)?.textContent ?? ''
      if (LABELS.has(text)) cell.setAttribute(MARKER, '')
    }
  }

  // The panel mounts inside a React commit; reading it in the next frame keeps
  // the scan off the mutation callback and collapses a burst into one pass.
  const schedule = (): void => {
    if (frame === undefined) frame = window.requestAnimationFrame(mark)
  }

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (!INTERESTING.some(fragment => node.className.includes(fragment))) continue
        schedule()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  // The panel may already be open — a plugin reload while settings is up.
  mark()

  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    style.remove()
    for (const cell of document.querySelectorAll(`[${MARKER}]`)) cell.removeAttribute(MARKER)
  }
}
