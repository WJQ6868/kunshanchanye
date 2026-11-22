#!/usr/bin/env bash
# 一键启动（细节见 scripts/server-control.sh 顶部说明）
# 被 `sh start.sh` 调用时自动切回 bash —— 下面的 ${BASH_SOURCE[0]} 是 bash 专有语法
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/server-control.sh" start "$@"
