import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyLogDialogMove,
  applyLogDialogResize,
  LOG_DIALOG_BODY_HEIGHT_PROP,
  LOG_DIALOG_CHROME_PX,
  LOG_DIALOG_FULLSCREEN_ATTR,
  LOG_DIALOG_FULLSCREEN_RIGHT_PX,
  LOG_DIALOG_FULLSCREEN_TOP_PX,
  LOG_DIALOG_HEIGHT,
  LOG_PATH_MIN_HEIGHT_PX,
  logDialogMoveBounds,
  logDialogResizeBounds,
  logDialogRule,
  logDialogWidth,
} from '../src/client/log-dialog.js'
import { dialogFullscreenGeometry } from '@dsh-remote/plugin-ui'
import { en, fill, zh } from '../src/client/locales.js'
import { assertDialogGeometry } from '@dsh-remote/plugin-ui/test'
/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`node`、`ServicesDock.tsx`、`@deepseek-ai/dsh-client-ui-primitives`、`log-dialog.ts`） */
describe('log dialog width', () => {
  it('takes 80% of the measured panel, which dsh builds to the message width', () => {
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`ConversationRoot.module.css:9-12`）
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
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
    // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    const declared = /var\((--[\w-]+)/u.exec(rule)?.[1]
    expect(declared).toBe('--dsh-services-log-width')
    expect(rule).toContain('.dsh-services-log-dialog{')
  })
  it('carries a fallback, so a missing property degrades to a readable width', () => {
    expect(rule).toContain('620px')
  })
  it('wins over dsh\'s equal-specificity .dialog rule regardless of insert order', () => {
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`width: min(380px, 100%)`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 哪张样式表最后追加。
    expect(rule).toContain('width:min(')
    expect(rule).toContain('!important')
  })
  it('never lets the dialog exceed the viewport', () => {
    expect(rule).toContain('max-width:100%')
  })
})
describe('log fullscreen', () => {
  it('maximizes the card inside the root padding and re-centers it', () => {
    const chrome = 174
    const geometry = dialogFullscreenGeometry(1920, 1080, chrome, 24, 300, 110)
    expect(geometry).toEqual({ width: 1920 - 48, bodyHeight: 1080 - 48 - chrome, offsetX: 0, offsetY: 0 })
  })
  it('keeps a minimum readable body height on tiny viewports', () => {
    const geometry = dialogFullscreenGeometry(320, 240, 174, 24, 300, 110)
    expect(geometry.bodyHeight).toBe(110)
    expect(geometry.width).toBe(300)
  })
  it('ships the toggle button rule with a hover state on the dialog token', () => {
    const rule = logDialogRule()
    expect(rule).toContain('[' + LOG_DIALOG_FULLSCREEN_ATTR + ']{')
    expect(rule).toContain('[' + LOG_DIALOG_FULLSCREEN_ATTR + ']:hover')
    expect(rule).toContain('--dsw-alias-interactive-bg-hover')
  })
  it('places the toggle beside the Modal close button (header pad 22 + 14 + 28 + 8)', () => {
    expect(LOG_DIALOG_FULLSCREEN_TOP_PX).toBe(22)
    expect(LOG_DIALOG_FULLSCREEN_RIGHT_PX).toBe(50)
  })
  it('renders the public toggle and hides drag handles while fullscreen', () => {
    const dialogSource = readFileSync(new URL('../src/client/ServiceLogDialog.tsx', import.meta.url), 'utf8')
    expect(dialogSource).toContain('IconFullscreenOutline16')
    expect(dialogSource).toContain('DialogFullscreenButton')
    expect(dialogSource).toContain('dataAttribute={LOG_DIALOG_FULLSCREEN_ATTR}')
    expect(dialogSource).toMatch(/\{!fullscreen && <LogMoveHandle/u)
    expect(dialogSource).toMatch(/\{!fullscreen && directions\.map/u)
  })
})
describe('log dialog height', () => {
  it('is a FIXED height, so the card does not resize when the log lands', () => {
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。（涉及：`max-height`）
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(LOG_DIALOG_HEIGHT).toContain('60vh')
  })
  it('reserves the path line too, the second thing that arrived late', () => {
    expect(LOG_PATH_MIN_HEIGHT_PX).toBeGreaterThan(0)
  })
  it('still clamps to the viewport, which a fixed height needs even more', () => {
    // dsh 的 `.root` 使用 position:fixed + align-items:center，`.dialog`
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    // 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`60vh`）
    // 界面契约：此处说明布局、主题 token、尺寸或 DOM 接缝。
    expect(LOG_DIALOG_HEIGHT).toContain('min(')
    expect(LOG_DIALOG_HEIGHT).toContain(`100vh - ${String(LOG_DIALOG_CHROME_PX)}px`)
  })
  it('reserves more than the chrome dsh actually spends', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 高度计算：+ 24 dialog padding-bottom + 48 root padding = 222 像素。
    const measuredChrome = 62 + 20 + 24 + 20 + 24 + 24 + 48
    expect(measuredChrome).toBe(222)
    expect(LOG_DIALOG_CHROME_PX).toBeGreaterThanOrEqual(measuredChrome)
  })
  it('leaves the card fitting at every viewport height', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    for (const viewport of [360, 480, 555, 720, 900, 1440]) {
      const body = Math.min(0.6 * viewport, viewport - LOG_DIALOG_CHROME_PX)
      expect(body + 222).toBeLessThanOrEqual(viewport)
    }
  })
})
describe('copy', () => {
  it('keeps both dictionaries on the same key set', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
  })
  it('fills placeholders and leaves unknown ones written', () => {
    expect(fill(en.summaryRunning, { count: 3 })).toBe('3 running')
    expect(fill(zh.logTitle, { name: 'demo-web' })).toBe('demo-web 的日志')
    expect(fill('{a} {b}', { a: 'x' })).toBe('x {b}')
  })
  it('has no copy left over from the removed stopped-services strip', () => {
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    for (const key of ['summaryNone', 'summaryStopped', 'stoppedHint', 'hideLogs']) {
      expect(Object.keys(en)).not.toContain(key)
    }
  })
})
describe('shared dialog geometry', () => {
  it('keeps the services adapter aligned with the shared contract', () => {
    assertDialogGeometry({
      expect,
      applyResize: applyLogDialogResize,
      resizeBounds: logDialogResizeBounds,
      applyMove: (start, dx, dy, bounds) => applyLogDialogMove(start, dx, dy, bounds as never),
      moveBounds: logDialogMoveBounds,
    }, ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const)
    expect(LOG_DIALOG_BODY_HEIGHT_PROP).toBe('--dsh-services-log-body-height')
    expect(logDialogRule()).toContain('var(' + LOG_DIALOG_BODY_HEIGHT_PROP)
  })
})
describe('resize structure', () => {
  it('keeps eight non-button handles in Modal children', () => {
    const dialogSource = readFileSync(new URL('../src/client/ServiceLogDialog.tsx', import.meta.url), 'utf8')
    const panelSource = readFileSync(new URL('../src/client/ServicesDock.tsx', import.meta.url), 'utf8')
    const resizeSource = readFileSync(new URL('../src/client/dialog-resize.tsx', import.meta.url), 'utf8')
    expect(dialogSource).toContain('data-dsh-services-log-body')
    expect(dialogSource).toContain('LogResizeHandle')
    expect(panelSource).toMatch(/\['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'\]/u)
    expect(panelSource).toMatch(/\['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'\]/u)
    expect(resizeSource).toMatch(/touchAction: 'none'/u)
    expect(resizeSource).toContain('setPointerCapture')
    expect(resizeSource).toContain('HANDLE_SIZE_PX = 12')
    expect(resizeSource).toContain('HANDLE_CORNER_SIZE_PX = 14')
    expect(resizeSource.match(/direction ===/gu)).toHaveLength(7)
  })
})
describe('move math', () => {
  const rect = { left: 100, right: 600, top: 80, bottom: 480 }
  const bounds = logDialogMoveBounds(rect, 800, 600)
  it('clamps every edge to 24px viewport padding', () => {
    expect(bounds).toEqual({ minDx: -76, maxDx: 176, minDy: -56, maxDy: 96 })
    expect(applyLogDialogMove({ offsetX: 10, offsetY: -4 }, 1000, -1000, bounds)).toEqual({ offsetX: 186, offsetY: -60 })
  })
  it('reuses offsets across consecutive move and resize operations', () => {
    const first = applyLogDialogMove({ offsetX: 10, offsetY: -4 }, 30, 20, bounds)
    expect(first).toEqual({ offsetX: 40, offsetY: 16 })
    const secondBounds = logDialogMoveBounds({ left: 130, right: 630, top: 100, bottom: 500 }, 800, 600)
    expect(applyLogDialogMove(first, -50, 40, secondBounds)).toEqual({ offsetX: -10, offsetY: 56 })
    const resized = applyLogDialogResize({ width: 500, bodyHeight: 300, ...first }, 'se', 20, 30, {
      minWidth: 300,
      maxWidth: 800,
      minBodyHeight: 110,
      maxBodyHeight: 600,
    })
    expect(applyLogDialogMove(resized, 10, -10, bounds)).toMatchObject({ offsetX: 60, offsetY: 21 })
  })
})
describe('move handle structure', () => {
  const dialogSource = readFileSync(new URL('../src/client/ServiceLogDialog.tsx', import.meta.url), 'utf8')
  const resizeSource = readFileSync(new URL('../src/client/dialog-resize.tsx', import.meta.url), 'utf8')
  it('is transparent and below the eight resize handles', () => {
    expect(dialogSource).toContain('LogMoveHandle')
    expect(resizeSource).toContain('data-dsh-services-move-handle')
    expect(resizeSource).toContain('aria-hidden={true}')
    expect(resizeSource).toContain('zIndex: 3')
    expect(resizeSource).toContain('zIndex: 2')
    expect(resizeSource).toContain('top: 12')
    expect(resizeSource).toContain('left: 16')
    // 实现说明：此处记录相关接口、边界和生命周期约束。
    expect(resizeSource).toContain('right: 52')
    expect(resizeSource).toContain('height: 50')
    expect(resizeSource).toMatch(/background: 'transparent'/u)
    expect(resizeSource).not.toContain('linear-gradient')
    expect(resizeSource).not.toMatch(/opacity\s*:/u)
  })
  it('uses the complete guarded pointer lifecycle', () => {
    expect(resizeSource).toContain('event.button !== 0')
    expect(resizeSource).toContain('setPointerCapture')
    expect(resizeSource).toContain('pointerId !== active.pointerId')
    expect(resizeSource).toContain('requestAnimationFrame')
    expect(resizeSource).toMatch(/removeEventListener\('pointermove'/u)
    expect(resizeSource).toMatch(/removeEventListener\('lostpointercapture'/u)
  })
})
