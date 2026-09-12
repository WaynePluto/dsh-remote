/**
 * 让「执行过程」表头跟随阅读位置，并在自己的内容结束后推出视口。
 * 普通 `position: sticky` 会固定到整列末尾，因此按每帧测量内容底边计算 push；每个 header 用自己的 custom property，不移动 React DOM。
 * offset = clamp(scrollportTop + headerHeight - contentBottom, 0, headerHeight)，写到 `<html>` 后由本模块 stylesheet 应用到 dsh wrapper。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/sticky-push
 */

import { FLOW_KEY_ATTRIBUTE, flowKeySelector, THINK_SELECTOR } from './hidden-rows.js'

/** 本模块自有 `<style>` 上的标记属性，用于诊断。 */
export const PUSH_STYLE_MARKER = 'data-dsh-plugin-exec-process-sticky'

/** 发布到 `<html>` 的每个表头 custom property 前缀。 */
export const PUSH_PROPERTY_PREFIX = '--dshx-exec-process-push-'

/** 使元素成为 scrollport 的 computed style overflow 值。 */
const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay'])

/** 一次测量所需的数据；四个数字都是 viewport 坐标。 */
export interface PushGeometry {
  /** 表头吸附的 scrollport 顶边。 */
  scrollportTop: number
  /** 表头行高度。 */
  headerHeight: number
  /** segment 最后一个展开内容的底边；内容不存在时为 `null`。 */
  contentBottom: number | null
}

/**
 * 计算表头需要从 sticky 位置向上推出的距离。
 * @param geometry - scrollport 顶部、表头高度和内容结束位置。
 * @returns 非负像素值，且不超过表头高度；超过后表头已经离开 viewport，不再继续写 offset。
 */
export function pushOffset({ scrollportTop, headerHeight, contentBottom }: PushGeometry): number {
  if (contentBottom === null || !(headerHeight > 0)) return 0
  const overhang = scrollportTop + headerHeight - contentBottom
  if (!(overhang > 0)) return 0
  // 使用整像素：读者看不到三分之一像素，取整可将连续滚动限制为每像素最多一次 property 写入。
  return Math.min(Math.round(overhang), Math.ceil(headerHeight))
}

/** stylesheet 当前看到的一项吸附表头。 */
export interface StickyEntry {
  /** 表头自身 wrapper 的 `data-chat-flow-key`。 */
  readonly flowKey: string
  /** 携带该表头 push offset 的 custom property。 */
  readonly property: string
}

/**
 * 选择一个展开 segment 的真实底边。
 * 正式答案行本身不属于 segment，但其中的 inline reasoning 属于；因此有 reasoning 时测量带 frame padding/border 的 `div:has(> [data-variant="think"])`，否则测量最后一个 member 行。
 * @param memberKeys - segment 拥有的整行 key，按 flow 顺序排列。
 * @param reasoningOnlyKeys - 正式行中、其嵌套 thinking 归该 segment 的 key。
 * @returns 最后展开 box 的 selector；没有内容时返回 undefined。
 */
export function segmentContentEndSelector(
  memberKeys: readonly string[],
  reasoningOnlyKeys: readonly string[],
): string | undefined {
  const reasoningKey = reasoningOnlyKeys.at(-1)
  if (reasoningKey !== undefined) {
    return `${flowKeySelector(reasoningKey)} div:has(> ${THINK_SELECTOR})`
  }
  const memberKey = memberKeys.at(-1)
  return memberKey === undefined ? undefined : flowKeySelector(memberKey)
}

/**
 * 构造当前吸附表头的 stylesheet 文本。`z-index` 和不透明背景必须与 sticky 写在同一规则中，避免表头透明或被邻居覆盖。
 * @param entries - 每个打开表头一项，顺序任意。
 * @returns CSS 文本；没有吸附项时返回空字符串。
 */
export function stickyCss(entries: readonly StickyEntry[]): string {
  return entries
    .map(entry => `${flowKeySelector(entry.flowKey)} {
  position: sticky;
  top: var(${entry.property}, 0px);
  z-index: 3;
  background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff));
}`)
    .join('\n\n')
}

/** 本模块从被测元素读取的最小接口。 */
export interface MeasuredElement {
  /** @returns 元素在 viewport 坐标中的 box。 */
  getBoundingClientRect(): { readonly top: number; readonly bottom: number; readonly height: number }
}

/** 本模块可从中向上遍历并监听事件的元素。 */
export interface AncestorElement extends MeasuredElement {
  /** 树中向上的下一个元素；根部为 `null`。 */
  readonly parentElement: AncestorElement | null
  /** @param name - attribute 名称。@returns 存在时返回其值。 */
  getAttribute(name: string): string | null
  /** @param type - 始终为 `scroll`。@param listener - callback。@param options - listener options。 */
  addEventListener(type: 'scroll', listener: () => void, options: { passive: boolean }): void
  /** @param type - 始终为 `scroll`。@param listener - 之前注册的 callback。 */
  removeEventListener(type: 'scroll', listener: () => void): void
}

/** 表头 button；仅用于找到 dsh 放置它的 wrapper。 */
export interface TrackedButton {
  /** @param selectors - CSS selector。@returns 最近的匹配祖先。 */
  closest(selectors: string): AncestorElement | null
}

/** 本模块所需的 window surface；收窄接口以便测试伪造。 */
export interface StickyPushView {
  /** @param type - 始终为 `resize`。@param listener - callback。 */
  addEventListener(type: 'resize', listener: () => void): void
  /** @param type - 始终为 `resize`。@param listener - 之前注册的 callback。 */
  removeEventListener(type: 'resize', listener: () => void): void
  /** @param callback - 在下一次 paint 前运行。@returns 取消句柄。 */
  requestAnimationFrame(callback: () => void): number
  /** @param handle - 来自 `requestAnimationFrame` 的句柄。 */
  cancelAnimationFrame(handle: number): void
  /** @param element - 任意元素。@returns 解析后的 style。 */
  getComputedStyle(element: AncestorElement): { readonly overflowY: string }
}

/** 本模块所需的 document surface；收窄接口以便测试伪造。 */
export interface StickyPushHost {
  /** @param tag - 始终为 `style`。@returns detached element。 */
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  /** stylesheet 挂载的位置。 */
  readonly head: { append(node: never): void } | { appendChild(node: never): void }
  /** 承载 push properties 的对象。 */
  readonly documentElement: {
    readonly style: {
      setProperty(name: string, value: string): void
      removeProperty(name: string): void
    }
  }
  /** @param selectors - CSS selector。@returns 页面中的首个匹配项。 */
  querySelector(selectors: string): MeasuredElement | null
  /** window；detached document 中不存在。 */
  readonly defaultView: StickyPushView | null
}

/** 一项打开表头的注册。 */
export interface StickyPushController {
  /**
   * 只要调用方保留注册，就让一个表头保持吸附。
   * @param button - 表头 button；实际吸附的是它的 wrapper。
   * @param contentEndSelector - segment 最后一个展开 box 的 selector；
   * 没有 selector 时表头会吸附且永不释放。
   * @returns 移除规则和 property 的 disposer。
   */
  track(button: TrackedButton, contentEndSelector: string | undefined): () => void
  /** 立即重新计算所有 offset，不经过 frame loop。 */
  measure(): void
  /** @returns 当前安装的 CSS；用于测试和诊断。 */
  css(): string
  /** 解除所有吸附并移除 stylesheet。 */
  dispose(): void
}

/** 一个被跟踪表头的记录。 */
interface Entry extends StickyEntry {
  readonly wrapper: AncestorElement
  readonly scrollport: AncestorElement | null
  readonly contentEndSelector: string | null
  readonly detach: () => void
  offset: number
}

/**
 * 找到表头实际会吸附其中的 box。dsh 有两种转录布局：`.scroll` 通常拥有 `overflow-y: auto`，`[data-conversation-scroll]` 下则由祖先滚动，因此必须动态发现 scrollport。
 * @param start - 表头 wrapper。
 * @param view - window，用于读取 resolved styles。
 * @returns 最近的滚动祖先；没有时返回 null。
 */
export function findScrollport(
  start: AncestorElement | null,
  view: StickyPushView | null,
): AncestorElement | null {
  if (view === null) return null
  let node = start?.parentElement ?? null
  while (node !== null) {
    if (SCROLLING_OVERFLOW.has(view.getComputedStyle(node).overflowY)) return node
    node = node.parentElement
  }
  return null
}

/**
 * 创建所有「执行过程」表头共享的 stylesheet 和 frame loop。
 * @param host - document；注入以便测试无需 DOM。
 * @returns controller；没有 document 时返回 no-op controller。
 */
export function createStickyPushController(host: StickyPushHost | undefined): StickyPushController {
  if (host === undefined) {
    return { track: () => () => {}, measure: () => {}, css: () => '', dispose: () => {} }
  }
  const view = host.defaultView
  const element = host.createElement('style')
  element.setAttribute(PUSH_STYLE_MARKER, '')
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)

  const entries = new Map<number, Entry>()
  let nextId = 1
  let text = ''
  let frame: number | null = null

  const render = (): void => {
    const next = stickyCss([...entries.values()])
    if (next === text) return
    text = next
    element.textContent = next
  }

  const measure = (): void => {
    for (const entry of entries.values()) {
      // 每次重新查询而不是缓存：reader 分页时 dsh 会挂载/卸载转录行，旧 node 可能已不在屏幕上；对少数打开表头做属性查询远比测错便宜。
      const contentEnd = entry.contentEndSelector === null ? null : host.querySelector(entry.contentEndSelector)
      const offset = pushOffset({
        scrollportTop: entry.scrollport === null ? 0 : entry.scrollport.getBoundingClientRect().top,
        headerHeight: entry.wrapper.getBoundingClientRect().height,
        contentBottom: contentEnd === null ? null : contentEnd.getBoundingClientRect().bottom,
      })
      if (offset === entry.offset) continue
      entry.offset = offset
      host.documentElement.style.setProperty(entry.property, `${-offset}px`)
    }
  }

  const schedule = (): void => {
    if (view === null) {
      measure()
      return
    }
    if (frame !== null) return
    frame = view.requestAnimationFrame(() => {
      frame = null
      measure()
    })
  }

  const onResize = (): void => { schedule() }
  view?.addEventListener('resize', onResize)

  const drop = (id: number): void => {
    const entry = entries.get(id)
    if (entry === undefined) return
    entry.detach()
    entries.delete(id)
    host.documentElement.style.removeProperty(entry.property)
    render()
  }

  return {
    track(button, contentEndSelector) {
      const wrapper = button.closest(`[${FLOW_KEY_ATTRIBUTE}]`)
      const flowKey = wrapper?.getAttribute(FLOW_KEY_ATTRIBUTE) ?? null
      // 没有 wrapper 表示 dsh 重命名了属性或移动了 seat；表头仍渲染并折叠，只是不再跟随阅读位置。
      if (wrapper === null || flowKey === null) return () => {}
      const id = nextId++
      const scrollport = findScrollport(wrapper, view)
      // 每项使用独立 identity：同一个 scrollport 上注册两次的相同函数会被 DOM 去重，移除一个表头时会悄悄停止另一个。
      const onScroll = (): void => { schedule() }
      scrollport?.addEventListener('scroll', onScroll, { passive: true })
      entries.set(id, {
        flowKey,
        property: `${PUSH_PROPERTY_PREFIX}${id}`,
        wrapper,
        scrollport,
        contentEndSelector: contentEndSelector ?? null,
        detach: () => { scrollport?.removeEventListener('scroll', onScroll) },
        offset: 0,
      })
      host.documentElement.style.setProperty(`${PUSH_PROPERTY_PREFIX}${id}`, '0px')
      render()
      // reader 可能打开一个已经滚过的 fold。
      schedule()
      return () => { drop(id) }
    },
    measure,
    css: () => text,
    dispose() {
      if (frame !== null && view !== null) view.cancelAnimationFrame(frame)
      frame = null
      view?.removeEventListener('resize', onResize)
      // 迭代 Map 时删除当前 key 是定义好的行为：iterator 会继续访问剩余项，因此无需创建 snapshot 即可清空。
      for (const id of entries.keys()) drop(id)
      text = ''
      element.remove()
    },
  }
}
