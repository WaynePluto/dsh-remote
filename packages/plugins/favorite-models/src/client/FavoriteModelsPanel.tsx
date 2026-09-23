import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { Button, IconChevronDownOutlineMedium, Input, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ModelDirectory, ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import { staleFavorites } from '../filter.js'
import {
  canonicalizeFavorites, favoriteKey, favoritesFault, sameFavorites, DEFAULT_SETTINGS,
} from '../shared.js'
import type { FavoriteModel, FavoriteModelsSettings } from '../shared.js'
import { fill } from './locales.js'
import type { FavoriteModelsKey } from './locales.js'
import * as css from './styles.js'

/** dsh 0.1.6 起 sessions.list 不再携带当前会话；视图侧当前绑定来自 `ctx.uiSession.adapter.current`（key 为会话 id）。 */
interface SessionBindingSource {
  getSnapshot(): { key: string | undefined }
  subscribe(listener: () => void): () => void
}

export interface FavoriteModelsPanelProps {
  form?: ConfigForm<FavoriteModelsSettings>
  session?: SessionBindingSource
  getDirectory?: (sessionId: string) => Pick<ModelDirectory, 'store' | 'load'>
  t?: (key: FavoriteModelsKey) => string
}

const EMPTY_DIRECTORY: ModelDirectoryState = {
  current: null,
  routable: null,
  groups: [],
  failures: [],
  status: 'idle',
  error: null,
}
const noopSubscribe = (): (() => void) => () => {}

/** 缺省快照必须是稳定引用，否则 useSyncExternalStore 会无限重渲染。 */
const NO_SESSION_BINDING = { key: undefined }

/** 没有 form 时报告不可写、不可用，保持渲染分支一致。 */
const NO_FORM_SNAPSHOT: ConfigFormSnapshot<FavoriteModelsSettings> = {
  status: 'unavailable',
  value: undefined,
  base: undefined,
  user: undefined,
  revision: undefined,
  writable: false,
  mode: 'memory',
}

function textOf(t: ((key: FavoriteModelsKey) => string) | undefined, key: FavoriteModelsKey): string {
  return t?.(key) ?? key
}

export function FavoriteModelsPanel({ form, session, getDirectory, t }: FavoriteModelsPanelProps): ReactNode {
  const settingsSnapshot = useSyncExternalStore(
    listener => form?.subscribe(listener) ?? noopSubscribe(),
    () => form?.getSnapshot() ?? NO_FORM_SNAPSHOT,
    () => form?.getSnapshot() ?? NO_FORM_SNAPSHOT,
  )
  const sessionBinding = useSyncExternalStore(
    listener => session?.subscribe(listener) ?? noopSubscribe(),
    () => session?.getSnapshot() ?? NO_SESSION_BINDING,
    () => session?.getSnapshot() ?? NO_SESSION_BINDING,
  )
  const sessionId = sessionBinding.key
  const directory = sessionId === undefined || getDirectory === undefined ? undefined : getDirectory(sessionId)
  const directoryState = useSyncExternalStore(
    listener => directory?.store.subscribe(listener) ?? noopSubscribe(),
    () => directory?.store.getSnapshot() ?? EMPTY_DIRECTORY,
    () => directory?.store.getSnapshot() ?? EMPTY_DIRECTORY,
  )

  useEffect(() => {
    if (directory === undefined) return
    void directory.load().catch(() => { /** 目录加载失败时保持 panel 可用；错误通过 settings section 的状态显示。 */ })
  }, [directory])

  const settings = settingsSnapshot.value ?? DEFAULT_SETTINGS
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<FavoriteModel[] | undefined>(undefined)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const committed = useRef<FavoriteModelsSettings | undefined>(undefined)
  const editorId = useId()

  // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
  // 设置写入契约：此处说明命名空间、校验、回读确认和草稿保留。
  const storedFavoritesKey = canonicalizeFavorites(settings.favorites)
    .map(favoriteKey)
    .join('\u001f')
  useEffect(() => {
    const echo = committed.current
    if (echo !== undefined && sameFavorites(echo.favorites, settings.favorites)) return
    setDraft(undefined)
    setSaved(false)
    setFailure(undefined)
  }, [storedFavoritesKey])

  const selected = canonicalizeFavorites(draft ?? settings.favorites)
  const selectedKeys = useMemo(() => new Set(selected.map(favoriteKey)), [selected])
  const dirty = draft !== undefined && !sameFavorites(draft, settings.favorites)
  const readyDirectory = directoryState.status === 'ready'
  const stale = readyDirectory ? staleFavorites(directoryState.groups, selected) : []
  const query = search.trim().toLocaleLowerCase()
  const visibleGroups = useMemo(() => {
    if (query === '') return directoryState.groups
    return directoryState.groups.flatMap(group => {
      const providerMatch = `${group.id} ${group.name}`.toLocaleLowerCase().includes(query)
      const models = providerMatch
        ? group.models
        : group.models.filter(model => `${model.id} ${model.name}`.toLocaleLowerCase().includes(query))
      return models.length === 0 ? [] : [{ ...group, models }]
    })
  }, [directoryState.groups, query])

  const setSelection = useCallback((next: readonly FavoriteModel[]): void => {
    setDraft(canonicalizeFavorites(next))
    setSaved(false)
    setFailure(undefined)
  }, [])

  const toggle = useCallback((provider: string, model: string): void => {
    const favorite = { provider, model }
    const current = canonicalizeFavorites(draft ?? settings.favorites)
    const key = favoriteKey(favorite)
    setSelection(current.some(item => favoriteKey(item) === key)
      ? current.filter(item => favoriteKey(item) !== key)
      : [...current, favorite])
  }, [draft, settings.favorites, setSelection])

  const remove = useCallback((favorite: FavoriteModel): void => {
    const key = favoriteKey(favorite)
    setSelection(canonicalizeFavorites(draft ?? settings.favorites).filter(item => favoriteKey(item) !== key))
  }, [draft, settings.favorites, setSelection])

  const clear = useCallback((): void => { setSelection([]) }, [setSelection])
  const cancel = useCallback((): void => {
    setDraft(undefined)
    setFailure(undefined)
    setSaved(false)
  }, [])

  /** 设置写入契约：dsh 0.1.7 起 `form.mutate` 返回 boolean（false=宿主拒绝），无需再写后回读比对。 */
  const commit = useCallback(async (): Promise<void> => {
    if (form === undefined) return
    const next = canonicalizeFavorites(draft ?? settings.favorites)
    const fault = favoritesFault({ favorites: next })
    if (fault !== undefined) {
      setFailure(fault)
      return
    }
    if (sameFavorites(next, settings.favorites)) {
      setDraft(undefined)
      setSaved(true)
      return
    }
    setFailure(undefined)
    setBusy(true)
    try {
      const wireFavorites = next.map(favorite => ({ provider: favorite.provider, model: favorite.model }))
      const accepted = await form.mutate([{ op: 'set', path: ['favorites'], value: wireFavorites }])
      if (!accepted) {
        setFailure(textOf(t, 'rejected'))
        return
      }
      committed.current = { favorites: next }
      setDraft(undefined)
      setSaved(true)
    } catch (error: unknown) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }, [draft, form, settings.favorites, t])

  if (t === undefined || form === undefined) return null
  if (settingsSnapshot.status === 'loading') return <p style={css.note}>{t('loading')}</p>
  if (settingsSnapshot.status === 'unavailable') return <p style={css.errorText}>{t('unavailable')}</p>

  const readOnly = !settingsSnapshot.writable || busy
  return (
    <section style={css.page} aria-label={t('title')} data-dsh-plugin-favorite-models="">
      <div style={css.header}>
        <button
          type="button"
          style={css.headerToggle}
          aria-label={`${t(open ? 'collapse' : 'expand')}: ${t('title')}`}
          aria-expanded={open}
          aria-controls={editorId}
          onClick={() => { setOpen(value => !value) }}
        >
          <span style={css.headerCopy}>
            <span style={css.headerTitle}>{t('title')}</span>
            <span style={css.headerSummary}>
              {fill(t('selected'), { count: selected.length })}
              {dirty ? <span style={css.headerTag}><Tag tone="warning">{t('dirty')}</Tag></span> : null}
            </span>
          </span>
          <span
            style={{ ...css.chevron, transform: open ? 'rotate(180deg)' : undefined }}
            aria-hidden="true"
          >
            <IconChevronDownOutlineMedium />
          </span>
        </button>
      </div>

      {open
        ? (
          <div id={editorId} style={css.body} data-dsh-plugin-favorite-models-editor="">
            <p style={css.note}>{t('intro')}</p>

            {directory === undefined
              ? <p style={css.note}>{t('noSession')}</p>
              : directoryState.status === 'loading' || directoryState.status === 'idle'
                ? <p style={css.note}>{t('loading')}</p>
                : null}
            {directoryState.error !== null
              ? <p style={css.errorText}>{fill(t('loadFailed'), { message: directoryState.error })}</p>
              : null}
            {!settingsSnapshot.writable ? <p style={css.note}>{t('readOnly')}</p> : null}

            {stale.length > 0
              ? (
                <div style={css.staleBox}>
                  <strong>{t('staleTitle')}</strong>
                  <span style={css.note}>{t('staleHint')}</span>
                  {stale.map(favorite => (
                    <div style={css.staleLine} key={favoriteKey(favorite)}>
                      <span style={css.staleName}>{fill(t('staleItem'), { provider: favorite.provider, model: favorite.model })}</span>
                      <Button variant="outline" size="sm" disabled={readOnly} onClick={() => { remove(favorite) }}>
                        {t('remove')}
                      </Button>
                    </div>
                  ))}
                </div>
              )
              : null}

            <div style={css.field}>
              <label htmlFor="favorite-models-search">{t('search')}</label>
              <Input
                id="favorite-models-search"
                type="search"
                value={search}
                placeholder={t('searchPlaceholder')}
                onChange={event => { setSearch(event.target.value) }}
              />
            </div>

            <div style={css.row}>
              <span style={css.mutedText}>{fill(t('selected'), { count: selected.length })}</span>
              {dirty ? <span style={css.headerTag}><Tag tone="warning">{t('dirty')}</Tag></span> : null}
              {saved && !dirty ? <Tag tone="success">{t('saved')}</Tag> : null}
            </div>

            {directoryState.failures.map(failureItem => (
              <p style={css.note} key={failureItem.id}>
                {fill(t('groupLoadWarning'), { name: failureItem.name, message: failureItem.message })}
              </p>
            ))}

            <div
              style={css.modelList}
              data-dsh-plugin-favorite-models-list=""
              aria-label={t('modelList')}
            >
              {visibleGroups.map(group => (
                <div style={css.group} key={group.id}>
                  <div style={css.groupTitle}>{group.name}</div>
                  {group.models.map(model => {
                    const key = favoriteKey({ provider: group.id, model: model.id })
                    return (
                      <label style={css.checkboxRow} key={model.id}>
                        <input
                          type="checkbox"
                          checked={selectedKeys.has(key)}
                          disabled={readOnly}
                          onChange={() => { toggle(group.id, model.id) }}
                        />
                        <span style={css.checkboxLabel} title={model.id}>{model.name}</span>
                      </label>
                    )
                  })}
                </div>
              ))}
              {readyDirectory && directoryState.groups.length > 0 && visibleGroups.length === 0
                ? <p style={css.note}>{t('noMatches')}</p>
                : null}
              {readyDirectory && directoryState.groups.length === 0
                ? <p style={css.note}>{t('noModels')}</p>
                : null}
            </div>

            <div style={css.actions} data-dsh-plugin-favorite-models-actions="">
              <Button variant="primary" size="sm" disabled={readOnly || !dirty} onClick={() => { void commit() }}>
                {busy ? t('saving') : t('save')}
              </Button>
              <Button variant="outline" size="sm" disabled={readOnly || selected.length === 0} onClick={clear}>
                {t('clear')}
              </Button>
              <Button variant="outline" size="sm" disabled={readOnly || !dirty} onClick={cancel}>
                {t('cancel')}
              </Button>
            </div>
            {failure !== undefined ? <p style={css.errorText}>{failure}</p> : null}
          </div>
        )
        : null}
    </section>
  )
}
