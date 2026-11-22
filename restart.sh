#!/usr/bin/env bash
# 一键重启（细节见 scripts/server-control.sh 顶部说明）
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/server-control.sh" restart "$@"
