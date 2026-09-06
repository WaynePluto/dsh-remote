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

⚠️ **这条是给「我们自己往配置里写值」用的，不是用来管用户的。** 用户在权限选择器里选「完全权限」，
拿到的就是 `danger-full-access` = 全权限沙箱 + `never`，两个开关由预设**捆绑**，UI 上没有
「全权限 + ask」这个组合。看到某个会话的 approval policy 是 `never`，**先看它的 sandbox mode**：
配套的就是正常的用户选择，不要报警；只有在沙箱没放开的情况下单独写 `never`，才是「全部拒绝」那个坑。

（本仓库至今没有任何代码设置过 approval policy；真正会用到这条的是 M5 那个审批插件，
约束写在 `docs/05-roadmap.md` M5.1。）

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

## 7. 模型提供方：pi-ai 目录、凭据记录与模型页的扩展槽（copilot-auth 插件的依据）

核实于 tag `dsh-v0.1.2-alpha.4`（pi-ai `0.84.4`）。结论一句话：**dsh 已经内置 GitHub Copilot，缺的只是一个能跑登录的界面。**

### 7.1 dsh 的通用适配器就是 pi-ai

出处：`packages/llm/llm-pi-ai/src/{adapter,catalog,auth,login}.ts`

- `dsh-llm-pi-ai` 建立在 **`@earendil-works/pi-ai`** 之上，`catalogProviders()` 直接取 `builtinProviders()`；
  内置目录里**有 `github-copilot`**（设备码 OAuth + 令牌刷新 + 模型目录），也有 `openai-codex`、`anthropic` 等。
- 凭据记录键 = **`llm-pi-ai/github-copilot`**（`recordKeyFor()`），值 = `{kind:'grant', payload:<pi-ai 凭据原样>}`，
  落在 `$DSH_HOME/.credentials.yaml`。**payload 里不能有显式 `undefined`**（dsh 的存储校验会拒），
  pi-ai 的 github.com 凭据恰好带 `enterpriseUrl: undefined`，所以写入前必须过一遍 JSON 化剥离。
- 路由 `llm-pi-ai.providers['github-copilot']` **不需要 `apiKeyEnv`**：`resolveApiKey` 只在配置了引用时才 fail-loud，
  没配就交给 pi-ai 自己的凭据（即上面那条 grant），刷新也由 pi-ai 在 `store.modify()` 里做。
- ⚠️ **写 `models` 时只能写目录里有的 id**：`resolveRouteModels` 对目录未描述的模型要求显式 `api`，
  而 Copilot 的目录横跨 `anthropic-messages` / `openai-completions` / `openai-responses` 三种协议，
  “整条路由共用一个 api”的推断也不成立。只要有一个账号有而目录没有的 id（GitHub 上新模型比 pi-ai 发包快，
  实例：`claude-opus-4.8-fast`），**整个 settings 写入会被拒**（`assertServiceable` 在持久化前抛错）。
  因此 copilot-auth 只写「账号可用 ∩ 目录已描述」的交集。

### 7.2 授权座存在，但没人挂、也没人用

出处：`packages/credentials/authorization/src/index.ts`、`packages/llm/llm-pi-ai/src/index.ts`、`packages/bundle/*`

- dsh 有 `ctx.authorization`（`registerFlow` / `begin`），`llm-pi-ai` 会为**每个带登录的 pi-ai 提供方注册一条流程**
  （`ctx.inject(['authorization'], …)`），含 Copilot。
- 但 **`@deepseek-ai/dsh-authorization` 没有出现在任何 bundle 的依赖或 `cordis.patch.yml` 里**，
  且全仓库没有一处调用 `authorization.begin()`：既没有 UI，也没有 CLI 子命令。
- 因此 dsh-remote 的 `copilot-auth` 插件**不走这个座**，而是直接用 pi-ai 的登录流程 + 一个 pi-ai `CredentialStore`
  适配器写 `ctx.credentials`（等价的写入路径，且不需要从插件里 value-import dsh/cordis 的包 —— 那会引入模块实例同一性风险）。

### 7.3 模型页给仓库外插件留了官方扩展槽

出处：`packages/client/ui-settings-models/src/client/slot-contract.ts`（原文：*the two seats through which a plugin distributed outside this repository adds UI to the Models settings section without editing it*）

| 槽 | kind | 分派键 | 拿到什么 |
|---|---|---|---|
| `settings.models.provider-card` | keyed | `ProviderDirectoryEntry.settingsNs`（pi-ai 家族就是 `llm-pi-ai`） | `{provider, configured, keyConfigured}`，**每张卡都会分派**，包括「添加提供方」的草稿卡 |
| `settings.models.footer` | list | — | 提供方列表下方的区域 |

注意：它是**卡片内的追加区域，不能替换卡片自己的 API 密钥字段**。

### 7.4 仓库外可以做客户端插件（M0.5 的答案）

出处：`packages/client/modules/src/index.ts`（`locatePkgJson` / `clientExportOf`）、`packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts`

- 客户端模块扫描对 **`--patch` 插入的文件路径入口同样有效**：它把 `./dist/index.js` 解析成 file URL 后
  `nearestPackage()` 往上找 `package.json`，读 `dsh.client` 与 `exports["./client"]`。
  所以 dsh-remote 的插件不用装进 profile 也能带浏览器半。
- 工件格式必须自己复刻（没有发布出来的 preset）：CJS，`window.__ModuleLoader__.load({ id: <包名>, factory: (require) => { … return module.exports } })`，
  `intro` 里补 `var module = { exports: {} }`。
- **externals 只能是模块表里的那几个**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `dsh-client-store`、`dsh-client-ui-slots`、`dsh-client-ui-primitives`；其余一律内联，跨插件的 value import 是被禁止的
  （协作走 cordis 服务）。
- ⚠️ **bundle 缺失不是降级而是致命**：激活期扫描把缺失的 bundle 汇成一次抛错，fiber FAILED，整个 web UI 起不来。
  因此 launcher / dev-stack / pack 三处都要检查 `dist/client.js`。

### 7.5 插件可以开自己的、认证过的 RPC 通道

出处：`packages/client/connection/src/{rpc.ts,rpc-host.ts}`

- 宿主：`ctx.connection.rpc.handle('/<channel>', handler)` —— 注册一条自己的顶层路由，**dsh 自动套上 `/api` 同款的
  Host/Origin 围栏与浏览器认证**（未认证 401），注册随 fiber 释放。`/api` 是保留通道，不能占用。
- 浏览器：`(ctx.get('connection') as ConnectionHandle).rpc.call(channel, endpoint, payload)`；
  客户端半**没有**给 `ctx.connection` 声明 Context 合并，dsh 自己的 API Gateway 也是这样取的。
- 传输是 `POST <channel>/<endpoint>`，信封 `{type:'client-request', rpcId, method, payload}`，回 `{type:'server-response', result}`。

## 8. 模型列表可以不升级 dsh 就改（models-catalog 插件的依据）

核实于 tag `dsh-v0.1.2-alpha.4`（pi-ai `0.84.4`）。结论一句话：**改模型列表是 dsh 本来就有的能力，
缺的只是「知道上游出了新模型」这一步。**

### 8.1 配置层就能盖内置目录

出处：`packages/llm/llm-pi-ai/src/config.ts`（`PiAiProviderProfile`）、`src/catalog.ts`（`resolveRouteModels`）、
`tests/dynamic-config.spec.ts`

- 每条路由可配 `models`（**整份替换**内置目录）与 `modelOverrides`（只改内置已有模型，**不能新增**：
  目录未描述的 id 直接抛错，`catalog.ts` 的 `modelOverrides names "…"` 分支）。
- `models` 条目以 id 为键**盖在内置模型之上**（`...base` 展开），所以只写 `{id}` 的条目等于「照内置目录」。
- 路由是**热更新**的：settings 一写，路由当场注册/摘除（`dynamic-config.spec.ts:116`），不用重启。
- 模型页本来就有编辑器和「获取可用模型」：`ui-settings-models/src/client/ModelListEditor.tsx` +
  `llm-pi-ai/src/discovery.ts`（**内置目录里的路由从目录回答，不发网络请求**；只有目录外的网关/自建端点才打 `GET /models`）。

### 8.2 ⚠️ 单个模型不能声明 `api`（这是能力天花板）

`PiAiModelProfile` **没有 `api` 字段**。协议解析顺序是：路由级 `api` → 同 id 的内置模型 → `sharedCatalogApi`
（该路由内置模型协议唯一时才成立）。于是：

| 路由 | 能否补内置目录没有的模型 |
|---|---|
| anthropic / deepseek / groq 等协议单一的 | ✅ |
| **openai**（responses + completions 混合） | ❌ 整条路由不可服务，**settings 写入被整体拒绝** |
| **github-copilot**（三种协议） | ❌ 同上（§7.1 已记同一个坑） |

**真正的上游解法是给 `PiAiModelProfile` 加一个 `api` 字段。** 在那之前，仓库外插件只能把这类路由报为「不能添加」。

### 8.3 models.dev 的字段够不够 pi-ai 用（已实测更正）

> ⚠️ 早先这里写的「models.dev 完全不带推理信息」**不准确**，已按实测更正。

实测（经代理取到 4.44 MB 的 `api.json`，212 个供应商）后的字段清单：

- provider 层：`id, env, npm, name, doc, models`
- model 层：`id, name, description, family, attachment, reasoning, reasoning_options, tool_call,
  structured_output, temperature, knowledge, release_date, last_updated, modalities, open_weights, limit, cost`

**有 `reasoning_options`，但不能直接当 dsh 的 `reasoningEfforts` 用。** 它是**档位名单**而不是 wire 拼写，而且形态不统一：

| 供应商 | 实测到的 `reasoning_options` 形态 |
|---|---|
| anthropic | `[{type:'effort', values:['low','medium','high','xhigh','max']}]`、`[{type:'toggle'},…]`、`[{type:'budget_tokens', min:1024}]` |
| openai | `[{type:'effort', values:['minimal','low','medium','high']}]` 等三种 |
| groq | `[{type:'effort', values:['none','default']}]` ← **`none` / `default` 根本不是 dsh 的档位名** |

而 dsh 要的是 `{档位: wire 拼写}`（`catalog.ts` 的 `resolveModelReasoning`），缺省即「不会思考」。
所以**直接把 values 当 wire 值写进去会让请求被供应商拒**，插件当前的做法是只显示不写入。

**安全的改进路线（未实施）**：pi-ai 的内置数据里每个模型都带 `thinkingLevelMap`，
可以从同一供应商的兄弟推理模型抄一份真实的 map，再与 models.dev 声明的档位取交集。

### 8.3a pi-ai 的内置目录在磁盘上是可读的 JSON

`node_modules/@earendil-works/pi-ai/dist/providers/data/`：

- `<provider>.json`，结构是 **`{ "<api>": { "<modelId>": {id,name,api,provider,baseUrl,reasoning,input,cost,contextWindow,maxTokens,thinkingLevelMap,…} } }`**
  —— **按 wire 协议分组**，所以「这条路由是不是跨协议」就是数顶层键的个数。
- `.manifest.json` 带 `generatedAt`（本机为 `2026-08-28T22:00:02Z`），与 `getBuiltinModelDataGeneratedAt()` 同源。

对不能 `import` 的场合（比如创造模式的动态插件）这是唯一能拿到真实内置目录的途径。


### 8.4 插件要用到的几个只读/写入接口

出处：`packages/settings/settings/src/index.ts`、`packages/llm/llm/src/index.ts`

- `ctx.settings.get(ns)` / `update(ns, patch)` / `replace(ns, section)` /
  **`mutate(ns, ops)`**（ops 是 `{op:'set'|'unset', path: string[], value?}`，路径寻址、只改自己写的字段）。
- `ctx.settings.register(ns, schema)`：插件可以**注册自己的设置命名空间**（schemastery schema），
  用来存自己的状态；`dsh-plugin-models-catalog` 的溯源就放在这里。
- `ctx.llm.listConfigurableProviders()` → `{provider, displayName, settingsNs, settingsPath}`，
  `llm-pi-ai` 的 `settingsPath` 就是 `['providers', <route>]`。
  ⚠️ 它**列出每一个内置目录里的供应商**（含没配过的），要「用户配过的」得用 settings 的 `providers` 键过滤。
- `ctx.llm.listProviders()` / `listModels(id)` / `resolveModelInfo(id, model)`：**已生效**的目录
  （写了 `models` 之后它返回的就是覆盖后的结果，不能当作「纯净内置目录」用）。

### 8.4a 活体核实（在真实进程里跑动态插件读出来的，非推断）

用创造模式的动态 Host 插件只读探测本机 dsh 进程（`.dev/models-catalog-probe.json`，读完即删）：

- `settings.writable === true`，`llm` / `web` / `fs` 服务都在。
- ⚠️ **schemastery 会把 profile 的每个键都物化出来**：只登录过 Copilot、没配过模型的路由，
  `providers['github-copilot']` 也带着 `models` / `modelOverrides` / `compat` / `defaultContextWindow` … 一整套键，
  其中 **`models` 是 `[]` 而不是 `undefined`**。所以「有没有配模型列表」必须判 `Array.isArray(x) && x.length > 0`，
  只判 `!== undefined` 会把每条路由都误判成「配过」。
- `listConfigurableProviders()` 有 **40 条**（39 条 `llm-pi-ai` + 1 条 `llm-deepseek`），**含全部未配置的内置供应商**；
  「用户配过的」只能靠 settings 里 `providers` 的键来定（本机只有 1 条：`github-copilot`）。条目上有 `declared` 标志位。
- ⚠️ **本机直连 models.dev 不通，走公司代理可通**（实测）：
  - 直连：`UND_ERR_CONNECT_TIMEOUT`（Cloudflare 的 172.67.69.147 / 104.26.8.108 / 104.26.9.108:443 均超时）；
  - 经 `http://proxy.example.com:8080`：**200，4.44 MB，2.7 秒**；
  - `curl.exe` 无论走不走代理都是 `schannel: SEC_E_NO_CREDENTIALS` —— 那是 Windows 凭据存储那一层的问题，
    **不代表网络不通**；Node 走 OpenSSL 不受影响，排查时别被它误导。
- ⚠️ **Node 的全局 `fetch` 不认 `HTTP(S)_PROXY` 环境变量**，dsh 与 pi-ai 又全程用全局 `fetch`、
  从不传 `dispatcher`（全仓库 `setGlobalDispatcher` / `ProxyAgent` 零出现；pi-ai 的 OAuth 是裸 `fetch`，
  模型请求把 `options?.fetch` 交给 SDK，默认还是全局 `fetch`）。
  **结论：dsh 的对话、登录、web fetch/search 一律不走代理。**
  dsh 源码里 `HTTP_PROXY` 只出现在 `packages/boot/app-boot/src/index.ts` 的 `BOOTSTRAP_NAMES`——
  那是「这些变量只能来自继承的环境，项目 `.env` 不许覆盖」的**安全名单**，不是代理支持。
  → 本项目的解法是 `packages/plugins/proxy`：换掉 undici 的**全局 dispatcher**，一次覆盖所有出网。
- 本机环境设了 `NODE_TLS_REJECT_UNAUTHORIZED=0`（Node 会打警告），说明出网链路上有 TLS 中间人；
  这是既有环境事实，不是本项目引入的。

### 8.5 ⚠️ `settings.models.provider-card` 一个 key 只能有一个**同 priority** 的注册者

出处：`packages/client/ui-slots/src/index.ts:836-842`（keyed 槽的 cell 占用检查）、
`src/index.ts:749-755`（shadowing 规则）、`src/index.ts:955-983`（`entriesOfSlot` 选优）

`copilot-auth` 已经占了 `llm-pi-ai` 这个 key。**再写一个插件用默认 priority 往同一张卡里加按钮会当场抛错**，
所以 `models-catalog` 用的是 list 类型的 `settings.models.footer`（可多注册）。

⚠️ **更正（alpha.4 实读）**：keyed / single / list 槽都支持**按 priority 影子覆盖** ——
同一个 cell 上不同 priority 的条目并存，**升序排序、priority 最小的那个渲染**；
只有「同 cell + 同 priority」才抛错（默认 priority 是 0，所以不写 priority 的两个注册必然相撞）。
换言之：想**接管** dsh 自己已经占了的一个 key，正确做法是用 `priority: -1` 注册，
这是框架公开支持的能力、**与注册先后无关**，不是 hack。想**并列添加**才必须另找 list 槽。
本仓库的 `exec-process` 插件就是这么接管 `conversation.chat.node` 的 `turn-process` 的（见 §11）。

### 8.6 ⚠️ 主题变量名写错不会报错，只会静默用兜底色

出处：`Theme.listTokens`（创造模式 Inspect Provider）+ 在 `packages/client/**/*.css` 里数出现次数

插件用 `var(--dsw-…, 兜底)` 写内联样式，**名字写错不会有任何报错**，只会一直用兜底的死值——
于是「深浅色不跟随主题」这种问题要到肉眼看深色模式时才会发现。本仓库曾经把三个名字都写错了：

| 写错的 | 正确的 | 说明 |
|---|---|---|
| `--dsw-alias-border-1` | **`--dsw-alias-border-l1`** | 是字母 `l`（layer 1），不是数字 1；另有 `--dsw-alias-border-l2` |
| `--dsw-alias-fill-2` | **`--dsw-alias-bg-layer-2`** | 没有 `fill-*` 这一族 |
| `--dsw-font-family-mono` | **`--dsw-font-mono`** | 另有 `--dsw-font-family`。⚠️ 见下面 §8.6b：这个名字**对但没用** |

确实存在、可以放心用的：`--dsw-alias-bg-base` / `-bg-layer-1` / `-bg-layer-2` / `-bg-overlay`、
`--dsw-alias-border-l1` / `-l2`、`--dsw-alias-label-primary` / `-secondary` / `-primary-inverted`、
`--dsw-alias-brand-primary`、`--dsw-alias-button-primary-fill`、
`--dsw-alias-state-{error,success,warn}-primary`、`--dsw-specific-sidebar-fill`。

**写完客户端样式后要在深色下看一眼。** 两条路：把插件装进 dsh 重启后直接看（最真实），
或者用 esbuild 把组件单独打进一张空白页、喂假的 scope 与假的 RPC 通道来看明暗两套
（本次就是这么发现上面三个错名的；产物放在被 git 忽略的 `.dev/` 里，属于一次性脚手架，
需要常备的话再提升到 `scripts/`）。

### 8.6b ⚠️ `--dsw-font-mono` 名字是对的，但 dsh 从来没有定义过它

核实于 alpha.4，**在真浏览器里问出来的**（`getComputedStyle(el).getPropertyValue('--dsw-font-mono')`
返回空串），随后在源码里对上：全 `packages/client/**` 只有**四处引用、零处定义** ——
`ui-agent-preset/src/client/AgentPresetSection.module.css:245,329,412` 三处写的都是
`var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)`，
`ui-jobs/src/client/JobListAction.module.css:102` 干脆写成不带兜底的 `var(--dsw-font-mono)`（等于什么都没设）。

**结论**：等宽字体这一条上**没有主题令牌可依**，dsh 自己也一直在吃兜底。所以

- 继续写 `var(--dsw-font-mono, …)` 是对的（哪天 dsh 定义了就自动跟上），
- 但**兜底必须是一整条完整字体栈**，照抄 dsh 自己那条
  `ui-monospace, SFMono-Regular, Menlo, monospace`；只写 `ui-monospace, monospace`
  在 Windows 上会直接落到浏览器的默认 fixed 字体（`ui-monospace` 是 Apple 平台的通用族）。
- ⚠️ 这条也说明「名字写对」和「值解析得出」是两回事：**§8.6 那套检查只能查前者**，
  后者只有在真页面里问一句 `getPropertyValue()` 才知道
  （`packages/plugins/terminal` 的浏览器验收就是这么做的）。
  本仓库 `packages/plugins/services` 的面板用的仍是那条短兜底，视觉上无差别，**已知且接受**。

### 8.6a ⚠️ 浅色主题里 `bg-layer-1/2/3` 是同一个白

出处：`packages/client/ui-theme/src/styles/design-platform.css:158-160`（`body`，浅色）、
`:250-252`（`body[data-ds-dark-theme]`，深色）

```css
/* 浅色 */                                  /* 深色 */
--dsw-alias-bg-layer-1: …-neutral-bluish-00;   --dsw-alias-bg-layer-1: …-875;
--dsw-alias-bg-layer-2: …-neutral-bluish-00;   --dsw-alias-bg-layer-2: …-850;
--dsw-alias-bg-layer-3: …-neutral-bluish-00;   --dsw-alias-bg-layer-3: …-800;
```

深色下三层确实是三个不同的灰，**浅色下是同一个白**——所以「用下一层的 layer token 把一个内嵌
小容器衬出来」这种做法**在浅色主题里等于什么都没画**，而且不会有任何报错。
要在两套主题里都看得见内嵌容器，只能靠 `--dsw-alias-border-l1` 描边，或者自己写一个
中性半透明灰（`rgba(128,128,128,0.1)` 这类：压在浅色上变深、压在深色上变浅）。
turn-retry 的错误滚动框走的就是后者。

⚠️ 只有 `bg-layer-1` / `bg-layer-2` 在 `Theme.listTokens` 的清单里。`bg-layer-3` 有定义但没进清单，
`bg-layer-4` **根本没有定义**（dsh 自己在 `ui-settings-plugins/src/client/SubagentModelSelectionCard.module.css:152`
用了它，那句是死的）。插件要用这两个就自己带兜底值。

### 8.7 ⚠️ 设置页左侧导航的图标是硬编码的，`settings.section` 没有图标位

出处：`packages/client/ui-settings-general/src/client/SettingsRoot.tsx:27-32`（`navIcon(id)`）、
`packages/client/ui-settings/src/client/contract/slots.ts:43-54`（槽的注册项）、
`packages/client/ui-settings-general/src/client/shell-contract.ts:20-24`（投影出的导航行）

| 事实 | 细节 |
|---|---|
| 注册项能带什么 | 只有 `id` / `order` / `label`（外加 `locale`、`inject`）。**没有 icon 字段** |
| 图标从哪来 | shell 自己按 `id` 查一张写死的表：`models` → 数据图标、`agent-presets`、`plugins` 各一个 |
| 未知 id | **一律落到齿轮** `IconSettingsOutline16`——所以仓库外插件的设置页天生和「常规」长一样 |
| 导航行 DOM | `button.<hash>_navCell > svg.<hash>_navIcon + span.<hash>_navLabel`；hash 由 lightningcss 的 `[hash]_[local]` 生成，**局部名（`_navCell` 等）在整个前端唯一** |
| dsh 自带的地球图标 | `IconGlobeOutline14`（`packages/client/ui-primitives/src/icons/index.tsx:35`），viewBox `0 0 14 14`，`fill="currentColor"` |

本项目的解法在 `packages/plugins/proxy/src/client/nav-glyph.ts`（代理页要一个网络图标）：
**只往自己那一行的 button 上写一个 `data-` 属性**（React 只管自己渲染过的属性，外部加的属性能活过每次
重渲染），其余全部交给一张注入的样式表——隐藏兜底的 `<svg>`，用 `::before` 把地球当 mask 画出来、
底色 `currentColor`，于是 hover / 选中 / 深色模式自动跟随。MutationObserver 只在新增元素的 class
里出现 `_overlay` / `_navCell` 时才扫一遍，聊天流式输出不会为它付钱。

`packages/plugins/notify/src/client/nav-glyph.ts` 是同一套机制的第二例（通知页要一个铃铛），
另外多两条只有它踩过的经验：

- **dsh 的图标集里没有铃铛**，最近的是 `IconAlarmClockOutline16`——但**那是错的词**：dsh 本身有
  Schedule 子系统，闹钟在设置里会被读成「定时任务」。所以按 dsh 自己的描边语汇重画了一个
  （16×16 viewBox、`stroke-width: 1.25`、圆头圆角——闹钟 / 齿轮都是这套；只有早期的地球是**填充**的
  14×14，不要照它的路子画新图标）。
- ⚠️ **自己画的图标必须对齐 dsh 自带图标的跨度**。`IconAlarmClockOutline16` 铺到 x 1.75–14.25、
  y 2.5–13.75，几乎顶满 16 的框。第一版铃铛只有 x 3.5–12.5，**单独看完全正常**，一放进导航列、
  和上下两行 dsh 自己的图标并排，就明显小一圈。定稿是 x 2.25–13.75、y 2–13.875。
  **教训：图标大小只有放进真实的行、挨着真实的邻居才判得准**，单独渲染一张对比图会漏掉这个问题——
  这次是把三个尺寸做成临时 Cordis 插件、用 `styles.insert` 画到真实导航行上，由用户直接指认的。

**这是对 dsh DOM 的耦合，升级 dsh 后要复核**：局部类名若改，那一行只是退回齿轮（降级，不会坏）。
核实方式和 §8.6 一样——esbuild 把 `nav-glyph.ts` 单独打进一张仿照 `SettingsRoot.module.css` 结构的
空白页，用 CDP 看明暗两套（本次实测：只有「代理」那一行被标记、`<svg>` 被隐藏、mask 是 `16px 16px`，
disposer 调用后三样全部复原）。

### 8.8 ⚠️⚠️ `SettingsScope.mutate` 在宿主**拒绝**写入时是 resolve，不是 reject

出处：`packages/client/ui-settings/src/client/settings-scope.ts:126-151`

```ts
const response = await this.ctx.remote.settings.mutate(ns, ownedOps, revision)
if (!response.ok) {
  await this.recover(generation)   // 悄悄把宿主状态重新载入
  return                           // ← 正常 resolve，不抛
}
```

也就是说浏览器侧的 `await scope.mutate(...)` **成功返回并不代表写进去了**。宿主校验器抛出的那条
消息（`settings/rejected`）根本到不了页面：`SettingsScopeSnapshot` 上没有 `error` 字段，
`recover()` 只是重新 load。

**这个坑长什么样**（代理插件真实踩过）：页面 `try { await scope.mutate(...); setSaved(true) } catch { … }`
的 catch 是**死代码**，于是一次被拒的写入表现为「提示已保存 → 所有字段弹回原值 → 没有任何错误」，
而且如果 `catch` 之外还 `setDraft(undefined)`，用户刚输入的内容**当场丢失**。用户看到的就是
「存不进去、勾不上」。

**正确写法**（`packages/plugins/proxy/src/client/ProxySection.tsx`）：

1. **写之前先在本地判一次**，用和宿主校验器**同一套纯函数**（放在两半共享的模块里，
   不要各写一份 —— 两份规则迟早不一致，而不一致的表现正是「页面收了、宿主拒了」）；
2. **写之后核对落地**：`await scope.mutate(ops)` 之后读 `scope.getSnapshot().value`，
   逐字段比对预期值；不一致就报错并**保留草稿**；
3. 只在核对通过之后才清草稿、才显示「已保存」。

顺带两条同源经验：

- **「已保存」提示会被自己成功的那次写入清掉**：如果用 `useEffect(..., [settings.url])` 在文档变化时
  丢弃草稿，成功保存恰好会触发它。要记住「这次变化是我自己写的」（存一份刚提交的 section 做比对）。
- **报错要贴着出错的字段**，不要堆在页面最底部——那里没人会把它和刚输入的地址联系起来。

## 9. 补丁层顺序与「插件的 config 到底从哪来」
出处：`apps/cli/src/profile-boot.ts`（`allPatches` / `composeProfile`）、`packages/boot/app-boot/src/index.ts`
（`watchUserPatches` 的注释：*bundle layers below, overlays above*）、`packages/boot/app-boot/src/profile.ts`

**应用顺序（后者覆盖前者）**：

```
bundle 层（@deepseek-ai/dsh-base、dsh-web-app 的 cordis.patch.yml）
  → profile 的 cordis.patch.yml（$DSH_HOME/profiles/<name>/cordis.patch.yml）
    → DSH_HOME 级 patch（作用于所有 profile，故排在 per-profile 之后）
      → `--patch` 叠加层（argv 顺序）
```

由此得出两条对本项目很实际的结论：

1. **`--patch` 在最后**，所以 profile 的 `cordis.patch.yml` **改不了我们用 `--patch` 插进去的行的 config**
   —— 那时那一行还不存在。要覆盖只能再挂一个更靠后的 `--patch`，且**被覆盖的行必须有 `id`**
   （`models-catalog` 的 overlay 因此写了 `id: models-catalog`）。
2. 因机器而异的配置（代理地址之类）**走环境变量最省事**，插件自己读 `HTTPS_PROXY` 等即可，
   不用碰任何 patch 文件（也就不违反铁律 10 的「不写 home 级 patch」）。

**另外：cordis 插件的 `config` 与设置页无关。** 「设置 → 插件 → 插件配置」页
（`packages/client/ui-settings-plugins`）的卡片编辑的是**设置命名空间**（`settings.plugin.item` 按 ns 分派，
bash / web-search / subagent-model-selection 都是走 `scope.mutate` 写 settings），**够不到** cordis 的
plugin config。想让用户能在界面上改，就得注册一个设置命名空间，而不是加 `Config` 字段。

profile 的 `patchReload`：`web` 模板默认 `live`（`profile.spec.ts` 锁定），
本项目的 `dsh-remote-web` profile 清单里没写这一项且 bundles 与 stock web 一致，因此同样是 `live`。

## 10. turn 失败、自动重试与「重跑」（turn-retry 插件的依据）

核实于 tag `dsh-v0.1.2-alpha.4`。

### 10.1 一次模型请求失败会走到哪

出处：`packages/core/agent-loop/src/agent.ts:341-438`（`step()` 里的 `while (true)`）

```
stream 出错 → assembler.finish.kind === 'error'
  → dispatch.waterfall('agent/request-error', {...}, () => undefined)   L392-402
    → 返回 {kind:'retry'} → continue，**同一 turn、同一 step 重发**       L407
    → 返回 undefined      → throw LlmError                               L405
      → catch: turnEnds = {kind:'error', error}                          L318-323
      → emit Cordis 'agent/error'（**不写日志**）                         L324
      → finally: session.append('turn/end', {turn, reason})              L328
```

**关键结论**：`{kind:'retry'}` 是 dsh 里**唯一**的「不追加用户消息就重跑」的语义，而且只在
turn 还没抛出去之前有效。一旦 `turn/end` 落盘就再也回不去了。

⚠️ 失败路径是 `throw`，所以 `turn()` 末尾的「还有排队消息就再来一轮」没执行
（`agent.ts:333`）——**turn 失败后 inbox 里积压的消息会被搁置，不会自动开下一轮**。

### 10.2 `agent/request-error` 瀑布的签名

出处：`packages/core/agent/src/runtime-types.ts:66, 252-267`

```ts
export type RequestErrorAction = { kind: 'retry' } | undefined

'agent/request-error'(
  this: Scoped<Agent>,
  payload: { agent, turn, step, provider, failure: LlmFailure,
             retryPolicy: ResolvedRetryPolicy | undefined, signal: AbortSignal },
  next: () => Promise<RequestErrorAction>,
): Promise<RequestErrorAction>
```

### 10.3 dsh 自带的 `llm-retry` 什么时候放弃

出处：`packages/llm/llm-retry/src/index.ts:194-241`，默认值 `packages/llm/llm/src/retry-policy.ts:14-24`
（`maxRetries: 5`、`initialDelayMs: 500`、`maxDelayMs: 10_000`、可重试码
`EMPTY_RESPONSE / RATE_LIMIT / SERVER / TIMEOUT / TRANSPORT`）。

它**放弃时调 `next()`**（policy 缺失 L198、失败码不可重试 L215、预算耗尽 L223、
`Retry-After` 超过 `maxDelayMs` L230）。**放弃本身不写任何事件**，日志里只留下此前每次重试写的
`llm/retry` 与 `llm/retry-started`。所以判断「自动重试已耗尽」要看 `turn/end`，不能数 `llm/retry`。

⚠️ `mode: 'always'` 的分支**先调 `next()` 再自己无限退避**（L204），所以下游监听器在这种策略下会
在**第一次**失败就被叫到，而不是在自动重试之后。

### 10.4 turn 结束原因是一个可区分的和类型

出处：`packages/core/session/src/types.ts:180-215, 266-279`

```ts
'turn/end': { turn: number; reason: TurnEndReason }

completed | aborted{reason: AgentCancelCause} | blocked
| error{error: LlmFailure} | max-tokens | interrupted
```

**用户主动取消**是 `aborted{reason:{kind:'user'}}`（`agent.ts:313`，session-controller 的 cancel 传的正是
这个，`commands.ts:446`）；**技术失败**是 `error`；**进程崩溃留下的半截 turn** 是 `interrupted`
（`session/src/repair.ts:133`）。`error.code === 'UNKNOWN'` 表示这不是 `LlmError`，而是别的异常被
`errorChain` 压平的（`agent.ts:320-322`）。

`aborted` 的 `reason` 又是一个和类型（`AgentCancelCause` + 导入记录用的 `legacy`，`types.ts:180-188`）：

| `reason.kind` | 谁按的 | turn-retry 给不给「继续」按钮 |
|---|---|---|
| `user` | 人按了停止 | **给** —— 这正是「停了想接着做」的场景 |
| `disposed` | agent 被销毁（进程收摊等） | **给** —— 没人做过「到此为止」的决定 |
| `legacy` | 导入的旧记录没记原因 | **给** —— 同上 |
| `hook` | 钩子按策略掐掉的 | 不给 —— 一次点击不该推翻一个已经做出的策略决定 |
| `parent` | 父 agent 收子 agent | 不给 —— 子 agent 的轮次归父 agent 管 |

（`interrupted` 与 `disposed` 同类；`completed` / `blocked` / `max-tokens` 是正常收尾。）

⚠️ `agent/error` **不在** `KNOWN_SESSION_EVENT_TYPES` 里，它只是 Cordis 运行时事件，而且**早于**
`turn/end` 落盘（`agent.ts:324` vs `:328`）。要做 UI 状态一律以 `turn/end` 为准。

### 10.5 没有「不追加 user message 就重新推理」的入口

`ctx.agents` / `ctx.agentLoop` 上**没有** `prompt`/`submit`/`run`；能开一轮的只有 `Agent` 实例上的
`send` / `followup` / `steer` / `inject`（`runtime-types.ts:112-149`），**四个都要 `UserMessage`**，
而 `inject` 还不唤醒。空消息也没用：`decision.messages.length === 0` 会让第一步以 `completed`
空转结束、不发模型请求（`agent.ts:280-286`）；进了 step 的消息一定以 `surfaceOp:'append'` 落盘
（`agent.ts:291-293`）。

`ctx.agents.resume()` 是「加载已持久化 session 并在其上新建活的 Agent」，**不是重新推理**
（`agent/src/index.ts:196-206`；`tests/resume.spec.ts:620-646` 里 resume 之后仍要 `followup` 才跑模型）。

⇒ **事后重试必然多一条 `user/message`。** 代价可以降到最低：用 plugin 溯源
（`MessageSourceMap.plugin` = `{kind:'plugin', plugin} & ContextFormed`，`llm/src/message.ts:102-107`），
`form:'notice'` + `summary`（≤120 字符，`message.ts:114-125`）在会话里渲染成**一行折叠的 context 行**
而不是用户气泡（`ui-chat/src/client/conversation-nodes/message.ts:50-59`）。
先例：`packages/goal/goal-round-driver/src/index.ts:174-192`。

### 10.6 session projection：宿主算、dsh 自动推给页面、客户端零折叠代码

出处：`packages/session/session-projection/src/index.ts`、
`packages/api/session-controller/src/control.ts:27,88`、
`packages/api/session-controller/src/client/sessions/projection-store.ts:1-41`

宿主 `ctx.sessionProjections.register({ key, stateVersion, stateSchema, init, apply, wire })`
注册一个**纯同步 fold**；框架订阅 `session/event` 驱动它，Session Controller 把**每个**已注册 wire key
的变化推给浏览器（`onChanged`），客户端 `useProjection('<key>')` 直接读。

对第三方插件的三条实际结论：

1. **不需要任何客户端注册**：`snapshot(session)` 不带 key 过滤，client 侧 `faceOf(key: string)`
   按字符串取。宿主注册了，页面就能读。
2. **`apply` 必须在事件与自己无关时返回同一个引用**：框架用 `Object.is` 决定要不要发帧
   （`index.ts:645,679`），每次重建状态会安静地刷屏。
3. 类型表要从**纯类型出口** `@deepseek-ai/dsh-session-projection/types` 合并，不能从包根 —— 包根的
   dsh-agent → dsh-session 链会把宿主的 `Context.sessions` 合并拖进浏览器程序。

### 10.7 会话页可用的插件槽

出处：`packages/client/ui-conversation/src/client/contract/slots.ts:92-148`、
`packages/client/ui-chat/src/client/chat/register-node-renderers.ts`

- **消息流里没有「单条消息 / 单个 turn 之后」的通用 list 槽。** 想往流里塞东西得注册
  `ConversationNodeDefinition` + `conversation.chat.node`（**keyed**），而
  `turn-error` / `model-retry` 两个 key **已被 dsh 自己占用**（`register-node-renderers.ts:39,41`）。
  用**同 priority**（默认 0）重复注册直接抛错；但换一个 priority 是**影子覆盖**而不是冲突，
  见 §8.5 的更正 —— 所以「接管 dsh 的某个已占 key」是可行且受支持的，「在同一个 key 上并列添加」才不行。
- 安全的落点是 `conversation.input.dock`（**list**，scope `session`，
  owner `{session: SessionSnapshot, input: InputState}`，「输入框上方的整宽区域」）。
  dsh 自己的占用：todo `order:0`、queue `order:20`。
- ⚠️ **「整宽」是字面意思：dock 条目必须自己声明宽度，否则铺满整个会话列。**
  容器 `.composerStack` 只是一个 `display:flex; flex-direction:column` 的栈
  （`ConversationRoot.module.css:281-289`），**宽度上限不在栈上，在每张卡自己身上**：
  输入卡是 `width:100%; max-width: var(--dsh-composer-card-max-width)`
  （`InputBar.module.css:40-41`，外面还有一层 `align-items:center` + 16px 侧留白），
  todo / queue 两个 dock 条目则各自重述一遍共享宽度轴：

  ```css
  /* TodoPanel.module.css:1-21 —— 插件想跟它们对齐就照抄这一段 */
  margin: 0 auto;
  width:     calc(100% - 侧留白×2 - dock 内缩×4);
  max-width: calc(var(--dsh-composer-card-max-width) - dock 内缩×4);
  ```

  变量都定义在 `.root` 上（`:28-34`：`--dsh-chat-content-width` = `clamp(680px, 列宽×0.64, 920px)`、
  `--dsh-composer-card-max-width` = 它 +32px、`--dsh-composer-side-clearance: 16px`、
  `--dsh-composer-dock-inset: 8px`），会继承到插件的节点上，直接 `var()` 就行。
  **不写这一段的后果**是横幅比输入框宽 32px、比转录正文宽得更多 —— 看起来就是「宽度超出消息区域」，
  而且和文本长短无关。turn-retry 的横幅第一版就栽在这里。
- 想往流里加**自己的一行**，正路是「自己的 `ConversationNodeDefinition` + 自己的新 key」——
  新 key 不与任何人相撞，`ChatNodeDataMap` 是 ui-chat 公开的合并面（`ui-chat/src/client/index.ts:56-62`）。
  `exec-process` 插件走的就是这条（见 §11）。
- 其余：`conversation.composer.dock`（list，输入框下方）、
  `conversation.session.header.actions/.utilities`（list）、
  `conversation.chat.turnTail`（**chain**，第一个接受的才渲染，已有 ui-deliverables 占用）。

### 10.7a dock 卡片的「样子」也是抄的，不是设计的

出处：`packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`、
`.../skeleton/TodoPanel.tsx:88-121`、`.../queue/QueueDock.module.css:28-100`、
`packages/client/ui-primitives/src/icons/index.tsx`、
`packages/client/web/src/platform.ts:8-13`

宽度轴（§10.7）只解决「不比消息区宽」；**卡片本身长什么样**是另一件必须照抄的事，
否则插件的卡片挨着 dsh 自己的 todo / queue 条目，一眼就是外来户。dsh 自己那两张卡的数值：

| 位置 | 值 | 备注 |
|---|---|---|
| 背景 | `var(--dsw-specific-tip)` | **抬升面**，浅色 `rgb(245,246,247)`、深色 `rgb(53,54,56)`（`design-platform.css:245,337`）。⚠️ 不是 `--dsw-alias-bg-base`（浅色下就是纯白，卡片直接融进页面），也不是 `--dsw-alias-bg-layer-*`（浅色下 layer 1-3 同一个白，见 §8.6a） |
| 描边 | `0.5px solid var(--dsw-alias-border-l1)` | 是 0.5px，不是 1px |
| 圆角 | `12px` | 不是 10px |
| 头部 | `display:flex; align-items:center; gap:10px`（todo `.body` 6px 12px + `.header`；queue 用 36px 行高 + `padding:4px 12px`） | 整行是 `<button>`，`border:none; background:transparent; text-align:left`，并带 `aria-expanded` |
| 标题 | `font-size:13px; line-height:24px; font-weight:500; color: var(--dsw-alias-label-primary)` | 不是 `font-weight:600` |
| 副标题 / 摘要 | `flex:1 1 auto; min-width:0; font-size:13px; line-height:20px; color: var(--dsw-alias-label-tertiary)` + 省略号 | |
| 标题左侧图标 | `display:grid; place-items:center; color: var(--dsw-alias-label-tertiary)`，内放 dsh 自带的 14px outline 图标 | todo 用 `IconChecklistOutline14`，queue 用 `IconQueueOutline14` |
| 折叠箭头 | 同上的 grid 单元格，**collapsed → `IconChevronUpOutline14`，展开 → `IconChevronDownOutline14`** | ⚠️ 方向就是这样，不要按直觉反过来；也不要用文本 `▾ / ▴`，那是另一套字形和字重 |
| 内部滚动条 | 卡片上再写 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)`、`--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)` | 抬升面上的滚动条要换 l2 档，见 ui-theme `styles/scrollbar.css` |

图标从哪来：`@deepseek-ai/dsh-client-ui-primitives` **在页面的冻结模块表里**
（`PLATFORM_MODULES`，`packages/client/web/src/platform.ts:12`），所以插件的浏览器半可以直接
`import` 它，并在自己的 `tsdown.config.ts` 的 `MODULE_TABLE` 里列上这个 specifier 保持 external ——
拿到的是页面**已经加载的那一份**组件与 CSS，不是打进 bundle 的第二份副本。
可用图标名见 `ui-primitives/src/icons/index.tsx`（`IconApiOutline14`、`IconCodeOutline16`、
`IconRefreshOutline14`、`IconChevronUp/DownOutline14` …）。
本仓库现有占用：services 与 terminal 两张卡**共用** `IconApiOutline14`（用户拍板；两卡标题不同、
也很少同屏，不必各占一枚），turn-retry 用 `IconRefreshOutline14`。

⚠️ **本仓库在表头这一项上刻意不照抄 dsh：对齐交给 flex，不写死尺寸。**
dsh 的表头是 `lead`(14px) + 标题(24px) + 摘要(20px) + chevron(14px)，靠 `align-items:center`
对齐 —— 对齐的是**盒子中心**，而这四个盒子高度各不相同，图标的几何中心与文字 ink 的视觉中心就
差出肉眼可见的一两像素（用户实机反馈「icon、标题、副标题竖直方向没对齐」）。本仓库三张卡改成
两层 flex：① 表头 `align-items: stretch`，四个块被拉成**同一高度**（由内容决定，不是某个写死
的数字）；② 每个块自己 `display:flex; align-items:center`，图标与文字各自在这同一高度里居中。
⚠️ 摘要要省略号，`text-overflow:ellipsis` 必须落在**内层 span** 上 —— flex 容器自己做不了 ellipsis。

⚠️⚠️ **flex 全做对之后还差 1.5px —— 那不是布局问题，是字体的，图标要补一次光学下移。**
量真实截图（读墨迹包围盒，1× 无缩放，13px 表头；量法与整套居中判定顺序见 skill `flex-centering`）：
标题「常驻服务」与副标题「1 个运行中」的墨迹中心都落在 y=48.0，图标的墨迹中心却在 y=46.5。
**几何居中不等于视觉居中**：汉字字面在行盒里天然偏下，而 svg 是按几何中心摆的，这 1.5px 无论
怎么调 flex 都补不回来。所以图标格与箭头格再加
`transform: translateY(0.115em)`（1.5px ÷ 13px —— 写成 em 才跟着字号走；用 `transform` 而不是
margin，纯视觉位移不参与布局，不会把等高的格子挤歪）。改完复量：图标 35.5 / 标题 35.0 /
副标题 35.0，残差 0.5px。dsh 自己没做这一步，它的 todo 条目有同样的偏移。

⚠️ 这个包在 Node 环境下 import 会因为它带 CSS 而失败，所以带它的浏览器半**不能**被
`environment: 'node'` 的单测直接 import（services 的 `tests/client.spec.ts` 头注已记）。

### 10.8 Connection RPC 通道的端点在 URL 路径里

出处：`packages/client/connection/src/rpc-host.ts:259-267`、`src/client/rpc.ts:34-53`

`ctx.connection.rpc.handle('/x', handler)` 注册的通道，浏览器必须 POST 到 **`/x/<endpoint>`**：
宿主用 `endpointFromPath` 从 `${channel}/${endpoint}` 解析，只打到 `/x` 一律 404；信封里的
`method` 还必须和路径段**一致**，否则报错。客户端 `rpc.call(channel, endpoint, payload)` 正是这么拼的。
（本项目的 `scripts/turn-retry-check.mjs` 第一版就栽在这里。）

### 10.9 ⚠️ 事后重试不能直接 `followup` 已有队列的 agent

出处：`packages/core/agent-loop/src/agent.ts:122-141,254-339`、
`packages/core/agent/src/inbox.ts:63-77`、`packages/api/session-controller/src/commands.ts:327-330`。

`followup(message)` 会把消息追加到 `nextTurn` 尾部并唤醒。新 turn 的首个
`claim('next-turn')` 先取光 `nextStep`，再取 `nextTurn` 的第一条。
因此失败后若已有排队消息，直接 `followup(retryNotice)` 会先把旧消息写成
`user/message` 并交给模型；这轮正常结束后，driver 还会继续排空余下队列。

dsh 没有公开的“只跑一轮但冻结现有队列”入口。turn-retry 的可靠做法是宿主 fail closed：
`nextTurn` 非空时返回 `pending-input`；不调用 `followup()`、不改 inbox、不产生 `turn/start`。
`nextStep` 属于插话/上下文，不是普通排队消息，仍按 dsh 原有语义进入下一次 pre-step。

## 11. 转录里的「执行过程」：dsh 自带的折叠，以及它为什么永远不出现（exec-process 插件的依据）

> 全部核实于 tag `dsh-v0.1.2-alpha.4`（`4e84901e64`）。

### 11.1 dsh 本来就有一个 turn 级的过程折叠

出处：`packages/client/ui-chat/src/client/conversation-nodes/turn-process.ts`、
`src/client/chat/TurnProcessNodeView.tsx`、`src/client/chat/ChatNodeSeat.tsx`

`ui-chat` 为每个 turn 投影一个 `turn-process` 节点，把「正式回答之前的全部过程行」折进一条细横线，
文案形如「调用 3 次工具 · 2 条消息」。三个组成部分各自独立：

| 部件 | 在哪 | 作用 |
|---|---|---|
| 投影 | `turn-process.ts` 的 `buildLocationData`（scope `turn`） | 把 `TurnProcessSpec` 发布成 **Turn Location 数据**：`processStartSeq` / `answerAnchorSeq` / `answerStep` / 三个计数 |
| 判定 | `ChatNodeSeat.tsx:62-81` | 由 `processWindowReady` 决定这一轮能不能折 |
| 隐藏 | `ChatNodeSeat.tsx:98-102` + `searchable-hidden.ts` | 给成员行的外层 div 打 `hidden="until-found"` |

### 11.2 ⚠️⚠️ 会话一长，这个折叠**全局失效**

出处：`ChatNodeSeat.tsx:62-68`（`processWindowReady` 含 `!historyIncomplete`）、
`ChatView.tsx:242`（`historyIncomplete = useSession(s => s.hasMore)`）、
`packages/api/session-controller/src/client/sessions/session.ts:47,601`（`PAGE_MESSAGES = 50`）、
`packages/api/session-controller/src/history.ts:318-343`（`paginate` 按 surface 消息计数）

会话窗口打开时只取**最近 50 条 surface 消息**（`user/message` + `assistant/message` + `tool/result`），
还有更早的就 `hasMore = true`。而 `processWindowReady` 要求 `!historyIncomplete`，
于是 **只要会话超过约 50 条 surface 消息，整个转录视图的折叠就被关掉**——
不是「这一轮不折」，是**每一轮都不折**，而且没有任何设置能把它打开，
只能一路点「加载更早的消息」直到历史见底。

实测（本仓库的一个普通工作会话，`~/.dsh/sessions/**/session.jsonl.zstd` 解出来数）：
1024 个事件里 **109 条 surface 消息**、3 个 turn、42 个 step、61 次工具调用 —— 早就越过阈值。
**结论：日常使用中 dsh 自带的过程折叠等于不存在。**

配套的两个前提（都比这条弱，但一起构成「能不能折」）：`turnClosed`（这一轮已结束）、
`answerAnchorSeq !== null`（这一轮有干净的正式回答；末条 assistant 消息不能带 tool-call）。
⚠️ 这两条是 **dsh 的** 判定，不是插件必须照抄的：仓库外插件完全可以在运行中就折，
见 §11.9。

### 11.3 但**投影本身不受影响**，这是插件的立足点

`historyIncomplete` 只出现在 `ChatNodeSeat`（**呈现**），不出现在 `turn-process.ts`（**投影**）。
所以 `turn.data.get('turn-process')` 在长会话里照样有值。
仓库外插件因此可以只借它的**窗口与边界**，自己负责呈现与隐藏，完全绕开那道门。

### 11.4 转录 DOM 上可依赖的标识

出处：`ChatNodeSeat.tsx:124-135`

每个消息行的外层 div 都带：`data-chat-flow-key`（= 节点 key，全局唯一）、
`data-chat-anchor-key`（同值）、`data-chat-flow-kind`（节点 kind）、`data-chat-turn`（turn 号）。
折叠一行的正确姿势是**注入一张按 `data-chat-flow-key` 命中的样式表**，
不要往 dsh 的节点上写属性：`useSearchableHidden` 会 set/remove 同一批 wrapper 的 `hidden`，
外部写属性等于和它抢同一个元素。

⚠️ **隐藏要用「零高度」而不是 `display:none`**：`ChatView.tsx:93-104` 用二分查找在有序行里找
「第一个 bottom 越过视口顶」的行来记录阅读位置，`display:none` 的全零 rect 会破坏这个有序性，
翻页后可能落回错误的位置；`height:0 + overflow:hidden + content-visibility:hidden` 既保持了
top 的单调，又跳过了隐藏子树的布局与绘制。另外列间距规则
（`ChatView.module.css:49-52`，特异度 0-7-0）必须用 `margin:0!important` 抵消，否则六十行隐藏行
会留下上千像素的空白。

### 11.5 `ChatSnapshot` 里能直接拿到的统计口径

出处：`packages/client/ui-chat/src/client/contract/snapshot.ts:92-99`、
`src/client/conversation-nodes/chat-snapshot-builder.ts:164-217`

- `locations.getTurn(turn)` 返回该 turn 的节点 key（有序）。**它的数组身份就是变更信号**：
  `MutableChatLocationIndex.touch` 在成员节点的**数据**变化（不只是增删）时故意换一个新数组，
  而其他 turn 的数组不动 —— 拿它当 `useMemo` 依赖，底部正在流式的一轮不会让上面四十行重算。
- `nodes.get(key)` 给出 `{kind, anchorSeq, data}`：`assistant-step` 的 `data.blocks` 里
  `kind:'reasoning'` 且 `text` 非空即一次「思考」；`tool-call` 的 `data.root` 有 `kind:'tool-result'`
  即已结束，`isError === true` 即失败；`model-retry` 的 `data.attempts.length` 即模型重试次数。
- 哪些行算「过程」：抄 `ChatNodeSeat` 的 `processMember` 与
  `TURN_PROCESS_INDEPENDENT_KINDS`（`contract/turn-process.ts:20-33`，未导出，只能复制），
  否则会把用户消息或正式回答一起折进去。

### 11.6 活体核实（在真实浏览器里跑真实会话读出来的，非推断）

用 CDP 驱动 Chrome、另起一个独立 dsh（临时 home + 复制进去的真实历史会话）实测，两条分支都走到了：

| 分支 | 观察 |
|---|---|
| `hasMore` 为真（长会话） | dsh 一行都没标 `data-turn-process-member`——它的折叠确实是死的；仓库外插件自己那套折叠正常工作 |
| `hasMore` 为假（历史加载完） | dsh 给 46 行打了 `data-turn-process-member`，但 `data-turn-process-hidden` 为 **0**——只要有人把它的 disclosure 置为 open，它就一行都不藏 |

另外两条对写插件有用的实测结论：

- **被影子覆盖掉的 keyed 条目，座位是真的空的**：dsh 的 `turn-process` 行只剩
  `<div class="…_flowItem" …><div data-slot="conversation.chat.node" style="display: contents;"></div></div>`，
  高度 0、无文字。注意它**不是** `:empty`，所以 `ChatView.module.css` 的
  `.flowItem:empty { display:none }` 不生效，列间距规则仍会把它算作一个前序兄弟。
- **主题变量确实会跟着走**：同一行在浅色下是 `--dsw-alias-label-secondary = rgb(97,102,107)` /
  `--dsw-alias-border-l2 = rgba(0,0,0,0.1)`，深色下是 `rgb(207,211,214)` / `rgba(255,255,255,0.12)`。
  写完客户端样式后，**核对「深浅两套 computed 值不同」就是 §8.6 那个坑最快的检查方式**——
  名字写错的话两套会是同一个硬编码兜底值。
- **改一次设置（例如切主题）会让浏览器半重新 apply 一次**：之后页面上各只有一张自己的
  `<style>`，说明 `ctx.effect` 的清理链是通的；但**插件里的模块级状态会被清掉**
  （本插件的折叠状态因此回到默认的「全部折起」）。别把不能丢的东西只放在模块级变量里。

### 11.7 ⚠️ 想让一行「吸顶」，`position: sticky` 必须写在 dsh 的行 wrapper 上——而且它自己不会松开

出处：`ChatNodeSeat.tsx:124-135`（每个节点都被包在一层 `.flowItem` 里）、
`ChatView.module.css:9-12,29-33`（滚动容器有两套布局）

sticky 元素**永远出不了自己的 containing block**。插件渲染的内容在 dsh 的
`.flowItem` 里面，而那个 wrapper 只有一行高——所以把 `position: sticky` 写在自己的按钮上
**完全无效**：实测往下滚 900px，按钮相对滚动容器的 `top` 是 **−900**，它跟着 wrapper 一起滚走了。

所以要 sticky 的是 **wrapper 自己**。但同一条规则也带来第二个问题：**containing block
既决定 sticky 从哪里开始，也决定它到哪里结束**。wrapper 的 containing block 是**整条消息列**，
不是它所概括的那一段——于是「吸顶」会一直吸到会话结束，早就越过自己的内容还赖在顶上。
浏览器给普通元素做的「推出」（containing block 底边把 sticky 顶走）在这里不会发生。

补回那段推出，只需要每帧发布一个数字：

```
push = clamp(滚动容器顶 + 行高 − 本段最后一行的底, 0, 行高)
```

行下面还有内容时这一项是负的、夹到 0，就是普通吸顶；最后一行的底边升过表头自己的底边之后，
`push` 与滚动**等速**增长，表头就以内容的速度滑出滚动容器顶端——和真正的 containing block
一模一样，所以**不需要任何过渡动画，也不会跳**。实测：每滚 1px 推出 1px，`top` 从 0 连续走到 −32。

⚠️ **公式里绝对不能读表头自己的位置**：把 sticky 元素的当前位置反馈进它自己的偏移量，
会「松开 → 量到自然位置 → 重新吸住 → 再松开」，每帧震荡一次。只读滚动容器顶和内容底。

⚠️ **偏移量没法直接写到 wrapper 上**（§11.4：不往 dsh 的节点写属性）。走法是绕一圈：
把值写成 `<html>` 上一个**每行一个**的自定义属性，再由插件自己的样式表里那条规则读它——
规则用 `data-chat-flow-key` 直接命中 wrapper：

```css
[data-chat-flow-key="12:exec-process:7"] {
  position: sticky;
  top: var(--dshx-exec-process-push-1, 0px);
  z-index: 3;
  background: var(--dsw-alias-bg-base, #fff);   /* 透明会让下面的内容穿过去 */
}
```

**每行一个属性，不能共用一个**：屏幕上可以同时有两段，一段已经推出去了、另一段还没吸住，
共用一个值会把第二段直接顶没。（早期版本用 `:has()` 从按钮状态反选 wrapper；按 key 直接命中
更简单，而且不支持 `:has()` 的浏览器也能吸顶。）

⚠️ **滚动容器要现找，不能写死类名**：`ChatView.module.css` 给 `.scroll` 自己的
`overflow-y: auto`，但在 `[data-conversation-scroll]` 下又把它交还给祖先。从 wrapper 往上找
第一个 `overflow-y` 是 `auto|scroll|overlay` 的祖先即可；找不到就退回视口顶。

⚠️ **消息流里做不出「内部滚动条」**：要折叠的那些行是 dsh 自己的**兄弟节点**，
CSS `overflow` 只裁剪后代，把它们套进一个容器就得搬动 React 拥有的节点——React 卸载或重排
那份列表时必然抛错。想解决「展开后找不到收起按钮」，sticky 是唯一不动 DOM 的办法。

### 11.8 正式回答自己那段「已思考」，是 dsh 折叠的一部分

出处：`AssistantNodeView.tsx:23-27`、`AssistantMarkdown.tsx:61-70,120-127`、
`ReasoningRow.tsx:32-35`、`turn-process.ts:158`（`inlineReasoning`）

dsh 的折叠**收起时会连正式回答里的思考块一起藏掉**：`reasoningHidden = foldable &&
spec.answerStep === data.step && spec.inlineReasoning && !open`。也就是说，那条
「已思考」在 dsh 的设计里属于**过程**，不属于回答。

但它同样挂在 `foldable` 上（§11.2），长会话里恒为假 —— 所以**在真实会话中，正式回答上方那个
「已思考」永远露在外面**，即使它上面就是一条已经收起的过程折叠。仓库外插件要自己藏：

- 思考行的根节点带 **`data-variant="think"`**（`ReasoningRow.tsx:33`，语义属性，不是哈希类名）；
  它外面还包着一层 `<div>`（`ProcessReasoning`），那层只有在 dsh 自己隐藏时才带
  `data-turn-process-inline`，平时是个裸 `div`，选不中。
- 这里**必须**用 `display:none`（与 §11.4 相反）：它是行**内部**的元素，不参与那份 rect 有序性；
  而且 dsh 助手正文是 `display:flex; gap:16px`（`AssistantMarkdown.module.css:17-21`），
  只有 `display:none` 才连那 16px 间距一起去掉。用 `div:has(> [data-variant="think"])` 命中外层，
  再补一条不带 `:has()` 的兜底规则（两条**分开写**，一条选择器失效只丢自己那条规则）。

### 11.9 想在**运行中**就折叠：Context 只有匹配到事件才会重建

出处：`packages/client/ui-conversation/src/client/conversation/assembler.ts:314-334`
（增量刷新只对 `dirtyByTarget` 里的 Context 调 `buildViewNode`）、
`turn-process.ts:251-258`（dsh 自己的 `publication` 写法）

dsh 只折**已结束**的 turn（`turnClosed`），插件如果要在运行中就折，有两件事必须做对：

1. **必须跟随 chunk 事件**（`assistant/chunk`、`chunkrow/*-chunks`）。turn 的
   `turn-process` 投影在第一条可见 chunk 时就有值了，但**自己的 Context 不匹配任何事件就不会重建**，
   于是那一行要等到第一个 `tool/call` 才出现——一段很长的思考流会先整页铺出来再突然折起。
   代价可以压到很低：`update` 原样返回 state、`buildViewNode` 原样返回上一个节点，
   每个 token 只花一次 `Map.get` 加几次比较。
2. **用 `publication` 把 chunk 事件降成 `animation-frame`**，durable 事件仍然 `immediate`
   （抄 dsh 自己的写法），否则每个 token 都会触发一次立即发布。

另外两点让「运行中折叠」是安全的：

- **审批卡和 `userQuestions` 都不在消息流里**，它们渲染在 `conversation.composer`
  （`packages/client/ui-approval`、`ui-user-questions`），折叠碰不到它们。
- **`turn-tail`（运行状态行）在 `TURN_PROCESS_INDEPENDENT_KINDS` 里**，天然不会被折走，
  所以折起来之后仍然看得到「正在运行」。

实测：一轮真实的 3 次工具调用，运行中那一行实时显示「执行过程 思考 1 次 · 工具调用 3 次 最近 pwsh」，
被折的 `assistant-step` / `tool-call` 行高度为 0，turn 结束后正式回答与 `turn-tail` 照常可见。

### 11.10 第八轮当前实现：结束态摘要与展开外框

出处：`packages/plugins/exec-process/src/client/ExecProcessRow.tsx`、
`packages/plugins/exec-process/src/client/stats.ts`、`packages/plugins/exec-process/src/client/locales.ts`、
`packages/plugins/exec-process/src/client/row-styles.ts`、`packages/plugins/exec-process/src/client/segment-frame.ts`；Todo 背景出处：
`packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css`。

当前摘要固定为「思考N次·工具M次·失败K」：没有失败就省略「失败K」，失败计数留在同一个
status 区域并使用同一颜色。segment 或 turn 结束后不再显示「最近动作」；进行中的 segment 仍显示
当前动作，呼吸点作为独立 flex 项紧邻在 chevron 左边。

⚠️ **结束判断必须同时看三类信号**：最终 `answerAnchorSeq` 已出现、timeline 的 Turn status 已为
`closed`、后续可见的 segment header 已出现。三者分别覆盖正常回答刚落地、没有最终回答的异常结束，
以及整个 turn 仍在进行时 turn 内前一段已经结束；少看任一类都会漏判相应场景。

第八轮初版中，展开标题背景复用 TodoPanel 的 `--dsw-specific-tip`；内容外框不包新容器，也不移动 React DOM，
`SegmentFrameController` 只维护一张运行时样式表，并用 `--dsw-alias-border-l1` 组成连续外框。边框 token
随后按反馈升级，见 §11.11。sticky 的终点也测量 inline reasoning 的同一个父 wrapper
（`div:has(> [data-variant="think"])`），而不是内部固定高度的
think 根节点，才能把外框 padding / border 的真实底边算进去。

### 11.11 第九轮反馈：连续 frame 使用更强边框与不透明 Todo 背景

出处：`packages/plugins/exec-process/src/client/segment-frame.ts`；token 定义与语义：
`packages/client/ui-theme/src/client/index.ts:137`、
`packages/client/ui-theme/src/styles/design-platform.css:173-174,245,265-266,337`；Todo 用法：
`packages/client/ui-conversation/src/client/skeleton/TodoPanel.module.css:24-25`。

`--dsw-alias-border-l1` 用在一整块展开内容的外轮廓时太淡；改用 dsh 明确定义为
“Secondary stronger border”的 `--dsw-alias-border-l2`，仍保持 0.5px，所以边界更清楚但不会变成重框。
fallback 使用中性 `rgba(128, 128, 128, 0.28)`，单独落地时在深浅底色上都可见；frame 样式不再使用
`border-l1`。

⚠️ **只换边框不够**：member rows 仍是 dsh 自己的 sibling wrapper，页面内容会从它们下面滚过；
如果 wrapper 没有背景，连续外框内部和 inline reasoning 都会透出底层内容。正确做法是在不移动 DOM 的前提下，
给每一个展开 member wrapper 与 `div:has(> [data-variant="think"])` 父 wrapper 都画
`background: var(--dsw-specific-tip, var(--dsw-alias-bg-base, #fff))`。这与展开标题、TodoPanel 使用同一
不透明表面；`--dsw-specific-tip` 在深浅主题各有定义，缺失时先回退到同样随主题变化的
`--dsw-alias-bg-base`。连续左右边、首尾封口与圆角、sticky 推出和折叠逻辑均保持不变。

### 11.12 ⚠️ 插件的 presentation-only 节点也会让原生分叉按钮失效

出处：`packages/client/ui-chat/src/client/chat/TurnTailNodeView.tsx:17-18,44-50`、
`packages/client/ui-chat/src/client/conversation-nodes/common.ts:8-20`、
`packages/plugins/exec-process/src/client/definition.ts`。

dsh 允许从完成轮次的 closing assistant 分叉，但还有一道纯 UI 防线：
`hasLaterChatNode = locations.getTurn(turn).at(-1) !== turnTail.key`。它不区分业务消息与插件节点，
只要 `turn-tail` 后面还有任何 Chat Node，按钮就显示“仅可从已完成轮次的最后一条消息分叉”。

exec-process 的 follow-on 段头最初放在正式消息 `+0.2`，而 dsh 把 max-tokens notice 放在 `+0.05`、
`turn-tail` 放在 `+0.1`。最终正式消息后的 follow-on 段即使没有过程内容、组件返回 `null`，
其 Node 仍在 Location 索引里，于是它排在 `turn-tail` 后面并把分叉按钮永久禁用。

修复原则不是绕过 dsh 的 guard，而是维护它明确要求的排序：插件段头改到 `+0.04`，形成
`formal < exec-process-step < max-tokens < turn-tail`。这样 presentation-only 节点仍在正式消息之后，
又保证 `turn-tail` 是正常完成轮次的最后节点；若确实存在后续工具、重试或 steering，dsh 原有保护仍会禁用分叉。

写消息流插件时要把“最后节点”视为跨插件契约：一个视觉上为空的 Node 也参与 Location 排序，
不能因为 React 组件最终返回 `null` 就当它不存在。

## 12. 「agent 停下来等人」这件事在宿主侧怎么观察（notify 插件的依据）

核实于 tag `dsh-v0.1.2-alpha.4`。

### 12.1 dsh 没有任何系统通知能力

`packages/**` 里搜 `Notification` 全部命中的是 JSON-RPC / ACP / MCP 的**通知帧**，
与桌面通知无关。唯一沾边的是 `packages/api/session-controller/src/client/sessions/manager.ts:886`
的 `syncCompletedNotifications`：给「跑完了但当时没被选中」的会话在侧边栏点一个小圆点，
**纯页面内**，且只帮得到已经在看页面的人。

⇒ 「任务完成后提醒我」这件事 dsh 一点都没做，插件是从零加的。

### 12.2 `agent/status → idle` 才是「真的停下来了」，`turn/end` 不是

出处：`packages/core/agent/src/runtime-types.ts:177-185`、`packages/core/agent-loop/src/agent.ts:108-120, 219-232`

```
'agent/status'(payload: { agent: Agent; status: 'idle' | 'running' })   // @mode emit
```

语义是「没有 driver 在跑，也没有排队的活」。**不要用 `turn/end` 当完成信号**：
`kick()` 是 `while (await this.turn()) {}`，一轮结束时 inbox 里还有消息就立刻再开一轮，
于是一次「用户视角的任务」会打出好几个 `turn/end`。

两条实现上必须知道的时序：

1. **`turn/end` 一定先于 `agent/status → idle`**。`turn()` 在自己的 `finally` 里 append
   `turn/end`（`agent.ts:328`），而 idle 相位是在**包着它的** `kick()` 的 `finally` 里设的
   （`agent.ts:228`）。所以在收到 idle 时去读「上一轮怎么结束的」一定读得到。
2. ⚠️ **idle 之后可能同步地又变回 running**：`agent.ts:229` 是
   `if (wakeRequested && this.inbox.hasPending) this.wakeDriver()`，就在 `setPhase(idle)` 的下一行。
   所以「进入 idle 就通知」会宣布一件还在进行的工作结束了 —— 必须**去抖**（本插件 700ms），
   而且到点后要**再读一次 `agent.status`**。

`status` 的 getter 把 `maintenance` 相位也算作 `idle`（`agent.ts:108-110`），
但 `setPhase` 只在字符串真的变了时才发事件，所以维护任务不会多打一次。

### 12.3 审批与提问是**瀑布**，观察者必须 `prepend`

出处：`packages/interaction/user-approval/src/types.ts:76-90`、
`packages/interaction/user-questions/src/types.ts:76-90`

```
'approval/request'(req, next): Promise<ApprovalOutcome>          // @mode waterfall
'user-questions/request'(request, next): Promise<AskUserQuestionAnswer>  // @mode waterfall
```

⚠️ **认领请求的应答者不调 `next()`**（浏览器那半就是这样应答的），所以**排在应答者后面的
监听器根本不会被调用**。想做观察者必须 `ctx.on(..., { prepend: true })`
（选项形态见 `user-approval/tests/approval.spec.ts:437`），进来就 `await next()` 原样放行。

⚠️ 这两个事件**不代表「屏幕上出现了卡片」**：

- 权限预设**不是**这个瀑布上的应答者（`permission-presets/src/index.ts` 里没有
  `approval/request` 监听器），它只写 `approval/policy`（只有 `'ask' | 'never'` 两个值）。
- `'never'` 在**派发之前**就决定了（`user-approval/src/index.ts:266`），根本不进瀑布。
- 但 `approval.request()` 无论如何都会 append `approval/asked` + `approval/decided`
  这对审计事件（`index.ts:217-225`），**所以靠 `approval/asked` 判断「有人在等」会误报**。

⇒ 判断「这次审批真的落到人身上了」的可靠办法不是看事件，而是**看它悬了多久**：
进瀑布时挂一个定时器，`next()` 回来就撤销；几秒后还没回来的，才是真的有张卡片在等人。

### 12.4 会话的工作目录在 `session.header`，不在事件日志里

出处：`packages/core/session/src/types.ts:92-130`（`SessionHeader.cwd`）、
`packages/core/session/lib/types/index.d.ts:110-118`

`Session` 上是 **`header`**（不是 `meta`；`meta` 只是 `CreateSessionOptions` 的入参名）。
它是 detached、deep-frozen 的存储元数据，刻意不进可重放的会话状态。

会话标题走投影：`ctx.sessionProjections.stateOf(session, 'title')`，
由 `packages/session/session-title/src/index.ts:263-275` 注册，值是最后一个
`session/title` 事件的文本或 `null`。⚠️ 标题是 turn 结束**之后**才异步生成的，
所以一个新会话的第一条完成通知**必然没有标题**。

### 12.5 Windows toast：能弹，但静默失败是常态

`Windows.UI.Notifications` 经 Windows PowerShell 5.1 投影即可用，`scenario=reminder`
让通知常驻直到手动关闭（该场景**要求至少一个 action**，所以必须补一个「关闭」按钮）。

⚠️ **未注册 AUMID 的 AppID 可以被 API 接受却什么都不显示**，宿主侧完全观察不到。
本机实测（Windows，2026-09）：自定义 AppID 与 PowerShell 自己的 AUMID **两条都真的弹出来了**，
但这不是契约。⇒ 设置页必须有一个「发一条测试通知」按钮，那是唯一诚实的验证方式。

实现上不要把文案插进脚本里（pi 的那份扩展是这么做的，靠把单引号翻倍来转义）：
会话标题是模型写的、工具名是别人注册的，**用环境变量传文本**可以让脚本变成一个常量，
既没有转义函数可写错，`CreateTextNode` 又把 XML 转义包了。

## 13. 常驻进程、插件自定义会话事件、以及工具表的可观察性（services 插件的依据）

核实于 `dsh-v0.1.2-alpha.4`（`4e84901e64`）。

### 13.1 dsh 自带的后台任务**刻意**活不过会话

dsh 有完整的后台任务运行时：`bash` / `pwsh` 的 `run_in_background` 注册进 `ctx.jobs`，
由 `job_list` / `job_output` / `job_kill` 收集与停止（`docs/subsystems/jobs.md`）。
但它的生命周期是绑在 owner 上的：

- `JobStart.owner` 的契约原文：「**agent disposal cancels and awaits the job**」
  （`packages/jobs/jobs/src/types.ts`）。
- 不带 owner 的任务活到 service disposal 为止，也就是 dsh 进程结束。
- shell 执行器那条线同样：「A still-running background process is stopped and awaited when its
  owning composition tears down」（`docs/subsystems/shell.md:242`）。

⚠️ **所以「常驻」在 dsh 里没有现成的东西可用**：`pnpm dev` 用 `run_in_background` 起，
换个会话或重启 dsh 就没了，而且 dsh 里没有任何机制给长期进程**起名字**以便回头找到它。
`packages/plugins/services` 因此走 detached + 落盘注册表，而不是复用 `ctx.jobs`。

### 13.2 ⚠️⚠️ 插件**不能**往会话日志里 append 自己的事件类型

这是本轮最重要的一条，写错的代价是**用户的会话永久打不开**。

- 持久化读路径会拒绝任何类型不在构建期常量 `KNOWN_SESSION_EVENT_TYPES` 里的事件，
  **除非**该事件带 `ignorable: true` 标记
  （`packages/session/session-persistence/src/coordinator.ts:1248-1253`，
  常量在 `packages/core/session/src/known-event-types.ts`）。
- 那个常量是 dsh **自己仓库里**声明过的全部事件，注释明说
  「Downstream (out-of-repo) plugin events are outside this list by construction」。
- 而 **`Session.append()` 根本没有设置 `ignorable` 的参数**
  （签名见 `packages/core/session/src/index.ts:668-672`：只有 `type`、`data`、
  以及 surface 事件的 `SurfaceIntent`）。全仓库搜 `ignorable: true`，**只出现在测试里**
  （构造原始事件对象 / seed），没有任何生产代码路径能写出它。

结论：`ignorable` 目前是给**未来版本的 dsh** 用的前向兼容字段，插件用不上。
外部插件 append 一个自定义类型 ⇒ 该会话此后 `assertEventsSupported` 必抛
`SessionFormatUnsupportedError` ⇒ **永远加载不了**。

⚠️ 连带结论：**插件想做 session projection，只能折叠 dsh 已有的事件类型**
（`tool/call`、`tool/result`、`turn/end` …）。`turn-retry` 折 `turn/end` 是合法的；
「为我的插件发明一个事件再折它」不合法。

### 13.3 Host→Client 只有 session projection 一条推送通道

- `ctx.connection.rpc` 是**单向请求/应答**：`ClientConnectionRpc.call` 是 Client→Host，
  `open`（流）在浏览器传输里**不提供**（`packages/client/connection/src/rpc.ts:224-238`
  原文：「Browser transports omit this method」）。
- `capability-seams.md:504` 里，把宿主计算值推给页面的只有 `ctx.sessionProjections`
  （「the Session controller serves baselines and pushes changed values」）。

所以**非会话范围的宿主状态**（比如一份全局服务表）想上页面，只有轮询。
`services` 插件因此在浏览器半轮询，并且 §13.2 让 projection 那条路本来也走不通。

### 13.4 dsh 没有把工具表暴露成 API

`packages/api/**` 里搜不到 `tools.describe` 之类的方法。这意味着
**「某个工具真的注册进模型看得见的那张表了吗」从进程外观察不到**。
冒烟脚本要验这件事，只能把构建产物 `import` 进来跑一遍 `apply()`
（`scripts/services-check.mjs`）——「dsh 能启动」只证明 `ctx.tools.register` 没抛错
（重名会抛），证明不了注册的是哪几个、schema 转成了什么样。

### 13.5 ⚠️ 自己 spawn 就绕过了沙箱，而 web profile 的沙箱是真的

- web profile 挂的是 `@deepseek-ai/dsh-pwsh-sandbox`（`docs/reference/web-profile.yml:98`），
  它「wraps the exact local pwsh argv through `ctx.sandbox`，which **on Windows resolves to the
  ACL restricted-token runner chain**」（`packages/shell/pwsh-sandbox/src/index.ts:1-11`）。
- 权限预设写的是 `sandbox/mode` + `approval/policy` 两个旋钮
  （`packages/interaction/permission-presets/src/index.ts`），**不做逐工具拦截**。
- 逐工具拦截的通用接缝是 `tools/pre-execute` 瀑布（`packages/core/tools/src/index.ts:144`），
  任何用 `ctx.tools.register` 注册的工具都会照常流过它（hooks、策略插件因此自动生效）。
- 每次调用的模式用 `ctx.sandboxPolicy.resolve({ session })` 取
  （`packages/sandbox/sandbox-policy/src/index.ts:163-167`）。
- `ctx.approval.request()` 的结局是 `'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'`，
  **只有 `allowed-once` 是放行**，`unavailable` 是文档写明的 fail-closed 值；
  `never` 策略在派发前就返回 `rejected`（`packages/interaction/user-approval/src/index.ts:266`）。

所以用 `node:child_process` 直接起进程的插件，**必须自己补一道门**，否则用户选了
`read-only` / `workspace-write` 却有一个工具能逃出去且不被告知。

### 13.6 dsh 跑 pwsh 的确切 argv（照抄它，尤其 `-NoProfile`）

`pwsh -NoLogo -NoProfile -NonInteractive -Command <ENCODING_PREAMBLE><command>`
（`packages/shell/pwsh-local/src/index.ts:220`），环境再叠
`NO_COLOR=1 / PAGER=cat / GIT_PAGER=cat`（同文件 `ENV_OVERRIDES`）。

⚠️ **`-NoProfile` 不是讲究，是必需**：本机实测，不加它时用户的 PowerShell profile 会先执行，
把一段多行 `Set-PSReadLineOption` 报错写进日志**再**才轮到命令 —— 对一个靠日志判断就绪的
插件来说，这意味着每份日志都带噪音、就绪正则可能匹配错，而一个会提问或很慢的 profile
会让服务根本起不来。`ENCODING_PREAMBLE` 则是防 Windows PowerShell 5.1 回退时中文变乱码。

### 13.7 ⚠️ `dsh-remote-web` profile 没有 HMR：改完插件**必须重启 dsh**，刷新页面没用

实测（2026-09-04）：改完插件重新 `pnpm build` 后，宿主半**没有**重新加载 —— 新起的服务
仍然走旧代码的路径。核实原因：

- `<DSH_HOME>/profiles/dsh-remote-web/cordis.yml` 里**没有任何 hmr 行**（`dsh-client-hmr` /
  `cordis-plugin-hmr` 都没挂），而 launcher 与 `pnpm dev` 都用这个 profile。
- 浏览器半同样不行，而且**刷新页面也没用**：客户端模块注册表在注册时就
  `readFileSync(clientPath)` 把字节读成不可变快照、并以 `IMMUTABLE_CACHE` 下发
  （`packages/client/modules/src/index.ts:872-884, 968, 1015`）；**只有 `rebuilt(id)` 会重新读盘**
  （`:630-637`），而**调用它的只有 HMR 的 watch 回调**。没有 HMR 行 ⇒ 没人调 ⇒ 刷新拿到的
  仍是启动时那份字节。

⚠️ 所以 `docs/05-roadmap.md` 里 proxy 那条「这次正是我重新构建 `dist/index.js` 触发了热重载」
**不适用于当前的启动方式**（那多半发生在挂过 hmr 的环境里）。当前结论是：

> **插件的任何一半改动都要重启 dsh 才生效。改样式也一样 —— 不要让用户白刷新一次页面。**

（反过来它正好证明了 services 插件的价值：dsh 重启后，`.agents/services.json` 里那些 detached
服务**照样活着**，`service_list` 靠 pid + 创建时间比对把它们原样认回来 —— 前提是先修好 §13.8。）

### 13.8 ⚠️⚠️ Windows：`detached: true` **挡不住 `taskkill /T`**，两级启动器才行

上面 §13.7 那句「dsh 重启后服务照样活着」第一版是**假的**，用户实机一重启就暴露了：
服务连同 dsh 一起没了，日志里 vite 正常启动、没有任何报错就消失。

**根因**（`node:child_process` 的 Windows 语义，与 dsh 无关，但被我们自己的停止方式触发）：

- launcher 停 dsh 用的是 `taskkill /pid <dsh> /T /F`
  （`packages/launcher/src/supervisor.ts:76`、`scripts/dev-stack.mjs:136`）。
- `/T` 是**按记录的父 pid 递归**杀整棵树。而 Windows 的 `DETACHED_PROCESS`
  （Node 的 `detached: true`）只解除**控制台**，**不清除父 pid 字段** —— 所以「detached 的
  服务」在进程表里仍然是 dsh 的直接子进程，`/T` 一路走下来照杀不误。

**两条实测约束把所有单进程解法都堵死了**（都用一个「假 dsh + taskkill /T」的探针验过）：

1. **孙进程不能 detach**：没有 console 的 **pwsh 会立刻退出且不输出任何东西**，日志全空 ——
   而日志是这个插件存在的意义。（这与 §13.6 那条「pwsh 需要 console」是同一件事。）
2. **启动器不能直接退出**：Windows 上**非 detached 的子进程活不过父进程退出**
   （Node 文档对 `detached` 的措辞就是「makes it possible for the child process to continue
   running after the parent exits」）。实测启动器一 `process.exit(0)`，shell 立刻陪葬。

**解法：两级启动器。**

```
dsh → L1(node, detached, 起完 L2 立刻 exit) → L2(node, detached, 常驻) → pwsh(普通子进程)
```

- L1 退出 ⇒ L2 的父 pid 指向一个**已经不存在的进程** ⇒ 从 dsh 出发的 `/T` 枚举不到它。
- L2 是 node，**不需要 console**，所以 detach 它没有代价；pwsh 作为 L2 的普通子进程
  仍然拿得到 console，日志正常。
- 注册表记的是 **L2 的 pid**（L2 经 sidecar 文件把自己的 pid 交回来）：L2 在 shell 退出时
  才退出，所以「L2 活着」就等于「服务活着」，`killTree(L2)` 也正好带走 shell 及其全部后代。
  ⚠️ **不能记 L1 的 pid** —— 它几毫秒后就没了，`identify()` 会一律报 `gone`。

回归测试锁死这条：`tests/live.spec.ts` 会起一个子进程、由它启动服务，再对**这个子进程**
`taskkill /T /F`，然后断言服务仍然存活且仍被注册表认得。

## 14. dsh 自带的 PTY 终端，以及它为什么在 web profile 里不存在（terminal 插件的依据）

> 核实于 tag `dsh-v0.1.2-alpha.4`（`4e84901e64`）。

### 14.1 dsh **有**一整套持久 PTY 终端

| 层 | 包 / 文件 | 作用 |
|---|---|---|
| 底层 | `packages/subprocess/subprocess-local`（`node-pty@1.2.0-beta.15`） | `spawnTerminal()` 真 PTY；六个平台的**预编译产物随包**，无需编译 |
| 注册表 | `packages/terminal/terminal`（`ctx.terminals`） | 按 Agent 归属的会话表：`spawn` / `startSend` / `read` / `signal` / `kill` / `list` |
| 后端 | `packages/terminal/terminal-bash` | 真交互 shell，`shellDialect` 在 **bash / pwsh** 之间切换 |
| 工具 | `packages/terminal/tool-terminal` | 六个上游模型工具 `terminal_open/send/read/signal/close/list` |

三个包都是**已发布的公开 npm 包**（`0.1.2-alpha.4`，peerDependencies 只有 cordis / agent /
brand / session 等），可以从外部 overlay 或插件挂载。

`packages/plugins/terminal` **不把这些上游名字原样暴露给模型**。它用 fail-closed wrapper
包住上游工具包的 `apply()`：只接受预期的六次注册，再改名为
`interactive_terminal_open/send/read/signal/close/list`；缺少、重复或出现未知注册时整组失败，
不会泄漏或回退到裸 `terminal_*`。因此，上游名称仍是 `terminal_*`，本插件对外只有六个
`interactive_terminal_*`。

使用边界也严格锁定：仅在需要**交互式 stdin**，或需要同一个终端的状态跨调用保留时使用。
普通一次性命令（包括 Git、构建、测试、脚本）都用 `pwsh` / `bash`；运行时间长本身不是理由，需要时用 `run_in_background`。

### 14.2 但 web profile 一行都没挂

`packages/bundle/base/cordis.patch.yml:205` 挂了 `@deepseek-ai/dsh-subprocess-local`
（所以 `spawnTerminal` 与 node-pty 本来就在进程里），但 `base` 与 `web-app` 两个 patch 里
`dsh-terminal` / `dsh-terminal-bash` / `dsh-tool-terminal` **零出现**。只有
`packages/bundle/sdk-minimal/cordis.patch.yml:51-63` 与
`packages/preset/agent-presets/presets/minimal/agent.cordis.yml:21-70` 挂了它们
（后者还包在 `isolate: { terminals: true }` 里）。`standard` / `ptc` / `cordis` 三个预设都没有。

### 14.3 ⚠️ overlay 里的**裸包名**解析到 profile 目录，不是 overlay 目录

想用 `--patch` 加一行 `name: '@deepseek-ai/dsh-terminal'` 会**启动即失败**：

```
failed to import loader entry tool-terminal (@deepseek-ai/dsh-tool-terminal):
Cannot find package '@deepseek-ai/dsh-tool-terminal' imported from
<DSH_HOME>\profiles\dsh-remote-web\
```

即 loader 用 **profile 目录**做解析基准（那正是 `dsh plugin add` 装包的地方），
既不是 dsh 的安装位置，也不是 overlay 文件所在目录。overlay 里只有 `./` 开头的名字会被
锚定到本文件旁边（D17）。**结论**：想从本仓库挂 dsh 自己的包，把它们写成插件包的普通
`dependencies`，在宿主半用 `ctx.plugin()` 挂载；工作区是 `nodeLinker: hoisted`，全树一份
cordis，`Service` 基类同一性没问题。

### 14.4 `ctx.terminals` 的三条硬语义

1. **归属按对象同一性比较**，不是按 id：`record.owner !== owner` 直接 `FOREIGN_SESSION`
   （`packages/terminal/terminal/src/index.ts:390`），且 `isLiveOwner` 还要求
   `ctx.agents.get(owner.id) === owner`。重建过的 Agent 就是另一个人。
2. **同一会话同时只允许一次发送**，第二次**同步抛** `TerminalError(..., 'SEND_ACTIVE')`
   （`:246`）—— 不排队、不返回 rejected promise。
3. `startSend({ text, submit })` 里 **`submit` 只追加一个 `\r`**
   （`terminal-bash/src/session.ts:314`），`text` 原样写入且不做任何转义，
   所以 `\x03`（Ctrl-C）、`\x1b[A`（上箭头）这类裸字节都从 `text` 走。
   `{ text: '', submit: false }` 什么都不写。

### 14.5 三个 PTY 包**不发布任何可被浏览器观察的东西**

它们不注册 session projection、不 emit 事件、不往会话日志 append（全仓库搜
`projection|emit|session.append` 在这三个包的 `src/` 下只命中一处**只读**的
`sessionProjections.stateOf`）。唯一会到浏览器的是上游 `terminal_send(run_in_background)`
经 `ctx.jobs` 产生的通用任务帧，而那只有状态和标签、**没有终端输出**。
所以想在页面上看终端画面，只能轮询（§13.3 那条「插件不能 append 自己的事件类型」在这里同样成立）。

### 14.6 ⚠️⚠️ Windows 上 PSReadLine 会让 pwsh 终端**随机开不出来**

`terminal-bash` 判断 pwsh 就绪的方式是：写一句安装提示符的语句，等着看见自己的私有标记
后面跟着恰好是提示符的可打印尾巴。dsh 的提示符函数用 `[Console]::Write` 发标记、用
**函数返回值**发提示符文字，两者走不同的路离开 pwsh；PSReadLine 持续重绘输入行会把它们
**乱序**。抓到的原始字节里标记落在了下一条命令的回显之后，而启动循环之后只用**空**发送重试，
于是开局乱序的会话再也回不来，最终 `PTY shell did not reach readiness before startup timeout`。

PSReadLine 还让它**越用越坏**：每条命令都会被写进用户真正的
`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`
（dsh 自己那句 bootstrap 也在内），下次行内预测把它当幽灵文字补出来，回显再次对不上。
本机表现是「当天第一次成功，之后每次都失败」。

同机、间隔 500ms、其余一致的实测：

| pwsh argv | 开终端成功率 | 典型耗时 |
|---|---|---|
| dsh 默认 `-NoLogo -NoProfile` | 7/10 | 520ms |
| 加 `-NoExit -Command "Remove-Module PSReadLine -Force -ErrorAction SilentlyContinue"` | **20/20** | 460ms |

`terminal-bash` 的 `shellArgs` 是配置项，所以这可以从插件侧修，不用碰 dsh 源码
（`packages/plugins/terminal` 已经这么做了）。**升级 dsh 后要复核这一条**：
如果上游改了提示符函数或就绪判据，这段修补可能变成多余、也可能变成有害。

### 14.7 `terminal-bash` 的 shell 是被 dsh 自己沙箱化的

`spawnArgv()` 在 `policy.mode !== 'danger-full-access'` 时走 `ctx.sandbox.confine(argv, policy)`
再启动（`terminal-bash/lib/index.js`，对应源码 `src/index.ts`）。所以**消费 `ctx.terminals`
的插件不需要像 `services` 那样自建批准门** —— 受限预设下开出来的终端与 dsh 自己的
`bash` / `pwsh` 工具受同一套约束。反过来，`danger-full-access` 下它就是一个不受限的 shell。

### 14.8 `terminal-bash` 的默认值（抄配置时对照用）

`backendType: 'shell'`、`rows: 40`、`cols: 160`、`scrollbackLines: 10000`、
`scrollbackMaxBytes: 4MiB`、`maxReadBytes: 256KiB`、`timeoutMs: 30000`
（**同时**是一次发送和整个 pwsh 启动的绝对上限 —— 想给启动单独设界，只能自己往
`spawn(owner, request, signal)` 传 AbortSignal）；bash 默认
`/bin/bash --noprofile --norc -i`，pwsh 默认 `<resolved> -NoLogo -NoProfile`。
`read({offset, count})` 的 `offset` 是**从最新一行往回数**，`count` 默认 500。

## 15. 工具注册表：进程内可读，且 dsh **没有** deferred tool loading（tools-inspector 插件的依据）

核实于 `dsh-v0.1.2-alpha.4` / `4e84901e64`。与 §13.4 互补：那条讲的是**进程外**没有 API，
这一节讲**进程内**（插件宿主半）能读到什么。

### 15.1 `ctx.tools` 的公开面

`packages/core/tools/src/index.ts` 的 `ToolRuntime` 对插件公开：

| 成员 | 位置 | 用途 |
|---|---|---|
| `schemas(scope?)` | :1225 | 返回该 scope 可见工具的 `{name, description, parameters}`（深拷贝） |
| `get(name, scope?)` | :1195 | 取一个可见定义 |
| `register(def)` | :1028 | 注册，返回 disposer |
| `restrict({allow,deny})` | :1062 | **仅 scoped**，全局调用抛错 |
| `guard(fn)` | :1101 | 单调拒绝，不改变可见性 |

`schemas()` 只投影 name / description / parameters 三个字段（`schemaOf`，:1247），
`timeoutMs`、`isConcurrencySafe`、`presentCall` 等**永远不出现**在返回值里。

### 15.2 ⚠️ dsh **没有** deferred / dynamic tool loading

对照 pi-coding-agent：它有 `pi.getActiveTools()` / `pi.setActiveTools()`，形成
「注册集 ⊃ 激活集」双层模型，**只增不减**以保住 prompt 缓存前缀
（实例见 `D:\dev\custom-skill\extensions\services\core.ts:509-524`）。

**dsh 没有这一层**，三条证据：

1. 全仓库搜 `setActiveTools|getActiveTools|activeTools` → **零命中**。
2. `view(scope)`（:1143-1184）只算出**一个** `visible` 集合，由四件事决定：
   层叠继承 → `restrict` 交集 → 本 scope 同名影子覆盖 → ptc 塌缩。
   它直接喂给 `wireSchemas()`（:972）→ `SystemPrompt.assemble()`（`core/system-prompt/src/index.ts:598`）。
   **注册即可见**，中间没有「已注册但未激活」的档位。
3. dsh 每轮请求都重新 `assemble()`（`core/agent-loop/src/agent.ts:239`），
   工具按 `toolOrder` 或字典序**整体重排**（`orderTools`，`system-prompt/src/index.ts:205-218`），
   压根没把工具集当成需要保护的稳定缓存前缀 —— 也就没有做增量加载的动机。

> ⚠️ `llm-pi-ai/src/catalog.ts:240` 那个 `deferredToolsMode: 'withhold'` **不是**这回事：
> 它是 OpenAI-completions 协议兼容位的 disposition 表项，且值为 `withhold`（不向下游透出）。
> 别把它当成 dsh 支持 deferred loading 的证据。

### 15.3 最接近的是 `restrict()`，但语义不同，别混为一谈

| | pi 的 defer | dsh 的 `restrict` |
|---|---|---|
| 方向 | 只增不减（减了废缓存） | 可增可减 |
| 谁触发 | **模型**调工具触发加载 | **代码**在 scope 创建时设定 |
| 目的 | 省 token / 保缓存 | 权限隔离（子 agent 减能力） |

实际用处集中在子 agent 创建窗口（`packages/subagent/subagent/src/child-agent.ts:217`），
不是会话中途按需放行。**观察类插件不要用 `restrict` 去伪造 defer**——那会改变 agent 行为。

### 15.4 ⚠️⚠️ 调用历史**能**从会话日志回放出来（这一节曾经写错过）

**先前这里写的是「计数只能靠事件累计，只覆盖本次进程运行」—— 那是错的**，
而且错得很显眼：用户重启 dsh 后看到「全部未使用」，一眼就发现了。实际情况：

- `tool/call` 是 dsh 的**持久化会话事件**，在构建期常量 `KNOWN_SESSION_EVENT_TYPES` 里
  （`packages/core/session/src/known-event-types.ts:66`），
  且 data **自带 `name`**（`session/src/types.ts:306`）—— 工具名就在日志里躺着。
- `session.snapshotEvents(from?, to?)`（`session/src/index.ts:600`）返回整段日志的不可变快照；
  `ownEvents()`（:615）是去掉 fork 继承前缀的版本。
- 从宿主插件拿到会话：`ctx.agents.get(sessionId)?.session`。

**混淆点在 §13.2**：那条说的是「插件不能 **append** 自己的**新事件类型**」，
与「能不能 **读** dsh 自己的事件」是两码事 —— **读完全可以**。
凡是需要「这个会话历史上发生过什么」的插件，都应该回放日志，而不是在内存里累加；
后者重启即归零。

配对规则：`tool/call` 带 `callId` + `name`；`tool/result` 只带可选的 `error`，
它的 callId 在 `message.source.callId` 与 `message.content[0].toolCallId`
**两个等价位置**（`llm/src/message.ts:235,238` 同时写入）。所以失败数必须靠 callId
回填到 call 认领的名字上；配不上对的（日志截断 / fork 前缀只剩一半）应当安全忽略，
数不出名字的失败宁可不算，也不要归到错误的工具头上。

> `tools/result`（tools/src/index.ts:189）与 `tools/change`（:199）这两个**运行时**事件仍然存在，
> 适合做「实时反应」，但**不是**历史统计的正确来源。

### 15.5 会话头部的视图切换栏是一个 list 槽，可以直接加 tab

`conversation.view`：`{ kind: 'list', scope: 'session' }`
（`packages/client/ui-conversation/src/client/contract/slots.ts:117`）。
`ui-conversation` 把每个条目投影成一个 tab（`client/apply.ts:121-132`），
`label` 传**thunk** 才能跟随语言切换而不用重新注册。
现成范本是 `ui-trajectory`（`src/client/index.ts:77-106`），加一个 tab 约 20 行，**不用碰 dsh 源码**。

## 16. 技能目录与「已加载」：两者都能在进程内读到（skills-inspector 插件的依据）

> 核实于 `git 4e84901e64` / tag `dsh-v0.1.2-alpha.4`。

### 16.1 `ctx.skills` 是一个分层注册表，`list()` / `snapshot()` 直接可读

`packages/skill/skill/src/index.ts` 的 `SkillRegistry`：

| 方法 | 作用 |
|---|---|
| `list(options)` | 返回排好序的 `SkillSummary[]`（:472） |
| `snapshot(options)` | 同上，**外加 `complete`**：有 provider 中途失败时为 false（:483） |
| `get(name, options)` | 加载完整 `SkillDefinition`，**含 `content` 与 `path`**（:502） |

`options` 是 `SkillViewOptions`：`{ cwd?, scope?, signal? }`（:118）。

⚠️ **优先用 `snapshot()` 而不是 `list()`**：provider 失败时 `list()` 只是安静地少几个技能
（失败被 `logger.warn` 吞掉，:609），页面会显示成「技能凭空消失」。`complete: false` 才让
UI 有机会如实说明「这份列表可能不全」。

### 16.2 ⚠️ scope 必须传 `ctx.agents.get(sessionId)`——与 §15.3 同一个坑

分层规则与工具注册表完全一致（:347-357）：**global 层 + scope 链**，近的覆盖远的。
agent preset 挂的技能 provider 落在**每会话层**，所以不传 `scope` 只读得到全局层。

实测（`scripts/skills-inspector-check.mjs`）：对一个没有活 agent 的 sessionId 查询，
**全局层技能数为 0**——项目的 `.agents/skills` 一个都读不到。

dsh 自己的 `skill` 工具就是这么查的：

```ts
// packages/skill/tool-skill/src/index.ts:133
const lookup = { cwd: exec.agent?.session.header.cwd, signal: exec.signal, scope: exec.agent }
```

`cwd` 同样不能省：项目级技能根是 `cwd` 解析出来的（下一条）。

### 16.3 「全局还是项目级」有权威答案：`SkillSummary.source`

不需要按路径猜。`skill-filesystem/src/index.ts:246-258` 写死了根目录与来源桶，
**rank 越小优先级越高**（同名技能谁赢）：

| `source` | 根目录 | 层级 |
|---|---|---|
| `project-dsh` | `<projectRoot>/.dsh/skills` | 项目 |
| `project-agents` | `<projectRoot>/.agents/skills` | 项目 |
| `custom` | 配置指定的目录 | — |
| `user-dsh` | `<dshHome>/skills` | 全局 |
| `user-agents` | `<agentsHome>/skills` | 全局 |
| `bundled` | dsh 自带 | 内置 |
| `runtime` | `ctx.skills.register()` 注册的 | 插件 |

⚠️ `SkillSource` 是**开放联合**（`… | (string & {})`，:40）：第三方 provider 可以给出
任意字符串，消费方不能穷举断言，必须有「未知来源」兜底。

### 16.4 ⚠️ `list()` 投影掉了 `path`，精确文件路径只有 `get()` 给

- `SkillCandidate` 有 `path`（:81），`skill-filesystem` 填的是
  `<技能目录>/SKILL.md` 或单文件 `.md`（:725,742）。
- 但 `toSummary()`（:771）**只抄 7 个字段**，`path` 不在其中 —— `list()` 的结果拿不到文件。
- `SkillSummary` 上只有 `resourceBase: { kind: 'directory', path }`，那是技能**目录**。
- `get()` 返回的 `SkillDefinition` 才带 `path`（:91），**代价是连带读进整个正文**。

实测确认（冒烟脚本对着真注册表验）：

```
list() → resourceBase.path = D:\dev\dsh-remote\.agents\skills\dsh-source
get()  → path              = D:\dev\dsh-remote\.agents\skills\dsh-source\SKILL.md
```

所以「点击某个技能打开它的本地文件」必须是**点击时**才调 `get()` 的独立操作，
不能在列出列表时批量取路径。

### 16.5 ⚠️⚠️「agent 已加载了哪些技能」可以精确回放，且覆盖整个会话历史

dsh 有且只有**两条**把技能正文注入上下文的路径，**两条都留下持久化会话事件**：

| 路径 | 事件 | 技能名在哪 | 出处 |
|---|---|---|---|
| 模型自己加载 | `tool/call`，`data.name === 'skill'` | `data.arguments` 里 | `tool-skill/src/index.ts:127-156` |
| 用户 `/技能名` | `user/message`，`source.kind === 'skill-invocation'` | `source.name` | 同文件 `:177-204` |

两个事件类型都在 `KNOWN_SESSION_EVENT_TYPES` 里（`session/src/known-event-types.ts:66,72`），
`session.snapshotEvents()` 给出整段不可变日志 —— **dsh 重启后统计依然准确**。

⚠️ 再强调一次 §13.2 那个混淆点：它说的是「插件不能 **append** 自己的**新事件类型**」，
与「能不能 **读** dsh 自己的事件」是两码事。**读完全可以。**

#### ⚠️ `tool/call.arguments` 是模型原样产出的**未解析字符串**

```ts
// session/src/types.ts:302-306
// `name` with the raw `arguments` JSON string exactly as the model produced it (unparsed)
'tool/call': { turn, step, callId, name: string, arguments: string }
```

所以取技能名必须把 `JSON.parse` 包在 try 里：模型完全可能吐出半截 JSON，
一条畸形历史记录**不应该**让整个视图崩成错误页。

#### 失败的加载不算「已加载」

`tool/call` 记录的是**意图**。技能名写错或技能已不可用时 `execute` 抛错（:136,143），
正文从未进入上下文。所以模型路径要等配对的 `tool/result` **没有 `error`** 才计数
（callId 配对规则同 §15.4）。用户路径没有这一说：注入发生在 `agent/pre-step`，
注入了就是进了上下文。

⚠️ 但**尚未配对**的 call 要算（正在进行的这一轮：call 已落盘、result 还没有）。
不算的话，刚加载完的技能会先从「已加载」里消失再出现，看起来像 bug。

### 16.6 「打开本机路径」dsh 已经做好了，不要自己 spawn

`packages/api/session-controller/src/index.ts`：

- `canOpenWorkspacePath()`（:262）——能力探测；
- `openWorkspacePath({ path })`（:274）——交给宿主机桌面打开。

浏览器半用 `ctx.remote.session.*` 调，需要 `inject: ['remote', 'remote.session']`
（范本：`client/ui-deliverables/src/client/index.ts:34,48`；`ui-chat/src/client/apply.ts:124`）。

⚠️ **它打开的是宿主机的桌面**。对本项目的主场景（手机远程）完全不可见，
所以 UI 必须先探测、能开才显示按钮，并且无论如何都要把路径本身显示成可复制文本 ——
否则就是做了一个在手机上点了没反应的按钮。

## 17. 用户级全局提示词 `$DSH_HOME/AGENTS.md`（agents-md 插件的依据）

### 17.1 它真实存在，而且排在项目级提示词之前

`agent-instructions` 的发现过程（`packages/context/agent-instructions/src/files.ts:280`）
**第一件事**就是把用户级全局文件加进候选：

```ts
const userGlobal = join(config.dshHome, USER_GLOBAL_FILE)
```

然后才从项目根向 cwd 逐级收集项目级候选（`:298-307`）。所以全局那一份**先进上下文**，
项目级的叠加在它上面。

- 文件名 `USER_GLOBAL_FILE = 'AGENTS.md'` 定义在同包的 `render.ts:98`，
  ⚠️ **不在该包的公开入口上** —— 插件只能抄一份常量，抄错或 dsh 改名都不会报错，
  只会安静地编辑一个没人读的文件。
- 显示成 `~/.dsh/AGENTS.md` 或 `$DSH_HOME/AGENTS.md`（`files.ts:519-520`，
  由 `dshHomeDisplay()` 二选一），**永远不显示绝对路径**。
- 文件不存在是完全正常的状态（`statFile` 的 `absent` 分支直接跳过），不是错误。

### 17.2 `dshHome` 是**每个预设**的配置，不是进程全局的

⚠️ 这一条容易想当然。`agent-instructions` 这一行位于**每个预设自己的 composition** 里
（`packages/preset/agent-presets/presets/standard/agent.cordis.yml:30-33`，
`cordis` / `ptc` 同样），而 `dshHome` 是它的 config 字段（`config.ts:20,40`）。

**所以「每个预设一份全局提示词」在 dsh 里是天然可行的** —— 给各预设配不同的 `dshHome` 即可。

本项目**没有走这条路**，理由不是技术性的：官方的 `standard` / `cordis` / `ptc` 是
`trust: 'system'`（`preset.ts:8`），`remoteExportCopy` 明确拒绝写 shipped 预设，
所以「每个预设一份」等于逼用户把每个想用的预设都复制成用户预设。用户据此拍板
**只要全局唯一一份**。这条结论记在这里是为了：将来若要做「按预设区分」，
接缝在哪里是已经查清的，不必重查。

### 17.3 超过 `maxSourceBytes` 的文件被**静默丢弃**

`readBounded`（`files.ts:327-349`）在两处 `return undefined`：`size` 超限、
或流式累加时超限。返回 `undefined` 的候选**不进上下文，也不报错**。
默认 `maxSourceBytes` 是 1 MiB（`config.ts:14`）。

⚠️ 对写编辑器的插件而言这是硬约束：不在保存时拦下来，用户就会看到「已保存」
而模型永远收不到 —— 一个没有任何错误信息的失败。

### 17.4 怎么**反向验证**「写对了地方」

`@deepseek-ai/dsh-agent-instructions` 的公开入口导出了
`discoverBaselineInstructionFiles({ cwd, dshHome })`（`index.ts:36`）。
它返回 dsh **自己**认领的基线文件列表（`absolutePath` + `displayPath`）。

所以插件的正确性可以由 dsh 自己回答，而不是由我们抄的常量回答：
写一个带唯一标记的文件 → 调这个函数 → 看它在不在返回值里。
`scripts/agents-md-check.mjs` 就是这么做的，实测 dsh 认领
`["$DSH_HOME/AGENTS.md", "AGENTS.md"]`。**升级 dsh 后必须重跑**：
这是 §17.1 那个「不在公开入口上的常量」唯一的护栏。

## 18. 一句话总结

> dsh 的 Web 面就是「静态资源 + `POST /api/<service>/<method>` + 一条下行 WebSocket」，
> 外加一道基于 `Host` 头的 rebinding 防御，以及 0.1.2 新增的、只能用启动 token 换取的 cookie 认证。
> 所以本项目 = 一个原样转发 Host、自带认证、并代跑一次 dsh token 交换的反向隧道。
> **仍不需要理解 dsh 的任何业务协议。**
