/**
 * 不触碰任何 React 节点，只用 stylesheet 折叠 dsh 的过程行。
 * dsh 依靠有序行的 rect 恢复阅读位置，因此整行压到零高度而不是 `display:none`；行内 thinking 盒子才使用 `display:none`。
 * stylesheet 按 dsh 已写入的 `data-chat-flow-key` 选择器工作，避免和 dsh 自己维护的 `hidden` 属性竞争。
 *
 * @module @dsh-remote/dsh-plugin-exec-process/client/hidden-rows
 */

/** dsh 在每个 Chat node wrapper 上打印、携带 node key 的属性。 */
export const FLOW_KEY_ATTRIBUTE = 'data-chat-flow-key'

/** 本模块自有 `<style>` 上的标记属性，用于诊断。 */
export const STYLE_MARKER = 'data-dsh-plugin-exec-process'

/**
 * 折叠一行的 CSS 声明。全部使用 `!important`，以压过 dsh column 的间距规则，避免每个隐藏行留下 16px 空隙。
 */
const COLLAPSED_DECLARATIONS = [
  'height:0!important',
  'min-height:0!important',
  'margin:0!important',
  'padding:0!important',
  'border-width:0!important',
  'overflow:hidden!important',
  'pointer-events:none!important',
  'content-visibility:hidden',
].join(';')

/**
 * dsh reasoning 行自己的标记（`ReasoningRow.tsx:33`）。使用语义属性而不是带 hash 的 CSS module class，能跨 stylesheet 重建；只有 variant 改名才会导致 thinking 盒子停止隐藏。
 */
export const THINK_SELECTOR = '[data-variant="think"]'

/**
 * 转义双引号 CSS 属性选择器中的一个属性值。
 * @param value - 原始 `data-chat-flow-key` 值。
 * @returns 转义后的值。
 */
export function escapeAttributeValue(value: string): string {
  return value.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')
}

/**
 * @param key - Chat node key。
 * @returns 匹配该行 wrapper 的属性选择器。
 */
export function flowKeySelector(key: string): string {
  return `[${FLOW_KEY_ATTRIBUTE}="${escapeAttributeValue(key)}"]`
}

/**
 * 构造一个 fold 的 stylesheet 文本。
 * 整行折叠过程本身；segment 结束行仍可见，但其中的 thinking 需要单独隐藏。行内使用 `display:none` 不会影响 dsh 用于分页的行 rect。
 * @param keys - 整行折叠的 Chat node keys。
 * @param reasoningKeys - 折叠行内 thinking 的 Chat node keys。
 * @returns CSS 文本；没有内容时返回空字符串。
 */
export function collapsedRowsCss(
  keys: readonly string[],
  reasoningKeys: readonly string[] = [],
): string {
  const rules: string[] = []
  if (keys.length > 0) {
    rules.push(`${keys.map(flowKeySelector).join(',\n')} {\n  ${COLLAPSED_DECLARATIONS};\n}`)
  }
  if (reasoningKeys.length > 0) {
    const scopes = reasoningKeys.map(flowKeySelector)
    // 间距由 wrapper 承担；支持 `:has()` 时隐藏 wrapper。
    rules.push(`${scopes.map(scope => `${scope} div:has(> ${THINK_SELECTOR})`).join(',\n')} {\n  display:none!important;\n}`)
    // 使用独立规则和独立解析：不支持 `:has()` 的浏览器只丢弃上一条规则，仍会隐藏 box 本身。
    rules.push(`${scopes.map(scope => `${scope} ${THINK_SELECTOR}`).join(',\n')} {\n  display:none!important;\n}`)
  }
  return rules.join('\n\n')
}

/** 本 controller 所需的 document surface；收窄接口以便测试伪造。 */
export interface StyleHost {
  createElement(tag: 'style'): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  readonly head: { append(node: never): void } | { appendChild(node: never): void }
}

/** 按 owner id 记录的一项活动 fold 注册。 */
export interface CollapsedRowsController {
  /**
   * 发布一个 owner 当前折叠的内容。
   * @param owner - 稳定的 owner id（每个 session、turn、segment 一份）。
   * @param keys - 整行折叠的 node keys；空数组表示清除。
   * @param reasoningKeys - 折叠行内 thinking 的 node keys。
   */
  set(owner: string, keys: readonly string[], reasoningKeys?: readonly string[]): void
  /**
   * 移除一个 owner 的注册。
   * @param owner - 传给 {@link CollapsedRowsController.set} 的 owner id。
   */
  clear(owner: string): void
  /** 移除 stylesheet 并忘记所有 owner。 */
  dispose(): void
  /** @returns 当前安装的 CSS；用于测试和诊断。 */
  css(): string
}

/** 一个 owner 隐藏的内容。 */
interface OwnerEntry {
  readonly rows: readonly string[]
  readonly reasoning: readonly string[]
}

/**
 * @param left - 已注册的条目（若有）。
 * @param right - 正在注册的条目。
 * @returns 两者是否按相同顺序隐藏完全相同的 key。
 */
function sameEntry(left: OwnerEntry | undefined, right: OwnerEntry): boolean {
  return left !== undefined
    && left.rows.length === right.rows.length
    && left.reasoning.length === right.reasoning.length
    && left.rows.every((key, index) => key === right.rows[index])
    && left.reasoning.every((key, index) => key === right.reasoning[index])
}

/**
 * 创建所有「执行过程」行共享的单个 stylesheet。
 * 每行一个 `<style>` 会让长会话堆积节点并反复触发样式解析；集中到一个节点可避免该开销。
 * @param host - document；注入以便测试无需 DOM。
 * @returns controller；没有 document 时返回 no-op controller。
 */
export function createCollapsedRowsController(host: StyleHost | undefined): CollapsedRowsController {
  if (host === undefined) {
    return { set: () => {}, clear: () => {}, dispose: () => {}, css: () => '' }
  }
  const element = host.createElement('style')
  element.setAttribute(STYLE_MARKER, '')
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === 'function') head.append(element)
  else head.appendChild?.(element)

  const owners = new Map<string, OwnerEntry>()
  let text = ''

  const render = (): void => {
    const rows: string[] = []
    const reasoning: string[] = []
    for (const entry of owners.values()) {
      rows.push(...entry.rows)
      reasoning.push(...entry.reasoning)
    }
    const next = collapsedRowsCss(rows, reasoning)
    if (next === text) return
    text = next
    element.textContent = next
  }

  return {
    set: (owner, keys, reasoningKeys = []) => {
      if (keys.length === 0 && reasoningKeys.length === 0) {
        if (owners.delete(owner)) render()
        return
      }
      const next: OwnerEntry = { rows: [...keys], reasoning: [...reasoningKeys] }
      // 流式 turn 每个 animation frame 都会重新发布 node 列表；没有此检查，stylesheet 会每秒重建几十次却发现内容未变。
      if (sameEntry(owners.get(owner), next)) return
      owners.set(owner, next)
      render()
    },
    clear: (owner) => {
      if (owners.delete(owner)) render()
    },
    dispose: () => {
      owners.clear()
      text = ''
      element.remove()
    },
    css: () => text,
  }
}
