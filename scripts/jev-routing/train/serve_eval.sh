#!/usr/bin/env bash
# scripts/jev-routing/train/serve_eval.sh — serve one checkpoint and score it on the FULL locked set.
#
#   ATTESTATION=<accepted attestation.json> bash serve_eval.sh <checkpoint dir> <label> [timeout seconds]
#
# The runtime is re-verified before and after; the report directory gets
# runtime-attestation.sha256 so later phases can prove it was measured on THIS runtime.
set -euo pipefail

WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
CKPT="$1"
LABEL="$2"
LIMIT="${3:-7200}"
PORT=${PORT:-8791}
: "${ATTESTATION:?ATTESTATION must name the accepted runtime attestation}"
export JEV_MODEL_ROOT="$WS/models" HF_HUB_CACHE="$WS/models/hub" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
OUT="$WS/reports/$LABEL"
[ -e "$OUT/report.json" ] && { echo "$OUT already holds a report; refusing to overwrite"; exit 1; }
mkdir -p "$OUT"

python3 "$BUNDLE/train/runtime_attest.py" verify --bound "$ATTESTATION" || { echo "runtime changed before evaluation"; exit 4; }
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["bound_sha256"])' "$ATTESTATION" > "$OUT/runtime-attestation.sha256"
cp "$ATTESTATION" "$OUT/runtime-attestation.json"

DEADLINE=$(( $(date +%s) + LIMIT ))
cd "$WS/open-jev"
python -m jev.server --checkpoint "$CKPT" --device cuda:0 --host 127.0.0.1 --port "$PORT" >"$OUT/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null || true' EXIT
for _ in $(seq 1 180); do
  curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null 2>&1 && break
  kill -0 $SERVER 2>/dev/null || { tail -40 "$OUT/server.log"; exit 1; }
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/v1/models" >/dev/null

LEFT=$(( DEADLINE - $(date +%s) ))
[ "$LEFT" -gt 0 ] || { echo "evaluation time limit reached before scoring"; exit 5; }
DEVICE="gpu-$(nvidia-smi --query-gpu=name --format=csv,noheader | head -1 | tr ' ' '-' )"
timeout --signal=INT "$LEFT" node "$BUNDLE/evaluate.js" \
  --locked="$BUNDLE/data/locked" \
  --endpoint="http://127.0.0.1:$PORT/v1/systemone" \
  --label="$LABEL" --device="$DEVICE" --subset=full \
  --out="$OUT" --memory-probe=nvidia-smi --rotations=100 --timeout-ms=120000

python3 "$BUNDLE/train/runtime_attest.py" verify --bound "$ATTESTATION" || { echo "runtime changed during evaluation"; exit 4; }
