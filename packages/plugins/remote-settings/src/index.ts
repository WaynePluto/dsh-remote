/**
 * dsh-remote 插件（自 remote-privileged 拆出的 ownsHost 部分）：让已认证的远程浏览器获得与机器本地浏览器相同的 dsh surface。dsh 在浏览器端依据 loopback 判断 settings 是否可持久化；relay 已先完成认证，本插件通过 `ClientTransportHooks.ownsHost` 告知页面可以使用宿主状态。它不触碰 `/api` trust fence、不伪造 header，也不改变 relay 转发。
 *
 * Cordis 插件名保留拆分前的 dsh-remote-remote-privileged，插件树与诊断里的身份不变。
 *
 * @module @dsh-remote/dsh-plugin-remote-settings
 */

import type { Context } from '@deepseek-ai/cordis'
// 实现说明：此处记录相关接口、边界和生命周期约束。（涉及：`declare module`）
// 合并，使 `webserver/index-inject` 出现在本模块 Events
// 视图中。仅类型导入，产出的插件仍是无依赖单文件。
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

/** Cordis 插件名；它会出现在 dsh 插件树和诊断信息中。 */
export const name = 'dsh-remote-remote-privileged'

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。 */
export const inject = ['webServer']

/** dsh 读取 transport hooks 的页面全局对象。 */
export const TRANSPORT_GLOBAL = '__DSH_TRANSPORT__'

/** 传输契约：此处说明 RPC 端点、路径段、Host/Origin 围栏或认证边界。（涉及：`ownsHost`、`fetch`、`openStream`、`loadBundle`、`createWebConnectionRpc`、`packages/client/connection/src/client/rpc.ts`、`packages/client/web/src/boot.ts`、`global`、`__DSH_TRANSPORT__`） */
export function transportInjection(): IndexInjection {
  return { kind: 'global', name: TRANSPORT_GLOBAL, value: { ownsHost: true } }
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`webServer`） */
export function apply(ctx: Context): void {
  ctx.on('webserver/index-inject', (table: IndexInjection[]) => {
    table.push(transportInjection())
  })
}
