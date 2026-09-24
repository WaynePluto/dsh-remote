/** Host half：停用不安全的 adaptive directory picker，并动态挂载官方 browse Host/client。 */

import type { Context } from '@deepseek-ai/cordis'
// 仅类型：激活 Loader Context merge，运行时通过 `ctx.loader` 访问实例。
import type {} from '@deepseek-ai/cordis-plugin-loader'

/** 对远程浏览器不安全的 dsh adaptive backend 行。 */
export const DIRECTORY_PICKER_AUTO = '@deepseek-ai/dsh-host-directory-picker-auto'
/** 在浏览器流程中列出目录的 dsh 宿主半。 */
export const DIRECTORY_PICKER_BROWSE_HOST = '@deepseek-ai/dsh-host-directory-picker-browse'
/** 渲染应用内目录对话框的 dsh 浏览器半。 */
export const DIRECTORY_PICKER_BROWSE_CLIENT = '@deepseek-ai/dsh-client-ui-directory-picker-browse'

/** 组成一次 browse 交互的两个官方 Loader 条目。 */
export const BROWSE_PICKER_PACKAGES = [
  DIRECTORY_PICKER_BROWSE_HOST,
  DIRECTORY_PICKER_BROWSE_CLIENT,
] as const

/** Cordis 插件名。 */
export const name = 'dsh-station-directory-picker-browse'
/** Loader 是替换该组合交互所需的唯一服务。 */
export const inject = ['loader']

/** 查找 dsh 默认挂载的 adaptive `directory-picker` 条目。 */
function findAdaptiveEntry(ctx: Context) {
  return [...ctx.loader.entries()].find(entry => entry.options.name === DIRECTORY_PICKER_AUTO)
}

/** 只有本插件动态停用 adaptive 行时才恢复它。 */
async function restoreAdaptiveEntry(
  ctx: Context,
  entryId: string | undefined,
  wasEnabled: boolean,
): Promise<void> {
  if (!wasEnabled || entryId === undefined || ctx.loader.store[entryId] === undefined) return
  await ctx.loader.update(entryId, { disabled: false })
}

/** 停用 adaptive 条目，按官方 backend→browser surface 顺序挂载 browse 两半，并在卸载时恢复原条目。 */
export async function apply(ctx: Context): Promise<void> {
  const adaptiveEntry = findAdaptiveEntry(ctx)
  const adaptiveEntryId = adaptiveEntry?.id
  const wasAdaptiveEnabled = adaptiveEntry !== undefined && !adaptiveEntry.disabled

  if (wasAdaptiveEnabled && adaptiveEntryId !== undefined) {
    // 更新现有条目而不是删除它，可保留
    // profile 行，并让插件卸载后恢复官方 auto chooser。
    await ctx.loader.update(adaptiveEntryId, { disabled: true })
  }

  try {
    await ctx.effect(async () => {
      const mountedIds: string[] = []

      const unmount = async (): Promise<void> => {
        for (const id of mountedIds.toReversed()) {
          // 父级树或失败的激活可能已经移除了它。
          if (ctx.loader.store[id] === undefined) continue
          // 逆挂载每个实际创建的 Loader 条目，父级已移除时跳过。
          // eslint-disable-next-line no-await-in-loop -- 条目必须按挂载逆序移除。
          await ctx.loader.remove(id)
        }
      }

      try {
        // 保持宿主 backend 在浏览器 surface 之前，完全遵循
        // 上游 adaptive 组合；surface 驱动这项能力。
        for (const packageName of BROWSE_PICKER_PACKAGES) {
          // 先挂载宿主 backend，再挂载浏览器 surface，遵循官方 adaptive 组合。
          // eslint-disable-next-line no-await-in-loop -- 浏览器 surface 必须跟在宿主 backend 之后。
          mountedIds.push(await ctx.loader.create({ name: packageName }))
        }
      } catch (cause) {
        await unmount()
        throw cause
      }

      return async () => {
        try {
          await unmount()
        } finally {
          await restoreAdaptiveEntry(ctx, adaptiveEntryId, wasAdaptiveEnabled)
        }
      }
    }, 'dsh-station: browser directory picker')
  } catch (cause) {
    // 如果复制或自定义 profile 有启用的 adaptive 行，不要让它
    // 在替换失败后保持停用。dsh-station overlay 的静态
    // disable 仍然是有意的，失败启动会明确报告。
    await restoreAdaptiveEntry(ctx, adaptiveEntryId, wasAdaptiveEnabled)
    throw cause
  }
}
