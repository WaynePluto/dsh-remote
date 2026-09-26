/**
 * launcher 持有的子进程，按启动顺序排列。
 *
 * relay 先于 dsh 启动：桌面壳的初始导航在 relay 端口监听后即放行进入 relay
 * 的重试页，dsh 就绪前的等待由那页承担。停止顺序正好相反（supervisor 按
 * 反向启动顺序停止）：connector 必须在它拨号的 relay 消失前停止拨号，
 * 最先启动的隧道枢纽 relay 最后回收。
 */
export const CHILD_START_ORDER = ['relay', 'dsh', 'connector'] as const

/** 一个受 supervisor 管理的子进程名称，即日志前缀和消息中显示的名称。 */
export type LauncherChildName = typeof CHILD_START_ORDER[number]

export const [RELAY_CHILD, DSH_CHILD, CONNECTOR_CHILD] = CHILD_START_ORDER
