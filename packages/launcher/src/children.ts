/**
 * launcher 持有的子进程，按启动顺序排列。
 *
 * 停止顺序正好相反（supervisor 按反向启动顺序停止）：
 * connector 必须在它拨号的 relay 消失前停止拨号，并且
 * dsh 要比两个客户端都晚退出，以免它们在请求中途失去上游。
 */
export const CHILD_START_ORDER = ['dsh', 'relay', 'connector'] as const

/** 一个受 supervisor 管理的子进程名称，即日志前缀和消息中显示的名称。 */
export type LauncherChildName = typeof CHILD_START_ORDER[number]

export const [DSH_CHILD, RELAY_CHILD, CONNECTOR_CHILD] = CHILD_START_ORDER
