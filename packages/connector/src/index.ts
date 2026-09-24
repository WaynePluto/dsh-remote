/**
 * @dsh-station/connector —— 跑在被控机上的反向隧道连接器。
 *
 * 职责（见 docs/03-architecture.md §4）：
 *   - 拨出控制信道到 relay，指数退避重连
 *   - 收到 open-stream 后回拨数据 WS，与 127.0.0.1:<dshPort> 双向 pipe
 *   - 保持「哑」：只搬字节，不解析 HTTP
 */

export * from './backoff.js'
export * from './config.js'
export * from './connector.js'
export * from './control.js'
export * from './device-key.js'
export * from './membership.js'
export * from './stream.js'
export * from './version.js'


