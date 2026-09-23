import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  FileTypeIcon, IconBranchOutlineMedium, IconCheckOutlineMedium, IconCopyOutlineMedium,
  JsonBlock, Tooltip, fileSizeText, projectUserText, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserMessageNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { MessageImageSource, RenderMessageImages } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { UserMessageForkNodeProps } from './index.js'
import {
  previousCompletedTurnEnd, userMessageContentFacts, userMessageForkAvailability,
  type UserMessageForkAvailability,
} from '../shared.js'
import { type UserMessageForkKey } from './locales.js'
import {
  ACTIONS_CLASS, ACTION_CLASS, ATTACHMENTS_CLASS, BUBBLE_CLASS, FILE_CARD_CLASS,
  FILE_CONTENT_CLASS, FILE_ICON_CLASS, FILE_META_CLASS, FILE_NAME_CLASS, REFERENCE_CLASS,
  USER_ROW_CLASS, USER_STACK_CLASS, VISUALLY_HIDDEN_CLASS,
} from './styles.js'

interface UserImage {
  readonly type: 'image'
  readonly attachment: Extract<MessageImageSource, { readonly attachment: unknown }>['attachment']
}

interface UserFile {
  readonly type: 'file'
  readonly attachment: { readonly name: string; readonly bytes: number }
}

type PresentedAttachment =
  | { readonly type: 'image'; readonly image: MessageImageSource }
  | { readonly type: 'file'; readonly file: UserFile['attachment'] }

interface UserData extends UserMessageNode {
  readonly referenceLabels?: readonly string[]
  readonly skillNames?: readonly string[]
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toUpperCase().slice(0, 8)
}

function contentParts(content: readonly unknown[]): {
  text: string
  attachments: PresentedAttachment[]
  rest: unknown[]
} {
  const texts: string[] = []
  const attachments: PresentedAttachment[] = []
  const rest: unknown[] = []
  for (const block of content) {
    const candidate = block as { type?: unknown; text?: unknown; attachment?: unknown }
    if (candidate.type === 'text' && typeof candidate.text === 'string') {
      texts.push(candidate.text)
    } else if (candidate.type === 'image' && candidate.attachment !== undefined) {
      attachments.push({ type: 'image', image: { attachment: (block as UserImage).attachment } })
    } else if (candidate.type === 'file' && candidate.attachment !== undefined) {
      attachments.push({ type: 'file', file: (block as UserFile).attachment })
    } else {
      rest.push(block)
    }
  }
  return { text: texts.join(''), attachments, rest }
}

function pad2(value: number): string {
  return String(value).padStart(2, '0')
}

function formatMessageClock(
  time: number,
  t: (key: UserMessageForkKey, params?: Record<string, unknown>) => string,
  now = Date.now(),
): string {
  const date = new Date(time)
  const current = new Date(now)
  const clock = `${pad2(date.getHours())}:${pad2(date.getMinutes())}`
  if (
    date.getFullYear() === current.getFullYear()
    && date.getMonth() === current.getMonth()
    && date.getDate() === current.getDate()
  ) return clock
  const params = { y: date.getFullYear(), m: date.getMonth() + 1, d: date.getDate() }
  const key = date.getFullYear() === current.getFullYear() ? 'clockMd' : 'clockYmd'
  return `${t(key, params)} ${clock}`
}

function branchUnavailableText(
  availability: UserMessageForkAvailability,
  t: (key: UserMessageForkKey, params?: Record<string, unknown>) => string,
): string {
  if (availability.kind === 'ready' || availability.kind === 'needs-history') return ''
  switch (availability.reason) {
    case 'no-previous-turn': return t('branchUnavailableFirst')
    case 'empty-text': return t('branchUnavailableEmpty')
    case 'unsupported-content': return t('branchUnavailableContent')
  }
}

function UserMessageActions({
  text, time, currentTurn, turnStartSeq, availability, forkMessage, t,
}: {
  text: string
  time: number
  currentTurn: number
  turnStartSeq: number | undefined
  availability: UserMessageForkAvailability
  forkMessage: UserMessageForkNodeProps['forkMessage']
  t: UserMessageForkNodeProps['t']
}) {
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const reasonId = useId()
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current)
  }, [])

  const copy = useCallback(() => {
    if (copied) return
    void writeClipboard(text).then(ok => {
      if (ok) {
        setCopied(true)
        timer.current = setTimeout(() => {
          timer.current = null
          setCopied(false)
        }, 1_000)
      }
      return ok
    })
  }, [copied, text])

  const branch = useCallback(() => {
    if (availability.kind === 'unavailable' || busy) return
    setBusy(true)
    void forkMessage({
      ...(availability.kind === 'ready' ? { atSeq: availability.atSeq } : {}),
      currentTurn,
      ...(turnStartSeq === undefined ? {} : { turnStartSeq }),
      text,
    })
      .finally(() => { setBusy(false) })
      .catch(() => {
        // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
      })
  }, [availability, busy, currentTurn, forkMessage, text, turnStartSeq])

  const unavailable = availability.kind === 'unavailable' || busy
  const reason = busy ? t('branchBusy') : branchUnavailableText(availability, t)
  return (
    <div className={ACTIONS_CLASS}>
      <span className={`${ACTIONS_CLASS}__time`}>{formatMessageClock(time, t)}</span>
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={ACTION_CLASS} aria-label={copied ? t('copied') : t('copy')} onClick={copy}>
          {copied ? <IconCheckOutlineMedium /> : <IconCopyOutlineMedium />}
        </button>
      </Tooltip>
      <Tooltip label={reason === '' ? t('branch') : reason} side="bottom">
        <button
          type="button"
          className={ACTION_CLASS}
          aria-label={reason === '' ? t('branch') : reason}
          aria-disabled={unavailable || undefined}
          aria-describedby={reason === '' ? undefined : reasonId}
          data-unavailable={unavailable || undefined}
          onClick={unavailable ? undefined : branch}
        >
          <IconBranchOutlineMedium />
        </button>
      </Tooltip>
      {reason !== '' && <span id={reasonId} className={VISUALLY_HIDDEN_CLASS}>{reason}</span>}
    </div>
  )
}

function UserStyleBubble({
  data, currentTurn, turnStartSeq, previousEndSeq, hasMore, renderMessageImages, forkMessage, t,
}: {
  data: UserData
  currentTurn: number | undefined
  turnStartSeq: number | undefined
  previousEndSeq: number | undefined
  hasMore: boolean
  renderMessageImages: RenderMessageImages
  forkMessage: UserMessageForkNodeProps['forkMessage']
  t: UserMessageForkNodeProps['t']
}): ReactNode {
  const parts = useMemo(() => contentParts(data.content), [data.content])
  const facts = useMemo(() => userMessageContentFacts(data.content), [data.content])
  const compactImages = parts.attachments.length > 1
  const availability = useMemo(() => {
    if (currentTurn === undefined) return { kind: 'unavailable' as const, reason: 'no-previous-turn' as const }
    return userMessageForkAvailability(
      previousEndSeq,
      facts,
      previousEndSeq === undefined
        && currentTurn > 1
        && hasMore
        && turnStartSeq !== undefined
        && turnStartSeq > 0,
    )
  }, [currentTurn, facts, hasMore, previousEndSeq, turnStartSeq])
  const truncated = (total: number): string => t('extraBlock', { total })
  const showBubble = parts.text !== '' || parts.rest.length > 0
  return (
    <div className={USER_ROW_CLASS} data-dshx-user-message-fork-row>
      <div className={USER_STACK_CLASS}>
        {parts.attachments.length > 0 && (
          <div className={ATTACHMENTS_CLASS} data-message-attachments>
            {parts.attachments.map((attachment, index) => attachment.type === 'image'
              ? (
                <Fragment key={`image:${index}`}>
                  {renderMessageImages({ images: [attachment.image], align: 'end', compact: compactImages })}
                </Fragment>
              )
              : (
                <span key={`file:${index}`} className={FILE_CARD_CLASS} title={attachment.file.name}>
                  <FileTypeIcon path={attachment.file.name} size={18} className={FILE_ICON_CLASS} />
                  <span className={FILE_CONTENT_CLASS}>
                    <span className={FILE_NAME_CLASS}>{attachment.file.name}</span>
                    <span className={FILE_META_CLASS}>
                      {[extensionOf(attachment.file.name), fileSizeText(attachment.file.bytes)].filter(Boolean).join(' ')}
                    </span>
                  </span>
                </span>
              ))}
          </div>
        )}
        {showBubble && (
          <div className={BUBBLE_CLASS}>
            {projectUserText(parts.text, data.referenceLabels ?? [], data.skillNames ?? [])}
            {parts.rest.map((block, index) => (
              <JsonBlock key={index} label={t('extraBlock')} payload={block} truncatedLabel={truncated} />
            ))}
          </div>
        )}
        {(data.referenceLabels?.length ?? 0) > 0 && (
          <div className={REFERENCE_CLASS}>
            {t('referenceSummary', { labels: data.referenceLabels!.join(t('referenceSeparator')) })}
          </div>
        )}
      </div>
      <UserMessageActions
        text={parts.text}
        time={data.time}
        currentTurn={currentTurn ?? 0}
        turnStartSeq={turnStartSeq}
        availability={availability}
        forkMessage={forkMessage}
        t={t}
      />
    </div>
  )
}

/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export function UserMessageForkNodeView({
  node, renderMessageImages, forkMessage, useChat, useSession, t,
}: UserMessageForkNodeProps) {
  const turnLocation = node.location.kind === 'turn' || node.location.kind === 'step'
    ? node.location.turn
    : undefined
  const currentTurn = turnLocation?.turn
  const turnStartSeq = turnLocation?.start?.seq
  const previousEndSeq = useChat(snapshot => currentTurn === undefined
    ? undefined
    : previousCompletedTurnEnd(snapshot.timeline, currentTurn))
  const hasMore = useSession(snapshot => snapshot.hasMore)
  return (
    <UserStyleBubble
      data={node.data as UserData}
      currentTurn={currentTurn}
      turnStartSeq={turnStartSeq}
      previousEndSeq={previousEndSeq}
      hasMore={hasMore}
      renderMessageImages={renderMessageImages}
      forkMessage={forkMessage}
      t={t}
    />
  )
}
