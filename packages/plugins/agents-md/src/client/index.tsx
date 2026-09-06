/**
 * Browser half: add a Global instructions page to Settings.
 *
 * `settings.section` is the seat dsh declares for "one settings page per list
 * entry". Unlike this repository's other settings pages, this one owns NO
 * settings namespace: the document it edits is a file on the Host
 * (`$DSH_HOME/AGENTS.md`), so the page talks to its own private RPC channel
 * instead of `ctx.settingsScope`. Putting the text in a settings namespace
 * would have created a second copy of it that dsh's instruction loader does not
 * read.
 *
 * ⚠️ dsh draws the settings navigation icons itself from a hardcoded id → icon
 * table and `settings.section` has no icon seat, so every id it does not know
 * falls back to the gear (docs/02 §8.7). The document glyph is therefore
 * painted onto our own row from the outside; see `./nav-glyph.ts`.
 *
 * @module @dsh-remote/dsh-plugin-agents-md/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: each pulls in the Context merge naming the service this plugin
// reads. `dsh-client-ui-settings/client` carries the settings slot declarations.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import { CHANNEL, LOAD_ENDPOINT, NAMESPACE, SAVE_ENDPOINT } from '../shared.js'
import type { AgentsMdDocument, AgentsMdSaveResult } from '../shared.js'
import { AgentsMdSection } from './AgentsMdSection.js'
import { installNavGlyph } from './nav-glyph.js'
import { en, zh } from './locales.js'
import type { AgentsMdKey } from './locales.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** This plugin's copy namespace. */
    'dsh-plugin-agents-md': AgentsMdKey
  }
}

/** The copy namespace this plugin owns. */
const NS = NAMESPACE

/**
 * Where this page sits in the settings navigation.
 *
 * Before Proxy (60) and Notifications (70): unlike those two, this one is
 * content a person comes back to and edits repeatedly, rather than a switch
 * configured once and forgotten.
 */
const ORDER = 55

/**
 * Required services. `slots` is the seat, `locale` supplies the copy, and
 * `connection` carries this page's only channel. There is deliberately no
 * `settingsScope`: this page stores nothing in the settings domain.
 */
export const inject = ['slots', 'locale', 'connection']

/** The failure this plugin reports when the Host answers with an error. */
export class AgentsMdChannelError extends Error {}

/**
 * Register the page.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'agents-md: copy dictionaries')
  const t = ctx.locale.bind(NS)

  /**
   * Call one endpoint of this plugin's channel.
   *
   * ⚠️ The endpoint is a PATH SEGMENT: this posts to `/agents-md/<endpoint>`,
   * and the envelope's method must match that last segment (docs/02 §10.8).
   * @param endpoint - channel-relative endpoint name.
   * @param payload - the request body.
   * @returns the Host's value.
   * @throws AgentsMdChannelError when there is no connection or the Host failed.
   */
  const call = async <T,>(endpoint: string, payload: unknown): Promise<T> => {
    const connection = ctx.get('connection') as ConnectionHandle | undefined
    if (connection === undefined) throw new AgentsMdChannelError('no active connection')
    const result = await connection.rpc.call(CHANNEL, endpoint, payload)
    if (!result.ok) throw new AgentsMdChannelError(result.error.message)
    return result.value as T
  }

  /**
   * Read the stored global instruction file.
   * @returns the document as the Host has it.
   */
  const load = async (): Promise<AgentsMdDocument> =>
    await call<AgentsMdDocument>(LOAD_ENDPOINT, {})

  /**
   * Replace the stored global instruction file.
   * @param content - the full replacement contents.
   * @returns the document as it stands after the write.
   */
  const save = async (content: string): Promise<AgentsMdDocument> =>
    (await call<AgentsMdSaveResult>(SAVE_ENDPOINT, { content })).document

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: NAMESPACE,
    order: ORDER,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ load, save }),
  }, AgentsMdSection))

  // The shell draws the nav glyph itself and has no seat for ours, so the
  // document icon is painted onto our own row from the outside.
  ctx.effect(installNavGlyph, 'agents-md: settings nav glyph')
}
