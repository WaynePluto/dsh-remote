/** 实现说明：此处记录相关接口、边界和生命周期约束。 */
export const en = {
  copy: 'Copy',
  copied: 'Copied',
  branch: 'Start again from this message',
  branchBusy: 'Opening a new conversation',
  branchUnavailableFirst: 'The first message has no earlier conversation to inherit',
  branchUnavailableEmpty: 'An empty message cannot be edited and resent',
  branchUnavailableContent: 'Messages with attachments cannot be edited and resent yet',
  extraBlock: 'Additional content',
  referenceSummary: 'References: {labels}',
  referenceSeparator: ', ',
  clockMd: '{m}/{d}',
  clockYmd: '{y}/{m}/{d}',
} as const

export type UserMessageForkKey = keyof typeof en

export const zh: Record<UserMessageForkKey, string> = {
  copy: '复制',
  copied: '已复制',
  branch: '从此消息重新开始',
  branchBusy: '正在打开新会话',
  branchUnavailableFirst: '第一条消息没有可继承的前置内容',
  branchUnavailableEmpty: '空消息不能编辑后重新发送',
  branchUnavailableContent: '包含附件的消息暂不支持编辑后重新发送',
  extraBlock: '附加内容',
  referenceSummary: '引用：{labels}',
  referenceSeparator: '、',
  clockMd: '{m}月{d}日',
  clockYmd: '{y}年{m}月{d}日',
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。 */
export const NS = 'dsh-plugin-user-message-fork' as const
