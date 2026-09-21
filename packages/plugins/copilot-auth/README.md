# @dsh-remote/dsh-plugin-copilot-auth

在 dsh 的**设置 → 模型**页里，为 GitHub Copilot 提供方卡片加一个订阅登录区：点一下、在手机上打开 GitHub 的设备码页面输入代码，就能用 Copilot 订阅，不需要 API 密钥。登录区位于提供方卡片的**编辑**展开面板内，隐藏该卡片原生 API 密钥标签和输入框，其他提供方不受影响；收起卡片时不会占用列表空间。

## 为什么需要它

dsh 已经具备登录流程与凭据支持（核实结论见 [模型与代理](../../../docs/dsh/models.md)）：

- 它的通用适配器 `dsh-llm-pi-ai` 就是建立在 `@earendil-works/pi-ai` 之上，而 pi-ai 内置目录里**有 `github-copilot`**，设备码 OAuth、令牌刷新、模型目录一应俱全；
- 登录产物应当落在凭据记录 `llm-pi-ai/github-copilot`，那正是该适配器每次请求都会读的地方；
- 提供方路由**不需要 `apiKeyEnv`** —— 没有 key 时它就走 pi-ai 自己的凭据。

缺的只有一个界面：dsh 的 web bundle 没有挂载 `ctx.authorization`，UI 里没有任何地方去跑登录流程，模型页只提供一个 API 密钥输入框。**所以这个插件是一个界面，不是一个新的模型提供方** —— 协议、刷新、模型目录全部复用上游。

## 形态

| 半边 | 文件 | 作用 |
|---|---|---|
| 宿主 | `dist/index.js`（由 `cordis.patch.yml` 的 Bundle 层装载） | 跑 pi-ai 的登录流程，把凭据写进 `ctx.credentials`，登录成功后写 `llm-pi-ai.providers['github-copilot']` |
| 浏览器 | `dist/client.js`（由 dsh 的客户端模块系统按 `dsh.client` + `exports["./client"]` 下发） | 占用模型页官方扩展槽 `settings.models.provider-card`（key = `llm-pi-ai`），只在 `github-copilot` 那张卡上渲染登录区；同时声明 provider-card 子槽，供同一适配器的模型能力插件挂入原生展开行 |

两半通过 `ctx.connection.rpc` 上的 `/copilot-auth` 通道通信，dsh 会给它套上和 `/api` 一样的 Host/Origin 围栏与浏览器认证；在 dsh-remote 部署里，外面还叠着 relay 的登录。

## 边界

- **只支持 github.com**：pi-ai 登录一开始会问 GitHub Enterprise 域名，这里一律答空串；它若问别的（密钥、选项），插件**报错而不是猜**。
- **写进路由的模型 = 账号可用 ∩ pi-ai 目录已描述**：dsh 对目录未知模型要求可解析的协议，Copilot 跨多种协议，不能直接写入未知 ID。models-catalog 已恢复到同一运行时目录的模型也属于“已描述”；其他模型等待目录补齐。
- **登录成功但设置写失败是两件事**：凭据已经存下来时不会报「登录失败」，而是单独一条警告 + 一个「把模型加进来」按钮（`configure` 端点，不重跑设备码流程）。
- **订阅认证取代静态密钥**：登录成功或“把模型加进来”时移除 `providers['github-copilot'].apiKeyEnv`，回读确认后删除旧密钥；其他提供方仍在引用的共享密钥不删除。没有引用时清理遗留的 `GITHUB_COPILOT_API_KEY`。模型列表通过 path 写入，其余配置保留；退出登录只删 OAuth 凭据，不删路由。
- **不存任何令牌副本**：凭据只经由 pi-ai 的 store 适配器落到 dsh 的 `$DSH_HOME/.credentials.yaml`，刷新也归 pi-ai。

## 排障与升级

### Authorization 格式错误

若模型请求报 `Authorization header is badly formatted`，先检查 GitHub Copilot 提供方是否配置了
`apiKeyEnv`。dsh 将该引用解析为请求级 API key，优先于本插件保存的 OAuth grant；错误的静态值
会让订阅登录成功但模型请求失败。已登录时点击“把模型加进来”即可切换为 OAuth 并清理旧密钥，
不必反复登录。清理失败会显示警告，OAuth 凭据保留；尚未登录或登录失败时不清理密钥。

### 升级检查

这个插件依赖三条 dsh 的内部约定，升级后跑一次冒烟脚本即可全部覆盖：

```powershell
pnpm build
node scripts/copilot-auth-check.mjs
```

1. `settings.models.provider-card` 扩展槽还在（`packages/client/ui-settings-models/src/client/slot-contract.ts`）；
2. 客户端 bundle 的工件格式仍是 `window.__ModuleLoader__.load({ id, factory })`，模块表仍然共享 `react` / `react/jsx-runtime` / `react-dom`（`packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts`）；
3. 凭据记录仍是 `llm-pi-ai/github-copilot` + `{kind:'grant', payload:<pi-ai 凭据>}`，且 pi-ai 的 copilot 提供方仍在内置目录里（`packages/llm/llm-pi-ai/src/auth.ts`）。

另外：`@earendil-works/pi-ai` 的版本要跟 dsh 依赖的那个保持一致，否则凭据格式可能对不上。

## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：设置里的 Copilot 登录页消失；已保存的凭据与账号模型条目保留，但无法重新登录或同步。launcher 不再自动补回；右键托盘图标选「补回Copilot 登录」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-copilot-auth` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
