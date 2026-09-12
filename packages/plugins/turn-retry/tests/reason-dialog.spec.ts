import { describe, expect, it } from 'vitest'
import { assertDialogGeometry } from '@dsh-remote/plugin-ui/test'
import {
  applyReasonDialogMove,
  applyReasonDialogResize,
  publishReasonDialogWidth,
  REASON_DIALOG_BODY_HEIGHT_PROP,
  REASON_DIALOG_CHROME_PX,
  REASON_DIALOG_CLASS,
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
