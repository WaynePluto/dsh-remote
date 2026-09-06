import { describe, expect, it } from 'vitest'
import {
  LOG_DIALOG_CHROME_PX, LOG_DIALOG_HEIGHT, LOG_PATH_MIN_HEIGHT_PX, logDialogRule, logDialogWidth,
} from '../src/client/log-dialog.js'
import { en, fill, zh } from '../src/client/locales.js'

/**
 * The browser half's testable seams.
 *
 * Rendering is not exercised here (this package runs vitest on the `node`
 * environment, with no DOM), and `ServicesDock.tsx` cannot even be imported —
 * it pulls in `@deepseek-ai/dsh-client-ui-primitives`, whose published package
 * ships CSS a Node-environment loader refuses. That is exactly why the pure
 * parts live in `log-dialog.ts`.
 *
 * What is covered is the part that fails SILENTLY: a CSS custom property whose
 * name disagrees between the writer and the rule that reads it does not throw —
 * it just pins the dialog at its fallback width forever, which is the
 * invisible-CSS failure mode this repository keeps rediscovering.
 */

describe('log dialog width', () => {
  it('takes 80% of the measured panel, which dsh builds to the message width', () => {
    // dsh builds every dock card to the shared content width W
    // (`ConversationRoot.module.css:9-12`), so measuring our own card is how
    // "80% of the conversation message width" is obtained without reading a
    // variable the body-portaled dialog cannot see.
    expect(logDialogWidth(800)).toBe(640)
    expect(logDialogWidth(1000)).toBe(800)
  })

  it('falls back to a usable width when the panel has not been measured', () => {
    expect(logDialogWidth(0)).toBe(620)
    expect(logDialogWidth(-1)).toBe(620)
  })
})

describe('log dialog stylesheet', () => {
  const rule = logDialogRule()

  it('reads exactly the custom property the panel writes', () => {
    // The one assertion that matters: writer and reader must agree on the name.
    // Both sides derive it from the same constant, and this locks that they do.
    const declared = /var\((--[\w-]+)/u.exec(rule)?.[1]
    expect(declared).toBe('--dsh-services-log-width')
    expect(rule).toContain('.dsh-services-log-dialog{')
  })

  it('carries a fallback, so a missing property degrades to a readable width', () => {
    expect(rule).toContain('620px')
  })

  it('wins over dsh\'s equal-specificity .dialog rule regardless of insert order', () => {
    // dsh's card is `width: min(380px, 100%)` on a class of the same
    // specificity; without !important the winner would depend on which
    // stylesheet was appended last.
    expect(rule).toContain('width:min(')
    expect(rule).toContain('!important')
  })

  it('never lets the dialog exceed the viewport', () => {
    expect(rule).toContain('max-width:100%')
  })
})

describe('log dialog height', () => {
  it('is a FIXED height, so the card does not resize when the log lands', () => {
    // With `max-height` the box grew to its content: the dialog opened small on
    // "loading…" and jumped to full size the moment the Host answered.
    expect(LOG_DIALOG_HEIGHT).toContain('60vh')
  })

  it('reserves the path line too, the second thing that arrived late', () => {
    expect(LOG_PATH_MIN_HEIGHT_PX).toBeGreaterThan(0)
  })

  it('still clamps to the viewport, which a fixed height needs even more', () => {
    // dsh's `.root` is position:fixed + align-items:center and its `.dialog`
    // has no max-height, so an overflowing card is clipped at BOTH ends with
    // the top unreachable — there is nothing to scroll. A bare `60vh` does
    // exactly that below ~555px of viewport height.
    expect(LOG_DIALOG_HEIGHT).toContain('min(')
    expect(LOG_DIALOG_HEIGHT).toContain(`100vh - ${String(LOG_DIALOG_CHROME_PX)}px`)
  })

  it('reserves more than the chrome dsh actually spends', () => {
    // 62 header + 20 body margin + 24 path line + 20 gap + 24 footer
    // + 24 dialog padding-bottom + 48 root padding = 222.
    const measuredChrome = 62 + 20 + 24 + 20 + 24 + 24 + 48
    expect(measuredChrome).toBe(222)
    expect(LOG_DIALOG_CHROME_PX).toBeGreaterThanOrEqual(measuredChrome)
  })

  it('leaves the card fitting at every viewport height', () => {
    // With the cap in place, body + chrome never exceeds the viewport.
    for (const viewport of [360, 480, 555, 720, 900, 1440]) {
      const body = Math.min(0.6 * viewport, viewport - LOG_DIALOG_CHROME_PX)
      expect(body + 222).toBeLessThanOrEqual(viewport)
    }
  })
})

describe('copy', () => {
  it('keeps both dictionaries on the same key set', () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort())
  })

  it('fills placeholders and leaves unknown ones written', () => {
    expect(fill(en.summaryRunning, { count: 3 })).toBe('3 running')
    expect(fill(zh.logTitle, { name: 'demo-web' })).toBe('demo-web 的日志')
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}')
  })

  it('has no copy left over from the removed stopped-services strip', () => {
    // The panel now hides entirely when nothing runs, so these keys must be
    // gone rather than lingering as dead translations.
    for (const key of ['summaryNone', 'summaryStopped', 'stoppedHint', 'hideLogs']) {
      expect(Object.keys(en)).not.toContain(key)
    }
  })
})
