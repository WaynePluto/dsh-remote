# 模型与代理

基线见 [源码依据](../02-dsh-facts.md)。使用入口见 [插件索引](../plugins.md)。
以下路径相对 dsh 仓库根，项目实现明确标注。

## Copilot 登录

出处：`packages/llm/llm-pi-ai/src/{adapter,catalog,auth,login}.ts`、
`packages/credentials/authorization/src/index.ts`。

dsh-llm-pi-ai 基于 @earendil-works/pi-ai，内置 github-copilot 的设备码 OAuth、刷新和目录。
项目插件提供登录界面，通过 pi-ai CredentialStore 适配器写 ctx.credentials。

- 凭据键 llm-pi-ai/github-copilot，值为 kind:grant 与 pi-ai 原始 payload，持久化到 DSH_HOME/.credentials.yaml。
- payload 不能带显式 undefined，保存前需 JSON 化去掉此类字段。
- 路由不需要 apiKeyEnv；未配置该引用时由 pi-ai 使用 grant，刷新通过 store.modify 写回。
- 若配置 apiKeyEnv，adapter.ts 的请求级 apiKey 会优先于 OAuth grant。
	copilot-auth 在登录成功或 configure 时移除该引用，回读确认后删除不再被其他路由引用的旧密钥；
	没有引用时清理遗留 GITHUB_COPILOT_API_KEY。未登录不清理，失败显示警告并保留 OAuth grant。
- dsh 有 authorization 服务，但其标准 Bundle 未挂载且没有现成的登录 UI 调用链。
- copilot-auth 只写“账号可用模型 ∩ 已描述目录”；models-catalog 恢复的运行时目录条目也参与交集。

settings.models.provider-card 按 ProviderDirectoryEntry.settingsNs 分派，包含草稿卡。
它是卡片内附加区域，没有原生密钥替换接口。项目通过限定在 Copilot OAuth 面板所在编辑器的 CSS
隐藏原生密码字段块，不移动或删除 React 节点，其他提供方不受影响。项目自己的子槽可供其他插件组合内容。

## 模型目录配置

出处：`packages/llm/llm-pi-ai/src/config.ts`、`src/catalog.ts`、`src/discovery.ts`、
`tests/dynamic-config.spec.ts`、`packages/client/ui-settings-models/src/client/ModelListEditor.tsx`。

- providers.<route>.models 是整份目录替换，每项再按 id 合并内置模型字段。
- modelOverrides 只能覆盖内置已有模型，不能新增未知 id。
- settings 写入会热更新路由，无需重启 dsh；插件代码变化仍需重启。
- 内置供应商的模型发现从目录回答；自定义端点可请求 GET /models。
- schemastery 会物化空 models:[]，是否显式配置要判断数组且长度大于 0。
- listConfigurableProviders 包含未配置供应商，已配置路由应从 settings.providers 取。
- listModels/resolveModelInfo 返回生效后的目录，不能当纯净内置快照。

pi-ai 的 providers/data/<provider>.json 按 api → modelId 分组，含 input、reasoning、cost、
contextWindow、maxTokens、thinkingLevelMap 等；.manifest.json 记录生成时间。

## Models.dev 与协议

PiAiModelProfile 没有 api 字段，解析顺序是路由 api → 同 id 内置模型 → 路由唯一 sharedCatalogApi。
混合协议路由直接添加目录未知模型会导致 settings 校验拒绝。

项目 models-catalog 的兼容流程：

1. 按模型 id 查同一份外部 pi-ai 目录，目标路由优先。
2. 无匹配则按 gpt-* → openai-responses、claude-* → anthropic-messages、其他 → openai-completions。
3. 先扩展同一份 pi-ai 运行时 map，再写 dsh models；不是给单个模型增加 api 字段。
4. 将推断与新增条目归属存入 dsh-plugin-models-catalog，启动时在 llm-pi-ai 校验前恢复。
5. dsh 自带该模型后只清理本插件拥有的条目，用户及其他插件配置原样保留。

models.dev 提供 reasoning_options，但 effort/toggle/budget_tokens 形态不同，且档位名单不等于 wire 拼写。
不能直接把其 values 写成 reasoningEfforts；新增模型可能没有推理档位，界面必须如实提示。
协议回退属于项目约定，供应商例外命名仍需人工判断。

models 是持久的整份替换，卸载插件不会自动撤销配置。切回未加载该插件的官方 profile 前，
应使用“删除本插件添加的模型”，避免未知混合协议模型无法恢复。

在 dsh `0.1.5-rc.2` 中，`llm-pi-ai` 读取已存但因目录漂移而不可服务的模型配置时，会保留该路由和编辑入口，
并在提供方目录显示诊断；只有新建或实际变更的路由仍按完整目录严格校验。项目 models-catalog 的恢复流程仍须先于
写入校验运行，copilot-auth 使用的 `llm-pi-ai/github-copilot` 凭据格式不变。升级后的项目构建与冒烟验证见
[源码依据](../02-dsh-facts.md)。

## 自定义模型能力

出处：`PiAiModelProfile`、`modelFields`、`resolveModelReasoning`、`declaredInput`。

| 字段 | 语义 |
|---|---|
| input 省略或空数组 | 继承同名内置模型，再回退到路由 defaultInput |
| input:['text'] | 明确只接收文本 |
| input:['text','image'] | 用户声明支持图片，不自动探测 |
| reasoningEfforts 省略 | 继承目录；纯自定义模型没有默认推理档位 |
| reasoningEfforts:false | 明确关闭推理 |
| reasoningEfforts 字典 | dsh 档位映射实际 wire 值，仅 off 可为 null，至少一个非 off 档位 |

model-capabilities 编辑已有非空 models 列表的图片/推理字段；自带模型没有显式列表时不创建整份替换，
只开放单模型协议覆盖。协议覆盖保存在 dsh-plugin-model-capabilities，Host 先修改同一份外部
pi-ai 运行时 map，再将 api 镜像到 dsh 保留的 models/modelOverrides 字段，优先级为用户覆盖 >
pi-ai 默认 > models-catalog 推断。使用项目 provider-card 子槽与 React portal 挂到原生模型展开行，
保存后回读；原生 DOM 不匹配时不显示附加控件，不能把字段写到错误模型。

## 常用模型

favorite-models 在 settings.models.footer 保存 provider+model 收藏，只影子覆盖 conversation.input.model。
目录与选择动作复用 dsh modelDirectories；/model 保持完整目录。
当前模型不因不在收藏中而自动切换，收藏全部失效时需回退到可用目录。
具体契约由项目 favorite-models 测试与 scripts/favorite-models-check.mjs 维护。

## 出网代理

dsh 与 pi-ai 使用全局 fetch，默认没有为它传 dispatcher。
项目不读取 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY 或 NO_PROXY 作为代理配置来源。
设置 → 代理是唯一配置入口，持久化命名空间 dsh-plugin-proxy。

proxy 插件替换 undici 全局 dispatcher，覆盖使用该出口的模型、OAuth、网页请求和插件 fetch。
不保证覆盖子进程、独立 WebSocket、自建 Node Agent 或自带网络实现。
EnvHttpProxyAgent 的所有字段显式传值，包括空串，避免回退读取环境变量。

- 默认关闭且无预置地址；支持范围以 proxy 的共享校验器与 README 为准。
- 关闭使用新的直连 Agent；切换先安装新 dispatcher，再等待旧请求排空。
- 卸载恢复保存的 ambient dispatcher，并关闭本实例创建的代理 Agent。
- loopback 默认绕过代理；地址禁止 userinfo，不提供忽略 TLS 错误开关。
- models-catalog 与 copilot-auth 共用该出口，不设置独立代理。
- 保存使用 [设置写入契约](plugins.md)，先校验、后回读，失败保留草稿。

代理实现依据位于项目 packages/plugins/proxy/src；配置或测试不要通过关闭 TLS 校验来绕过证书问题。