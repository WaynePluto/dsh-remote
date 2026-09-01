# 01 · 需求、决策与废弃方案

## 1. 原始需求

用户当前工作流：PC 上用 VS Code + AI 插件开发 → 通过 VS Code Remote-SSH 连到服务器 → 在服务器上用 AI 插件做部署。

想补上的能力：**在手机上也能指挥 AI 干活**。

具体要求：

1. Agent 运行时装在开发机（或任意目标机器）上
2. 一个公网中转服务器负责转发，**纯中转，不部署业务 UI**
3. Web UI 支持 PC 和手机浏览器
4. 中转必须有认证（公网暴露）
5. 用户侧只需要安装少量组件；单机使用时不应该被迫部署公网服务
6. 手机上主要是**看进度 + 发指令**；默认 YOLO 自动执行，只有重大风险操作（删除等）需要人工批准

## 2. 已确认的决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | **Agent 运行时用 dsh**（DeepSeek Harness） | 用户指定。MIT、插件化内核、官方维护 |
| D2 | **不 fork、不改 dsh 源码** | dsh 是 0.1.0-rc，一周一个 rc；任何源码级耦合都会持续返工 |
| D3 | **走反向隧道，中转服务器不理解业务协议** | 对 dsh 的协议变更完全免疫；中转只认 HTTP/WebSocket 字节流 |
| D4 | **复用 dsh 自带的 Web UI** | 白嫖约 40 个官方 UI 插件（会话、审批、模型选择、设置、技能、子代理…） |
| D5 | **使用用户本机 Node，不携带 Node 二进制** | 用户明确要求；dsh 本来就要求 Node ≥22.19 |
| D6 | **提供双击启动器，但不自动打开浏览器**，在终端打印访问地址 | 用户明确要求 |
| D7 | **一台被控机器 = 一个子域名**，不用子路径 | dsh 前端把 `/api` 写死为绝对路径（见 02 文档 §4） |
| D8 | **不做 P2P / WebRTC** | 载荷是 JSON 消息和 diff，几 KB/s；P2P 的原生依赖会毁掉「纯 Node 绿色包」 |
| D9 | **不装任何第三方网络客户端**（Tailscale / frp 二进制等） | 用户明确要求；隧道用 Node + `ws` 自己实现，约 300 行 |
| D10 | **PWA 放到后期做，先验证效果** | 用户明确要求 |
| D11 | **优先使用成熟第三方依赖**，能用就用 | 用户明确要求 |
| D12 | **只用模式 A（声明 `trustedHosts`）过 dsh 的 fence，relay 永不重写 Host**。模式 B / `unlockPrivileged` 已于 dsh 0.1.2 升级时删除 | 模式 A 是官方支持路径，relay 实现更简单，且将来 dsh 若加 socket 层校验不会把你打死。**⚠️ 当时写的「15 个特权方法已删，设置/凭据页在模式 A 下直接可用」只对了一半**：服务端名单确实没了，但 dsh 把同等限制换成了**客户端**按 `location.hostname` 判定，远程页面的设置依旧废掉。修正方案见 D17；事实链见 [02-dsh-facts.md](02-dsh-facts.md) §4.7 |
| D13 | **dsh 以 npm 依赖（`@deepseek-ai/dsh`）内嵌进本项目的绿色包，用户不需要自行安装 dsh**；launcher spawn `node_modules/.bin/dsh web`。用户侧前置条件只有「装了 Node ≥22.19」 | 用户明确要求。核实过可行性：发布包 `@deepseek-ai/dsh` 的 `bin.dsh → lib/bin.js`，依赖里已含全部官方插件；两个原生依赖中 `node-addon-require-builtin` 是 optional，`landlock-run` 只提供 linux-x64/arm64 预编译二进制，Windows 上不参与 → 「解压即用」成立。**注意这只是分发方式，不改变 D3/D4**：仍然走 Web HTTP API + 隧道，仍然复用 dsh 自带 UI，**不是**改用 stdio JSON-RPC SDK 自研 UI（那条路已在 §3 废弃） |
| D14 | **dsh-remote 与官方 dsh 共用标准 `DSH_HOME`（默认 `~/.dsh`），但使用自己的 `dsh-remote-web` profile。** dsh-remote 内置插件只写进该 profile，不写 home 级全局 patch，也不写官方 `web` profile；launcher 不提供额外插件管理层，只负责确保极小的自有 profile 模板存在并启动它。 | 用户明确要求 launcher 保持精简并复用官方 dsh 的 settings/credentials/sessions 与 `$DSH_HOME/cordis.patch.yml`。因此 home 级全局 patch会自然应用于 dsh-remote；用户正常运行官方 `dsh web` 不加载本项目插件。若要让官方 `web` profile 使用本项目插件，用户按官方方式执行 `dsh plugin --profile web add <插件包>`；若要给 dsh-remote 增加第三方 bundle，则执行 `dsh plugin --profile dsh-remote-web add <插件包>`。 |
| D15 | **所有非本机浏览器访问统一要求正式认证；IP 单机模式与未来域名模式使用同一认证中间件。** 仅当 socket 来源是 loopback 且原始 Host 也是 loopback 时免登录。不存在 `allowInsecureLan`。 | 用户要求局域网 IP联调也不能成为无认证公网/LAN shell，并希望以后接域名时不更换认证方案。因此提前实现原 M2 的 SQLite 用户/会话、argon2id、TOTP、短 JWT + 可吊销 refresh cookie、限流。IP 联调使用 host-only cookie，域名部署配置共享 Cookie Domain；HTTP 局域网联调还需显式开发配置使用非 Secure cookie并打印警告，生产 HTTPS 使用 `__Secure-` + Secure。这些只是 cookie/传输配置，不改变认证流程。connector → relay 仍是独立的设备认证（M1 静态 token，M2 Ed25519）。 |

## 2.05 术语（唯一权威，写文案和代码注释都以此为准）

**坐标轴只有一条：能从哪个地址打开谁的 dsh。** 「加入」这个词已从全部中文文案里删除，
因为它的方向和控制的方向是反的（B 加入 A 之后，是 A 能打开 B），必然让人读反。

| 概念 | 用这个词 | 不要再用 |
|---|---|---|
| 提供地址、别的机器挂上来的那台 | **入口机器** | 集线器 |
| 它的浏览器地址 | **远程入口** | 集线器地址 |
| 挂上去的那台 | **通过 X 开放的机器** | 成员、成员机器 |
| 建立这层关系 | **把 X 挂到 Y 上**、**通过 Y 对外开放** | 加入、加入集线器、接入 |
| 解除这层关系（挂上去那台自己取消） | **取消远程入口** | 退出集线器 |
| 入口机器把挂在自己身上的机器踢掉 | **停止 X 并移除**（页面上就叫「停止…并移除」） | 吊销、摘下、解除授权 |
| 机器的名字（DNS 标签，如 `pc2`） | **机器名** | slug（只允许出现在代码和 CLI 参数里） |
| 页面文案里的第一人称 | **机器真名（pc1）** | 本机 |

代码标识符**不跟着改**：`hub`、`MembershipHub`、`membership.json`、`ADMIN_HUB_PATH`、
`membershipSchema` 保持英文原名——`hub` 在英文里没有这层歧义，改名只会制造一次无收益的大迁移。
`slug` 同理：字段名、`--slug` 参数、`machineSlugSchema` 一律不改，只换掉中文文案里的说法。
`revoke`、`ADMIN_REVOKE_PATH`、`device.revoked`、`DEVICE_REVOKED` 同样保持原名。

**为什么机器语境不再用「吊销」**：用户看到的后果不是「一张证书失效」，而是
**对方那台机器上的 dsh-remote 整个退出**（connector 致命退出，launcher 连带停掉 dsh 和 relay），
而且重启也回不来——必须由入口机器再签一次注册令牌。「停止」交代后果，「移除」交代不可逆，
缺一个都会被读成「关了还能再开」。
**「吊销」只保留在登录会话 / 令牌语境**（如「吊销了 N 个登录会话」），机器语境一律不用。

**必须反复出现的那句话**（README、控制台「机器」页、启动器 banner、packaging/README.txt 各有一份）：

> 每台机器都跑着自己的 dsh，AI 读写文件、执行命令都发生在**那台机器本地**。
> 打开 pc2 的页面，就是指挥 pc2 上的 dsh 动 pc2 的代码；pc1 只负责把请求转过去，自己什么都不执行。
> 「把 pc2 挂到 pc1 上」的意思是：以后从 pc1 的地址就能打开 pc2 的 dsh —— 反过来不行。

## 2.1 D16：mesh 拓扑与三种路由键

**每台机器都跑一整套 dsh + relay + connector**；任意一台都能当别人的入口机器。不存在中心化 relay。
一台机器**最多只有一个远程入口**，关系**单向**：谁挂到谁身上，就只能从后者的地址打开前者；
入口机器的控制台负责列出挂在它身上的机器，并能把其中任意一台停止并移除。
允许部分机器位于公网并使用域名 + HTTPS，其余机器留在局域网。

浏览器选择目标机器的路由键有三种，relay 按固定顺序解析：

| 顺序 | 路由键 | 适用 | 形态 |
|---|---|---|---|
| 1 | 子域名 | 配置了 `publicDomain` | `pc1.dsh.example.com` |
| 2 | **每机器一个端口** | 局域网，无域名 | `10.1.2.87:30810` |
| 3 | `directSlug` | 入口机器自己的 dsh | `10.1.2.87:30809` |

**为什么端口是合法的第三种路由键**：D7 只否决了子路径，理由是 dsh 把 `/api` 写死为绝对路径。
端口不触碰这个理由——`/api` 仍是绝对路径，但每台机器有独立 origin，各自解析到各自的 dsh。
dsh 的 `--trusted-host` 允许 port-less 条目匹配任意端口，模式 A 因此不受影响。

**端口不会阻碍以后接域名**：机器模型、设备认证、隧道协议都不变，改变的只有 relay 如何把请求解析成 slug。
接了域名之后改用 443 + 子域名，不再分配端口；证书绑定主机名而非端口，两者不冲突。
迁移代价只有书签变化，而切换机器本来就走控制台。

**已知取舍**：cookie 作用域不含端口（RFC 6265），所以同一主机的所有端口共享登录态。
登录一次即可打开挂在这台入口机器上的全部机器是体验优势，但浏览器层面机器之间没有隔离。
relay 是同一进程、同一登录用户，因此接受这一点；域名模式下配置了 Cookie Domain 时同样共享。

**模式 A 的连带要求**：浏览器发给被开放机器的 Host 是**入口机器的 authority**（如 `10.1.2.87:30810`），
原样转发后由那台机器的 dsh 校验，因此它的 dsh 必须 `--trusted-host` 信任入口机器的地址。
入口机器地址变化（如 DHCP 换 IP）需要被开放的机器重启 dsh。

## 2.2 D17：dsh 的扩展一律做成插件，首个插件把完整界面还给已认证的远程浏览器

**插件是本项目扩展 dsh 的唯一方式**（dsh 官方推荐）：不 fork、不改源码（铁律 1）、
也不在 relay 里改写 dsh 下发的东西（铁律 2）。所有插件住在 `packages/plugins/<名字>/`，
包名 `@dsh-remote/dsh-plugin-<名字>`。

**装载方式（不碰用户的 profile）**：每个插件包根携带一份 `dsh-overlay.yml`，
launcher 启动 dsh 时把它们逐个传成 `--patch`（`dsh --profile dsh-remote-web --patch <overlay>`）。
overlay 里用相对路径 `./dist/index.js` insert 插件，dsh 会把它锚定到 overlay 所在目录。
因此：不写 home 级 patch、不改用户的 `cordis.patch.yml`、不需要发布到 npm（D14 不变）。
插件缺失或未构建时 launcher **拒绝启动**，不静默降级。

**首个插件 `remote-privileged`**：向 dsh 首页注入 `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`
（走 dsh 官方的 `webserver/index-inject` 表），让非 loopback 页面拿回设置能力。
**默认开启，没有开关**（用户拍板）：能打开这个页面的人已经过了 relay 的密码 + TOTP，
而且在同一个页面里本就能开会话跑 `bash`，“不能改设置”从来不是一道隔离边界。
它**不碰** `/api` 的 browser-trust fence（模式 A 原样保留），**不伪造任何头**。

已知代价：`ownsHost` 是全局标志，一开也同时放出了「用系统程序打开设置文档 / 文件」这类
动作，而它们发生在**被控机**上，远程点了等于无声失败；以及 dsh 源码注释说这个标志是给
「自己组装 transport 的 shell」用的，升级 dsh 时必须重新核实（已计入 §4 风险表）。

## 3. 已废弃的方案（不要再提，不要再评估）

以下方案在前期讨论中已被逐一排除，**新会话不要重新提出**：

### ❌ VS Code Remote Tunnel（`code tunnel` + vscode.dev）
手机 Safari 上加载慢、内存受限、切 App 掉线。vscode.dev 是几十 MB 的完整 IDE，per-keystroke RTT，体验不可接受。这是本项目诞生的起因。

### ❌ 嵌套远程（tunnel 到家里电脑，再从里面 Remote-SSH 到服务器）
VS Code 一个窗口只能有一个 remote authority，官方不支持 nested remote。

### ❌ Happy Coder（slopus/happy）
架构高度匹配（CLI 包装 + relay + E2EE + 移动端），但 agent 运行时是 Claude Code / Codex / ACP，与 D1（用 dsh）冲突。**若 dsh 路线受阻可作为备选参考其设计**，但不作为实现基础。

### ❌ Omnara
定位是「自建 agent 运行平台」，不是遥控器；无移动端客户端。

### ❌ opencode / AgentAPI / claude-code-webui / vibetunnel
与 D1 冲突，或只是本地 server 无中转层。

### ❌ Tailscale / Headscale / frp / Cloudflare Tunnel
方案本身没问题，但要求安装额外二进制客户端，违反 D9。

### ❌ Electron 桌面壳（含 Linux 无头 Electron）
收益经逐条核算后只剩「双击即用」和「自动更新」两项，而代价是：原生模块 ABI 需 `electron-rebuild`（dsh 依赖 `node-addon-require-builtin`、`native/landlock-run`）、子进程环境复杂（dsh 大量 spawn bash/pwsh/PTY/pnpm）、多一条构建签名管线。
「双击即用」由 D6 的启动器解决，「独立窗口」由浏览器 PWA 安装解决。
**Linux 无头跑 Electron 尤其不可取**：Electron 二进制链接 libgtk-3/libnss3/libX11，需额外装 GUI 库和 xvfb/`--no-sandbox`，为一只永不显示的 Chromium 付 150MB。
→ 结论：**M6 之前不碰 Electron**，且很可能永远不需要。

### ❌ Node SEA / 单文件 exe 打包
dsh 的 profile 机制依赖磁盘上真实的 `node_modules`（插件按包名动态解析，`dsh plugin` 转发给 pnpm），静态打包会破坏它。绿色包（目录形态）是正解。

### ❌ 自己写一套 Agent 运行时抽象层（`AgentAdapter`）
前期设计过一个「协议层 + 适配器 + 自研 UI」的五包架构。在确认 dsh 的 Web 传输是标准 HTTP + WebSocket 之后，**隧道方案让这一整层变得多余**。不要再引入这层抽象。

### ❌ 端到端加密（v1 范围内）
中转服务器是用户自己的；且 Web UI 由中转下发，被攻破的中转可以下发窃取密钥的 JS，E2EE 在这种架构下防护有限。协议里预留位置，v1 不实现。

## 4. 关键风险（必须持续关注）

| 风险 | 说明 | 缓解 |
|---|---|---|
| **dsh 破坏性变更** | 0.1.2-alpha，官方明说会破坏性变更 | D3 的隧道方案只依赖「dsh 起一个 HTTP server」这一事实，是 dsh 最不可能变的部分（0.1.2 把两条下行 WS 合并成 `/api/remote.mux`，转发层果然一行没改） |
| **dsh 自带的浏览器认证** | 0.1.2 新增：`/api` 与首页没有 `dsh-auth-*` cookie 就 401，token 只在 dsh 启动输出里 | launcher 截获 token → connector 上报 → relay 代跑一次 `?token=` 交换（[02-dsh-facts.md](02-dsh-facts.md) §4.6）；token 取不到时只影响登录体验，不影响隧道 |
| **dsh 把「操作者在不在本机」判定搬到了客户端** | 0.1.2 按 `location.hostname` 决定 settings 能不能写，远程页面的模型 / 插件配置页废掉 | 已用官方的 `ownsHost` 逃生门修复（D17）。**它是非预期用法**：官方注释说该标志只给自己组装 transport 的 shell，升级 dsh 时必须重跑 `§4.7` 的核实步骤 |
| **「打开工作区」在有桌面的机器上远程不可用** | `directory-picker-auto` 在 Windows/macOS 上判定 `native`，对话框弹在被控机桌面（[02-dsh-facts.md](02-dsh-facts.md) §4.8） | **未修**。官方固定方式是在 patch 里直接组合 `-browse` 行；无头服务器不受影响 |
| **dsh Web 自己不提供传输安全** | 官方原话：`there is no TLS, auth, or origin policy` | 开发机永远只 bind `127.0.0.1`；认证与 TLS 全部由中转承担 |
