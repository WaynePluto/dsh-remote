/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`llm-pi-ai`、`github-copilot`） */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-settings'
import { GITHUB_COPILOT_MODELS } from '@earendil-works/pi-ai/providers/github-copilot.models'
import { PI_AI_NAMESPACE, PROVIDER_ID } from './shared.js'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`llm-pi-ai`） */
interface PiAiSection {
  providers?: Record<string, unknown>
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`llm-pi-ai`） */
function section(ctx: Context): PiAiSection | undefined {
  const settings = ctx.get('settings')
  if (settings === undefined) return undefined
  const value = settings.get(PI_AI_NAMESPACE)
  return typeof value === 'object' && value !== null ? (value as PiAiSection) : undefined
}

/** 从已保存 Copilot grant 规划并写回 `github-copilot` provider route。 */
export function isRouteConfigured(ctx: Context): boolean {
  return section(ctx)?.providers?.[PROVIDER_ID] !== undefined
}

export function subscriptionAuthWarning(ctx: Context): string | undefined {
  const route = section(ctx)?.providers?.[PROVIDER_ID]
  if (typeof route !== 'object' || route === null) return undefined
  const apiKeyEnv = (route as { apiKeyEnv?: unknown }).apiKeyEnv
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.trim() === '') return undefined
  return 'GitHub Copilot 的 API 密钥引用会优先于订阅登录凭据。'
    + '请点击“把模型加进来”切换为订阅认证并清理旧密钥。'
}

async function useSubscriptionAuth(ctx: Context): Promise<void> {
  const settings = ctx.get('settings')
  if (settings === undefined) return
  const route = section(ctx)?.providers?.[PROVIDER_ID] as { apiKeyEnv?: string } | undefined
  const reference = route?.apiKeyEnv || 'GITHUB_COPILOT_API_KEY'
  if (route?.apiKeyEnv) {
    await settings.mutate(PI_AI_NAMESPACE, [{ op: 'unset', path: ['providers', PROVIDER_ID, 'apiKeyEnv'] }])
    if (subscriptionAuthWarning(ctx) !== undefined) {
      throw new Error('无法清除 GitHub Copilot 的 API 密钥引用，尚未切换为订阅认证。')
    }
  }
  const stillReferenced = Object.values(section(ctx)?.providers ?? {}).some(provider =>
    typeof provider === 'object' && provider !== null
      && (provider as { apiKeyEnv?: unknown }).apiKeyEnv === reference,
  )
  if (!stillReferenced) await ctx.get('credentials')?.unset(reference as CredentialRef)
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`api`、`anthropic-messages`、`openai-completions`、`openai-responses`） */
export function describedModelIds(ids: readonly string[]): readonly string[] {
  return ids.filter(id => Object.hasOwn(GITHUB_COPILOT_MODELS, id))
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（涉及：`set`、`cordis.yml`） */
export async function ensureProviderRoute(ctx: Context, modelIds: readonly string[]): Promise<boolean> {
  const settings = ctx.get('settings')
  if (settings === undefined) return false
  await useSubscriptionAuth(ctx)
  const configured = isRouteConfigured(ctx)
  const described = describedModelIds(modelIds)
  if (described.length < modelIds.length) {
    ctx.logger?.info(
      'copilot-auth: %d of this account\'s %d models are newer than the installed pi-ai catalog and stay out of'
      + ' the route', modelIds.length - described.length, modelIds.length,
    )
  }
  if (described.length > 0) {
    await settings.mutate(PI_AI_NAMESPACE, [{
      op: 'set',
      path: ['providers', PROVIDER_ID, 'models'],
      value: described.map(id => ({ id })),
    }])
    return true
  }
  if (configured) return true
  await settings.mutate(PI_AI_NAMESPACE, [{ op: 'set', path: ['providers', PROVIDER_ID], value: {} }])
  return true
}
