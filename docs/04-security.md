# 04 · 安全与认证

## 0. 一句话威胁模型

> 中转服务器上的一个 URL，等价于被控机器上的一个**无密码 root shell**（在该用户权限下）。
> dsh 自己不提供任何认证。**relay 的认证是唯一防线。**

## 1. 必须理解的三个事实

### 1.1 dsh Web 没有认证

`docs/subsystems/web-server.md` L41 原文：

> there is no TLS, auth, or origin policy, so a non-loopback bind exposes the server to that network.

`packages/client/connection/README.md`：

> The fence is a reachability policy, not authentication.

dsh 0.1.2 另外给自己加了一层浏览器认证（启动 token 换 `dsh-auth-*` cookie，见
[02-dsh-facts.md](02-dsh-facts.md) §4.6）。**它不是本项目的防线**：它只能证明“浏览器拿到过那个
token”，而 token 是 relay 在用户登录成功后主动递给浏览器的。真正把关的仍是 relay 的认证。

### 1.2 只有模式 A，模式 B 已删除

dsh 0.1.1 及以前把 15 个方法钉死在 loopback（即使声明 `trustedHosts` 也够不到），
模式 B（把 Host 改写成 loopback）存在的唯一理由就是解锁它们。
**dsh 0.1.2 删掉了这份名单**（`PRIVILEGED_METHODS` 已不存在），所以：

- 模式 A 下设置页、凭据页、模型发现直接可用，不再需要任何开关
- 保留模式 B 只剩下“关掉 dsh 自带的 rebinding 防御”一个效果 → `unlockPrivileged` 已从代码与文档中删除

**不要高估 fence 的保护。** dsh 源码注释自己写了：

> the deployment's own default already carries `bash` and the filesystem tools, so **any caller that may start a session at all can already run commands as this process. Pinning the switch would be a fence beside an open gate.**

即：任何能创建会话的人都能跑 `bash`，照样能 `cat` 出凭据文件。
**「relay 认证被突破」就等于完全失守**，dsh 那层只是多一步。

选模式 A 的真正理由是工程性的，不是安全性的：
1. 它是官方支持路径，将来 dsh 若加 socket 层校验不会把你打死
2. relay 不用改写头，少一类出错可能
3. 日常需求（看进度 + 发指令 + 批准）完全不受影响

### 1.3 connector 是拨出的，所以被控机没有攻击面

connector 主动连 relay，被控机不监听任何公网端口，不需要端口映射。
**这消除了「家里电脑被扫描」这一整类风险** —— 攻击者只能攻击 relay。

## 2. 认证设计（三层）

### 第 1 层：机器接入（connector → relay），用公钥

**不要用共享密码。** 一台机器泄露会导致全线沦陷，且无法单独把某一台停掉。

```
1. connector 首次启动生成 Ed25519 密钥对
   私钥存 ~/.dsh-remote/device.key，文件权限 600（Windows 上用 ACL 限制到当前用户）
2. 管理员在管理页 `/_admin` 生成注册令牌：
   一次性，固定 **5 分钟**有效（像短信验证码，不可配置）；库里只存哈希，
   用掉 / 吊销时整行删除，过期的在下次签发时清掉
3. connector 首次连接时携带该令牌 + 公钥 + 期望的 slug，完成注册
4. 之后每次连接走签名挑战：relay 发 nonce → connector 用私钥签名 → relay 用已存公钥验签
```

实现：`node:crypto` 内置 Ed25519，无需第三方。

```ts
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const sig = crypto.sign(null, nonceBuffer, privateKey)
const ok  = crypto.verify(null, nonceBuffer, publicKey, sig)
```

好处：无长期共享密钥；机器丢失可单独把那一台停止并移除（删掉它的公钥）；审计日志能区分机器。

### 第 2 层：人类登录（浏览器 → relay）

**v1：密码 + TOTP + 短期 JWT**

| 项 | 方案 |
|---|---|
| 密码哈希 | `@node-rs/argon2`，argon2id |
| 密码策略 | **至少 6 个字符，且大写 / 小写 / 数字 / 其他字符四类里至少占三类**（用户拍板，从“至少 12 个字符、不限组成”改来）。显式接受的风险见 §6 |
| 二次因子 | `otplib` TOTP，首次登录扫码绑定 |
| 会话 | `jose` 签发 JWT，**15 分钟**有效；配 httpOnly + Secure + SameSite=Lax 的 refresh cookie（30 天，可吊销） |
| Cookie 作用域 | `Domain=.dsh.example.com`（要跨子域名共享会话） |
| 限流 | `rate-limiter-flexible`，登录接口 5 次失败锁 15 分钟，按 IP + 按账号双维度 |
| 注册 | **关闭开放注册**。`dsh-remote-relay init` 创建唯一管理员；多用户靠邀请令牌 |

⚠️ Cookie 必须设 `Domain=.dsh.example.com` 才能在 `pc1.dsh.example.com` 上生效。
配套：**必须开 `__Host-` 前缀做不到（它禁止 Domain），改用 `__Secure-` 前缀 + 严格的 CSRF 防护。**

CSRF：relay 自己的管理接口用 double-submit token；转发给 dsh 的请求不需要额外 CSRF（dsh 的 Origin 检查在重写后仍然生效，且 Origin 被强制改成 loopback，等于关掉了这层 —— 所以 **relay 侧必须自己校验原始 Origin**，见 §3）。

**后续可选**：OIDC/GitHub OAuth（`openid-client`）、Passkey/WebAuthn（`@simplewebauthn/server`）。接口抽象好，加它们不用改数据模型。

### 第 3 层：人 ↔ 机器绑定

- relay 存 `user_machines` 关联表
- 管理页显示「我的机器」列表 + 在线状态
- 一个用户没绑定的 machine slug，即使猜到子域名也返回 404（不泄露机器是否存在）

### 2.1 本机免登录与统一的非本机认证（D15）

IP 单机模式和域名多机模式不使用两套认证。relay 只在以下两个条件**同时成立**时允许免登录：

1. TCP socket 的实际来源是 loopback；
2. 原始 `Host` 的 hostname 也是 loopback（`localhost` / `127.0.0.0/8` / `::1`）。

这意味着：

- 本机 `http://127.0.0.1:<port>` 可作为开发便利入口；
- 局域网 `http://192.168.x.x:<port>` 必须登录；
- 未来 Caddy 从 loopback 转发域名请求时，虽然 socket 是 loopback，但原始 Host 不是，因此仍必须登录；
- 不信任 `X-Forwarded-For` 来决定免登录，避免反代配置错误造成绕过；
- 不提供 `allowInsecureLan`。

IP 联调时 session cookie 是 host-only；域名部署时配置 `Domain=.dsh.example.com` 供子域共享。登录、TOTP、JWT/refresh、吊销和限流逻辑不变。

⚠️ `http://<LAN-IP>` 没有 TLS，登录密码和 session cookie 可能被同网段监听。它只能作为显式的开发联调模式：使用普通的 host-only 非 Secure cookie并在启动时打印高危警告。生产域名必须切回 `__Secure-` 前缀 + `Secure`；这是传输/cookie 配置变化，不是另一套认证。

## 3. relay 必须自己做的检查

下列检查必须在 relay 做，因为路由判断本来就在 relay，且不能依赖隔着隧道的 dsh：

| 检查 | 做法 |
|---|---|
| 原始 `Host` 校验 | 必须是已知的 slug 子域名或管理域，否则 404 |
| 原始 `Origin` 校验 | 若请求带 `Origin`，必须等于 `https://<slug>.dsh.example.com`，否则 403 |
| `sec-fetch-site` | `cross-site` 直接拒（与 dsh 原策略一致） |
| WebSocket 升级 | 同样做上述三项检查后才允许升级 |

**顺序不能错：会话认证 → relay 侧安全检查 → 入隧道（头原样转发）。**

### 3.0 dsh 登录 token 的处理

relay 会在“dsh 对首页回 401”时给浏览器一个 303 `…/?token=<dsh token>`（见 02 文档 §4.6）。约束：

| 项 | 做法 |
|---|---|
| 时机 | **先过 relay 自己的认证**，才可能看到 401，才会发 token；未登录的浏览器拿不到 |
| 范围 | 只对 `GET /` 与 `/index.html` 重定向；`/api` 的 401 原样透传（那是页面自己要处理的） |
| 防循环 | 已带 `token` 参数的请求不再重定向 |
| 防泄露 | 重定向响应带 `referrer-policy: no-referrer` 与 `cache-control: no-store`；dsh 自己的 303 同样如此 |
| 存储 | token 只存在 relay 内存里（挂在当前控制信道上），**不写数据库、不进日志** |

### 3.1 认证之前就回答的公开路径

只有两类，都是**构建期固定字节**，不读数据库、不反射任何机器状态，也不进隧道：

| 路径 | 为什么不能要求登录 |
|---|---|
| `/manifest.webmanifest` | 浏览器按规范**不带凭据**取它；重定向到 HTML 登录页只会让它解析失败 |
| `/_icon/dsh-remote.{svg,ico,png}` | 同上，而且**登录页自己就要显示图标** —— 登录前拿不到就没图标 |

图标故意放在 `/_icon/` 而不是 `/favicon.ico`：后者是隧道对面 dsh 前端的路径，
relay 不去遮盖它（铁律 2）。新增公开路径前先问一句：它的字节会因机器、用户或配置而变吗？
会变就不能公开。

> 模式 A 下 dsh 会再校验一次 Host/Origin，并且还要求它自己的 cookie，属于纵深防御；
> 但 relay 不能因此省掉自己的检查，因为路由判断本来就在 relay。

## 4. 部署要求

| 项 | 要求 |
|---|---|
| TLS | 必须。泛域名证书 `*.dsh.example.com`。推荐 Caddy 自动 DNS-01 |
| HSTS | `max-age=31536000; includeSubDomains` |
| 端口 | relay 只监听 `127.0.0.1:<port>`，由 Caddy/nginx 反代。不要直接暴露 |
| 系统加固 | relay 进程用非 root 专用用户运行；systemd 加 `ProtectSystem=strict` 等 |
| 备份 | SQLite 文件（含设备公钥、用户、绑定关系）定期备份 |

## 4.1 发行包不能带出内网痕迹

绿色包是 `pnpm deploy` 出来的一整棵 `node_modules`，里面有两个**运行时用不到、但会记下当时解析用的 registry** 的
pnpm 账本文件：

| 文件 | 泄露内容 |
|---|---|
| `node_modules/.modules.yaml` | 一行 `default: <registry>` |
| `node_modules/.pnpm/lock.yaml` | 每个包一条 `tarball: <registry>/...`（几百条） |

在公司内网镜像后面打的包，等于把内部 Artifactory 地址随发行包发出去。`scripts/pack.mjs` 的
`isPnpmBookkeeping` 在进 zip 时把这两个文件挡掉（Node 的模块解析从不读它们，真正的包目录与
符号链接都在 `.pnpm/<name>@<ver>/` 下，照旧保留）。

`.npmrc` 的 `lockfile-include-tarball-url=false` 管的是仓库里那份 `pnpm-lock.yaml`，管不到
deploy 产物——两道口子要分别堵。**换镜像源或换打包方式后，用「解开 zip 搜一遍公司域名」验一次。**

## 5. 审计日志（必做）

每条记录时间、用户、机器、动作、源 IP：

- 登录成功 / 失败
- 设备注册 / 停止并移除
- 隧道建立 / 断开
- **审批请求与结果**（M5 之后）

写两处，一次调用写完（`packages/relay/src/audit/recorder.ts`）：

| sink | 用途 |
|---|---|
| SQLite `audit_log` 表（`relay.db`） | 权威副本，可查询，**永不自动过期**（清理是显式运维动作） |
| `pino` JSON 行（带 `audit: true`） | 跟流量日志在同一条流里，用来对时间线 |

**不给它做页面**（用户拍板）：审计记录是写给事后排查的人（或 AI）看的，不是日常用户
在手机上翻的东西。控制台曾经有过 `/_admin/audit` 和机器页预览，已删除。
怎么查、怎么判风险见 skill `relay-audit`（`.agents/skills/relay-audit/SKILL.md`）。

## 6. 显式接受的风险

| 风险 | 决定 |
|---|---|
| relay 被攻破 → 被控机完全沦陷 | 接受。bash 即 RCE；缓解靠强认证 + TOTP + 限流 + 审计 |
| 密码下限从 12 位降到 6 位（改用“四类字符取三类”补偿） | 接受（用户拍板）。代价是单密码的猜解空间明显变小；守住的东西变成 **TOTP 必开 + 5 次失败锁 15 分钟（IP 与账号双维度）**，且 relay 不得裸暴在公网 HTTP 上。副作用：纯小写的长口令短语（如 `correct horse battery staple`）也会被拒，因为组成规则无条件生效 |
| 已登录用户可以访问设置/凭据页 | 接受。服务端本就不按 loopback 区分；客户端那道 gate 由 `remote-privileged` 插件主动解除（D17）——反正能开会话就能跑 shell |
| 插件把 `ownsHost` 写死为 true，没有开关 | 接受（用户拍板）。它只在已认证的页面里生效，不碰 fence、不改头；代价是「在被控机上用系统程序打开文件」这类动作也会被放出来，远程点了等于无声失败 |
| dsh 登录 token 会出现在浏览器 URL 里 | 接受。同源重定向 + `no-referrer`，且只发给已登录会话；dsh 马上把它换成 HttpOnly cookie 并跳回干净 URL |
| 无 E2E 加密 | 接受（v1）。relay 是用户自己的服务器；且 UI 由 relay 下发，E2EE 在此架构下防护有限 |
| 隧道内明文 HTTP | 接受。外层 WSS 已加密，内层是 relay ↔ 本机 loopback |
| dsh 自身的沙箱能力有限（Windows 上尤其） | 接受。这是 dsh 的问题，不是本项目的 |
| 常驻服务跑在沙箱之外，且活过会话与 dsh 进程 | 接受，**但加了一道门**。`packages/plugins/services` 用 `node:child_process` 直接 spawn，绕过 web profile 那个真会约束的 `pwsh-sandbox`（Windows 上是 ACL 受限令牌）。这不引入新的风险**类别**（§6 第一行已接受「bash 即 RCE」），但会让「用户选了 `read-only` / `workspace-write` 预设」变得名不副实，所以 `service_start` / `service_restart` 读会话解析出的沙箱模式：`danger-full-access` 不问（`bash` 本来就给了同样能力，再弹一次只是仪式），**任何受限模式都走 `ctx.approval` 征求人工批准、只有 `allowed-once` 放行**，受限但没有批准服务 / 没有归属会话一律 fail closed。面板上**刻意没有「启动」按钮** —— 「页面上一个能在沙箱外跑任意命令的输入框」和「一个能停掉你已经看得见的东西的按钮」性质不同，创建只能走带批准门的工具。配置项 `approvalInConfinedSandbox` 可以关掉这道门，关掉等于明确接受服务静默逃逸 |
| 页面上有一个能往真 shell 里打任意文本的输入框 | 接受，**边界写死在通道上**。`packages/plugins/terminal` 的面板输入框等同于远程执行任意命令，但它**不引入新的风险类别**（§6 第一行已接受「bash 即 RCE」），也**不绕过沙箱**——与 `services` 不同，本插件自己不 spawn：`terminal-bash` 在 `danger-full-access` 以外的每种模式下都先 `ctx.sandbox.confine()` 再启动 shell，所以受限预设下开出来的终端与 dsh 自己的 `bash` / `pwsh` 工具受同一套约束（docs/02 §14.7），因此**不需要再加一道批准门**。真正划的那条线是**面板不能创建能力**：通道只有 `list` / `read` / `send` / `interrupt`，**没有 `open` / `close`** —— 造一个 shell 只能走 turn 里的 `terminal_open`，那里有转录记录也有审批栈。冒烟脚本里有两条专门锁死通道上不存在 `open` / `close` |

## 7. 给使用者的安全须知（要写进最终 README）

> 通过本工具，任何拿到你 relay 账号的人都能在你的机器上执行任意命令、读写任意文件、读取你配置在 dsh 里的所有 API Key。
> - 必须开启 TOTP 二次验证
> - 密码不要与其他站点复用
> - 公用设备上用完立即登出
> - 定期检查「我的机器」列表；怀疑出事时到跑 relay 的机器上查安全记录（日志 + `relay.db`）
> - 不用的机器及时停止并移除
