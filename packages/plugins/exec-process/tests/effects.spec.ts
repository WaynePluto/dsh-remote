import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconChevronDownOutlineMedium: () => null,
}))

import type { ExecProcessRowProps } from '../src/client/ExecProcessRow.js'
import type * as ReactModule from 'react'

type Cleanup = () => void
interface EffectCall { setup: () => void | Cleanup; dependencies?: readonly unknown[] | undefined; cleanup?: Cleanup | undefined }

const pending: EffectCall[] = []
let mounted: EffectCall[] = []

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useCallback: <T,>(callback: T): T => callback,
    useEffect: (setup: EffectCall['setup'], dependencies?: readonly unknown[]) => {
      pending.push({ setup, dependencies })
    },
    useMemo: <T,>(factory: () => T): T => factory(),
    useRef: <T,>(initial: T) => ({ current: initial }),
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  }
})

const { ExecProcessRow } = await import('../src/client/ExecProcessRow.js')

function sameDependencies(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  return left !== undefined && right !== undefined
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]))
}

function render(props: ExecProcessRowProps): void {
  pending.length = 0
  ExecProcessRow(props)
  const previous = mounted
  mounted = pending.map((effect, index) => {
    const old = previous[index]
    if (old !== undefined && sameDependencies(old.dependencies, effect.dependencies)) {
      return { ...effect, cleanup: old.cleanup }
    }
    old?.cleanup?.()
    return { ...effect, cleanup: effect.setup() ?? undefined }
  })
  for (const stale of previous.slice(mounted.length)) stale.cleanup?.()
}

function unmount(): void {
  for (const effect of mounted) effect.cleanup?.()
  mounted = []
  pending.length = 0
}

const node = {
  key: 'tool',
  kind: 'tool-call',
  anchorSeq: 1,
  data: { root: { kind: 'tool-result', call: { name: 'read' }, isError: false } },
}

function rowProps(open: boolean): ExecProcessRowProps {
  return {
    turn: 1,
    selfKey: 'exec-process-row',
    sessionId: 'session',
    turnNodeKeys: ['tool'],
    nodes: { get: key => key === 'tool' ? node : undefined },
    processStartSeq: 0,
    selfAnchorSeq: 0,
    turnClosed: false,
    answerAnchorSeq: null,
    foldStore: {
      isOpen: () => open,
      setOpen: () => {},
      subscribe: () => () => {},
      reset: () => {},
    },
  }
}

beforeEach(() => { unmount() })

describe('controller effect lifecycle', () => {
  it('publishes collapsed rows repeatedly without clearing between streamed updates', () => {
    const collapsed = { set: vi.fn(), clear: vi.fn(), dispose: vi.fn(), css: () => '' }
    render({ ...rowProps(false), collapsed })
    render({ ...rowProps(false), collapsed })
    expect(collapsed.set).toHaveBeenCalledTimes(2)
    expect(collapsed.clear).not.toHaveBeenCalled()
    unmount()
    expect(collapsed.clear).toHaveBeenCalledTimes(1)
  })

  it('hides an empty header wrapper so batch boundaries leave no flow gap', () => {
    const collapsed = { set: vi.fn(), clear: vi.fn(), dispose: vi.fn(), css: () => '' }
    render({ ...rowProps(false), turnNodeKeys: [], collapsed })
    expect(collapsed.set).toHaveBeenCalledWith(expect.any(String), ['exec-process-row'], [])
    unmount()
  })

  it('publishes frames repeatedly without clearing between streamed updates', () => {
    const frame = { set: vi.fn(), clear: vi.fn(), dispose: vi.fn(), css: () => '' }
    render({ ...rowProps(true), frame })
    render({ ...rowProps(true), frame })
    expect(frame.set).toHaveBeenCalledTimes(2)
    expect(frame.clear).not.toHaveBeenCalled()
    unmount()
    expect(frame.clear).toHaveBeenCalledTimes(1)
  })
})
