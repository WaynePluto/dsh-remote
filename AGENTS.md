# AGENTS.md

本文件给在 `d:\Documents\ai-dev\dsh-chat` 目录下工作的 AI 编码助手看。（目录名沿用旧名，仓库 / 包 / 产物已改名为 dsh-remote；若你把目录改名为 dsh-remote，请同步更新这一行。）

## 项目是什么

给 **DeepSeek Harness (dsh)** 加一层「带认证的反向隧道」，让手机 / 异地电脑能通过浏览器远程指挥跑在开发机上的 dsh。

## 开始工作前必须做的三件事

1. 读 [docs/05-roadmap.md](docs/05-roadmap.md)，确认当前进度和下一项任务
2. 读 [docs/01-decisions.md](docs/01-decisions.md) §3「已废弃的方案」，**不要重新提出已排除的方案**
3. 涉及 dsh 行为时，读 [docs/02-dsh-facts.md](docs/02-dsh-facts.md)，那里的每条结论都标了源码路径；需要翻 dsh 源码时先加载 skill `dsh-source`（`.agents/skills/dsh-source/SKILL.md`），本地路径只记在那里

## 铁律

| # | 规则 |
|---|---|
| 1 | **不改 dsh 源码，不 fork dsh。** dsh 是 0.1.2-alpha，任何源码耦合都会持续返工 |
| 2 | **中转服务器不解析 dsh 的业务协议。** 它只搬运 HTTP/WebSocket 字节（唯一例外：把 dsh 对首页的 401 换成一次 `?token=` 重定向） |
| 3 | **connector / launcher 侧零原生模块。** 用 `node:sqlite`，不用 `better-sqlite3`；绿色包必须解压即用 |
| 4 | **dsh 永远只 bind 127.0.0.1。** dsh 自带的浏览器认证不是我们的防线，relay 才是 |
| 5 | **approval policy 用 `'ask'`，绝不用 `'never'`**（`'never'` 是全部拒绝，不是 YOLO） |
| 6 | 一台被控机 = 一个子域名，**不要试图挂子路径**（dsh 把 `/api` 写死成绝对路径） |
| 7 | **只有模式 A：原样转发 Host，dsh 侧用 `--trusted-host` 声明。** relay 永不重写 Host/Origin（模式 B / `unlockPrivileged` 已删除） |
| 8 | 优先用成熟第三方依赖，不重复造轮子（用户明确要求） |
| 9 | 每完成一个 roadmap 条目立刻改 `- [x]`，不要攒着批量勾 |
| 10 | **与官方 dsh 共用标准 `DSH_HOME`，但只在 `dsh-remote-web` profile 中加载项目内置插件。** 不写 home 级 patch、不修改官方 `web` profile；launcher 不重复实现 dsh 的插件管理 |
| 10b | **扩展 dsh 只能写插件，插件全部放在 `packages/plugins/<名字>/`**（包名 `@dsh-remote/dsh-plugin-<名字>`）。每个插件包根携带 `dsh-overlay.yml`，launcher 用 `--patch` 传给 dsh；overlay 里只写相对路径 `./dist/index.js`，**永远不写绝对路径**（见 D17） |
| 11 | **所有非本机浏览器访问必须认证。** 只有 loopback socket + loopback Host 同时成立才免登录；IP 与域名复用同一认证中间件，不提供 `allowInsecureLan` |
| 12 | **中文用户可见文案只用 [docs/01-decisions.md](docs/01-decisions.md) §2.05 的词表。** 「集线器 / 成员 / 加入 / 接入」已全部废弃；页面里不写「本机」，写机器真名。代码标识符（`hub`、`membership.json`）保持英文原名，不跟着改 |

## 环境

| 项 | 值 |
|---|---|
| OS | Windows，Shell 是 **PowerShell 7**（不要写 bash / CMD 语法） |
| Node | v22.19.0 |
| pnpm | 10.17.0 |
| dsh 源码 | 位置见 skill `dsh-source`（`.agents/skills/dsh-source/SKILL.md`）——**不要在其他文件里写死本地路径** |

## 技术栈

TypeScript + ESM + pnpm workspace，构建 `tsdown`，开发 `tsx`。
依赖选型见 [docs/03-architecture.md](docs/03-architecture.md) §6，不要随意替换。

## 依赖版本与提交前检查

- **所有 package.json 的直接依赖必须写固定版本号**，不允许 `^` / `~` / 范围 / dist-tag。
  `.npmrc` 已设 `save-exact=true`，新增依赖用 `pnpm add <pkg>` 即为精确版本。
- 体检命令：`pnpm check:dependencies`（脚本 `scripts/check-dependency-versions.mjs`，覆盖根与 `packages/**`）。
- `.husky/pre-commit` 在每次提交前跑两件事：① 上面的固定版本号检查；② 从 `pnpm-lock.yaml` 剥离
  内网镜像 tarball 地址，保证 lockfile 可移植。克隆仓库后 `pnpm install` 会自动装好钩子（`prepare: husky`）。
- 升级依赖（尤其是 `@deepseek-ai/dsh`）走 skill `update-dependencies`（`.agents/skills/update-dependencies/SKILL.md`）。

## 查安全活动记录

登录 / 机器 / 账号类安全事件同时写 `relay.db` 的 `audit_log` 表和 pino 日志（带 `audit: true`），
**管理页里没有展示页面，也不要再加**。要查或要判断有无风险，加载 skill `relay-audit`
（`.agents/skills/relay-audit/SKILL.md`）。

## 查证 dsh 行为

加载 skill `dsh-source`（`.agents/skills/dsh-source/SKILL.md`），它给出 dsh 源码根路径和常用文件位置对照表。

本仓库其他文档 / 代码注释引用 dsh 文件时，一律写**相对于 dsh 仓库根**的路径（如 `packages/client/connection/src/api-request-trust.ts`），不写绝对路径。

## 写代码时的注意事项

- **HTTP 转发不要用框架**。`hono` 只用于 relay 的管理页（登录、机器列表）。隧道转发直接用 `node:http`，因为需要注入 `createConnection`
- **WebSocket 升级必须单独处理**。dsh 0.1.2 的下行通道是单条 `/api/remote.mux`，走 `upgrade` 事件
- **顺序不能错**：认证 → relay 侧安全检查（原始 Origin/Host）→ 入隧道（头原样转发）
- **dsh 自己也要认证**（0.1.2 起）：launcher 从 dsh 输出截获 token → connector 上报 → relay 在首页 401 时回一次 `?token=` 重定向
- **`--trusted-host` 写错会让 dsh 插件加载直接报错**（不是运行时 403）。必须是裸的 `host` 或 `host:port`，不能带 scheme / 路径 / 尾部冒号
- **远程页面的设置能力靠插件拿回来**：dsh 0.1.2 在浏览器里按 `location.hostname` 判定，非 loopback 页面的 settings 被降级成只读内存。`packages/plugins/remote-privileged` 注入 `__DSH_TRANSPORT__.ownsHost` 解除它；**升级 dsh 后必须重新核实这个逃生门还在不在**（docs/02 §4.7）
- **Windows 上杀子进程树**用 `taskkill /pid <pid> /T /F`，`child.kill()` 杀不掉 dsh 派生的 shell
- 安全相关改动前先读 [docs/04-security.md](docs/04-security.md)，那里记了显式接受的风险

## 不确定时

- dsh 的行为 → 加载 skill `dsh-source` 后读 dsh 源码，不要猜、不要凭记忆
- 架构决策 → 读 docs/01 和 docs/03；如果那里没写，说明需要和用户确认，**先问再做**
