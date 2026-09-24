const MODEL_BUNDLE = '@dsh-station/dsh-plugin-model-enhancements'
const BOOTSTRAP_SERVICES = ['modelsCatalogBootstrap', 'modelCapabilitiesBootstrap']

export const name = 'dsh-station-model-bootstrap-fallback'
export const inject = ['profileContext']

/**
 * 模型增强未随本次进程启动时提供占位屏障；启用时由两个模型组件完成真实初始化后提供。
 * 服务挂在 root fiber 上，保证运行中停用模型 Bundle 不会迫使 llm-pi-ai 热重启。
 */
export function apply(ctx) {
  if (ctx.profileContext.startedBundles.includes(MODEL_BUNDLE)) return
  for (const service of BOOTSTRAP_SERVICES) {
    if (ctx.root.get(service) === undefined) ctx.root.provide(service, true)
  }
}
