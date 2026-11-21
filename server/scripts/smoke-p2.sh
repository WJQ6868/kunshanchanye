#!/usr/bin/env bash
# P2 接口冒烟：登录 → 逐个读接口 → 写名单 → 加分 → 排行榜 → 教务状态
set -u
BASE="${BASE:-http://127.0.0.1:3210/api/v1}"
JAR="$(dirname "$0")/../data/.cookies.txt"
rm -f "$JAR"

# 管理员账号从环境变量读，不要把口令写进仓库：
#   RC_ADMIN_LOGIN=xxx RC_ADMIN_PASSWORD=yyy bash scripts/smoke-p2.sh
ADMIN_LOGIN="${RC_ADMIN_LOGIN:-wjqcool}"
ADMIN_PASSWORD="${RC_ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "缺少 RC_ADMIN_PASSWORD 环境变量，拒绝用空口令跑冒烟。" >&2
  exit 2
fi

say() { echo; echo "=== $* ==="; }

say "login"
curl -s -m 10 -c "$JAR" -X POST "$BASE/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"login\":\"$ADMIN_LOGIN\",\"password\":\"$ADMIN_PASSWORD\"}" -o /dev/null -w 'http=%{http_code}\n'

CSRF=$(grep rc_csrf "$JAR" | awk '{print $7}')
echo "csrf=${CSRF:0:10}..."

# 幂等键必须每次跑都不同：固定键会让第二次跑命中「已处理过」而静默跳过整批，
# 看起来像「写入没生效」，实际是幂等在正常工作。
IDEM="smoke-$(date +%s)-$$"
echo "idem=$IDEM"

say "GET /classes (空库)"
curl -s -m 10 -b "$JAR" "$BASE/classes"; echo

say "PUT /classes"
curl -s -m 10 -b "$JAR" -X PUT "$BASE/classes" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"current":"电气2301","list":[{"name":"电气2301"},{"name":"自动化2302"}]}' | head -c 500; echo

say "PUT /roster (5 人)"
curl -s -m 10 -b "$JAR" -X PUT "$BASE/roster" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '[{"name":"张伟","id":"2023001","group":"电气2301"},{"name":"李娜","id":"2023002","group":"电气2301"},{"name":"王强","id":"2023003","group":"电气2301"},{"name":"刘洋","id":"2023004","group":"自动化2302"},{"name":"陈静","id":"2023005","group":"自动化2302"}]' | head -c 400; echo

say "GET /classes (有数据)"
curl -s -m 10 -b "$JAR" "$BASE/classes" | head -c 700; echo

say "PUT /classes/电气2301/scores"
NOW=$(node -e 'console.log(Date.now())')
curl -s -m 10 -b "$JAR" -X PUT "$BASE/classes/%E7%94%B5%E6%B0%942301/scores" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"records\":[{\"id\":\"s1\",\"t\":$NOW,\"name\":\"张伟\",\"sid\":\"2023001\",\"delta\":5,\"reason\":\"回答问题\"},{\"id\":\"s2\",\"t\":$NOW,\"name\":\"李娜\",\"sid\":\"2023002\",\"delta\":3,\"reason\":\"作业优秀\"}]}" | head -c 600; echo

say "GET /classes/电气2301/scores"
curl -s -m 10 -b "$JAR" "$BASE/classes/%E7%94%B5%E6%B0%942301/scores" | head -c 600; echo

say "PUT 同一批（幂等重放）"
curl -s -m 10 -b "$JAR" -X PUT "$BASE/classes/%E7%94%B5%E6%B0%942301/scores" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -H "Idempotency-Key: $IDEM" \
  -d "{\"records\":[{\"id\":\"s1\",\"t\":$NOW,\"name\":\"张伟\",\"sid\":\"2023001\",\"delta\":5,\"reason\":\"回答问题\"},{\"id\":\"s2\",\"t\":$NOW,\"name\":\"李娜\",\"sid\":\"2023002\",\"delta\":3,\"reason\":\"作业优秀\"}]}" | head -c 400; echo

say "GET /leaderboard?period=all"
curl -s -m 10 -b "$JAR" "$BASE/leaderboard?period=all" | head -c 700; echo

say "GET /leaderboard?period=week"
curl -s -m 10 -b "$JAR" "$BASE/leaderboard?period=week" | head -c 400; echo

say "GET /settings"
curl -s -m 10 -b "$JAR" "$BASE/settings" | head -c 300; echo

say "PUT /settings"
curl -s -m 10 -b "$JAR" -X PUT "$BASE/settings" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" \
  -d '{"theme":"white","anim":"wheel","rankPeriod":"week"}' | head -c 300; echo

say "GET /edu/status"
curl -s -m 10 -b "$JAR" "$BASE/edu/status" | head -c 500; echo

say "POST /edu/sync (未配置)"
curl -s -m 10 -b "$JAR" -X POST "$BASE/edu/sync" \
  -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '{}' | head -c 300; echo

say "DELETE /classes/电气2301/scores"
curl -s -m 10 -b "$JAR" -X DELETE "$BASE/classes/%E7%94%B5%E6%B0%942301/scores" \
  -H "X-CSRF-Token: $CSRF" | head -c 300; echo

say "GET /classes/电气2301/scores/all (冲正明细)"
curl -s -m 10 -b "$JAR" "$BASE/classes/%E7%94%B5%E6%B0%942301/scores/all" | head -c 500; echo

rm -f "$JAR"
echo; echo "=== done ==="
