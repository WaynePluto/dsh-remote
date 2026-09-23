import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { OpenInAppActionInjected } from '@deepseek-ai/dsh-client-ui-open-in-app/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { CHANNEL, OPEN_WORKSPACE_ENDPOINT } from '../shared.js'

const SLOT = 'conversation.session.header.utilities'
const OPEN_IN_APP_ID = 'open-in-app'

type Inject = (...args: never[]) => Record<string, unknown>

function explorerInject(entry: StoredEntry, connection: ConnectionHandle): StoredEntry['inject'] {
  const original = entry.inject as Inject | undefined
  return ((...args: never[]) => {
    const face = original?.(...args) as OpenInAppActionInjected | undefined
    if (face === undefined || typeof face.launch !== 'function') {
      throw new Error('open-in-app entry has no launch capability')
    }
    return {
      ...face,
      launch: async (appId: string, path: string): Promise<void> => {
        if (appId !== 'explorer') return face.launch(appId, path)
        const result = await connection.rpc.call(CHANNEL, OPEN_WORKSPACE_ENDPOINT, { path })
        if (!result.ok) throw new Error(result.error.message)
      },
    } satisfies OpenInAppActionInjected
  }) as StoredEntry['inject']
}

/** 找到原生顶部 Open In… 项；忽略本插件自己的低优先级 shadow。 */
export function nativeOpenInAppEntry(entries: readonly StoredEntry[]): StoredEntry | undefined {
  return entries.find(entry => entry.options.id === OPEN_IN_APP_ID && (entry.options.priority ?? 0) >= 0)
}

/** 保留原生组件和所有菜单项，只替换 Explorer 的启动通道。 */
export function installExplorerLaunch(ctx: Context, connection: ConnectionHandle): () => void {
  let native: StoredEntry | undefined
  let disposeShadow: (() => void) | undefined
  let stopped = false
  const reconcile = (): void => {
    if (stopped) return
    const candidate = nativeOpenInAppEntry(ctx.slots.entries(SLOT) as readonly StoredEntry[])
    if (candidate === native) return
    disposeShadow?.()
    disposeShadow = undefined
    native = candidate
    if (candidate === undefined) return
    const options: Record<string, unknown> = {
      name: SLOT,
      id: OPEN_IN_APP_ID,
      priority: -1,
      order: candidate.options.order,
      label: candidate.options.label,
      locale: candidate.locale,
      store: candidate.store,
      inject: explorerInject(candidate, connection),
    }
    const slots = ctx.slots as unknown as {
      register: (options: Record<string, unknown>, component: StoredEntry['component']) => () => void
    }
    disposeShadow = slots.register(options, candidate.component)
  }
  const unsubscribe = ctx.slots.subscribe(SLOT, reconcile)
  reconcile()
  return () => {
    stopped = true
    unsubscribe()
    disposeShadow?.()
  }
}

export const inject = ['slots', 'connection']

export function apply(ctx: Context): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject(SLOT, () => installExplorerLaunch(ctx, connection))
}
