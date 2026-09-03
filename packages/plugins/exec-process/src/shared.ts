/**
 * Constants shared by this plugin's two halves.
 *
 * The Host half contributes nothing, so this module is small on purpose: it
 * exists so the package name appears exactly once per meaning instead of being
 * spelled out at each use site.
 *
 * @module @dsh-remote/dsh-plugin-exec-process/shared
 */

/** Copy namespace this plugin owns; the package name without the scope. */
export const SELF_NAMESPACE = 'dsh-plugin-exec-process'

/**
 * The Chat node kind opening a turn's FIRST process segment.
 *
 * It is also the kind of its Conversation Node Definition — the engine
 * requires the two to match when a Definition publishes Location data
 * (`packages/client/ui-conversation/src/client/conversation/assembler.ts:841`),
 * and keeping them equal here means one name to grep for.
 */
export const EXEC_PROCESS_KIND = 'exec-process'

/**
 * The Chat node kind opening a SECOND (third, …) segment inside one turn.
 *
 * A turn is not one block of process. The agent may say something formal
 * mid-turn and then go back to work; that formal message ends a segment and
 * the work after it starts a new one. One Conversation Context materializes
 * exactly one node, so the follow-on segments need their own Definition, their
 * own identity domain (one per step) and therefore their own kind.
 */
export const EXEC_PROCESS_STEP_KIND = 'exec-process-step'

/** Every Chat node kind this plugin contributes, in one place. */
export const EXEC_PROCESS_KINDS: ReadonlySet<string> = new Set([
  EXEC_PROCESS_KIND,
  EXEC_PROCESS_STEP_KIND,
])
