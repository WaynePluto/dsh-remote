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
| [子代理深度](../packages/plugins/subagent-depth/README.md) | 插件 → 子代理深度 Bundle 详情 | 设置全局子代理深度上限；配置直接位于 Bundle 页面，无嵌套卡片 |
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
| [简洁模式](../packages/plugins/concise-mode/README.md) | 新建会话时选择预设 | 提供 concise 与 concise-ptc 两个简洁预设 |
| [远程设置](../packages/plugins/remote-settings/README.md) | 自动生效 | 让已认证的远程浏览器使用完整设置页（自 remote-privileged 拆出；connection 注入留在壳级 overlay 不可停） |
| [浏览器兼容](../packages/plugins/browser-compat/README.md) | 自动生效；设置 → 浏览器日志 | 为旧 WebKit 垫平 Iterator/AbortSignal/Promise 缺口，并提供当前页面临时错误日志与能力清单 |
| [网页目录选择](../packages/plugins/directory-picker-browse/README.md) | 打开工作区 | 在浏览器内选择运行 dsh 的机器上的目录 |
| [固定 YOLO](../packages/plugins/yolo-mode/README.md) | 自动生效 | 固定全权限并自动允许权限请求；用户提问仍需回答 |

## 分发组合

22 个功能组件以 11 个第三方 Bundle 随 dsh-remote 提供。组合包是安装、卸载和升级单位；
除表中注明外，其组件行仍可在插件详情中单独停用。

| 分发包 | 类型 | 包含组件或功能 |
|---|---|---|
| remote-experience | 组合包 | 远程设置、浏览器兼容 |
| model-enhancements | 组合包 | Copilot 登录、模型目录更新、模型能力与协议、常用模型；模型目录和模型能力共同参与启动屏障，不可单独停用 |
| conversation-enhancements | 组合包 | 失败重试、执行过程、会话滚动、用户消息分叉、任务通知 |
| development-tools | 组合包 | 常驻服务、交互终端、工具状态、技能状态 |
| directory-picker-browse | 独立包 | 网页目录选择；需在 Bundle 层静态覆盖原生目录选择器，不能并入组合包 |
| proxy | 独立包 | 出网代理 |
| concise-mode | 独立包 | 简洁模式 |
| agents-md | 独立包 | 全局提示词 |
| files | 独立包 | 文件浏览 |
| subagent-depth | 独立包 | 子代理深度 |
| yolo-mode | 独立包 | 固定 YOLO |

完整包名均为 `@dsh-remote/dsh-plugin-<上表名称>`。唯一不在该表中的项目扩展是壳级
[remote-privileged](../packages/plugins/remote-privileged/README.md)：它提供 connection 的
webServer 注入和模型 Bundle 在线启停所需的稳定启动屏障，随 launcher 以 `--patch` 常驻加载，
不可停用或卸载。

## 安装、升级与停用

- 新建 `dsh-remote-web` profile 时，11 个分发包通过 dsh 官方插件管理器默认安装并启用；
  官方 `web` profile 不加载它们。
- dsh-remote 升级时会升级所有**仍安装**的随附包，包括当前停用的 Bundle；不会改变 Bundle
  是否启用，也不会改回组件行的停用状态。
- 从 dsh 插件页卸载包后，launcher 不自动补回。需要恢复时，在「添加插件」中输入随附包目录的
  绝对路径：绿色发行版使用 `<解压目录>/plugins/<包目录>`，源码开发使用
  `<仓库>/.dev/plugins/<包目录>`；安装完成后按官方流程启用。
- 组合包卸载会一起移除其中全部组件；组件级停用只关闭对应功能。不要同时安装组合包及其内部
  组件的旧独立 Bundle，否则稳定行 ID 会冲突。
- 改动插件后重新构建并重启 dsh。该 profile 没有 HMR，刷新页面不会加载新产物。
- 带浏览器半的插件依赖 `dist/client.js`；缺失时应修复构建或重新解压，不能跳过检查启动。
- 固定 YOLO 会取消模型执行前的交互式权限边界，请阅读 [安全说明](04-security.md)。
- 新增、删除或重新分组插件时，以根目录 `plugin-catalog.json` 为唯一清单，并同步维护本索引、
  组合包 README 与组件 README；已完成实现的细节不追加到路线图。
