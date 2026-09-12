/**
 * user-message-fork 的 Host half。
 * session fork 和 draft hand-off 使用 dsh 已有 browser API；本模块刻意为空，只通过 overlay 让 dsh 发现并提供 `dsh.client`。
 *
 * @module @dsh-remote/dsh-plugin-user-message-fork
 */

import type { Context } from '@deepseek-ai/cordis'

/** 出现在 dsh 诊断信息中的 Cordis 插件名。 */
export const name = 'dsh-remote-user-message-fork'

/** 挂载刻意为空的 Host half。 */
export function apply(_ctx: Context): void {
  // 所有行为位于 `src/client/index.tsx`。
}
