/**
 * dsh-remote 插件：为每个非空 turn segment 提供一个折叠的「执行过程」行。dsh 原生 fold 在长会话中受 historyIncomplete 限制，本插件在浏览器半读取 turn-process projection，使用独立节点和 shadow renderer 提供统一折叠。宿主半保持为空，仅用于让 dsh 发现浏览器 bundle。
 */

import type { Context } from '@deepseek-ai/cordis'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-exec-process'

/** 宿主半只用于让 dsh 发现浏览器 bundle，不注册运行时行为。 */
export function apply(_ctx: Context): void {
  // Host 半保持空实现；全部行为位于 `src/client/index.tsx`。
}
