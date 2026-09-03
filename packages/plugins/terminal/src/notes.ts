/**
 * Host-side sentences the panel shows verbatim.
 *
 * They live here rather than in the browser half because the Host is the one
 * that knows WHICH refusal happened, and a code the page has to translate back
 * into a sentence is two places to keep in sync for no gain. The browser half
 * owns the copy it composes itself (labels, buttons, headers) in
 * `src/client/locales.ts`.
 *
 * @module @dsh-remote/dsh-plugin-terminal/notes
 */

/** Every Host-authored sentence, in one place. */
export const NOTES = {
  /** The PTY registry is not mounted, or has not finished waiting for its injections. */
  noService: '终端服务还没就绪。它需要 subprocess 与沙箱策略先挂上来，稍等一下再看。',
  /** The conversation has no live agent, so it owns no terminals. */
  noAgent: '这个会话当前没有在运行的 agent，所以它名下没有终端。',
  /** The write was dispatched. */
  sent: '已送进终端。',
  /** Nothing would have been written. */
  nothingToSend: '没有内容可发送。',
  /**
   * The session had another send in flight for the whole wait window.
   * @param seconds - how long the Host waited.
   * @returns the sentence.
   */
  busy: (seconds: number): string =>
    `终端正忙：等了 ${String(seconds)} 秒，上一次发送仍没结束（通常是模型自己发的那次还在跑）。`
    + '你输入的内容没有送出去，可以点「中断」再试。',
  /**
   * The text exceeded the per-send cap.
   * @param limit - the cap, in UTF-16 code units.
   * @returns the sentence.
   */
  tooLong: (limit: number): string => `一次最多发送 ${String(limit)} 个字符。`,
  /**
   * SIGINT reached the foreground process group.
   * @param pgid - the process group that was signalled.
   * @returns the sentence.
   */
  interrupted: (pgid: number): string => `已向前台进程组 ${String(pgid)} 发送 SIGINT。`,
} as const
