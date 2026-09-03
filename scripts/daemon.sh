#!/usr/bin/env bash
# daemon.sh <name> [env KEY=VAL ...] -- <command...>
# Launch a long-running process detached from the caller's process group so it
# survives across shell-tool calls. Kills any prior instance of the same name.
set -u
NAME="$1"; shift
ENVS=()
while [[ "${1:-}" != "--" ]]; do
  ENVS+=("$1"); shift
done
[[ "${1:-}" == "--" ]] && shift
LOG="/tmp/${NAME}.log"
PID="/tmp/${NAME}.pid"
# Idempotent stop of a previous instance
if [[ -f "$PID" ]]; then
  OLD=$(cat "$PID" 2>/dev/null || true)
  [[ -n "$OLD" ]] && kill "$OLD" 2>/dev/null
  # stop the process group too
  pkill -f "uhmark ${NAME}" 2>/dev/null
  sleep 0.3
fi
env "${ENVS[@]}" setsid "$@" "uhmark ${NAME}" </dev/null >"$LOG" 2>&1 &
echo $! > "$PID"
sleep 1
echo "launched $NAME (pid $(cat "$PID")) -> $LOG"
exit 0
