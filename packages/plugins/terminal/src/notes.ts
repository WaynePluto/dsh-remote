/**
 * Host 侧原样展示给 panel 的句子，集中在此处。
 * Host 知道具体 refusal；browser 只负责自己的 label/button 文案（`src/client/locales.ts`）。
 *
 * @module @dsh-station/dsh-plugin-terminal/notes
 */

/** 所有 Host 编写的句子集中在此处。 */
export const NOTES = {
  /** PTY registry 未挂载或仍在等待依赖注入。 */
  noService: '终端服务还没就绪。它需要 subprocess 与沙箱策略先挂上来，稍等一下再看。',
  /** conversation 没有 live agent，因此不拥有 terminal。 */
  noAgent: '这个会话当前没有在运行的 agent，所以它名下没有终端。',
  /** 写入已 dispatch。 */
  sent: '已送进终端。',
  /** 没有内容会被写入。 */
  nothingToSend: '没有内容可发送。',
  /**
   * 整个等待窗口内 session 都有另一个 send 正在进行。
   * @param seconds - Host 等待的秒数。
   * @returns 展示句子。
   */
  busy: (seconds: number): string =>
    `终端正忙：等了 ${String(seconds)} 秒，上一次发送仍没结束（通常是模型自己发的那次还在跑）。`
    + '你输入的内容没有送出去，可以点「中断」再试。',
  /**
   * 文本超过单次 send 上限。
   * @param limit - UTF-16 code units 上限。
   * @returns 展示句子。
   */
  tooLong: (limit: number): string => `一次最多发送 ${String(limit)} 个字符。`,
  /**
   * SIGINT 已到达前台 process group。
   * @param pgid - 被 signal 的 process group。
   * @returns 展示句子。
   */
  interrupted: (pgid: number): string => `已向前台进程组 ${String(pgid)} 发送 SIGINT。`,
} as const
