# M0 验证报告（进行中）

> 环境：Windows / Node v22.19.0 / pnpm 10.17.0 / `@deepseek-ai/dsh@0.1.0-rc.7`（npm 上的 latest，本地源码是未发布的 rc.8）
> dsh 以本仓库依赖形式安装（D13），`DSH_HOME` 指向 `.dev/dsh-home`，未污染用户全局 `~/.dsh`。

## 结论速览

| 问题 | 结论 |
|---|---|
| dsh 能否作为 npm 依赖内嵌、不需要用户单独安装？ | ✅ 能。`node node_modules/@deepseek-ai/dsh/lib/bin.js web` 直接可用，profile 首次启动自动物化，**不需要联网 pnpm install 插件** |
| 模式 A（声明 `trustedHosts`，不重写 Host）可行？ | ✅ 完全可行。`/api` + 两个 WebSocket 全部放行；15 个特权方法如预期 403 |
| 模式 B（重写 Host 为 loopback）可行？ | ✅ 可行。特权方法（`settings.describe`）返回 200，确认能解锁 |
| dsh 的 fence 是否只看 HTTP 头？ | ✅ 是。本机构造 Host 头即可完全复现公网链路行为 |
| 手机上 dsh 原生 UI 能不能用？ | ⏳ 待用户实测（M0.3） |

---

## M0.1 / M0.2 · 安装与 profile 导出

- `dsh --version` → `0.1.0-rc.7`
- `dsh --profile web --dump-config` → 503 行，已存档 `docs/reference/web-profile.yml`
- profile 首次启动物化到 `$DSH_HOME/profiles/web/`，只有 4 个文件：
  `cordis.yml`（空数组）、`cordis.patch.yml`（用户 patch 层）、`package.json`（`dsh.profile.bundles = [dsh-base, dsh-web-app]`）、`pnpm-workspace.yaml`
- webserver 默认值（`web-profile.yml` L404-410）：`host: 127.0.0.1`、`port: 3080`，均可被 CLI 覆盖

### ⚠️ 打包相关的关键发现（影响 M3）

1. **`$DSH_HOME/profiles/node_modules` 是一堆指向安装方 pnpm store 的绝对路径 junction**
   例：`profiles/node_modules/@deepseek-ai/cordis → D:\dev\dsh-remote\node_modules\.pnpm\@deepseek-ai+dsh@0.1.0-rc.7_.../node_modules/@deepseek-ai/cordis`
   → 绿色包被移动 / 改名后旧 junction 会失效。**D14 已决定共用标准 DSH_HOME，不把 home 指到包内。** 官方 dsh 每次 profile boot 都调用 `healProfilesModuleFallback()` 重建安装侧 fallback；launcher 不再复制这套逻辑。M3 只需做一次“移动绿色包后重新启动”的验收，确认上游 healing 足够；不足时再提交上游问题，而不是长期维护一套私有修复器。
2. **pnpm 10 默认忽略了 6 个依赖的构建脚本**：`@deepseek-ai/dsh-subprocess-local`、`@google/genai`、`esbuild`、`koffi`、`node-pty`、`protobufjs`。
   dsh web 在此状态下**能正常启动并响应 RPC**，但 PTY / 终端类工具是否受影响未验证 → M3 之前必须复核（跑一次真实 bash 工具调用）。
3. peer 警告：`react-dom 19.2.8` 要求 `react@^19.2.8`，实际解析到 `react 18.3.1`。前端 dist 是预构建的，估计无实际影响，但 M0.3 实测时若前端行为异常，先回来看这条。

---

## M0.4 · fence 验证（本机等价验证，未用公网服务器）

**方法**：`scripts/m0-fence-check.mjs` 直接构造 `Host` / `Origin` / `sec-fetch-site` 打本机 `127.0.0.1:3080`。

**为什么等价**：`packages/client/connection/src/api-request-trust.ts` 的 `isTrustedApiRequest(request, trustedHosts)` 入参只有 headers，源码中**没有任何 `socket.remoteAddress` 检查**（02 文档 §4.1 已核实）。因此本机伪造 Host 与真实公网链路对 fence 而言不可区分。ssh -R + nginx 的公网链路验证推迟到 M1.5 端到端联调。

### 结果对照表

| 用例 | 无 `--trusted-host` | `--trusted-host pc1.dsh.example.com` |
|---|---|---|
| `GET /`（Host=loopback） | 200 | 200 |
| `GET /`（Host=pc1.dsh.example.com） | **200** | 200 |
| `POST /api/llm.providers`（Host=loopback） | 200 | 200 |
| `POST /api/llm.providers`（Host=pc1，Origin 同源） | **403** | **200** ✅ 模式 A 成立 |
| `POST /api/settings.describe`（特权，Host=pc1） | 403 | **403** ✅ 特权方法确实够不到 |
| `POST /api/settings.describe`（Host 改写为 loopback） | **200** | 200 ✅ 模式 B 成立 |
| `POST /api/llm.providers`（Host=pc1，Origin=evil） | 403 | 403 |
| `POST /api/llm.providers`（`sec-fetch-site: cross-site`） | 403 | 403 |
| `GET /api/events.mux`（无 Upgrade 头） | 426 | 426 |
| WS 升级 `/api/events.mux`（Host=loopback） | 101 | 101 |
| WS 升级 `/api/events.mux`（Host=pc1） | **403** | **101** ✅ |
| WS 升级 `/api/events.host`（Host=pc1） | **403** | **101** ✅ |

### 格式错误的 `--trusted-host`

```
node .../dsh/lib/bin.js web --trusted-host https://pc1.dsh.example.com
→ 退出码 1
→ Error: dsh: plugin tree failed to load: failed to apply loader entry connection
   (@deepseek-ai/dsh-client-connection): client-connection: trustedHosts entry
   "https://pc1.dsh.example.com" is not a bare host[:port] authority
```

**确认是启动即失败**（不是运行时 403），与 02 文档 §4.4 一致。launcher 拼 `--trusted-host` 前必须自己校验格式。

---

## 对现有文档的修正

**`/api` 不是「单一 POST 端点」，而是一个前缀路由。**
实际形状（`packages/client/connection/src/{index.ts,client/rpc.ts}`）：

```
POST /api/<method>          ← 例如 /api/llm.providers、/api/settings.describe
body: {"type":"client-request","rpcId":"<uuid>","method":"<method>","payload":{...}}
resp: {"type":"server-response","rpcId":"<uuid>","result":{...}}
```

- fence 注册为 `{ kind: 'prefix', path: '/api' }`，对整个前缀生效
- 特权方法判定取路径末段：`pathname.slice('/api'.length + 1)`，再查 `PRIVILEGED_METHODS`，用**空信任列表**判 loopback
- **对 relay 无影响**（relay 按前缀整体转发字节，不解析方法名），但 docs/02 §3 的写法应改成 `POST /api/<method>`

另外 fence 注释里还提到一条 02 文档没写的：trustedHosts 除了手工声明，**dsh CLI 自己会为 `--host 0.0.0.0` 推导本机 LAN IP 字面量**并加入信任列表。这解释了 M0.3 局域网实测时 `--trusted-host <LAN_IP>:3080` 可能不是必须的。

---

## 待办

- [ ] M0.3 手机实测（用户执行，见 `docs/reference/mobile-test.md`）
- [ ] M0.5 Hello World 客户端插件（不阻塞 M1）
- [ ] 公网链路（ssh -R / Caddy）验证 —— 并入 M1.5
- [ ] 复核 `node-pty` / `koffi` 构建脚本被跳过是否影响终端类工具（M3 之前）
