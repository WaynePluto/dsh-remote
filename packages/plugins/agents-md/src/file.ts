/**
 * Reading and writing the one global instruction file.
 *
 * Separated from the plugin wiring so the file semantics can be tested against
 * a real temporary directory without a Cordis runtime.
 *
 * @module @dsh-remote/dsh-plugin-agents-md/file
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { utf8Bytes } from './shared.js'
import type { AgentsMdDocument } from './shared.js'

/**
 * The file name dsh reads the user-global instructions from.
 *
 * ⚠️ Hardcoded in dsh too, and deliberately mirrored rather than imported:
 * `USER_GLOBAL_FILE` lives in `@deepseek-ai/dsh-agent-instructions`'s internal
 * `render.ts` and is not part of that package's public entry, so importing it
 * would couple this plugin to an unexported path. If dsh ever renames it, this
 * page edits a file nothing reads — which is why the smoke check asserts the
 * name against dsh's own resolved baseline rather than against this constant.
 */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/**
 * Absolute path of the global instruction file.
 *
 * Resolved through dsh's own `resolveDshHome` so this plugin can never disagree
 * with the loader about which home is in effect: the precedence rules
 * (explicit config, then `$DSH_HOME`, then `~/.dsh`, with a blank `$DSH_HOME`
 * treated as unset) live in that one function.
 * @param home - explicit harness home; defaults to the resolved one.
 * @returns the absolute path of the file this plugin edits.
 */
export function agentsMdPath(home: string = resolveDshHome()): string {
  return join(home, USER_GLOBAL_FILE)
}

/**
 * Describe the global instruction file as it stands.
 *
 * A missing file is a normal, expected state — most machines have never had
 * one — and is reported as an empty document rather than as a failure, so the
 * page opens on a blank editor instead of an error.
 * @param home - explicit harness home; defaults to the resolved one.
 * @returns the file's contents and whether it exists.
 */
export async function readDocument(home: string = resolveDshHome()): Promise<AgentsMdDocument> {
  const path = agentsMdPath(home)
  const displayPath = `${dshHomeDisplay(home)}/${USER_GLOBAL_FILE}`
  try {
    const content = await readFile(path, 'utf8')
    return { content, exists: true, displayPath, bytes: utf8Bytes(content) }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { content: '', exists: false, displayPath, bytes: 0 }
    }
    throw error
  }
}

/**
 * Replace the global instruction file's contents.
 *
 * Written through a temporary file in the same directory and then renamed, so
 * a crash or a full disk mid-write cannot leave a half-written instruction file
 * behind. That matters more here than for ordinary user data: a truncated
 * `AGENTS.md` is silently fed to the model as if the person had written it.
 *
 * The harness home is created when absent, because a machine that has never
 * had a global instruction file may equally never have had the directory.
 * @param content - the full replacement contents.
 * @param home - explicit harness home; defaults to the resolved one.
 * @returns the document as it stands after the write.
 */
export async function writeDocument(
  content: string,
  home: string = resolveDshHome(),
): Promise<AgentsMdDocument> {
  const path = agentsMdPath(home)
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporary, content, 'utf8')
    await rename(temporary, path)
  } catch (error: unknown) {
    // A failed rename leaves the temporary file behind; drop it rather than
    // littering the harness home with one per failed save.
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return {
    content,
    exists: true,
    displayPath: `${dshHomeDisplay(home)}/${USER_GLOBAL_FILE}`,
    bytes: utf8Bytes(content),
  }
}
