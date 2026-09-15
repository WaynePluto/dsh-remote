---
name: update-dependencies
description: 检查并更新本项目（dsh-remote）的依赖版本。优先检查 @deepseek-ai/dsh 是否有新版本；若 dsh 无新版本则跳过其余依赖检查。更新后运行项目验证，并评估 dsh 新版本对隧道 / 认证 / 插件的影响。当用户要求更新依赖、升级 dsh、或检查依赖新版本时使用。
---

# update-dependencies

依赖版本规则以根目录 `AGENTS.md` 为准：**所有 package.json 的直接依赖必须写固定版本号**
（不允许 `^` / `~` / 范围 / dist-tag）。新增依赖由 `.npmrc` 的 `save-exact=true` 默认精确保存；
本技能直接改 `package.json` 里的版本字符串。

固定版本号不变式由项目脚本统一检查（`.husky/pre-commit` 也会跑同一份逻辑），开始前先运行：

```powershell
pnpm check:dependencies
```

失败就把违规声明固定为 `pnpm-lock.yaml` 中已解析的版本，再 `pnpm install`，然后继续。

工作区布局：根 `package.json`（工具链 devDependencies + `pnpm.overrides`）+ `packages/{protocol,relay,connector,launcher}`。
`@deepseek-ai/dsh` 只声明在 `packages/launcher`（D13）。

## 步骤

### 1. 检查 dsh 是否有新版本

```powershell
npm view @deepseek-ai/dsh dist-tags --json
npm view @deepseek-ai/dsh versions --json
```

与 `packages/launcher/package.json` 的 `@deepseek-ai/dsh` 比较。

判定口径：
- **以 npm 上实际发布的版本为准，`latest` / `next` / `alpha` 通道都可采纳**。
  只要能从 npm 安装（不需要从源码构建、不需要 GitHub 依赖），就是候选版本。
- **alpha 视为高风险升级**：alpha 随时破坏 API，第 2 步的影响评估**逐条做完**再动手，
  并在改版本号前把评估结论告诉用户、由用户确认是否升级（rc 可直接推进）。
- 若无新版本：告知用户「dsh 已是最新」，确认第 0 步的固定版本检查通过后**结束，不再检查其他依赖**。
- 若有新版本：继续第 2 步。

### 2. 升级 dsh 前先评估影响（必做，不要直接装）

dsh 是 0.1.x developer preview，**每个 rc / alpha 都可能有破坏性变更**（alpha 尤甚）。先做功课再改版本号：

1. 读 `docs/02-dsh-facts.md` 的当前基线、检查表和 `docs/dsh/` 对应主题。
2. 加载 skill `dsh-source`（`.agents/skills/dsh-source/SKILL.md`），把本地 dsh checkout 切到对应
   tag，核对下面这些**本项目真正依赖的行为**，逐条给出「变 / 没变」而不是凭记忆：
   - `--trusted-host` CLI 参数是否还在、格式是否还是裸 `host` / `host:port`（铁律 7、写错是启动即失败）；
     同时按第 8 步检查上游是否提供了 trustedHosts 的运行时更新契约
   - `/api` 的 Host/Origin 校验逻辑（`packages/client/connection/src/api-request-trust.ts` 一类）
   - ownsHost 与远程设置持久化、浏览器信任围栏是否变化（见 `docs/dsh/transport.md`）
   - 浏览器认证的 token 输出格式、cookie 与认证范围是否变化，会不会让 relay 登录后仍吃 401
     （见 `docs/dsh/transport.md`；契约变化时同步改 launcher/relay）
   - 下行 WebSocket 路径与插件 combo 路由是否变化（现为 `/api/remote.mux`、`/plugins/??…`）
   - 插件 / profile 机制（`dsh-remote-web` profile 的加载方式，铁律 10）
3. 将结论更新到 `docs/dsh/` 对应主题，标清目标版本与尚未验证项；升级完成后更新基线与路线图进度，不追加升级流水账。

**不要因为升级去改 dsh 源码或 fork（铁律 1）**；不要基于本地源码构建 dsh。

### 3. 升级 dsh

编辑 `packages/launcher/package.json` 的 `@deepseek-ai/dsh` 为新版本，然后：

```powershell
pnpm install
```

安装后确认：

```powershell
node node_modules\@deepseek-ai\dsh\lib\bin.js --version
```

### 3.1 必查：peer 版本错配（dsh 子包的坑）

dsh 的 70 个子包把彼此声明为 **peerDependencies**。pnpm 自动安装缺失 peer 时走 npm 的
`latest` dist-tag，而预发布轨道（alpha/rc）的子包 `latest` 常常停在旧版本 → 新包加载旧依赖，
dsh **启动即报** `does not provide an export named ...`。升级后必须查一次版本分布：

```powershell
Get-ChildItem node_modules\@deepseek-ai -Directory |
  ForEach-Object { (Get-Content "$($_.FullName)\package.json" -Raw | ConvertFrom-Json).version } |
  Group-Object | Sort-Object Count -Descending
```

出现多个 `0.1.x` 版本共存就是中奖了（`nodeLinker: hoisted` 下只有一份能赢）。修法：

1. 把滞后的包逐个钉到 dsh 依赖闭包实际用的版本，写进根 `package.json` 的 `pnpm.overrides`
   （那张表就是这么来的；`package.json` 里不写说明，因为 JSON 无注释、schema 也不收额外字段）
2. **删掉 `pnpm-lock.yaml` 与 `node_modules` 重装**：只改 overrides 不删 lockfile 时 pnpm 会沿用旧解析
3. 删 `node_modules` 后还要删 `packages/*/node_modules`，否则里面留着指向旧 `.pnpm` 的断链接
   （症状：`Cannot find module .../vitest/vitest.mjs`）
4. 真正的验证是实际启动一次：`node node_modules\@deepseek-ai\dsh\lib\bin.js --profile dsh-remote-web --no-open --port 3099 --trusted-host 127.0.0.1`，
   看到 `dsh web: http://127.0.0.1:3099/?token=…` 才算好（`--version` 能跑不说明任何问题）。

`nodeLinker: hoisted` 是 dsh profile fallback 的前提（见 `pnpm-workspace.yaml` 注释），
不要在升级过程中改成 isolated。

### 4. 检查其余依赖（仅当 dsh 有更新时）

```powershell
pnpm outdated -r
```

逐个评估，注意本项目的约束：

- `zod`、`commander`、`ws`、`pino`：三个包共用，升级要**同时**改，版本保持一致。
- `hono` / `@hono/node-server`：只用于 relay 管理页（铁律：隧道转发不用框架）。两者配套升。
- `jose`、`otplib`、`rate-limiter-flexible`：安全相关，major 升级前读 changelog 的 breaking changes，
  并对照 `docs/04-security.md`。
- `undici`：launcher 的显式依赖，升级后要确认代理 / fetch 行为没变。
- **零原生模块**（铁律 3）：任何新依赖或升级后引入 prebuild / node-gyp 的包一律拒绝，
  绿色包必须解压即用。`onlyBuiltDependencies` 保持为空数组。
- devDependencies（`typescript`、`tsdown`、`tsx`、`oxlint`、`vitest`、`archiver`、`@types/*`）：
  可跟进最新，但 `@types/node` 的 major 不得超过 `engines.node`（当前 `^22.19.0 || >=24.0.0` → 用 22.x）。
- 升级 dsh 本身已经够大了：major 跳版（如 `@hono/node-server` 2.x、TypeScript 7）单独一轮做，不要搔在一起。

注意：`pnpm outdated` 只列「已安装版本落后于 latest」的包，**看不到版本声明写法的问题**，
所以不能只盯这张表，固定版本号仍以 `pnpm check:dependencies` 为准。

更新后再次 `pnpm install`。

### 5. 同步文案中的版本号（必做）

升级前记下旧版本号，升级后全文搜索：

```powershell
rg -n "<旧版本号>" README.md docs
```

已知承载 dsh 版本号的位置：

- `README.md` 的环境表「dsh 版本」一行
- `docs/02-dsh-facts.md` 开头的「结论基于 dsh 版本 / git 提交」声明（同时更新 git 短哈希与 tag）
- `docs/dsh/` 中受影响的现行契约与检查入口
- `docs/05-roadmap.md` 中的当前版本与进度
- `.agents/skills/dsh-source/SKILL.md` 中记录的核实版本

判定口径：文档只保留现行行为与明确待办，失效方案直接删除。没有完成的实机验收不能随版本号一起勾选。

### 6. 验证（必做）

```powershell
pnpm check:dependencies
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

全部通过才算更新成功。dsh 升级还要额外跑一次真实链路冒烟：

```powershell
node scripts/m0-fence-check.mjs --token <dsh 启动行里的 token>   # Host/Origin 围栏 + dsh 自带认证
node scripts/copilot-auth-check.mjs                            # 两个插件的宿主半 + 浏览器半仍被 dsh 装载
node scripts/proxy-check.mjs                                   # 代理插件：设置命名空间仍注册，写入的接受/拒绝仍如预期
node scripts/turn-retry-check.mjs                              # 失败重试插件：projection 注册 + RPC 通道 + 单一重试栏
pnpm dev                             # 起 relay + connector + dsh，浏览器走一遍登录 → 发消息 → 流式输出
```

冒烟重点：`--trusted-host` 拼装是否仍被 dsh 接受（写错是**启动即退出码 1**，不是运行时 403）、
首页是否被 relay 的 `?token=` 重定向换成了 dsh 的 cookie（不应看到 dsh 的 401 文本）、
`/api/remote.mux` 是否 101、`/plugins/??…` combo bundle 是否 200、审批卡片能否点。

⚠️ **`proxy-check.mjs` 还盯着一条 dsh 行为**：`SettingsScope.mutate` 在宿主拒绝时是 **resolve
不是 reject**（见 `docs/dsh/plugins.md`）。哪天 dsh 改成 reject（或给 snapshot 加上 error 字段），
代理页里那段「写完再核对是否落地」的代码就可以简化 —— 但**在确认之前不要删**，
它现在是页面唯一能知道「被拒了」的途径。

**插件侧额外要复核的四件事**（后三条由两个 check 脚本覆盖，它们报错就是其中一条变了）：

1. `remote-privileged` 的 `__DSH_TRANSPORT__.ownsHost` 还在（见 `docs/dsh/transport.md`）；
2. `copilot-auth` 依赖的模型页扩展槽 `settings.models.provider-card`、客户端 bundle 工件格式
  （`window.__ModuleLoader__.load`）与模块表（react / react/jsx-runtime）还在（见 `docs/dsh/plugins.md`）；
3. 凭据记录仍是 `llm-pi-ai/github-copilot` + `{kind:'grant', payload:<pi-ai 凭据>}`，且 pi-ai 内置目录里
  还有 `github-copilot`（见 `docs/dsh/models.md`）。同时把 `packages/plugins/copilot-auth` 的 `@earendil-works/pi-ai`
   版本跟 dsh 依赖的那个对齐。
4. `turn-retry` 依赖的几样东西还在（见 `docs/dsh/conversation.md`）：`TurnEndReasonMap` 的失败/停止分支、
   `ctx.sessionProjections.register` 的 `wire` 契约、`Agent.inbox.nextTurn`、
   `followup()` 的追加与唤醒语义，以及槽 `conversation.input.dock`。升级后必须重跑排队消息回归：
   存在 `nextTurn` 排队消息时，`pending-input` 不得调用 `followup()`，也不得改写 inbox。
   同时把运行时依赖 `@deepseek-ai/dsh-llm` 与 dsh 对齐。

### 7. 整理 dsh 新能力吸收建议

比较新旧版本（skill `dsh-source` 给出源码路径），关注：

- 是否新增了对远程 / 多端访问有用的能力（可能让本项目的某层变薄）
- 插件与 profile 机制的变化（影响铁律 10 的接入方式）
- 审批 / 权限模型变化（`ApprovalPolicy` 的取值与内置预设表，见 `docs/dsh/runtime.md`）
- 是否出现了可以直接删掉的本仓库兼容代码

整理成推荐列表（能力名、dsh 提供了什么、本仓库需要改多少）报告给用户，
**由用户决定**是否实现，不要擅自加功能或改架构（架构决策见 `docs/01-decisions.md`、`docs/03-architecture.md`）。

### 8. 常设关注：trustedHosts 能否运行时更新（决定是否去掉 dsh 自动重启）

**背景**：membership 变化改变 dsh 必须信任的 Host 集合（切换/取消远程入口）时，launcher 目前
**自动重启 dsh**（`packages/launcher/src/dsh-restart.ts` + `src/index.ts` 的 `restartForTrust`）。
重启会打断当时正在进行的任务（生成中的回复、执行中的工具调用；会话历史与 services 常驻服务不受影响）。
重启的唯一原因是 dsh 的 trustedHosts 在进程内**不可变**，而换入口必然改变 Host 集合，不重启就会 403。

**源码依据（基线 fb2c4b9e69 / dsh 0.1.5-rc.2，升级时逐条复核）**：

- trustedHosts 来自 connection 插件启动配置，加载时一次性解析
  （`packages/client/connection/src/index.ts` 的 `apply()`，非法条目启动即失败）
- 存进 `HostConnectionService` 的 `private readonly trustedHosts`（`packages/client/connection/src/rpc-host.ts`），
  每个请求的 fence 检查只读这个不可变字段
- web-app 启动时一次性采样（`packages/bundle/web-app/src/index.ts` 的 `resolveLanTrust`，注释写明 sampled once）
- dsh 没有任何运行时修改接口；铁律 1 禁止改/fork dsh，所以重启是现有约束下的最小区

**每次升级 dsh 时检查**：上游是否提供了 trustedHosts 的运行时更新契约。看三处——
`HostConnectionService` 的 `trustedHosts` 是否仍是 readonly 构造参数、是否出现 mutator/setter
或新的 plugin service、web-app 是否仍一次性采样。

**如果上游有了**：向用户提出吸收建议（第 7 步流程），把 launcher 的自动重启替换为运行时更新调用；
`dsh-restart-status.json` 状态文件与「远程入口」页的重启提示随之简化。**在确认上游契约之前，
不要动现有重启机制**——它经端到端冒烟验证过，是当前唯一正确的做法。

## 完成后

向用户汇报：升了哪些包（旧 → 新）、固定版本号体检结果、dsh 行为核对结论、文案同步了哪些文件、
验证结果（lint / typecheck / build / test / 冒烟）、以及 dsh 新能力推荐列表。
