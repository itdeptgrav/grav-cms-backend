#!/usr/bin/env bash
# STAGE 5 — full training, then the final adapter on the SAME locked set, then the release gate.
# Refuses to start unless the stage-4 smoke gate said CONTINUE.
set -euo pipefail
WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
export JEV_MODEL_ROOT="$WS/models" HF_HUB_CACHE="$WS/models/hub" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
PKG="$WS/models/Open-Jev-2B/package"
RUN="$WS/runs/full"
node -e 'const g=require(process.argv[1]); if(!g.continue_to_full){console.error("stage 4 said STOP; refusing");process.exit(1)}' "$WS/reports/smoke-adapter/smoke-gate.json"
cd "$WS/open-jev"
python "$BUNDLE/train/grav_jev_train.py" --config "$BUNDLE/train/configs/full.json" --data "$BUNDLE/data/train-view" \
  --open-jev "$WS/open-jev" --init-package "$PKG" --baseline-report "$WS/reports/baseline-released-2b/report.json" \
  --output "$RUN" ${RESUME:+--resume "$RESUME"} 2>&1 | tee -a "$WS/runs/full.log"
bash "$BUNDLE/train/serve_eval.sh" "$RUN/export/grav-acc-routing-v2-full/checkpoint" final-adapter
node "$BUNDLE/gate.js" --baseline="$WS/reports/baseline-released-2b" --trained="$WS/reports/final-adapter" \
  && echo "RELEASE GATE: ACCEPTED as a candidate only — nothing is deployed" \
  || echo "RELEASE GATE: REJECTED — do not use this adapter"
