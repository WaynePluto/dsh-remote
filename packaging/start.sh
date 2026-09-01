#!/bin/sh
# dsh-remote 的 Linux / macOS 启动入口。
#
# 检查 Node.js 版本，然后从本脚本所在目录运行 dist/index.js。
# 多余的参数原样转交给 dsh-remote，例如：./start.sh --config /etc/dsh-remote.json
#
# 刻意只用 POSIX sh：这个脚本要能在没有 bash 的精简系统（Alpine 等）上跑起来，
# 至少要能把「Node 版本太低」这句话打印出来。

set -eu

# 最低 Node 版本，与 packages/launcher/src/node-version.ts 中的 MINIMUM_NODE_VERSION 一致。
MIN_MAJOR=22
MIN_MINOR=19
MIN_PATCH=0
MIN_VERSION="${MIN_MAJOR}.${MIN_MINOR}.${MIN_PATCH}"
NODE_URL="https://nodejs.org"

fail() {
  printf '\n' >&2
  for line in "$@"; do
    printf '%s\n' "$line" >&2
  done
  printf '\n' >&2
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  fail "[dsh-remote] 没有找到 Node.js（命令 node 不存在）。" \
       "           dsh-remote 使用你本机的 Node.js 运行，请到 ${NODE_URL} 下载安装 LTS 版" \
       "           （${MIN_VERSION} 或更高），或用系统包管理器安装，然后重新运行本脚本。"
fi

RAW_VERSION=$(node -v 2>/dev/null || true)
# node -v 输出形如 v22.19.0，也可能带预发布后缀（v23.0.0-nightly）。只看前三段数字，
# 判断口径与 launcher 里的 releaseNumbers 一致。
VERSION=$(printf '%s' "$RAW_VERSION" | sed -n 's/^v\{0,1\}\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\).*$/\1/p')
if [ -z "$VERSION" ]; then
  fail "[dsh-remote] 认不出 Node.js 的版本号，node -v 输出的是：${RAW_VERSION}" \
       "           请确认 $(command -v node) 确实是 Node.js，或到 ${NODE_URL} 重新安装。"
fi

# 用参数展开拆版本号，不要用 "set -- $VERSION"：那会把脚本自己的 "$@" 冲掉，
# 最后 exec 转交给 node 的就变成版本号而不是用户传进来的参数了。
MAJOR=${VERSION%%.*}
REST=${VERSION#*.}
MINOR=${REST%%.*}
PATCH=${REST#*.}

too_old=0
if [ "$MAJOR" -lt "$MIN_MAJOR" ]; then
  too_old=1
elif [ "$MAJOR" -eq "$MIN_MAJOR" ]; then
  if [ "$MINOR" -lt "$MIN_MINOR" ]; then
    too_old=1
  elif [ "$MINOR" -eq "$MIN_MINOR" ] && [ "$PATCH" -lt "$MIN_PATCH" ]; then
    too_old=1
  fi
fi

if [ "$too_old" -eq 1 ]; then
  fail "[dsh-remote] Node.js 版本太低：这台机器上是 v${MAJOR}.${MINOR}.${PATCH}，dsh-remote 需要 ${MIN_VERSION} 或更高。" \
       "           请到 ${NODE_URL} 下载安装新版 Node.js（LTS 即可），然后重新运行本脚本。" \
       "           当前用的是： $(command -v node)"
fi

# 以脚本自身所在目录当工作目录：dsh-remote.config.json 是按当前目录查找的，而用户从哪个
# 目录调用这个脚本是无法预测的。
PACKAGE_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$PACKAGE_ROOT"

if [ ! -f dist/index.js ]; then
  fail "[dsh-remote] 找不到 ${PACKAGE_ROOT}/dist/index.js。" \
       "           这个压缩包没有完整解压，请把整个 zip 重新解压一次。"
fi

printf '[dsh-remote] Node v%s.%s.%s  (%s)\n' "$MAJOR" "$MINOR" "$PATCH" "$(command -v node)"

# exec 而不是普通调用：让 node 直接接管这个进程，Ctrl+C 和 systemd 的 SIGTERM
# 都能原封不动送到 launcher，由它按 connector -> relay -> dsh 的顺序收尾。
exec node dist/index.js "$@"
