/** dsh primitives icon component 的最小调用面；React element 只在浏览器侧序列化一次。 */
export type NavigationGlyph = (props: { size: number }) => unknown

export interface NavigationGlyphOptions {
  marker: string
  cellSelector: string
  labelSelector: string
  labels: ReadonlySet<string>
  interesting: readonly string[]
  icon: NavigationGlyph
  maskSize: string
}

/** XML 属性名中 React JSX 常见 camelCase 的 SVG 对应写法。 */
const SVG_ATTRIBUTES: Readonly<Record<string, string>> = {
  className: 'class',
  clipPath: 'clip-path',
  clipRule: 'clip-rule',
  fillOpacity: 'fill-opacity',
  fillRule: 'fill-rule',
  strokeLinecap: 'stroke-linecap',
  strokeLinejoin: 'stroke-linejoin',
  strokeMiterlimit: 'stroke-miterlimit',
  strokeOpacity: 'stroke-opacity',
  strokeWidth: 'stroke-width',
  tabIndex: 'tabindex',
  viewBox: 'viewBox',
}

/** 转义原生 icon element 里的文本/属性，避免把 JSX 值拼进 mask markup。 */
function escapeXml(value: string, attribute: boolean): string {
  const escaped = value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
  return attribute ? escaped.replace(/"/gu, '&quot;') : escaped
}

/** 将 dsh primitive 的 SVG 图标及其纯函数 artwork 包装转成 CSS mask。 */
function serializeSvgNode(node: unknown, wrapperDepth = 0): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string') return escapeXml(node, false)
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(item => serializeSvgNode(item, wrapperDepth)).join('')
  if (typeof node !== 'object') throw new TypeError('Navigation glyph must return an SVG element')

  const element = node as { type?: unknown, props?: unknown }
  if (element.props === null || typeof element.props !== 'object') {
    throw new TypeError('Navigation glyph must return an SVG element')
  }
  const props = element.props as Record<string, unknown>
  if (typeof element.type === 'function') {
    if (wrapperDepth >= 8) throw new TypeError('Navigation glyph has too many component wrappers')
    return serializeSvgNode((element.type as (props: Record<string, unknown>) => unknown)(props), wrapperDepth + 1)
  }
  if (typeof element.type !== 'string') throw new TypeError('Navigation glyph must return an SVG element')
  const attributes: string[] = []
  for (const [key, rawValue] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref' || key === 'dangerouslySetInnerHTML') continue
    if (rawValue === null || rawValue === undefined || typeof rawValue === 'function') continue
    if (typeof rawValue === 'object') throw new TypeError(`Navigation glyph has unsupported SVG property: ${key}`)
    if (rawValue === false) continue
    const name = SVG_ATTRIBUTES[key] ?? key
    const value = rawValue === 'currentColor' ? '#000' : String(rawValue)
    attributes.push(`${name}="${escapeXml(value, true)}"`)
  }
  return `<${element.type}${attributes.length === 0 ? '' : ` ${attributes.join(' ')}`}>${serializeSvgNode(props.children, wrapperDepth)}</${element.type}>`
}

/**
 * 生成设置导航图标的公共 CSS；具体 icon component 和 marker 仍由各插件拥有。
 *
 * dsh 设置 shell 自己已经渲染了一个原生 SVG。直接把这个 SVG 当作 mask
 * 载体比额外创建 `::before` 更稳定：React 重建导航行时不会丢伪元素，
 * Safari 也不会在 flex 子项和伪元素之间丢掉图标盒。原 SVG 的子节点
 * 隐藏后，mask 背景仍保留在同一个 16px flex item 上。
 */
export function navigationGlyphStylesheet(options: NavigationGlyphOptions): string {
  const svg = serializeSvgNode(options.icon({ size: 16 }))
  if (!svg.startsWith('<svg')) throw new TypeError('Navigation glyph root must be an SVG')
  const mask = `url("data:image/svg+xml,${encodeURIComponent(svg)}") center / ${options.maskSize} no-repeat`
  return [
    `[${options.marker}] > svg {`,
    '  display: block;',
    '  flex: none;',
    '  width: 16px;',
    '  height: 16px;',
    '  background-color: currentColor;',
    `  -webkit-mask: ${mask};`,
    `  mask: ${mask};`,
    '}',
    `[${options.marker}] > svg > * { display: none; }`,
  ].join('\n')
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
      const text = cell.querySelector(options.labelSelector)?.textContent?.trim() ?? ''
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
