export interface NavigationGlyphOptions {
  marker: string
  cellSelector: string
  labelSelector: string
  labels: ReadonlySet<string>
  interesting: readonly string[]
  svg: string
  maskSize: string
}

/** 生成设置导航图标的公共 CSS；具体 SVG 和 marker 仍由各插件拥有。 */
export function navigationGlyphStylesheet(options: NavigationGlyphOptions): string {
  const mask = `url("data:image/svg+xml,${encodeURIComponent(options.svg)}") center / ${options.maskSize} no-repeat`
  return [
    `[${options.marker}] > svg { display: none; }`,
    `[${options.marker}]::before {`,
    '  content: "";',
    '  flex: none;',
    '  width: 16px;',
    '  height: 16px;',
    '  background-color: currentColor;',
    `  -webkit-mask: ${mask};`,
    `  mask: ${mask};`,
    '}',
  ].join('\\n')
}

/** 安装设置导航图标，并在 React 重建导航节点时按需重新标记。 */
export function installNavigationGlyph(options: NavigationGlyphOptions): () => void {
  if (typeof document === 'undefined') return () => {}
  const style = document.createElement('style')
  style.textContent = navigationGlyphStylesheet(options)
  document.head.append(style)
  let frame: number | undefined
  const mark = (): void => {
    frame = undefined
    for (const cell of document.querySelectorAll(options.cellSelector)) {
      const text = cell.querySelector(options.labelSelector)?.textContent ?? ''
      if (options.labels.has(text)) cell.setAttribute(options.marker, '')
    }
  }
  const schedule = (): void => {
    if (frame === undefined) frame = window.requestAnimationFrame(mark)
  }
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue
        if (!options.interesting.some(fragment => node.className.includes(fragment))) continue
        schedule()
        return
      }
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  mark()
  return () => {
    observer.disconnect()
    if (frame !== undefined) window.cancelAnimationFrame(frame)
    style.remove()
    for (const cell of document.querySelectorAll(`[${options.marker}]`)) cell.removeAttribute(options.marker)
  }
}


