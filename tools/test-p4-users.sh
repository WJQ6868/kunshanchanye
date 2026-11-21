#!/bin/bash
# 人员管理 P4 接口全链路测试（在服务器本机跑，走 https）
set -u
B="https://class.wangjiaqi.me/api/v1"
CJ=/tmp/wjq-test-cj.txt
rm -f "$CJ"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "  ✓ $1"; }
bad() { fail=$((fail+1)); echo "  ✗ $1  ($2)"; }

login() {
  curl -s -c "$CJ" -X POST "$B/auth/login" -H 'Content-Type: application/json' \
    -d "{\"login\":\"$1\",\"password\":\"$2\"}" > /dev/null
  CSRF=$(grep rc_csrf "$CJ" | awk '{print $7}')
}
# api METHOD PATH [BODY]
api() {
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -b "$CJ" -X "$m" "$B$p" -H 'Content-Type: application/json' \
      -H "X-CSRF-Token: $CSRF" -H 'Origin: https://class.wangjiaqi.me' -d "$body"
  else
    curl -s -b "$CJ" -X "$m" "$B$p" -H "X-CSRF-Token: $CSRF" -H 'Origin: https://class.wangjiaqi.me'
  fi
}
code() {
  local m=$1 p=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X "$m" "$B$p" -H 'Content-Type: application/json' \
      -H "X-CSRF-Token: $CSRF" -H 'Origin: https://class.wangjiaqi.me' -d "$body"
  else
    curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X "$m" "$B$p" -H "X-CSRF-Token: $CSRF" -H 'Origin: https://class.wangjiaqi.me'
  fi
}

echo "== 1. 管理员登录 =="
login wjqcool 5201314
[ -n "$CSRF" ] && ok "拿到 CSRF token" || bad "拿 CSRF" "空"

echo "== 2. 未登录访问 /users 应 401 =="
c=$(curl -s -o /dev/null -w '%{http_code}' "$B/users")
[ "$c" = "401" ] && ok "未登录 401" || bad "未登录" "$c"

echo "== 3. 缺 CSRF 应 403 =="
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ" -X POST "$B/users" -H 'Content-Type: application/json' \
  -H 'Origin: https://class.wangjiaqi.me' -d '{"login":"nocsrf","displayName":"x","role":"teacher"}')
[ "$c" = "403" ] && ok "缺 CSRF 403" || bad "缺 CSRF" "$c"

echo "== 4. 新增讲师 =="
r=$(api POST /users '{"login":"t_p4test","displayName":"测试讲师","role":"teacher","employeeNo":"T9001","password":"test123456","classScopes":null}')
TID=$(echo "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "$r" | grep -q '测试讲师' && ok "新增成功 id=$TID" || bad "新增" "$r"
echo "$r" | grep -q '"mustChange":true' && ok "mustChange=true" || bad "mustChange" "$r"
echo "$r" | grep -q '"builtin":false' && ok "builtin=false" || bad "builtin" "$r"

echo "== 5. 登录名重复应 409 =="
c=$(code POST /users '{"login":"t_p4test","displayName":"重名","role":"teacher"}')
[ "$c" = "409" ] && ok "重名 409" || bad "重名" "$c"

echo "== 6. 工号重复应 409 =="
c=$(code POST /users '{"login":"t_p4test2","displayName":"工号重","role":"teacher","employeeNo":"T9001"}')
[ "$c" = "409" ] && ok "工号重 409" || bad "工号重" "$c"

echo "== 7. 非法登录名应 400 =="
c=$(code POST /users '{"login":"中文名","displayName":"x","role":"teacher"}')
[ "$c" = "400" ] && ok "非法登录名 400" || bad "非法登录名" "$c"

echo "== 8. 新账号能登录且必须改密 =="
CJ2=/tmp/wjq-test-cj2.txt; rm -f "$CJ2"
r=$(curl -s -c "$CJ2" -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"login":"t_p4test","password":"test123456"}')
echo "$r" | grep -q '"mustChange":true' && ok "新账号登录成功且 mustChange=true" || bad "新账号登录" "$r"
echo "$r" | grep -q '"role":"teacher"' && ok "角色 teacher" || bad "角色" "$r"

echo "== 9. 讲师无权访问 /users 应 403 =="
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ2" "$B/users")
[ "$c" = "403" ] && ok "讲师 403" || bad "讲师" "$c"

echo "== 10. 改姓名+权限+停用 =="
r=$(api PATCH "/users/$TID" '{"displayName":"改名后","perms":{"score.add":false}}')
echo "$r" | grep -q '改名后' && ok "改名成功" || bad "改名" "$r"
echo "$r" | grep -q '"score.add":false' && ok "权限覆盖生效" || bad "权限" "$r"

echo "== 11. 停用后无法登录 =="
api PATCH "/users/$TID" '{"disabled":true}' > /dev/null
CJ3=/tmp/wjq-test-cj3.txt; rm -f "$CJ3"
c=$(curl -s -o /dev/null -w '%{http_code}' -c "$CJ3" -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"login":"t_p4test","password":"test123456"}')
[ "$c" = "403" ] && ok "停用后登录 403" || bad "停用后登录" "$c"

echo "== 12. 已有会话在停用后应失效 =="
c=$(curl -s -o /dev/null -w '%{http_code}' -b "$CJ2" "$B/me")
[ "$c" = "401" ] && ok "旧会话已吊销 401" || bad "旧会话" "$c"

echo "== 13. 重新启用 + 重置密码 =="
api PATCH "/users/$TID" '{"disabled":false}' > /dev/null
c=$(code POST "/users/$TID/password" '{"newPassword":"newpass789"}')
[ "$c" = "200" ] && ok "重置密码 200" || bad "重置密码" "$c"
c=$(curl -s -o /dev/null -w '%{http_code}' -c /tmp/wjq-test-cj4.txt -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"login":"t_p4test","password":"newpass789"}')
[ "$c" = "200" ] && ok "新密码可登录" || bad "新密码登录" "$c"
c=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$B/auth/login" -H 'Content-Type: application/json' \
  -d '{"login":"t_p4test","password":"test123456"}')
[ "$c" = "401" ] && ok "旧密码失效 401" || bad "旧密码" "$c"

echo "== 14. 不能删除自己 =="
ME=$(api GET /me | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
c=$(code DELETE "/users/$ME")
[ "$c" = "400" ] && ok "删自己 400" || bad "删自己" "$c"

echo "== 15. 内置管理员不能被停用/降级 =="
c=$(code PATCH "/users/$ME" '{"disabled":true}')
[ "$c" = "400" ] && ok "停用内置 400" || bad "停用内置" "$c"
c=$(code PATCH "/users/$ME" '{"role":"teacher"}')
[ "$c" = "400" ] && ok "降级内置 400" || bad "降级内置" "$c"
c=$(code DELETE "/users/$ME")
[ "$c" = "400" ] && ok "删除内置 400" || bad "删除内置" "$c"

echo "== 16. 最后一个管理员保护（新建管理员→降级自己前的模拟）=="
r=$(api POST /users '{"login":"t_admin2","displayName":"第二管理员","role":"admin","password":"admin123456"}')
A2=$(echo "$r" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$A2" ] && ok "新建第二管理员" || bad "新建第二管理员" "$r"
c=$(code PATCH "/users/$A2" '{"role":"teacher"}')
[ "$c" = "200" ] && ok "有两个管理员时可降级其一" || bad "降级第二管理员" "$c"

echo "== 17. 删除测试账号 =="
c=$(code DELETE "/users/$TID")
[ "$c" = "200" ] && ok "删除讲师 200" || bad "删除讲师" "$c"
c=$(code DELETE "/users/$A2")
[ "$c" = "200" ] && ok "删除第二管理员 200" || bad "删除第二管理员" "$c"
# 没有单条查询接口（前端不需要），DELETE 之后再 GET 应当落到 405 而不是返回数据
c=$(code GET "/users/$TID")
[ "$c" = "405" ] && ok "无单条查询接口（405，符合预期）" || bad "删后查" "$c"
echo "== 18. 删后列表里不应再有它 =="
api GET /users | grep -q "$TID" && bad "列表仍含已删账号" "$TID" || ok "列表已不含已删账号"

echo
echo "===== 结果：$pass 通过 / $fail 失败 ====="
[ "$fail" = "0" ]
