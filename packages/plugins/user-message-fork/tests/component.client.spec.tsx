// @vitest-environment node

import { describe, expect, it, vi } from 'vitest'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  DocumentFileIcon: () => null,
  IconBranchOutline16: () => null,
  IconCheckOutline16: () => null,
  IconCopyOutline16: () => null,
  JsonBlock: () => null,
  Tooltip: ({ children }: { children: unknown }) => children,
  fileSizeText: () => '',
  projectUserText: (text: string) => text,
  writeClipboard: vi.fn(async () => true),
}))

import { renderToStaticMarkup } from 'react-dom/server'
import { UserMessageForkNodeView, type UserMessageForkNodeProps } from '../src/client/index.js'
import type { UserMessageForkKey } from '../src/client/locales.js'

function props(options: { currentTurn: number; hasMore?: boolean }): UserMessageForkNodeProps {
  const timeline = options.hasMore
    ? {
      turnOrder: [options.currentTurn],
      turns: new Map([[options.currentTurn, { end: { seq: 20 } }]]),
    }
    : {
      turnOrder: [1, 2],
      turns: new Map([
        [1, { end: { seq: 9 } }],
        [2, { end: { seq: 20 } }],
      ]),
    }
  const node = {
    key: 'user:message-2',
    kind: 'user',
    id: 'message-2',
    target: 'chat',
    anchorSeq: 11,
    location: {
      kind: 'turn',
      turn: {
        turn: options.currentTurn,
        start: { type: 'turn/start', seq: 10, time: 10, data: { turn: options.currentTurn } },
        end: { type: 'turn/end', seq: 20, time: 20, data: { turn: options.currentTurn, reason: { kind: 'completed' } } },
        status: 'closed',
        steps: [],
        data: { get: () => undefined, source: () => ({ getSnapshot: () => undefined, subscribe: () => () => {} }) },
      },
    },
    visibility: 'visible',
    data: {
      kind: 'user',
      seq: 11,
      time: Date.now(),
      content: [{ type: 'text', text: '原始问题' }],
      source: { kind: 'user' },
    },
  }
  const chatSnapshot = { timeline }
  return {
    node,
    sessionId: 'session-2',
    useChat: (select: (snapshot: typeof chatSnapshot) => unknown) => select(chatSnapshot),
    useSession: (select: (snapshot: { hasMore: boolean }) => unknown) => select({ hasMore: options.hasMore ?? false }),
    renderMessageImages: () => null,
    forkMessage: vi.fn(async () => {}),
    t: (key: UserMessageForkKey, params?: Record<string, unknown>) => {
      const values: Record<string, string> = {
        branch: '从此消息重新开始',
        branchBusy: '正在打开新会话',
        branchUnavailableFirst: '第一条消息没有可继承的前置内容',
        branchUnavailableEmpty: '空消息不能编辑后重新发送',
        branchUnavailableContent: '包含附件的消息暂不支持编辑后重新发送',
        copy: '复制',
        copied: '已复制',
        extraBlock: '附加内容',
        referenceSummary: `引用：${String(params?.labels ?? '')}`,
        referenceSeparator: '、',
        clockMd: `${String(params?.m ?? '')}月${String(params?.d ?? '')}日`,
        clockYmd: `${String(params?.y ?? '')}年${String(params?.m ?? '')}月${String(params?.d ?? '')}日`,
      }
      return values[key] ?? key
    },
  } as unknown as UserMessageForkNodeProps
}

describe('UserMessageForkNodeView', () => {
  it('renders a ready fork button beside a text user message', () => {
    const markup = renderToStaticMarkup(<UserMessageForkNodeView {...props({ currentTurn: 2 })} />)
    expect(markup).toContain('原始问题')
    expect(markup).toContain('从此消息重新开始')
    expect(markup).not.toContain('data-unavailable="true"')
  })

  it('keeps the first user message visibly unavailable', () => {
    const markup = renderToStaticMarkup(<UserMessageForkNodeView {...props({ currentTurn: 1 })} />)
    expect(markup).toContain('data-unavailable="true"')
    expect(markup).toContain('第一条消息没有可继承的前置内容')
  })

  it('keeps the button usable when the previous turn must be paged in', () => {
    const markup = renderToStaticMarkup(<UserMessageForkNodeView {...props({ currentTurn: 2, hasMore: true })} />)
    expect(markup).not.toContain('data-unavailable="true"')
  })
})
