# 出网代理

`@dsh-remote/dsh-plugin-proxy` 在 **设置 → 代理** 中配置本进程的原生 fetch 与官方网页抓取出口。

| 出网方式 | 效果 |
|---|---|
| 跟随环境（默认） | 沿用 dsh 启动时从环境变量安装的官方代理策略；未配置环境代理则直连。 |
| 使用插件代理 | 对 HTTP/HTTPS 使用这里填写的同一代理地址，优先于启动环境；绕过地址仍直连。 |
| 强制直连 | 本进程上述两条请求路径直连；保留已填写的代理地址与绕过列表。 |

支持 `http://proxy.example.com:8080`、`https://proxy.example.com:8080` 或 `host:port`（补 `http://`）。
不支持 SOCKS/PAC 或地址中的用户名密码，不提供跳过 TLS 验证开关。
绕过列表用逗号或换行分隔，官方策略始终绕过 loopback。测试按钮报告**测试 URL** 的实际路由，而非所有请求的统一出口。
保存到插件行 `proxy` 的 volatile Config，修改后无需重启；非法地址、插件模式下空地址或无效模式会被拒绝，页面保留草稿。

旧配置未写入 `mode` 时：`enabled=true` 对应「使用插件代理」；`enabled=false` 且地址非空对应「强制直连」；关闭且地址为空对应「跟随环境」。显式 `mode` 优先，不自动改写旧设置或用户 DSH_HOME。
插件卸载时逆序释放官方策略层并恢复 dsh 启动环境。模型、OAuth 等使用原生 fetch 的请求与官方 web-fetch 共用策略；不承诺控制子进程、独立 WebSocket、自建 Agent 或独立网络库。`models-catalog` 与 `copilot-auth` 不另配代理。

插件作为独立 Bundle 分发，停用后页面消失、dsh 恢复环境策略，保存的字段仍在。重装可通过 dsh「添加插件」选择发行 `plugins/proxy` 或开发 `.dev/plugins/proxy` 的绝对目录。代码修改后需构建并重启 dsh（配置热更新不需要重启）。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-proxy typecheck
pnpm --filter @dsh-remote/dsh-plugin-proxy test
pnpm --filter @dsh-remote/dsh-plugin-proxy build
node scripts/proxy-check.mjs
```
