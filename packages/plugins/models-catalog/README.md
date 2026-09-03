# @dsh-remote/dsh-plugin-models-catalog

在 dsh 的**设置 → 模型**页底部加一块面板：读 [models.dev](https://models.dev/api.json)，
把 dsh 内置目录里还没有的模型列出来，用户确认后写进 dsh 自己的设置；等 dsh 升级带上了
这些模型，插件自动把写入的那份删掉，交还给 dsh。

## 为什么需要它

dsh **本来就能**服务内置目录里没有的模型：`llm-pi-ai` 会把每条路由配置里的 `models`
列表盖在 pi-ai 内置目录之上，模型页也有手工编辑器
（dsh 源码 `packages/llm/llm-pi-ai/src/catalog.ts`、
`packages/client/ui-settings-models/src/client/ModelListEditor.tsx`）。

缺的是**发现**：pi-ai 的内置目录是构建期从 models.dev 生成的快照，供应商发了新模型也要等
dsh 发版才会出现。这个插件在运行时读同一份上游文档，把差集摆出来。

## 三条硬规则

1. **不问不写。** `preview` 只读；`apply` 只写用户勾选的供应商。唯一的例外是「dsh 追上来了」
   的清理，它**只会删除本插件写入的条目**，并在面板上报告自己做了什么。
2. **绝不编造协议。** models.dev 不带 wire protocol，而 dsh 的模型条目也不能自带 `api`
   （`PiAiModelProfile` 没有这个字段），协议只能来自路由级 `api` 或「该路由内置模型协议唯一」
   的推断。所以 **openai / github-copilot 这类跨协议路由会显示为「不能添加」**，而不是写进去
   让整条路由不可服务（dsh 会整体拒绝这次设置写入）。
3. **只碰自己写的。** 本插件在自己的设置命名空间 `dsh-plugin-models-catalog` 里记溯源；没有溯源的
   `models` 列表（用户手写的，或 `copilot-auth` 为 Copilot 裁剪的那份）一律不改写。

## 已知的降级

models.dev 带 `reasoning_options`，但那是**档位名单**不是 wire 拼写，而且形态不统一
（`effort` / `toggle` / `budget_tokens`，groq 甚至用 `none` / `default` 这种不在 dsh 档位表里的名字）。
dsh 要的是 `{档位: wire 拼写}`，缺省即「不会思考」，所以**这样添加进来的推理模型不会带思考档位**。
面板会就地提示这一点。安全的改进路线见 docs/02 §8.3。

## 配置

`sourceUrl` 是 **cordis 插件的 config**（`export const Config` + `apply(ctx, config)`），
**不是设置页里的东西** —— dsh 的「插件配置」页编辑的是*设置命名空间*（bash、web-search 那些卡片），
够不到 cordis 的 plugin config。

| 键 | 默认 | 说明 |
|---|---|---|
| `sourceUrl` | `https://models.dev/api.json` | 数据源。指向内网镜像是绕开出网限制的一种办法。 |

**代理不在这里配。** 本插件用普通的全局 `fetch`，出网代理由
[`@dsh-remote/dsh-plugin-proxy`](../proxy/README.md)（设置 → 代理）统一提供：那里配了就自动走，
没配就直连。一个进程级出口比每个插件各配一份干净，也保证本插件不会出现「dsh 连不上网但它能连上」这种怪事。

配置 `sourceUrl` 的三种途径，按推荐顺序：

1. 保持默认，代理在「设置 → 代理」里配；
2. 本包 `dsh-overlay.yml` 的 `config:`（产品默认值）；
3. 再挂一个更靠后的 `--patch`，按 id 覆盖：
   ```yaml
   - id: models-catalog
     config:
       sourceUrl: https://mirror.example/models-dev.json
   ```
   ⚠️ 顺序是 `bundle 层 → profile 的 cordis.patch.yml → DSH_HOME 级 patch → --patch 叠加层`
   （dsh 源码 `apps/cli/src/profile-boot.ts`）。`--patch` 排在最后，**所以 profile 的 `cordis.patch.yml`
   改不了本插件的 config** —— 那时这一行还不存在。

> 实测（本机）：直连 models.dev 是 `UND_ERR_CONNECT_TIMEOUT`，经 `http://proxy.example.com:8080` 是 200 / 4.44 MB / 2.7 秒。
> `curl` 报的 `schannel SEC_E_NO_CREDENTIALS` 是 Windows 凭据存储的问题，不代表网络不通。

## 「删除本插件添加的模型」这个按钮为什么必须有

插件写的是**用户真实的、持久的 `settings.yaml`**，而且 `models` 是**整份替换**语义。由此推出三件事：

1. **卸载插件不会带走这些写入。** 设置文件独立于插件存在；插件没了，它写下的模型列表还在生效。
2. **自动清理只管「dsh 已经自带了」那一种情况**，不管「我不想要了」——比如从 models.dev 抄来的
   `contextWindow` 和你的网关实际不符，或者你只是后悔了。
3. **最要紧的**：只要写过一次，这条路由的模型集合就被钉住，将来 dsh 升级带来的新模型不会再自己出现。
   如果你哪天直接跑官方 `dsh web`（那里没有这个插件），**没有任何人会来解除这个钉住状态**。

所以这个按钮是那份写入的唯一撤销入口。它**只在插件确实写过东西时才出现**（`owned.length > 0`）。



## 两半与装载

和 `copilot-auth` 同形：宿主半 `dist/index.js` 由包根的 `dsh-overlay.yml` 经 `--patch` 插入，
浏览器半 `dist/client.js` 由 dsh 的客户端模块系统按 `dsh.client` + `exports["./client"]` 下发。
**缺 `dist/client.js` 会让 dsh 的 web UI 整个起不来**，不是少一块面板。

## 开发

```powershell
pnpm --filter @dsh-remote/dsh-plugin-models-catalog build
# 沙箱/受限环境里 vitest 的 forks 池会 spawn EPERM，用 threads 池：
pnpm --filter @dsh-remote/dsh-plugin-models-catalog exec vitest run --pool=threads
```
