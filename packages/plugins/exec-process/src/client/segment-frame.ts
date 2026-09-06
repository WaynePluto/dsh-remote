import { flowKeySelector, THINK_SELECTOR } from "./hidden-rows.js"

export const FRAME_STYLE_MARKER = "data-dsh-plugin-exec-process-frame"

const FRAME_BORDER = "0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.28))"
const FRAME_BACKGROUND = "var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff))"

export interface SegmentFrameEntry {
  readonly rows: readonly string[]
  readonly reasoning: readonly string[]
}

/** Build frame CSS for one expanded segment without moving dsh-owned nodes. */
export function segmentFrameCss(entry: SegmentFrameEntry): string {
  const rules: string[] = []
  const rows = entry.rows.map(flowKeySelector)
  if (rows.length === 1) {
    rules.push(`${rows[0]} {
  box-sizing: border-box;
  margin-top: 8px!important;
  padding: 10px 12px;
  border: ${FRAME_BORDER};
  background: ${FRAME_BACKGROUND};
  border-radius: 8px;
}`)
  } else if (rows.length > 1) {
    rules.push(`${rows.join(",\n")} {
  box-sizing: border-box;
  margin-top: 0!important;
  padding-inline: 12px;
  border-inline: ${FRAME_BORDER};
  background: ${FRAME_BACKGROUND};
}`)
    rules.push(`${rows[0]} {
  margin-top: 8px!important;
  padding-top: 10px;
  border-top: ${FRAME_BORDER};
  border-radius: 8px 8px 0 0;
}`)
    rules.push(`${rows.slice(1).join(",\n")} {
  padding-top: 16px;
}`)
    rules.push(`${rows.at(-1)} {
  padding-bottom: 10px;
  border-bottom: ${FRAME_BORDER};
  border-radius: 0 0 8px 8px;
}`)
  }

  // The thinking box itself is fixed at 24px in dsh. Padding or a border on it
  // compresses/overflows that content, so frame its auto-sized parent instead.
  const reasoning = entry.reasoning.map(key => `${flowKeySelector(key)} div:has(> ${THINK_SELECTOR})`)
  if (reasoning.length > 0) {
    rules.push(`${reasoning.join(",\n")} {
  box-sizing: border-box;
  padding: 6px 10px;
  border: ${FRAME_BORDER};
  background: ${FRAME_BACKGROUND};
  border-radius: 8px;
}`)
  }
  return rules.join("\n\n")
}

export interface SegmentFrameHost {
  createElement(tag: "style"): {
    textContent: string | null
    setAttribute(name: string, value: string): void
    remove(): void
  }
  readonly head: { append(node: never): void } | { appendChild(node: never): void }
}

export interface SegmentFrameController {
  set(owner: string, rows: readonly string[], reasoning?: readonly string[]): void
  clear(owner: string): void
  css(): string
  dispose(): void
}

function sameEntry(left: SegmentFrameEntry | undefined, right: SegmentFrameEntry): boolean {
  return left !== undefined
    && left.rows.length === right.rows.length
    && left.reasoning.length === right.reasoning.length
    && left.rows.every((key, index) => key === right.rows[index])
    && left.reasoning.every((key, index) => key === right.reasoning[index])
}

/** Create one lifecycle-safe stylesheet for all currently expanded segments. */
export function createSegmentFrameController(host: SegmentFrameHost | undefined): SegmentFrameController {
  if (host === undefined) return { set: () => {}, clear: () => {}, css: () => "", dispose: () => {} }

  const element = host.createElement("style")
  element.setAttribute(FRAME_STYLE_MARKER, "")
  const head = host.head as { append?: (node: unknown) => void; appendChild?: (node: unknown) => void }
  if (typeof head.append === "function") head.append(element)
  else head.appendChild?.(element)

  const owners = new Map<string, SegmentFrameEntry>()
  let text = ""
  const render = (): void => {
    const next = [...owners.values()].map(segmentFrameCss).filter(Boolean).join("\n\n")
    if (next === text) return
    text = next
    element.textContent = next
  }

  return {
    set(owner, rows, reasoning = []) {
      if (rows.length === 0 && reasoning.length === 0) {
        if (owners.delete(owner)) render()
        return
      }
      const next: SegmentFrameEntry = { rows: [...rows], reasoning: [...reasoning] }
      if (sameEntry(owners.get(owner), next)) return
      owners.set(owner, next)
      render()
    },
    clear(owner) {
      if (owners.delete(owner)) render()
    },
    css: () => text,
    dispose() {
      owners.clear()
      text = ""
      element.remove()
    },
  }
}
