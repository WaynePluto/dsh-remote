/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */

import type { ProviderCardExtrasOwnerProps } from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'settings.models.provider-card.capabilities': {
      kind: 'single'
      scope: 'root'
      owner: ProviderCardExtrasOwnerProps
    }
  }
}
