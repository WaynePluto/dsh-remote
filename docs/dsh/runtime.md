# 工具、权限与进程

基线见 [源码依据](../02-dsh-facts.md)。以下路径相对 dsh 仓库根，项目实现明确标注。

## 工具注册表

出处：`packages/core/tools/src/index.ts`、`packages/preset/agent-presets/src/mount.ts`。

| API | 语义 |
|---|---|
| schemas(scope) | 当前 scope 可见工具的 name、description、parameters 深拷贝 |
| get(name,scope) | 获取可见定义 |
| register | 注册定义并返回 disposer，scope 可覆盖祖先同名工具 |
| restrict | scoped allow/deny 交集，不能在全局调用 |
| guard | 单调拒绝，不改变可见性 |

preset 将工具挂在 Agent scope，查询必须传 ctx.agents.get(sessionId)，否则只得到全局层。
dsh 没有 registered/active 两级延迟加载；view(scope) 通过继承、restrict、shadow 与 PTC 呈现计算唯一可见集。
llm-pi-ai 的 deferredToolsMode:withhold 是协议兼容位，不是工具激活 API。
工具观察页只读，不能调用 register/restrict/guard 改变 Agent 行为。

## 持久历史与事件限制

出处：`packages/core/session/src/{index,types,known-event-types}.ts`、
`packages/session/session-persistence/src/coordinator.ts`、`packages/llm/llm/src/message.ts`。

tool/call 是持久事件，带 callId、name、原始 arguments JSON 字符串。
session.snapshotEvents 返回含继承前缀的不可变日志，ownEvents 只返回本会话部分。
工具调用统计回放整个日志；失败按 tool/result 的 source.callId 或 content[0].toolCallId 配对，无法配对则忽略。
tools/result 等运行时事件适合实时反应，但不是历史计数的唯一来源。

外部插件不能 append 自己定义的事件类型：持久化加载拒绝不在 KNOWN_SESSION_EVENT_TYPES 且无 ignorable 的事件，
而 Session.append 没有 ignorable 参数。写入会导致会话无法恢复。
可以读取、折叠 dsh 已有事件，不能把新事件名塞入日志。

插件可用的 Host→Client 状态推送是 session projection；浏览器 RPC 不提供 open 流。
服务和 PTY 不发布可折叠会话事件，因此面板使用有界轮询。

## 固定 YOLO

出处：`packages/interaction/user-approval/src/index.ts`、`packages/sandbox/sandbox-policy/src/{index,session-mode}.ts`、
`packages/core/agent/src/{index,runtime-types}.ts`、`packages/core/tools/src/index.ts`。

approval policy 只有 ask 和 never：never 在 waterfall 前确定性拒绝，不能实现自动允许。
项目固定 danger-full-access + ask，并以 prepend answerer 对合法 approval/request 返回 allowed-once。
ask_user_question 保持用户回答，原生工具的结果、diff、取消与超时仍沿用 dsh。

- sandbox/mode 与 approval/policy 是已知持久事件，可追加策略修正，不改写历史。
- agent/created 在首个模型请求前同步通知，Agent.ctx 可注册 scoped 同名 shadow。
- yolo-mode 覆盖 bash、pwsh、write、edit 的 schema、execute 与接收参数的展示回调，
  从克隆参数中去掉 sandbox_permissions、justification。
- 只删 schema 不够，模型的既有上下文仍可能发送字段；不能让原参数直接流入工具。
- 意外受限窗口由 wrapper 使用固定内部 widening 参数经过 dsh 原生链，再修正会话策略。
- session/event 通知内不能重入 append，修正用 queueMicrotask 并确认 Agent 仍 live。
- 禁用原生权限服务与选择器；停用插件并重启后恢复服务，已有历史策略仍需重新选择权限预设。

工具参数出处：`packages/shell/tool-bash/src/index.ts`、`packages/shell/tool-pwsh/src/index.ts`、
`packages/fs/tool-fs/src/{write,edit}.ts`、`packages/sandbox/sandbox/src/escalation.ts`。
目标工具、字段或 scope 契约变化时 yolo-mode-check 必须失败，不能降级成部分 YOLO。

## 常驻服务

出处：`packages/jobs/jobs/src/types.ts`、`docs/subsystems/jobs.md`、`docs/subsystems/shell.md`。

dsh jobs 生命周期绑定 owner；Agent 销毁会取消并等待任务，无 owner 的任务也活不过 service disposal。
项目 services 使用 detached 进程与项目 .agents/services.json 注册表，日志位于 .agents/logs/<name>.log。
以 pid 和创建时间识别，避免复用 pid 时误杀。

直接 node:child_process.spawn 不经过沙箱，所以 service_start/restart 必须读取 session 的 sandbox mode。
danger-full-access 不额外提问；受限模式需 ctx.approval 且仅 allowed-once 放行。
缺会话或批准能力时 fail closed；面板不提供创建服务入口。
权限预设只写 mode/policy，不替自行 spawn 的插件做逐工具沙箱隔离。

### PowerShell

出处：`packages/shell/pwsh-local/src/index.ts`、`packages/shell/pwsh-sandbox/src/index.ts`。
普通服务命令使用 -NoLogo -NoProfile -NonInteractive -Command，加入 UTF-8 前缀和 NO_COLOR/PAGER/GIT_PAGER。
不加载用户 profile，避免提示、启动噪音或错误匹配服务就绪日志。
受限模式的 pwsh-sandbox 在 Windows 使用 ACL restricted-token runner。

### Windows 进程树

项目 launcher 使用 taskkill /T /F；detached 只解除控制台，不清除记录的父 pid，单层 detached 会被一起枚举。
services 使用两级 Node 启动器：

```text
dsh → L1(detached，启动 L2 后退出) → L2(detached，常驻) → pwsh(普通子进程)
```

L1 退出后 L2 不再能从 dsh 的存活子树枚举；L2 为 pwsh 保持需要的控制台环境。
注册表记 L2 pid，经 sidecar 回传，停止 L2 进程树可清理 shell 及其后代。
这属于操作系统行为，必须以 services/tests/live.spec.ts 真实启动、杀父树和存活检查验证。

## 交互终端

出处：`packages/terminal/terminal`、`packages/terminal/terminal-bash`、`packages/terminal/tool-terminal`、
`packages/subprocess/subprocess-local`。

dsh 提供 PTY registry、bash/pwsh 后端、node-pty 和六个 terminal_* 实现，但标准 Web Bundle 不挂这些工具。
项目插件直接实例化 TerminalSessionService，backend 用 ctx.plugin，wrapper 捕获上游 apply 的六次注册。
缺少、重复或未知注册均整组失败；模型只看见 interactive_terminal 的 start/read/list/interrupt/close。
start 合并创建与前台发送，interrupt 固定 SIGINT，不暴露 raw send 或任意 signal。

严格用于预期必须让用户在可见终端直接输入的命令。普通命令、构建、Git、测试、长任务与持久 shell 状态
均使用 pwsh/bash；可改非交互的优先改非交互。持续服务使用 services。

### Registry 契约

- owner 按对象同一性比较且必须是 live Agent，恢复出的新 Agent 不等于原 owner。
- 同一终端同时只允许一次发送，重复发送同步抛 SEND_ACTIVE。
- startSend 的 submit 只追加回车，text 原样写入，不转义控制字节。
- 面板只有 list/read/send/interrupt，不能创建或关闭终端。
- backend 在非 danger-full-access 下调用 ctx.sandbox.confine，插件不自己 spawn 终端。
- sendWaitMs 默认 10 秒，等待后仍忙返回 busy:true，页面必须保留草稿。
- 短暂 unavailable 不等于终端已关闭，轮询失败不能立即卸载面板丢草稿。

### Windows 就绪与轮询

PSReadLine 重绘会打乱私有提示符标记与可打印尾部顺序，还会记录 bootstrap 到用户历史。
项目在 pwsh 启动参数中移除 PSReadLine，保留 NoExit，bash 使用上游默认参数。
每次启动使用独立 20 秒超时、最多 3 次尝试，不以一次发送的 300 秒预算等待启动。

终端列表每 5 秒轮询，展开画面每 1.5 秒，发送后 4 秒内加快到 400ms。
画面按 revision 返回变化，页面隐藏时停止轮询。真实交互由 terminal/tests/live.spec.ts 验证。
上游默认 rows:40、cols:160、scrollbackLines:10000、scrollbackMaxBytes:4MiB、maxReadBytes:256KiB；
read 的 offset 从最新行向前计数，count 默认 500。