#!/usr/bin/env node
/**
 * 校验仓库内所有 package.json 的直接依赖是否使用固定版本号。
 *
 * 另外核对钉死版本的 workspace: 引用（"workspace:0.0.1"）必须指向目标 workspace 包的
 * 当前 version：发版改 version 漏改引用时，本地旧链接仍能解析，CI 全新安装才会炸，
 * 这里提前到提交前响亮失败。
 *
 * 最后核对各包 src/version.ts 里的构建身份常量（LAUNCHER_VERSION 等）必须等于
 * 本包 package.json 的 version——同一类「发版漏改」的源码形态，漏改会让包内 banner
 * 打出旧版本号。
 *
 * 允许：精确 SemVer（"4.4.3"、"0.1.1-rc.2"、"1.0.0+build.1"）、workspace 协议（"workspace:*"/"workspace:^"）、
 * catalog 协议（"catalog:"/"catalog:xxx"）及 link:/file: 本地路径。
 * 拒绝：^、~、>=、x 通配、范围（||/空格）、dist-tag（latest/next）以及 git/URL 等非确定版本。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'lib', '.git', '.dev', 'release', 'data']);

const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LOCAL_PROTOCOL = /^(workspace:|catalog:|link:|file:)/;

/** @param {string} dir @param {string[]} out */
function collectPackageJson(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      collectPackageJson(join(dir, entry.name), out);
    } else if (entry.name === 'package.json') {
      out.push(join(dir, entry.name));
    }
  }
}

const files = [];
const rootManifest = join(ROOT, 'package.json');
if (statSync(rootManifest, { throwIfNoEntry: false })) files.push(rootManifest);
collectPackageJson(join(ROOT, 'packages'), files);

/** @type {{ file: string, manifest: any }[]} */
const manifests = [];
/** @type {string[]} */
const invalid = [];

for (const file of files) {
  try {
    manifests.push({ file, manifest: JSON.parse(readFileSync(file, 'utf8')) });
  } catch (error) {
    invalid.push(`${relative(ROOT, file)}: 解析失败 (${error.message})`);
  }
}

// workspace 包名 -> 当前 version，用于核对钉死版本的 workspace: 引用
const workspaceVersions = new Map();
for (const { manifest } of manifests) {
  if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
    workspaceVersions.set(manifest.name, manifest.version);
  }
}

/** 钉死版本的 workspace: 引用与目标包实际版本不一致（发版改 version 漏改引用时会在 CI 才炸）。@type {string[]} */
const staleWorkspacePins = [];

for (const { file, manifest } of manifests) {
  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') {
        invalid.push(`${relative(ROOT, file)}: ${section}.${name} 不是字符串`);
        continue;
      }
      if (spec.startsWith('workspace:')) {
        const pinned = spec.slice('workspace:'.length);
        // 只核对钉死版本；workspace:* / ^ / ~ 随 workspace 包演进，无需核对
        if (EXACT_SEMVER.test(pinned)) {
          const actual = workspaceVersions.get(name);
          if (actual === undefined) {
            staleWorkspacePins.push(
              `${relative(ROOT, file)}: ${section}.${name} = "${spec}"，但 ${name} 不是 workspace 包`,
            );
          } else if (actual !== pinned) {
            staleWorkspacePins.push(
              `${relative(ROOT, file)}: ${section}.${name} = "${spec}"，但 ${name} 当前版本是 ${actual}`,
            );
          }
        }
        continue;
      }
      if (LOCAL_PROTOCOL.test(spec)) continue;
      if (EXACT_SEMVER.test(spec)) continue;
      invalid.push(`${relative(ROOT, file)}: ${section}.${name} = "${spec}"`);
    }
  }
}

if (invalid.length > 0) {
  console.error('[fail] 直接依赖必须写固定版本号（不允许 ^ / ~ / 范围 / dist-tag）：');
  for (const item of invalid) console.error(`       ${item}`);
  console.error('       修复：把版本改成 node_modules 中实际安装的版本，然后运行 pnpm install');
  process.exit(1);
}

if (staleWorkspacePins.length > 0) {
  console.error('[fail] 钉死版本的 workspace: 引用与目标包当前版本不一致：');
  for (const item of staleWorkspacePins) console.error(`       ${item}`);
  console.error('       修复：发版改 version 时同步改这些引用，然后运行 pnpm install 更新 lockfile');
  process.exit(1);
}

// packages/*/src/version.ts 的构建身份常量必须与本包 version 同步
const staleVersionConstants = [];
for (const { file, manifest } of manifests) {
  const versionFile = join(dirname(file), 'src', 'version.ts');
  if (!statSync(versionFile, { throwIfNoEntry: false })) continue;
  const source = readFileSync(versionFile, 'utf8');
  for (const match of source.matchAll(/export const ([A-Z0-9_]+_VERSION) = '([^']+)'/g)) {
    const [, constant, value] = match;
    if (value === manifest.version) continue;
    staleVersionConstants.push(
      `${relative(ROOT, versionFile)}: ${constant} = '${value}'，但包 version 是 ${manifest.version}`,
    );
  }
}

if (staleVersionConstants.length > 0) {
  console.error('[fail] 构建身份常量与包 version 不一致：');
  for (const item of staleVersionConstants) console.error(`       ${item}`);
  console.error('       修复：发版改 version 时同步改 version.ts 里的常量并重新构建');
  process.exit(1);
}

console.log(`[ok]   ${files.length} 个 package.json 的直接依赖均为固定版本号`);
