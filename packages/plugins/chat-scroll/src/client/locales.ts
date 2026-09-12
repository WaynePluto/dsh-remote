/** chat-scroll 控件的文案。 */
export const en = {
  locate: 'Back to the start of the message',
} as const

export type AgentMessageStartKey = keyof typeof en

export const zh: Record<AgentMessageStartKey, string> = {
  locate: '回到消息开头',
}

/** 本包拥有的命名空间，与包名后缀一致。 */
export const NS = 'dsh-plugin-chat-scroll' as const
