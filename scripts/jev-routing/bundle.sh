#!/usr/bin/env bash
# scripts/jev-routing/bundle.sh — assemble the upload for a GPU pod. Runs LOCALLY; uploads nothing.
#
#   bash scripts/jev-routing/bundle.sh   →  tmp/jev-routing/bundle/grav-jev.tar.gz (+ .sha256)
#
# Contents: the evaluator, metrics, gate, tool schema, trainer package and the
# generated dataset (train-view + locked). Nothing else from GRAV — no services,
# no models, no .env, no credentials, no database dump. The pod never needs
# GRAV's code or data to train or evaluate.
set -euo pipefail
# macOS: never let tar or cp carry AppleDouble (._*) files, resource forks or extended attributes
export COPYFILE_DISABLE=1

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
SRC="$ROOT/scripts/jev-routing"
DATA="$ROOT/tmp/jev-routing/data/grav-acc-routing-v2"
OUT="$ROOT/tmp/jev-routing/bundle"
STAGE="$OUT/grav-jev"

[ -f "$DATA/manifest.json" ] || { echo "generate the dataset first: node scripts/jev-routing/generate.js"; exit 1; }
node -e 'const m=require(process.argv[1]); if(!m.audit_passed){console.error("dataset audit did not pass");process.exit(1)}' "$DATA/manifest.json"

rm -rf "$STAGE" && mkdir -p "$STAGE/schema" "$STAGE/train/configs" "$STAGE/train/prompts" "$STAGE/data"
cp "$SRC/evaluate.js" "$SRC/metrics.js" "$SRC/gate.js" "$STAGE/"
cp "$SRC/schema/grav-acc-tools.v2.json" "$STAGE/schema/"
# RTX PRO 4000 Blackwell bounded experiment: one orchestrator, no full-training config, no Ada scripts.
cp "$SRC/train/grav_jev_train.py" "$SRC/train/train_core.py" "$SRC/train/runtime_attest.py" "$SRC/train/budget.py" \
   "$SRC/train/audit_validation_snapshot.py" \
   "$SRC/train/robustness_augmentation.py" "$SRC/train/generate_judged_paraphrases.py" \
   "$SRC/train/build_augmented_training_view.py" "$SRC/train/create_proxy_ood_experiment_config.py" \
   "$SRC/train/fresh_init.py" "$SRC/train/fresh_baseline.sh" "$SRC/train/measure_prompt_length.py" \
   "$SRC/train/setup_fresh_4b_pod.sh" "$SRC/train/HARDWARE_PROFILE_RTX6000_ADA.json" \
   "$SRC/train/snapshot_meta.py" "$SRC/train/test_grav_jev_train.py" "$SRC/train/test_resume_equivalence.py" \
   "$SRC/train/test_bounded_local.py" "$SRC/train/test_robustness_augmentation.py" \
   "$SRC/train/test_generate_judged_paraphrases.py" "$SRC/train/test_build_augmented_training_view.py" \
   "$SRC/train/test_create_proxy_ood_experiment_config.py" \
   "$SRC/train/requirements-train.txt" "$SRC/train/setup_pod.sh" "$SRC/train/serve_eval.sh" \
   "$SRC/train/bounded_smoke.sh" "$SRC/train/collect.sh" "$SRC/train/HARDWARE_PROFILE.json" \
   "$SRC/train/LOCKED_MANIFEST_SHA256" "$STAGE/train/"
# the locked set shipped must be the frozen one
[ "$(shasum -a 256 "$DATA/locked/manifest.json" | cut -d' ' -f1)" = "$(cat "$SRC/train/LOCKED_MANIFEST_SHA256")" ] || { echo "locked manifest differs from the frozen hash"; exit 1; }
cp "$SRC/train/configs/smoke.json" "$STAGE/train/configs/"   # full.json deliberately not shipped
cp "$SRC/train/configs/route-safety-balanced.json" "$STAGE/train/configs/"
cp "$SRC/train/configs/qwen35-4b-fresh-route-focus.json" "$STAGE/train/configs/"
cp "$SRC/train/configs/qwen35-4b-warm-route-safety-reasons.json" "$STAGE/train/configs/"
cp "$SRC/train/configs/qwen35-9b-fresh-route-focus.json" "$STAGE/train/configs/"
cp "$SRC/train/configs/qwen35-9b-warm-route-safety-and-labels.json" "$STAGE/train/configs/"
cp "$SRC/train/configs/qwen35-9b-proxy-ood-augmentation.json" "$STAGE/train/configs/"
cp "$SRC/train/prompts/semantic-paraphrase-teacher-v1.txt" "$SRC/train/prompts/semantic-paraphrase-judge-v1.txt" "$STAGE/train/prompts/"
cp -R "$DATA/train-view" "$DATA/locked" "$STAGE/data/"
cp "$DATA/manifest.json" "$STAGE/data/dataset-manifest.json"

# The RTX 4000 Ada Stage 1 baseline is historical evidence only (tmp/jev-routing/prior/); it is NOT shipped:
# Stage 1 is re-measured on the RTX PRO 4000 Blackwell by bounded_smoke.sh.

# strip platform junk, then refuse anything that should never travel
find "$STAGE" \( -name '._*' -o -name '.DS_Store' -o -name '__pycache__' -o -name '*.pyc' \) -prune -exec rm -rf {} +
if find "$STAGE" \( -name '*.safetensors' -o -name '*.bin' -o -name '*.pt' -o -name '*.pth' -o -name '*.gguf' -o -name '*.ckpt' \
     -o -name '.env*' -o -name '*.pem' -o -name '*.key' -o -name 'id_rsa*' -o -name 'training-checkpoints' -o -name 'runs' \) | grep -q .; then
  echo "weights, credentials or previous-run files in bundle; aborting"; exit 1
fi
# nothing in the bundle may start full training
if [ -e "$STAGE/train/configs/full.json" ] || ls "$STAGE/train"/stage*.sh >/dev/null 2>&1 || grep -rIl -E 'full\.json|stage5_full' "$STAGE/train"/*.sh; then
  echo "a full-training path is in the bundle; aborting"; exit 1
fi
if grep -rIl -E "(BEGIN [A-Z ]*PRIVATE KEY|MONGODB_URI|mongodb(\+srv)?://|JWT_SECRET|GEMINI_API_KEY|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|rpa_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,})" "$STAGE"; then
  echo "secret-looking content in bundle; aborting"; exit 1
fi

( cd "$STAGE" && find . -type f ! -name BUNDLE.sha256 -print0 | sort -z | xargs -0 shasum -a 256 > BUNDLE.sha256 )
TAR_FLAGS=()
tar --version 2>/dev/null | grep -q bsdtar && TAR_FLAGS=(--no-mac-metadata --no-xattrs --no-acls)
tar ${TAR_FLAGS[@]+"${TAR_FLAGS[@]}"} -C "$OUT" -czf "$OUT/grav-jev.tar.gz" grav-jev
( cd "$OUT" && shasum -a 256 grav-jev.tar.gz > grav-jev.tar.gz.sha256 )
if tar -tzf "$OUT/grav-jev.tar.gz" | grep -E '(^|/)(\._|\.DS_Store)' ; then echo "Apple metadata in archive; aborting"; exit 1; fi
du -h "$OUT/grav-jev.tar.gz"
cat "$OUT/grav-jev.tar.gz.sha256"
