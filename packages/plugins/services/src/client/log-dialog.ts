/**
 * Widening dsh's `Modal` for the log view.
 *
 * A module of its own, deliberately: it imports nothing but the DOM, so the
 * pure parts stay unit-testable. `ServicesDock.tsx` cannot be imported from a
 * test at all — it pulls in `@deepseek-ai/dsh-client-ui-primitives`, whose real
 * package ships CSS that a Node-environment vitest cannot load.
 *
 * ⚠️ WHY THIS IS NOT ONE LINE OF CSS. dsh's dialog card is
 * `width: min(380px, 100%)` (`ui-primitives/src/Modal.module.css:28`), which is
 * right for a confirm box and far too narrow for a dev server's output. The
 * obvious fix — `calc(var(--dsh-chat-content-width) * 0.8)` — does NOT work:
 * that variable is declared on the Conversation root
 * (`ui-conversation/.../ConversationRoot.module.css:28`), while `Modal` portals
 * its card to `document.body`, which is OUTSIDE that subtree and therefore
 * never inherits it. Copying the variable across does not help either, because
 * its value is a `clamp()` over a second root-scoped variable that would
 * collapse to its `0px` fallback and silently pin the width at the 680px floor.
 *
 * So the width is MEASURED instead. The panel is itself a dock card, and dsh
 * builds dock cards to exactly the shared message width W
 * (`ConversationRoot.module.css:9-12` — "one content width W … for the
 * transcript, the dock cards …"), so measuring our own box yields W. Measuring
 * at open time also keeps it correct after the sidebar collapses or the user
 * drags the width handles.
 *
 * The value then travels as a custom property on `<html>`, read by one injected
 * stylesheet — the same shape `exec-process` uses — so this never writes an
 * attribute or an inline style onto a node React owns.
 *
 * This module holds only the DOM-FREE half (constants, the width arithmetic and
 * the rule text) so a unit test can import it; the two calls that touch
 * `document` live in `ServicesDock.tsx`, which compiles in the browser program.
 *
 * @module @dsh-remote/dsh-plugin-services/client/log-dialog
 */

/** How wide the dialog is, as a fraction of the conversation's message width. */
export const LOG_DIALOG_RATIO = 0.8

/** Width used when the panel has not been measured yet. */
export const LOG_DIALOG_FALLBACK_PX = 620

/** The class this plugin puts on dsh's dialog card. */
export const LOG_DIALOG_CLASS = 'dsh-services-log-dialog'

/** The custom property carrying the measured width to the stylesheet. */
export const LOG_DIALOG_WIDTH_PROP = '--dsh-services-log-width'

/**
 * Everything the dialog spends on height BESIDES the log body, in px.
 *
 * Measured off dsh's own `Modal.module.css`, because the log body is the only
 * part this plugin controls and it has to leave room for the rest:
 *
 * | part                                   | px |
 * |----------------------------------------|----|
 * | `.header` 22 + 28 (close button) + 12  | 62 |
 * | `.body` `margin-top`                   | 20 |
 * | the log file path line above the body  | 24 |
 * | `.dialog` `gap` before the footer      | 20 |
 * | footer button                          | 24 |
 * | `.dialog` `padding-bottom`             | 24 |
 * | `.root` `padding` 24 top + 24 bottom   | 48 |
 *
 * That is 222; the constant rounds up to 240 so a font-size change or one more
 * line of chrome does not immediately reintroduce the overflow.
 */
export const LOG_DIALOG_CHROME_PX = 240

/**
 * The log body's FIXED height.
 *
 * Fixed, not `max-height`, and that is the whole point: with a maximum the box
 * grows to its content, so the dialog opened small on "loading…" and then jumped
 * to full size the instant the log arrived. A constant height means the card is
 * the same size from the first frame — the reason {@link LOG_PATH_MIN_HEIGHT_PX}
 * exists too, since the path line was the second thing appearing late.
 *
 * ⚠️ THE `min()` IS NOT DECORATION, and a fixed height makes it matter MORE
 * than it did for a maximum: `60vh` alone overflows whenever the viewport is
 * under ~555px tall (`60vh + 222 > 100vh`) — a laptop in a vertical split, or a
 * phone held sideways. An overflowing dialog here is not merely ugly: dsh's
 * `.root` is `position: fixed` with `align-items: center` and its `.dialog`
 * declares no `max-height`, so the card is clipped at BOTH ends and **the top
 * becomes unreachable** — there is nothing to scroll. The second term keeps the
 * card fitting at every viewport height.
 */
export const LOG_DIALOG_HEIGHT = `min(60vh, calc(100vh - ${String(LOG_DIALOG_CHROME_PX)}px))`

/**
 * Height reserved for the log-path line while the log is still loading.
 *
 * The path is only known once the Host answers, so without a reserved box the
 * dialog gains a line mid-flight — the same jump the fixed body height removes.
 */
export const LOG_PATH_MIN_HEIGHT_PX = 16

/**
 * The width the dialog should take for a measured panel box.
 *
 * Pure, so the ratio and the unmeasured fallback are testable without a layout
 * engine.
 * @param measured - the panel's rendered width in px; 0 when unmeasured.
 * @returns the dialog width in px.
 */
export function logDialogWidth(measured: number): number {
  return measured > 0 ? measured * LOG_DIALOG_RATIO : LOG_DIALOG_FALLBACK_PX
}

/**
 * The one CSS rule that widens dsh's dialog card.
 *
 * Split from {@link installLogDialogStyles} so a test can assert it without a
 * DOM. What that test really guards is that the property name here and the one
 * {@link publishLogDialogWidth} writes are the SAME string: a typo would not
 * throw, it would silently pin the dialog at the fallback width forever.
 *
 * `!important` because dsh's `.dialog` and this class have equal specificity,
 * so the winner would otherwise depend on stylesheet insertion order — not
 * something a plugin should bet on.
 * @returns the stylesheet text.
 */
export function logDialogRule(): string {
  return `.${LOG_DIALOG_CLASS}{`
    + `width:min(var(${LOG_DIALOG_WIDTH_PROP}, ${String(LOG_DIALOG_FALLBACK_PX)}px), 100%)!important;`
    + 'max-width:100%!important}'
}

/**
 * Publish the measured width for the stylesheet to read.
 *
 * ⚠️ DOM-FREE ON PURPOSE. The two functions that actually touch `document`
 * live in `ServicesDock.tsx` instead, because this module is imported by a unit
 * test and therefore compiles in the HOST program — which has no `DOM` lib and
 * should not gain one just to typecheck a stylesheet string. Keeping the pure
 * half here is what makes the property-name agreement testable at all.
 * @param setProperty - the `<html>` style setter, injected by the caller.
 * @param width - the dialog width in px.
 */
export function publishLogDialogWidth(
  setProperty: (name: string, value: string) => void,
  width: number,
): void {
  setProperty(LOG_DIALOG_WIDTH_PROP, `${String(Math.round(width))}px`)
}
