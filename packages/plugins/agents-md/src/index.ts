/**
 * dsh-remote plugin: edit the global instruction file from Settings.
 *
 * WHY THIS PLUGIN EXISTS. dsh reads a user-global `AGENTS.md` from the harness
 * home into every session's context — `agent-instructions/src/files.ts:280`
 * joins `<dshHome>/AGENTS.md` and pushes it ahead of every project-level
 * instruction file — but it offers no way to see or change it. The file is
 * real, it is loaded into every conversation this machine runs, and today the
 * only way to edit it is to know that it exists and open it in a text editor.
 * For anyone driving this dsh from a phone through the relay, that is not
 * possible at all.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not change how dsh discovers,
 * loads, budgets or reconciles instructions, and it registers no
 * `agent-instructions` row of its own. dsh's loader stays the single reader;
 * this plugin only supplies the editor for the file that loader already reads.
 * That is what keeps the plugin correct across dsh upgrades: the moment dsh
 * changes its instruction pipeline, this page is still editing the same file,
 * or the smoke check fails loudly because the path no longer matches.
 *
 * WHY ONE FILE AND NOT ONE PER PRESET. The `agent-instructions` row lives in
 * each preset's own composition, so its `dshHome` COULD differ per preset and
 * give every preset a private instruction file. That was considered and
 * rejected by the user: the shipped presets are `trust: 'system'` and cannot be
 * edited, so per-preset files would have forced a writable copy of every preset
 * a person wanted to use. One global file, exactly the one dsh already reads.
 *
 * TWO HALVES, ONE PACKAGE. This module is the Host half, loaded through the
 * `--patch` overlay next to it; the browser half (`./client`) adds the Settings
 * page. They meet on the RPC channel in `./shared.ts` — there is no settings
 * namespace, because the document's home is the file itself.
 *
 * @module @dsh-remote/dsh-plugin-agents-md
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: activates the `ctx.connection` Context merge this plugin reads.
import type {} from '@deepseek-ai/dsh-client-connection'
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { readDocument, writeDocument } from './file.js'
import {
  CHANNEL,
  documentFault,
  isAgentsMdEndpoint,
  LOAD_ENDPOINT,
  MAX_BYTES,
  SAVE_ENDPOINT,
} from './shared.js'
import type { AgentsMdDocument, AgentsMdSaveResult } from './shared.js'

export { agentsMdPath, readDocument, USER_GLOBAL_FILE, writeDocument } from './file.js'
export {
  CHANNEL, documentFault, ENDPOINTS, isAgentsMdEndpoint, LOAD_ENDPOINT,
  MAX_BYTES, NAMESPACE, SAVE_ENDPOINT, utf8Bytes,
} from './shared.js'
export type {
  AgentsMdDocument, AgentsMdEndpoint, AgentsMdSaveRequest, AgentsMdSaveResult,
} from './shared.js'

/** Cordis plugin name, as it appears in dsh's plugin tree and its diagnostics. */
export const name = 'dsh-remote-agents-md'

/** Required services. `connection` carries this plugin's only seam. */
export const inject = ['connection']

/** The failure code the channel reports for an unknown endpoint. */
export const UNKNOWN_ENDPOINT_CODE = 'agents-md/unknown-endpoint'

/** The failure code reported when a save carries a malformed payload. */
export const BAD_REQUEST_CODE = 'agents-md/bad-request'

/** The failure code reported when a document is larger than dsh will read. */
export const TOO_LARGE_CODE = 'agents-md/too-large'

/** The failure code reported when the file could not be read or written. */
export const IO_CODE = 'agents-md/io-failed'

/**
 * Dispatch one decoded RPC call.
 *
 * Exported for tests, which drive the endpoints without an HTTP carrier.
 * @param endpoint - channel-relative endpoint name.
 * @param payload - the decoded request body.
 * @returns the document, or a coded failure.
 */
export async function dispatch(
  endpoint: string,
  payload: unknown,
): Promise<ConnectionRpcResult<AgentsMdDocument | AgentsMdSaveResult>> {
  if (!isAgentsMdEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  try {
    if (endpoint === LOAD_ENDPOINT) return { ok: true, value: await readDocument() }

    // SAVE. The payload crossed a network boundary, so it is untrusted input
    // rather than a typed call: anything but a string is refused by shape
    // before it can reach the filesystem.
    const content = (payload as { content?: unknown } | undefined)?.content
    if (typeof content !== 'string') {
      return {
        ok: false,
        error: { code: BAD_REQUEST_CODE, message: 'save requires a string "content"', details: {} },
      }
    }
    // The same validator the page runs before sending, so a document the page
    // accepted can never be refused here (docs/02 §8.8 is the same failure in
    // the settings domain: a silent refusal reads as a successful save).
    if (documentFault(content) !== undefined) {
      return {
        ok: false,
        error: {
          code: TOO_LARGE_CODE,
          message: `the document is larger than ${String(MAX_BYTES)} bytes, which dsh would silently ignore`,
          details: {},
        },
      }
    }
    return { ok: true, value: { document: await writeDocument(content) } }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: IO_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/**
 * Mount the editor's channel.
 *
 * ⚠️ The endpoint is a PATH SEGMENT: the browser posts to `/agents-md/load`
 * and `/agents-md/save`, and the envelope's method must equal that last segment
 * (docs/02 §10.8). dsh wraps the channel in the same Host/Origin fence and
 * browser authentication as `/api`, and for a remote page the relay's own login
 * sits outside that again.
 * @param ctx - Host plugin context.
 */
export function apply(ctx: Context): void {
  const dispose = ctx.connection.rpc.handle(
    CHANNEL,
    async (endpoint: string, payload: unknown) => await dispatch(endpoint, payload),
  )
  ctx.effect(() => () => { void dispose() }, 'agents-md: editor channel')
}

/** Endpoint names this plugin serves, for the smoke check's assertions. */
export const SERVED = { load: LOAD_ENDPOINT, save: SAVE_ENDPOINT } as const
