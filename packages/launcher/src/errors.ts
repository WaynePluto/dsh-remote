/**
 * 用户可以采取行动解决的失败。
 *
 * launcher 会单独打印这些消息，不附带 stack trace：因为目标
 * 读者是双击 `start.cmd` 的用户，而不是 Node 开发者。
 */
export class LauncherError extends Error {
  /** 在消息下额外打印的一行，例如下一步要运行的命令。 */
  readonly hint: string | undefined

  constructor(message: string, options?: { hint?: string | undefined, cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LauncherError'
    this.hint = options?.hint
  }
}
