# 远程设置

`@dsh-remote/dsh-plugin-remote-privileged` 让已通过 relay 认证的远程浏览器使用完整的 dsh 设置页，
包括模型、凭据和插件配置。插件自动生效，没有单独的页面或开关。

## 工作方式

dsh 浏览器端通过 `ownsHost` 判断是否可以持久化设置。本插件使用官方的首页注入接口声明
`globalThis.__DSH_TRANSPORT__.ownsHost = true`，并为 profile 的 Connection 配置所需 Web 服务注入，
让其他插件的 RPC 通道正常挂载。

## 安全边界

- 不修改 dsh 源码、不改写 Host/Origin，也不绕过 `/api` 的信任校验和浏览器认证。
- 非 loopback 访问必须先通过 relay 登录；本插件不是认证方案。
- `ownsHost` 也会开放调用系统程序打开文件的能力，动作发生在运行 dsh 的机器桌面上，手机看不到该窗口。
- 仅加载到 `dsh-remote-web`，不修改官方 `web` profile。

## 维护

升级 dsh 时复核 `ClientTransportHooks.ownsHost`、`webserver/index-inject` 和 Connection 注入契约。
构建产物为 `dist/index.js`，无需浏览器 bundle。修改后必须重启 dsh。

源码依据见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。