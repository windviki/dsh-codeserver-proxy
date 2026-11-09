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
#
# 端口布局（.env 可覆盖）：
#   /proxy/3100/  → proxy（监听 3100，浏览器唯一入口；token 认证由 proxy 自动完成）
#   127.0.0.1:3001 → dsh web（内部上游，不通过 code-server 暴露）
#
# 进程托管：start 用 setsid 启动 proxy —— 自建会话/进程组、脱离终端与父进程，
# 父 shell 或其所在会话被清理时不会被连带杀死（dsh web 是 proxy 的子进程，
# 一并受保护）。

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

# ---------- 配置（.env 可覆盖，默认与 .env 部署布局一致） ----------
PROXY_PORT=3100
UPSTREAM_PORT=3001
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

# 用绝对路径精确匹配本工程的 proxy.js，避免与 kimi 等其它 proxy 误匹配
proxy_pids() { pgrep -f "node $SCRIPT_DIR/proxy\.js$" || true; }
# 上游 dsh web 按「本服务配置的端口」精确匹配，避免误伤其它 dsh web 实例
dsh_pids()   { pgrep -f "dsh web --port $UPSTREAM_PORT" || true; }

start() {
  if is_up "$PROXY_PORT"; then
    info "proxy 已在运行（端口 $PROXY_PORT）"
  else
    info "启动 proxy（端口 $PROXY_PORT）…"
    # setsid：自建会话/进程组并脱离控制终端，父 shell 退出或其会话被清理时
    # 不受影响；重定向兜底标准流。无 setsid 的环境退化为 nohup。
    # env -u：剥掉父环境里残留的 PROXY_* 变量（proxy 规定真实环境变量优先于
    # .env，外部注入会把 BASE/PORT 改乱），保证 .env 是本服务唯一配置源。
    local launcher=(node)
    if command -v setsid >/dev/null 2>&1; then launcher=(setsid node); fi
    env -u PROXY_BASE -u PROXY_PORT -u PROXY_UPSTREAM_HOST \
        -u PROXY_UPSTREAM_PORT -u PROXY_SPAWN_DSH -u PROXY_DSH_TOKEN \
        "${launcher[@]}" "$SCRIPT_DIR/proxy.js" >>"$LOG_FILE" 2>&1 < /dev/null &
    echo $! > "$PID_FILE"
    for _ in {1..90}; do
      is_up "$PROXY_PORT" && break
      sleep 0.5
    done
    is_up "$PROXY_PORT" || die "proxy 未就绪，请查看 $LOG_FILE"
    # setsid 在少数环境（自身已是进程组组长）会 fork 出真正的服务进程，$! 记录的
    # 可能只是中间进程；就绪后用精确 pgrep 把真实 PID 写回，stop 时不会杀错。
    local real
    real="$(proxy_pids | head -1)"
    [[ -n "$real" ]] && echo "$real" > "$PID_FILE"
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
  local pid="" p c
  if [[ -s "$PID_FILE" ]]; then pid="$(cat "$PID_FILE")"; fi
  [[ -z "$pid" ]] && pid="$(proxy_pids | head -1)"

  # 先按父子关系精准停掉 proxy spawn 的 dsh web：正常路径下不依赖 proxy 的退出
  # 处理，proxy 被 SIGKILL 时也不会留下孤儿占着上游端口。
  for p in $(proxy_pids); do
    for c in $(pgrep -P "$p" 2>/dev/null || true); do
      case "$(tr '\0' ' ' < "/proc/$c/cmdline" 2>/dev/null || true)" in
        *"dsh web --port $UPSTREAM_PORT"*)
          kill "$c" 2>/dev/null && info "已停止 dsh web（pid $c）" || true
          ;;
      esac
    done
  done

  if [[ -n "$pid" ]]; then
    kill "$pid" 2>/dev/null && info "已向 proxy 发送 SIGTERM" || true
  fi
  rm -f "$PID_FILE"
  # 兜底：只清理精确匹配本工程 proxy.js 的残留进程
  pkill -f "node $SCRIPT_DIR/proxy\.js$" 2>/dev/null && info "已清理残留 proxy" || true

  for _ in {1..20}; do
    ! is_up "$PROXY_PORT" && ! is_up "$UPSTREAM_PORT" && break
    sleep 0.5
  done

  # 上游端口仍被占用 = 有孤儿 dsh web（proxy 未走正常退出路径时）。只杀真正
  # 占用该端口的进程；fuser 不可用时才退回端口匹配。
  if is_up "$UPSTREAM_PORT"; then
    local holders
    holders="$(fuser -n tcp "$UPSTREAM_PORT" 2>/dev/null | sed 's/^[^:]*://' | tr -s ' ' '\n' | grep -E '^[0-9]+$' || true)"
    if [[ -n "$holders" ]]; then
      for c in $holders; do
        kill "$c" 2>/dev/null && info "已清理占用端口 $UPSTREAM_PORT 的残留进程（pid $c）" || true
      done
    else
      pkill -f "dsh web --port $UPSTREAM_PORT" 2>/dev/null && info "已清理残留 dsh web" || true
    fi
  fi
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
