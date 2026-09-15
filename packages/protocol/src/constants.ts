/**
 * 当前线路协议版本。仅在帧发生不兼容变更时递增。
 *
 * v2 移除了 M1 共享静态 token：可接受的控制凭据只有
 * Ed25519 设备签名，因此 v1 connector 无法再完成认证。
 *
 * v3 新增了 `dsh-auth` 帧。dsh 0.1.2 自行认证浏览器（通过
 * 每进程 launch token 交换签名 cookie），因此 connector 现在会
 * 将该 token 报告给 relay；v2 relay 会直接拒绝这个帧。
 */
export const PROTOCOL_VERSION = 3 as const

/** Relay 的 WebSocket 路径。 */
export const TUNNEL_CONTROL_PATH = '/_tunnel/control' as const
export const TUNNEL_STREAM_PATH = '/_tunnel/stream' as const

/** 单个 JSON 控制帧可接受的最大 UTF-8 大小。 */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024

/** 握手和工作连接的生命周期。 */
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const STREAM_TOKEN_TTL_MS = 60_000
export const STREAM_CONNECT_TIMEOUT_MS = 15_000
export const LOCAL_DSH_CONNECT_TIMEOUT_MS = 5_000

/** 控制信道存活性。 */
export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 90_000

/** Connector 重连退避。抖动是计算延迟的对称百分比。 */
export const RECONNECT_BACKOFF = Object.freeze({
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
})

/**
 * 断开远程入口后唤醒探测的周期间隔；也是「请求上线」按钮从点击到
 * 生效的最长等待。首次探测同样等满一个周期：刚断开就立刻报到会
 * 让「断开」失去意义。
 */
export const PROBE_INTERVAL_MS = 60_000

/**
 * 「请求上线」标记的保留时长。机器真正关机时请求无法送达，标记
 * 留着等它下次启动后的第一次探测；过期自动失效，避免很久之后的
 * 一次上线让操作员意外。
 */
export const WAKEUP_REQUEST_TTL_MS = 24 * 60 * 60 * 1000
