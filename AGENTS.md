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
| 6 | 一台被控机 = 一个子域名，**不要试图挂子路径**（dsh 把 `/api` 写死成绝对路径） |
| 7 | **只有模式 A：原样转发 Host，dsh 侧用 `--trusted-host` 声明。** relay 永不重写 Host/Origin（模式 B / `unlockPrivileged` 已删除） |
| 8 | 优先用成熟第三方依赖，不重复造轮子（用户明确要求） |
| 9 | 每完成一个 roadmap 条目立刻改 `- [x]`，不要攒着批量勾 |
| 10 | **与官方 dsh 共用标准 `DSH_HOME`，但只在 `dsh-remote-web` profile 中加载项目内置插件。** 不写 home 级 patch、不修改官方 `web` profile；launcher 不重复实现 dsh 的插件管理 |
| 10b | **扩展 dsh 只能写插件，插件全部放在 `packages/plugins/<名字>/`**（包名 `@dsh-remote/dsh-plugin-<名字>`）。每个插件包根携带 `dsh-overlay.yml`，launcher 用 `--patch` 传给 dsh；overlay 里只写相对路径 `./dist/index.js`，**永远不写绝对路径**（见 D17）。插件带浏览器半时声明 `dsh.client` + `exports["./client"]`，**缺 `dist/client.js` 不是降级，而是让 dsh 的 web UI 整个起不来**，laucher / dev-stack / pack 三处产物检查都要覆盖它 |
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
- **GitHub Copilot 订阅登录在 `packages/plugins/copilot-auth`**：dsh 本来就内置了 Copilot（它的 `llm-pi-ai` 就是 pi-ai），插件只补了「能跑登录的界面」——模型页官方扩展槽 `settings.models.provider-card` + 自己的 `/copilot-auth` RPC 通道。事实链见 docs/02 §7；升级 dsh 后跑 `node scripts/copilot-auth-check.mjs`
- **出网代理在 `packages/plugins/proxy`**：**Node 的全局 `fetch` 不读 `HTTP(S)_PROXY`**，而 dsh 与 pi-ai 全程用全局 `fetch`、从不传 dispatcher —— 所以对话、登录、web fetch/search 默认**都不走代理**。插件的做法是换掉 undici 的**全局 dispatcher**（设置 → 代理页面配置，存设置命名空间 `dsh-plugin-proxy`），一次覆盖整个进程。**代理只有这一个事实源**：launcher 的临时环境变量 bootstrap 已删除，全链路不读任何代理环境变量，**也不预置任何默认代理地址**。别再给单个插件加各自的代理配置项
- **插件自己的设置 / 文案命名空间一律用包名 `dsh-plugin-<名字>`**（`dsh-plugin-proxy`、`dsh-plugin-models-catalog`、`dsh-plugin-copilot-auth`）：共享的 `settings.yaml` 里一眼看得出这段归谁，也不会和 dsh 上游将来新增的命名空间撞车
- **跟随 models.dev 更新模型列表在 `packages/plugins/models-catalog`**：改模型列表是 dsh 本来就有的能力（配置层 `providers.*.models` 热更新），插件补的是「发现上游新模型」。三条不能破的规则：**dsh 一旦自带就交还并删掉本插件写的那份**、**只碰自己写过的列表**（溯源在自己的设置命名空间 `dsh-plugin-models-catalog`）、**跨协议路由（openai / github-copilot）一律报「不能添加」**（写进去会让 dsh 整体拒绝这次设置写入）。事实链见 docs/02 §8
- ⚠️⚠️ **`SettingsScope.mutate` 在宿主拒绝写入时是 resolve 不是 reject**（docs/02 §8.8）：`catch` 是死代码，被拒的写入表现成「提示已保存 → 字段全部弹回 → 没有任何报错」，还会连带丢掉用户刚输入的内容。写设置页必须做三件事：① 写之前用**和宿主校验器同一套纯函数**在本地判一次（放两半共享模块，别各写一份）；② 写之后读 `scope.getSnapshot().value` 核对是否真的落地，没落地就报错并**保留草稿**；③ 报错贴着出错的那个字段显示，别堆在页面最底部
- ⚠️ **主题变量名写错不会报错，只会静默用兜底色**：正确的是 `--dsw-alias-border-l1`（字母 l，不是数字 1）、`--dsw-alias-bg-layer-2`、`--dsw-font-mono`。写完客户端样式**必须在深色下看一眼**（docs/02 §8.6）。⚠️ **浅色主题里 `bg-layer-1/2/3` 是同一个白**（`bg-layer-4` 压根没定义），拿层级 token 去衬一个内嵌小容器，在浅色下等于什么都没画 —— 用 `--dsw-alias-border-l1` 描边或自己写中性半透明灰（docs/02 §8.6a）
- ⚠️ **`settings.models.provider-card` 是 keyed 槽，`llm-pi-ai` 这个 key 已被 copilot-auth 占用**：第二个插件用**默认 priority** 往同一张卡里加东西会直接抛错，要**并列添加**请用 list 槽 `settings.models.footer`。但**「接管」是可以的**：keyed / single / list 都支持按 `priority` 影子覆盖（**priority 小的渲染**，只有同 cell + 同 priority 才抛错），与注册先后无关（docs/02 §8.5）
- ⚠️ **设置页左侧导航的图标是 dsh 写死的，`settings.section` 没有图标位**：未知 id 一律落到齿轮。代理页那个地球、通知页那个铃铛都靠各自的 `src/client/nav-glyph.ts` 从外面画（只往自己那一行写一个 `data-` 属性 + 一张样式表，不改 React 渲染出来的节点）；**升级 dsh 后要复核局部类名还在不在**，改了只是退回齿轮（docs/02 §8.7）。⚠️ **自己画图标要对齐 dsh 自带图标的跨度**（`IconAlarmClockOutline16` 是 x 1.75–14.25、y 2.5–13.75）：画小了单看没毛病，一进导航列挨着邻居就明显缩一圈 —— 这种问题**只有放进真实的行里**才看得出来，别拿单独预览定稿
- **失败重试在 `packages/plugins/turn-retry`**：dsh 自带的 `llm-retry` **本来就会**自动退避重试 5 次，缺的是它放弃之后的出路。插件覆盖两个时刻：① turn 还活着时挂 `agent/request-error` 瀑布、用 `ctx.userQuestions` 问一句，点重试返回 `{kind:'retry'}` 就在**同一 turn、同一 step** 重跑（不产生多余消息、不丢已完成的工具调用）；② turn 已结束后，把 `turn/end` 折成 session projection `turnRetry`，在 `conversation.input.dock` 画横幅。**监听器一进来先 `await next()`，所以与 `llm-retry` 的注册顺序无关**。横幅认两种结局：`error` →「上一轮失败了 `[重试]`」，`aborted{user|disposed|legacy}` / `interrupted` →「`[继续]`」（**手动停止后不用再打一遍字**）；`aborted{hook|parent}` 和正常收尾不给按钮 —— 那是别人已经做过的决定（对照表见 docs/02 §10.4）。**供应商的失败信息是不可控字符串**：宿主折叠时截到 2000 字、给模型的通知截到 300 字，横幅里再放进一个高度封顶的滚动容器；改投影状态的形状**必须 bump `stateVersion`**。事实链见 docs/02 §10；升级 dsh 后跑 `node scripts/turn-retry-check.mjs`
- ⚠️ **dsh 没有「不追加 user message 就重新推理」的入口**：`send`/`followup`/`steer`/`inject` 四个都要 `UserMessage`，空消息会让这一轮不发模型请求就结束（docs/02 §10.5）。所以**事后**重试必然在日志里多一条消息；把它写成 plugin 溯源 + `form:'notice'`，会话里就是一行折叠的 context 行而不是伪造的用户气泡
- ⚠️ **`ctx.connection.rpc.handle('/x', …)` 的端点在 URL 路径里**：浏览器必须 POST 到 `/x/<endpoint>`，只打 `/x` 一律 404，且信封里的 `method` 必须和路径段一致（docs/02 §10.8）
- ⚠️ **session projection 的 `apply` 在事件与自己无关时必须返回同一个引用**：框架用 `Object.is` 决定要不要给每个连着的浏览器发帧，每次重建状态不报错、只会安静地刷屏（docs/02 §10.6）
- **转录里的「执行过程」折叠在 `packages/plugins/exec-process`**：dsh 本来就有这个折叠（`ui-chat` 的 `turn-process`），但 `ChatNodeSeat` 把它挂在 `!historyIncomplete` 上，而转录窗口只加载**最近 50 条 surface 消息**（`PAGE_MESSAGES = 50`）——**会话一超过约五十条消息，整个视图的折叠就被全局关掉，没有任何设置能打开**。插件的做法：两个自己的 `ConversationNodeDefinition` 只提供位置（窗口与边界直接读 dsh 发布的 `turn-process` Turn 数据，**那份投影不受该门影响**），`exec-process` 是一个 turn 的第一段、`exec-process-step` 是每条正式消息之后的新一段；再用 `priority: -1` 影子覆盖 dsh 的 `turn-process` 渲染器、**把 dsh 的 disclosure 强制常开**，于是转录里只剩一套折叠机制。三条产品规则：**正式消息不进折叠**、**运行中也折**、**段尾那条正式消息里的「已思考」跟着这一段折**。事实链见 docs/02 §11；升级 dsh 后跑 `node scripts/exec-process-check.mjs`
- ⚠️ **要折叠转录里的行，用「按 `data-chat-flow-key` 命中的注入样式表」，不要往 dsh 的节点上写属性**：`useSearchableHidden` 会 set/remove 同一批 wrapper 的 `hidden`，外部写属性等于和它抢同一个元素。而且**整行隐藏要用零高度 + `content-visibility:hidden`，不能用 `display:none`**——dsh 靠行 rect 的有序性二分查找阅读位置，全零 rect 会让翻页后落回错误位置；列间距规则特异度 0-7-0，必须 `margin:0!important` 抵消（docs/02 §11.4）。**反过来，藏行「内部」的元素（例如 `data-variant="think"` 那个已思考盒子）必须用 `display:none`**：它不参与那份 rect 顺序，而且只有 `display:none` 才连助手正文那 16px flex 间距一起去掉（docs/02 §11.8）
- ⚠️ **想让插件的一行「吸顶」，`position: sticky` 得写在 dsh 的 `.flowItem` wrapper 上，而且要自己把它推出去**：sticky 出不了自己的 containing block，写在按钮上实测滚 900px 后 `top` 是 −900；但 wrapper 的 containing block 是**整条消息列**，浏览器那套「滚过内容就把 sticky 顶走」在这里永远不会发生，不补就一路吸到会话结束。补法是每帧发布 `push = clamp(滚动容器顶 + 行高 − 本段最后一行的底, 0, 行高)`、令 `top: -push`——内容还在时为 0，内容一完就与滚动等速滑出，不需要过渡也不会跳。**公式里绝不能读表头自己的位置**（会每帧震荡），**每行一个自定义属性**（两段同屏时值不同，共用会把第二段顶没）；值写在 `<html>` 上，由自己样式表里按 `data-chat-flow-key` 命中 wrapper 的规则读取，仍然不往 dsh 的节点写属性。滚动容器要现找（`.scroll` 在 `[data-conversation-scroll]` 下会把 overflow 交还给祖先）。消息流里**做不出内部滚动条**——要折的行是 dsh 自己的兄弟节点，套容器就得搬动 React 拥有的节点（docs/02 §11.7）
- ⚠️ **想在 turn 运行中就改消息流里的东西，Definition 必须跟随 chunk 事件**：引擎只对匹配到事件的 Context 调 `buildViewNode`，不跟 chunk 的话你的行要等到第一个 durable 事件才出现；chunk 用 `publication: 'animation-frame'` 压成一帧一次（docs/02 §11.9）
- ⚠️ **会话消息流里没有通用的插件槽**：`conversation.chat.node` 是 keyed 槽且 `turn-error` / `model-retry` 已被 dsh 自己占用（同 priority 重复注册抛错，但**换 priority 是影子覆盖**，见上面 §8.5 那条）；想**并列添加**用 list 槽 `conversation.input.dock`（输入框正上方），想加**自己的一行**就注册自己的 `ConversationNodeDefinition` + 新 key（docs/02 §10.7、§11）
- ⚠️ **`conversation.input.dock` 的条目必须自己声明宽度**：那个栈只是竖排 flex，宽度上限在每张卡自己身上，不写就铺满整个会话列（比输入框宽 32px、比转录正文宽更多，且与文本长短无关）。照抄 dsh 自己 dock 条目那一段：`margin:0 auto` + `width: calc(100% - 侧留白×2 - dock内缩×4)` + `max-width: calc(var(--dsh-composer-card-max-width) - dock内缩×4)`（docs/02 §10.7）
- **任务完成通知在 `packages/plugins/notify`**：dsh 一点桌面通知能力都没有（`packages/**` 里的 `Notification` 全是 JSON-RPC / ACP / MCP 的通知帧；唯一沾边的是侧边栏那个「未选中的会话跑完了」小圆点，纯页面内）。插件在 Windows 上弹常驻 toast，两个时刻：① **`agent/status → idle`**（**不是 `turn/end`** —— 一轮结束时 inbox 还有消息就立刻再开一轮，用 `turn/end` 会响好几次），必须**去抖 700ms**，因为 `agent.ts:229` 就在设完 idle 的下一行同步地再唤醒 driver；② `approval/request` / `user-questions/request` 两个**瀑布**，⚠️ **观察者必须 `prepend: true`**（认领请求的应答者不调 `next()`，排它后面根本不会被调用），且**不能靠事件判断「屏幕上真有卡片」**（权限预设不在这个瀑布上，而 `approval/asked` 无论如何都会写），只能**看它悬了多久**（3 秒）。⚠️ **未注册 AUMID 的 toast 会被 API 接受却什么都不显示**，宿主侧观察不到 —— 所以设置页那个「发一条测试通知」按钮是唯一诚实的验证方式，别删。通知文案**走环境变量**传进 PowerShell，让脚本保持常量、没有转义函数可写错。事实链见 docs/02 §12；升级 dsh 后跑 `node scripts/notify-check.mjs`
- **常驻服务在 `packages/plugins/services`**：dsh **有**后台任务运行时（`run_in_background` + `ctx.jobs` + `job_*`），但它的生命周期**刻意**绑在会话上（`JobStart.owner`：「agent disposal cancels and awaits the job」），换会话或重启 dsh 就没了，也没有给长期进程起名字的机制 —— 所以插件走 detached + 落盘具名注册表（`<会话项目目录>/.agents/services.json`、日志 `.agents/logs/<name>.log`），五个 `service_*` 工具 + 输入框上方一个可折叠面板。⚠️⚠️ **插件绝不能 append 自己的会话事件类型**：`Session.append()` 没有 `ignorable` 参数，而类型不在构建期常量 `KNOWN_SESSION_EVENT_TYPES` 里、又没有该标记的事件，会让持久化层**永久拒绝加载这个会话** —— 所以插件做 projection 只能折叠 dsh 已有的事件类型，本插件的面板改走轮询（顺带查实：**Host→Client 只有 session projection 一条推送通道**，`rpc` 的流式 `open` 在浏览器传输里不提供）。⚠️ **自己 spawn 就绕过了沙箱**，而 web profile 的 `pwsh-sandbox` 在 Windows 上是真的 ACL 受限令牌、权限预设又**只写两个旋钮、不做逐工具拦截** —— 所以 `service_start`/`service_restart` 读会话解析出的沙箱模式：`danger-full-access` 不问（`bash` 本来就给了同样能力），受限模式走 `ctx.approval` 且**只有 `allowed-once` 放行**，拿不到批准一律 fail closed；**面板刻意没有「启动」按钮**。⚠️ **spawn pwsh 必须照抄 dsh 的 argv**（`-NoLogo -NoProfile -NonInteractive -Command` + UTF-8 前缀 + `NO_COLOR`）：少了 `-NoProfile`，用户的 PowerShell profile 会先把报错写进服务日志，就绪正则会匹配错，慢/会提问的 profile 直接让服务起不来。事实链见 docs/02 §13；升级 dsh 后跑 `node scripts/services-check.mjs`
- **可交互终端在 `packages/plugins/terminal`**：dsh **已经有**一整套持久 PTY 终端（`ctx.terminals` + `@deepseek-ai/dsh-terminal-bash`，`shellDialect` 按平台切 bash/pwsh，底层 node-pty 六平台预编译产物随包，六个 `terminal_*` 模型工具），缺的只有两件事 —— **web profile 一行都没挂载它们**，以及**没有任何界面让「人」往里面打字**（工具是给模型的，网页里的 `TerminalBlock` 只读），所以在这个插件之前**密码只能由模型替你打进去**。插件因此只做两件事：挂上 dsh 的三个包 + 在 `conversation.input.dock` 加一个能打字的面板。⚠️ **overlay 里的裸包名解析到 profile 目录**（`<DSH_HOME>/profiles/<profile>/`，不是 overlay 目录也不是 dsh 安装位置），所以三个 dsh 包只能写成本包的普通依赖、由宿主半 `ctx.plugin()` 挂载。⚠️⚠️ **Windows 上必须把 PSReadLine 请出去**（`-NoExit -Command "Remove-Module PSReadLine …"`）：它的持续重绘会打乱就绪判据里 `[Console]::Write` 的标记与提示符文字的顺序，还会把 dsh 自己的 bootstrap 写进用户的 `ConsoleHost_history.txt` 再作为行内预测补回来 —— 实测默认 argv 只有 7/10 能开出终端，移除后 20/20；再叠一层「每次开终端独立超时 + 重试」的补丁（打在自己挂载的 registry 实例上，`terminal_open` 没有拦截接缝）。⚠️ `ctx.terminals` **同一会话只允许一次发送**，第二次同步抛 `SEND_ACTIVE`，所以人类输入要**等**（默认 10 秒）、等不到就 `busy: true` 且**页面必须保留草稿**（刚吞掉密码的输入框自己清空是唯一不能有的失败）。**面板只能往模型已开好的终端里打字，没有 `open`/`close` 端点**（与 services 的取舍一致）；也**不需要自建沙箱门**（`terminal-bash` 在非 `danger-full-access` 下自己走 `ctx.sandbox.confine()`）。事实链见 docs/02 §14；升级 dsh 后跑 `node scripts/terminal-check.mjs`
- **Windows 上杀子进程树**用 `taskkill /pid <pid> /T /F`，`child.kill()` 杀不掉 dsh 派生的 shell
- 安全相关改动前先读 [docs/04-security.md](docs/04-security.md)，那里记了显式接受的风险

## 不确定时

- dsh 的行为 → 加载 skill `dsh-source` 后读 dsh 源码，不要猜、不要凭记忆
- 架构决策 → 读 docs/01 和 docs/03；如果那里没写，说明需要和用户确认，**先问再做**
