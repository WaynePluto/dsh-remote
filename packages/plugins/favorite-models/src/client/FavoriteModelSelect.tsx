import {
  useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
} from 'react'
import type { CSSProperties, FocusEvent, KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type { ModelReasoningEffort, ModelSelection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelDirectoryState } from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14,
  IconWarningOutline16, Toast,
} from '@deepseek-ai/dsh-client-ui-primitives'
import { filterFavoriteGroups } from '../filter.js'
import { DEFAULT_SETTINGS } from '../shared.js'
import type { FavoriteModelsSettings } from '../shared.js'
import { fill } from './locales.js'
import type { FavoriteModelsKey } from './locales.js'
import { SELECTOR_STYLE_MARKER, selectorClasses, selectorStyles } from './selector-styles.js'

export interface FavoriteModelSelectInjected {
  available: boolean
  directory: SnapshotStore<ModelDirectoryState>
  load: () => void
  select: (selection: ModelSelection) => Promise<boolean>
  favorites: SettingsScope<FavoriteModelsSettings>
}

type Pane = 'root' | 'model' | 'effort'
interface EffortChoice { key: string; effort: string | undefined; label: string }

/** 收藏 selector 的渲染 props。 */
const MEASURE_STYLE: CSSProperties = { visibility: 'hidden', left: 0, top: 0 }

function translate(t: ((key: FavoriteModelsKey) => string) | undefined, key: FavoriteModelsKey): string {
  return t?.(key) ?? key
}

export function FavoriteModelSelect({
  locked, available, directory, load, select, favorites, t,
}: FavoriteModelSelectInjected & { locked: boolean; t?: (key: FavoriteModelsKey) => string }) {
  const state = useSyncExternalStore(
    listener => directory.subscribe(listener),
    () => directory.getSnapshot(),
    () => directory.getSnapshot(),
  )
  const favoriteSnapshot = useSyncExternalStore(
    listener => favorites.subscribe(listener),
    () => favorites.getSnapshot(),
    () => favorites.getSnapshot(),
  )
  const [open, setOpen] = useState(false)
  const [, refreshFavorites] = useState(0)
  const [pane, setPane] = useState<Pane>('root')
  const lastAction = useRef<'load' | 'select'>('load')
  const [toast, setToast] = useState<{ seq: number; text: string } | null>(null)
  const toastSeq = useRef(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const [menuPos, setMenuPos] = useState<CSSProperties | null>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const id = useId()
  const favoritesValue = favorites.getSnapshot().value ?? favoriteSnapshot.value ?? DEFAULT_SETTINGS

  const groups = useMemo(
    () => filterFavoriteGroups(state.groups, favoritesValue.favorites),
    [state.groups, favoritesValue.favorites],
  )
  const allChoices = useMemo(() => state.groups.flatMap(group => group.models.map(model => ({ group, model }))), [state.groups])
  const choices = useMemo(() => groups.flatMap(group => group.models.map(model => ({ group, model }))), [groups])
  const currentChoice = state.current === null
    ? undefined
    : allChoices.find(choice => choice.group.id === state.current?.provider && choice.model.id === state.current.model)
  const reasoning = currentChoice?.model.reasoning
  const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort
  const effortLabel = reasoning === undefined
    ? undefined
    : effectiveEffort === undefined
      ? translate(t, 'providerDefault')
      : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort
  const effortChoices = useMemo<readonly EffortChoice[]>(() => reasoning === undefined
    ? []
    : [
      ...reasoning.defaultEffort === undefined
        ? [{ key: 'provider-default', effort: undefined, label: translate(t, 'providerDefault') }]
        : [],
      ...reasoning.efforts.map((effort: ModelReasoningEffort) => ({
        key: `effort:${effort.id}`,
        effort: effort.id,
        label: effort.name,
      })),
    ], [reasoning, t])
  const busy = state.status === 'selecting'

  const reload = (): void => {
    lastAction.current = 'load'
    load()
  }

  useEffect(() => {
    if (!available || !open) return
    const closeOutside = (event: MouseEvent): void => {
      // 只在点击菜单外部时关闭菜单，点击列表项本身交给其 handler。
      if (rootRef.current?.contains(event.target as Node) === true) return
      if (menuRef.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    document.addEventListener('mousedown', closeOutside)
    return () => { document.removeEventListener('mousedown', closeOutside) }
  }, [available, open])

  // 计算菜单位置：优先放在 trigger 上方，并用 clamp 处理矮视口和窄屏。
  // 首选位置在上方（与
  // 原生 ModelSelect 一致）；clamp 处理矮视口和窄屏。
  useLayoutEffect(() => {
    if (!available || !open) { setMenuPos(null); return }
    const place = (): void => {
      /* v8 ignore next 2 -- 菜单打开时 trigger ref 一定已挂载。 */
      const rect = triggerRef.current?.getBoundingClientRect()
      if (rect === undefined) return
      const MARGIN = 12
      const lw = menuRef.current?.offsetWidth ?? 0
      const lh = menuRef.current?.offsetHeight ?? 0
      let x = rect.right - lw
      let y = rect.top - 8 - lh
      if (lw > 0) {
        const maxX = Math.max(MARGIN, window.innerWidth - lw - MARGIN)
        x = Math.min(Math.max(x, MARGIN), maxX)
      }
      if (lh > 0) {
        const maxY = Math.max(MARGIN, window.innerHeight - lh - MARGIN)
        y = Math.min(Math.max(y, MARGIN), maxY)
      }
      setMenuPos({ left: x, top: y })
    }
    // pane 切换和异步目录更新后重新定位；滚动与 resize 继续保持绑定。
    // 再显示。pane 切换和异步目录更新
    // 会重新运行该 effect；之后由滚动和 resize 保持绑定。
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [available, open, pane, state])

  // 深入子 pane 会替换原先获得焦点的行；把焦点放进
  // 新 pane；返回 root 时同样把焦点留在真实
  // 深入子 pane 会替换原先获得焦点的行；把焦点移入新 pane，返回 root 时也保留可用焦点。
  useEffect(() => {
    if (!available || !open) return
    if (pane !== 'root' || rootRef.current?.contains(document.activeElement) !== true) {
      itemRefs.current[0]?.focus()
    }
  }, [available, open, pane])
  if (!available) return null

  const show = (): void => {
    refreshFavorites(value => value + 1)
    setPane('root')
    setOpen(true)
    reload()
  }
  const close = (restoreFocus = false): void => {
    setOpen(false)
    setPane('root')
    if (restoreFocus) queueMicrotask(() => { triggerRef.current?.focus() })
  }

  const moveFocus = (offset: number): void => {
    const items = itemRefs.current.filter(item => item !== null)
    if (items.length === 0) return
    const active = items.findIndex(item => item === document.activeElement)
    const next = active < 0
      ? offset > 0 ? 0 : items.length - 1
      : (active + offset + items.length) % items.length
    items[next]?.focus()
  }
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && open) {
      event.preventDefault()
      if (pane !== 'root') setPane('root')
      else close(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveFocus(event.key === 'ArrowDown' ? 1 : -1)
    }
  }
  const onBlur = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && (
      rootRef.current?.contains(event.relatedTarget) === true
      || menuRef.current?.contains(event.relatedTarget) === true
    )) return
    close()
  }
  const settleSelection = (accepted: boolean): void => {
    if (accepted) {
      if (rootRef.current !== null) close(true)
      return
    }
    const message = directory.getSnapshot().error
    if (message !== null) {
      toastSeq.current += 1
      setToast({ seq: toastSeq.current, text: fill(translate(t, 'actionError'), { message }) })
    }
  }
  const choose = (selection: ModelSelection): void => {
    if (state.current?.provider === selection.provider && state.current.model === selection.model) {
      close(true)
      return
    }
    lastAction.current = 'select'
    void select(selection).then(settleSelection)
  }
  const chooseEffort = (effort: string | undefined): void => {
    if (state.current === null) return
    if (effectiveEffort === effort) {
      close(true)
      return
    }
    lastAction.current = 'select'
    void select({
      provider: state.current.provider,
      model: state.current.model,
      ...effort === undefined ? {} : { reasoningEffort: effort },
    }).then(settleSelection)
  }

  const waiting = state.current === null && state.status === 'loading'
  const modelLabel = waiting
    ? translate(t, 'triggerLoading')
    : currentChoice?.model.name
      ?? (state.current === null ? translate(t, 'triggerFallback') : `${state.current.provider}/${state.current.model}`)
  const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`
  const triggerAria = waiting
    ? translate(t, 'triggerLoading')
    : state.current === null
      ? translate(t, 'triggerSelectAria')
      : effortLabel === undefined
        ? fill(translate(t, 'triggerAria'), { model: modelLabel })
        : fill(translate(t, 'triggerAriaEffort'), { model: modelLabel, effort: effortLabel })
  itemRefs.current = []
  let itemIndex = 0
  const itemRef = () => {
    const at = itemIndex++
    return (node: HTMLButtonElement | null) => { itemRefs.current[at] = node }
  }

  return (
    <div
      ref={rootRef}
      className={selectorClasses.root}
      data-open={open ? '' : undefined}
      onKeyDown={onRootKeyDown}
      onBlur={onBlur}
    >
      <style {...{ [SELECTOR_STYLE_MARKER]: '' }}>{selectorStyles}</style>
      <button
        ref={triggerRef}
        type="button"
        className={selectorClasses.trigger}
        aria-label={triggerAria}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? `${id}-menu` : undefined}
        title={triggerLabel}
        disabled={locked}
        onClick={() => { if (open) close(); else show() }}
      >
        <span className={selectorClasses.triggerLabel}>{modelLabel}</span>
        {effortLabel !== undefined ? <span className={selectorClasses.triggerEffort}>{effortLabel}</span> : null}
        <span className={selectorClasses.chevron}><IconChevronDownOutline14 /></span>
      </button>

      {open && createPortal(
        <div
          ref={menuRef}
          id={`${id}-menu`}
          className={selectorClasses.menu}
          style={menuPos ?? MEASURE_STYLE}
          role="menu"
          aria-label={translate(t, 'menuAria')}
          aria-busy={state.status === 'loading' || busy}
        >
            {pane === 'root'
              ? (
                <>
                  <button ref={itemRef()} type="button" role="menuitem" className={selectorClasses.cell} onClick={() => { setPane('model') }}>
                    <span className={selectorClasses.cellLabel}>{translate(t, 'menuModel')}</span>
                    <span className={selectorClasses.cellValue}>{modelLabel}</span>
                    <span className={selectorClasses.cellChevron}><IconChevronRightOutline14 /></span>
                  </button>
                  {reasoning !== undefined
                    ? (
                      <button ref={itemRef()} type="button" role="menuitem" className={selectorClasses.cell} onClick={() => { setPane('effort') }}>
                        <span className={selectorClasses.cellLabel}>{translate(t, 'menuEffort')}</span>
                        <span className={selectorClasses.cellValue}>{effortLabel}</span>
                        <span className={selectorClasses.cellChevron}><IconChevronRightOutline14 /></span>
                      </button>
                    )
                    : null}
                </>
              )
              : null}
            {pane === 'model'
              ? (
                <>
                  {state.status === 'loading' ? <div className={selectorClasses.status}>{translate(t, 'statusLoading')}</div> : null}
                  {state.error !== null && lastAction.current === 'load'
                    ? (
                      <div className={selectorClasses.error}>
                        <span>{fill(translate(t, 'actionError'), { message: state.error })}</span>
                        <button type="button" className={selectorClasses.retry} onClick={reload}>{translate(t, 'retry')}</button>
                      </div>
                    )
                    : null}
                  {state.failures.map(failure => (
                    <div className={selectorClasses.warning} key={failure.id}>
                      <span>{fill(translate(t, 'groupLoadWarning'), { name: failure.name, message: failure.message })}</span>
                      <button type="button" className={selectorClasses.retry} onClick={reload}>{translate(t, 'retry')}</button>
                    </div>
                  ))}
                  <div className={selectorClasses.groups}>
                    {groups.map(group => (
                      <section role="group" aria-label={group.name} className={selectorClasses.group} key={group.id}>
                        <div className={selectorClasses.groupTitle}>{group.name}</div>
                        {group.models.map(model => {
                          const selected = state.current?.provider === group.id && state.current.model === model.id
                          return (
                            <button
                              ref={itemRef()}
                              type="button"
                              role="menuitemradio"
                              aria-checked={selected}
                              className={selectorClasses.option}
                              key={model.id}
                              title={model.name}
                              disabled={busy}
                              onClick={() => { choose({ provider: group.id, model: model.id }) }}
                            >
                              <span className={selectorClasses.optionCopy}><span className={selectorClasses.modelName}>{model.name}</span></span>
                              <span className={selectorClasses.check}>{selected ? <IconCheckOutline16 /> : null}</span>
                            </button>
                          )
                        })}
                      </section>
                    ))}
                  </div>
                  {state.status === 'ready' && choices.length === 0 ? <div className={selectorClasses.empty}>{translate(t, 'emptyModels')}</div> : null}
                </>
              )
              : null}
            {pane === 'effort'
              ? (
                <>
                  {state.error !== null && lastAction.current === 'load'
                    ? (
                      <div className={selectorClasses.error}>
                        <span>{fill(translate(t, 'actionError'), { message: state.error })}</span>
                        <button type="button" className={selectorClasses.retry} onClick={reload}>{translate(t, 'retry')}</button>
                      </div>
                    )
                    : null}
                  {effortChoices.length === 0
                    ? <div className={selectorClasses.empty}>{translate(t, 'emptyEfforts')}</div>
                    : effortChoices.map(level => (
                      <button
                        ref={itemRef()}
                        type="button"
                        role="menuitemradio"
                        aria-checked={effectiveEffort === level.effort}
                        className={selectorClasses.option}
                        key={level.key}
                        disabled={busy}
                        onClick={() => { chooseEffort(level.effort) }}
                      >
                        <span className={selectorClasses.optionCopy}><span className={selectorClasses.modelName}>{level.label}</span></span>
                        <span className={selectorClasses.check}>{effectiveEffort === level.effort ? <IconCheckOutline16 /> : null}</span>
                      </button>
                    ))}
                </>
              )
              : null}
        </div>,
        document.body,
      )}
      {toast !== null
        ? (
          <Toast
            key={toast.seq}
            text={toast.text}
            icon={<IconWarningOutline16 />}
            anchor={rootRef.current?.closest<HTMLElement>('[data-composer-card]') ?? null}
            onDone={() => { setToast(null) }}
          />
        )
        : null}
    </div>
  )
}
