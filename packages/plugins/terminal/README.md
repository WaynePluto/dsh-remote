# @dsh-remote/dsh-plugin-terminal

可交互终端：一个**人可以往里面打字**的真终端（Windows 走 pwsh 7，POSIX 走 bash），
挂在 dsh 输入框上方。

起因：用户提出「默认的 shell 工具（bash / pwsh）不支持用户输入，遇到要输密码或者别的
交互式指令就没辙了；参考 `D:\dev\pi-agent-chat` 的 `vscode_terminal`，加一个用户可交互的终端」。

---

## 先说核实结果：dsh 已经自带了大半

这个插件**没有**自己实现 PTY。dsh 里本来就有一整套：

| 有什么 | 在哪 |
|---|---|
| `ctx.terminals`：按 Agent 归属的 PTY 会话注册表 | `@deepseek-ai/dsh-terminal` |
| 真 PTY 后端，**bash / pwsh 按平台切换**（`shellDialect`） | `@deepseek-ai/dsh-terminal-bash` |
| 六个模型工具 `terminal_open/send/read/signal/close/list` | `@deepseek-ai/dsh-tool-terminal` |
| 底层 PTY（node-pty，六个平台的预编译产物随包） | `packages/subprocess/subprocess-local` |

缺的正好是两件事，这个插件补的就是这两件：

1. **web profile 一行都没挂载它们。** `bundle/base` 挂了 `dsh-subprocess-local`
   （所以 `spawnTerminal` 和 node-pty 本来就在），但终端注册表、后端、工具全都不在；
   只有 `sdk-minimal` 与 `minimal` 预设挂了。
2. **没有任何界面让「人」往里面打字。** 六个工具是给模型的，网页里的 `TerminalBlock`
   是只读的 ANSI 渲染。也就是说，在这个插件之前，密码只能由**模型**替你打进去 ——
   而密码之所以是密码，正是为了不这么干。

事实链见 [docs/02-dsh-facts.md](../../../docs/02-dsh-facts.md) §14。

---

## 用起来是什么样

1. 让模型开一个终端：它调 `terminal_open`（六个工具由本插件挂上）。
2. 输入框上方出现「**交互终端**」折叠面板，展开是终端画面 + 一个输入框。
3. 命令停在 `PASSWORD:` 这种提示上时，**你自己在面板里输入并回车** ——
   进的是同一个 shell，模型看得到之后的输出，但你输入的内容不经过模型的参数。
4. 打错了或者想停下来，点「中断」（向前台进程组发 `SIGINT`）。

会话没开过终端时，面板整个不出现 —— 一个常驻的空盒子只会白占输入框上方的高度。

---

## ⚠️ 安全边界

面板上的输入框，本质上就是「**在网页里往一个 shell 打任意文本**」，
等同于远程执行任意命令。本仓库的威胁模型早就接受了这件事
（[docs/04-security.md](../../../docs/04-security.md) §6「bash 即 RCE」，唯一防线是 relay 登录）。
在此之上，这个插件划了两条线：

- **面板不能开终端，也不能关终端。** 通道只有 `list` / `read` / `send` / `interrupt` 四个端点。
  造一个 shell 是「凭空多出一份能力」，只能走 turn 里的 `terminal_open` ——
  那里有转录记录，也有审批栈。这与本仓库 `services` 插件「面板刻意没有启动按钮」是同一条取舍。
  冒烟脚本里有两条专门锁死通道上没有 `open` / `close`。
- **不需要额外的沙箱门。** 与 `services` 插件不同，本插件**不自己 spawn** ——
  `terminal-bash` 在 `danger-full-access` 以外的每种模式下都走 `ctx.sandbox.confine()`
  再启动 shell。也就是说，受限预设下开出来的终端，**是被 dsh 自己约束住的**，
  和它的 `bash` / `pwsh` 工具一样。

---

## ⚠️ 为什么 PTY 三件套是用 `ctx.plugin()` 挂的，不是写在 overlay 里

最自然的写法是在 `dsh-overlay.yml` 里加三行 `name: '@deepseek-ai/dsh-terminal'`。
**实测不行**：dsh 的 loader 把 overlay 里的**裸包名**解析到 **profile 目录**
（`<DSH_HOME>/profiles/<profile>/`），既不是 overlay 所在目录，也不是 dsh 的安装位置，
于是启动即 `ERR_MODULE_NOT_FOUND`。overlay 里只有 `./` 开头的相对路径才被锚定到本文件旁边
（D17），而一条指进 `node_modules` 的相对路径是对目录布局的假设，绿色包里就不成立了。

所以三个包是**本包的普通 dependencies**，由宿主半 `ctx.plugin()` 挂载，交给 Node 解析。
工作区是 `nodeLinker: hoisted`，全树只有一份 cordis，`Service` 基类同一性没有问题。

---

## ⚠️ Windows 上必须把 PSReadLine 请出去

这是本插件里唯一一段「不是产品决定、而是缺陷修复」的代码（`pwshShellArgs()`）。

`terminal-bash` 判断一个 pwsh 会话就绪的方式是：写一句安装提示符的语句，然后等着看见
自己那个私有提示符标记、且后面跟着**恰好**是提示符的可打印尾巴。dsh 的提示符函数用
`[Console]::Write` 发标记、用**函数返回值**发提示符文字 —— 两者走不同的路离开 pwsh，
而 PSReadLine 会持续重绘输入行，把它们的顺序打乱。抓到的原始字节里，标记落在了**下一条命令的回显之后**；
启动循环随后只会用**空**发送重试，于是一个开局就乱序的会话再也回不来，最后以
`PTY shell did not reach readiness before startup timeout` 结束。

PSReadLine 还会让它**越用越坏**：每条命令都被追加进用户真正的 `ConsoleHost_history.txt`
（dsh 自己那句 bootstrap 也在内），下次启动时行内预测又把它当成幽灵文字补出来 ——
这是回显对不上的第二条路。本机上的表现就是「当天第一次开成功，之后每次都失败」。

同一台机器、间隔 500ms、其余完全一致的实测：

| pwsh argv | 开终端成功 | 典型耗时 |
|---|---|---|
| dsh 默认的 `-NoLogo -NoProfile` | 7/10 | 520ms |
| 加上本插件的 `-NoExit -Command "Remove-Module PSReadLine …"` | **20/20** | 460ms |

**移除模块**而不是配置它，是因为这样才是彻底的：没有 PSReadLine 就没有重绘可打乱、
没有预测、也没有东西去写用户的 shell 历史。`-NoExit` 是让 `-Command` 不变成一次性执行的关键。
面板发的是整行文本、shell 仍然回显，所以并不会因此少掉什么。

bash 那一侧**不动** dsh 的默认 argv（本机没有 bash，不猜）。

此外还留了一道 `installStartupRetry`：给每次开终端一个**独立的**超时（`startupTimeoutMs`，
默认 20 秒）并允许重试（`startupAttempts`，默认 3 次）。它存在是因为 `terminal-bash`
用同一个 `timeoutMs` 同时兜住「一次发送」和「整个启动」，300 秒的发送预算会让一次失败的
开终端挂 5 分钟。⚠️ 它是打在**本插件自己挂载的那个 registry 实例**上的补丁 ——
`terminal_open` 直接调 `spawn`，dsh 没有留下拦截的接缝；补丁挂在本插件的 fiber 上，卸载即还原。

---

## 面板为什么是轮询的

和 `services` 插件同一个理由，但结论更硬：dsh 唯一能用的 Host→Client 推送接缝是
**session projection**，而 projection 折叠的是**会话事件** —— 三个 PTY 包一个事件都不发布
（不注册 projection、不 emit、不往日志里 append）。自己发明一个事件类型也不行：
`Session.append()` 没有 `ignorable` 参数，类型不在 `KNOWN_SESSION_EVENT_TYPES` 里的事件
会让持久化层**永久拒绝加载这个会话**。

轮询是按手机 + relay 这条链路写的：

- 会话列表 5 秒一次；**终端画面 1.5 秒一次，且只在面板展开时**。
- 画面轮询带上一次的 `revision`，没变化就只回一个短字符串，不回整屏。
- 页面不可见就全停，可见时立刻补一次。
- 刚发送完的 4 秒内加密到 400ms，让回显跟得上手指。

---

## 一次发送为什么可能被拒，以及为什么草稿不会被清掉

`ctx.terminals` **同一时刻只允许一次发送**，第二次直接抛 `SEND_ACTIVE`。模型自己那次
`terminal_send` 还在结算时，你敲的密码就会撞上它。所以宿主侧会**等**（`sendWaitMs`，默认 10 秒，
每 250ms 重试一次）——模型那次发送会在输出静默约 3 秒后结算，而「停在提示符上等输入」
恰好就是这种状态。

等不到就返回 `busy: true`，页面**保留你输入的内容**。一个刚吞掉密码的输入框自己清空，
是这个组件唯一不能有的失败方式。

---

## 文件

| 路径 | 内容 |
|---|---|
| `src/shared.ts` | 两半共享的通道契约与纯函数；**不 import `node:*` 或任何 dsh 包** |
| `src/notes.ts` | 宿主侧那几句会原样显示给用户的话 |
| `src/index.ts` | 宿主半：挂 PTY 三件套、`/terminal` 通道、发送/中断/读屏、开终端重试 |
| `src/client/` | 浏览器半：dock 条目、面板、文案 |

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `mountBackend` | `true` | 挂 dsh 的 PTY 注册表与 shell 后端 |
| `mountTools` | `true` | 挂 dsh 的六个 `terminal_*` 工具（关掉等于没人能开终端；它是固定的 token 成本） |
| `shellDialect` | `auto` | `auto` 按平台，和 dsh 自己的组合体一致 |
| `hardenPwshReadLine` | `true` | 见上面那一节；关掉请自带 `shellArgs` |
| `shellArgs` | `[]` | 非空则原样交给 `terminal-bash`，覆盖全部默认 |
| `timeoutMs` | `300000` | 一次发送的绝对上限（交给 `terminal-bash`） |
| `startupTimeoutMs` | `20000` | **每次**开终端的上限，与上面那个分开 |
| `startupAttempts` | `3` | 开终端最多试几次 |
| `sendWaitMs` | `10000` | 一次人类输入最多等多久让出忙碌的会话 |

## 验证

```powershell
pnpm --filter @dsh-remote/dsh-plugin-terminal test   # 52 项，含真 PTY 的交互闭环
node scripts/terminal-check.mjs                      # 25 项真机冒烟，升级 dsh 后跑
```

`tests/live.spec.ts` 是唯一真的起 PTY 的测试文件，它跑的是这个插件全部主张的那一条：
模型发一条 `Read-Host` / `read -p`，发送在**命令还等着输入时**就返回，
然后由本插件的 `sendToTerminal` 把 `hunter2` 送进去，最后在 scrollback 里读到 `GOT:[hunter2]`。
其余测试注入假 registry（适合分支逻辑），而「一个卡在提示符上的 shell 会不会真的收下这些字节」
是操作系统、node-pty 与 dsh 后端三者共同的性质，只能真做一遍。

`scripts/terminal-check.mjs` 比部分兄弟插件多做一步「把宿主产物 import 进来跑一遍 `apply()`」，
因为**六个工具是 dsh 的、三个包是本插件挂上去的**，而 dsh 没有把工具表暴露成任何 `/api` 方法：
「dsh 能启动」证明不了挂进去的是哪三个、模型最后看见的是哪六个。
