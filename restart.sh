#!/usr/bin/env bash
# 重启 Vela 的开发进程：先清掉上一次没退干净的残留，再起 `pnpm app:dev`。
#
#   ./restart.sh            扫描 → 打印将要杀掉的进程 → 杀 → 启动
#   ./restart.sh -n         只扫描和打印，什么都不杀（--dry-run）
#
# 杀进程的判定是**正面举证**，不是「工作目录在这儿就归我管」。后者会误伤编辑器
# 和其他 AI 工具派生到本工作区的 node 子进程（实测踩过：cwd 相同的 codex
# app-server 子进程被一起杀了）。所以一个进程要被认定为残留，必须命中下面任一条：
#
#   A  可执行名就是 vela / Vela            —— 我们自己的 app 二进制，不会认错
#   B  命令行带着本项目路径，且是个开发工具（vite / tauri / pnpm / cargo）
#   C  占着 1420 端口                      —— tauri.conf.json 里钉死的 devUrl
#   D  命令行是 pnpm / vite / tauri 的形态，cwd 在本项目里，且路径不在 /Applications/ 下
#      （这条专门收 `node /opt/homebrew/bin/pnpm dev` 这种父进程已死、
#        命令行里根本没有项目路径的孤儿）
#   E  cargo / rustc 且 cwd 正好是 src-tauri
#
# 命中之后还要过两道闸：命令行撞上 DENY_RE（编辑器、容器、虚拟机、各家 AI 运行时）
# 的一律放过；自己和自己的祖先链一律放过——脚本就是从用户那个 shell 里跑起来的。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT=1420
SELF=$$
GRACE=5

TOOL_RE='^(node|pnpm|tauri|cargo|rustc|vela|Vela)$'
DEV_TOOL_RE='vite|tauri|pnpm|cargo'
DENY_RE='Qoder|\.qoder|Cursor|Code Helper|Visual Studio|JetBrains|WebStorm|Docker|WeChat|微信|Virtualization|ChatGPT|[Cc]odex|Copilot|Gemini|Claude'

DRY_RUN=0
if [[ "${1:-}" == '-n' || "${1:-}" == '--dry-run' ]]; then DRY_RUN=1; fi

cd "$ROOT"

is_self_or_ancestor() {
  local pid=$1 cur=$SELF
  while [[ -n "$cur" && "$cur" != 0 && "$cur" != 1 ]]; do
    if [[ "$cur" == "$pid" ]]; then return 0; fi
    cur="$(ps -o ppid= -p "$cur" 2>/dev/null | tr -d ' ')"
  done
  return 1
}

in_list() {
  local needle=$1 p
  for p in $2; do
    if [[ "$p" == "$needle" ]]; then return 0; fi
  done
  return 1
}

cwd_of() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1
}

LISTENERS="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true)"

pids=()
lines=()

# 返回 0 表示这是该清的残留，并把命中理由写进 REASON
classify() {
  local pid=$1 name=$2 cmd=$3 cwd
  REASON=''

  if [[ "$name" == vela || "$name" == Vela ]]; then
    REASON='A 本项目的 app 二进制'
    return 0
  fi
  if [[ "$cmd" == *"$ROOT"* ]] && grep -Eq "$DEV_TOOL_RE" <<<"$cmd"; then
    REASON='B 命令行带着本项目路径'
    return 0
  fi
  if in_list "$pid" "$LISTENERS"; then
    REASON="C 占着 $PORT 端口"
    return 0
  fi

  cwd="$(cwd_of "$pid")"
  if [[ "$ROOT" != "$cwd"* ]]; then return 1; fi

  if grep -Eq '(^|[/ ])(pnpm|vite|tauri)( |$)' <<<"$cmd" && [[ "$cmd" != *'/Applications/'* ]]; then
    REASON='D pnpm/vite/tauri 形态且 cwd 在本项目里'
    return 0
  fi
  if [[ "$name" == cargo || "$name" == rustc ]] && [[ "$cwd" == "$ROOT/src-tauri" ]]; then
    REASON='E cargo/rustc 且 cwd 在 src-tauri'
    return 0
  fi
  return 1
}

while read -r pid comm; do
  name="${comm##*/}"
  if [[ ! "$name" =~ $TOOL_RE ]]; then continue; fi
  if is_self_or_ancestor "$pid"; then continue; fi

  cmd="$(ps -o args= -p "$pid" 2>/dev/null || true)"
  if [[ -z "$cmd" ]]; then continue; fi
  if grep -Eqi "$DENY_RE" <<<"$cmd"; then continue; fi

  if ! classify "$pid" "$name" "$cmd"; then continue; fi

  pids+=("$pid")
  lines+=("$(printf '[%s] pid=%-7s %s\n      %s' "$REASON" "$pid" "$name" "$cmd")")
done < <(ps axo pid=,comm=)

if [[ ${#pids[@]} -eq 0 ]]; then
  echo "没有残留进程。"
else
  echo "发现 ${#pids[@]} 个残留进程："
  for line in "${lines[@]}"; do echo "  $line"; done

  if [[ $DRY_RUN -eq 1 ]]; then
    echo
    echo "（--dry-run：一个都没杀）"
    exit 0
  fi

  echo
  echo "发 SIGTERM……"
  kill "${pids[@]}" 2>/dev/null || true

  # 给足体面退出的时间，vite 和 cargo 都装了自己的信号处理
  alive=()
  for _ in $(seq "$GRACE"); do
    alive=()
    for pid in "${pids[@]}"; do
      if kill -0 "$pid" 2>/dev/null; then alive+=("$pid"); fi
    done
    if [[ ${#alive[@]} -eq 0 ]]; then break; fi
    sleep 1
  done

  if [[ ${#alive[@]} -gt 0 ]]; then
    echo "还没退，补 SIGKILL：${alive[*]}"
    kill -9 "${alive[@]}" 2>/dev/null || true
    sleep 1
  fi
fi

# 端口没让出来就别启动：vite 会以 exit 1 收场，`tauri dev` 跟着一起挂，
# 报错还是那句看不懂的 "Port 1420 is already in use"
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "✗ $PORT 还被占着，不敢擅自处理，请你自己看一眼：" >&2
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2 >&2
  exit 1
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "（--dry-run：不启动）"
  exit 0
fi

echo
echo "启动 pnpm app:dev（改了 src-tauri 的话会重编 Rust，稍等）……"
exec pnpm app:dev
