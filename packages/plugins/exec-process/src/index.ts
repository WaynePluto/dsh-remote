/**
 * dsh-remote plugin: give every completed turn one collapsed「执行过程」row.
 *
 * WHY THIS PLUGIN EXISTS. dsh already ships the idea — `ui-chat` projects a
 * `turn-process` node per turn and folds everything before the final answer
 * behind one thin line. Two things stop that from ever being visible in a real
 * working session, and one thing is missing from it:
 *
 *   1. `ChatNodeSeat` only folds when `!historyIncomplete`
 *      (`packages/client/ui-chat/src/client/chat/ChatNodeSeat.tsx:62-68`), and
 *      the transcript window opens with `maxMessages: PAGE_MESSAGES = 50`
 *      (`packages/api/session-controller/src/client/sessions/session.ts:47`).
 *      Any session past ~50 surface messages therefore has `hasMore === true`
 *      and the fold is switched off for the WHOLE view — every thinking row and
 *      every tool row stays expanded, forever, no matter what the user does.
 *   2. Its summary counts tool calls, assistant messages and subagents. It does
 *      not count thinking segments or failures, and it never says what the last
 *      thing the agent did was.
 *
 * WHAT THIS PLUGIN DOES. The browser half (`./client`) contributes its own
 * chat node — one per turn, anchored exactly where dsh anchors its own control
 * — renders it with dsh's own thin-line chrome, and does the hiding itself with
 * a runtime stylesheet keyed by node identity, so it does not depend on the
 * `historyIncomplete` gate at all. See `src/client/index.tsx` for the full
 * reasoning, including why it shadows dsh's own `turn-process` renderer instead
 * of leaving two controls on screen.
 *
 * WHY THIS HOST HALF IS EMPTY. It has no work to do: everything the row shows
 * is already in the browser's own conversation projection, so there is nothing
 * for a Host fold or an RPC channel to add. It exists because dsh's client
 * module system discovers a plugin's browser half by walking up from the Host
 * module inserted by `dsh-overlay.yml` to that package's `package.json` and
 * reading `dsh.client` + `exports["./client"]`. No Host module, no browser
 * bundle. Deleting this file does not make the plugin smaller — it makes it
 * not exist.
 *
 * @module @dsh-remote/dsh-plugin-exec-process
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-exec-process'

/**
 * Mount the Host half.
 *
 * Deliberately empty; see the module docblock. It takes `ctx` so the export is
 * a well-formed cordis functional plugin rather than something dsh has to
 * special-case.
 * @param _ctx - cordis context; unused.
 */
export function apply(_ctx: Context): void {
  // No Host contribution by design.
}
