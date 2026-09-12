/** 对 `$DSH_HOME/AGENTS.md` 的有界读取和原子写入。 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { dshHomeDisplay, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { utf8Bytes } from './shared.js'
import type { AgentsMdDocument } from './shared.js'

/** dsh 全局提示词文件名，与 `@deepseek-ai/dsh-agent-instructions` 的 `render.ts` 读取位置一致。 */
export const USER_GLOBAL_FILE = 'AGENTS.md'

/** 解析 `$DSH_HOME`（默认 `~/.dsh`）下的全局 AGENTS.md 路径。 */
export function agentsMdPath(home: string = resolveDshHome()): string {
  return join(home, USER_GLOBAL_FILE)
}

/** 读取文件；不存在时返回空 document，不把缺失当成错误。 */
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

/** 以临时文件 + rename 原子写入 AGENTS.md，失败时清理临时文件。 */
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
    // rename 失败会留下临时文件；删除它，避免
    // 每次保存失败都污染 harness home。
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
