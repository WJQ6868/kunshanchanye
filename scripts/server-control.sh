#!/usr/bin/env bash
# ============================================================
#  server-control.sh — 启停控制核心
# ------------------------------------------------------------
#  一般不用直接调用它，用仓库根目录的四个一键脚本：
#      ./start.sh     启动
#      ./stop.sh      停止
#      ./restart.sh   重启
#      ./status.sh    看状态
#  需要看实时日志时：./scripts/server-control.sh logs
#
#  两种运行模式，脚本自己判断：
#    systemd  —— 机器上装了 wjq-rollcall.service（生产部署就是这样），
#                转给 systemctl，保持和开机自启、日志落点一致
#    manual   —— 没有 systemd 单元时，用 nohup 直接起 node，
#                pid 写进 server/data/wjq.pid，日志追加到 server/data/server.log
#  想强制用某一种：WJQ_MODE=manual ./start.sh  /  WJQ_MODE=systemd ./start.sh
#
#  为什么不用 `source .env`：那个文件是配置不是脚本，逐行解析成
#  环境变量更安全，而且「命令行上已经给的变量」优先级更高，
#  方便临时 `PORT=3210 ./start.sh` 起一个测试实例。
# ============================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_DIR="$ROOT/server"
ENV_FILE="${WJQ_ENV_FILE:-$SERVER_DIR/.env}"   # 临时换配置文件（自测/多实例时用）
DATA_DIR="$SERVER_DIR/data"
PID_FILE="$DATA_DIR/wjq.pid"
LOG_FILE="$DATA_DIR/server.log"
UNIT="${WJQ_UNIT:-wjq-rollcall.service}"   # 临时换单元名（自测/多实例时用）
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-40}"   # 等健康检查的最长秒数

# ---------- 输出 ----------
if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'
  C_DIM=$'\033[2m'; C_B=$'\033[1m'; C_END=$'\033[0m'
else
  C_OK=''; C_WARN=''; C_ERR=''; C_DIM=''; C_B=''; C_END=''
fi
ok()   { printf '%s✓%s %s\n' "$C_OK" "$C_END" "$*"; }
warn() { printf '%s!%s %s\n' "$C_WARN" "$C_END" "$*"; }
err()  { printf '%s✗%s %s\n' "$C_ERR" "$C_END" "$*" >&2; }
info() { printf '%s·%s %s\n' "$C_DIM" "$C_END" "$*"; }

# ---------- 读配置 ----------
load_env() {
  [ -f "$ENV_FILE" ] || return 0
  local line key val
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) continue ;; esac
    key="${line%%=*}"
    val="${line#*=}"
    # 只接受合法的变量名，避免把注释里的怪东西塞进环境
    case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
    # 去掉值两边成对的引号（.env 里写 PORT="3000" 也认）
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    # 命令行已经指定的优先，不被 .env 覆盖
    [ -n "${!key+x}" ] && continue
    export "$key=$val"
  done < "$ENV_FILE"
}

load_env
PORT="${PORT:-3000}"
HOST="${HOST:-127.0.0.1}"
NODE_ENV="${NODE_ENV:-dev}"

# 监听 0.0.0.0 / :: 时探活要打回环地址，否则连不上
case "$HOST" in
  0.0.0.0|'::'|'[::]'|'') PROBE_HOST="127.0.0.1" ;;
  *) PROBE_HOST="$HOST" ;;
esac
BASE_URL="http://$PROBE_HOST:$PORT"

# ---------- 环境探测 ----------
mode() {
  case "${WJQ_MODE:-auto}" in
    manual)  echo manual;  return ;;
    systemd) echo systemd; return ;;
  esac
  if command -v systemctl >/dev/null 2>&1 && systemctl cat "$UNIT" >/dev/null 2>&1; then
    echo systemd
  else
    echo manual
  fi
}

node_bin() {
  command -v node 2>/dev/null || { [ -x /usr/local/bin/node ] && echo /usr/local/bin/node; }
}

# systemctl 需要 root：已经是 root 就直接调，否则优先免密 sudo
as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif sudo -n true 2>/dev/null; then
    sudo -n "$@"
  else
    # 没有免密 sudo：让它正常弹密码提示（终端里跑才有意义）
    if [ -t 0 ]; then sudo "$@"; else
      err "需要 sudo 权限，请用：sudo $0 ${CMD:-start}"
      return 1
    fi
  fi
}

unit_active() { systemctl is-active --quiet "$UNIT" 2>/dev/null; }

health_json() { curl -fsS -m 2 "$BASE_URL/healthz" 2>/dev/null; }

port_owner() {
  # 监听该端口的 pid（没有就返回空）
  command -v ss >/dev/null 2>&1 || return 0
  ss -lntpH "sport = :$PORT" 2>/dev/null \
    | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2
}

manual_pid() {
  [ -f "$PID_FILE" ] || return 1
  local p
  p="$(tr -dc '0-9' < "$PID_FILE" 2>/dev/null)"
  [ -n "$p" ] || return 1
  kill -0 "$p" 2>/dev/null || return 1
  # 确认这个 pid 确实还是我们的服务端，避免 pid 被系统复用后误杀别人
  if [ -r "/proc/$p/cmdline" ]; then
    tr '\0' ' ' < "/proc/$p/cmdline" | grep -q 'src/index\.ts' || return 1
  fi
  echo "$p"
}

wait_health() {
  local i=0
  while [ "$i" -lt "$((HEALTH_TIMEOUT * 2))" ]; do
    if health_json >/dev/null 2>&1; then return 0; fi
    sleep 0.5
    i=$((i + 1))
  done
  return 1
}

show_ready() {
  local h uptime
  h="$(health_json)"
  uptime="$(printf '%s' "$h" | grep -o '"uptimeSec":[0-9]*' | cut -d: -f2)"
  ok "服务已就绪：$BASE_URL"
  [ -n "$uptime" ] && info "已运行 $((uptime / 60)) 分钟"
  info "本机访问  $BASE_URL/"
  if [ "$HOST" = "127.0.0.1" ] || [ "$HOST" = "localhost" ]; then
    info "只监听本机；外网走 nginx 反代（https://class.wangjiaqi.me）"
  fi
}

# ---------- 启动 ----------
do_start() {
  local m; m="$(mode)"
  info "模式：$m    端口：$PORT    环境：$NODE_ENV"

  if [ "$m" = "systemd" ]; then
    if unit_active; then
      warn "$UNIT 已经在运行，不重复启动"
      show_ready
      return 0
    fi
    info "systemctl start $UNIT"
    as_root systemctl start "$UNIT" || { err "启动失败，看日志：sudo journalctl -u $UNIT -n 50 --no-pager"; return 1; }
    if wait_health; then
      show_ready
    else
      err "进程起来了但健康检查没通过（${HEALTH_TIMEOUT}s）"
      err "看日志：sudo journalctl -u $UNIT -n 50 --no-pager"
      return 1
    fi
    return 0
  fi

  # ---- manual ----
  local pid; pid="$(manual_pid)"
  if [ -n "$pid" ]; then
    warn "已经在运行（pid $pid），不重复启动"
    show_ready
    return 0
  fi
  local owner; owner="$(port_owner)"
  if [ -n "$owner" ]; then
    err "端口 $PORT 已被 pid $owner 占用（不是本脚本起的），先停掉它或改 PORT"
    info "看是谁：ss -lntp | grep :$PORT"
    return 1
  fi
  local node; node="$(node_bin)"
  if [ -z "$node" ]; then
    err "找不到 node（需要 22.18+，推荐 24）"
    return 1
  fi
  mkdir -p "$DATA_DIR" || { err "建不了目录 $DATA_DIR"; return 1; }
  # 记下日志当前位置：失败时只回放这次启动新写的内容，
  # 否则会翻出上一次运行（甚至生产实例）的陈年日志，误导排查。
  local log_from=1
  if [ -f "$LOG_FILE" ]; then
    log_from=$(( $(wc -c < "$LOG_FILE") + 1 ))
  fi
  info "启动 $node src/index.ts（工作目录 server/）"
  (
    cd "$SERVER_DIR" || exit 1
    nohup "$node" src/index.ts >> "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
  ) || { err "拉起进程失败"; return 1; }

  pid="$(manual_pid)"
  if [ -z "$pid" ]; then
    err "进程没起来，看日志：tail -n 50 $LOG_FILE"
    rm -f "$PID_FILE"
    return 1
  fi
  if wait_health; then
    show_ready
    info "pid $pid，日志 $LOG_FILE"
    return 0
  fi

  # 探活超时：先分清「还活着但没起来」和「已经退出了」，
  # 这两种情况的下一步完全不同，糊成一句「启动失败」等于没说。
  if manual_pid >/dev/null; then
    err "进程在跑（pid $pid）但 ${HEALTH_TIMEOUT}s 内健康检查没通过"
    err "看日志：tail -n 50 $LOG_FILE"
    err "确认没问题再 ./stop.sh 收掉，或先 ./stop.sh 再查原因"
    return 1
  fi
  rm -f "$PID_FILE"
  err "进程启动后立刻退出了（多半是配置问题），这次的日志："
  printf '%s\n' "$C_DIM"
  tail -c "+$log_from" "$LOG_FILE" 2>/dev/null | tail -n 12 | sed 's/^/    /'
  printf '%s\n' "$C_END"
  return 1
}

# ---------- 停止 ----------
do_stop() {
  local m; m="$(mode)"
  info "模式：$m    端口：$PORT"

  if [ "$m" = "systemd" ]; then
    if ! unit_active; then
      warn "$UNIT 本来就没在运行"
      return 0
    fi
    info "systemctl stop $UNIT"
    as_root systemctl stop "$UNIT" || { err "停止失败"; return 1; }
    if unit_active; then err "还活着，试试 sudo systemctl kill -s SIGKILL $UNIT"; return 1; fi
    ok "已停止（开机自启仍然有效，下次 start 或重启机器会自动起来）"
    return 0
  fi

  # ---- manual ----
  local pid; pid="$(manual_pid)"
  if [ -z "$pid" ]; then
    rm -f "$PID_FILE"
    warn "没有本脚本启动的进程在跑"
    local owner; owner="$(port_owner)"
    [ -n "$owner" ] && info "不过端口 $PORT 被 pid $owner 占用着，可能是别的实例"
    return 0
  fi
  info "给 pid $pid 发 SIGTERM（服务端会先停止收新连接再关库）"
  kill -TERM "$pid" 2>/dev/null
  local i=0
  while [ "$i" -lt 40 ]; do          # 最多等 10 秒
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.25
    i=$((i + 1))
  done
  if kill -0 "$pid" 2>/dev/null; then
    warn "10 秒还没退，改用 SIGKILL"
    kill -KILL "$pid" 2>/dev/null
    sleep 0.5
  fi
  rm -f "$PID_FILE"
  if kill -0 "$pid" 2>/dev/null; then
    err "pid $pid 还在，手动处理：kill -9 $pid"
    return 1
  fi
  ok "已停止（pid $pid）"
}

# ---------- 重启 ----------
do_restart() {
  local m; m="$(mode)"
  if [ "$m" = "systemd" ]; then
    info "模式：systemd    systemctl restart $UNIT"
    as_root systemctl restart "$UNIT" || { err "重启失败"; return 1; }
    if wait_health; then show_ready; else
      err "健康检查没通过（${HEALTH_TIMEOUT}s），看日志：sudo journalctl -u $UNIT -n 50 --no-pager"
      return 1
    fi
    return 0
  fi
  do_stop || return 1
  do_start
}

# ---------- 状态 ----------
do_status() {
  local m; m="$(mode)"
  printf '%s服务状态%s\n' "$C_B" "$C_END"
  info "目录    $ROOT"
  info "模式    $m"
  info "地址    $BASE_URL（HOST=$HOST PORT=$PORT NODE_ENV=$NODE_ENV）"

  if [ "$m" = "systemd" ]; then
    if unit_active; then
      ok "$UNIT 运行中"
      systemctl show -p MainPID --value "$UNIT" 2>/dev/null | while read -r p; do
        [ -n "$p" ] && [ "$p" != "0" ] && info "主进程  pid $p"
      done
      info "开机自启 $(systemctl is-enabled "$UNIT" 2>/dev/null || echo unknown)"
      info "启动于  $(systemctl show -p ActiveEnterTimestamp --value "$UNIT" 2>/dev/null)"
    else
      warn "$UNIT 未运行"
    fi
  else
    local pid; pid="$(manual_pid)"
    if [ -n "$pid" ]; then
      ok "运行中（pid $pid，日志 $LOG_FILE）"
    else
      warn "未运行"
    fi
  fi

  if health_json >/dev/null 2>&1; then
    local h uptime
    h="$(health_json)"
    uptime="$(printf '%s' "$h" | grep -o '"uptimeSec":[0-9]*' | cut -d: -f2)"
    ok "健康检查通过 ${C_DIM}${h}${C_END}"
    [ -n "$uptime" ] && info "已运行 $((uptime / 60)) 分钟"
  else
    err "健康检查失败（$BASE_URL/healthz 不通）"
  fi

  local owner; owner="$(port_owner)"
  [ -n "$owner" ] && info "端口 $PORT 由 pid $owner 监听" || info "端口 $PORT 没有监听"
  # 退出码跟着健康检查走：0=健康，1=不健康，方便脚本里写 if ./status.sh; then
  if health_json >/dev/null 2>&1; then return 0; else return 1; fi
}

# ---------- 日志 ----------
do_logs() {
  local n="${1:-100}"
  if [ ! -f "$LOG_FILE" ]; then
    warn "还没有日志文件 $LOG_FILE"
    return 1
  fi
  info "跟踪 $LOG_FILE（Ctrl+C 退出）"
  tail -n "$n" -f "$LOG_FILE"
}

# ---------- 入口 ----------
CMD="${1:-status}"
shift || true
case "$CMD" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_restart ;;
  status)  do_status ;;
  logs)    do_logs "$@" ;;
  *)
    printf '用法：%s {start|stop|restart|status|logs}\n' "$0"
    printf '  或直接用根目录的 start.sh / stop.sh / restart.sh / status.sh\n'
    exit 2
    ;;
esac
