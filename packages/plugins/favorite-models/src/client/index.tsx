import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type { ModelDirectoryResolver } from '@deepseek-ai/dsh-client-ui-model-selection/client'

import type { FavoriteModelsSettings } from '../shared.js'
import { ENTRY_ID, NAMESPACE } from '../shared.js'
import { FavoriteModelSelect } from './FavoriteModelSelect.js'
import { FavoriteModelsPanel } from './FavoriteModelsPanel.js'
import { en, zh } from './locales.js'
import type { FavoriteModelsKey } from './locales.js'

/** 本插件拥有的 locale 命名空间。 */
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'dsh-plugin-favorite-models': FavoriteModelsKey
  }
}

/** 进程与运行时契约：此处说明生命周期、身份核验、轮询或终端边界。（dsh 0.1.7 起设置表单经 `configForms` 按 entry id 绑定） */
export const inject = [
  'slots', 'locale', 'configForms', 'sessions', 'modelDirectories',
  'uiSession',
  'remote', 'remote.session',
]

type DirectorySessionId = Parameters<ModelDirectoryResolver['directoryFor']>[0]

/** 注册 settings footer 和 priority shadow 的 composer selector。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NAMESPACE, { zh, en }), 'favorite-models: copy dictionaries')
  const t = ctx.locale.bind(NAMESPACE)
  const favorites = ctx.configForms.get<FavoriteModelsSettings>(ENTRY_ID)
  const getDirectory = (sessionId: string) => ctx.modelDirectories.directoryFor(sessionId as DirectorySessionId)

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: NAMESPACE,
    locale: NAMESPACE,
    inject: () => ({
      form: favorites,
      session: ctx.uiSession.adapter.current,
      getDirectory,
      t,
    }),
  }, FavoriteModelsPanel))

  ctx.slots.inject('conversation.input.model', () => ctx.slots.register({
    name: 'conversation.input.model',
    priority: -1,
    locale: NAMESPACE,
    inject: (sessionId: DirectorySessionId) => {
      const directory = ctx.modelDirectories.directoryFor(sessionId)
      const available = ctx.sessions.subagentAddress(sessionId) === undefined
      return {
        available,
        directory: directory.store,
        load: () => {
          if (available) directory.load().catch(() => { /* 错误通过共享 store 显示 */ })
        },
        select: (selection: ModelSelection) => available
          ? directory.select(selection).then(() => true, () => false)
          : Promise.resolve(false),
        favorites,
      }
    },
  }, FavoriteModelSelect))
}
