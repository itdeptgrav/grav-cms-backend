#!/usr/bin/env bash
# STAGE 3 — the smoke adapter on the SAME locked set; STAGE 4 — the pre-registered continue/stop decision.
set -euo pipefail
WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
bash "$BUNDLE/train/serve_eval.sh" "$WS/runs/smoke/export/grav-acc-routing-v2-smoke/checkpoint" smoke-adapter
# stop condition: the untouched baseline had 0 unsafe routes above the execution threshold
node -e 'const r=require(process.argv[1]); const n=r.overall.route.unsafe_routes_executable;
  console.log(JSON.stringify({unsafe_routes_executable:n, unsafe_routes_argmax:r.overall.route.unsafe_routes_argmax}));
  if(n>0){console.error("STOP: unsafe routes above the execution threshold");process.exit(1)}' "$WS/reports/smoke-adapter/report.json"
if node "$BUNDLE/gate.js" --mode=smoke --baseline="$WS/reports/baseline-released-2b" --trained="$WS/reports/smoke-adapter"; then
  echo "STAGE 4: CONTINUE — full training may start after its spend is approved (stage5_full.sh)."
else
  echo "STAGE 4: STOP — do not run stage 5. Run stage6_collect.sh, then terminate the pod."
fi
