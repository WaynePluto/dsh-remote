/**
 * The handful of facts both halves of this plugin have to agree on.
 *
 * This module is imported by the Host half AND compiled into the browser
 * bundle, so it must stay free of Node built-ins and of every dsh package: the
 * client program (`tsconfig.client.json`) type-checks it with `"types": []`.
 *
 * @module @dsh-remote/dsh-plugin-agents-md/shared
 */

/**
 * The copy namespace of this plugin's settings page.
 *
 * The package name, per AGENTS.md. Note this plugin registers NO settings
 * namespace: its state is the `AGENTS.md` file itself, not a settings section,
 * so this string is only a locale key. Keeping the same spelling anyway means
 * the settings page id, the locale namespace and the package all read alike.
 */
export const NAMESPACE = 'dsh-plugin-agents-md'

/** The private RPC channel the editor reads and writes the file through. */
export const CHANNEL = '/agents-md'

/** Read the current file. */
export const LOAD_ENDPOINT = 'load'

/** Write the editor's contents back to the file. */
export const SAVE_ENDPOINT = 'save'

/** Every endpoint of {@link CHANNEL}. */
export const ENDPOINTS = [LOAD_ENDPOINT, SAVE_ENDPOINT] as const

/** One endpoint name of {@link CHANNEL}. */
export type AgentsMdEndpoint = typeof ENDPOINTS[number]

/**
 * The largest document this page will read or write, in UTF-8 bytes.
 *
 * ⚠️ This is NOT a limit this plugin invented. dsh's own instruction loader
 * refuses to read a candidate larger than its `maxSourceBytes`
 * (`agent-instructions/src/files.ts` `readBounded`), whose default is 1 MiB —
 * and a file over that limit is dropped SILENTLY, so a person who saved one
 * through this page would see it stored and never applied. Refusing the write
 * here is the only way that failure becomes visible.
 */
export const MAX_BYTES = 1_048_576

/**
 * What the Host reports about the global instruction file.
 *
 * `content` is the file exactly as stored, empty when it does not exist yet;
 * `exists` is what distinguishes "an empty file" from "no file", which is a
 * real difference to dsh (an absent candidate contributes nothing at all).
 */
export interface AgentsMdDocument {
  /** The file's contents, or the empty string when it does not exist. */
  content: string
  /** Whether the file exists on disk right now. */
  exists: boolean
  /** Symbolic location for display, e.g. `~/.dsh/AGENTS.md`. */
  displayPath: string
  /** Size of the stored content in UTF-8 bytes. */
  bytes: number
}

/** What one save did. */
export interface AgentsMdSaveResult {
  /** The document as it stands after the write. */
  document: AgentsMdDocument
}

/** What the editor sends to {@link SAVE_ENDPOINT}. */
export interface AgentsMdSaveRequest {
  /** The full replacement contents. */
  content: string
}

/**
 * Whether an endpoint name is one this channel serves.
 * @param endpoint - channel-relative endpoint name.
 * @returns whether it is a known endpoint.
 */
export function isAgentsMdEndpoint(endpoint: string): endpoint is AgentsMdEndpoint {
  return (ENDPOINTS as readonly string[]).includes(endpoint)
}

/**
 * Count the UTF-8 bytes of a string without Node's Buffer.
 *
 * Shared rather than duplicated because the page refuses an oversized document
 * BEFORE sending it and the Host refuses it again on arrival; two different
 * measurements would let a document the page accepted be rejected on the wire,
 * which is exactly the "page said yes, host said no" failure shape this
 * repository has already been bitten by (docs/02 §8.8).
 * @param text - the text to measure.
 * @returns its length in UTF-8 bytes.
 */
export function utf8Bytes(text: string): number {
  // TextEncoder is available in Node 22 and in every browser dsh supports.
  return new TextEncoder().encode(text).length
}

/**
 * Why a document cannot be saved, or undefined when it can.
 *
 * The single validator both halves call, so the page can never accept a
 * document the Host will refuse.
 * @param content - the candidate document.
 * @returns a machine-readable fault, or undefined when the content is fine.
 */
export function documentFault(content: string): 'too-large' | undefined {
  return utf8Bytes(content) > MAX_BYTES ? 'too-large' : undefined
}
