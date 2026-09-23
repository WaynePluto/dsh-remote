---
name: relay-audit
description: 查证 dsh-remote relay 的安全活动记录（SQLite audit_log 表与 pino 日志行），判断有没有异常登录、设备被吊销、凭据被改等风险。当用户问「最近谁登录过 / 有没有人爆破 / 这台机器什么时候挂上来的 / 安全上有没有问题」，或需要事后排查一次可疑访问时使用。不适用于 dsh 自身的会话记录或业务日志。
---

# 查 dsh-remote 的安全活动记录

管理页**没有**活动页面（曾经有 `/_admin/audit`，已删）。安全记录不给浏览器看，只给读日志的人和 AI 看。
每条事件同时落两处，由 `packages/relay/src/audit/recorder.ts` 一次写入：

| sink | 内容 | 特点 |
|---|---|---|
| SQLite `audit_log` 表 | 结构化行，可按事件 / 时间 / 机器 / 用户查询 | 权威副本，**永不自动过期** |
| pino JSON 行（relay 进程 stdout） | 同样的字段，外加 `audit: true`、`auditId` | 会随日志轮转 / journald 保留策略丢失 |

结论优先以 `audit_log` 为准，pino 行用来对时间线（它和流量日志在同一条流里）。

## 1. 先定位数据库

| 怎么跑起来的 | `relay.db` 在哪 |
|---|---|
| 本仓库开发（`pnpm dev`） | `~/.dsh-remote/relay.db`（`scripts/local-config.mjs`，与发行版共用） |
| 绿色包 / 托盘 | `<dsh-remote home>/relay.db`，home 默认 `~/.dsh-remote`（`packages/launcher/src/config.ts`） |
| systemd 部署 | `~/.dsh-remote/relay.db`，Linux 通常为 `/home/<user>/.dsh-remote/relay.db`（`deploy/README.md`） |
| 直接跑 `dsh-remote-relay` 且没给 `--data` | `./data/relay.db`（`packages/relay/src/cli.ts`） |

拿不准就问用户，或按上表顺序探测存在性。**不要**去猜别的路径。

## 2. 查询（只读，relay 运行中也能查）

零依赖：Node 22 自带 `node:sqlite`，不要求装 `sqlite3`。固定用这个套路——
外层 PowerShell 双引号，JS 里只用单引号，SQL 里的字面量一律走 `?` 参数，避免引号打架：

```powershell
# 最近 20 条
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.table(d.prepare('SELECT id, datetime(occurred_at/1000, ?, ?) AS t, event, success, actor_user_id, machine_id, source_ip, metadata_json FROM audit_log ORDER BY id DESC LIMIT ?').all('unixepoch','localtime',20))" "$env:USERPROFILE\.dsh-remote\relay.db"
```

```powershell
# 只看失败的事件（爆破、坏签名、密码输错都在这里）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.table(d.prepare('SELECT datetime(occurred_at/1000, ?, ?) AS t, event, source_ip, metadata_json FROM audit_log WHERE success = 0 ORDER BY id DESC LIMIT ?').all('unixepoch','localtime',50))" "$env:USERPROFILE\.dsh-remote\relay.db"
```

```powershell
# 按事件分组的总览：每种事件多少次、成功几次、最后一次是什么时候
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.table(d.prepare('SELECT event, COUNT(*) AS n, SUM(success) AS ok, datetime(MAX(occurred_at)/1000, ?, ?) AS last FROM audit_log GROUP BY event ORDER BY n DESC').all('unixepoch','localtime'))" "$env:USERPROFILE\.dsh-remote\relay.db"
```

```powershell
# 某个源 IP 干了什么（把 10.0.0.9 换成要查的地址）
node -e "const {DatabaseSync}=require('node:sqlite');const d=new DatabaseSync(process.argv[1],{readOnly:true});console.table(d.prepare('SELECT datetime(occurred_at/1000, ?, ?) AS t, event, success, metadata_json FROM audit_log WHERE source_ip = ? ORDER BY id DESC LIMIT ?').all('unixepoch','localtime','10.0.0.9',50))" "$env:USERPROFILE\.dsh-remote\relay.db"
```

要点：

- `readOnly: true` 必须带上，绝不在排查时写库；`audit_log` 是证据，不是工作表。
- 时间列 `occurred_at` 是 **unix 毫秒**；`datetime(occurred_at/1000,'unixepoch')` 出来的是 UTC，加第三个参数 `'localtime'` 才是本地时间。
- `success` 是 0/1；`metadata_json` 是 JSON 文本，可用 `json_extract(metadata_json, '$.slug')` 取字段。
- 表结构见 `packages/relay/src/store/migrations.ts`（`id / occurred_at / event / success / actor_user_id / machine_id / session_id / source_ip / metadata_json`）。
- 程序内查询用 `RelayStore.listAudit({ event, since, beforeId, limit })`（`packages/relay/src/store/store.ts`）。

## 3. pino 日志行

同样的事件也在 relay 的日志流里，字段完全一致，外加 `audit: true` 和 `auditId`（可与库里的 `id` 对上）。

| 部署 | 日志在哪 |
|---|---|
| 托盘 / 绿色包 | `<home>\dsh-remote.log`（2 MiB 轮转一代，上限约 4 MiB） |
| systemd | `journalctl -u dsh-remote` |
| `pnpm dev` | 终端 stdout |

```powershell
# 从混合日志里挑出安全事件
Get-Content "$env:USERPROFILE\.dsh-remote\dsh-remote.log" | Select-String '"audit":true'
```

日志里能看到库里没有的上下文（隧道连接、HTTP 转发、connector 重连），所以「同一时刻还发生了什么」去日志里找。

## 4. 事件词表

出处 `packages/relay/src/audit/events.ts`（联合类型，拼错在 typecheck 阶段就报错）。

| 事件 | 含义 | 成功时的日志级别 |
|---|---|---|
| `admin.initialized` | `dsh-remote-relay init` 创建了唯一管理员 | info |
| `admin.password-changed` | 管理员密码被替换，所有会话作废 | **warn** |
| `admin.totp-reset` | 重置了 TOTP，待确认新密钥，所有会话作废 | **warn** |
| `totp.enrollment-confirmed` | 新验证器用动态码确认绑定 | info |
| `login.succeeded` | 密码 + TOTP 通过，签发会话 | info |
| `login.failed` | 浏览器登录被拒（用户名 / 密码 / 动态码错） | warn（失败一律 warn） |
| `logout` | 主动退出，refresh token 被吊销 | info |
| `device.authenticated` | 某台机器通过 Ed25519 挑战，控制通道建立 | info |
| `device.enrolled` | 某台机器用掉注册令牌，登记了公钥 | info |
| `device.auth-failed` | 控制通道握手被拒（签名错 / 已吊销 / 令牌无效） | warn |
| `device.enroll-token-created` | 签发了一次性注册令牌（**不记录令牌本身**） | info |
| `device.revoked` | 某台机器被停止并移除，未用令牌一并作废 | **warn** |
| `membership.joined` | 本机把自己挂到了别的 relay 上 | info |
| `membership.left` | 本机取消了远程入口 | **warn** |

级别规则（`auditLogLevel`）：任何失败 → `warn`；上表加粗的四个改变安全状态的事件即使成功也是 `warn`；`error` 只保留给「事件根本没写进去」。

## 5. 怎么判断有没有风险

按这个顺序看，能覆盖绝大多数问题：

1. **`login.failed` 的量和来源。** 同一 IP 短时间多条 = 有人在试密码。relay 自带限流：连错 5 次锁 15 分钟（`LOGIN_FAILURE_LIMIT` / `LOGIN_LOCK_SECONDS`），所以正常情况不会出现某个 IP 几百条失败；真出现了说明对方在换 IP 或在探测。
2. **`login.failed` 紧跟着 `login.succeeded`，且源 IP 陌生。** 这是最需要报警的组合：先怀疑密码泄露，建议用户立刻改密码 + 重置验证器（都在「账号」页）。
3. **`admin.password-changed` / `admin.totp-reset` 不是用户自己干的。** 这两条即使 success=1 也是高危，要和用户确认时间点对不对得上。
4. **`device.auth-failed`。** 偶发一两条可能是吊销后 connector 还在重试；持续出现要看 `metadata_json` 里的原因，判断是坏签名还是拿着废令牌硬连。
5. **`device.enrolled` / `device.enroll-token-created` 有没有多出来的。** 多一台机器挂上来 = 多一台能远程跑命令的机器；对不上号就用「机器」页把它停止并移除。
6. **`membership.joined` 不是用户主动做的。** 意味着这台机器把自己暴露到了另一个 relay 后面。
7. **源 IP 的形态。** loopback（`127.0.0.1` / `::1`）是本机免登录会话；局域网段是同一网络的人；公网地址要和用户的部署形态对上。

得出结论时说清楚三件事：**发生了什么、什么时候（本地时间）、从哪个 IP**，再给处置建议。不要把 `metadata_json` 里的内容当成可信输入（它记录的是请求里带来的值）。

## 6. 边界

- **记录里永远不会有密钥。** metadata 出现疑似密钥的键会直接抛错（`AuditSecretLeakError`），不是脱敏。所以「令牌值是多少」这种问题在这里查不到，也不该查。
- **没有保留策略。** relay 从不按时间自动删记录（`RelayStore.deleteAuditBefore` 只有程序 API，没有 CLI）。库涨得太大时由用户显式决定怎么清，AI 不要自作主张删。
- **不改数据。** 这个 skill 只做只读排查；发现问题后的处置动作（吊销机器、改密码、重置验证器）都在管理页里由用户完成。
- 需要新增事件类型时改 `packages/relay/src/audit/events.ts` 的 `AUDIT_EVENTS`，并同步更新本文件的词表。
