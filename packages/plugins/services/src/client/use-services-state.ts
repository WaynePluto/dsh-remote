/**
 * services panel 的状态与副作用：轮询、session 切换清理、uptime、操作按钮和日志请求。
 * 组件只负责把这份状态投影成 DOM，不在此处改变 Host RPC 契约。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Dispatch, MutableRefObject, PointerEvent as ReactPointerEvent, SetStateAction } from 'react'
import { formatUptime } from '../shared.js'
import type { ServiceLogsResult, ServiceView, ServicesSnapshot } from '../shared.js'
import { fill } from './locales.js'
import type { ServicesKey } from './locales.js'
import {
  LOG_DIALOG_BODY_HEIGHT_PROP,
  LOG_DIALOG_CLASS,
  LOG_DIALOG_MIN_BODY_HEIGHT_PX,
  LOG_DIALOG_MIN_WIDTH_PX,
  LOG_DIALOG_OFFSET_X_PROP,
  LOG_DIALOG_OFFSET_Y_PROP,
  LOG_DIALOG_ROOT_PADDING_PX,
  LOG_DIALOG_WIDTH_PROP,
  logDialogWidth,
} from './log-dialog.js'
import type { LogDialogResizeDirection } from './log-dialog.js'
import { useLogDialogResize } from './dialog-resize.js'
import { useDialogFullscreen } from '@dsh-station/plugin-ui'
import { publishWidth } from './styles.js'
import type { Busy, ServicesDockInjected } from './types.js'

/** tab 可见时 panel 的刷新间隔（毫秒）。 */
export const POLL_MS = 5000

/** 本地渲染 uptime 的推进间隔（毫秒）。 */
const TICK_MS = 1000

/** 日志 dialog 的尺寸状态由 services 的 custom properties 提供。 */
const LOG_RESIZE_CONFIG = {
  dialogClass: LOG_DIALOG_CLASS,
  bodySelector: '[data-dsh-services-log-body]',
  widthProp: LOG_DIALOG_WIDTH_PROP,
  bodyHeightProp: LOG_DIALOG_BODY_HEIGHT_PROP,
  offsetXProp: LOG_DIALOG_OFFSET_X_PROP,
  offsetYProp: LOG_DIALOG_OFFSET_Y_PROP,
  rootPaddingPx: LOG_DIALOG_ROOT_PADDING_PX,
  minWidthPx: LOG_DIALOG_MIN_WIDTH_PX,
  minBodyHeightPx: LOG_DIALOG_MIN_BODY_HEIGHT_PX,
}

/** panel 状态 hook 的输入。 */
export interface UseServicesStateOptions {
  sessionId: string | undefined
  actions?: Partial<ServicesDockInjected> | undefined
  translate: (key: ServicesKey) => string
}

/** panel 状态 hook 的返回值。 */
export interface ServicesState {
  collapsed: boolean
  setCollapsed: Dispatch<SetStateAction<boolean>>
  snapshot: ServicesSnapshot | undefined
  error: string | null
  busy: Record<string, Busy>
  openLog: string | null
  log: ServiceLogsResult | null
  services: readonly ServiceView[]
  summary: string
  rootRef: MutableRefObject<HTMLElement | null>
  elapsed: (service: ServiceView) => string
  load: () => Promise<void>
  act: (name: string, kind: 'stop' | 'restart') => void
  showLog: (name: string) => void
  closeLog: () => void
  /** 日志 dialog 是否处于全屏态；全屏时隐藏拖动与八向 resize。 */
  logFullscreen: boolean
  toggleLogFullscreen: () => void
  onLogResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>, direction: LogDialogResizeDirection) => void
  onLogMovePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void
}

/** 判断 document 当前是否可见；没有 document 时按 visible 处理。 */
function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

/**
 * 管理 panel 的远程数据、页面计时与日志 dialog 状态。
 * @param options - session、Host actions 和 locale seat。
 * @returns 供 panel 与子组件消费的状态和回调。
 */
export function useServicesState({ sessionId, actions, translate }: UseServicesStateOptions): ServicesState {
  const [collapsed, setCollapsed] = useState(true)
  const [snapshot, setSnapshot] = useState<ServicesSnapshot | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, Busy>>({})
  const [openLog, setOpenLog] = useState<string | null>(null)
  const [log, setLog] = useState<ServiceLogsResult | null>(null)
  /** 页面收到 snapshot 的时间；uptime 以 Host 时钟为基准再加本地经过时间。 */
  const [receivedAt, setReceivedAt] = useState(() => Date.now())
  const [localNow, setLocalNow] = useState(() => Date.now())
  /** card 自身的 box；日志 dialog 以它作为宽度标尺。 */
  const rootRef = useRef<HTMLElement | null>(null)
  const {
    onPointerDown: onLogResizePointerDown,
    onMovePointerDown: onLogMovePointerDown,
    reset: resetLogResize,
  } = useLogDialogResize(LOG_RESIZE_CONFIG)

  const onList = actions?.onList
  // ref 防止每次 fetch 返回都拆除/重启 poll effect；effect 依赖操作函数，而不是数据。
  const listRef = useRef(onList)
  listRef.current = onList

  const load = useCallback(async (): Promise<void> => {
    const fetchList = listRef.current
    if (fetchList === undefined) return
    try {
      const next = await fetchList()
      setSnapshot(next)
      setReceivedAt(Date.now())
      setLocalNow(Date.now())
      setError(null)
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  // 可见时轮询；隐藏时停止，返回可见后补一次。
  useEffect(() => {
    if (sessionId === undefined) return
    let timer: ReturnType<typeof setInterval> | undefined
    const start = (): void => {
      if (timer !== undefined) return
      void load()
      timer = setInterval(() => { void load() }, POLL_MS)
    }
    const stop = (): void => {
      if (timer === undefined) return
      clearInterval(timer)
      timer = undefined
    }
    const onVisibility = (): void => {
      if (documentVisible()) start()
      else stop()
    }
    if (documentVisible()) start()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [sessionId, load])

  // 不同 session 就是不同项目：全部清空，避免首个 poll 到达前显示上一个项目的服务。
  useEffect(() => {
    setSnapshot(undefined)
    setError(null)
    resetLogResize()
    setOpenLog(null)
    setLog(null)
    setBusy({})
  }, [sessionId])

  // 不访问网络，只推进页面显示的 uptime。
  useEffect(() => {
    if (collapsed || snapshot === undefined || snapshot.services.length === 0) return
    const timer = setInterval(() => { setLocalNow(Date.now()) }, TICK_MS)
    return () => { clearInterval(timer) }
  }, [collapsed, snapshot])

  // 全屏开关由公共 hook 管理：进入前保存几何、退出写回、resize 跟随、换服务或关闭即复位。
  const { fullscreen: logFullscreen, toggle: toggleLogFullscreen } = useDialogFullscreen({
    ...LOG_RESIZE_CONFIG,
    open: openLog !== null,
    identity: openLog ?? undefined,
  })

  const act = useCallback((name: string, kind: 'stop' | 'restart'): void => {
    const verb = kind === 'stop' ? actions?.onStop : actions?.onRestart
    if (verb === undefined) return
    setBusy(previous => ({ ...previous, [name]: kind }))
    setError(null)
    void (async () => {
      try {
        const result = await verb(name)
        // refusal 是 Host 精心措辞的正常结果；原样展示，不在页面另造一套词汇。
        if (!result.ok) setError(result.message)
        await load()
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      } finally {
        setBusy(previous => ({ ...previous, [name]: undefined }))
      }
    })()
  }, [actions, load, translate])

  /** 打开一个服务的日志 dialog，或刷新当前已打开的 dialog。 */
  const showLog = useCallback((name: string): void => {
    // 换服务等于换一份内容：清掉上一个 dialog 的几何，全屏态由 hook 按 identity 复位。
    if (openLog !== null && openLog !== name) resetLogResize()
    // 现在测量而不是 mount 时测量：sidebar 折叠或拖动宽度时 column 会变化，而此刻才真正需要该数字。
    const measured = rootRef.current?.getBoundingClientRect().width ?? 0
    publishWidth(logDialogWidth(measured))
    setOpenLog(name)
    setLog(null)
    const fetchLogs = actions?.onLogs
    if (fetchLogs === undefined) return
    void (async () => {
      try {
        setLog(await fetchLogs(name))
      } catch (cause: unknown) {
        setError(fill(translate('failed'), {
          message: cause instanceof Error ? cause.message : String(cause),
        }))
      }
    })()
  }, [actions, openLog, resetLogResize, translate])

  const closeLog = useCallback((): void => {
    resetLogResize()
    setOpenLog(null)
    setLog(null)
  }, [resetLogResize])

  const services: readonly ServiceView[] = snapshot?.services ?? []

  useEffect(() => {
    if (services.length === 0) {
      resetLogResize()
      if (openLog !== null || log !== null) {
        setOpenLog(null)
        setLog(null)
      }
    }
  }, [log, openLog, resetLogResize, services.length])

  const summary = useMemo(
    () => fill(translate('summaryRunning'), { count: services.length }),
    [services.length, translate],
  )

  const elapsed = (service: ServiceView): string => {
    if (snapshot === undefined) return ''
    return formatUptime(snapshot.now - service.startedAt + (localNow - receivedAt))
  }

  return {
    collapsed,
    setCollapsed,
    snapshot,
    error,
    busy,
    openLog,
    log,
    services,
    summary,
    rootRef,
    elapsed,
    load,
    act,
    showLog,
    closeLog,
    logFullscreen,
    toggleLogFullscreen,
    onLogResizePointerDown,
    onLogMovePointerDown,
  }
}

