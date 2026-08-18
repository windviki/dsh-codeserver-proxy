#!/usr/bin/env bash
#
# dsh-codeserver-proxy 服务控制脚本
#
#   ./dsh-service.sh start    启动 dsh web + proxy
#   ./dsh-service.sh stop     停止 dsh web + proxy
#   ./dsh-service.sh restart  重启
#   ./dsh-service.sh status   查看状态
#   ./dsh-service.sh logs     跟踪 proxy 日志（Ctrl-C 退出）
#
# 说明：proxy 会自动 spawn `dsh web`（PROXY_SPAWN_DSH 默认开启），因此本脚本
# 只直接管理 proxy 进程，dsh web 由 proxy 拉起；stop 时 proxy 会带掉它 spawn
# 的 dsh，脚本再做一次兜底清理，保证两个服务都停止。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ---------- 配置（.env 可覆盖，默认与 proxy.js 一致） ----------
PROXY_PORT=3100
UPSTREAM_PORT=3000
if [[ -f .env ]]; then
  while IFS='=' read -r k v; do
    case "$k" in
      PROXY_PORT)          PROXY_PORT="$v" ;;
      PROXY_UPSTREAM_PORT) UPSTREAM_PORT="$v" ;;
    esac
  done < .env
fi

PID_FILE="$SCRIPT_DIR/.service.pid"
LOG_FILE="$SCRIPT_DIR/proxy.log"

info() { printf '[dsh-service] %s\n' "$*"; }
die()  { info "错误：$*"; exit 1; }

# 端口是否可访问
is_up() { curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$1/" >/dev/null 2>&1; }

# 精确匹配相关进程命令行
proxy_pids() { pgrep -f "node proxy\.js$" || true; }
dsh_pids()   { pgrep -f "dsh web --port" || true; }

start() {
  if is_up "$PROXY_PORT"; then
    info "proxy 已在运行（端口 $PROXY_PORT）"
  else
    info "启动 proxy（端口 $PROXY_PORT）…"
    nohup node proxy.js >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    for _ in {1..20}; do
      is_up "$PROXY_PORT" && break
      sleep 0.5
    done
    is_up "$PROXY_PORT" || die "proxy 未就绪，请查看 $LOG_FILE"
    info "proxy 就绪（pid $(cat "$PID_FILE")）"
  fi

  if is_up "$UPSTREAM_PORT"; then
    info "dsh web 已在运行（端口 $UPSTREAM_PORT）"
  else
    info "等待 proxy spawn dsh web（端口 $UPSTREAM_PORT）…"
    for _ in {1..30}; do
      is_up "$UPSTREAM_PORT" && break
      sleep 0.5
    done
    if is_up "$UPSTREAM_PORT"; then
      info "dsh web 就绪（端口 $UPSTREAM_PORT）"
    else
      info "dsh web 未就绪，请查看 $LOG_FILE"
    fi
  fi
}

stop() {
  info "停止 proxy…"
  if [[ -s "$PID_FILE" ]]; then
    kill "$(cat "$PID_FILE")" 2>/dev/null && info "已向 proxy 发送 SIGTERM" || true
    rm -f "$PID_FILE"
  fi
  # 兜底：proxy 退出时已 kill 它 spawn 的 dsh；这里清理任何残留进程
  pkill -f "node proxy\.js$" 2>/dev/null && info "已清理残留 proxy" || true
  pkill -f "dsh web --port" 2>/dev/null && info "已清理残留 dsh web" || true

  for _ in {1..20}; do
    ! is_up "$PROXY_PORT" && ! is_up "$UPSTREAM_PORT" && break
    sleep 0.5
  done
  info "已停止"
}

restart() { stop; start; }

status() {
  local pp dp
  pp=$(proxy_pids | tr '\n' ' ')
  dp=$(dsh_pids | tr '\n' ' ')
  printf 'proxy   : %s（端口 %s）\n' "${pp:-未运行}" "$PROXY_PORT"
  printf 'dsh web : %s（端口 %s）\n' "${dp:-未运行}" "$UPSTREAM_PORT"
}

logs() { tail -f "$LOG_FILE"; }

case "${1:-}" in
  start|stop|restart|status|logs) "$1" ;;
  *) echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
