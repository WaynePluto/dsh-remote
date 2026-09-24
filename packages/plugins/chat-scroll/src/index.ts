/** Host half 为空；overlay 只需让 dsh 发现 browser bundle。 */

import type { Context } from '@deepseek-ai/cordis'

/** dsh 诊断信息中显示的 Cordis 插件名。 */
export const name = 'dsh-station-chat-scroll'

/** 挂载刻意为空的宿主半。 */
export function apply(_ctx: Context): void {
  // 所有行为都在 src/client/index.tsx。
}
