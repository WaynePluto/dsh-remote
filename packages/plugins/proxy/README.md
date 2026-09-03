# @dsh-remote/dsh-plugin-proxy

给 dsh 加一个**出网代理**开关：设置页多一个「代理」页面，配好之后**整个 dsh 进程**的出网都走它——
模型请求、OAuth 登录、网页抓取与搜索、其他插件自己的抓取，一个不落。

## 为什么需要它

事实很窄，但后果很大（核实过，见 [docs/02-dsh-facts.md](../../../docs/02-dsh-facts.md) §8.4a）：

- **Node 的全局 `fetch` 从不读 `HTTP(S)_PROXY`**；
- dsh 和 pi-ai 全程用全局 `fetch`，从不传 `dispatcher`（全仓库搜不到 `setGlobalDispatcher`）。

于是在「只有代理能出网」的机器上，机器上别的工具都认的那个代理，**偏偏 dsh 用不了**，
而且报错既不提主机也不提代理（`UND_ERR_CONNECT_TIMEOUT` 而已）。

这个插件换掉 undici 的**全局 dispatcher**——那是所有出网请求共同的出口，改这一个对象就全覆盖了。

## 刻意不读环境变量

`EnvHttpProxyAgent` 对任何**没显式传**的字段会回落到 `process.env`
（`opts.httpProxy ?? process.env.http_proxy ?? …`）。本插件把每个字段都显式传进去（**包括空串**），
所以**页面上显示什么，进程就做什么**。一个来自 `HTTPS_PROXY`、界面上却看不见的代理，
正是这个插件要消灭的困惑。

## 配置

设置 → **代理**：

| 字段 | 说明 |
|---|---|
| 出网请求走代理 | 总开关。地址会被保留，关掉不会丢。 |
| 代理地址 | `http://proxy.example.com:8080`，http / https 共用。 |
| 不走代理的地址 | 逗号或换行分隔。**默认带上回环地址**——dsh、relay、connector、本地模型服务都走 loopback，被代理劫持就全断了。 |
| 测试 | 用**全局 `fetch`** 打一次给定地址，报状态码、耗时、以及是不是经代理走的。用全局 fetch 是刻意的：这个按钮回答的问题是「dsh 现在能不能出网」。 |

存在设置命名空间 `dsh-plugin-proxy` 里（`settings.yaml`），因此可以跨重启、也能手改。
**默认没有任何代理地址**：全新安装是「不填地址、开关关闭、直连」，需要代理的机器自己填。
校验挂在命名空间上：地址写错、或者「开着但没地址」，**写入时就被拒绝并指名字段**，
而不是存下来之后让每个请求默默失败。

## 生命周期

插件加载时记住**当时**的全局 dispatcher，卸载（或关掉开关）时原样还回去——
停用插件后进程行为和装它之前完全一致。切换地址时先换新 agent 再关旧的，
在途请求不会被掐断。

## 与其他插件的关系

`models-catalog` **不再自带代理配置**（原来的 `proxyUrl` 和 undici 依赖已删除）：
它用普通的全局 `fetch`，因此这里配好代理，它就自动走代理；这里不配，它就直连。
一个进程级出口，比每个插件各配一份干净。

## 开发

```powershell
pnpm --filter @dsh-remote/dsh-plugin-proxy build
# 沙箱/受限环境里 vitest 的 forks 池会 spawn EPERM，用 threads 池：
pnpm --filter @dsh-remote/dsh-plugin-proxy exec vitest run --pool=threads
```
