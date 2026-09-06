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

- [x] **M1.5** 端到端联调
  - 同机跑 relay + connector + dsh，由另一台局域网机器直接访问 `http://<relay局域网IP>:30809` ✅
  - M1 单机模式配置 `directSlug=pc1`，IP/localhost Host 固定路由到该机器 ✅
  - **前置正式浏览器认证已完成**（M2.3）：实测局域网 IP 访问 `/`、`/api/remote.mux`、`/plugins/*`
    一律 302 到 `/_auth/login`，认证确实排在路由解析之前 ✅
  - 隧道数据面由 `relay.integration.spec.ts` **6 项集成测试**覆盖并通过（真 relay + 真 connector +
    真 HTTP server）：控制信道认证、HTTP body 双向转发 + 模式 A 头原样、dsh 自身 token 交换只做一次、
    坏 Origin / cross-site 在分配 stream 前就被拒、浏览器 WebSocket upgrade 走独立数据流、
    过期 access cookie 在 upgrade 期间轮换、未注册设备拿到致命错误 ✅

### M1 验收

> 下面几条**刻意不由测试代劳**：它们要的是「真浏览器 + 真时间 + 真断网」，
> 集成测试只能证明协议对，证明不了长连接在真实网络里熬不熬得住。

- [ ] 浏览器通过 relay 能完整使用 dsh：发消息、流式输出、切换会话、打开设置
      （dsh 0.1.2 删除了特权方法围栏，设置页在模式 A 下应该直接可用）
- [ ] 下行 WebSocket `/api/remote.mux` 稳定，长时间（>30min）不断
- [ ] connector 断网后自动重连，恢复后页面刷新即可用
- [ ] relay 重启后 connector 自动重连
- [ ] 上传一张图片附件成功（验证大 body 转发）

---

## 已完成 · 全局提示词编辑插件（`packages/plugins/agents-md`）

> 起因：用户提出「增加一个写入 `$DSH_HOME/AGENTS.md` 的插件，在设置里加一个新页面，
> 回显之前编辑的内容、可以直接编辑保存」。
> 核实后发现：**这个文件 dsh 本来就在读，而且排在所有项目级 `AGENTS.md` 之前
> 推给模型**（`agent-instructions/src/files.ts:280`），但 **dsh 没给它任何界面** ——
> 唯一的编辑方式是「你得先知道它存在」，而手机远程根本做不到。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §17。

- [x] 新建插件包 `packages/plugins/agents-md`（`@dsh-remote/dsh-plugin-agents-md`），**双半**
- [x] **需求收敛：用户原本要「每个预设一份」，问过之后改为「全局唯一一份」**。
      先查清了可行性：`agent-instructions` 这一行位于**每个预设自己的 composition** 里
      （`presets/standard/agent.cordis.yml:30-33`），`dshHome` 是它的 config 字段，
      所以「每个预设一份」在 dsh 里**技术上完全可行**。但官方的
      `standard` / `cordis` / `ptc` 是 `trust: 'system'`、`remoteExportCopy` 明确拒绝写
      shipped 预设 —— 按预设区分等于**逼用户把每个想用的预设都复制一份**。
      把这个代价摆给用户后，用户拍板「不要根据预设改变了，全局唯一只有一份」。
      **接缝已查清并记进 docs/02 §17.2**，将来若要做按预设区分不必重查
- [x] 界面入口：设置页新增 **「全局提示词」页**（`settings.section`，`id: dsh-plugin-agents-md`，
      order 55，排在代理 60 / 通知 70 之前 —— 那两个是配一次就忘的开关，这个是会反复回来改的内容）
- [x] ⚠️ **刻意没有设置命名空间**：正文的归宿就是那个文件本身。存进设置命名空间会变成
      **第二份、而且是 dsh 的加载器不读的那一份** —— 页面显示得好好的，模型收到的是另一回事
- [x] ⚠️ **也刻意不注册自己的 `agent-instructions` 行**：dsh 的加载器仍是唯一读取方，
      插件只往它读的那个文件里写字节。这是升级 dsh 后仍然正确的唯一姿势
- [x] ⚠️⚠️ **`MAX_BYTES` 不是我们发明的限制**：dsh 的 `readBounded` 拒绝读超过
      `maxSourceBytes`（默认 1 MiB）的提示词文件，而且是**静默丢弃**（两处 `return undefined`，
      不报错、不进上下文）。不在保存时拦下来，用户就会看到「已保存」而模型永远收不到 ——
      一个没有任何错误信息的失败。两半用 `shared.ts` 里**同一个** `documentFault()` 判断，
      所以页面接受的内容不可能被宿主拒绝（正是 docs/02 §8.8 那个坑的形状）
- [x] ⚠️ **按 UTF-8 字节判，不是字符**：60 万个汉字的字符数远小于上限、字节数远超上限。
      单测里有一条专门锁这个
- [x] ⚠️ **保存是原子的**（临时文件 + `rename`）：半个提示词文件会被当成用户写的内容
      原样喂给模型。失败时清掉临时文件，不在 home 里留一堆 `.tmp`
- [x] ⚠️ **失败时保留草稿**，报错贴着出错的地方显示 —— 这个仓库已经在设置页上吃过两次这个亏
- [x] 「文件不存在」被如实报告成 `exists: false` 而不是一次失败（全新机器上这是**正常状态**），
      页面显示「这个文件还不存在，保存时会自动创建」并直接给出空编辑器
- [x] 路径经 dsh 自己的 `resolveDshHome()` 解析，显示用 `dshHomeDisplay()`
      （`~/.dsh/AGENTS.md` 或 `$DSH_HOME/AGENTS.md`，**永不显示绝对路径**）
- [x] 导航图标：`settings.section` 没有图标位，未知 id 一律齿轮（docs/02 §8.7）。
      照 notify 的机制画了一个文档图标（16×16、`stroke-width 1.25`、圆头圆角），
      **跨度对齐 dsh 自带图标**（x 2.75–13.25、y 1.75–14.25）
- [x] 16 项单元测试（路径、缺文件/空文件之分、UTF-8 计数、原子写、校验器、
      四种 dispatch 失败码），两半 typecheck + 构建通过，本包 oxlint **0 error**
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、
      `scripts/pack.mjs`（两张表）；launcher 的 workspace 依赖也加了一行。
      **顺带补上了 `pack.mjs` 里漏掉的 `tools-inspector` / `skills-inspector` 两行**
- [x] ⚠️⚠️ **真机冒烟 `node scripts/agents-md-check.mjs` 17 项全绿，其中最关键的一条是
      单元测试锁不住的**：`USER_GLOBAL_FILE` 定义在 dsh 内部的 `render.ts`、
      **不在该包的公开入口上**，插件只能抄一份常量 —— 抄错或 dsh 改名都**不会报错**，
      只会安静地编辑一个没人读的文件。所以脚本**反过来验**：写一段带唯一标记的文字，
      再调 dsh **自己的** `discoverBaselineInstructionFiles()` 确认它认领了这个文件。
      实测 dsh 认领 `["$DSH_HOME/AGENTS.md", "AGENTS.md"]`，并显示为 `$DSH_HOME/AGENTS.md`。
      其余各项：全部 `--patch` 正常启动、`__DSH_BOOT__` 有本插件行、combo bundle 200
      且带着槽注册与通道路径、全新 home 读到 `exists:false`、写入后磁盘字节一致、
      未知端点与非字符串载荷各自被自己的错误码挡下、无 cookie 401
- [x] **用户实机验证通过**（2026-09-04）：重启 dsh 后设置 → 全局提示词 → 写入 1692 字节并保存 →
      磁盘上的 `~/.dsh/AGENTS.md` 与页面完全一致 → **新会话里 dsh 自己把它注入成
      `Additional instructions from: ~/.dsh/AGENTS.md`（标为 `user-global`）**。
      也就是说「写对了地方」最终由 **dsh 本身**证实，而不是由插件自己的报告证实

## 已完成 · 任务完成通知插件（`packages/plugins/notify`）

> 起因：用户说「pi coding agent 有个 `notify` 扩展，完成任务后给 Windows 发一条常驻系统通知，
> 想在 dsh 里也加一个」。
> 核实后发现：**dsh 一点这类能力都没有** —— 搜遍 `packages/**`，`Notification` 全是 JSON-RPC /
> ACP / MCP 的通知帧；唯一沾边的是侧边栏那个「未选中的会话跑完了」小圆点，纯页面内，
> 只帮得到已经在看页面的人。事实链见 [02-dsh-facts.md](02-dsh-facts.md) §12。

- [x] 新建插件包 `packages/plugins/notify`（`@dsh-remote/dsh-plugin-notify`），**双半**
- [x] ⚠️ **完成信号用 `agent/status → idle`，不用 `turn/end`**（这一条决定了整个实现）：
      `kick()` 是 `while (await this.turn()) {}`，一轮结束时 inbox 里还有消息就立刻再开一轮，
      用 `turn/end` 会让一次「用户视角的任务」响好几次。`agent/status → idle` 的语义正是
      「没有 driver 在跑也没有排队的活」，也就是 pi 那个 `agent_settled` 的对应物
- [x] ⚠️ **完成通知必须去抖**（700ms）：`agent.ts:229` 就在 `setPhase(idle)` 的**下一行**做
      `if (wakeRequested && this.inbox.hasPending) this.wakeDriver()`，不去抖就会宣布一件
      还在进行的工作结束了。到点后还要**再读一次 `agent.status`** 兜住别的唤醒路径
- [x] 顺带查实**时序是稳的**：`turn/end` 一定先于 idle 落盘（`turn()` 的 finally 在
      `agent.ts:328`，idle 相位在包着它的 `kick()` 的 finally 在 `:228`），
      所以收到 idle 时读「上一轮怎么结束的」一定读得到。结局分五种文案：
      已完成 / 失败（带失败码）/ 被停止 / 被拦下 / 到达长度上限
- [x] **第二个时刻：审批卡片和提问悬着没人管**（用户拍板要）。这是 pi 没有而 dsh 有的场景 ——
      卡片把 agent 按在 `running`，永远等不到上面那个 idle，人一走开就无声卡住
- [x] ⚠️ **两个都是瀑布，观察者必须 `prepend: true`**：认领请求的应答者**不调 `next()`**
      （浏览器那半就是这样应答的），排在它后面的监听器根本不会被调用到。
      监听器进来就 `await next()` 原样放行，绝不参与决定
- [x] ⚠️ **不能靠事件判断「屏幕上真的有张卡片」**：权限预设**不是**这个瀑布上的应答者
      （它只写 `approval/policy`，值只有 `'ask' | 'never'`），`'never'` 在派发之前就决定了；
      而 `approval.request()` 无论如何都会 append `approval/asked` + `approval/decided`，
      所以拿审计事件判断会误报。改为**看它悬了多久**：进瀑布挂定时器、`next()` 回来就撤销，
      3 秒还没回来的才是真的落到人身上了
- [x] **设置页**（用户第二轮要求「在设置页面中再增加一个 windows 通知的开关，默认开启」）：
      新增「设置 → 通知」页（`settings.section`，order 70），两个开关，
      **默认都开着** —— 一个装完还要手动打开的通知器，会在它被装来对付的那次长任务里保持沉默。
      写入后**回读 `scope.getSnapshot().value` 核对**（`mutate` 被拒时是 resolve 不是 reject，§8.8）
- [x] ⚠️ **设置页带一个「发一条测试通知」按钮，这不是装饰**：未注册 AUMID 的 toast
      可以被 API 接受却什么都不显示，宿主侧完全观察不到。本机实测自定义 AppID 与
      PowerShell 自己的 AUMID **两条都真的弹出来了**，但这不是契约 ——
      「发一条让你自己看一眼」是唯一诚实的验证方式
- [x] **通知文案走环境变量，不插进 PowerShell 脚本**：pi 那份是插值 + 单引号翻倍，
      于是脚本的正确性取决于一个转义函数，而文案不是我们的（标题是模型写的、工具名是别人注册的）。
      传环境变量让脚本变成一个**常量**：没有转义函数可以写错，`CreateTextNode` 又把 XML 转义包了。
      单元测试里有一条专门锁这个（恶意串只能出现在环境变量里，不能出现在 argv 里）
- [x] 其余细节：子 agent 一律不通知（它在一次任务里会停很多次）；
      `session.header.cwd`（**不是 `meta`**）取项目名、投影 `title` 取会话标题（新会话第一条必然没有标题）；
      并发上限 4 条、超时 10 秒、`unref()` 不留住进程；非 Windows 整体 no-op
      （刻意不做 pi 那种 OSC 777 降级：dsh 的 stdout 是日志文件）
- [x] 58 项单元测试（文案 16 / toast 14 / 宿主 28），两半 typecheck + 构建通过，
      全仓库 lint 0 error、全仓库测试通过
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、`scripts/pack.mjs`（两张表），
      launcher 的 workspace 依赖也加了一行。
      顺带修好了 lockfile 里漏掉的 `exec-process` 那一行
- [x] 真机冒烟 `node scripts/notify-check.mjs` 全绿：临时 DSH_HOME 起一个真 dsh，
      全部 `--patch` 正常启动（两个瀑布监听与设置命名空间都被接受）、`__DSH_BOOT__` 有本插件行、
      combo bundle 200 且带着槽注册与通道路径、设置命名空间可写、
      `/notify/test` 带 cookie 真的弹出一条通知（`platform: win32`，160ms）、不带 cookie 401、
      未知端点被通道自己挡下
- [x] **用户实机验证通过**（2026-09-03）：设置 → 通知 → 「发一条测试通知」弹出常驻 toast；
      跑完一轮后收到完成通知；审批卡片挂着没人管时收到「在等你批准」

### 第二轮（用户反馈）：把设置页左边那个齿轮换成铃铛

> 起因：用户看到设置页后说「改一下通知 icon，看看有没有类似铃铛之类的能表示通知的」。
> 第一版实现里我**刻意没做**这件事（理由写在 README 里：nav-glyph 依赖一个升级就可能改名的
> 局部类名，为一个图标不值得多一处「升级后要复核」）——用户的要求推翻了这个取舍。

- [x] 先查 dsh 有没有现成的：`navIcon` 只认 `models` / `agent-presets` / `plugins`，
      未知 id 一律齿轮；**整个图标集里也没有铃铛**。最近的是 `IconAlarmClockOutline16`，
      但**那是错的词**——dsh 本身有 Schedule 子系统，闹钟在设置里会被读成「定时任务」
- [x] 按 dsh 自己的描边语汇重画一个：16×16 viewBox、`stroke-width 1.25`、圆头圆角
      （闹钟 / 齿轮都是这套；早期那个地球是**填充**的 14×14，不要照它画新图标）。
      机制照抄 `packages/plugins/proxy/src/client/nav-glyph.ts`：只往自己那一行写一个
      `data-` 属性，其余交给注入的样式表（隐藏兜底 `<svg>` + `::before` 拿铃铛当 mask、
      底色 `currentColor`，hover / 选中 / 深色自动跟随）
- [x] ⚠️ **尺寸返工了一次，这是本轮真正的教训**：第一版跨度只有 x 3.5–12.5，
      **单独渲染出来完全正常**，用户一看真实页面就说「有点小」——因为 dsh 自带图标铺到
      x 1.75–14.25，并排就矮一头。**图标大小只有放进真实的行、挨着真实的邻居才判得准。**
      定稿 E：x 2.25–13.75、y 2–13.875
- [x] **定稿方式也换了**：不再自己截图评估，而是把 A/D/E 三个尺寸做成一个**临时 Cordis 插件**
      （`styles.insert` + `:nth-last-child` 命中真实导航行，三页 order 拉到 9000+ 恒在最后三行），
      直接画进用户正在用的那个 dsh 的设置菜单列里，由用户指认。选定 E 后插件已 `cordis_undefine`。
      ⚠️ 顺带查实：Client 的 Builtin 只有 `ctx` / `React` / `host` / `styles` / `console`，
      **没有 `document`**，所以临时插件做不了 DOM 写入，只能走纯 CSS 按位置命中；
      仓库里那份不受此限（它按标签文字找到自己那一行，不依赖行的位置）
- [x] 文档回写：README、AGENTS.md、docs/02 §8.7 都补上了「对齐 dsh 图标跨度」这条
- [x] **用户实机验证通过**（2026-09-03）：重启 dsh 后设置左侧「通知」那一行是铃铛而不是齿轮，
      和上下两行 dsh 自己的图标一样大

---

## 已完成 · 执行过程折叠容器插件（`packages/plugins/exec-process`）

> 起因：用户提出「agent 正式消息与用户消息之间那些思考 / 工具调用，想在外面再套一个折叠框，
> 叫『执行过程』，标题行显示思考多少次、工具调用多少次、失败多少次、最近一次动作」。
> 核实后发现：**dsh 本来就有这个折叠（`ui-chat` 的 `turn-process`），但它在真实会话里永远不出现**。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §11。

- [x] ⚠️ **先查清了「为什么用户从来没见过 dsh 自带的折叠」**：`ChatNodeSeat` 把整套折叠挂在
      `!historyIncomplete` 上，而转录窗口只加载**最近 50 条 surface 消息**（`PAGE_MESSAGES = 50`）。
      所以会话一超过约五十条消息，`hasMore` 恒为真，**整个视图的折叠被全局关掉**，没有任何设置能打开。
      实测用户当时那个会话：1024 个事件 / **109 条 surface 消息** / 3 个 turn / 42 个 step / 61 次工具调用。
      **这一条决定了实现方式**——不能只改 dsh 那条线的文案，必须自带一套不依赖该门的折叠
- [x] 新建插件包 `packages/plugins/exec-process`（`@dsh-remote/dsh-plugin-exec-process`），**双半**；
      宿主半是**空插件**（本插件全部行为在浏览器），它存在只为让 dsh 的客户端模块系统顺着 overlay
      找到 `package.json` 并下发 `dist/client.js`
- [x] 三处注册：① 自己的 `ConversationNodeDefinition`（kind `exec-process`）只提供**位置**，
      窗口与边界直接读 dsh 自己发布的 `turn-process` Turn 数据（**那份投影不受 `historyIncomplete` 影响**，
      被关掉的只是呈现）；② `conversation.chat.node` 的 `exec-process` 键渲染这一行；
      ③ 用 **`priority: -1` 影子覆盖** dsh 自己的 `turn-process` 渲染器
- [x] ⚠️ **顺带更正了 docs/02 §8.5 与 §10.7 的一条旧结论**：keyed 槽并非「一个 key 只能有一个注册者」，
      alpha.4 支持**按 priority 影子覆盖**（priority 小的渲染，**同** priority 才抛错），
      所以「接管 dsh 已占的 key」是框架公开支持的能力、且与加载先后无关；「并列添加」才必须另找 list 槽
- [x] 覆盖 dsh 控件的那个条目不是只画空——它把 dsh 的 disclosure **强制常开**，
      于是 dsh 不再隐藏任何行（包括本插件那一行，它就落在同一个 seq 窗口里），
      转录里只剩**一套**折叠机制，长短会话行为一致
- [x] 折叠实现是**按 `data-chat-flow-key` 命中的运行时样式表**，**零 DOM 写入**：
      `useSearchableHidden` 会 set/remove 同一批 wrapper 的 `hidden`，外部写属性等于和它抢同一个元素。
      隐藏用**零高度 + `content-visibility:hidden`** 而不是 `display:none`——dsh 靠行 rect 的有序性
      二分查找阅读位置（`ChatView.tsx:93-104`），全零 rect 会让翻页后落回错误的位置；
      列间距规则特异度 0-7-0，必须 `margin:0!important` 抵消，否则六十行隐藏行留下上千像素空白
- [x] 统计口径（用户拍板「工具报错 + 模型重试都算失败」）：思考 = `assistant-step` 里非空 reasoning 块；
      工具 = `tool-call` 根节点；失败 = 工具结果 `isError` + `model-retry` 的 attempts；
      最近一次动作 = 折叠范围内最后一次工具调用的名字。成员判定**照抄** dsh 的 `processMember` 与
      `TURN_PROCESS_INDEPENDENT_KINDS`，否则会把用户消息或正式回答一起折进去
- [x] 性能：`useMemo` 的依赖用 `locations.getTurn(turn)` 的**数组身份**——dsh 在成员节点数据变化时
      故意换新数组、其他 turn 不动，所以底部正在流式的一轮不会让上面四十行重算
- [x] 用户拍板的两条范围：**不画框**（沿用 dsh 那条 0.5px 细线与它的全部颜色/尺寸）、**默认折叠**。
      （「只做已完成的轮次」第三轮被推翻、「不画框」第四轮被推翻，见下；只有「默认折叠」一直没变）
- [x] 82 项单元测试（成员判定与计数 24 / 样式表 13 / 节点定义 18 / apply 注册 10 / 文案与行外观 17），
      两半 typecheck + 构建通过，全仓库 lint 0 error
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、`scripts/pack.mjs`（两张表）；
      `scripts/dev-stack.mjs` 走 `local-config.mjs` 的目录扫描，无需改动。launcher 的 workspace 依赖也加了一行
- [x] 真机冒烟 `node scripts/exec-process-check.mjs`：**先把构建产物放进 vm 跑一遍 `apply()`**
      （确认注册了会话节点定义、两个座位、覆盖用的 priority 非 0、四个副作用都可撤销），
      再起一个真 dsh 确认全部 `--patch` 正常启动、`__DSH_BOOT__` 有本插件的行、combo bundle 200
      且带着槽注册与折叠依赖的属性名。
      ⚠️ 这个脚本比兄弟插件多做第一步是有原因的：本插件**没有宿主行为**，
      「dsh 启动成功」证明不了插件是对的，而 keyed 槽同 priority 重复注册的抛错发生在**浏览器**，
      会把整个 web UI 带走
- [x] **真实浏览器里的活体验收**（CDP 驱动 Chrome，另起一个独立 dsh + 临时 home，
      把真实历史会话复制进去打开；不碰用户正在用的那个 dsh）。**两条分支都走到了**：
      · **长会话（`hasMore` 为真，dsh 自带折叠已死）**：转录里出现两行「执行过程」，
        分别是 `思考 11 次 · 工具调用 22 次 · 最近 read`（33 个成员）与 `思考 3 次 · 工具调用 4 次`（7 个），
        **默认折叠**；样式表里 40 条选择器命中的**只有** `assistant-step`(14) 与 `tool-call`(26) ——
        用户消息、三条上下文注入、正式回答、turn-tail、系统提示词**全都没被折进去**；
        点开后 40 → 7（另一轮仍折着），22 个工具行原样回来，两轮互不影响。
      · **历史加载完（`hasMore` 为假，dsh 自带折叠会生效）**：dsh 给 46 行打了
        `data-turn-process-member`，但 `data-turn-process-hidden` 是 **0** —— 影子条目
        把 dsh 的 disclosure 强制常开了，dsh 一行都没藏；dsh 自己的控件座位是**空的**
        （`<div data-slot=… style="display: contents;"></div>`，高度 0、无文字），
        没有出现两条控件。
      · **深浅色都看了**：浅色 `rgb(97,102,107)` / `rgba(0,0,0,0.1)`，
        深色 `rgb(207,211,214)` / `rgba(255,255,255,0.12)` —— 四个 `--dsw-*` 变量**全部真的跟着主题走**，
        没有一个静默落到硬编码兜底（这正是 docs/02 §8.6 那个坑的检查方式）。
      · 折叠态下可见行的 `getBoundingClientRect().top` 仍然**单调递增**，
        证明「零高度」而不是 `display:none` 的选择成立。
      · 顺带验证了生命周期：设置页改主题会让浏览器半重新 apply 一次，
        之后页面上**各只有一张**样式表（chrome / fold），没有泄漏、没有重复注册。
- [x] **第二轮用户反馈：分段 + 吸顶**（「展开后全平铺到页面上，想收起还得一路往回滚」「执行过程里似乎
      还有 agent 发出的正式消息？我最初的想法是，有正式消息就不在执行过程里，正式消息后面再出来一个新的
      执行过程」）：
      · 新增第二个 `ConversationNodeDefinition`（kind `exec-process-step`），按 `turn:step` 建 Context，
        在正式消息之后 `+0.04` 处再开一条「执行过程」（最初是 `+0.2`，第十轮修正）；没说过正式话的 step 出 `visibility:'hidden'`
        而不是撤回节点（**撤回已物化的节点会被引擎判错**）。折叠成员判定加一条自己的规则：
        **带可见文字的 `assistant-step` 永不折**，哪怕它同时派了工具
      · ⚠️ **「内部滚动条」做不到，已明确回绝**：要折的行是 dsh 自己的**兄弟节点**，
        `overflow` 只裁剪后代，套容器就得搬动 React 拥有的节点。改为**展开时吸顶**：
        `position: sticky` 必须写在 **dsh 的 `.flowItem` wrapper** 上（`:has()` 反选，零 DOM 写入），
        写在自己按钮上完全无效 —— sticky 出不了自己的 containing block，实测滚 900px 后 `top` 是 −900。
        事实链记进 docs/02 §11.7
- [x] **第三轮用户反馈：运行中不折、正式回答上方漏出一个思考块**：
      · **运行中也折**（推翻第一轮「只做已完成轮次」那条范围）：去掉 `turnClosed` / `answerAnchorSeq`
        两道门，段的上界在运行时是无穷。⚠️ 关键是**必须跟随 chunk 事件** —— 引擎只对匹配到事件的
        Context 调 `buildViewNode`，不跟 chunk 的话那一行要等到第一个 `tool/call` 才出现，
        一段长思考会先整页铺出来再突然折起；chunk 事件用 `publication: 'animation-frame'` 压成一帧一次
      · **漏出来的思考块查清了**：那是 **dsh 自己**折叠机制的一部分 ——
        `AssistantNodeView.tsx:23-27` 收起时会连正式回答里的 `已思考` 一起藏，但它同样挂在 `foldable` 上，
        长会话恒为假。改为由段尾那条正式消息所属的这一段负责藏它：命中 `data-variant="think"`
        （语义属性，不是哈希类名），**这里必须用 `display:none`**（与整行相反）——它是行内部元素、
        不参与 rect 有序性，且只有 `display:none` 才连助手正文那 16px flex 间距一起去掉。
        事实链记进 docs/02 §11.8、§11.9
      · 顺带确认**折叠不会挡住审批**：审批卡与 `userQuestions` 渲染在 `conversation.composer`，不在消息流里
      · **真机活体验收（真跑了一轮）**：在独立 dsh 里发一条「连续三次 pwsh」的无害任务，
        运行中那一行实时显示「执行过程 思考 1 次 · 工具调用 3 次 最近 pwsh」、默认折起、
        被折的 `assistant-step`/`tool-call` 行高 0；结束后正式回答与 `turn-tail` 照常可见。
        长会话里 12 条段头全部默认折起，页面上**再没有一个 rect 高度非 0 的「已思考」漏在外面**。
        深色下 sticky 背景 `rgb(21,21,23)`、文字 `rgb(207,211,214)`、细线 `rgba(255,255,255,0.12)` ——
        `--dsw-alias-bg-base` 等四个变量都真的跟着主题走
- [x] **第四轮用户反馈：加圆角外框、标题字号调小、补一个「进行中」标识**：
      · **圆角外框**（推翻第一轮「不画框」）：只有一条下边线时，摘要读起来和上一条正式消息粘在一起。
        改成 `border: 0.5px solid var(--dsw-alias-border-l2)` + `border-radius: 8px`。
        ⚠️ **背景必须保持不透明的 `--dsw-alias-bg-base`，`:hover` 只能动边框色与文字色** ——
        dsh 的 hover 令牌 `--dsw-alias-interactive-bg-hover` 是半透明的，画进 background
        会让吸顶时下面滚过去的内容透出来
      · **字号**：走 dsh 的次级字号轴 `--dsh-content-font-size-secondary`
        （`gradient-shadow-text.css:56`，比正文小一档，每条流式行的标题/摘要都在这条轴上），
        而不是写死一个更小的 px —— 这样读者在设置里改字号时这一行才跟着变
      · **进行中**：`ExecLastAction` 加 `running`；工具用 dsh 的 `isRunningTool` 口径
        （settled 的 root 才有 `kind:'tool-result'`），思考用 `data.status === 'running'`。
        **并行工具按「还没结束的那个」算，不按「最后开始的那个」算** —— 并行调用会乱序结束，
        否则会在还有工具在跑时报「最近 xxx」。文案 `pwsh 进行中` / `思考中`
        （「进行中」是谓语跟在名字后，「最近」是状语放在名字前 —— 位置不一样是故意的），
        带一个呼吸的小圆点（名字被截断时它是留下来的那个状态标识；`prefers-reduced-motion` 下停）
      · **真机活体验收**：让 agent 跑一条 `Start-Sleep -Seconds 45` 的无害命令，运行途中读到
        `执行过程 工具调用 1 次 ● 进行中 pwsh`、`data-running="true"`，与 dsh 自己那行工具的
        `data-state="running"` 完全一致；结束后自动回到 `最近 pwsh`。深浅色都看了：
        深色下框线 `rgba(255,255,255,0.12)`、背景 `rgb(21,21,23)`、字号 13px
        （文案的前后顺序是这次验收之后按用户意见调的，只动 locale 一行）
- [x] **第五轮用户反馈：「进行中」放到工具名后面**（`pwsh 进行中`）—— 只改 locale 的一条模板串
- [x] **第六轮用户反馈：呼吸的圆点垂直方向不居中**：原来它是摘要文字的 `::before` + `vertical-align: middle`，
      而 `middle` 对齐的是**拉丁小写字母的 x-height 中线**，中文「进行中」的视觉中线比它低一截，
      所以在中英混排的这行里怎么调都偏上。改成**和文案并列的一个 flex 兄弟节点**
      （`flex: none` 的 6×6 圆角块），由那一行本来就有的 `align-items: center` 直接对齐；
      实测 `rowCenter === dotCenter === actionCenter === 381.6`。
      截断保护没丢：圆点在 ellipsis 的文字节点**外面**，名字被截掉时它仍留在原地
- [x] **第七轮用户反馈：滚过执行过程的全部内容之后，吸顶应该松开**（「现在是一直展示」）：
      吸顶写在 dsh 的 `.flowItem` wrapper 上，而它的 containing block 是**整条消息列**——
      浏览器那套「滚过内容就把 sticky 顶走」永远不会发生，于是表头一路吸到会话结束。
      · **补回推出**：每帧发布 `push = clamp(滚动容器顶 + 行高 − 本段最后一行的底, 0, 行高)`，
        令 `top: -push`。内容还在时夹到 0（普通吸顶），内容一完就与滚动**等速**滑出容器顶端。
        实测每滚 1px 推出 1px、`top` 从 0 连续走到 −32 —— 和真 containing block 一样，
        **不需要过渡动画，也不会跳**（硬切会在表头完全可见时突然消失，还会把它盖住的那 32px 内容一下子露出来）
      · ⚠️ **公式绝不能读表头自己的位置**：把 sticky 元素的当前位置反馈进它自己的偏移量，
        会「松开 → 量到自然位置 → 重新吸住」每帧震荡一次。只读滚动容器顶和内容底
      · ⚠️ **每行一个自定义属性**：屏幕上可以同时有两段，一段已经推出去、另一段还没吸住；
        实测 `push-1 = -32px` 与 `push-2 = 0px` 并存，共用一个值会把第二段直接顶没
      · **偏移量绕道 `<html>`**：不往 dsh 的节点写属性（§11.4），所以值写成 `<html>` 上的
        自定义属性，由本插件样式表里按 `data-chat-flow-key` 命中 wrapper 的规则读取。
        顺带把 `:has()` 依赖也去掉了——按 key 直接命中，不支持 `:has()` 的浏览器现在也能吸顶
      · **滚动容器现找不写死**：`ChatView.module.css` 给 `.scroll` 自己的 `overflow-y: auto`，
        但在 `[data-conversation-scroll]` 下又交还给祖先；实测命中的是 `wSkVaW_scrollBody`
      · **实机验收**（隔离 dsh + CDP）：吸住时 `top` 相对容器为 0、`position: sticky`、背景不透明；
        推出后 `push = -32px` 且表头完全不可见；反向滚回来重新吸住；两段同开时两条规则两份属性；
        收起第一段后它的规则与属性都消失，只剩第二段的
- [x] **第八轮用户反馈：收敛摘要状态与展开层级**：
      · 摘要改成紧凑的「思考N次·工具M次·失败K」，没有失败时省略「失败K」，失败计数与其余摘要同色；
      · segment 或整个 turn 结束后隐藏「最近动作」区，进行中的动作仍显示，呼吸点移到 chevron 左边；
      · 展开标题背景复用 dsh `TodoPanel` 的 `--dsw-specific-tip`；展开内容由一张按
        `data-chat-flow-key` 命中的运行时样式表画出连续的 `--dsw-alias-border-l1` 外框，
        **不移动 React DOM**
- [x] **第九轮用户反馈：展开后的思考 / 工具调用外框太淡且没有底色**：
      · 连续 frame 与 inline reasoning 父 wrapper 的描边从 `--dsw-alias-border-l1` 提升到
        `--dsw-alias-border-l2`，保留中性 fallback，仍用 0.5px 控制视觉重量；
      · 所有展开 member rows 与 inline reasoning 父 wrapper 增加不透明的 `--dsw-specific-tip` 背景，
        回退到 `--dsw-alias-bg-base`，深浅主题与 sticky/滚动时都不透底；
      · 不移动 DOM，不改变连续边框、首尾圆角、sticky 推出或折叠逻辑；单测锁定新 token 与 fallback，
        并明确禁止 frame 再使用 `border-l1`
- [x] **第十轮用户反馈：最后一轮最后一条正式消息的分叉按钮仍提示不可用**：
      · dsh 不只看可见消息，还要求 `turn-tail` 是该 turn 的最后一个 Chat Node；本插件原来的
        `exec-process-step = formalSeq + 0.2` 排在 dsh 的 `turn-tail = formalSeq + 0.1` 后面，
        即使该段最终没有内容、组件返回 `null`，节点仍在 Location 索引里，导致 `hasLaterChatNode` 恒为真；
      · 把段头改到 `+0.04`，严格位于正式消息之后、dsh 的 max-tokens `+0.05` 与 turn-tail `+0.1` 之前，
        不影响分段，但重新保证 turn-tail 最后、原生分叉可用；
      · 回归测试锁定 `formal < exec-process-step < max-tokens < turn-tail` 的排序边界
- [x] 192 项单元测试、两半 typecheck、构建、target oxlint 与范围内 `git diff --check` 全绿
- [ ] **用户实机验证**：重启 dsh（`pnpm build` + `pnpm dev`）→ 打开一个跑过几轮工具调用的会话 →
      每条正式消息之间应当只剩一个圆角小框「执行过程 思考N次·工具M次」（有失败再显示「·失败K」，
      已结束段不显示最近动作）→ 点开后标题底色与 todo 面板一致、原来的思考/工具行包在连续细框内，
      行头吸顶跟着走、**滚过这一段之后表头自己滑走** → 再点收起 →
      发一条新消息，看运行中是否也是折起的、右侧是否仍显示动作且呼吸点位于 chevron 左边

## 已完成 · GitHub Copilot 订阅登录插件（`packages/plugins/copilot-auth`）

> 起因：用户想用 Copilot 订阅跑 dsh，而订阅根本不发 API 密钥。
> 核实后发现：**dsh 已经内置了 Copilot（pi-ai 目录），缺的只是一个能跑登录的界面**。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §7。

- [x] 新建插件包 `packages/plugins/copilot-auth`（`@dsh-remote/dsh-plugin-copilot-auth`），**双半**：
      宿主半走 `--patch` 叠加层，浏览器半由 dsh 的客户端模块系统按 `dsh.client` + `exports["./client"]` 下发
- [x] 界面入口：**设置 → 模型** 页的官方扩展槽 `settings.models.provider-card`（keyed，key=`llm-pi-ai`），
      只在 `github-copilot` 那张卡上渲染登录区（卡片自带的 API 密钥字段盖不掉，只能追加 —— 用户已拍板）
- [x] 登录实现：直接跑 `@earendil-works/pi-ai` 的 copilot 设备码 OAuth（与 dsh 同版本 0.84.4），
      凭据经自写的 `CredentialStore` 适配器落到 `ctx.credentials` 的 `llm-pi-ai/github-copilot`；
      **不手写 OAuth、不挂 dsh 的 authorization 座**（避免从插件 value-import cordis 带来的模块实例同一性风险）
- [x] 登录成功后自动写 `llm-pi-ai.providers['github-copilot'].models`，按账号 `availableModelIds` 裁剪；
      退出登录只删凭据，不动用户配置
- [x] 前后端通道：`ctx.connection.rpc.handle('/copilot-auth', …)`，dsh 自动套上与 `/api` 同款的
      Host/Origin 围栏 + 浏览器认证（远程访问外面还叠着 relay 登录）
- [x] 只支持 github.com：pi-ai 开场问的企业域名一律答空串；它若问别的（密钥/选项）**报错而不猜**
- [x] 产物存在性检查扩展到 `dist/client.js`：`packages/launcher/src/dsh-plugins.ts`、
      `scripts/local-config.mjs`、`scripts/pack.mjs` 三处 —— **缺客户端 bundle 会让 dsh 的 web UI 整个起不来**（fiber FAILED）
- [x] 冗余验证：19 项单元测试 + `scripts/copilot-auth-check.mjs` 真机冒烟
      （临时 DSH_HOME 起一个 dsh：两个 `--patch` 正常启动、`__DSH_BOOT__` 有本插件行、combo bundle 200
      且是 `__ModuleLoader__.load` 工件、`/copilot-auth/status` 带 cookie 200 / 不带 401）
- [ ] **用户实机验证**：`pnpm dev` 后打开设置 → 模型 → 添加提供方 → GitHub Copilot → 点登录 →
      手机上输入设备码 → 回到页面看到「已登录」→ 模型选择器里选一个 Copilot 模型发一条消息

## 已完成 · 出网代理插件（`packages/plugins/proxy`）

> 起因：models.dev 抓不下来，查下来根因是 **Node 的全局 `fetch` 不读 `HTTP(S)_PROXY`**，
> 而 dsh 与 pi-ai 全程用全局 `fetch`、从不传 dispatcher —— 所以**对话、登录、web fetch/search 也都不走代理**。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §8.4a。

- [x] 新建插件包 `packages/plugins/proxy`（`@dsh-remote/dsh-plugin-proxy`），**双半**
- [x] 界面入口：设置页新增一个 **「代理」页面**（`settings.section`，`id: proxy`，order 60）。
      页面通过 `ctx.settingsScope.bind({namespace:'dsh-plugin-proxy'})` 读写设置命名空间 —— 这是 dsh 设置域自己的
      服务接缝，不跨插件 value import、也不自建传输
- [x] 三个字段：总开关 / 代理地址 / 不走代理的地址（**默认带回环地址**：dsh、relay、connector、
      本地模型服务全走 loopback，被代理劫持就全断）。文本框本地草稿 + 「保存」显式提交；
      校验挂在命名空间上，写入时就拒绝并指名字段
- [x] **修复：开关在全新页面上「点不动」**（用户实测发现）。原因是开关原本单独写 `enabled: true`，
      而校验器拒绝「开着但没地址」—— 全新页面 `url` 为空，于是唯一合理的第一个动作必然被拒、
      勾选状态回弹，看起来就是坏的；英文报错还显示在页面最底部，联系不起来。
      改为：**打开开关时连同地址一并写入**；没有地址则根本不写，改成地址框飘红 + 自动聚焦 + 中文提示
      「请先填代理地址」。关掉开关仍然立即写入。
      **经验**：客户端表单的每个控件都要问一句「这一次写入能单独通过宿主校验吗」——
      能被校验器拒绝的字段组合，就不该让用户单独提交
- [x] **刻意不读环境变量**：`EnvHttpProxyAgent` 对没显式传的字段会回落 `process.env`，
      所以每个字段都显式传（**含空串**）—— 页面显示什么，进程就做什么
- [x] 「测试」按钮走**全局 `fetch`**（刻意）：它要回答的是「dsh 现在能不能出网」，
      报状态码 / 耗时 / 是否经代理；只取响应头，`body.cancel()` 不下载正文
- [x] 生命周期：加载时记住当时的全局 dispatcher，卸载或关掉开关时原样还回去；
      换地址时先装新 agent 再关旧的，在途请求不被掐断
- [x] 17 项单元测试（地址校验、绕过列表归一化、装/换/还原 dispatcher、选项全显式不漏环境变量、
      测试端点、挂载后跟随设置变更）
- [x] **顺带修掉一个静默缺陷**：三个主题变量名一直是错的
      （`--dsw-alias-border-1` → `-border-l1`、`--dsw-alias-fill-2` → `--dsw-alias-bg-layer-2`、
      `--dsw-font-family-mono` → `--dsw-font-mono`），**写错不报错、只静默用兜底死值**，
      等于边框和行背景不跟随主题。三个插件（proxy / models-catalog / copilot-auth）已一并修正，
      事实记入 docs/02 §8.6
- [x] **同时简化 `models-catalog`**：删掉它的 `proxyUrl` 配置与 undici 依赖，抓取回到全局 `fetch`
      —— 一个进程级出口，而不是每个插件各配一份
- [x] 三处产物检查同步加上新插件（`dsh-plugins.ts` 里排在需要联网的插件之前、`pack.mjs` 两张表）
- [x] **修复：关掉代理后仍在走代理，页面却标注「直连」**（用户实测发现：关闭状态下测试返回
      「HTTP 200，1036 毫秒，直连」，而同一时刻独立进程直连 3/3 全部 10.7 秒超时）。
      两个错叠在一起：
      ① **还原目标可能是自己**——`original` 取自「构造时的全局 dispatcher」，而热重载会在旧 agent
      仍然装着时构造新实例，于是把**我们自己的代理 agent** 当成了「原始状态」；关闭代理 = 还原成代理本身。
      （这次正是我重新构建 `dist/index.js` 触发了热重载。）
      ② **UI 相信缓存状态而不是进程实况**，于是替一次走了代理的请求标注了「直连」。
      改法：给自己造的 agent 打上跨 realm 的 `Symbol.for('dsh-remote.proxy.agent')` 标记，
      **捕获还原目标时跳过带标记的**（退回全新 `Agent`）；`current()` 改为读**实时**全局 dispatcher。
      真 undici + 构建产物验收：重载后关闭代理 → `Agent` → 10.2 秒超时，与正常路径一致。
      **经验**：进程级副作用的插件，绝不能把「我接手时看到的状态」不加甄别地当作「原始状态」——
      热重载会让它变成你自己上一次留下的东西；对外报告状态要读实况，不要读自己的记忆
- [x] **同一 bug 的第二轮：真正的根因是我们自己有第二个代理来源**（用户重启后仍复现）。
      `packages/launcher/src/proxy-bootstrap.ts` 在检测到代理环境变量时被 `--import` 预加载进 dsh
      （`dsh.ts` 与 `dev-stack.mjs` 两处），所以 dsh 从启动起就挂着一个环境变量代理；
      插件把它当成「原始 dispatcher」，关闭代理 = 还原成它 → 照样走代理，而它没有本插件的标记 → 标注「直连」。
      改法：**「关闭」= 装一个全新的直连 `Agent`**，不再「还原我接手前看到的东西」；
      只有 `dispose()`（插件卸载）才还原环境原有的 dispatcher。
      在**预装环境代理**的条件下用真 undici + 构建产物验收：关闭 → 10.7 秒超时；打开 → 944ms 通；
      再关闭 → 10.2 秒超时；卸载 → 原样还回 `EnvHttpProxyAgent`。
      ⚠️ **连带后果**：这个版本加载后，launcher 那个环境变量 bootstrap 在开关关闭时**不再有任何效果**，
      用户必须在「设置 → 代理」里配好，否则 dsh 没有网络。这正是设计文档要的终局状态。
      **经验**：动手前先在自己仓库里搜一遍同类实现 —— 这次第二个代理来源和一份完整设计文档
      （`docs/proxy-plugin-design.md`）都在仓库里，我却一个都没查，违反了 AGENTS.md「开工前必须做的三件事」
- [x] ⚠️ **收尾：删除 launcher 的临时代理 bootstrap**（`docs/proxy-plugin-design.md` 的硬性要求）。
      已删 `packages/launcher/src/proxy-bootstrap.ts`，并清理 `dsh.ts`（`resolveProxyBootstrap` /
      `proxyEnvironmentConfigured` / `--import` 参数）、`index.ts`、`tsdown.config.ts`、
      `dev-stack.mjs`、`local-config.mjs`、`pack.mjs`（产物表 + 目录说明）、`launcher/tests/dsh.spec.ts`
      与 `docs/06-packaging.md`、`docs/reference/mobile-test.md`。
      **现在代理只有「设置 → 代理」这一个事实源，全链路不再读任何代理环境变量。**
      ⚠️ 运行前提：需要代理才能出网的机器，必须先在界面里配好并打开开关，否则模型请求会失败
- [x] ⚠️ **修复：页面存不进去、开关也勾不上**（用户实测发现；两层缺陷叠在一起）。
      **第一层——可见症状的根因**：`SettingsScope.mutate` 在**宿主拒绝**写入时是 **resolve 不是 reject**
      （dsh 的 `packages/client/ui-settings/src/client/settings-scope.ts:132-135`，它只是悄悄把宿主
      状态重新载入）。页面的 `try/catch` 因此是**死代码**：一次被拒的写入表现成「提示已保存 →
      所有字段弹回原值 → 没有任何错误」，而 `setDraft(undefined)` 还把用户刚输入的内容**当场丢掉**。
      **第二层——为什么会被拒**：校验器只接受带协议的地址，于是最常见的 `127.0.0.1:7890`
      （本地代理软件给的那种写法）被拒，而这个拒绝是隐形的。
      改法三条：① `parseProxyUrl` **补全缺失的协议**（`host:port` → `http://host:port`），
      并连同 `normalizeBypass` 与新增的 `proxyFault` 一起移进两半共享的 `shared.ts`，
      **让页面和宿主用同一套规则**（两份规则迟早不一致，而不一致的表现正是「页面收了、宿主拒了」）；
      ② 页面**写之前先在本地判一次**、**写之后读 `scope.getSnapshot().value` 核对是否真的落地**，
      没落地就报错并**保留草稿**；③ 报错**贴着出错的那个字段**显示，不再堆在页面最底部
      —— 这正是上一条修复里已经吃过一次的亏。
      顺带修掉「『已保存』提示会被自己成功的那次写入清掉」：记一份刚提交的 section 做比对。
      新增真机冒烟 `node scripts/proxy-check.mjs`：在真 dsh 上打 `/api/settings/mutate`，验证
      `127.0.0.1:7890` **被接受**、随后开关能打开，而 socks5 / 地址带凭据 / 开着却清空地址
      三条护栏**仍然被拒**。事实链记入 [02-dsh-facts.md](02-dsh-facts.md) §8.8。
      **经验**：别把「promise 没抛」当成「写成功了」—— 先查清这条 API 拒绝时到底 reject 还是 resolve
- [ ] **待决定**：设置命名空间是否由 `proxy` 改名为设计文档确认的 `dsh-remote-proxy`
      （字段 `url`/`bypass` → `proxyUrl`/`noProxy`）。现在只有一条配置，改名成本最低
- [ ] **用户实机验证**：重启 dsh → 设置 → 代理 → 填 `127.0.0.1:7890`（或你的代理地址，**不用写 http://**）
      → 保存应当看到「已保存」而不是弹回原值 → 勾上开关 → 点「测试」看到 200；
      再去模型页点「检查 models.dev」应当能拉到列表。
      故意填一个错的（比如 `socks5://127.0.0.1:1080`）应当**当场在地址框下面飘红报错**，
      且你输入的内容**不会被清掉**

## 已完成 · 失败重试插件（`packages/plugins/turn-retry`）

> 起因：用户提出「网络超时或别的问题导致 agent 运行失败后，现在必须重新发一条用户消息才能重试，
> 想要一个重试按钮」。
> 核实后发现：**dsh 自带的 `llm-retry` 已经会自动退避重试 5 次，缺的是它放弃之后的出路**。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §10。

- [x] 新建插件包 `packages/plugins/turn-retry`（`@dsh-remote/dsh-plugin-turn-retry`），**双半**
- [x] **只保留一个入口**：不再监听 `agent/request-error`，不再调用 `ctx.userQuestions`；
      自动退避仍完全交给 dsh 自带 `llm-retry`。用户只在 turn 结束后看到输入框上方的持久重试栏。
- [x] 把 `turn/end{error}` 与可恢复的停止结局折进 session projection `turnRetry`；
      刷新、换设备或稍后回来仍能看到 `[重试/继续]`。
- [x] 事后重试使用 plugin 溯源 + `form:'notice'` 的短通知，不重复原 prompt；
      会话里显示为折叠 context 行，不伪造用户气泡。
- [x] 删除旧的 `ask` / `askTimeoutMs` 配置、schemastery 依赖与 `dsh-user-questions` 依赖；
      浏览器横幅也删除「不再提示」，每种结局只剩一个主动作。
- [x] RPC 仍走 `/turn-retry/retry`，由 dsh 套 Host/Origin 围栏与浏览器认证。
      `@deepseek-ai/dsh-llm` 继续放在 runtime dependencies，因为按钮点击时要创建 branded message。
- [x] 投影状态形状未变，`stateVersion` 保持 2。
- [ ] **用户实机验证**：制造失败后只出现输入框上方横幅，不再弹大询问卡；横幅只有
      `[重试]` 或 `[继续]`，没有「不再提示」。

### 第二轮（用户反馈）：长错误装进可滚动的小容器，手动停止后也能接着做

> 起因：用户反馈两件事 ——「`上一轮失败了` 的错误信息太长，宽度超过消息区、高度占满整屏」，
> 和「手动停止之后想继续，还得再发一条用户消息」。

- [x] **宽度超出根本不是文本的错**：`conversation.input.dock` 那个栈只是竖排 flex，
      宽度上限在每张卡自己身上，不声明就铺满整个会话列（比输入框宽 32px、比转录正文宽更多）。
      横幅照抄 dsh 自己 dock 条目的那段几何（`margin:0 auto` + `width: calc(100% - 侧留白×2 -
      dock内缩×4)` + `max-width: calc(卡片上限 - dock内缩×4)`），事实写进 §10.7
- [x] 高度：横幅改竖排 —— **标题行**（标题 + 唯一的 `[重试/继续]`）+ **错误文本自己的滚动容器**
      （`max-height:7.5em`、`overflow-y:auto`、`overscroll-behavior:contain`、`pre-wrap` +
      `overflow-wrap:anywhere`），每层都写 `min-width:0`。
      按钮挪到标题行以后，它们的位置不再取决于错误信息有多长
- [x] 底色**不用 `--dsw-alias-bg-layer-*`**：浅色主题里 layer-1/2/3 是同一个白
      （§8.6a），用层级 token 会让这个框在一半主题里彻底看不见 —— 改用中性半透明灰
- [x] **宿主侧也截断**（`MESSAGE_LIMIT = 2000`）：投影是推给每个连着的浏览器的整值帧，
      供应商回一整页 HTML 时，光靠 CSS 遮起来不等于没传；给模型的通知另有更狠的 300 字上限
- [x] 投影从「只记失败」扩成「上一轮留下的活」：`turn/end` 的 `aborted{user}`（停止按钮）、
      `aborted{disposed|legacy}`、`interrupted` 折成 `kind:'stopped'`，`error` 仍是 `kind:'failed'`；
      `aborted{hook}`（钩子自己的决定）、`aborted{parent}`（父 agent 收子 agent）、
      `completed / blocked / max-tokens` 一律不给按钮
- [x] `stateVersion` 1 → 2：状态形状变了，不 bump 会让投影缓存把旧形状的值喂回页面
- [x] 停止的那一半**说人话**：按钮写「继续」不写「重试」，给模型的通知也不说「请求失败」——
      本来就没失败
- [x] 单元测试 50 项（fold 19 / 宿主 31，新增「wire schema 两个变体和 null 都能 parse」），
      冒烟脚本加一条「bundle 里带着 stopped 那半的文案」，`node scripts/turn-retry-check.mjs` 全绿
- [ ] **用户实机验证**：手动停止一轮 → 输入框上方出现「上一轮被你停止了 …[继续]」→ 点它接着做；
      再制造一次超长错误 → 横幅高度封顶、错误文本在自己的框里滚动、按钮不跑位

### 第三轮（用户反馈）：只保留重试栏，并保护排队消息

> 用户明确取消失败当场的大询问卡，也不需要横幅上的「不再提示」；同时报告点击重试会误发排队消息。

- [x] 删除 `agent/request-error` / `ctx.userQuestions` 整条路径，失败后只显示持久重试栏。
- [x] 删除「不再提示」按钮及本地 `dismissedTurn` 状态；失败与停止横幅都只剩一个主动作。
- [x] 查清 bug：`followup` 把 notice 追加到 `nextTurn` 尾部，首步却先领取全部 `nextStep`
      和 `nextTurn[0]`；失败后已有队列时，点击重试实际先发送旧用户消息。
- [x] 宿主 fail closed：`nextTurn` 非空时返回 `pending-input`；
      不调用 `followup`、不改 inbox、不产生新 turn，移除队列后仍可重试；`nextStep` 保持 dsh 原有语义。
- [x] 50 项单元测试通过，覆盖 nextTurn 拦截、nextStep 放行、冷会话、RPC 返回与单按钮结构；
      typecheck、构建、`turn-retry-check.mjs` 全绿，bundle 不含「不再提示」。投影形状未变，不 bump `stateVersion`。
- [ ] **用户实机验证**：失败时先排队一条消息 → 点重试只看到排队提示，队列不减少、消息不进入转录；
      删除排队消息后再点重试，才开始新的重试 turn。

## 已完成 · models.dev 模型目录插件（`packages/plugins/models-catalog`）


> 起因：用户问「不升级 dsh 能不能只更新供应商的模型列表」。
> 核实后发现：**改模型列表 dsh 本来就支持（配置层 `providers.*.models`），缺的是「知道上游出了新模型」**。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §8。

- [x] 新建插件包 `packages/plugins/models-catalog`（`@dsh-remote/dsh-plugin-models-catalog`），**双半**，
      与 copilot-auth 同形（overlay `--patch` + `dsh.client`）
- [x] 界面入口：**设置 → 模型**页的 `settings.models.footer`（list 槽）。
      **不是**每张卡旁边加按钮 —— `settings.models.provider-card` 是 keyed 槽且 `llm-pi-ai` 这个 key
      已被 copilot-auth 占用，重复注册直接抛错（docs/02 §8.5）
- [x] 数据源 `https://models.dev/api.json`，防御式解析（外部数据，字段全部可选、类型不对就丢），
      24 MiB 上限 + 30s 超时；`sourceUrl` 是插件配置项（公司网络 TLS 拦截时指内网镜像）
- [x] **代理支持**：本机直连 models.dev 是 `UND_ERR_CONNECT_TIMEOUT`，经 `http://proxy.example.com:8080`
      是 200 / 4.44 MB / 2.7 秒。**代理不由本插件负责** —— 交给 `packages/plugins/proxy` 的进程级
      全局 dispatcher，本插件只用普通的全局 `fetch`（原先的 `proxyUrl` 配置与 undici 依赖已删除）
- [x] 三条硬规则写在 `src/planning.ts`（纯函数，14 项测试）：
      ① **dsh 优先** —— 内置目录一旦有了某模型，插件写的那条降级成 `{id}`（改由 dsh 的目录描述），
      本插件不再拥有它；全部交还后**整个 `models` 键删除**，路由恢复原状。
      ② **只碰自己写的** —— 溯源存在插件自己的设置命名空间 `dsh-plugin-models-catalog`；
      没有溯源的列表（用户手写的、copilot-auth 写的）一律不改写，报 `foreign-models`。
      ③ **绝不编造协议** —— 跨协议路由（openai / github-copilot）报 `multi-protocol`，
      因为写进去会让 dsh 整体拒绝这次设置写入（docs/02 §8.2）
- [x] 「dsh 追上来了」的清理是**唯一不问就写**的动作（只删不加），并在面板上报告自己删了什么
      （`CatalogStatusView.reconciled`）；加载时跑一次，每次读取前再跑一次
- [x] 写入顺序：**先溯源、后模型**。模型写入被 dsh 拒绝时，溯源指向不存在的 id，
      而计划阶段会丢掉「列表里没有的溯源」，于是下一趟自我修复
- [x] pi-ai 与 schemastery 都**保持 external**（`tsdown.config.ts`）：内置目录必须是 dsh 实际服务的那一份，
      打进 bundle 的第二份快照会让「dsh 追上来了」判断失准
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、`scripts/pack.mjs`（两张表）；
      `scripts/dev-stack.mjs` 走 `local-config.mjs` 的目录扫描，无需改动
- [x] 36 项单元测试通过（planning 14 / host 12 / models-dev 10），两半 typecheck + 构建通过
- [ ] **用户实机验证**：`pnpm dev` → 设置 → 模型 → 页面底部「模型目录（models.dev）」→ 点「检查 models.dev」
      → 勾选供应商 → 「添加所选模型」→ 模型选择器里出现新模型；再点「删除本插件添加的模型」确认恢复原状

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
  - 账号名在初始设置向导里当作**可改的表单项**（预填 `admin`，字母/数字/`. _ -`，2–32 字符）；
    `passwd` / `totp reset` 不带 `--username` 时自动认库里唯一的账号，改过名也能救急
  - 密码策略（用户拍板）：**至少 6 个字符 + 大写/小写/数字/其他四类取三类**，替代原来的“至少 12 位、不限组成”；
    风险记在 docs/04 §6
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

## 已完成 · 常驻服务插件（`packages/plugins/services`）

> 起因：用户提出「pi coding agent 有个 `services` 扩展（`D:\dev\custom-skill\extensions\services`），
> 用来跑持久的 shell 命令、启动前后端服务，并提供一组服务工具；想在 dsh 里也加一个，
> 并且像 `D:\dev\pi-agent-chat` 那样在输入框上方加一个可折叠的服务面板」。
> 事实链见 [02-dsh-facts.md](02-dsh-facts.md) §13。

- [x] ⚠️ **先核实了「dsh 是不是已经有了」**：dsh **有**完整的后台任务运行时
      （`bash`/`pwsh` 的 `run_in_background` + `ctx.jobs` + `job_list/job_output/job_kill`），
      但它的生命周期**刻意**绑在会话上：`JobStart.owner` 的契约原文是
      「agent disposal cancels and awaits the job」，shell 那条线也写着后台进程随组合体拆除而停止。
      对 `pnpm build` 正确，对 `pnpm dev` 完全错误 —— 换会话或重启 dsh 就没了，
      而且 dsh 没有任何机制给长期进程**起名字**。**这一条决定了不复用 `ctx.jobs`**，
      改走 pi 那份扩展的 detached + 落盘具名注册表
- [x] 新建插件包 `packages/plugins/services`（`@dsh-remote/dsh-plugin-services`），**双半**。
      分四层：`shared.ts`（两半共享契约，不 import `node:*` 或 dsh）、`core.ts`（注册表 / spawn /
      就绪探测 / pid 身份，只依赖 `node:*`）、`manager.ts`（五个操作的**唯一**实现）、
      `index.ts`（宿主：工具 + 通道 + 批准门）。**工具和面板按钮走同一套 manager**，
      不存在「按钮做一套、工具做另一套」的分叉
- [x] 五个工具：`service_start` / `service_list` / `service_logs` / `service_stop` / `service_restart`。
      pi 那份用 `setActiveTools` 做按需加载，**dsh 没有这个接缝**（`ctx.tools.register` 就是全部
      注册面），所以五个一律常驻 —— 与其发明一个 dsh 没有的机制，不如接受这五个很小的 schema
- [x] ⚠️⚠️ **查实「插件不能 append 自己的会话事件类型」，这条差点造成永久性数据损坏**：
      `Session.append()` **没有** `ignorable` 参数，而类型不在构建期常量 `KNOWN_SESSION_EVENT_TYPES`
      里、又没有该标记的事件，会让持久化层**永久拒绝加载这个会话**。全仓库搜 `ignorable: true`
      只出现在测试里 —— 它是留给未来版本 dsh 的前向兼容字段，插件用不上。
      **连带结论：插件做 projection 只能折叠 dsh 已有的事件类型**（`turn-retry` 折 `turn/end` 合法，
      「发明一个事件再折它」不合法）
- [x] **面板因此走轮询，不走 projection**（两个独立理由，叠加后完全堵死）：① 上面那条；
      ② 就算能写，折叠也只报告「本插件上次做了什么」，而不是「操作系统现在有什么」——
      服务会自己退出、被手工杀掉、pid 被复用，注册表是**缓存**、真相是一次探测。
      顺带查实 **Host→Client 只有 session projection 一条推送通道**
      （`ctx.connection.rpc` 的流式 `open` 在浏览器传输里不提供）
- [x] 轮询是按手机 + relay 这条链路写的：**页面不可见就完全停掉**、可见时立刻补一次；
      运行时长在**本地**每秒自增，网络每 5 秒才碰一次。
      ⚠️ **运行时长用 host 的时钟**（`snapshot.now - startedAt + 本地流逝`），
      **从不跨两台机器做减法** —— 睡了一觉的手机时钟差几分钟是常态
- [x] ⚠️ **安全：补了一道沙箱批准门**（本轮第二个真发现）。web profile 挂的是**会真正约束的**
      `@deepseek-ai/dsh-pwsh-sandbox`（Windows 上落到 ACL 受限令牌），而权限预设只写
      `sandbox/mode` + `approval/policy` 两个旋钮、**不做逐工具拦截**；用 `node:child_process`
      直接 spawn 等于绕过全部这些。不管就会出现「用户选了受限预设，却有一个工具能逃出去，
      而且没人告诉他」。做法：`service_start`/`service_restart` 读**调用方会话**解析出的沙箱模式，
      `danger-full-access` **不问**（`bash` 本来就给了同样能力，再弹一次只是仪式），
      受限模式走 `ctx.approval` 征求人工批准、**只有 `allowed-once` 放行**，
      受限但没批准服务 / 没有归属会话一律 **fail closed**
- [x] **面板刻意没有「启动」按钮**：造一个服务要带命令，而「页面上一个能在沙箱外跑任意命令的
      输入框」和「一个能停掉你已经看得见的东西的按钮」性质不同。创建只能走带批准门的工具，
      那里既有审批也有转录记录。冒烟里有一条专门锁死通道上没有 `start` 端点
- [x] **pid 不是证据**（照抄 pi 的结论）：OS 会复用 pid，所以每条会杀进程的路径都先比对
      spawn 时刻与 OS 报告的创建时刻。`recycled` 与 `gone` 一样删条目但**绝不杀**，
      `unknown`（读不到创建时间）**拒绝自动停止**并给出手动命令。
      `unknown` 不是 `running` 的同义词，面板为它显示提醒、报告里标「(身份待确认)」
- [x] ⚠️ **修掉一个只有真机能发现的 bug：服务继承了用户的 PowerShell profile**。
      第一版照抄 pi 的启动器用 `shell: true`，实测日志里命令还没跑就先出现一段多行
      `Set-PSReadLineOption` 报错 —— 每份日志都带噪音、就绪正则可能匹配错，
      而一个会提问或很慢的 profile 会让服务**根本起不来**。改为**照抄 dsh 自己的 argv**：
      `pwsh -NoLogo -NoProfile -NonInteractive -Command <UTF8前缀><command>`，
      并叠上它的 `NO_COLOR/PAGER/GIT_PAGER`（否则 ANSI 转义会进日志、再原样显示在面板里）。
      启动器改成读 JSON 计划，才能传得进 flags。
      `tests/live.spec.ts` 有一条专门锁这个：**banner 必须是日志的第一行**
- [x] Windows 那层 node 启动器保留（pi 的三条实测结论仍然成立）：Node 的 `shell:true` 与
      `detached:true` 在 Windows 上不兼容；`DETACHED_PROCESS` 下 **pwsh 需要 console**、会立即退出；
      `cmd.exe` 能跑但**不转发子进程输出到继承的文件句柄**，日志永远是空的
- [x] 注册表落 `<会话项目目录>/.agents/services.json`、日志落 `.agents/logs/<name>.log`
      （**按项目目录**，用户拍板，与 pi 一致）。写入走 write-then-rename：它**不**让并发的
      read-modify-write 变安全，但保证没有读者会看到半个文件 —— 截断的 JSON 不会自愈
- [x] 面板占 list 槽 `conversation.input.dock`（order 10，在 dsh 自己的 todo=0 与队列=20 之间），
      **并列添加、不覆盖任何 keyed 槽**；宽度照抄 dsh 自己 dock 条目那段几何（docs/02 §10.7），
      主题变量名逐个核对（`--dsw-alias-border-l1` 是字母 l；浅色下层级 token 是同一个白，
      所以日志框用中性半透明灰而不是 `bg-layer-*`）
- [x] **66 项单元测试**，其中 `tests/live.spec.ts` 是唯一**真的 spawn 进程**的文件：
      其余测试注入探针（适合分支逻辑），而「进程是否真的脱钩、日志是否真的写出来、
      停止是否真的杀干净」是操作系统的性质，只能真做一遍。三条：完整生死循环、
      重名拒绝、启动即崩溃不留假条目
- [x] 顺带**加固了一处**：`isValidName` 的字符类允许 `.` 与 `..`（pi 那版也一样）。
      实测不可利用（`logPath` 会拼出一个名叫 `...log` 的文件，不构成穿越），
      但「安全性取决于记得 `path.join` 怎么处理后缀」的名字不值得留着，直接显式拒绝
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、`scripts/pack.mjs`（两张表）；
      `scripts/dev-stack.mjs` 走 `local-config.mjs` 的目录扫描，无需改动。
      launcher 的 workspace 依赖也加了一行
- [x] 真机冒烟 `node scripts/services-check.mjs` **23 项全绿**。
      ⚠️ 这个脚本比部分兄弟插件多做一步「把构建产物 import 进来跑一遍 `apply()`」：
      **dsh 没有把工具表暴露成任何 `/api` 方法**，所以「五个工具真的注册进去了」从进程外
      观察不到，而「dsh 能启动」只证明 `ctx.tools.register` 没抛错（重名会抛），
      证明不了注册的是哪五个、schema 转成了什么样。
      客户端产物也在 vm 里跑了一遍，确认只占一个座位、id/order/locale 都对
- [x] 全仓库 lint **0 error**、typecheck 通过、build 通过、全部测试通过（含既有 600+ 项）

### 第二轮（用户实机试用）：三个真 bug + 面板打磨

> 用户说「起一个前端让我看看效果」，一用就连爆三个只有真机能发现的问题。

- [x] ⚠️ **bug 1：带 `cwd` 启动的服务成了孤儿**。第一次演示用 `cwd` 把 vite 指到别处，
      结果 **vite 明明在跑，`service_list` 和面板都说「没有服务」**。根因是注释和实现不一致：
      注释写着「注册表永远放会话目录」，实现却只传了一个 `cwd`，同时当注册表位置、日志位置和
      工作目录。于是注册表落在了命令目录，而 list/面板只认会话目录 —— 服务活着但谁也管不到，
      只能手动 taskkill。改法：拆成 `root`（拥有服务的项目目录，恒为会话目录）与 `cwd`
      （命令的工作目录），日志跟 `root` 走，重启时从记录里回放 `cwd`
- [x] ⚠️⚠️ **bug 2：服务活不过 dsh 重启 —— 也就是这个插件的全部卖点是假的**。
      用户重启 dsh 后服务连同它一起没了。根因：launcher 停 dsh 用 `taskkill /T`，它**按记录的
      父 pid 递归**杀树，而 Windows 的 `DETACHED_PROCESS` 只解除**控制台**、**不清父 pid**。
      两条实测约束堵死了单进程解法（孙进程 detach ⇒ pwsh 没 console、日志全空；
      启动器直接退出 ⇒ 非 detached 的子进程陪葬），最终改成**两级启动器**
      （L1 起完 L2 就 exit 断链，L2 是 detached 的 node 常驻并托管 pwsh），注册表记 **L2** 的 pid。
      全程用「假 dsh + `taskkill /T`」探针逐条验证，事实链见 [02-dsh-facts.md](02-dsh-facts.md) §13.8
- [x] ⚠️ **bug 3（连带发现）：`dsh-remote-web` profile 根本没有 HMR**，所以「改完插件重新构建
      就生效」是错的 —— 宿主半不重载，浏览器半的 bundle 更是在注册时就被读成不可变快照下发，
      **连刷新页面都没用**。改完插件必须重启 dsh，改样式也一样（§13.7）
- [x] 面板按用户反馈打磨四项：① **没有运行中的服务就整个不画**（连「N 个已停止」都不显示）；
      ② **日志改到屏幕中央的弹窗**（dock 只有几行高，读不了 dev server 的输出）；
      ③ 标题前加**图标**；④ 背景从 `--dsw-alias-bg-base`（浅色下就是纯白，用户说「太白了」）
      换成 dsh todo 面板同款的**抬升层** `--dsw-specific-tip`，边框/圆角也对齐它的 0.5px / 12px
- [x] ②③ 都**向页面借 dsh 自己的东西**而不是自己实现：`Modal` 与 `IconApiOutline14` 来自
      `@deepseek-ai/dsh-client-ui-primitives`，它在 dsh 的 `PLATFORM_MODULES` 里，
      所以留成 external、连同已加载的 CSS 一起用，不打进 bundle 变成第二份。
      冒烟脚本新增两条断言锁住这一点（require 的说明符必须全在模块表里）
- [x] **70 项单元测试**（新增：跨目录仍可见、活过 `taskkill /T`、两级启动器形状、
      Windows 走 launcher 交回真 pid），冒烟 **25 项全绿**，全仓库 lint 0 error / 测试全过
- [ ] **用户实机验证（需重启 dsh 才生效）**：重启后让 agent `service_start` 起一个前端（带 `port`）
      → 输入框上方出现带图标的「常驻服务」折叠框，底色与 todo 面板一致 →
      展开是 `名字 :端口 pid 运行时长 命令` + 「日志 / 重启 / 停止」→ 点日志弹出居中弹窗 →
      点停止后**面板整个消失** → **切换会话再切回来服务还在**，
      **再重启一次 dsh 它仍然在**（这次才是真的）。受限沙箱预设下 `service_start` 应先弹审批卡

---

## 已完成 · 可交互终端插件（`packages/plugins/terminal`）

> 起因：用户提出「默认的 shell（bash / pwsh7）不支持用户输入，遇到要输密码或者别的交互式
> 指令就不好办了；参考 `D:\dev\pi-agent-chat` 的 `vscode_terminal`，加一个用户可交互的终端
> （按平台切换 bash 和 pwsh7），让用户能在终端里输入内容」。
> 核实后发现：**dsh 已经自带了大半**——`ctx.terminals` + `terminal-bash`（真 PTY，
> `shellDialect` 按平台切 bash/pwsh）+ 六个上游 `terminal_*` 模型工具，底层 node-pty 的
> 六平台预编译产物本来就躺在 node_modules 里。事实链见 [02-dsh-facts.md](02-dsh-facts.md) §14。

- [x] ⚠️ **先查清了「dsh 到底缺什么」**，结论是两件事，插件补的就是这两件：
      ① **web profile 一行都没挂载它们**（`bundle/base` 挂了 `dsh-subprocess-local`，
      所以 `spawnTerminal` 与 node-pty 本来就在进程里，但注册表 / 后端 / 工具全不在；
      只有 `sdk-minimal` 与 `minimal` 预设挂了）；
      ② **没有任何界面让「人」往里面打字** —— 六个工具是给模型的，网页里的 `TerminalBlock`
      是只读 ANSI 渲染。也就是说在这个插件之前，**密码只能由模型替你打进去**
- [x] 新建插件包 `packages/plugins/terminal`（`@dsh-remote/dsh-plugin-terminal`），**双半**
- [x] ⚠️ **PTY 三件套用 `ctx.plugin()` 挂，不是写在 overlay 里**（实测踩出来的）：
      dsh 的 loader 把 overlay 里的**裸包名**解析到 **profile 目录**
      （`<DSH_HOME>/profiles/<profile>/`），不是 overlay 所在目录、也不是 dsh 的安装位置，
      于是 `name: '@deepseek-ai/dsh-terminal'` 启动即 `ERR_MODULE_NOT_FOUND`。
      改成本包的普通 dependencies + 宿主半 `ctx.plugin()`，解析交给 Node，
      绿色包靠 `pnpm deploy --prod` 带进去。工作区是 `nodeLinker: hoisted`，
      全树一份 cordis，`Service` 基类同一性没问题（docs/02 §14.3）
- [x] **上游实现名保留 `terminal_open/send/read/signal/close/list`，插件只暴露
      `interactive_terminal_open/send/read/signal/close/list`**。实现是在上游 `apply()` 外包一层
      fail-closed wrapper：只接受预期六次注册；缺少、重复或未知注册时整组失败，绝不泄漏裸
      `terminal_*`。代价仍是六个 schema + 一段指引常驻，所以保留配置项 `mountTools`
- [x] **严格用途约束**：只有交互式 stdin 或终端状态必须跨调用保留时才用
      `interactive_terminal_*`；普通一次性命令（Git、构建、测试、脚本等）一律用 `pwsh` / `bash`，
      运行时间长本身不是理由，需要时用 `run_in_background`
- [x] **人类那半**：`conversation.input.dock`（order 15，在服务面板 10 与 dsh 队列 20 之间）
      加一个可折叠面板 —— 终端画面 + 输入框 + 中断。会话没开过终端时**整个不出现**
- [x] ⚠️ **安全边界（用户拍板）：面板只能往模型已经开好的终端里打字，不能自己开终端**。
      通道只有 `list` / `read` / `send` / `interrupt` 四个端点，**没有 `open` / `close`** ——
      造一个 shell 是「凭空多出一份能力」，只能走 turn 里的 `interactive_terminal_open`，那里有转录也有审批栈。
      与 `services` 插件「面板刻意没有启动按钮」是同一条取舍；冒烟脚本里有两条专门锁死这一点
- [x] 顺带查实**不需要再自建沙箱门**（与 `services` 插件不同）：`terminal-bash` 在
      `danger-full-access` 以外的每种模式下都先 `ctx.sandbox.confine()` 再启动 shell，
      受限预设下开出来的终端**是被 dsh 自己约束住的**（docs/02 §14.7）
- [x] ⚠️⚠️ **修掉一个只有真机能发现的 dsh 缺陷：Windows 上 pwsh 终端随机开不出来**。
      `terminal-bash` 的就绪判据是「私有提示符标记 + 恰好是提示符的可打印尾巴」，
      而 dsh 的提示符函数用 `[Console]::Write` 发标记、用**函数返回值**发提示符文字，
      两者走不同的路离开 pwsh，**PSReadLine 的持续重绘会把它们乱序**；抓到的原始字节里
      标记落在了下一条命令的回显之后，而启动循环之后只用**空**发送重试，于是开局乱序的
      会话再也回不来。PSReadLine 还让它**越用越坏**：每条命令都被写进用户真正的
      `ConsoleHost_history.txt`（dsh 自己那句 bootstrap 也在内），下次行内预测把它当幽灵
      文字补出来 —— 本机表现是「当天第一次成功，之后每次都失败」，一开始还误以为是 vitest 的问题。
      同机、间隔 500ms、其余一致的实测：**dsh 默认 argv 7/10（520ms），
      加上 `-NoExit -Command "Remove-Module PSReadLine …"` 后 20/20（460ms）**。
      `shellArgs` 是 `terminal-bash` 的配置项，所以这一修补完全在插件侧（铁律 1 不破）。
      **移除模块**而不是配置它：没有 PSReadLine 就没有重绘可乱序、没有预测、
      也没有东西去写用户的 shell 历史。bash 那侧保持 dsh 默认，不猜
- [x] 再补一道 `installStartupRetry`：给**每次**开终端一个独立超时（`startupTimeoutMs`，20 秒）
      并允许重试（`startupAttempts`，3 次）。理由是 `terminal-bash` 用同一个 `timeoutMs`
      兜住「一次发送」和「整个启动」，300 秒的发送预算会让一次失败的开终端挂 5 分钟。
      ⚠️ 它是打在**本插件自己挂载的那个 registry 实例**上的补丁 —— 上游实现的 `terminal_open` 直接调
      `spawn`，dsh 没留下拦截接缝；补丁挂在本插件 fiber 上，卸载即还原，且**绝不越过调用方
      自己的 abort**
- [x] ⚠️ **一次发送可能被拒，而草稿绝不能被清掉**：`ctx.terminals` 同一会话只允许一次发送，
      第二次**同步抛** `SEND_ACTIVE`。模型那次 `interactive_terminal_send`（内部调用上游 `terminal_send`）还在结算时，你敲的密码会撞上它。
      宿主侧因此会**等**（`sendWaitMs`，默认 10 秒，250ms 一试）——模型那次发送在输出静默约
      3 秒后结算，而「停在提示符上等输入」恰好就是这种状态。等不到就返回 `busy: true`，
      页面**保留已输入内容**：一个刚吞掉密码的输入框自己清空，是这个组件唯一不能有的失败方式
- [x] 面板走**轮询**（原因比 services 更硬）：三个 PTY 包**一个事件都不发布**，
      projection 无从折起；而插件又不能 append 自己的事件类型（docs/02 §13.3）。
      轮询按手机 + relay 这条链路调过：列表 5 秒、**画面 1.5 秒且只在展开时**、
      画面带 `revision` 没变化就只回一个短字符串、页面不可见全停、刚发送后 4 秒内加密到 400ms
- [x] **测试覆盖**：其中 `tests/live.spec.ts` 是唯一真起 PTY 的文件，跑的正是本插件的全部主张：
      模型发一条 `Read-Host` / `read -p` → 发送在**命令还等着输入时**就返回
      （`stdin_read` / `inferred_idle`）→ 由本插件的 `sendToTerminal` 把 `hunter2` 送进去 →
      scrollback 里读到 `GOT:[hunter2]`；另有一条真的制造 `SEND_ACTIVE` 并验证「短窗口被拒 +
      等够了就送达」
- [x] 三处产物检查同步加上新插件：`packages/launcher/src/dsh-plugins.ts`、`scripts/pack.mjs`（两张表）；
      `scripts/dev-stack.mjs` 走 `local-config.mjs` 的目录扫描，无需改动。launcher 的 workspace 依赖也加了一行
- [x] 真机冒烟 `node scripts/terminal-check.mjs` 通过。它比部分兄弟插件多做一步
      「把宿主产物 import 进来跑一遍 `apply()`」，理由在这里格外硬：**六个实现来自 dsh、插件只允许暴露改名后的六个工具、
      三个包是本插件挂上去的**，而 dsh 没有把工具表暴露成任何 `/api` 方法 ——
      「dsh 能启动」证明不了挂进去的是哪三个、模型是否只看见 `interactive_terminal_*`、看不见裸 `terminal_*`
- [x] **真实浏览器里的活体验收**（隔离 dsh + 临时 home + CDP 驱动的真 Chrome；脚手架在被 git
      忽略的 `.dev/`，含一个只在验收时挂载的探针 —— 因为面板**刻意没有**开终端的能力）。
      走通的是完整一条线：面板出现 → 默认折叠 → 展开看到真 shell 输出 → 往输入框打字 → 回车 →
      **在终端画面里读回自己打的那串** → 输入框被清空 → 深浅两套主题下 computed 值不同
      （浅 `rgb(255,255,255)` / 深 `rgb(21,21,23)`）→ 页面零未捕获报错。**连跑六次全绿**
- [x] ⚠️ 这轮验收逼出了**两个只在页面上才成立的缺陷**，都已修：
      · **`--dsw-font-mono` 从来没被 dsh 定义过**。名字是对的（AGENTS.md 也一直这么写），
        但在真页面里 `getPropertyValue('--dsw-font-mono')` 返回**空串**；回头对源码发现
        全 `packages/client/**` **引用四处、定义零处**，连 dsh 自己都一直在吃兜底
        （`ui-jobs` 那处甚至没写兜底，等于什么都没设）。所以兜底才是真正渲染的值 ——
        已改成 dsh 自己那条完整栈 `ui-monospace, SFMono-Regular, Menlo, monospace`
        （只写 `ui-monospace, monospace` 在 Windows 上直接落到浏览器默认 fixed 字体）。
        **教训**：§8.6 那套「名字有没有写错」的检查查不出这一类，只有在真页面里问一句
        `getPropertyValue()` 才知道。记进 docs/02 §8.6b
      · ⚠️⚠️ **一次「答不上来」的轮询会把整个面板卸载掉，连用户正在打的草稿一起丢**。
        二十次验收里出现一次：`unavailable: 'no-agent'`（会话重挂的一瞬间 agent 不在）
        被当成了「没有终端」。这正是本插件反复强调的那个失败（绝不能自己清空输入框），
        只是换了个入口。修法是把这个判断提成 `src/shared.ts` 里的纯函数 `foldPoll`：
        **只认确定的答案** —— 模型关掉终端时面板立刻消失，而连续三次答不上来才清空；
        另配 6 项单元测试。**教训**：把「会丢用户输入」的状态机留在组件里，就没人测得了它
- [ ] **用户实机验证**：`pnpm build` + `pnpm dev`（⚠️ 必须重启 dsh，刷新页面没用）→
      让 agent 开一个终端（例如「用 interactive_terminal_open 开一个终端，然后在里面跑一条会问我密码的命令」）→
      输入框上方出现「交互终端」折叠框，展开后是终端画面 + 输入框 →
      命令停在提示上时**你自己输入并回车**，看到它继续往下跑 →
      再试一次「中断」按钮 → 切到别的会话再切回来，面板跟着会话走

---

## 工具状态视图（tools-inspector 插件）

> 用户需求：「在会话头部的视图切换栏增加一个『工具』，让用户看到当前会话注册了哪些工具、
> 哪个用过、用了多少次、哪个是延迟加载还没暴露给 agent。」
> 核实后发现最后一问的前提不成立：**dsh 没有工具延迟加载**（见下），
> 所以状态只有「用过 / 没用过」两档，并在页面上把这个事实直接告诉用户。

- [x] ⚠️⚠️ **先查清了「dsh 到底有没有 deferred tool loading」，结论是没有**，
      事实链记进 [02-dsh-facts.md](02-dsh-facts.md) §15。三条证据：
      ① 全仓库搜 `setActiveTools|getActiveTools|activeTools` **零命中**
      （对照 pi-coding-agent 有这组 API，用户给的 `D:\dev\custom-skill\extensions\services`
      就是它的实例，`core.ts:509-524` 的 `planToolLoad` 只增不减以保住 prompt 缓存前缀）；
      ② `ToolRuntime.view(scope)` 同步算出**唯一一个** `visible` 集合直接喂给系统提示装配，
      **注册即可见**，没有「已注册但未激活」的中间态；
      ③ dsh 每轮都重新 `assemble()` 并把工具**整体重排**，压根没把工具集当成需要保护的
      缓存前缀，也就没有做增量加载的动机。
      ⚠️ `llm-pi-ai/src/catalog.ts:240` 的 `deferredToolsMode: 'withhold'` **不是**这回事，
      它是 OpenAI-completions 协议兼容位的 disposition 表项，别拿它当证据
- [x] **用户拍板：不展示「模型不可见」那一组**（restrict 遮蔽 / 同名影子覆盖 / ptc 塌缩），
      只展示「已注册·已激活」里的用过与没用过。将来 dsh 若加了 active-set API 再补第三档 ——
      预留位置就是 `src/client/ToolsView.tsx` 的 `GROUPS` 和 `src/shared.ts` 的 `ToolStatus`
- [x] 新建插件包 `packages/plugins/tools-inspector`（`@dsh-remote/dsh-plugin-tools-inspector`），**双半**
- [x] **座位是 `conversation.view`（list 槽，order 20）** —— 这就是会话头部视图切换栏的来源
      （`ui-conversation/src/client/apply.ts:121-132` 把每个槽条目投影成一个 tab），
      范本是 dsh 自己的 `ui-trajectory`。**没有改 dsh 任何源码**。
      ⚠️ `label` 必须传 **thunk**，传字符串会把注册时的语言钉死，切语言后 tab 文字不变
- [x] ⚠️ **`ctx.tools.schemas(scope)` 的 scope 必须传 Agent**：agent preset 把工具挂在
      **每会话的 scope** 下（`preset/agent-presets/src/mount.ts`），不传只读得到全局层。
      冒烟里那个「没有活 agent 的会话」就只看得到 11 个插件工具，内置工具一个都没有 ——
      这正好反证了 scope 参数不是可有可无的
- [x] ~~⚠️ **计数只能活在内存里**：插件不能往会话日志 append 自定义事件类型，
      历史轮次无法回填、重启归零~~ —— **这条是错的，已被用户实机证伪并推翻，见下面「第二轮」**
- [x] **它是只读观察窗口**：不注册工具、不 `restrict`、不 `guard`，对 agent 行为零影响。
      冒烟脚本显式断言这三条 —— 技术上可以用 `restrict` 的 disposer 伪造一个 defer，
      但那是改变 agent 行为，不在观察工具的职责里
- [x] **界面**：一屏一列表不做仪表盘；统计带 + 搜索 + 两组（已用按次数降序 / 未用按字母序）；
      状态靠字形 `●`/`○` 不靠颜色（深色主题下颜色容易翻车，docs/02 §8.6）；
      次数右对齐等宽并写**完整兜底栈**（`--dsw-font-mono` 定义零处，docs/02 §8.6b）；
      点一行展开顶层参数（刻意不递归展开嵌套 schema，否则一屏 JSON）

### 第二轮（用户实机试用）：一个根本性错误 —— 计数源找错了

- [x] ⚠️⚠️ **用户重启 dsh 后看到「全部未使用」，一句话就证伪了上面那条「只能统计本次运行」**。
      根因是把 docs/02 §13.2 读串了：那条说的是**插件不能 append 自己的新事件类型**，
      我却当成了「插件读不到调用历史」——**两码事，读是完全可以的**。真实情况：
      · `tool/call` 是 dsh 的**持久化会话事件**，在构建期常量 `KNOWN_SESSION_EVENT_TYPES` 里
        （`session/src/known-event-types.ts:66`），而且 data **自带 `name`**（`types.ts:306`）；
      · `session.snapshotEvents()`（`session/src/index.ts:600`）直接给出整段不可变日志；
      · 宿主插件经 `ctx.agents.get(id)?.session` 就能拿到。
      改成**回放会话日志**后，统计覆盖**整个会话的全部历史**，dsh 重启、会话重开都不受影响。
      docs/02 §15.4 已整条重写（保留「曾经写错」的记录，避免下一个人重蹈覆辙）
- [x] ⚠️ **失败数要靠 callId 回填**：`tool/call` 才有 `name`，`tool/result` 只带可选的 `error`，
      而它的 callId 在 `message.source.callId` 与 `message.content[0].toolCallId`
      **两个等价位置**（`llm/src/message.ts:235,238` 同时写入），两处都要认。
      配不上对的（日志被截断、fork 前缀只剩一半）**安全忽略** ——
      数不出名字的失败宁可不算，也不要归到错误的工具头上
- [x] **教训**：「这个数据 dsh 存不存」这种问题，必须去翻**持久化事件类型表**，
      不能从一条讲「写入限制」的结论里推断「读取也不行」。
      单元测试全绿、31 项冒烟全过，都没能发现这个错 ——
      因为测的是「我实现的逻辑对不对」，而不是「我选的数据源对不对」
- [x] 单元测试 17 → **22 项**（新增回放、配对、半截日志、已下线工具不进快照等）；
      冒烟仍 **31 项全过**，其中两项改为断言「不再监听任何事件」与「从 `tool/call` 回放出次数」

- [x] **用户实机验证（已通过）**：重启 dsh 后会话头部切换栏出现「工具」，
      切过去立刻看到历史调用次数（不再是全部未使用）。用户确认满意

---

## 技能状态视图（skills-inspector 插件）

> 用户需求：「在会话头部的视图切换栏增加一个『技能』，让用户看到当前会话一共有哪些技能、
> agent 已经加载了哪些、技能是全局还是项目级，点击技能可以打开该技能的本地文件。」
> 与 tools-inspector 不同的是：这次用户问的四个问题**全部**都有精确答案，
> 事实链记进 [02-dsh-facts.md](02-dsh-facts.md) §16。

- [x] ⚠️⚠️ **先查清了「已加载」到底能不能精确回答，结论是能，而且覆盖整个会话历史**。
      dsh 有且只有两条把技能正文注入上下文的路径，**两条都留下持久化会话事件**：
      ① 模型自己加载 → `tool/call`，`data.name === 'skill'`，技能名在 `data.arguments`
      （`tool-skill/src/index.ts:127-156`）；
      ② 用户 `/技能名` → `agent/pre-step` 注入一条 `user/message`，
      `source.kind === 'skill-invocation'`、`source.name` 就是技能名（同文件 `:177-204`）。
      两个类型都在 `KNOWN_SESSION_EVENT_TYPES` 里，`snapshotEvents()` 给出整段不可变日志 ——
      **dsh 重启后依然准确**。这次一开始就吸取了 tools-inspector 的教训，没有再走内存累加
- [x] **「全局还是项目级」有权威答案**：`SkillSummary.source` 七个来源桶
      （project-dsh / project-agents / custom / user-dsh / user-agents / bundled / runtime），
      每个对应 `skill-filesystem/src/index.ts:246-258` 一个写死的根目录，**不需要按路径猜**。
      ⚠️ `SkillSource` 是**开放联合**（`… | (string & {})`），必须有「未知来源」兜底
- [x] ⚠️ **`ctx.skills` 的 scope 必须传 `ctx.agents.get(sessionId)`**——与 tools-inspector
      同一个坑（§15.3）。实测对一个没有活 agent 的会话查询，**技能数为 0**，
      项目的 `.agents/skills` 一个都读不到。`cwd` 同样不能省（项目级技能根由它解析）
- [x] ⚠️ **用 `snapshot()` 而不是 `list()`**：前者多给一个 `complete`，
      provider 中途失败时为 false。`list()` 只会安静地少几个技能（失败被 `logger.warn` 吞掉），
      页面会显示成「技能凭空消失」；有了 `complete` 才能如实提示「这份列表可能不全」
- [x] ⚠️ **`list()` 拿不到文件路径**：`toSummary()` 只抄 7 个字段，`path` 不在其中；
      `SkillSummary` 上只有 `resourceBase`（技能**目录**）。精确的 `SKILL.md` 只有
      `skills.get()` 给，而那会**连带把整个正文读进内存** —— 所以拆成独立的 `locate` 端点，
      **只在用户点开某一行时调一次**，绝不在列表里批量取
- [x] ⚠️ **`tool/call.arguments` 是模型原样产出的未解析字符串**（dsh 注释原话），
      取技能名必须把 `JSON.parse` 包在 try 里：一条畸形历史记录不该让整个 tab 崩成错误页。
      单测有专门用例钉住这条
- [x] **「打开本地文件」用 dsh 自己的 Remote**：`session.canOpenWorkspacePath()` +
      `openWorkspacePath({ path })`（`api/session-controller/src/index.ts:262,274`），
      浏览器半 `inject: ['remote', 'remote.session']`。**不自己 spawn** ——
      自己 spawn 就绕过了沙箱，而这件事 dsh 已经做好了。
      ⚠️ 它打开的是**宿主机**桌面，对手机远程完全不可见，所以**先探测、能开才显示按钮**，
      路径本身无论如何都显示成可复制的等宽文本
- [x] 新建插件包 `packages/plugins/skills-inspector`（`@dsh-remote/dsh-plugin-skills-inspector`），**双半**
- [x] **座位是 `conversation.view`（list 槽，order 30）**，排在 chat(0) / trajectory(10) /
      工具(20) 之后。⚠️ `label` 仍必须传 **thunk**
- [x] **用户拍板两条**：①「已加载」取**全历史回放**口径（可回放、重启后准确，
      与工具页一致；另一种「当前上下文里仍在场」的口径因 dsh 会压缩历史而算不准）；
      ② **不加「/加载」快捷按钮**，保持只读观察窗口的约定
- [x] **它是只读观察窗口**：不注册技能、不注册技能来源、不注册工具、不 restrict、不 guard。
      冒烟脚本显式断言这几条
- [x] **界面**：与「工具」tab 共用一套视觉语言；「已加载」独立成第一组（按最近加载倒序），
      未加载的**按来源分组**（组标题 =「中文人话 + 灰色真实路径」，一次讲完概念与磁盘位置）；
      加载方式用「模型 / 用户」两字标注不用图标；状态靠字形 `●`/`○` 不靠颜色；
      「仅用户可调用」（`disable-model-invocation` 技能）单独挂一个微标
- [x] 单元测试 **27 项**（回放两条路径、失败不算、未配对要算、畸形 JSON、分组、排序、过滤）；
      冒烟 **42 项全过**，其中一段**直接对着真的技能注册表**验
      `list()` 无 `path` / `get()` 有 `SKILL.md` 的链路 ——
      那条链路一旦被上游改掉，页面会安静退化成「这个技能没有本地文件」，
      单测与 HTTP 冒烟都看不出来
- [x] **用户实机验证（已通过）**：重启 dsh 后会话头部切换栏出现「技能」tab，
      技能列表、来源分组、已加载状态均正常。用户确认满意

---

## 进度记录

| 里程碑 | 状态 | 完成日期 | 备注 |
|---|---|---|---|
| M0 | 进行中 | | M0.1/M0.2/M0.4 完成（见 reference/m0-report.md）；M0.3 待用户手机实测；M0.5 未做（不阻塞） |
| M1 | 进行中 | | M1.1–M1.4 完成；M1.5 隧道数据面已由 6 项集成测试覆盖并通过，**剩「浏览器长时间实操」类验收**（>30min WebSocket、断网重连、图片附件）待用户实测 |
| M2 | 基本完成 | | M2.1–M2.6 全部完成（设备认证、用户认证+TOTP、安全检查顺序、管理页、审计日志）；验收仅剩「连错 5 次被锁」未做浏览器实操（会把管理员锁 15 分钟，单测已覆盖） |
| M3 | 未开始 | | |
| M4 | 未开始 | | |
| M5 | 未开始 | | |
| M6 | 未开始 | | |

### 插件（不属于 M 序列，按需求随时插入）

| 插件 | 状态 |
|---|---|
| remote-privileged / proxy / copilot-auth / models-catalog / turn-retry / exec-process / notify / services / terminal | 已完成并经用户实机验证 |
| tools-inspector（工具状态视图） | 已完成并经用户实机验证 |
| skills-inspector（技能状态视图） | 已完成并经用户实机验证 |
