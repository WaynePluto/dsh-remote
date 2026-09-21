# 出网代理

`@dsh-remote/dsh-plugin-proxy` 在 **设置 → 代理** 配置 dsh 的全局 fetch/Undici 出口，
覆盖使用该出口的模型请求、OAuth 登录、网页抓取和其他插件请求。

## 使用

| 字段 | 用途 |
|---|---|
| 出网请求走代理 | 启用或关闭；关闭保留已填地址 |
| 代理地址 | HTTP/HTTPS 代理，可填 http://proxy.example.com:8080 或 host:port |
| 不走代理的地址 | 逗号或换行分隔，默认包含 localhost、127.0.0.1、::1 |
| 测试 | 使用全局 fetch 请求指定 URL，报告状态、耗时和实际代理 |

默认关闭、地址为空，不预置代理。设置保存到 dsh-plugin-proxy，保存后对后续请求生效，无需重启。
地址不合法或启用时为空会被拒绝，页面保留草稿并就地报错。

## 范围与边界

- 只支持 HTTP/HTTPS 代理，不支持 SOCKS/PAC；禁止 URL 中携带用户名和密码。
- 设置页是唯一配置源，不读取 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY、NO_PROXY。
- 不保证覆盖子进程、独立 WebSocket、自建 Node Agent 或独立网络库。
- loopback 默认直连，避免目标机器上的服务请求被代理转走。
- 不提供忽略 TLS 错误开关。
- models-catalog 与 copilot-auth 使用同一出口，不另配代理。

## 生命周期与维护

插件安装新的全局 dispatcher；关闭时切为新的直连 Agent。
切换先安装新对象，再等待旧代理请求结束；卸载恢复保存的 ambient dispatcher。
代理地址、不走代理地址和测试地址使用 dsh 主题字段：border-l4、bg-layer-1、brand focus，
禁用态使用 tertiary 文字且不显示浏览器默认黑色 focus 轮廓；多行绕过地址仍保留 textarea 语义。

代码改动仍需构建并重启 dsh，与设置热更新不同。

实现契约见 [模型与代理](../../../docs/dsh/models.md)。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-proxy build
pnpm --filter @dsh-remote/dsh-plugin-proxy exec vitest run --pool=threads
node scripts/proxy-check.mjs
```
## 停用与补回

本插件是受管 Profile Bundle（默认全开）。在 dsh 插件页停用后：「设置 → 代理」页消失，dsh 回退到环境变量代理（HTTPS_PROXY / HTTP_PROXY）；已保存的代理地址保留在设置里但不再生效。launcher 不再自动补回；右键托盘图标选「补回出网代理」，或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-proxy` 补回。想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。
