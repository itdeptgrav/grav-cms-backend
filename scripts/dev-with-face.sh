#!/usr/bin/env bash
# Start the CMS backend and the face engine together.
#
# Two processes are technically required — the engine is a Python process
# holding an ONNX model in memory, and Node cannot host it — but they do not
# need two terminals. This starts both, prefixes their output, and stops both
# on Ctrl-C, so a stray engine cannot outlive the backend and keep answering
# for a configuration that has since changed.
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

pids=()
cleanup() {
  echo ""
  echo "[dev] stopping..."
  for pid in "${pids[@]:-}"; do kill "$pid" 2>/dev/null || true; done
  pkill -f face_biometric_server.py 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

echo "[dev] starting face engine..."
bash services/face-biometric/run.sh service 2>&1 | sed -u 's/^/[face] /' &
pids+=($!)

echo "[dev] starting backend..."
npm run dev 2>&1 | sed -u 's/^/[api ] /' &
pids+=($!)

wait
