/**
 * Current wire-protocol version. Increment only for incompatible frame changes.
 *
 * v2 removed the M1 shared static token: the only accepted control credentials
 * are Ed25519 device signatures, so a v1 connector can no longer authenticate.
 *
 * v3 added the `dsh-auth` frame. dsh 0.1.2 authenticates browsers itself (a
 * per-process launch token exchanged for a signed cookie), so a connector now
 * reports that token to its relay; a v2 relay would reject the frame outright.
 */
export const PROTOCOL_VERSION = 3 as const

/** Relay WebSocket paths. */
export const TUNNEL_CONTROL_PATH = '/_tunnel/control' as const
export const TUNNEL_STREAM_PATH = '/_tunnel/stream' as const

/** Maximum UTF-8 size accepted for one JSON control frame. */
export const MAX_CONTROL_FRAME_BYTES = 64 * 1024

/** Handshake and work-connection lifetimes. */
export const HANDSHAKE_TIMEOUT_MS = 10_000
export const STREAM_TOKEN_TTL_MS = 60_000
export const STREAM_CONNECT_TIMEOUT_MS = 15_000
export const LOCAL_DSH_CONNECT_TIMEOUT_MS = 5_000

/** Control-channel liveness. */
export const HEARTBEAT_INTERVAL_MS = 30_000
export const HEARTBEAT_TIMEOUT_MS = 90_000

/** Connector reconnect backoff. Jitter is a symmetric percentage of the computed delay. */
export const RECONNECT_BACKOFF = Object.freeze({
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitterRatio: 0.2,
})
