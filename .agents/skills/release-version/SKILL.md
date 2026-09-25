---
name: release-version
description: 执行 dsh-station 的版本发布流程。预发布版本号 = 下一个正式版本 + 当日日期（如最新正式版是 0.0.1 时，预发布为 v0.0.2-20260925）；每次发布都先把之前所有预发布连根清理（本地/远程 tag、GitHub Release、changelog 与 release/ 本地产物），旧预发布的更新说明并入最新文档。正式发布 = 当前预发布去掉日期后缀，同样清空全部预发布痕迹。当用户要求发布预发布/正式版本、打发布 tag、或清理旧预发布时使用。不适用于依赖升级（那是 update-dependencies skill）。
---

# 版本发布（预发布 / 正式）

## 版本号规则

- **预发布**：`<下一个正式版本>-<YYYYMMDD>`，日期取当天。下一个正式版本 = 最新**正式**
  tag 的 patch + 1（例：正式版只有 0.0.1，预发布就是 `0.0.2-20260925`）。
  同一天重复发布**复用同一版本号**：删掉旧 tag 后重新构建、重打。
- **正式**：当前预发布去掉日期后缀（`0.0.2-20260925` → `0.0.2`）。
- tag 名为 `v<版本号>`，必须与 `packages/launcher/package.json` 的 `version` 完全一致，
  release 工作流有硬校验。版本号含 `-` 时 GitHub Release 自动标记为预发布。
- 判定「预发布 tag」：tag 名匹配 `v<数字>.<数字>.<数字>-*`（日期或 rc 后缀都算）。
  **正式 tag 永远不参与清理。**

## 核心不变量：任何时刻至多存在一个预发布

历史预发布不累积。每次发布（无论预发布还是正式）都先把之前所有预发布连根清理：
本地 tag、远程 tag、GitHub Release、`docs/changelog/` 文档与 `release/` 本地产物。
被清理版本的更新说明**并入最新文档**，不保留独立文件。

## 步骤一：清理历史预发布（两种发布都先做）

1. 列出并**向用户展示**将清理的预发布 tag，再执行删除：

   ```powershell
   git tag -l "v[0-9]*.[0-9]*.[0-9]*-*"
   ```

2. 对每个旧预发布 tag，按顺序清理（先 Release 后 tag，避免留下指向悬空 tag 的 Release）：

   ```powershell
   gh release view <tag>                    # 存在才删；gh 未登录先让用户 gh auth login
   gh release delete <tag> --yes --cleanup-tag   # 顺带删远程 tag
   git push origin --delete <tag>           # 上一步没删掉远程 tag 时补刀
   git tag -d <tag>                         # 本地 tag
   ```

3. 读出 `docs/changelog/<旧预发布版本>.md` 的内容（步骤三合并用），然后删除该文件；
   `CHANGELOG.md` 索引里删掉对应行。
4. 删除 `release/` 下以旧预发布版本号命名的本地产物（gitignore 的可再生成文件）。

## 步骤二：写入新版本号

按规则取号后，全仓替换旧版本字符串（注意 `workspace:<版本>` 固定引用也要跟着换）：

| 位置 | 内容 |
|---|---|
| `package.json`（根） | `version` + 4 个组合包的 `workspace:<版本>` devDependencies |
| `packages/*/package.json`、`packages/plugins/*/package.json` | 全部工作区包 `version` |
| `packages/launcher/src/version.ts`、`packages/connector/src/version.ts` | 运行时版本常量 |
| `packages/launcher/tests/plugin-distributions.spec.ts` | 固定版本断言 |

然后按序执行并全部通过：

```powershell
pnpm install                                                    # 刷新 pnpm-lock.yaml（不手改 lockfile）
pnpm plugins:prepare                                            # 刷新 .dev/plugins 介质版本
pnpm --filter @dsh-station/launcher --filter @dsh-station/connector build   # 版本常量进 dist
pnpm check:dependencies                                         # 抓 version.ts 与 package.json 不同步
pnpm --filter @dsh-station/launcher test                        # 固定版本断言
```

## 步骤三：changelog

- **预发布**：新建 `docs/changelog/<新版本>.md`，先吸收刚删掉的旧预发布文档的全部内容
  （同主题合并，不逐版罗列），再追加本轮变化；标题日期用发布当天。
- **正式**：把当前预发布的文档整理为 `docs/changelog/<正式版本>.md`，去掉「预发布迭代」
  类措辞，作为该正式版本的完整说明。
- `CHANGELOG.md` 索引同步：预发布条目只保留最新一个；正式条目按版本倒序排列，
  链接指向打 tag 时刻的文件。

## 步骤四：提交、打 tag、推送

```powershell
git status                       # 确认只有版本相关变更
git add -A
git commit -m "chore(release): 预发布 v<版本>"     # 正式版：chore(release): 发布 v<版本>
git tag v<版本>
git push origin main --tags
```

推 `v*` tag 后 release 工作流在三个原生 runner（windows/macos/ubuntu）各跑一条
`node scripts/release.mjs --target=<平台>`，一次构建产出全部介质（桌面 setup/portable ×
lite/full × 三平台 = 12 个 + Linux 服务版 zip × lite/full = 2 个）与 `checksums.txt`，
并创建 GitHub Release。

```powershell
gh run watch                     # 跟踪三路构建
gh release view v<版本>          # 确认 Release 与 14 个附件齐全
```

## 红线

- 正式 tag 不可删；清理只针对带 `-` 后缀的预发布 tag。
- 远程清理顺序：先 GitHub Release 再远程 tag。
- 打 tag 前必须存在 `docs/changelog/<版本>.md` 且已进 `CHANGELOG.md` 索引，
  否则 release 工作流直接失败。
- 不手改 `pnpm-lock.yaml`；版本变更后一律 `pnpm install` 重刷。
- 删除远程 tag / Release 前先把清单亮给用户（本 skill 的既定策略是用户确认过的批量清理，
  但列出被删对象是必须的动作）。
