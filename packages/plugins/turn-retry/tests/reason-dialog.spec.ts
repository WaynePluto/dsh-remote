import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dialogFullscreenGeometry } from '@dsh-remote/plugin-ui'
import { assertDialogGeometry } from '@dsh-remote/plugin-ui/test'
import {
  applyReasonDialogMove,
  applyReasonDialogResize,
  publishReasonDialogWidth,
  REASON_DIALOG_BODY_HEIGHT_PROP,
  REASON_DIALOG_CHROME_PX,
  REASON_DIALOG_CLASS,
  REASON_DIALOG_FULLSCREEN_ATTR,
  REASON_DIALOG_FULLSCREEN_RIGHT_PX,
  REASON_DIALOG_FULLSCREEN_TOP_PX,
  REASON_DIALOG_HEIGHT,
  REASON_DIALOG_WIDTH_PROP,
  reasonDialogMoveBounds,
  reasonDialogResizeBounds,
  reasonDialogRule,
  reasonDialogWidth,
} from '../src/client/reason-dialog.js'
describe('retry reason dialog', () => {
  it('uses the services log dialog dimensions', () => {
    expect(reasonDialogWidth(800)).toBe(640)
    expect(reasonDialogWidth(0)).toBe(620)
    expect(REASON_DIALOG_HEIGHT).toBe('min(60vh, calc(100vh - ' + String(REASON_DIALOG_CHROME_PX) + 'px))')
  })
  it('publishes and reads the same width property', () => {
    const properties = new Map<string, string>()
    publishReasonDialogWidth((name, value) => {
      properties.set(name, value)
    }, 641.6)
    expect(properties.get(REASON_DIALOG_WIDTH_PROP)).toBe('642px')
    const rule = reasonDialogRule()
    expect(rule).toContain('.' + REASON_DIALOG_CLASS + '{')
    expect(rule).toContain('var(' + REASON_DIALOG_WIDTH_PROP)
    expect(rule).toContain(REASON_DIALOG_BODY_HEIGHT_PROP)
    expect(rule).toContain('!important')
  })
})
describe('reason dialog fullscreen', () => {
  it('maximizes the card inside the root padding and re-centers it', () => {
    const chrome = 174
    const geometry = dialogFullscreenGeometry(1920, 1080, chrome, 24, 300, 110)
    expect(geometry).toEqual({ width: 1920 - 48, bodyHeight: 1080 - 48 - chrome, offsetX: 0, offsetY: 0 })
  })
  it('ships the toggle button rule with a hover state on the dialog token', () => {
    const rule = reasonDialogRule()
    expect(rule).toContain('[' + REASON_DIALOG_FULLSCREEN_ATTR + ']{')
    expect(rule).toContain('[' + REASON_DIALOG_FULLSCREEN_ATTR + ']:hover')
    expect(rule).toContain('--dsw-alias-interactive-bg-hover')
  })
  it('places the toggle beside the Modal close button (header pad 22 + 14 + 28 + 8)', () => {
    expect(REASON_DIALOG_FULLSCREEN_TOP_PX).toBe(22)
    expect(REASON_DIALOG_FULLSCREEN_RIGHT_PX).toBe(50)
  })
  it('renders the public toggle and hides drag handles while fullscreen', () => {
    const source = readFileSync(new URL('../src/client/RetryDock.tsx', import.meta.url), 'utf8')
    expect(source).toContain('IconFullscreenOutline16')
    expect(source).toContain('DialogFullscreenButton')
    expect(source).toContain('dataAttribute={REASON_DIALOG_FULLSCREEN_ATTR}')
    expect(source).toMatch(/\{!reasonFullscreen && <ReasonMoveHandle/u)
    expect(source).toMatch(/\{!reasonFullscreen && \['n', 'ne'/u)
  })
})
describe('shared dialog geometry', () => {
  it('keeps the turn-retry adapter aligned with the shared contract', () => {
    assertDialogGeometry({
      expect,
      applyResize: applyReasonDialogResize,
      resizeBounds: reasonDialogResizeBounds,
      applyMove: (start, dx, dy, bounds) => applyReasonDialogMove(start, dx, dy, bounds as never),
      moveBounds: reasonDialogMoveBounds,
    }, ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const)
  })
})
