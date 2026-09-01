# 05 · 开发路线图

> **这是开发主线。每完成一项立刻把 `- [ ]` 改成 `- [x]`，不要攒着批量勾。**
> 每个里程碑都有明确验收标准，未通过验收不要进入下一个里程碑。

---

## M0 · 零代码可行性验证 ⚠️ 不要跳过

**目的**：在写任何代码之前，用手工手段验证三件事。任何一条不成立，后面整个方案都要改。

### 任务

- [x] **M0.1** 本机装 dsh 并跑起来
  > 实际做法改为 **D13：dsh 作为本仓库依赖**（`packages/launcher` 的 `@deepseek-ai/dsh@0.1.0-rc.7`），不全局安装、不用 npx：
  > ```powershell
  > $env:DSH_HOME = "d:\dev\dsh-remote\.dev\dsh-home"
  > node packages\launcher\node_modules\@deepseek-ai\dsh\lib\bin.js web --no-open --port 3080
  > ```
  > 已验证：能启动、能响应 `/api` RPC。对话需先配 DeepSeek API Key（未做）。

- [x] **M0.2** 导出 profile 配置树，确认插件组成
  已存档 `docs/reference/web-profile.yml`（503 行）。关键行：L404-419 webserver / web-runtime / connection 的 `trustedHosts` 注入链。

- [ ] **M0.3** 🔑 **手机浏览器局域网实测（用户执行，清单已写到 `docs/reference/mobile-test.md`）**（最大分叉点）
  ```powershell
  # 仅限内网，用完立刻关掉
  npx @deepseek-ai/dsh@latest web --host 0.0.0.0 --trusted-host 192.168.x.x:3080
  ```
  手机连同一 WiFi，浏览器打开 `http://192.168.x.x:3080`

  **重点观察并记录到 `docs/reference/mobile-test.md`**：
  - 首屏加载耗时
  - 布局是否可用（侧边栏、输入框、消息流会不会挤成一团）
  - 能否正常发指令、看到流式输出
  - 审批卡片（`ui-permission-presets` / `ui-user-questions`）在小屏上能不能点
  - 切到别的 App 再回来，会话是否自动恢复

  **决策点**：
  - 可用 → M4 只做 PWA + 推送，**不写自定义 UI**
  - 不可用 → M6 需要写 `dsh.client` 插件替换 layout，工作量增加约 2 周

- [x] **M0.4** 🔑 **验证两种过 fence 的模式** —— **已用本机等价验证完成，结果见 [m0-report.md](reference/m0-report.md)**

  > 未用 ssh -R + nginx：`isTrustedApiRequest` 入参只有 headers、无 `socket.remoteAddress` 检查，所以
  > `scripts/m0-fence-check.mjs` 直接构造 Host/Origin/sec-fetch-site 打本机即等价。
  > 结论：**模式 A 全部通过**（`/api/<method>` 200、两个 WS 均 101、特权方法 403）；
  > **模式 B 也成立**（改写 Host 后 `settings.describe` 返回 200）；
  > 写错 `--trusted-host` 确实是**启动即退出码 1**。
  > **真实公网链路（Caddy/nginx + 证书）的验证并入 M1.5 / M2。**

<details>
<summary>原计划的公网验证步骤（M1.5 时重新拿出来用）</summary>

  先建反向隧道：
  ```powershell
  ssh -N -R 13080:127.0.0.1:3080 user@your-server
  ```

  **模式 A（默认路线，先测这个）**：dsh 侧声明 trustedHosts，nginx 原样转发
  ```powershell
  npx @deepseek-ai/dsh@latest web --trusted-host pc1.dsh.example.com
  ```
  ```nginx
  proxy_set_header Host $host;        # 原样转发，不改
  ```

  **模式 B（备选）**：nginx 重写 Host/Origin，dsh 不加 `--trusted-host`
  ```nginx
  server {
      listen 443 ssl;
      server_name pc1.dsh.example.com;
      location / {
          proxy_pass http://127.0.0.1:13080;
          proxy_set_header Host 127.0.0.1:3080;           # ★ 模式 B 才改
          proxy_set_header Origin http://127.0.0.1:3080;  # ★ 模式 B 才改
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_read_timeout 3600s;
          client_max_body_size 200m;
      }
  }
  ```

  然后手机访问 `https://pc1.dsh.example.com`

  **两种模式都要验收的项**：
  - [ ] 前端 dist 正常加载，不是 403
  - [ ] `/plugins/*/client.js` 全部 200
  - [ ] `POST /api` 成功（不是 403）
  - [ ] `/api/events.mux` 和 `/api/events.host` 两个 WebSocket 都升级成功（101，不是 426/403）
  - [ ] 能发消息、能看到流式输出
  - [ ] 能创建会话并选择工作目录（模式 A 下走 `directory-picker-browse` 回退）

  **模式 A 专项**：
  - [ ] 确认设置页 / 凭据页返回 403（**预期行为，不是 bug**）
  - [ ] 确认除此之外一切正常 → 记录「模式 A 是否够日常使用」
  - [ ] 故意写错 `--trusted-host`（如 `https://pc1...`）验证 dsh **插件加载即报错**

  **模式 B 专项**：
  - [ ] 设置页 / 凭据页可用（验证 15 个特权方法确实被解锁）

  ⚠️ 这一步验证通过后**立刻把 nginx 配置删掉或加上 HTTP Basic Auth** —— 此时它是一个无认证的公网 shell。

</details>

- [ ] **M0.5** 写一个 Hello World 客户端插件，验证插件链路
  照 dsh 源码的 `docs/cookbook/adding-a-settings-card.md`（源码位置见 skill `dsh-source`）做，用 `dsh plugin --profile web add <本地路径>` 装进去
  （目的：确认 M6 的自定义 UI 路线可行，不通过不影响 M1-M5）

### M0 验收

写一份 `docs/reference/m0-report.md`（**已建，除 M0.3 外均已回答**），回答：
1. 手机上 dsh 原生 UI 能不能用？（决定 M6 范围）
2. 模式 A 是否可行、是否够日常使用？（决定默认模式）
3. 模式 B 是否可行？（决定 `unlockPrivileged` 开关能否实现）
4. 有没有发现文档没写的坑？

---

## M1 · 隧道最小可用

**目标**：用自己的代码替代 M0.4 的 ssh + nginx，跑通端到端，认证先用静态 token 占位。

- [x] **M1.1** 搭 monorepo 骨架
  - `pnpm-workspace.yaml`、根 `package.json`、`tsconfig.base.json` ✅
  - 四个包 `packages/{protocol,connector,relay,launcher}` ✅
  - 构建 `tsdown`（`deps.alwaysBundle` 打进内部包、`deps.neverBundle` 保留 dsh 实体依赖），开发 `tsx` ✅
  - `.gitignore`、`.editorconfig`、`.oxlintrc.json` ✅
  - `@deepseek-ai/dsh@0.1.0-rc.7` 装在 `packages/launcher`（D13），保持实体 `node_modules` ✅

- [x] **M1.2** `@dsh-remote/protocol`：定义控制帧
  - 严格 zod schema：`hello` / `challenge` / `auth`（M1 token + 预留 M2 Ed25519）/ `auth-ok` / `open-stream` / `ping` / `pong` / `error` ✅
  - 每帧 `version: 1`；`decodeControlFrame()` 把 `UNSUPPORTED_PROTOCOL` 与 JSON/schema/大小错误分开并给明确提示 ✅
  - 双向帧集合、路径、握手/stream/心跳超时、重连退避与 64KiB 帧上限 ✅
  - Vitest 12 项通过（全帧、方向、严格字段、版本错误、codec、Buffer/ArrayBuffer/typed array、大小上限） ✅

- [x] **M1.3** `@dsh-remote/relay`：隧道服务端
  - `node:http` server，M1 强制 bind `127.0.0.1`（浏览器认证尚未实现，不能暴露）✅
  - `/_tunnel/control`：hello → challenge → M1 静态 token auth、明确版本错误、心跳、重复机器拒绝、断线清理 ✅
  - `/_tunnel/stream`：32-byte 随机一次性 token、过期/连接超时、`createWebSocketStream()` 交给 HTTP 客户端 ✅
  - 主流量：原始 Host 解析 slug → open-stream → `http.request({ createConnection })` 重发请求体/响应体 ✅
  - 模式 A 原样转发 Host/Origin（当时还有一个 `unlockPrivileged` 开关，已于 dsh 0.1.2 升级时删除）✅
  - `upgrade` 单独转发 dsh 的下行 WebSocket；原始 Host/Origin/sec-fetch-site 先检查 ✅
  - 5 项集成测试：control auth、HTTP body + 模式 A、dsh token 重定向、请求安全拒绝、WebSocket echo；连续运行 5 轮稳定 ✅

- [x] **M1.4** `@dsh-remote/connector`：被控端反向隧道连接器
  - 拨出控制信道，指数退避重连（1s→30s，带抖动）
  - 收到 `open-stream` → 回拨数据 WS → `net.connect('127.0.0.1', 3080)` → 双向 pipe
  - 本地 dsh 未启动时给出明确错误提示，不要静默失败
  - 心跳与超时
  - **上报自己的 slug**，供 launcher 生成 `--trusted-host` 参数（模式 A）

- [ ] **M1.5** 端到端联调
  - 同机跑 relay + connector + dsh，由另一台局域网机器直接访问 `http://<relay局域网IP>:30809`
  - M1 单机模式配置 `directSlug=pc1`，IP/localhost Host固定路由到该机器；不要求 hosts、域名或 TLS，多机器子域名路由留到公网联调
  - **前置：先完成正式浏览器认证。** 只有“loopback socket + loopback Host”可免登录；局域网 IP访问与未来域名访问走同一登录/session中间件，认证落地前禁止非 loopback bind

### M1 验收

- [ ] 浏览器通过 relay 能完整使用 dsh：发消息、流式输出、切换会话、打开设置
      （dsh 0.1.2 删除了特权方法围栏，设置页在模式 A 下应该直接可用）
- [ ] 下行 WebSocket `/api/remote.mux` 稳定，长时间（>30min）不断
- [ ] connector 断网后自动重连，恢复后页面刷新即可用
- [ ] relay 重启后 connector 自动重连
- [ ] 上传一张图片附件成功（验证大 body 转发）

---

## 已完成 · dsh 插件体系与远程设置修复（D17）

> 起因：远程地址打开时「模型」页报 `settings are unavailable in this browser`、
> 「插件」页配置区空白。根因是 dsh 0.1.2 把「操作者在不在本机」的判定搬到了客户端
> （按 `location.hostname`），而不是服务端权限。事实链见 [02-dsh-facts.md](02-dsh-facts.md) §4.7。

- [x] 新建插件目录 `packages/plugins/`（`pnpm-workspace.yaml` 加 `packages/plugins/*`），
      以后扩展 dsh 一律写插件（用户拍板，D17）
- [x] `@dsh-remote/dsh-plugin-remote-privileged`：订阅 `webserver/index-inject`，注入
      `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`；运行时零依赖，**默认开启、无配置项**
- [x] 装载方式：插件包根的 `dsh-overlay.yml` 由 launcher 以 `--patch` 传给 dsh，
      overlay 用相对路径 insert（`packages/launcher/src/dsh-plugins.ts`）；不碰用户 profile（D14 不变）
- [x] **两个 spawn dsh 的地方都要传 `--patch`**：`packages/launcher/src/dsh.ts`（绿色包）与
      `scripts/dev-stack.mjs`（`pnpm dev` / `pnpm start`，走 `local-config.mjs` 的 `dshPluginOverlays()`
      扫 `packages/plugins/*`）。漏了后者的后果：开发机上一切看上去正常，但设置页依旧废掉
- [x] 缺失即失败：overlay 或 `dist/index.js` 不在时 launcher 拒绝启动；`scripts/pack.mjs` 同步拦一道
- [x] 实测：`dsh --profile dsh-remote-web --patch …` 正常加载，首页 `<head>` 里出现
      `globalThis["__DSH_TRANSPORT__"] = {"ownsHost":true}`，位于模块入口之前
- [x] 文档回写：docs/01 D12 更正 + D17、docs/02 §4.2/§4.7/§4.8、docs/03、docs/04 §6、docs/06、AGENTS.md
- [ ] 用户实机验证：从远程地址打开，模型页能列提供方、插件页配置区有内容

### 顺带查实、尚未处理的一件事

`directory-picker-auto` 在启动时按 bind 地址 / SSH / DISPLAY 判定原生对话框还是网页内浏览
（[02-dsh-facts.md](02-dsh-facts.md) §4.8）。dsh 恒定 bind loopback，所以 **Windows / macOS 机器上
「打开工作区」的对话框会弹在被控机桌面上**，远程看不见；无头 Linux 服务器不受影响。
官方固定方式是在 patch 里直接组合 `-browse` 行（同时换掉 backend 与 client surface 两个包）。
做不做、以及是否接受「本机也没有原生对话框」这个代价，待拍板。

## 已完成 · dsh 0.1.2-alpha.2 升级（含影响评估与执行记录）

> 结论基于 tag `dsh-v0.1.2-alpha.2`（`0a53fb55be`，2026-08-30，距 alpha.1 共 234 个提交）源码逐条核对，非推测。
> 升级已执行：`packages/launcher` 的 `@deepseek-ai/dsh` = `0.1.2-alpha.2`。

### 已执行的改动

- [x] `@deepseek-ai/dsh` 升到 `0.1.2-alpha.2`；同步小版本：zod 4.5.4（四包一致）、hono 4.13.5、
      jose 6.2.10、undici 8.10.1、tsx 4.23.13、oxlint 1.80.0（`@hono/node-server` 2.x、TypeScript 7、
      `@types/node` 26 三个 major 本轮不跟）
- [x] **根 `package.json` 新增 `pnpm.overrides`**：dsh 子包互相声明为 peerDependencies，
      pnpm 自动安装缺失 peer 时走 npm 的 `latest` dist-tag，而这些子包的 `latest` 仍停在
      0.1.0-rc.8 / 0.1.1-rc.2，导致 alpha.3 的包加载 rc 版依赖，dsh **启动即报**
      `does not provide an export named 'admitPromptContent'`。把 21 个滞后的 peer 钉到 `0.1.2-alpha.3` 后正常启动。
      下次升级 dsh 时必须重新核对这张表。
- [x] 删除 `packages/plugins/web-compat`（`crypto.randomUUID` 已由上游 `dsh-util-crypto` 解决）
- [x] 删除模式 B：`unlockPrivileged` / `upstreamAuthority` / `--unlock-privileged` 全部从 relay 移除（用户拍板）
- [x] 接上 dsh 的浏览器认证：protocol v3 新增 `dsh-auth` 帧；launcher 截获 token →
      `DSH_REMOTE_DSH_TOKEN` → connector 上报 → relay 在首页 401 时回一次 303 `?token=`
- [x] 路径与文档同步：`/api/remote.mux`、combo 插件路由、docs/01、02、03、04、AGENTS.md、
      `deploy/Caddyfile`、`scripts/m0-fence-check.mjs`

### 逐条核对结果（alpha.2）

| 本项目依赖的行为 | 变/没变 | 出处（相对 dsh 仓库根） |
|---|---|---|
| `--trusted-host` CLI 参数 | **没变**。仍在，仍是裸 `host` / `host:port`、可重复；写错仍是**插件加载时抛错** | `packages/bundle/web-app/src/startup.ts`、`packages/client/connection/src/api-request-trust.ts` (`assertTrustedAuthority`) |
| `/api` Host/Origin fence | **没变**。Host 必须 loopback 或命中 `trustedHosts`；`sec-fetch-site: cross-site` 直接拒；Origin 存在时必须同 authority；**仍只看 headers，不看 socket 地址** | `packages/client/connection/src/api-request-trust.ts` |
| 特权方法钉死 loopback | **整套删了**。`PRIVILEGED_METHODS` 在源码中零出现；`requestRejection()` = fence(403) → 浏览器认证(401)，无按方法区分 | `packages/client/connection/src/rpc-host.ts` |
| dsh 自带浏览器认证 | **新增**（详见下文）。未带 cookie 的 `/api` 一律 401，WS 升级同样 401 | `packages/client/connection/src/browser-auth.ts` |
| `crypto.randomUUID` 兼容 | **上游已解决**。改用 `@deepseek-ai/dsh-util-crypto` 的 `randomUUID`（走 `getRandomValues`），并有 lint 规则禁用 `crypto.randomUUID` | `packages/util/crypto/src/index.ts` |
| 插件 / profile 机制 | **没变**。`dsh --profile <name>`、`dsh web` 别名、`dsh plugin --profile <name> add <pkg>`（转发 pnpm）均在；bundle 名 `@deepseek-ai/dsh-base` / `@deepseek-ai/dsh-web-app` 未改 | `apps/cli/src/args.ts`、`apps/cli/src/plugin.ts`、`packages/bundle/{base,web-app}/package.json` |

### dsh 浏览器认证的确切形状（alpha.2 实读）

- `GET /?token=<launch token>` → 303 到 `/`，同时下发 `dsh-auth-<base64url(sha256(authority))>` cookie：
  HMAC-SHA256 签名、payload 绑定 authority、`HttpOnly; SameSite=Strict; Path=/`、默认 30 天（`cookieMaxAgeDays` 可配）。
- 签名密钥存在 credentials（dsh home），**跨重启有效**；launch token 是**每进程随机**（`randomBytes(32)`，挂在 `ctx.root` 的 WeakMap），没有环境变量可注入。
- **token 取法已确定**：web-app bundle patch 里 `printUrl: true` 写死，dsh 启动必定打印
  `dsh web: http://127.0.0.1:<port>/?token=<token>`（`packages/bundle/web-app/{cordis.patch.yml,src/index.ts}`）；
  launcher 已逐行转发子进程 stdout（`packages/launcher/src/supervisor.ts`），截获这一行即可。
- 认证范围：`/api/**`（含 WS 升级）+ index（`/` 与 `index.html`，走 `authorizeIndex`）；
  其余静态资源与 `/plugins/**` 不需认证（`packages/host/frontend-static/src/index.ts`）。
- `isAuthenticated` **没有 loopback 豁免** —— 本机直连 `127.0.0.1:<port>` 也必须先过 token 换 cookie。

### 另外两个必须知道的变更

1. **下行 WebSocket 从两个变成一个**：`/api/events.mux` + `/api/events.host` 已删除，换成单条
   `/api/remote.mux`（Typert Remote stream mux，`packages/api/gateway/src/stream-protocol.ts`）。
   转发层路径无关，**代码不用改**；但 `AGENTS.md`、`docs/02`、`docs/03`、`deploy/Caddyfile` 注释、
   `scripts/m0-fence-check.mjs`、冒烟清单里的路径都要改。
2. **前端插件改走 combo 路由**：`/plugins/??a/client.js,b/client.js&rev=<rev>`
   （`packages/client/modules/src/index.ts`）。URL 带 `??` 与逗号，relay 与 Caddy 必须原样透传 raw URI，需冒烟验证。

次要：`dsh --profile web --host 0.0.0.0` 现在被 CLI 直接拒绝（提示改用 127.0.0.1），
本项目 dsh 只 bind 127.0.0.1（铁律 4）不受影响，但 `docs/02` §4.5「局域网测试可用 `--host 0.0.0.0`」的说法作废；
`0.0.0.0` 绑定时 dsh 会自动把 LAN IPv4 字面量加进 `trustedHosts`（`resolveLanTrust`）。

**已完成的小改**

- 删除 `packages/plugins/web-compat`（含开发机 profile 里的 bundle 条目与文档引用）。
- `docs/02-dsh-facts.md` §4.2「15 个特权方法钉死 loopback」已标为作废，§3 的 WS 路径已改成 `/api/remote.mux`，
  新增 §4.6 记 dsh 自带认证；`docs/04-security.md` §1.2 与风险表同步。
- `scripts/m0-fence-check.mjs` 重写：新增 `--token`（先换 cookie 再测 fence）、路径改 `/api/remote.mux`、
  旧特权方法用例改为“不再固定 403”的反向断言。
- 模式 B / `unlockPrivileged` **已删除**（特权方法名单消失后它只剩下“关掉 dsh 的 rebinding 防御”一个效果）。

**已完成的设计：dsh launch token 链路**

把 dsh 的 launch token 接到我方登录流程后面，否则用户在 relay 登录后打到 dsh 仍会吃 401：

1. connector 从 dsh 子进程 stdout 的 `dsh web: ...?token=` 行截获 token
   （实际实现：launcher / dev-stack 负责截获，通过 `DSH_REMOTE_DSH_TOKEN` 传给 connector）
2. protocol v3 新增 `dsh-auth` 帧，认证后（含每次重连）上报给 relay（token 每次 dsh 重启都会变）
3. relay 在 dsh 对首页回 401 时回一个 303 `?token=…`，让 dsh 向浏览器下发它自己的 cookie
   （模式 A 下原样转发 Host，dsh 签的 authority 就是 relay 子域名，一致）；
   已带 token 的请求不再重定向，`/api` 的 401 原样透传

两个 cookie 并存、各司其职。**不削弱安全性**：我方认证仍在最前面，dsh 那层是叠加而非替代。
注意：dsh 的 cookie 没有 `Secure` 属性，但有 `HttpOnly; SameSite=Strict`；HTTPS 下正常工作。

**不做的事**：不基于本地源码构建或打包 dsh。GitHub tag 依赖不可行（仓库根是 workspace 根、
不支持子目录、70 个 `workspace:^` 无法在外部解析）；本地全量打包需要先构建 247 个包并自建 registry。
只从 npm 安装已发布的版本。

---

## 已完成 · dsh 0.1.2-alpha.4 升级（含影响评估与执行记录）

> 结论基于 tag `dsh-v0.1.2-alpha.4`（`4e84901e64`，2026-09-01，距 alpha.2 共 414 个提交）源码逐条核对，非推测。
> 升级已执行：`packages/launcher` 的 `@deepseek-ai/dsh` = `0.1.2-alpha.4`。

### 逐条核对结果（alpha.4）

| 本项目依赖的行为 | 变/没变 | 出处（相对 dsh 仓库根） |
|---|---|---|
| `--trusted-host` CLI 参数 | **没变**。仍是裸 `host` / `host:port`、违规仍是插件加载时抛错；`apps/cli/src` 在两 tag 间零改动 | `packages/client/connection/src/api-request-trust.ts` |
| `/api` Host/Origin fence | **没变**。`isTrustedApiRequest` 逐行与 alpha.2 一致：Host loopback/`trustedHosts`、`sec-fetch-site: cross-site` 拒、Origin 同 authority、只看 headers | 同上 |
| 特权方法围栏 | **没变**（保持已删除）。`connection/src` 中 `privileged` 零出现 | `packages/client/connection/src/` |
| dsh 浏览器认证 | **没变**。`?token=` → 303 + `dsh-auth-<sha256(authority)>` cookie 形状不变；`printUrl: true` 仍在 web-app patch，launcher 截获不受影响 | `packages/client/connection/src/browser-auth.ts`、`packages/bundle/web-app/cordis.patch.yml` |
| 下行 WebSocket 路径 | **没变**。仍为 `/api/remote.mux`；心跳从「1 次未 pong 即断」放宽到「容忍 2 次」（`MAX_MISSED_HEARTBEATS`），对转发层透明且更稳 | `packages/api/gateway/src/stream-protocol.ts`、`src/stream-server.ts` |
| combo 插件路由 | **没变**。`/plugins/??…` 机制保留 | `packages/client/modules/src/index.ts` |
| 插件 / profile 机制 | **没变**。`--profile` / `--patch` / `web` 别名 / `plugin` 子命令全在 | `apps/cli/src/` |

### 本次变更的主体与已知注意点

- 414 个提交的主体是聊天渲染性能优化（streaming 分帧发布、keyed sources）与 UI 细节（superellipse 圆角等），
  以及新插件 `session-turn-outline`（turn rail 预览）。唯一带 `!` 的是 dsh 内部 session 格式
  （`refactor(session)!: distinguish event seqs from log offsets`），对隧道透明。
- `pnpm.overrides` 21 个子包从 `0.1.2-alpha.3` 钉到 `0.1.2-alpha.4`；删 lockfile + 全部 `node_modules`
  重装后，dsh 闭包内 214 个子包版本统一为 alpha.4，无滞后 peer（其余非 alpha 版本为 cordis 生态第三方包
  与 dsh 自己的 Linux 沙箱模块 `node-addon-landlock-run`，版本线独立，正常）。
- 本轮未跟的同步小版本与 major 升级见「检查其余依赖」小节。
- 冒烟：`--profile dsh-remote-web --no-open --port 3099 --trusted-host 127.0.0.1` 启动正常并打印
  `dsh web: …?token=…`；`m0-fence-check.mjs` 全部用例符合预期（401/303/200/403/101 均与 alpha.2 行为一致）；
  `pnpm dev` 全链路：设备注册 + 控制信道认证 + dsh token 上报、relay 向导登录后访问机器根路径
  303→303→200 到 dsh 页面、`/plugins/??…&rev=…` combo bundle 经 relay 原样透传 200。

### 新能力观察（未实施，待用户决定）

- `feat(base): expose web fetch by default`：web fetch 工具默认暴露，可能影响远程会话的可用工具面。
- steer service（PR #3250）：会话转向服务，与 M5 审批推送可能有关联。
- `session-turn-outline`：整日志 turn 大纲，纯 dsh 前端能力，本仓库无需改动。

---

## M2 · 认证与设备管理

- [x] **M2.1** `node:sqlite` 存储层
  - 表：`users`、`devices`（machineId, slug, publicKey, revoked）、`user_machines`、`sessions`、`enroll_tokens`、`audit_log`
  - 简单的迁移机制（版本号 + 顺序执行的 SQL）

- [x] **M2.2** 设备认证（替换 M1 的静态 token）
  - [x] connector 首启生成 Ed25519 密钥对，存 `~/.dsh-remote/device.key`（Windows 用 ACL 限权）
  - [x] 管理页签发一次性注册令牌
  - [x] 注册流程 + 签名挑战登录流程
  - [x] 管理页查看 / 吊销设备
  - 协议版本升到 2；静态 token 已彻底移除，不保留兼容层

- [x] **M2.3** 用户认证
  - `dsh-remote-relay init` 创建管理员（argon2id）
  - 登录接口 + TOTP 绑定与校验（`otplib`）
  - `jose` 签发 15 分钟 JWT + 30 天可吊销 refresh cookie
  - Cookie `Domain=.dsh.example.com`、`__Secure-` 前缀、Secure/httpOnly/SameSite=Lax（LAN HTTP 开发模式为 host-only 非 Secure，并打印高危警告）
  - `rate-limiter-flexible` 限流

- [x] **M2.4** relay 侧安全检查（见 04-security.md §3）
  - 原始 Origin / Host 校验、`sec-fetch-site` 拒绝
  - **顺序：认证 → 安全检查 → 重写 Host → 入隧道**

- [x] **M2.5** 管理页（hono + 极简 HTML，不引入前端框架）
  - [x] 登录页
  - [x] 「我的机器」列表 + 在线状态 + 点击跳转到对应子域名
  - [x] 机器离线时的友好 502 页面（仅对浏览器导航；API 请求保持机器可读响应）
  - [x] `/_admin/devices/revoke`：吊销走运行中的 relay，同时断开已建立的控制信道
        （GET 同路径是确认页：列出后果——包括对方 connector 致命退出会连带停掉那台机器的 dsh）
  - [x] `/_admin/tokens/create`：管理页签发一次性注册令牌，并给出可粘贴的 connector 命令
  - [x] `/_admin/membership/join|leave`：运行时设置 / 取消本机的远程入口（D16）；leave 同样先过确认页
  - [x] 「远程入口」页收敛成**一个粘贴框**：入口机器打印的 connector 命令里多带一个 `--hub-authority`
        （无域名时取控制台当前 Host 的主机名，port-less 匹配任意端口；有域名时取 `<机器名>.<域名>`），
        于是地址 / 机器名 / 令牌 / 要信任的地址全在那一行里，手填的四个输入框连同 `MembershipPrefill` 一起删除。
        拒绝提交时不回显粘贴内容（里面有令牌）。connector CLI 同步新增 `--hub-authority`，让同一行命令在终端里等价。
  - [x] 注册令牌不再留废行：用掉即 `DELETE`（原来是写 `used_at`），吊销机器时删掉该机器名下未用的令牌，
        签发时顺手清掉已过期的；migration v3 删掉 `used_at` 列。库里只剩「未使用且未过期」的哈希。
        没有令牌列表页；也没有活动页（见下）——要看签发了多少个，查 `relay.db` 的 `audit_log`（skill `relay-audit`）。
  - [x] 有效期固定 **5 分钟**（`ENROLL_TOKEN_TTL_MINUTES`），像短信验证码；签发表单去掉了时长输入框与
        对应的校验分支，`issueDeviceEnrollToken` 不再接 `ttlMinutes`。
  - [x] 控制台各页改为**顶部对齐**（`body{place-items:start center}`）：共享壳原来垂直居中，
        页面高度不同时整张卡片（连同 tab 条）上下跳。实测（当时四页）：tab 条顶部 y 从 88/231/107/326 变成全部 88。
        同时加 `html{scrollbar-gutter:stable}`，避免有无滚动条造成的横向位移。
  - [x] 控制台拆成多个页面 + 顶部 tab 导航（原来是一个塞了五个板块的长页，手机上要滚很久）：
        `/_admin` 机器、`/_admin/hub` 远程入口、`/_admin/account` 账号（当时还有第四页活动，后来删了）；
        POST 端点路径全部不变，只是重定向到各自所属的页。
        不做侧边栏（relay 页面 CSP 是 `default-src 'none'`，零 JS；设置类页面不值得常驻占屏宽）；
        不在 dsh 页面里注入回控制台的入口；`_` 前缀保留（它是与 dsh 路由的防碰撞命名空间）
  - [x] **删掉「活动」功能**（用户拍板）：`/_admin/audit` 整页、机器页的 5 条预览、tab 项全部移除，
        现在访问该路径是 404。**记录本身一条不少**：依旧同时写 `audit_log` 和 pino 流。
        理由：安全记录是写给事后排查的人（或 AI）看的，日常用户在手机上翻分页安全日志只是负担；
        也不补 CLI（用户拍板）。查询方式写在 skill `relay-audit`（`.agents/skills/relay-audit/SKILL.md`）：
        `node:sqlite` 只读打开 `relay.db` 查 `audit_log`，或在日志里滤 `"audit":true`。
  - [x] ~~`/_admin/audit`：完整审计列表，`beforeId` 游标分页（每页 25 条）+ 按事件过滤（GET 表单，
        结果是可书签的 URL）；机器页只留 5 条预览 + 「查看全部活动 →」~~（已删除，见上条）
  - [x] 退出登录：管理页页脚链接 → `GET /_auth/logout` 确认页 → `POST /_auth/logout`
        （服务端撤销 refresh，清三个 cookie，表单提交 303 回登录页；loopback 免登录会话不显示入口）
  - [x] 页面主题切换：**浅色 / 深色 / 跟随系统**，词表与顺序都跟 dsh 的「外观」一致。
        relay 自己服务的每一页都带（登录、退出确认、初始设置向导、控制台各页、确认页、机器离线页）；
        仍然零 JS —— 偏好存 `dsh_theme` cookie，切换是一条 `GET /_theme?value=…&returnTo=…`
        （在认证之前处理，否则登录页用不了；`returnTo` 只允许同源路径），
        `system` 由 `prefers-color-scheme` 媒体查询在 CSS 里解析。
        与 dsh 自己的外观设置各存各的：relay 不读也不写 dsh 的设置文档
  - [x] 每台挂上来的机器一个持久化端口，作为第二种路由键

- [x] **M2.6** `pino` 审计日志
  - [x] 单一 `AuditRecorder` 同时写 SQLite 行和 pino 行（带 `audit: true` 便于过滤），
        `store.appendAudit` 不再在其他模块直调（有测试看着）
  - [x] 事件名改为联合类型，拼错在 typecheck 阶段就报错
  - [x] 分级规则：成功 `info`；认证失败与破坏性管理操作 `warn`；写库失败 `error` 并重抛
  - [x] 密钥护栏：metadata 包含类似密钥的键时**直接抛错**，不静默脱敏
  - [x] 审计事件同时进入数据库和 pino 日志流；**不做展示页面**，查询走 skill `relay-audit`

### M2 验收

- [x] 未登录访问 → 跳登录页（局域网 IP 与成员端口均已实测 302；域名形态待 M3）
- [x] 登录（含 TOTP）后可正常使用（用户实测）
- [ ] 登录接口连错 5 次被锁（单元测试已覆盖；未做浏览器实操，因为会把管理员锁 15 分钟）
- [x] 吊销设备后该机器立即断开且无法重连
      —— 已实测：`/_admin` 吊销后 relay 记录 `machine disconnected by operator`，
      connector 同时收到 `DEVICE_REVOKED` 并「stopped and will not retry」。无轮询。
- [x] 未绑定的 slug 返回 404（不泄露存在性）
      —— 已由测试锁定：已注册的 slug 与不存在的 slug **状态码和响应体完全一致**。
      未登录者更早就被跳转到登录页，压根触及不到路由解析。
- [x] 伪造 Origin 的请求被 403（实测；cross-site 的 `sec-fetch-site` 同样 403）

---

## M3 · 绿色包与启动器

见 [06-packaging.md](06-packaging.md)。

- [x] **M3.1** `@dsh-remote/launcher`
  - [x] 读 `dsh-remote.config.json`（dsh 端口、profile、home、relay 端口/地址/slug/数据库）
        —— 按 D16 调整：远程入口不再写在配置里，而是由 `membership.json` 运行时管理
  - [x] D14：共用标准 `DSH_HOME`；仅当 `dsh-remote-web` profile 完全不存在时写最小模板
  - [x] 拉起内嵌 dsh（bin 经 `require.resolve` 定位，不写死路径）并轮询至就绪
  - [x] 从 `membership.json` 推导入口机器 authority 并拼入 `--trusted-host`（模式 A 的最后一环）
  - [x] 拉起本机 relay（D16：本机控制台是给本机设置远程入口的唯一地方）
  - [x] 首次运行：生成 0600 的 JWT 密钥 + 交互创建管理员；stdin 非终端时报错不挂起
  - [x] 拉起 connector（不传 `--relay`/`--slug`，由它自己读 membership）
  - [x] **在终端打印访问地址，不自动开浏览器**（D6）
  - [x] Ctrl+C 优雅关闭：按 connector → relay → dsh 逆序，Windows 走 `taskkill /T /F`
  - [x] 实机验证：三进程均已启动、控制台可用、关闭后无孤儿进程且端口释放

- [x] **M3.2** Windows 入口
  - [x] `dsh-remote.exe`（Go 写的 shim，交叉编译，1.9 MB）：**可双击**，按自身路径解析工作目录，
        找不到 Node 时中文提示并保持窗口；**顺带去掉了 PowerShell 7 这个前置依赖**
  - [x] `packaging/start.ps1`（PowerShell 7）作为终端用户的替代入口
  - ❌ `.lnk` 快捷方式已实测排除：工作目录被写死成绝对路径，解压到别处即失效
  - ⚠ exe 未代码签名，SmartScreen 首次会提示「无法识别的发布者」，README.txt 已写明

- [x] **M3.3** Linux/macOS 启动器：`packaging/start.sh`（POSIX sh，归档内保留 0755）

- [x] **M3.4** 打包脚本 `scripts/pack.mjs`（`pnpm release`）
  - 一次 `pnpm deploy --prod` 产出单一自洽的依赖树（早期的「两次 deploy 再平铺合并」
    在 `real-require` 0.2.0/1.0.0 上直接撞死，已废弃）
  - 写 zip 前先跑五个入口的冒烟测试，解析不到就不产出包
  - 文件名带平台后缀（`dsh-remote-0.0.1-win32-x64.zip`）：**dsh 自带按平台安装的预编译二进制**
    （sharp / koffi / node-addon-require-builtin），单平台包 63.8 MB，
    配 `pnpm.supportedArchitectures` 拉全平台可得单包通吃但涨到 133.4 MB

- [x] **M3.5** `deploy/`：systemd unit + Caddyfile + 部署说明

- [x] **M3.6** 重写 `docs/06-packaging.md`，使其与实现一致
  - 修正七处过时：桌面包裁掉 relay、argon2、两进程模型、`.cmd`、
    单包跨平台、终端初始化、缺托盘应用
  - 新增 §8「已否决的方案」，把 SEA / Go 重写 / 携带 Node / `.lnk` / `.cmd` 的
    否决理由固定下来，避免重走弯路

### M3 验收

- [x] 在一台只装了 Node 22.19+ 的机器上解压、启动、按提示打开地址即可用
      —— 已实测：解压到临时目录，**从 `C:\` 作为当前目录**跑 `dsh-remote.exe`（只有按
      自身路径解析才可能成功），三个子进程全起，向导页 200。
- [ ] Linux 服务器上 `./start.sh` 同样可用（本机无 Linux 环境，待实机验证）
- [x] 关掉终端窗口子进程都退出，不留孤儿进程
      —— 已实测：exe + 四个 node 全部消失，两个端口均释放。
      ⚠ **交互式双击后按 Ctrl+C 尚未人工验证**（需要真实桌面会话）。

---

## M4 · 移动端体验

- [ ] **M4.1** 基于 M0.3 的结论决定范围
- [ ] **M4.2** PWA：manifest + service worker + 图标
  - ⚠️ 这需要往 dsh 的前端注入内容 → 用 `dsh.client` 插件，或由 relay 在转发 HTML 时注入 `<link rel="manifest">`
  - **优先试 relay 注入**（不碰 dsh），失败再写插件
- [ ] **M4.3** iOS 引导：检测 iOS Safari 且非独立模式时，提示「添加到主屏幕」
- [ ] **M4.4** Web Push（VAPID，`web-push`）
  - ⚠️ iOS 16.4+ 的 Web Push **只在添加到主屏幕的 PWA 中可用**
  - 订阅存 relay，被控端事件触发推送

### M4 验收

- [ ] iPhone 上添加到主屏幕后是独立窗口、有图标
- [ ] 锁屏状态下能收到推送通知
- [ ] 点通知能跳到对应会话

---

## M5 · 审批策略插件

- [ ] **M5.1** 写 `dsh-remote-approval` Cordis 插件（这是本项目**第一个也可能是唯一一个** dsh 插件）
  - 监听 `approval/request` 瀑布事件
  - approval policy 用 `'ask'`（**绝不能用 `'never'`，那是全拒绝**，见 02 文档 §6.1）
- [ ] **M5.2** 三档分类
  | 档 | 内容 | 行为 |
  |---|---|---|
  | 自动放行 | read/grep/ls、工作区内 edit、`git status/diff/add/commit`、build/test | 返回 `'allowed-once'` |
  | 需批准 | `rm -rf`、工作区外写入、`git push --force`、`sudo`、`systemctl`、`docker rm`、`curl \| sh`、`DROP/TRUNCATE`、发包/部署 | 推送到手机等答复 |
  | 直接拒绝 | 读 `~/.ssh/id_*`、`.env` 外传、写系统目录 | 返回 `'rejected'` |
  - 规则表放配置文件，可覆盖
- [ ] **M5.3** 超时策略：默认阻塞等待 + 推送提醒；可配置 N 分钟后自动拒绝
  - ⚠️ fail-closed：异常/非法返回值都会被当成 `unavailable`（拒绝），断网时行为是安全的但 AI Agent 会停住
- [ ] **M5.4** 审批全过程记入审计日志

### M5 验收

- [ ] 常规编码任务全程无打断
- [ ] `rm -rf` 类命令确实被拦下并推送到手机
- [ ] 手机点批准后 AI Agent 继续执行；点拒绝后 AI Agent 收到拒绝并合理处理
- [ ] 断网期间 AI Agent 停住而不是继续执行

---

## M6 · 可选增强（按需，非必做）

- [ ] 自定义移动端 UI 插件（仅当 M0.3 结论是「不可用」）
- [ ] 多用户 / 邀请令牌
- [ ] OIDC 或 Passkey 登录
- [ ] E2E 加密（需先解决「UI 由 relay 下发」的信任问题，可能需要原生 App）
- [ ] Electron 桌面壳（**先重读 01-decisions.md §3 的废弃理由再决定**）

---

## 进度记录

| 里程碑 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| M0 | 进行中 | | M0.1/M0.2/M0.4 完成（见 reference/m0-report.md）；M0.3 待用户手机实测；M0.5 未做（不阻塞） |
| M1 | 进行中 | | M1.1 骨架、M1.2 protocol、M1.3 relay、M1.4 connector 完成；下一项为正式浏览器认证，完成后进入 M1.5 |
| M2 | 进行中 | | M2.1 存储层、M2.3 用户认证、M2.4 安全检查顺序完成；剩 M2.2 设备认证、M2.5 管理页、M2.6 审计日志输出 |
| M3 | 未开始 | | |
| M4 | 未开始 | | |
| M5 | 未开始 | | |
| M6 | 未开始 | | |
