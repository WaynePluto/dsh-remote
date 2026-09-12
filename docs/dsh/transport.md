# 传输与浏览器认证

基线与维护方式见 [源码依据索引](../02-dsh-facts.md)。以下路径相对 dsh 仓库根。

## Web 传输

出处：`packages/client/connection/src/api-path.ts`、`src/client/web-api-client.ts`、
`packages/api/gateway/src/stream-protocol.ts`、`packages/client/modules/src/index.ts`。

| 请求 | 用途 |
|---|---|
| GET / | dsh 前端首页，需要 dsh cookie |
| GET /plugins/??a/client.js,b/client.js&rev=… | 客户端插件 combo bundle |
| POST /api/<service>/<method> | 一元 RPC 与 respond 操作 |
| WS /api/remote.mux | 唯一的 Typert Remote 多路复用 WebSocket |

API_PATH 是绝对 `/api`，不能把目标机器挂到子路径。combo URL 的问号、逗号及整个 raw URI 必须原样转发。
断线后客户端重建连接 generation；relay 不实现业务消息补发或游标续传。
WebSocket 必须独立处理 upgrade。dsh 的默认请求 body 上限为 160 MiB，转发层不应无意缩小附件容量。

## Host/Origin Fence

出处：`packages/client/connection/src/api-request-trust.ts`、`src/loopback-hostname.ts`、`src/rpc-host.ts`。

判定顺序：fence 失败返回 403；fence 通过但没有 dsh cookie 返回 401。

1. 每个 API 请求的 Host 必须是 loopback authority 或匹配 trustedHosts。
2. 带浏览器标记的请求要求 Origin 与 Host authority 一致；sec-fetch-site:cross-site 拒绝。
3. WebSocket 升级也受同一规则保护。
4. isTrustedApiRequest 只接收 headers，不检查 socket.remoteAddress；这是可达性策略，不是身份认证。

loopback 包括 localhost、[::1] 与 127.0.0.0/8。
trustedHosts 必须是裸的规范 host 或 host:port；无端口条目匹配任意端口，有端口则精确匹配。
scheme、路径、userinfo、尾部冒号、未加方括号 IPv6 等非法输入会在插件加载时抛错，IDN 使用 punycode。

dsh-remote 始终原样转发 Host/Origin，并通过 --trusted-host 声明入口 authority。
dsh 的 Web 启动路径要求 loopback 绑定，项目也始终绑定 127.0.0.1；LAN 和公网访问走 relay。
启动约束出处：`packages/bundle/web-app/src/startup.ts`。

## dsh Cookie

出处：`packages/client/connection/src/browser-auth.ts`、`src/rpc-host.ts`、
`packages/host/frontend-static/src/index.ts`、`packages/bundle/web-app/src/index.ts`。

| 项目 | 契约 |
|---|---|
| 交换入口 | GET /?token=<launch token>，303 到 / 并设置 cookie |
| Cookie 名 | dsh-auth-<base64url(sha256(authority))> |
| 属性 | HMAC-SHA256 签名，payload 绑定 authority，HttpOnly、SameSite=Strict、Path=/，默认 30 天，无 Secure |
| 签名密钥 | 存 credentials，跨重启有效 |
| Launch token | 每进程随机 32 字节 base64url，可重复交换，存 root WeakMap |
| Token 来源 | 启动输出中的 dsh web URL；没有环境变量注入入口 |
| 保护范围 | API 含 WS，以及 / 和 /index.html；其余静态与插件资源不要求 dsh cookie |
| Loopback | 也需要先交换 token |

项目链路：launcher 截获 token → DSH_REMOTE_DSH_TOKEN 传给 connector → dsh-auth 帧上报 relay。
relay 在认证后的首页 401 上代发一次重定向，不改 API 的 401；token 不写库、不进日志。

## 远程设置与 OwnsHost

出处：`packages/client/connection/src/client/index.ts`、`packages/api/gateway/src/client/index.ts`、
`packages/client/ui-settings/src/client/index.ts`、`src/client/settings-mirror.ts`。

浏览器的 isLoopback 来自 transport.ownsHost 或 location.hostname。
非 loopback 页面会将设置 persistence 设为 memory，scope 为 unavailable，不向宿主发起 settings/describe。
因此“HTTP 认证通过”本身不代表远程设置可用。

ClientTransportHooks.ownsHost 从全局 __DSH_TRANSPORT__ 读取；只设置 ownsHost 时，fetch 与 loadBundle
仍回退到原有 HTTP/WS 传输。remote-privileged 用 webserver/index-inject 的 global 行注入 true。
客户端先等待 __DSH_BOOT_READY__，注入先于页面启动。

注入出处：`packages/host/webserver/src/index.ts`、`src/injections.ts`。
该标志还开放调用系统程序打开文件的能力，动作发生在目标机器桌面，并非远程设备桌面。

## 网页目录选择

出处：`packages/host/directory-picker-auto/src/resolve.ts`。

auto 后端在启动时决定：SSH、非 loopback 或无图形界面的环境走 browse；Windows/macOS 与有图形工具的
Linux 可走 native。判定不看浏览器是不是远程，native 对话框会弹在目标机器桌面。

directory-picker-browse 插件停用 adaptive 行，用 Loader 挂载官方 host/client browse 两半，
因此所有平台都在网页内选工作区，官方 web profile 不受影响。

## 插件 RPC

出处：`packages/client/connection/src/rpc.ts`、`src/rpc-host.ts`、`src/client/rpc.ts`。

- 宿主 ctx.connection.rpc.handle('/x', handler) 注册通道，自动套用 fence 与浏览器认证。
- 客户端 rpc.call(channel, endpoint, payload) 请求 POST /x/<endpoint>，只打 /x 会 404。
- 信封为 client-request、rpcId、method、payload；method 必须与 URL endpoint 一致。
- /api 是保留通道，插件不能占用；注册随 fiber 释放。
- Connection 的 generic channel 挂载需要 owner context 注入 webServer。
  remote-privileged 的 overlay 为 connection 设置 inject:[webRuntime,webServer]。
  缺失可能启动失败或落到静态 fallback 返回 405。