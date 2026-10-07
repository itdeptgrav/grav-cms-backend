#!/usr/bin/env bash
set -euo pipefail

# Private development tunnel from the local CMS backend to Ollama on RunPod.
# The model API remains bound to loopback on both machines.

RUNPOD_QWEN_HOST="${RUNPOD_QWEN_HOST:-69.30.85.69}"
RUNPOD_QWEN_SSH_PORT="${RUNPOD_QWEN_SSH_PORT:-22108}"
RUNPOD_QWEN_SSH_KEY="${RUNPOD_QWEN_SSH_KEY:-${HOME}/.ssh/id_ed25519}"
RUNPOD_QWEN_LOCAL_PORT="${RUNPOD_QWEN_LOCAL_PORT:-11435}"
RUNPOD_QWEN_REMOTE_PORT="${RUNPOD_QWEN_REMOTE_PORT:-11434}"
RUNPOD_QWEN_CONTROL_SOCKET="${RUNPOD_QWEN_CONTROL_SOCKET:-/tmp/grav-qwen-${UID}.sock}"
RUNPOD_QWEN_MODEL="${RUNPOD_QWEN_MODEL:-qwen3:32b}"

ssh_base=(
  ssh
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=30
  -o ServerAliveCountMax=3
  -i "${RUNPOD_QWEN_SSH_KEY}"
  -p "${RUNPOD_QWEN_SSH_PORT}"
)

remote="root@${RUNPOD_QWEN_HOST}"

status() {
  if ! "${ssh_base[@]}" -S "${RUNPOD_QWEN_CONTROL_SOCKET}" -O check "${remote}" >/dev/null 2>&1; then
    echo "Qwen tunnel is stopped."
    return 1
  fi

  node -e '
    fetch(`http://127.0.0.1:${process.argv[1]}/api/tags`)
      .then(async response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        const names = (body.models || []).map(model => model.name);
        const expected = process.argv[2];
        if (!names.includes(expected)) throw new Error(`${expected} is not installed`);
        console.log(`Qwen tunnel is ready: ${expected}`);
      })
      .catch(error => {
        console.error(`Qwen tunnel is not healthy: ${error.message}`);
        process.exit(1);
      });
  ' "${RUNPOD_QWEN_LOCAL_PORT}" "${RUNPOD_QWEN_MODEL}"
}

case "${1:-start}" in
  start)
    if "${ssh_base[@]}" -S "${RUNPOD_QWEN_CONTROL_SOCKET}" -O check "${remote}" >/dev/null 2>&1; then
      status
      exit 0
    fi

    "${ssh_base[@]}" -fNT -M \
      -S "${RUNPOD_QWEN_CONTROL_SOCKET}" \
      -o ExitOnForwardFailure=yes \
      -L "127.0.0.1:${RUNPOD_QWEN_LOCAL_PORT}:127.0.0.1:${RUNPOD_QWEN_REMOTE_PORT}" \
      "${remote}"
    status
    ;;
  stop)
    if "${ssh_base[@]}" -S "${RUNPOD_QWEN_CONTROL_SOCKET}" -O exit "${remote}" >/dev/null 2>&1; then
      echo "Qwen tunnel stopped."
    else
      echo "Qwen tunnel was not running."
    fi
    ;;
  status)
    status
    ;;
  *)
    echo "Usage: $0 [start|stop|status]" >&2
    exit 2
    ;;
esac
