/**
 * A pi-ai `CredentialStore` over dsh's credential records, narrowed to the one
 * provider this plugin signs into.
 *
 * This is the join that makes the whole plugin work without owning any OAuth
 * code: pi-ai's own GitHub Copilot flow writes its credential through a store,
 * and dsh's `llm-pi-ai` reads the very same record back out for every request
 * (`packages/llm/llm-pi-ai/src/auth.ts`). Writing through this adapter is
 * therefore indistinguishable from dsh having run the sign-in itself — token
 * refresh included, since pi-ai refreshes inside `modify()` on the next
 * request that finds the access token expired.
 *
 * @module @dsh-remote/dsh-plugin-copilot-auth/credential-store
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { Credential, CredentialInfo, CredentialStore } from '@earendil-works/pi-ai'
import { CREDENTIAL_KEY, PROVIDER_ID } from './shared.js'

/**
 * The record address, branded. `CredentialKey` is a branded string whose only
 * runtime content is `<scope>/<id>`, so the cast states what
 * `credentialKey('llm-pi-ai', 'github-copilot')` would have built — without a
 * value import of a dsh package, which an overlay-loaded plugin cannot make
 * safely (it would be a second module instance of dsh's own dependency).
 */
export const RECORD_KEY = CREDENTIAL_KEY as CredentialKey

/**
 * The JSON image of a value, dropping members that are explicitly
 * `undefined`.
 *
 * pi-ai credentials idiomatically carry optional members as explicit
 * `undefined` — a github.com Copilot grant holds `enterpriseUrl: undefined` —
 * and dsh's credential store refuses those as unrepresentable. dsh's own
 * adapter does exactly this before storing; a plugin that skipped it would see
 * every sign-in fail at the last step, on the write.
 * @param value - the value to render.
 * @returns the value's JSON image.
 */
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

/**
 * Read one stored record as the credential pi-ai expects.
 *
 * Only a `grant` record is ours: an `api-key` record under this key belongs to
 * someone who typed a key into the Models page, and reporting it as an OAuth
 * credential would make the card claim a subscription sign-in that never
 * happened.
 * @param record - the stored record, or undefined when nothing is stored.
 * @returns the pi-ai credential, or undefined.
 */
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

/**
 * The stored form of one pi-ai credential.
 * @param credential - what a login or a refresh produced.
 * @returns the record to commit.
 */
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

/** The credential-store facts a stored grant discloses to a surface. */
export interface StoredGrant {
  /** Whether an OAuth grant is stored for this provider. */
  signedIn: boolean
  /** Model ids the account may use, as the sign-in reported them. */
  modelIds: readonly string[]
}

/**
 * Describe the stored grant without exposing any of it.
 * @param record - the stored record, or undefined.
 * @returns presence and the public model-id list.
 */
export function describeGrant(record: CredentialRecord | undefined): StoredGrant {
  const credential = toPiCredential(record)
  if (credential?.type !== 'oauth') return { signedIn: false, modelIds: [] }
  const ids = (credential as { availableModelIds?: unknown }).availableModelIds
  return {
    signedIn: true,
    modelIds: Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [],
  }
}

/** Whether one pi-ai provider id is the one this store serves. */
function mine(providerId: string): boolean {
  return providerId === PROVIDER_ID
}

/**
 * Build the pi-ai credential store for this plugin's sign-in.
 *
 * Every method refuses a provider id other than ours: this store exists to
 * carry one flow's credential, and answering for another provider would let a
 * pi-ai collection built here write records this plugin does not own.
 * @param ctx - the plugin context; `ctx.credentials` is read per call so a
 *   provider mounted later, or replaced, is always the live one.
 * @returns the store to hand `createModels()`.
 */
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
