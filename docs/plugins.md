# 插件索引

功能、使用入口和限制写在各插件包根的 README；本页负责导航。
实现依据见 [dsh 核实结论](02-dsh-facts.md)，装载方式见 [架构](03-architecture.md)。

## 设置与模型

| 插件 | 使用入口 | 用途 |
|---|---|---|
| [全局提示词](../packages/plugins/agents-md/README.md) | 设置 → 全局提示词 | 编辑 dsh 读取的全局 AGENTS.md |
| [出网代理](../packages/plugins/proxy/README.md) | 设置 → 代理 | 统一配置 dsh fetch 的 HTTP/HTTPS 代理出口 |
| [Copilot 登录](../packages/plugins/copilot-auth/README.md) | 设置 → 模型 → GitHub Copilot | 设备码登录与账号模型同步 |
| [模型目录更新](../packages/plugins/models-catalog/README.md) | 设置 → 模型 | 从 models.dev 补充模型目录 |
| [模型能力与协议](../packages/plugins/model-capabilities/README.md) | 设置 → 模型 → 展开模型行 | 声明图片支持、推理档位与单模型协议覆盖 |
| [常用模型](../packages/plugins/favorite-models/README.md) | 设置 → 模型；聊天模型选择器 | 收藏并筛选常用模型 |
| [子代理深度](../packages/plugins/subagent-depth/README.md) | 设置 → 插件 → 插件配置 | 设置全局子代理深度上限 |
| [任务通知](../packages/plugins/notify/README.md) | 设置 → 通知 | 在运行 dsh 的 Windows 桌面提醒任务完成或等待输入 |

## 会话与工作区

| 插件 | 使用入口 | 用途 |
|---|---|---|
| [执行过程](../packages/plugins/exec-process/README.md) | 会话消息流 | 分段折叠思考与工具调用，保留正式消息 |
| [失败重试](../packages/plugins/turn-retry/README.md) | 输入框上方 | 失败后重试、停止后继续，并保护排队消息 |
| [会话滚动导航](../packages/plugins/chat-scroll/README.md) | Agent 消息操作栏、右下角底部按钮 | 消息开头定位与返回底部滚动动效 |
| [用户消息分叉](../packages/plugins/user-message-fork/README.md) | 用户消息操作栏 | 从消息之前的历史创建子会话并回填草稿 |
| [工具状态](../packages/plugins/tools-inspector/README.md) | 会话 → 工具 | 查看可见工具及历史调用、失败次数 |
| [技能状态](../packages/plugins/skills-inspector/README.md) | 会话 → 技能 | 查看技能来源与会话加载历史 |
| [文件浏览](../packages/plugins/files/README.md) | 右侧 Sidebar → 文件 | 原生文件树增强、Git 状态与目录右键菜单 |
| [常驻服务](../packages/plugins/services/README.md) | 模型工具；输入框上方 | 管理有名字、可跨会话存活的服务 |
| [交互终端](../packages/plugins/terminal/README.md) | 模型工具；输入框上方 | 由用户直接输入密码、MFA 等交互内容 |

## 运行环境

| 插件 | 使用入口 | 用途 |
|---|---|---|
| [精简模式](../packages/plugins/concise-mode/README.md) | 新建会话时选择预设 | 提供 concise 与 concise-ptc 两个精简预设 |
| [远程设置](../packages/plugins/remote-privileged/README.md) | 自动生效 | 让已认证的远程浏览器使用完整设置页 |
| [浏览器兼容](../packages/plugins/browser-compat/README.md) | 自动生效 | 为旧 WebKit（Safari < 18.4）垫平 Iterator helpers，让 dsh 前端能启动 |
| [网页目录选择](../packages/plugins/directory-picker-browse/README.md) | 打开工作区 | 在浏览器内选择运行 dsh 的机器上的目录 |
| [固定 YOLO](../packages/plugins/yolo-mode/README.md) | 自动生效 | 固定全权限并自动允许权限请求；用户提问仍需回答 |

## 使用与维护

- 内置扩展只加载到 `dsh-remote-web` profile；官方 `web` profile 不加载它们。
- 普通插件由 launcher 传入 `--patch`；精简模式是排在 `dsh-web-app` 后的 Profile Bundle。
- 改动插件后，重新构建并重启 dsh。该 profile 没有 HMR，刷新页面不会加载新产物。
- 带浏览器半的插件依赖 `dist/client.js`；缺失时应修复构建或重新解压，不能跳过检查启动。
- 固定 YOLO 会取消模型执行前的交互式权限边界，请阅读 [安全说明](04-security.md)。
- 新增或删除插件时，同步维护本索引和包根 README；已完成实现的细节不追加到路线图。