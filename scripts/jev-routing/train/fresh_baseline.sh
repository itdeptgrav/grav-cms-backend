#!/usr/bin/env bash
# Fully evaluate a fresh initialization and bind the report to its manifest.
set -euo pipefail

WS=${WS:-/workspace}
PACKAGE=${1:?fresh initialization package}
LABEL=${2:?baseline report label}
ATTESTATION=${ATTESTATION:?accepted runtime attestation}

MANIFEST_SHA=$(sha256sum "$PACKAGE/manifest.json" | awk '{print $1}')
export PATH="$WS/jev-venv/bin:$PATH"
ATTESTATION="$ATTESTATION" bash "$WS/grav-jev/train/serve_eval.sh" \
  "$PACKAGE/checkpoint" "$LABEL" "${EVAL_TIMEOUT_SECONDS:-10800}"
printf '%s\n' "$MANIFEST_SHA" > "$WS/reports/$LABEL/initialization-manifest.sha256"

