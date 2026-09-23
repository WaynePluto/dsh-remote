# 壳级运行时注入（remote-privileged）

`@dsh-remote/dsh-plugin-remote-privileged` 由 launcher 作为唯一的壳级常驻 `--patch` overlay 传给 dsh，固定在首位且**不可停用**。它不属于第三方功能插件，承担两项运行时基础设施职责：

1. 为 `connection` 行注入 `webRuntime` 与 `webServer`，让插件 RPC 使用与 dsh 相同的 WebServer context。
2. 固定 `llm-pi-ai` 的模型启动屏障，并提供启动期占位服务，使模型增强 Bundle 在线停用或重新启用时无需热重启上游 `llm-pi-ai`。

模型增强随进程启动时，`models-catalog` 与 `model-capabilities` 完成真实初始化后把屏障服务挂到 root fiber；未随进程启动时，`model-bootstrap.mjs` 提供占位屏障。屏障在进程内保持稳定，不会让已停用的模型增强界面或 RPC 继续存在。

ownsHost 的远程设置能力已拆为 [远程体验 Bundle](../remote-experience/README.md) 中的
[remote-settings](../remote-settings/README.md) 组件，可在 Bundle 详情中停用；本壳级注入不作为第三方功能包分发。

## 维护

升级 dsh 时复核：

- `connection` 行的 `webRuntime` / `webServer` 注入契约；
- `llm-pi-ai` 的 `llm`、`modelsCatalogBootstrap`、`modelCapabilitiesBootstrap` 启动依赖；
- 11 个随附 Bundle 的在线停用与重新启用冒烟。

launcher、开发栈与绿色包检查清单都以 [dsh-plugins.ts](../../launcher/src/dsh-plugins.ts) 为准；上游契约见 [dsh 核实结论](../../../docs/02-dsh-facts.md)。
