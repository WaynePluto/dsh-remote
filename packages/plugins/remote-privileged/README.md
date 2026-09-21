# 壳级连接注入（remote-privileged）

`@dsh-remote/dsh-plugin-remote-privileged` 只剩一个职责：包根 `dsh-overlay.yml` 里的
`connection` 行注入。launcher 把它作为唯一的壳级常驻 `--patch` overlay 传给 dsh，
固定在首位，**不可停用**——它让插件 RPC 注册使用与 dsh 自己相同的 WebServer context，
是全部插件（含本机使用）RPC 通道的地基，不是一个功能插件。

ownsHost 的远程设置能力已拆到受管 Bundle
[remote-settings](../remote-settings/README.md)（默认全开、可停用、托盘补回）。
本包没有代码产物，只有 overlay 文件与说明。

## 维护

升级 dsh 时复核 `connection` 行的 `webRuntime` / `webServer` 注入契约
（见 [dsh 核实结论](../../../docs/02-dsh-facts.md)）。launcher、开发栈与绿色包
检查清单都以 [dsh-plugins.ts](../../launcher/src/dsh-plugins.ts) 为准。
