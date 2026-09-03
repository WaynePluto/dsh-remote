# @dsh-remote/dsh-plugin-copilot-auth

在 dsh 的**设置 → 模型**页里，为 GitHub Copilot 提供方卡片加一个订阅登录区：点一下、在手机上打开 GitHub 的设备码页面输入代码，就能用 Copilot 订阅，不需要 API 密钥。

## 为什么需要它

dsh 0.1.2 已经具备除「入口」以外的所有零件（核实结论见 [docs/02-dsh-facts.md](../../../docs/02-dsh-facts.md) §8）：

- 它的通用适配器 `dsh-llm-pi-ai` 就是建立在 `@earendil-works/pi-ai` 之上，而 pi-ai 内置目录里**有 `github-copilot`**，设备码 OAuth、令牌刷新、模型目录一应俱全；
- 登录产物应当落在凭据记录 `llm-pi-ai/github-copilot`，那正是该适配器每次请求都会读的地方；
- 提供方路由**不需要 `apiKeyEnv`** —— 没有 key 时它就走 pi-ai 自己的凭据。

缺的只有一个界面：dsh 的 web bundle 没有挂载 `ctx.authorization`，UI 里没有任何地方去跑登录流程，模型页只提供一个 API 密钥输入框。**所以这个插件是一个界面，不是一个新的模型提供方** —— 协议、刷新、模型目录全部复用上游。

## 形态

| 半边 | 文件 | 作用 |
|---|---|---|
| 宿主 | `dist/index.js`（由 `dsh-overlay.yml` 的 `--patch` 加载） | 跑 pi-ai 的登录流程，把凭据写进 `ctx.credentials`，登录成功后写 `llm-pi-ai.providers['github-copilot']` |
| 浏览器 | `dist/client.js`（由 dsh 的客户端模块系统按 `dsh.client` + `exports["./client"]` 下发） | 占用模型页官方扩展槽 `settings.models.provider-card`（key = `llm-pi-ai`），只在 `github-copilot` 那张卡上渲染登录区 |

两半通过 `ctx.connection.rpc` 上的 `/copilot-auth` 通道通信，dsh 会给它套上和 `/api` 一样的 Host/Origin 围栏与浏览器认证；在 dsh-remote 部署里，外面还叠着 relay 的登录。

## 边界

- **只支持 github.com**：pi-ai 登录一开始会问 GitHub Enterprise 域名，这里一律答空串；它若问别的（密钥、选项），插件**报错而不是猜**。
- **写进路由的模型 = 账号可用 ∩ pi-ai 目录已描述**：dsh 对目录未描述的模型要求显式 `api`，而 Copilot 的目录横跨三种协议、推断不出来；只要混进一个目录里没有的 id，**整个设置写入会被 dsh 拒掉**。所以比 pi-ai 发包更新的模型（如 `claude-opus-4.8-fast`）会被留在外面，等 pi-ai 升级后自然就有了。
- **登录成功但设置写失败是两件事**：凭据已经存下来时不会报「登录失败」，而是单独一条警告 + 一个「把模型加进来」按钮（`configure` 端点，不重跑设备码流程）。
- **不碰用户已有配置**：登录成功后只用 path 写入 `providers['github-copilot'].models`，其余字段原样保留；退出登录只删凭据，不删路由（提供方的删除按钮在卡片上，属于用户）。
- **不存任何令牌副本**：凭据只经由 pi-ai 的 store 适配器落到 dsh 的 `$DSH_HOME/.credentials.yaml`，刷新也归 pi-ai。

## 升级 dsh 后必须复核

这个插件依赖三条 dsh 的内部约定，升级后跑一次冒烟脚本即可全部覆盖：

```powershell
pnpm build
node scripts/copilot-auth-check.mjs
```

1. `settings.models.provider-card` 扩展槽还在（`packages/client/ui-settings-models/src/client/slot-contract.ts`）；
2. 客户端 bundle 的工件格式仍是 `window.__ModuleLoader__.load({ id, factory })`，模块表仍然共享 `react` / `react/jsx-runtime`（`packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts`）；
3. 凭据记录仍是 `llm-pi-ai/github-copilot` + `{kind:'grant', payload:<pi-ai 凭据>}`，且 pi-ai 的 copilot 提供方仍在内置目录里（`packages/llm/llm-pi-ai/src/auth.ts`）。

另外：`@earendil-works/pi-ai` 的版本要跟 dsh 依赖的那个保持一致，否则凭据格式可能对不上。
