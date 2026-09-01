#!/usr/bin/env node
/**
 * 校验仓库内所有 package.json 的直接依赖是否使用固定版本号。
 *
 * 允许的写法：
 *   - 精确 SemVer："4.4.3"、"0.1.1-rc.2"、"1.0.0+build.1"
 *   - workspace 协议："workspace:*"、"workspace:^"（pnpm workspace 内部链接）
 *   - catalog 协议："catalog:"、"catalog:xxx"
 *   - link:/file: 本地路径
 *
 * 拒绝的写法：^、~、>=、x 通配、范围（||、空格）、dist-tag（latest/next）、
 * git/URL 依赖等一切非确定版本。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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

/** @type {string[]} */
const invalid = [];

for (const file of files) {
  /** @type {Record<string, Record<string, string>>} */
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    invalid.push(`${relative(ROOT, file)}: 解析失败 (${error.message})`);
    continue;
  }

  for (const section of SECTIONS) {
    const deps = manifest[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec !== 'string') {
        invalid.push(`${relative(ROOT, file)}: ${section}.${name} 不是字符串`);
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

console.log(`[ok]   ${files.length} 个 package.json 的直接依赖均为固定版本号`);
