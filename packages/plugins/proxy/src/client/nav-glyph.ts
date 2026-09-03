/**
 * Give the Proxy settings page a globe instead of the generic gear.
 *
 * dsh's settings shell picks the nav glyph from a hardcoded id → icon map and
 * falls back to the gear for every id it does not know (`navIcon` in
 * `packages/client/ui-settings-general/src/client/SettingsRoot.tsx`), and a
 * `settings.section` registration carries only `id` / `order` / `label`
 * (`packages/client/ui-settings/src/client/contract/slots.ts`). There is no
 * seam for a plugin page to state its own glyph, so every out-of-tree settings
 * page is a gear next to the four pages dsh drew icons for.
 *
 * The smallest honest workaround, and the reason it is shaped this way:
 *
 * - the only DOM write is one `data-` attribute on our own nav button. React
 *   sets and clears the attributes it rendered; one it never rendered survives
 *   every re-render, so nothing here fights the shell's reconciliation and no
 *   React-owned node has its children rewritten.
 * - the whole visual swap lives in a stylesheet: the fallback `<svg>` is
 *   hidden and the button's `::before` paints dsh's own globe as a mask filled
 *   with `currentColor`, so hover / active / dark mode keep working unchanged.
 * - the observer only wakes for an added element whose class names look like
 *   the settings overlay, so a streaming conversation does not pay for it.
 *
 * This is coupled to dsh's DOM, deliberately and visibly: it matches the
 * shell's CSS-module class names by suffix (lightningcss emits
 * `[hash]_[local]`, so `VOzbGW_navCell` ends with `_navCell`). If a dsh
 * upgrade renames or restructures them, the row simply keeps its gear —
 * degraded, never broken. Re-check it when dsh moves (docs/02 §8.7).
 *
 * @module @dsh-remote/dsh-plugin-proxy/client/nav-glyph
 */

import { en, zh } from './locales.js'

/**
 * dsh's own meridian globe (`ic_ds_globe_outline_14`, viewBox 0 0 14 14),
 * copied as path data so the row reads as part of the product rather than as
 * a foreign icon set. A value import of the primitives package is not
 * available to an out-of-tree client bundle (it is not in the browser module
 * table), and it would be a whole React component for one `d` attribute.
 */
const GLOBE = 'M7.00018 0.353516C10.6708 0.353535 13.6468 3.32958 13.6469 7.00018C13.6468 10.6708 10.6708 13.6468 7.00018 13.6469C3.32957 13.6468 0.353535 10.6708 0.353516 7.00018C0.353535 3.32957 3.32957 0.353531 7.00018 0.353516ZM5.44643 7.59661C5.49463 8.97506 5.70762 10.191 6.02136 11.0793C6.20141 11.5891 6.40328 11.9585 6.59898 12.1889C6.79501 12.4196 6.93213 12.454 7.00018 12.454C7.06822 12.454 7.20533 12.4197 7.40138 12.1889C7.59708 11.9585 7.79895 11.589 7.979 11.0793C8.29274 10.191 8.50574 8.97506 8.55394 7.59661H5.44643ZM1.57861 7.59661C1.80785 9.70467 3.2386 11.4509 5.1715 12.1388C5.07135 11.9317 4.97972 11.7098 4.89746 11.477C4.53084 10.4391 4.30224 9.0828 4.25357 7.59661H1.57861ZM9.74679 7.59661C9.69813 9.0828 9.46952 10.4391 9.1029 11.477C9.0206 11.7099 8.92818 11.9316 8.82797 12.1388C10.7613 11.4511 12.1925 9.70496 12.4218 7.59661H9.74679ZM5.1706 1.8616C3.23814 2.54963 1.80876 4.29604 1.5795 6.40376H4.25357C4.30224 4.91756 4.53083 3.56129 4.89746 2.5234C4.97968 2.29066 5.07051 2.0686 5.1706 1.8616ZM7.00018 1.54637C6.93213 1.54638 6.79503 1.5807 6.59898 1.81145C6.40332 2.04177 6.20139 2.41058 6.02136 2.92012C5.70754 3.80851 5.49461 5.02499 5.44643 6.40376H8.55394C8.50575 5.025 8.29282 3.80851 7.979 2.92012C7.79898 2.41059 7.59705 2.04177 7.40138 1.81145C7.20531 1.58067 7.06823 1.54637 7.00018 1.54637ZM8.82887 1.8616C8.92902 2.0687 9.02064 2.29053 9.1029 2.5234C9.46953 3.56129 9.69812 4.91756 9.74679 6.40376H12.4209C12.1916 4.29575 10.7618 2.54943 8.82887 1.8616Z'

/** The attribute this module writes on the Proxy nav button, and its hook. */
const MARKER = 'data-dsh-plugin-proxy-nav'

/** Nav button and its label, matched by CSS-module local name. */
const CELL = `button[class*="_navCell"]:not([${MARKER}])`
const LABEL = '[class*="_navLabel"]'

/** Every spelling this plugin registers as its nav label, in any locale. */
const LABELS: ReadonlySet<string> = new Set([en.nav, zh.nav])

/** Class-name fragments worth a rescan: the settings overlay and its cells. */
const INTERESTING = ['_overlay', '_navCell']

/**
 * The stylesheet that does the swap.
 * @returns CSS text, with the globe inlined as a mask image.
 */
function stylesheet(): string {
  // width/height are stated so the mask has an intrinsic size in every engine;
  // mask-size below scales it into the 16px slot the shell's own glyphs fill.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14">`
    + `<path fill="#000" fill-rule="evenodd" clip-rule="evenodd" d="${GLOBE}"/></svg>`
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
 * Paint the globe on the Proxy nav row for as long as the caller keeps it.
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
