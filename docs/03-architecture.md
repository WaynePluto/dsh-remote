# 03 · 架构设计

## 1. 全景

```
                        公网
  ┌──────────┐                          ┌─────────────────────┐
  │ 手机浏览器 │──── HTTPS/WSS ─────────>│                     │
  └──────────┘   pc1.dsh.example.com    │   dsh-remote-relay    │
                                        │   (中转服务器)       │
  ┌──────────┐                          │                     │
  │ PC 浏览器 │──── HTTPS/WSS ─────────>│  · 用户认证          │
  └──────────┘                          │  · 设备认证          │
                                        │  · 子域名路由        │
                                        │  · Host/Origin 重写  │
                                        └─────────┬───────────┘
                                                  │ WSS（由开发机主动拨出）
                                        ┌─────────┴───────────┐
                                        │ dsh-remote-connector  │  开发机 / 目标服务器
                                        │  (隧道连接器)        │  ★ 不监听任何公网端口
                                        └─────────┬───────────┘
                                                  │ HTTP → 127.0.0.1:3080
                                        ┌─────────┴───────────┐
                                        │  dsh web            │  官方原版，未改动
                                        │  (Node 22.19+)      │
                                        └─────────────────────┘
```

## 2. 组件

| 组件 | 部署位置 | 职责 | 是否必需 |
|---|---|---|---|
| **dsh** | 被控机器 | Agent 运行时 + Web UI，官方原版 | 必需 |
| **dsh-remote-connector** | 被控机器 | **反向隧道连接器**：拨出到中转、把隧道流量转给本地 dsh；不是执行任务的 AI Agent | 远程使用时必需 |
| **dsh-remote-relay** | 任意一台机器（可公网可局域网） | 认证 + 路由 + 转发；充当 hub | 远程使用时必需 |
| **dsh-remote-launcher** | 被控机器 | 双击启动 dsh + connector，终端打印地址 | 便利组件 |

### dsh home 与 profile（D14）

dsh-remote 不另建私有 `DSH_HOME`，默认和用户安装的官方 dsh 共用 `~/.dsh`，从而共享：

- `settings.yaml`、`.credentials.yaml`、sessions、storages；
- `$DSH_HOME/cordis.patch.yml`（用户有意应用到所有 profile 的全局 patch）。

dsh-remote 只隔离**具名 profile**：启动 `dsh-remote-web`，不启动官方 `web`。该 profile 的 bundle 顺序是官方 `dsh-base`、`dsh-web-app`；**dsh-remote 自己的插件不进这份 bundle 列表**，而是以 `--patch` 叠加层的形式由 launcher 传给 dsh（D17，见下）。内置插件绝不写入 home 级全局 patch，也不修改官方 `web` profile，更不改用户自己的 `cordis.patch.yml`。

### dsh 插件（D17）

扩展 dsh 只走插件。插件包住在 `packages/plugins/<名字>/`，包名 `@dsh-remote/dsh-plugin-<名字>`，
每个包根携带一份 `dsh-overlay.yml`：

```
packages/plugins/remote-privileged/
├─ src/index.ts        # cordis 插件（name / inject / apply），运行时零依赖
├─ dist/index.js       # 构建产物，dsh 直接从磁盘 import 它
└─ dsh-overlay.yml     # - insert: [{ name: './dist/index.js' }]
```

launcher 启动 dsh 时：`dsh --profile dsh-remote-web --patch <每个插件的 overlay> …`。
**仓库里有两处 spawn dsh，两处都必须传 `--patch`**：`packages/launcher/src/dsh.ts`（绿色包）和
`scripts/dev-stack.mjs`（`pnpm dev` / `pnpm start`，用 `scripts/local-config.mjs` 的 `dshPluginOverlays()`
扫 `packages/plugins/*`）。
dsh 把 overlay 里 `./` 开头的名字锚定到 overlay 所在目录（[02-dsh-facts.md](02-dsh-facts.md) §4.7），
所以绿色包解到哪里都成立。解析与校验在 `packages/launcher/src/dsh-plugins.ts`，
插件或其构建产物缺失时 launcher 直接报错退出。

| 插件 | 职责 |
|---|---|
| `remote-privileged` | 向首页注入 `__DSH_TRANSPORT__ = { ownsHost: true }`，让已通过 relay 认证的远程页面拿到与本机同等的设置能力（否则模型页报 `settings are unavailable in this browser`，插件页配置区空白） |

launcher 保持薄：只在 profile 不存在时写入最小模板文件，然后启动内嵌 dsh；不实现另一套插件管理器。额外插件沿用官方命令：

```powershell
# 只给 dsh-remote profile 安装
dsh plugin --profile dsh-remote-web add <bundle-package>

# 给官方 web profile 安装（包括用户主动让官方 dsh 使用 dsh-remote 插件）
dsh plugin --profile web add <bundle-package>
```

### 单机使用

只跑 `dsh web`，浏览器开 `http://127.0.0.1:3080`。**不需要 relay，不需要 connector。**
这与前期设想的「本机也走中转以统一代码路径」不同 —— 因为隧道方案里根本没有第二套代码路径可统一，直连就是最优解。

### 中转使用

被控机器跑 `dsh web` + `dsh-remote-connector`；公网服务器跑 `dsh-remote-relay`。
中转服务器本身也可以既跑 relay 又跑 dsh+connector（自己控制自己）。

## 3. 为什么是「一机一子域名」

dsh 前端把 `/api` 写死为绝对路径（`packages/client/connection/src/api-path.ts`）。挂子路径需要改 dsh 源码，违反 D2。

```
https://pc1.dsh.example.com/     → 家里的 Windows PC
https://srv.dsh.example.com/     → 生产服务器
https://relay.dsh.example.com/   → 中转自己的管理页（登录、机器列表）
```

生产多机器模式中，子域名也是 relay 的路由键：它从原始 `Host` 取出 slug，再选择对应机器。但这不是 M1 单机远程可用性的前置条件。M1 提供显式 `directSlug`：IP/localhost Host固定路由到一台机器，让另一台局域网设备可直接访问 `http://<LAN-IP>:30809`；该模式不猜“当前恰好在线的机器”，目标 slug 必须配置。

局域网多机器场景不依赖域名：见 [01-decisions.md](01-decisions.md) D16，入口机器为每台挂上来的机器分配一个持久化端口，
端口作为第二种路由键。解析顺序是：子域名 → 每机器端口 → `directSlug`。

IP 模式与未来域名模式复用完全相同的浏览器认证中间件。只有“loopback socket + loopback Host”免登录；局域网 IP、反代后的域名请求都必须登录。正式认证完成前 relay 不允许 bind 非 loopback。

**生产多机器部署要求：泛域名证书 `*.dsh.example.com`。** 用 Caddy 自动申请最省事（Caddy 支持 DNS-01 泛域名），或 acme.sh + nginx。

## 4. 隧道协议

### 4.1 为什么不用多路复用库

前期考虑过 `yamux-js`（0.2.1，MIT，活跃度低）。**改用 frp/ngrok 经典的 "work connection" 模型**：每个浏览器连接对应一条独立的 WebSocket，不需要任何多路复用库。

- 少一个低活跃度依赖
- 每条流独立，一条出错不影响其他
- 代价：新建连接多一次 RTT（浏览器长连接复用，实际影响可忽略）

### 4.2 控制信道

```
connector ──> wss://relay.dsh.example.com/_tunnel/control
```

1. connector 连上后，relay 下发随机 nonce
2. connector 用设备 Ed25519 私钥签名 nonce，回传 `{ machineId, publicKey, signature }`
3. relay 校验公钥已注册且签名有效 → 标记该 machine 在线
4. 之后控制信道只用于：relay → connector 的 `open-stream` 指令、双向心跳、connector → relay 的状态上报

心跳：30s 一次 ping，90s 无响应判定离线。connector 侧断线后指数退避重连（1s → 最大 30s，带抖动）。

### 4.3 数据信道

浏览器每来一个新连接：

```
1. relay: 生成 streamId + 一次性 streamToken（60s 有效）
2. relay ──控制信道──> connector: { type: 'open-stream', streamId, streamToken }
3. connector ──> wss://relay/_tunnel/stream?token=<streamToken>
4. relay: 校验 token，把浏览器侧连接与这条 WS 双向对接
5. connector: 把这条 WS 与 net.connect('127.0.0.1', 3080) 双向对接（纯字节流）
```

**connector 保持“哑”的**：只做字节搬运，不解析 HTTP。所有 HTTP 语义处理都在 relay。

### 4.4 过 dsh 的两道门：fence（模式 A）+ dsh 自己的浏览器认证

dsh 的 `/api` 有一道基于 `Host` 头的 rebinding 防御，`/api` 与首页还要过 dsh 自己的浏览器认证
（详见 [02-dsh-facts.md](02-dsh-facts.md) §4）。

#### 门 1：browser-trust fence —— 只有模式 A

```
relay 原样转发 Host: pc1.dsh.example.com 和 Origin
dsh 侧启动时声明：dsh --profile dsh-remote-web --trusted-host pc1.dsh.example.com
```

- ✅ 官方支持路径，relay 实现更简单：转发前不改任何头
- ✅ 对话、会话、审批、切模型、目录浏览全部可用；设置、凭据、模型发现同样可用
  （dsh 0.1.2 删掉了钉死 loopback 的特权方法名单）
- `trustedHosts` 条目格式错误会让 **dsh 插件加载直接失败**，格式约束见 02 文档 §4.4

> 曾经存在的【模式 B：把 Host/Origin 改写成 loopback】已随 `unlockPrivileged` 一起删除。
> 它唯一的用途是解锁特权方法，而那份名单在 dsh 0.1.2 中不复存在；保留它只会白白关掉
> dsh 自带的 rebinding 防御。

#### 门 2：dsh 的浏览器认证 —— relay 代跑一次 token 交换

dsh 0.1.2 起自带浏览器认证：启动时打印 `dsh web: http://127.0.0.1:3080/?token=<token>`，
浏览器访问带 token 的 URL 才会拿到 `dsh-auth-*` cookie，之后 `/api` 与首页才不是 401。
链路（详见 [02-dsh-facts.md](02-dsh-facts.md) §4.6）：

```
launcher 读 dsh 首行输出里的 token
  → 以 DSH_REMOTE_DSH_TOKEN 传给 connector
  → connector 认证后用 dsh-auth 控制帧上报给 relay（protocol v3）
  → relay 看到 dsh 对首页回 401 时，回一个 303 到 /?token=…（仅一次：带 token 的请求不再重定向）
  → dsh 下发自己的 cookie，跳回干净的 /
```

两个 cookie 并存：relay 的会话 cookie 在最前面把关，dsh 的 cookie 只是叠加。

Node 实现要点：

```ts
// 模式 A：浏览器发来的头原样进隧道
const headers = { ...req.headers }

// 普通请求
const upstream = http.request({
  createConnection: () => tunnelDuplex,   // 隧道流当作 socket
  method: req.method,
  path: req.url,
  headers,
})
req.pipe(upstream)
upstream.on('response', res => { /* 回写状态码、头、body */ })

// WebSocket 升级：监听 relay server 的 'upgrade' 事件，
// 用同样方式重发升级请求，拿到 upstream 的 'upgrade' 后双向 pipe socket
upstream.on('upgrade', (upRes, upSocket, upHead) => { /* 写回 101 + 头，然后 pipe */ })
```

**踩坑提醒**：
- `/api/remote.mux` 是 WebSocket（dsh 0.1.2 把原来的 `/api/events.mux` + `/api/events.host` 合并成了这一条），必须走 `upgrade` 路径
- 前端插件走 combo 路由 `/plugins/??a/client.js,b/client.js&rev=<rev>`：URL 里带 `??` 和逗号，转发链路必须原样透传 raw URI
- 不要用 `http-proxy-3` 之类的现成库直接套 —— 它们不方便注入 `createConnection`。手写约 150 行更可控
- `POST /api` 的 body 上限：dsh 侧 `maxRequestBodyBytes` 默认 160 MiB（图片附件），relay 不要设更小的限制

## 5. 目录结构

```
dsh-remote/
├─ package.json                # pnpm workspace 根
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ packages/
│  ├─ protocol/                # @dsh-remote/protocol
│  │   └─ src/                 # 隧道控制帧 zod schema、共享类型、错误码
│  ├─ connector/               # @dsh-remote/connector
│  │   └─ src/                 # 拨出、设备密钥、流转发、重连退避
│  ├─ relay/                   # @dsh-remote/relay
│  │   └─ src/
│  │       ├─ http/            # 反代（模式 A：头原样转发）与 dsh token 重定向
│  │       ├─ tunnel/          # 控制信道、流配对
│  │       ├─ auth/            # 用户登录、设备认证、会话
│  │       ├─ admin/           # 管理页（登录、机器列表、配对）
│  │       └─ store/           # node:sqlite 持久化
│  └─ launcher/                # @dsh-remote/launcher
│      └─ src/                 # 拉起 dsh + connector，打印地址
├─ docs/                       # 本目录
└─ scripts/                    # 打包、发布
```

## 6. 技术选型

| 用途 | 选择 | 理由 |
|---|---|---|
| 语言 | TypeScript，ESM，`"type": "module"` | 与 dsh 一致 |
| 包管理 | pnpm 11.7.0 | 与 dsh 一致，本机已有 |
| 构建 | `tsdown` | dsh 自己用的就是它（`tsdown.config.ts`） |
| 开发运行 | `tsx` | 免编译直跑 |
| WebSocket | **`ws` 8.21** | 事实标准 |
| HTTP 框架（relay 管理页） | **`hono` 4.13** | 轻、类型好、Node adapter 成熟。注意：**隧道转发不走框架**，直接用 `node:http` |
| 校验 | **`zod` 4.4** | 协议帧校验 |
| 持久化 | **`node:sqlite`**（Node 22.19 内置） | **零原生依赖**，直接支撑绿色包。不要用 `better-sqlite3` |
| 密码哈希 | **`@node-rs/argon2` 2.1** | ⚠️ 原生模块，但只在 relay（Linux 服务器）用，不进绿色包 |
| JWT / 会话 | **`jose` 6.2** | 纯 JS |
| TOTP | **`otplib` 13.4** | 纯 JS |
| Web Push（M4） | **`web-push` 3.6** | VAPID 标准实现 |
| 限流 | **`rate-limiter-flexible` 11.2** | 登录接口防爆破 |
| 日志 | **`pino` 10.3** | 结构化日志 |
| 签名 | **`node:crypto`** 内置 Ed25519 | 不需要第三方 |
| CLI 参数 | **`commander` 15** | 与 dsh 一致 |

**绿色包（connector + launcher）侧的硬约束：只用纯 JS 依赖，零原生模块。**
`@node-rs/argon2` 只在 relay 用；relay 部署在 Linux 服务器上，不受绿色包约束。

## 7. 请求全流程（示例）

用户在手机上打开 `https://pc1.dsh.example.com/`：

```
1. Caddy/nginx 终结 TLS，转给 relay 的本地端口
2. relay 从 Host 头解出 machine slug = "pc1"
3. relay 检查会话 cookie
   ├─ 无效 → 302 到 https://relay.dsh.example.com/login
   └─ 有效 → 继续
4. relay 检查该用户是否绑定了 machine "pc1"，且该 machine 在线
   └─ 离线 → 返回自定义 502 页面「机器离线」
5. relay 生成 streamId/streamToken，经控制信道通知 connector
6. connector 回拨一条数据 WS，relay 配对
7. relay 用 http.request({ createConnection: 隧道流 }) 重发请求，
   Host 改写为 127.0.0.1:3080
8. connector 把字节送到本地 dsh，响应原路返回
9. 浏览器拿到 dsh 的前端 dist，随后加载 /plugins/*/client.js，
   POST /api 建立会话，并升级两个下行 WebSocket（同样走 5-8）
```

## 8. 明确不做的事

- ❌ 不实现事件补发 / 游标续传 —— dsh 的 connection 层自己会在 socket 断开时重建 generation（见 02 文档 §3）
- ❌ 不实现 P2P
- ❌ 不实现 E2E 加密（协议留位，v1 不做）
- ❌ 不在 relay 上部署任何业务 UI —— relay 只有登录页和机器列表页
- ❌ 不解析、不理解、不缓存 dsh 的业务协议
