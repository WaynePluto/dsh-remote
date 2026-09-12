/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`CredentialStore`、`llm-pi-ai`） */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { CREDENTIAL_KEY, PROVIDER_ID } from './shared.js'

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`CredentialKey`、`<scope>/<id>`、`credentialKey('llm-pi-ai', 'github-copilot')`） */
export const RECORD_KEY = CREDENTIAL_KEY as CredentialKey

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`undefined`、`enterpriseUrl: undefined`） */
export function jsonImage(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(entry => (entry === undefined ? null : jsonImage(entry)))
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const image: Record<string, unknown> = {}
    for (const [key, member] of Object.entries(value)) {
      if (member !== undefined) image[key] = jsonImage(member)
    }
    return image
  }
  return value
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。（涉及：`grant`、`api-key`） */
export function toPiCredential(record: CredentialRecord | undefined): Credential | undefined {
  if (record === undefined) return undefined
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...record.key === undefined ? {} : { key: record.key },
      ...record.env === undefined ? {} : { env: { ...record.env } },
    }
  }
  return record.payload as Credential
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export function toRecord(credential: Credential): CredentialRecord {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...credential.key === undefined ? {} : { key: credential.key },
      ...credential.env === undefined ? {} : { env: { ...credential.env } },
    }
  }
  return { kind: 'grant', payload: jsonImage(credential) }
}

/** 已存 grant 可向页面披露的 credential-store 信息。 */
export interface StoredGrant {
  /** 该 provider 是否保存 OAuth grant。 */
  signedIn: boolean
  /** 登录流程报告的账号可用模型 id。 */
  modelIds: readonly string[]
}

/** 模型目录契约：此处说明 provider、协议、目录覆盖和用户条目保留。 */
export function describeGrant(record: CredentialRecord | undefined): StoredGrant {
  const credential = toPiCredential(record)
  if (credential?.type !== 'oauth') return { signedIn: false, modelIds: [] }
  const ids = (credential as { availableModelIds?: unknown }).availableModelIds
  return {
    signedIn: true,
    modelIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** 判断 pi-ai provider id 是否由本 store 服务。 */
function mine(providerId: string): boolean {
  return providerId === PROVIDER_ID
}

/** 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。（涉及：`ctx.credentials`、`createModels()`） */
export function credentialStoreFor(ctx: Context): CredentialStore {
  const credentials = (): Context['credentials'] => {
    const service = ctx.get('credentials')
    if (service === undefined) {
      throw new Error(
        'copilot-auth: this dsh composition mounts no credentials service, so a sign-in would have nowhere to'
        + ' store its grant',
      )
    }
    return service
  }
  return {
    async read(providerId) {
      if (!mine(providerId)) return undefined
      return toPiCredential(await credentials().readRecord(RECORD_KEY))
    },
    async list(): Promise<readonly CredentialInfo[]> {
      const record = await credentials().readRecord(RECORD_KEY)
      const credential = toPiCredential(record)
      return credential === undefined ? [] : [{ providerId: PROVIDER_ID, type: credential.type }]
    },
    async modify(providerId, mutate) {
      if (!mine(providerId)) {
        throw new Error(`copilot-auth: refusing to write a credential for "${providerId}"`)
      }
      const stored = await credentials().modifyRecord(RECORD_KEY, async (current) => {
        const next = await mutate(toPiCredential(current))
        return next === undefined ? undefined : toRecord(next)
      })
      return toPiCredential(stored)
    },
    async delete(providerId) {
      if (!mine(providerId)) return
      await credentials().deleteRecord(RECORD_KEY)
    },
  }
}
