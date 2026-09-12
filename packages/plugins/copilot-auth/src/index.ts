/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：启用 `ctx.credentials` Context 合并。
import type {} from '@deepseek-ai/dsh-credentials'
// 仅类型：启用本插件使用的 `ctx.connection` RPC registry。
import type { ConnectionRpcResult } from '@deepseek-ai/dsh-client-connection'
import { CopilotSignIn } from './sign-in.js'
import { CHANNEL, isCopilotEndpoint } from './shared.js'
import type { CopilotStatusView } from './shared.js'

export { CHANNEL, CREDENTIAL_KEY, PROVIDER_ID } from './shared.js'
export type { CopilotAttemptView, CopilotStatusView } from './shared.js'

/** Host half：注册 credentials、settings、Copilot sign-in RPC 和 provider route。 */
export const name = 'dsh-remote-copilot-auth'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`connection`、`credentials`） */
export const inject = ['connection', 'credentials']

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export const UNKNOWN_ENDPOINT_CODE = 'copilot-auth/unknown-endpoint'

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export const INTERNAL_CODE = 'copilot-auth/internal'

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export async function dispatch(
  signIn: CopilotSignIn,
  endpoint: string,
): Promise<ConnectionRpcResult<CopilotStatusView>> {
  if (!isCopilotEndpoint(endpoint)) {
    return {
      ok: false,
      error: { code: UNKNOWN_ENDPOINT_CODE, message: `unknown endpoint "${endpoint}"`, details: {} },
    }
  }
  try {
    switch (endpoint) {
      case 'start':
        return { ok: true, value: await signIn.start() }
      case 'configure':
        return { ok: true, value: await signIn.configure() }
      case 'cancel':
        signIn.cancel()
        return { ok: true, value: await signIn.status() }
      case 'sign-out':
        return { ok: true, value: await signIn.signOut() }
      default:
        return { ok: true, value: await signIn.status() }
    }
  } catch (error: unknown) {
    return {
      ok: false,
      error: {
        code: INTERNAL_CODE,
        message: error instanceof Error ? error.message : String(error),
        details: {},
      },
    }
  }
}

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。 */
export function apply(ctx: Context): void {
  const signIn = new CopilotSignIn(ctx)
  // `handle()` 通过 connection 注册自己的顶层路由
  // service 并将注册绑定到该 fiber，因此卸载插件
  // 会一并移除路由；尝试也会同时终止，因为 device
  // poll 不能超出负责保存结果的插件生命周期。
  const dispose = ctx.connection.rpc.handle(CHANNEL, async (endpoint) => await dispatch(signIn, endpoint))
  ctx.effect(() => () => {
    signIn.dispose()
    void dispose()
  }, 'copilot-auth: sign-in channel')
}
