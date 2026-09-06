# @dsh-remote/dsh-plugin-services

常驻服务：把 `pnpm dev` 这类**永不退出**的命令交给一个带名字的注册表管起来，
并在 dsh 输入框上方给它一个可折叠的面板。

起因：用户提出「pi coding agent 有个 `services` 扩展，用来跑持久的 shell 命令（启动前后端），
还带一组服务工具；想在 dsh 里也加一个，并且像 pi-agent-chat 那样在输入框上方显示当前服务」。

---

## 为什么不用 dsh 自带的后台任务

dsh **已经**有后台任务运行时：`bash` / `pwsh` 带 `run_in_background`，注册进 `ctx.jobs`，
再由 `job_list` / `job_output` / `job_kill` 收集和停止。核实之后仍然新建了这个插件，
因为那套运行时的生命周期是**刻意**绑在会话上的：

| 事实 | 出处 |
|---|---|
| `JobStart.owner`：「agent disposal cancels and awaits the job」 | `packages/jobs/jobs/src/types.ts` |
| 后台进程在其组合体拆除时被停止并等待 | `docs/subsystems/shell.md:242` |

对 `pnpm build` 这完全正确；对 `pnpm dev` 完全错误 —— **换个会话、重启 dsh，你正在用的
开发服务器就没了**，而且 dsh 里没有任何东西能给一个长期进程起名字以便回头找到它。

所以本插件照 pi 那份扩展的做法：**detached 起进程 + 落盘的具名注册表**。
引擎在 `src/core.ts` 与 `src/manager.ts`，两者都不 import 任何 dsh 包。

---

## 五个工具

| 工具 | 作用 |
|---|---|
| `service_start` | detached 启动一个常驻命令，立刻返回；带就绪探测（端口 / 日志正则 / 定时） |
| `service_list` | 列出运行中的服务与已停止但日志尚在的名字；**每次调用都与操作系统对账** |
| `service_logs` | 读日志尾部；**服务已经死了也能读**，那正是最需要它的时候 |
| `service_stop` | 杀整棵进程树 |
| `service_restart` | 用**启动时记下的**命令重启 |

> pi 那份扩展用 `setActiveTools` 做了工具的按需加载。dsh 没有这个接缝
> （`ctx.tools.register` 就是全部注册面），所以五个工具一律常驻。
> 与其发明一个 dsh 没有的机制，不如接受这五个很小的 schema。

---

## ⚠️ 安全：常驻服务跑在沙箱之外

这是本插件唯一需要你读完的一段。

dsh 的 web profile 挂的是**会真正约束的** shell 执行器
（Windows 上是 `@deepseek-ai/dsh-pwsh-sandbox`，落到 ACL 受限令牌），
权限预设里的 `read-only` / `workspace-write` 是真的限制。
而本插件用 `node:child_process` 直接 spawn，**绕过全部这些**。

如果不管，就会出现「用户选了受限预设，却有一个工具能逃出去，而且没人告诉他」。
所以 `service_start` 与 `service_restart` 会读**调用方会话**当前解析出来的沙箱模式：

| 沙箱模式 | 行为 |
|---|---|
| `danger-full-access` | **不问**。`bash` 本来就给了同样的能力，再弹一次只是仪式 |
| 其他任何模式（受限） | 走 `ctx.approval` **征求人工批准**；只有 `allowed-once` 放行 |
| 组合体里没挂沙箱 | 不问 —— 没有东西可逃 |
| 受限但没挂批准服务 / 没有归属会话 | **拒绝**（fail closed） |

配置项 `approvalInConfinedSandbox`（默认 `true`）可以关掉这道门；关掉等于明确接受
「服务静默逃出沙箱」，它**永远不会**削弱 `danger-full-access`（那本来就不问）。

面板上**刻意没有「启动」按钮**：造一个服务要带命令，而「页面上一个能在沙箱外跑任意命令的
输入框」和「一个能停掉你已经看得见的东西的按钮」是两件性质不同的事。
创建只能走带批准门的工具，那里既有审批也有转录记录。

这一层与本仓库既有的威胁模型一致（`docs/04-security.md` §6：「bash 即 RCE」），
它**加固**的是「受限预设应当名副其实」，**不改变**「relay 认证是唯一防线」。

---

## 面板为什么是轮询的

`conversation.input.dock`（**输入区停靠区**，dsh 自己的说法是「Full-width entries above the
composer card」）是 list 槽，本插件在里面并列加一个可折叠条目（order 10，在 dsh 自己的
todo=0 与队列=20 之间）。数据走**轮询**，不是 session projection。
两个独立的理由，缺一条都不足以推翻，两条叠加则完全堵死：

1. **插件不能往会话日志里写自己的事件类型。** `Session.append()` 没有 `ignorable` 参数
   （`packages/core/session/src/index.ts:668-672`），而类型不在构建期常量
   `KNOWN_SESSION_EVENT_TYPES` 里、又没有该标记的事件，会让持久化层**永久拒绝加载这个会话**
   （`session-persistence/src/coordinator.ts:1248-1253`）。projection 要有事件可折，
   这条路等于拿一个面板换一堆坏掉的日志。
2. **就算能写，折叠也只能报告「本插件上次做了什么」，而不是「操作系统现在有什么」。**
   服务会自己退出、被手工杀掉、pid 被复用。注册表是**缓存**，真相是一次探测 ——
   pi 那份扩展每次调用都与 OS 对账，正是同一个原因。

轮询是按手机 + relay 这条链路写的：**页面不可见就完全停掉**，可见时恢复并立刻补一次；
运行时长在**本地**每秒自增，网络每 5 秒才碰一次；载荷是几个短字符串。

⚠️ 运行时长用的是 **host 的时钟**（`ServicesSnapshot.now`）：页面渲染
`snapshot.now - startedAt + (本地现在 - 收到时刻)`，把一次绝对的宿主测量和一次纯本地的
流逝测量拼起来，**从不跨两台机器做减法** —— 睡了一觉的手机时钟差几分钟是常态。

### 面板的三条呈现规则

- **没有运行中的服务就整个不画**（连「N 个已停止」都不显示）。dock 夹在转录和输入框之间，
  放在那里的东西每一轮都在占用户的竖直空间，一个「没有东西在跑」的框没有挣到这个位置。
  服务死了要看日志，走 `service_logs` 工具。
- **日志开在 dsh 自己的 `Modal` 里**，不是行下面。dock 只有几行高，塞不下一个 dev server 的输出。
  `Modal` 来自 `@deepseek-ai/dsh-client-ui-primitives` —— 它在 dsh 的 `PLATFORM_MODULES` 里，
  所以是**向页面借的**（连同它已经加载的 CSS），不是打进 bundle 的第二份；遮罩、模糊、
  Esc 关闭、body portal 全都跟着来，也就不会被 dock 的 `overflow: hidden` 裁掉。
- **弹窗宽度是量出来的，高度是固定的**。宽度取会话消息宽度的 80%（见下）；高度是
  `min(60vh, calc(100vh - 240px))`。⚠️ **固定高度而不是 `max-height`**：用最大值时框会随内容长，
  弹窗先以「正在读取日志…」的小尺寸打开、日志一到就跳一下；路径行同理（加载时不存在、
  到达后凭空多一行），所以它**恒定渲染并预留高度**。而那个 `min()` 不是装饰 ——
  `.root` 是 `position: fixed` + 居中、`.dialog` 又没有 `max-height`，视口低于约 555px 时
  裸 `60vh` 会让卡片**上下都被裁掉、且顶部点不到**（没有东西可滚）。
- **标题前的图标同样是借的**：`IconApiOutline14`（一个圆角方框里的 `>` 和 `_`，
  正好就是「一条常驻 shell 命令」），与 dsh todo 面板的 14px 图标同一套语汇、同一个尺寸。

---

## pid 不是证据

操作系统会**复用 pid**。所以每一条会杀进程的路径都先比对「我们 spawn 时记下的时刻」与
「OS 报告的进程创建时刻」：

| 判定 | 含义 | 处理 |
|---|---|---|
| `ours` | 活着且创建时间对得上 | 正常操作 |
| `gone` | 进程不在了 | 直接从注册表删掉 |
| `recycled` | 活着但创建时间对不上 —— 这个 pid 现在是别人的 | 删掉注册表条目，**绝不杀** |
| `unknown` | 活着但读不到创建时间 | **拒绝自动停止**，并给出手动命令 |

`unknown` 不是 `running` 的同义词。面板会为它显示一行提醒，
`service_list` 的报告里标「(身份待确认)」。
杀错一棵进程树没有撤销键，让人确认一次的代价小得多。

---

## Windows 上那两级 node 启动器

`shellInvocation()` 在 Windows 上返回的是「node 起 L1 → L1 起 L2 → L2 起真正的 shell」。
看着离谱，但每一层都是被实测逼出来的。

### 第一层原因：detached 起不来 pwsh，所以需要一个 node 中转

1. Node 的 `shell: true` 与 `detached: true` 在 Windows 上**不兼容**：命令不执行、输出全丢，
   退出码却是 0。
2. `detached: true` 对应 `DETACHED_PROCESS`，子进程**没有 console**，而 **pwsh 需要 console**：
   它会立即退出且不产生任何输出。`cmd /c pwsh`、`start /min`、`start /b` 三种写法均无效。
3. `cmd.exe` 在 detached 下能执行命令，但**不把子进程的 stdout/stderr 转发到继承的文件句柄**，
   日志永远是空的 —— 而日志是这个插件存在的意义。

### ⚠️⚠️ 第二层原因：`detached` 挡不住 `taskkill /T`（第一版就栽在这里）

第一版只有一级启动器，这份 README 当时写着「活过 dsh 重启」—— **那是假的**：
用户实机重启一次 dsh，服务就连同它一起没了，日志里 vite 正常启动、没有任何报错就消失。

- launcher 停 dsh 用的是 `taskkill /pid <dsh> /T /F`（`packages/launcher/src/supervisor.ts:76`）。
- `/T` 是**按记录的父 pid 递归**杀树，而 `DETACHED_PROCESS` 只解除**控制台**、**不清父 pid**。
  所以「detached 的服务」在进程表里仍然是 dsh 的直接子进程，`/T` 一路走下来照杀不误。

两条实测约束把所有单进程解法都堵死了：**孙进程不能 detach**（回到上面第 2 条，日志全空）、
**启动器又不能直接退出**（Windows 上非 detached 的子进程活不过父进程退出 —— Node 文档对
`detached` 的措辞正是「makes it possible for the child process to continue running after the
parent exits」）。于是：

```
dsh → L1(node, detached, 起完 L2 立刻 exit) → L2(node, detached, 常驻) → pwsh(普通子进程)
```

- **L1 退出** ⇒ L2 的父 pid 指向一个已经不存在的进程 ⇒ 从 dsh 出发的 `/T` 枚举不到它。
- **L2 是 node**，不需要 console，所以 detach 它没有代价；pwsh 作为 L2 的普通子进程仍有 console。
- 注册表记的是 **L2 的 pid**（L2 经 sidecar 文件交回）：L2 在 shell 退出时才退出，
  所以「L2 活着」就等于「服务活着」，`killTree(L2)` 也正好带走 shell 及其全部后代。
  ⚠️ **不能记 L1 的 pid** —— 它几毫秒后就没了，`identify()` 会一律报 `gone`。

`tests/live.spec.ts` 里有一条专门锁这个：起一个子进程、由它启动服务，再对**这个子进程**
`taskkill /T /F`，然后断言服务仍然存活且仍被注册表认得。

### ⚠️ `-NoProfile` 是必需的，不是讲究

shell 与 flags 都**对齐 dsh 自己的执行器**：
`pwsh -NoLogo -NoProfile -NonInteractive -Command <command>`
（`packages/shell/pwsh-local/src/index.ts:220`）。

- 对齐 **shell** 是为了模型不用在两套方言之间切换。
- 对齐 **flags** 里 `-NoProfile` 是真正要命的那个：**本机实测**，不加它时用户的 PowerShell
  profile 会先跑一遍，把一段多行的 `Set-PSReadLineOption` 报错写进服务日志 —— 每份日志都带噪音、
  就绪正则可能匹配到错的文本，而一个会提问或很慢的 profile 会让服务根本起不来。
  `tests/live.spec.ts` 里有一条专门锁这个：**banner 必须是日志的第一行**。

同样照抄了 dsh 的 UTF-8 前缀（防 5.1 回退时中文变乱码）与 `NO_COLOR` 环境覆盖
（否则 ANSI 转义会进日志、再原样显示在面板的日志框里）。

---

## 文件

| 路径 | 内容 |
|---|---|
| `src/shared.ts` | 两半共享的通道契约与纯函数；**不 import `node:*` 或任何 dsh 包** |
| `src/core.ts` | 注册表、detached spawn、就绪探测、pid 身份；只依赖 `node:*` |
| `src/manager.ts` | 五个操作的唯一实现；工具和面板按钮都走它，不存在两套 |
| `src/index.ts` | 宿主半：五个工具 + `/services` 通道 + 沙箱批准门 |
| `src/client/` | 浏览器半：dock 条目、面板、文案 |

注册表落 `<会话项目目录>/.agents/services.json`，日志落 `<会话项目目录>/.agents/logs/<name>.log`
（与 pi 那份扩展一致，用户拍板）。写注册表走 write-then-rename：它**不**让并发的
read-modify-write 变安全（两个会话同时启动服务仍可能丢一行，下次对账会修好可见性），
但它保证**没有任何读者会看到半个文件**，而截断的 JSON 是不会自愈的。

---

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-services test   # 66 项，含真实 detached 进程的集成测试
node scripts/services-check.mjs                      # 23 项真机冒烟，升级 dsh 后跑
```

`tests/live.spec.ts` 是唯一真的 spawn 进程的测试文件：其余测试注入探针（适合分支逻辑），
而「进程是否真的脱钩、日志是否真的写出来、停止是否真的杀干净」是操作系统的性质，
只能真做一遍才知道。

`scripts/services-check.mjs` 比部分兄弟插件多做一步「把构建产物 `import` 进来跑一遍 `apply()`」：
**dsh 没有把工具表暴露成任何 `/api` 方法**，所以「五个工具真的注册进去了」从外面观察不到；
而 dsh 能启动只证明注册没抛错，证明不了注册的是哪五个。
