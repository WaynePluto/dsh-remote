# 远程设置

`@dsh-remote/dsh-plugin-remote-settings` 让已通过 relay 认证的远程浏览器使用完整的 dsh 设置页，
包括模型、凭据和插件配置。插件自动生效，没有单独的页面或开关。

它是受管 Profile Bundle（自 `remote-privileged` 拆出的 ownsHost 部分；connection 的
webServer 注入已留在壳级常驻 overlay，与本包无关）。

## 工作方式

dsh 浏览器端通过 `ownsHost` 判断是否可以持久化设置。本插件使用官方的首页注入接口声明
`globalThis.__DSH_TRANSPORT__.ownsHost = true`。

## 停用与补回

在 dsh 插件页停用本 Bundle 后，经 relay 地址访问时设置页回到 dsh 受限形态——
**包括本机** `127.0.0.1:30809`（relay 转发的 Host 不是 dsh 自己的 authority）；
直连 dsh 端口的原生访问不受影响。launcher 不再自动补回；右键托盘图标选「补回远程设置」，
或运行 `node dist/index.js --restore-bundle @dsh-remote/dsh-plugin-remote-settings` 补回。
想让停用被托盘感知，请用 dsh 插件页的开关（直接改 profile patch 层的停用托盘看不见）。

## 安全边界

- 不修改 dsh 源码、不改写 Host/Origin，也不绕过 `/api` 的信任校验和浏览器认证。
- 非 loopback 访问必须先通过 relay 登录；本插件不是认证方案。
- `ownsHost` 也会开放调用系统程序打开文件的能力，动作发生在运行 dsh 的机器桌面上，手机看不到该窗口。
- 仅加载到 `dsh-remote-web`，不修改官方 `web` profile。

## 维护

升级 dsh 时复核 `ClientTransportHooks.ownsHost` 与 `webserver/index-inject` 契约。
构建产物为 `dist/index.js`，无需浏览器 bundle。修改后必须重启 dsh。

```powershell
pnpm --filter @dsh-remote/dsh-plugin-remote-settings test
pnpm --filter @dsh-remote/dsh-plugin-remote-settings typecheck
pnpm --filter @dsh-remote/dsh-plugin-remote-settings build
```

源码依据见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。
