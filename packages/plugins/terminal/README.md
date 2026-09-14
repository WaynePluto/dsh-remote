# 交互终端

`@dsh-remote/dsh-plugin-terminal` 在输入框上方提供能由用户直接输入的 PTY 终端。
Windows 使用 PowerShell 7，POSIX 使用 bash，底层复用 dsh 的终端运行时与 node-pty。

## 使用

1. 需要密码、MFA、确认或交互向导时，模型通过 interactive_terminal 的 start 启动命令。
2. 展开“交互终端”面板，在提示出现后自己输入并回车；输入框默认密码遮罩，输入不作为模型工具参数发送。
3. Linux 管理任务的每条 sudo 命令都通过交互终端执行，即使缓存可能跳过密码提示；先说明明确的命令和影响，同一终端可以按系统策略复用 sudo 凭据缓存，但不启动 `sudo -i`、`sudo su`、`su root` 或等价的 root shell。
4. 需要停止前台命令时使用中断，发送固定 SIGINT。

模型工具只有 start/read/list/interrupt/close；页面只能查看、发送输入和中断，不能创建或关闭终端。
未创建终端时不显示面板。

## 使用边界

只用于预期必须让用户在可见终端直接输入的命令。普通 Git、构建、测试、脚本、长时间运行、持续输出、
仅需要持久 shell 状态均使用 pwsh/bash；可以改成非交互的优先改非交互。已因 sudo 人工认证打开的终端，
可以在同一管理员任务内复用缓存执行后续明确命令，但不因此把普通持久 shell 工作搬进交互终端。常驻服务用 services。

同一终端只允许一次发送，用户输入最多等待 10 秒；仍忙时保留遮罩草稿。收起 panel、切换 conversation 或 terminal 时清除草稿，
过时请求不能清空新 terminal 的输入。输入内容可能被目标程序回显或写入输出，输入不经模型参数并不等于输出中绝不会出现敏感信息。
终端沿用 dsh 的沙箱约束；默认固定 YOLO 下是全权限 shell。

## 配置

以下为 Cordis 插件配置，不是独立设置页：

| 字段 | 默认 | 用途 |
|---|---|---|
| mountBackend | true | 挂载 registry 与 shell 后端 |
| mountTools | true | 注册一个 interactive_terminal 组合工具 |
| shellDialect | auto | 按平台选择 pwsh/bash |
| hardenPwshReadLine | true | 移除 PSReadLine，稳定提示符与就绪检测 |
| shellArgs | [] | 非空时覆盖默认参数 |
| timeoutMs | 300000 | 一次发送上限 |
| startupTimeoutMs | 20000 | 每次启动上限 |
| startupAttempts | 3 | 启动尝试次数 |
| sendWaitMs | 10000 | 用户输入等待终端空闲的上限 |

## 维护与验证

上游六个 terminal_* 实现只供 wrapper 组合，注册缺失、重复或未知时整组失败，不能向模型泄漏裸工具。
registry 直接实例化 Service，backend 用 ctx.plugin，wrapper 捕获上游 apply。
列表每 5 秒、展开画面每 1.5 秒轮询；发送后短时加快，隐藏页面停止，按 revision 避免重复整屏传输。
短暂 unavailable 不立即卸载面板，以免丢失用户草稿。

终端输入框始终使用密码遮罩，并关闭拼写检查、自动纠正、自动大写和自动填充提示；同时沿用 dsh 主题字段
（border-l4、bg-layer-1、brand focus、tertiary disabled）。终端输出区仍是独立的等宽 code surface，不与输入框共用高度或边框。
遮罩只保护网页输入框；如果目标程序回显，内容仍可能出现在终端输出和模型读取结果中。

详细契约见 [工具与进程](../../../docs/dsh/runtime.md)，界面规则见 [插件机制](../../../docs/dsh/plugins.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-terminal test
node scripts/terminal-check.mjs
```

live 测试需真实 PTY，验证等待用户输入、发送与回显。修改插件后必须构建并重启 dsh。