# 02 · dsh 源码核实结论

> 全部结论基于本地 dsh 源码（git `4e84901e64`，tag `dsh-v0.1.2-alpha.4`，源码位置见 skill `dsh-source`）与 npm 上的 `@deepseek-ai/dsh@0.1.2-alpha.4`。alpha.4 升级时逐条复核了本项目依赖的行为，与 alpha.2 的结论一致（见 docs/05-roadmap.md 升级影响评估）。
> 每条都标了出处文件，**改动 dsh 版本后请重新核对**。

## 1. dsh 是 Node 项目，Python 只是外挂

文件统计：`.ts` 2438 个、`.tsx` 262 个、`.py` 仅 20 个。

Python 出现在三处，都与核心运行时无关：

| 路径 | 是什么 |
|---|---|
| `python/sdk/` | 官方 **Python SDK**（`deepseek_harness` 包） |
| `python/sdk-runtime/` | `deepseek_harness_runtime`，用 `hatch_build.py` **把 Node 运行时打包进 wheel** |
| `packages/code-runtime/code-runtime-python/py/protocol.py` | 给模型用的 Python 代码执行 runtime（一个工具） |

佐证 —— `examples/jsonrpc-agent/README.md`：

> The bundled executable already carries every plugin named by this file; **the target machine does not need Node.js.**

即 Python SDK 靠内嵌 Node 运行。**本项目全程 TypeScript，不碰 Python。**

## 2. dsh 的编程接入方式（三条，各有用途）

| 方式 | 包 / 位置 | 说明 |
|---|---|---|
| **Cordis 插件** | 写一个 npm 包，装进 profile | dsh 的原生扩展方式，能力最强，但绑定 dsh 内部 API |
| **stdio JSON-RPC SDK** | `packages/sdk/{protocol,client,server}` → `@deepseek-ai/dsh-sdk-client` / `-protocol` / `-jsonrpc-server` | 官方 TS SDK，驱动一个 dsh 子进程。适合完全自研 UI |
| **Web HTTP API** | `/api` + 两个 WebSocket 下行 | dsh 自带 Web UI 用的通道。**本项目走这条** |

## 3. Web 传输层的确切形状（本项目的核心依据）

出处：`packages/client/connection/`（`README.md`、`src/api-path.ts`、`src/client/web-api-client.ts`）

```
GET  /                      → 前端 dist（frontend-static）—— 需要 dsh 自己的 cookie（§4.6）
GET  /plugins/??a/client.js,b/client.js&rev=<rev> → UI 插件的 combo bundle（不需认证）
POST /api/<service>/<method> → 所有一元调用与 respond 操作（RPC over HTTP POST）
WS   /api/remote.mux        → 唯一的 Typert Remote 多路复用 WebSocket
```

⚠️ **0.1.2 变更**：原来的两条下行 WebSocket（`/api/events.mux`、`/api/events.host`）已删除，
合并为单条双向 `/api/remote.mux`（`packages/api/gateway/src/stream-protocol.ts`）；前端插件改走
`/plugins/??…` combo 路由（`packages/client/modules/src/index.ts`）。对转发层无影响（路径无关），
但代理/网关必须原样透传带 `??` 与逗号的 raw URI。

⚠️ **修正**（M0.4 实测 + 读 `src/index.ts` / `src/client/rpc.ts`）：`POST /api` **不是单一端点**，`/api` 是前缀路由（`{ kind: 'prefix', path: '/api' }`），每次调用打到 `POST /api/<method>`。
请求体 `{"type":"client-request","rpcId":"<uuid>","method":"<method>","payload":{...}}`，响应 `{"type":"server-response","rpcId":"<同 uuid>","result":{...}}`。
fence 对整个前缀生效。**0.1.2 起 method 名是 `<service>/<method>` 两段式**（如 `$events/result`），旧的 `llm.providers` / `settings.describe` 已不存在。对中转无影响（整体转发前缀）。

关键性质：

- `src/api-path.ts` 里 `API_PATH = '/api'` 是**绝对路径**；`web-api-client.ts` 用 `new URL(path, this.resolveBase())` 构造，协议 `https:` 自动转 `wss:`。
  → **这就是 D7（一机一子域名）的原因**，挂在子路径下会 404。
- 断线自愈已内置：一条 socket 断了，当前连接世代失败并重建。
  → 手机切 App 掉线后 dsh 自己会重连，**本项目不需要实现补发机制**。

**结论：中转只需要转发「HTTP GET/POST + 一个 WebSocket 升级」，是最普通不过的反向代理工作。**

## 4. `/api` 的两道门：browser-trust fence + dsh 自己的浏览器认证

出处：`packages/client/connection/README.md` §`/api browser-trust fence`、`src/api-request-trust.ts`、
`src/loopback-hostname.ts`、`src/rpc-host.ts`、`src/browser-auth.ts`

判定顺序（`rpc-host.ts` 的 `requestRejection`）：**fence 不过 → 403；fence 过了但没有 dsh cookie → 401**。

fence 规则：

1. **每个** `/api` 请求（无论是否带浏览器标记）的 `Host` 头必须是 loopback 权威，或命中 `trustedHosts` 条目。
   - loopback 判定见 `src/loopback-hostname.ts`：`localhost`、`[::1]`、`127.0.0.0/8`
   - `trustedHosts` 条目必须是裸的、规范的 `host[:port]`，否则**插件加载时直接抛错**
2. 带浏览器标记时，`Origin` 必须等于 Host 权威；显式 `sec-fetch-site: cross-site` 直接拒绝
3. 失败：HTTP 返回纯 403（在任何 RPC 分发之前）；WebSocket 升级在事件流开始前被拒
4. 这是 **DNS-rebinding 防御，不是认证**。原文：`The fence is a reachability policy, not authentication`。
   认证在 0.1.2 起由另一层提供，见 §4.6。
5. `0.0.0.0` 绑定时 dsh 会把本机 LAN IPv4 字面量自动加进 `trustedHosts`（`packages/bundle/web-app/src/index.ts` 的 `resolveLanTrust`）。

**→ 隧道只有一种合法过法（模式 A），见 §4.3。**

### 4.1 ⚠️ fence 只看 HTTP 头，不看 socket 地址

`src/api-request-trust.ts` 的入参只有 headers：

```ts
interface ApiTrustRequest { headers: IncomingHttpHeaders | Headers }
export function isTrustedApiRequest(request: ApiTrustRequest, trustedHosts: readonly string[]): boolean
```

**没有任何 `socket.remoteAddress` 检查。** 所以声明 `trustedHosts` 就能让远端 Host 通过，
这正是模式 A 成立的基础（也意味着改写 Host 同样能冒充 loopback —— 本项目不这么做，见 §4.3）。

### 4.2 【已作废】被钉死在 loopback 的 15 个特权方法 —— 但客户端换了一种方式钉回来了

> **服务端机制确实没了。** `PRIVILEGED_METHODS` 在 dsh 0.1.2-alpha.4 源码中零出现（alpha.2 核实过一次，alpha.4 升级时复检），
> `rpc-host.ts` 只做统一判定（fence → 403，浏览器认证 → 401），没有按方法名区分的名单。
> `packages/host`、`packages/settings`、`packages/api`（Host 半）里也搜不到任何 `isLoopback` 门禁：
> **`settings/*` 会照常回答任何过了 fence 的请求。**
>
> 旧名单仅作历史记录：`agentPreset.read/copy/openDocument/remove`、`host.pickDirectory/openPath`、
> `settings.describe/openDocument/update/replace/mutate`、`credentials.describe/set/unset`、`llm.discoverModels`。

⚠️ **但同等效果以客户端 gate 的形式回来了**（实测发现，见 §4.7）：浏览器自己按
`location.hostname` 判断「操作者是不是坐在这台机器前」，非 loopback 页面把 settings 持久化
降级成 `memory`，于是设置相关的页面在远程访问时废掉——**不是 403，是前端自我阉割**。

目录选择仍有服务端回退：`dsh-host-directory-picker-browse`（服务端列目录），
`directory-picker-auto` 负责在原生对话框与它之间选择（判定规则见 §4.8）。

### 4.3 模式 A：声明 trustedHosts，不重写（本项目的唯一模式）

| | **模式 A：声明 trustedHosts** | 【已删除】模式 B：重写 Host 为 loopback |
|---|---|---|
| relay 行为 | 原样转发 `Host` / `Origin` | （不再存在） |
| dsh 侧配置 | `--trusted-host pc1.dsh.example.com` 或 profile 里 `trustedHosts` | — |
| 功能 | ✅ 全部可用（含设置与凭据页） | — |
| dsh 的 rebinding 防御 | 保留 | 会被完全绕开 |
| 是否官方支持路径 | ✅ 是 | ❌ 是在绕开厂商的安全控制 |

0.1.2 删掉特权方法名单后，模式 B 只剩下“关掉 dsh 的 rebinding 防御”这一个效果，因此已从本项目删除。

**⚠️ 不要高估 fence 的安全收益。** dsh 源码注释自己承认：

> the deployment's own default already carries `bash` and the filesystem tools, so **any caller that may start a session at all can already run commands as this process. Pinning the switch would be a fence beside an open gate.**

即：模式 A 挡不住已认证的人拿 shell，他照样能 `cat` 出凭据文件。这道钉子是纵深防御，不是隔离边界。

**选 A 的真正理由**：①它是官方支持路径，dsh 将来若加 socket 层校验不会把你打死；②relay 不用改写头，实现更简单、更不容易错。

### 4.4 `trustedHosts` 的格式约束

`assertTrustedAuthority` 要求条目是**裸的、规范的** `host` 或 `host:port`，否则**插件加载时直接抛错**（不是运行时 403）：

- ✅ `pc1.dsh.example.com`（无端口 → 匹配任意端口）
- ✅ `pc1.dsh.example.com:443`（有端口 → 精确匹配）
- ❌ `https://pc1.dsh.example.com`、`pc1.dsh.example.com/path`、`user@host`、`host:`、`:0443`、未加方括号的 IPv6、`0x7f.0.0.1`
- IDN 必须写 punycode

### 4.5 官方对公网暴露的态度

`packages/host/webserver` 的文档（`docs/subsystems/web-server.md`）：

> `host` accepts only `127.0.0.1` (default posture) and `0.0.0.0` (deliberate network exposure); **there is no TLS, auth, or origin policy**, so a non-loopback bind exposes the server to that network.

⚠️ **0.1.2 变更**：`dsh --profile web --host 0.0.0.0` 现在被 CLI **直接拒绝**
（`packages/bundle/web-app/src/startup.ts`：“intentionally not supported yet for safety … use 127.0.0.1 instead”）。
旧文档里「局域网测试可以用 `--host 0.0.0.0`」的说法已作废。

**→ dsh 永远只 bind 127.0.0.1（铁律 4），局域网访问一律走 relay。**

### 4.6 dsh 自带的浏览器认证（0.1.2 新增，本项目必须配合）

出处：`packages/client/connection/src/browser-auth.ts`、`src/rpc-host.ts`、
`packages/host/frontend-static/src/index.ts`、`packages/bundle/web-app/src/index.ts`

| 事实 | 细节 |
|---|---|
| 换 cookie 的入口 | `GET /?token=<launch token>` → 303 到 `/`，同时 `Set-Cookie` |
| cookie 名 | `dsh-auth-<base64url(sha256(authority))>`，**每个 authority 一份** |
| cookie 属性 | HMAC-SHA256 签名、payload 绑定 authority、`HttpOnly; SameSite=Strict; Path=/`、默认 30 天（`cookieMaxAgeDays`）；**没有 `Secure`** |
| 签名密钥 | 存在 credentials（dsh home），**跨重启有效** |
| launch token | `randomBytes(32)` 的 base64url，**每个 dsh 进程一个**，挂在 `ctx.root` 的 WeakMap；没有环境变量可注入，可重复使用（不是一次性消耗） |
| 取 token 的唯一途径 | dsh 启动时打印 `dsh web: http://127.0.0.1:<port>/?token=<token>`（`printUrl` 在 web-app bundle patch 里写死为 true） |
| 适用范围 | `/api/**`（含 WS 升级）与 index（`/`、`/index.html`）；**其余静态资源与 `/plugins/**` 不需认证** |
| loopback 豁免 | **没有**。本机直连 `127.0.0.1:<port>` 也要先走一次 token 交换 |

本项目的对接（实现见 docs/03 §4.4 门 2）：launcher 从 dsh 子进程输出截获 token →
`DSH_REMOTE_DSH_TOKEN` 传给 connector → connector 用 `dsh-auth` 帧上报 relay（protocol v3）→
relay 在 dsh 对首页回 401 时回一次 303 `?token=` 重定向。
**这不削弱安全性**：relay 自己的认证仍在最前面，dsh 那层是叠加。

### 4.7 客户端的 loopback gate，以及官方留的逃生门 `ownsHost`

**现象**：远程地址打开 dsh，设置里「模型」页报 `加载提供方目录失败: settings are unavailable in this browser`，
「插件」页列表正常但每个插件的配置区空白。

**判定链**（全部在浏览器里，服务端不参与）：

| 顺序 | 位置 | 行为 |
|---|---|---|
| 1 | `packages/client/connection/src/client/index.ts:228` | `isLoopback` = transport 声明 `ownsHost` 或页面 hostname 是 loopback |
| 2 | `packages/api/gateway/src/client/index.ts:196` | 发布为 `ctx.remote.$host.isLoopback`，页面生命周期内固定 |
| 3 | `packages/client/ui-settings/src/client/index.ts:58` | `persistence = isLoopback ? 'host' : 'memory'` |
| 4 | `packages/client/ui-settings/src/client/settings-mirror.ts:89/115/133` | `'memory'` ⇒ 状态恒为 `unavailable`，**从不发起 `settings/describe`**，`view` 恒 undefined |
| 5 | `packages/client/ui-settings-models/src/client/store.ts:190` | `view === undefined` ⇒ 就是上面那句报错文案 |
| 6 | `packages/client/ui-settings-plugins/src/client/tab-store.ts:87-90` | `view` 为空 ⇒ served 命名空间集合为空 ⇒ 插件配置卡片全被过滤掉 |

同一标志还降级了 `ui-settings-general/src/client/index.ts:76`（打开设置文档）与
`ui-deliverables/src/client/index.ts:76`。

**逃生门**：`ClientTransportHooks.ownsHost`（`packages/client/connection/src/client/index.ts:96-104`），
从页面全局 `__DSH_TRANSPORT__` 读取，置 true 即等价于 loopback 页面。只设 `ownsHost` 是安全的：
`fetch`（`client/rpc.ts:32`）、`loadBundle`（`client/web/src/boot.ts:71`）缺省时都回退到页面自带的 HTTP/WS 载体。

**注入位置**：`packages/host/webserver/src/index.ts:34` 的 `webserver/index-inject` 事件表，
`injections.ts` 的 `{ kind: 'global' }` 行渲染成 `<head>` 里的内联脚本；客户端入口在读取任何注入状态前
先 await `__DSH_BOOT_READY__`（`injections.ts` 的 `READY_MARKUP`），所以注入一定先于 boot 生效。

**dsh 的 patch 叠加层**（本项目的装载方式）：

- `dsh --profile <p> --patch <file>` 可重复（`apps/cli/src/args.ts:132,163`），在 profile 层之后应用
- 没有 `id` 的 `insert` 补丁把条目追加到条目表末尾（`cordis-plugin-include` 的 `applyEntryPatches`）
- `insert` 行里以 `./` / `../` 开头的 `name` 会被锚定到 **patch 文件所在目录**并转成 `file://` URL
  （`packages/boot/app-boot/src/index.ts:311` 的 `anchorInsertedPluginNames`）

→ 本项目据此实现 `@dsh-remote/dsh-plugin-remote-privileged`（D17）。实测：dsh 正常加载该插件，
首页 `<head>` 里出现 `globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}`，位置在模块入口之前。

### 4.8 目录选择器按启动环境判定，与页面无关

`packages/host/directory-picker-auto/src/resolve.ts`（`web-app` bundle 挂的就是它）在**启动时**采样一次：

| 条件 | 后端 |
|---|---|
| bind 不是 `127.0.0.1` | `browse`（网页内列目录） |
| 有 `SSH_CONNECTION` / `SSH_TTY` | `browse` |
| win32 / darwin | `native`（在**那台机器的桌面**上弹原生对话框） |
| linux 有 DISPLAY/WAYLAND_DISPLAY 且 PATH 上有 zenity/kdialog | `native` |
| 其他 | `browse` |

dsh-remote 里 dsh 恒定 bind `127.0.0.1`（铁律 4），所以 **Windows / macOS 机器判定 `native`**：
远程点「打开工作区」时对话框弹在被控机桌面上，远程看不到；**无头 Linux 服务器判定 `browse`**，远程可用。
官方给的固定方式是直接组合 `-browse` 行而不是 `auto` 行（见该包 README「固定某种交互」）。
**尚未处理**，见 docs/01 §4 风险表。

## 5. 前端是插件组装的（后期自定义 UI 的基础）

出处：`docs/subsystems/client-modules.md`、`packages/client/`

- `packages/client/` 下有 **40 个 `ui-*` 包**：`ui-conversation`、`ui-trajectory`、`ui-permission-presets`、`ui-settings`、`ui-sidebar`、`ui-layout`、`ui-theme`、`ui-slots`、`ui-model-selection`、`ui-subagent`、`ui-workspace`…
- 机制叫 **dual-half plugin**：一个 npm 包同时提供 node 半（`.`）和 browser 半（`./client`），在 `package.json` 里声明：

```jsonc
{
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" }
  },
  "dsh": { "client": { "platform": "web", "inject": ["<某个上游 UI 包>"] } }
}
```

- `ctx.clientModules` 扫描 Loader 中所有声明 `dsh.client` 的包 → 组装 `window.__DSH_BOOT__`（`WebBootGraph`，含 `id/url/rev/inject/immediately/external`）→ 浏览器按 combo 路由 `/plugins/??<id>/client.js,…&rev=<rev>` 动态加载（0.1.2 变更，旧形式是 `/plugins/<id>/client.js`）
- 官方教程：`docs/cookbook/adding-a-settings-card.md`、`docs/subsystems/client-modules.md`
- 安装：`dsh plugin --profile <name> add <包名>`（内部**转发给 pnpm**，在 profile 目录里装）

**⚠️ 移动端适配情况未知** —— 文档中没有任何响应式 / 小屏适配的说明。M0 必须实测。

## 6. 审批（approval）子系统

出处：`docs/subsystems/approval.md`、`docs/subsystems/permission-presets.md`、`packages/interaction/user-approval`

### 6.1 关键陷阱：`'never'` 不是 YOLO

`ApprovalPolicy` 只有两个取值：

| 值 | 语义 |
|---|---|
| `'ask'` | 交给 `approval/request` answerer 瀑布链；没有 answerer 时 fail-closed |
| `'never'` | **每次都确定性返回 `'rejected'`**（严格 headless 姿态，用于 CI） |

**不存在 `'always-allow'`。** 且 `'never'` 在瀑布分发之前就被服务强制执行，用 `prepend` 注册的 answerer 也绕不过去。

内置预设表（`docs/subsystems/permission-presets.md`）：

| 预设 | sandbox mode | approval policy |
|---|---|---|
| `workspace-write` | `workspace-write` | `ask` |
| `danger-full-access` | `danger-full-access` | `never` |

`danger-full-access` 之所以表现得像 YOLO，是因为 sandbox 开到全权限后**工具压根不发起询问**。

### 6.2 正确的「YOLO + 危险操作问我」实现方式

- approval policy 用 **`'ask'`**
- 写插件监听 **`approval/request` 瀑布事件**（官方指定的可插拔策略点）：

```ts
'approval/request'(
  this: Scoped<ApprovalService>,
  req: ApprovalRequest,
  next: () => Promise<ApprovalOutcome>,
): Promise<ApprovalOutcome>
```

返回 outcome = 认领；调 `next()` = 交给下一个 answerer；「the first answer occupies the single decision slot」。

- `ApprovalOutcome` 是封闭枚举：`'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，**fail-closed**（异常 / 非法值一律当 `unavailable` 即拒绝），且 `allowed-once` 只授权这一次，不产生持久授权
- `ApprovalRequest` 是 **same-process** 进程内瀑布事件 → 桥接到手机需要把一个进程内 Promise 拉长到跨网络，超时/取消要自己设计

### 6.3 好消息：审批已经在 Web API 里了

`packages/client/connection/src/client/api.ts` 的类型再导出里有 `ApprovalResponsePayload`、`QuestionResponsePayload`，`packages/client/ui-permission-presets`、`ui-user-questions` 也在。

**→ 隧道打通后，手机上就能直接看到并回应审批请求，无需额外开发。** 只是没有推送通知（需要页面开着）。推送是 M4 的事。

## 7. 一句话总结

> dsh 的 Web 面就是「静态资源 + `POST /api/<service>/<method>` + 一条下行 WebSocket」，
> 外加一道基于 `Host` 头的 rebinding 防御，以及 0.1.2 新增的、只能用启动 token 换取的 cookie 认证。
> 所以本项目 = 一个原样转发 Host、自带认证、并代跑一次 dsh token 交换的反向隧道。
> **仍不需要理解 dsh 的任何业务协议。**
