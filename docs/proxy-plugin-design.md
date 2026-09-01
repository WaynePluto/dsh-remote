# dsh-remote Proxy Plugin 设计（延期实现）

> 状态：**设计已确认，暂不实现。** 当前主线先完成 M1 隧道；开发期由 launcher 的环境变量代理 bootstrap 临时解决 Node `fetch()` 不走公司代理的问题。
>
> 正式插件完成后，必须删除 launcher 的临时代理 bootstrap 及其环境变量读取逻辑，避免出现两套代理配置来源。

## 1. 目标与边界

在不修改、不 fork dsh 的前提下，为 dsh-remote 内嵌的 dsh 提供可热更新的模型 HTTP(S) 代理：

- 用户在 dsh Web UI 的**通用设置**中手工填写代理地址；
- 配置存入 dsh 的 `settings.yaml`，不读取 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`；
- 设置保存后立即对后续请求生效，不重启 dsh；
- dsh-remote 的 `dsh-remote-web` profile 自动加载该插件；用户正常运行官方 `web` profile 默认不加载；
- dsh-remote 与官方 dsh 共用 `DSH_HOME`：home 级全局 patch自动共享，profile 级 bundle/patch彼此隔离；
- v1 只覆盖使用 Undici/global `fetch()` 的 HTTP(S) 客户端，不宣称代理 dsh 的所有网络流量。

### 非目标

- 不支持 SOCKS、PAC；
- 不在 v1 支持代理 URL 中的用户名/密码；如以后需要，凭据应走 dsh credentials seam；
- 不通过设置 `NODE_TLS_REJECT_UNAUTHORIZED=0` 绕过证书校验；企业 TLS 根证书另行设计；
- 不修改 `process.env` 来诱导第三方库读取代理；
- 不修改 dsh 源码。

## 2. 目录与包

```text
packages/
└─ plugins/
   └─ proxy/
      ├─ package.json
      ├─ cordis.patch.yml
      ├─ tsconfig.json
      ├─ tsdown.config.ts
      ├─ src/
      │  ├─ index.ts                 # Host 半：settings + dispatcher 生命周期
      │  └─ client/
      │     ├─ index.tsx             # Browser 半：注册通用设置行
      │     └─ ProxyRow.tsx
      └─ tests/
```

包名：`@dsh-remote/plugin-proxy`。

`pnpm-workspace.yaml` 最终需要同时包含：

```yaml
packages:
  - packages/*
  - packages/plugins/*
```

## 3. dsh 双半插件结构

### 3.1 Host 半

使用 dsh 的 settings seam：

- namespace：`dsh-remote-proxy`；
- `installSettingsSection()` 把 Cordis entry config 作为 base，把用户 `settings.yaml` 作为覆盖层；
- `setSource()` 持有当前权威配置 thunk；
- `onChange()` 在 settings service attach/detach、文档提交时重新配置 dispatcher；
- `validate()` 在写入前拒绝不可服务的配置；
- 插件卸载时恢复它接管前的 dispatcher，并释放自己创建的 Agent。

建议配置：

```yaml
dsh-remote-proxy:
  enabled: true
  proxyUrl: http://proxy.example.com:8080
  noProxy: localhost,127.0.0.1,::1
```

类型：

```ts
interface ProxySettings {
  enabled: boolean
  proxyUrl: string
  noProxy: string
}
```

约束：

- `enabled: true` 时 `proxyUrl` 必填；
- 仅允许规范的 `http:` / `https:` URL；
- 拒绝 URL userinfo（`username` / `password`）；
- `noProxy` 是用户手填的逗号分隔规则，默认必须绕过 `localhost`、`127.0.0.1`、`::1`，避免本地 dsh/relay 请求被送进公司代理。

### 3.2 代理实现

优先复用成熟的 Undici dispatcher：

1. 显式把 UI 配置作为 `httpProxy`、`httpsProxy`、`noProxy` 传入；
2. 不让环境变量参与解析；
3. 使用 `setGlobalDispatcher()` 原子切换；
4. 新请求使用新 dispatcher，旧 dispatcher 等活动请求结束后关闭；
5. 关闭代理或卸载插件时，只在当前全局 dispatcher 仍由本插件持有时恢复原 dispatcher，避免覆盖其他插件后续的接管。

实现前必须核实目标 Undici 版本的 `EnvHttpProxyAgent` 是否在显式传参后仍读取环境变量；若无法证明完全不读，改为组合普通 `Agent` + `ProxyAgent` 的路由 Dispatcher。

### 3.3 Browser 半

代理是进程级通用行为，放到 `settings.general.item`，而不是 `settings.plugin.item`：

```ts
ctx.slots.inject('settings.general.item', () =>
  ctx.slots.register({
    name: 'settings.general.item',
    id: 'dsh-remote-proxy',
    order: 30,
    // store / locale / inject
  }, ProxyRow),
)
```

Browser 半通过：

```ts
ctx.settingsScope.bind<ProxySettings>({ namespace: 'dsh-remote-proxy' })
```

读写设置，保存时携带 revision，避免覆盖并发写入。

界面至少包括：

- 启用代理开关；
- 代理地址输入框；
- 不代理地址输入框；
- 保存、放弃、恢复默认；
- URL 校验错误；
- “只影响基于 Node fetch/Undici 的模型 HTTP(S) 请求”的能力说明。

### 3.4 Client bundle 构建

dsh 动态 Browser 插件要求 `lib/client.js` 是 lazy-CJS factory：

```js
window.__ModuleLoader__.load({
  id: '@dsh-remote/plugin-proxy',
  factory: (require) => {
    // bundle
    return module.exports
  },
})
```

官方 preset 位于 dsh 源码的 `packages/client/tsdown.client.ts`，目前未作为 npm 包发布。仓库外插件必须复现必要的 tsdown 配置：

- `format: 'cjs'`、`platform: 'browser'`；
- banner / footer / `module.exports` intro；
- dsh module table 的 runtime externals；
- React JSX runtime；
- sourcemap；
- 如使用样式，再实现 CSS 内联。初版应避免 CSS Modules，降低耦合。

## 4. 包清单与 bundle

`package.json` 同时声明 Node、Browser 两个 export：

```jsonc
{
  "name": "@dsh-remote/plugin-proxy",
  "type": "module",
  "exports": {
    ".": {
      "types": "./lib/types/index.d.ts",
      "default": "./lib/index.js"
    },
    "./client": {
      "types": "./lib/types/client/index.d.ts",
      "default": "./lib/client.js"
    },
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-runtime",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-locale"
      ]
    }
  }
}
```

`cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-remote-proxy
      name: '@dsh-remote/plugin-proxy'
```

启用的 Host Loader row 使 `dsh-client-modules` 发现同包的 `dsh.client` 声明并提供 `/plugins/.../client.js`。

## 5. dsh 官方插件加载机制（源码核实）

### 5.1 Profile bundle

```powershell
dsh plugin --profile web add <package-or-path>
```

该命令在 `$DSH_HOME/profiles/web` 中转发给 pnpm。安装成功后：

- 声明 `dsh.bundle.patch` 的依赖自动追加到 profile 的 `dsh.profile.bundles`；
- 没有 `dsh.bundle` 的包只作为普通依赖安装，不会自动挂载；
- remove/update 后按当前安装状态重新协调 bundle 列表。

### 5.2 Profile patch

`$DSH_HOME/profiles/<name>/cordis.patch.yml`，只影响该 profile。

### 5.3 Harness home 全局 patch

`$DSH_HOME/cordis.patch.yml`，影响该 home 下所有 profile。dsh 没有单独的“全局 profile”，这里才是全局覆盖层。

### 5.4 启动参数 patch

```powershell
dsh --profile web --patch C:\path\extra.patch.yml
```

只影响本次启动，适合诊断或一次性组合，不修改用户 profile。dsh-remote 的内置插件不走这条临时 overlay，而是作为 bundle 固化在 `dsh-remote-web` profile。

### 5.5 层优先级

```text
profile bundles（声明顺序）
→ profile/cordis.patch.yml
→ $DSH_HOME/cordis.patch.yml
→ --patch overlays（参数顺序）
```

Profile patch 与 home patch支持运行时监听；更新失败时保留上一棵可用插件树。

## 6. 共享 DSH_HOME，以 profile 隔离（D14）

dsh-remote 沿用官方 dsh 的标准 home：

```text
$DSH_HOME（若用户设置）
否则 ~/.dsh
```

它不创建私有 home，而是启动自有 profile：

```text
官方 Web：$DSH_HOME/profiles/web
dsh-remote：$DSH_HOME/profiles/dsh-remote-web
```

共享内容：

- `settings.yaml`、`.credentials.yaml`、sessions、storages；
- `$DSH_HOME/cordis.patch.yml`，因为用户把它放在 home 层就是有意让所有 profile 加载。

隔离内容：

- profile 的 bundle 列表；
- profile 自己的 `cordis.patch.yml`；
- profile 安装的树外依赖。

`dsh-remote-web` 的基础 bundle 顺序：

```text
@deepseek-ai/dsh-base
@deepseek-ai/dsh-web-app
@dsh-remote/plugin-proxy（以及其他随项目分发的内置 bundle）
```

内置插件不写入 home 级 patch，也不修改官方 `web` profile。

| 场景 | 是否加载 proxy |
|---|---|
| 用户正常运行官方 `dsh web` | 否 |
| 用户运行 dsh-remote（`dsh-remote-web`） | 是 |
| 用户的 `$DSH_HOME/cordis.patch.yml` | 两边都加载 |
| 只安装在官方 `web` profile 的第三方 bundle | dsh-remote 不加载 |
| 只安装在 `dsh-remote-web` profile 的第三方 bundle | 官方 `web` 不加载 |
| 用户显式运行官方 dsh 的 `dsh-remote-web` profile | 会加载（用户明确选择了该 profile） |

## 7. 插件安装与精简 launcher

launcher 不再实现 `dsh-remote plugin add/remove/list`，也不读取 `extraPatches`。插件管理完全沿用 dsh 官方命令，避免在上游 dsh 更新时维护第二套 profile/pnpm 行为：

```powershell
# 只给 dsh-remote 使用
dsh plugin --profile dsh-remote-web add <bundle-package-or-path>

# 用户主动让官方 web profile 使用 dsh-remote proxy
dsh plugin --profile web add @dsh-remote/plugin-proxy
```

launcher 对 profile 只做一件事：当 `dsh-remote-web` 完全不存在时，写入最小模板；如果已存在则不重写，用户拥有后续修改。模板创建是启动自有 profile 的必要引导，不扩展成通用插件管理功能。

开发/发布包中的 `@dsh-remote/plugin-proxy` 是 launcher 的运行时依赖，使自有 profile 能从同一真实 `node_modules` 树解析它；官方 `web` profile没有对应 bundle 行，因此不会仅因包存在于磁盘就加载。

## 8. 安全与产品限制

- dsh 0.1.2 删除了钉死 loopback 的特权方法名单，所以设置类接口在模式 A 下就可用：
  已通过 relay 认证的远程用户能修改代理设置，因此 relay 的原始 Host/Origin 检查与登录防线必须保持。
  （旧的模式 B / `unlockPrivileged` 已删除，不再是这里的变量。）
- 代理地址不是 secret，但禁止 userinfo，避免凭据通过设置描述接口回显。
- 插件不提供“忽略 TLS 错误”开关；企业代理 CA 应通过安全的自定义 CA 设计解决。
- global dispatcher 是进程级单例；必须正确处理多个接管者、插件卸载和在途请求。
- global fetch 代理不保证覆盖 WebSocket、AWS 自定义 handler、原生模块或自行创建的 Node Agent。

## 9. 验收

- Host namespace 在 `settings.yaml` 中可持久化且热更新；
- 通用设置出现代理行，保存/放弃/恢复默认和 revision 冲突行为正确；
- `/plugins/<id>/client.js` 返回 200 且 Browser bundle 正常执行；
- mock 直连与 mock CONNECT proxy 测试证明 enabled/disabled/noProxy 路由正确；
- 当前 `opencode-go` provider 在公司网络中可发起流式请求；
- 本地 `127.0.0.1` 请求不进入代理；
- 卸载插件后恢复原 dispatcher；
- 官方 `web` profile 不出现该插件；
- dsh-remote 在共享 `DSH_HOME` 中只创建/修改 `dsh-remote-web` profile，不修改官方 `web` profile或 home 级 patch；
- home 级全局 patch在两个 profile 中都生效；
- 完成后删除 launcher 临时代理方案并验证只剩 UI 配置这一处代理事实源。

## 10. 依据

以下路径相对 dsh 源码仓库根（根路径见 skill `dsh-source`）：

- `docs/architecture.md`（Profiles and bundles）
- `docs/cordis-tutorial/01-first-plugin.md`
- `docs/cookbook/adding-a-settings-card.md`
- `packages/boot/app-boot/README.md`（Profiles）
- `apps/cli/src/plugin.ts`
- `packages/settings/settings/src/index.ts`（`installSettingsSection`）
- `packages/client/ui-settings-general/src/client/index.ts`
- `packages/client/tsdown.client.ts`
