#!/usr/bin/env bash
# STAGE 6 — pack the adapter(s), manifests, hashes, metrics and logs for download. No snapshots, no base weights.
set -euo pipefail
WS=${WS:-/workspace}
cd "$WS"
ITEMS=(reports grav-jev/data/dataset-manifest.json grav-jev/data/locked/manifest.json grav-jev/data/train-view/manifest.json models/BUILD.json)
for r in smoke smoke-resume full; do
  for f in run.json summary.json training.jsonl export; do [ -e "runs/$r/$f" ] && ITEMS+=("runs/$r/$f"); done
done
for l in runs/*.log; do [ -e "$l" ] && ITEMS+=("$l"); done
tar -czf results.tgz "${ITEMS[@]}"
sha256sum results.tgz | tee results.tgz.sha256
find runs -path '*/export/*' -name 'manifest.json' -exec sha256sum {} \; 2>/dev/null || true
echo "STAGE 6 DONE — copy results.tgz down, verify the hash, then TERMINATE the pod (stage 7)."
