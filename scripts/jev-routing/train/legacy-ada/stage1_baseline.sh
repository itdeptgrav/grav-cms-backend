#!/usr/bin/env bash
# STAGE 1 — the untouched released Jev 2B on the ENTIRE frozen v2 locked set. Run ON THE POD after setup_pod.sh.
set -euo pipefail
WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
PKG="$WS/models/Open-Jev-2B/package"
( cd "$BUNDLE/data/locked" && [ "$(sha256sum manifest.json | cut -d' ' -f1)" = "$(cat "$BUNDLE/train/LOCKED_MANIFEST_SHA256")" ] ) \
  || { echo "locked set is not the frozen one"; exit 1; }
bash "$BUNDLE/train/serve_eval.sh" "$PKG/checkpoint" baseline-released-2b
echo "STAGE 1 DONE → $WS/reports/baseline-released-2b/report.md"
