/**
 * A failure the user can act on.
 *
 * The launcher prints these messages on their own, without a stack trace: the
 * audience is someone who double-clicked `start.cmd`, not a Node developer.
 */
export class LauncherError extends Error {
  /** One extra line printed under the message, e.g. what to run next. */
  readonly hint: string | undefined

  constructor(message: string, options?: { hint?: string | undefined, cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'LauncherError'
    this.hint = options?.hint
  }
}
