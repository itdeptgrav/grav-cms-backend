#!/usr/bin/env bash
# STAGE 2 — 100-step smoke training from the released package, plus a resume check from the step-50 snapshot.
#
# Stops (non-zero exit, no further stage started) on:
#   bundle/hash mismatch · CUDA or hardware mismatch · projected pod spend above $0.70
#   deterministic GPU preflight failure · an operation with no deterministic implementation
#   resume divergence >= 0.005
# It never starts stage 3 or full training.
set -euo pipefail
WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
export JEV_MODEL_ROOT="$WS/models" HF_HUB_CACHE="$WS/models/hub" HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1
PKG="$WS/models/Open-Jev-2B/package"
RUN="$WS/runs/smoke"
BASE="$WS/reports/baseline-released-2b/report.json"
stop() { echo "STAGE 2 STOP: $*" >&2; exit 1; }

# ── spend guard: $0.70 at $0.28/h = 9,000 s of pod lifetime (PID 1 starts with the pod) ──
RATE_PER_HOUR=0.28
BUDGET_USD=0.70
BUDGET_SECONDS=$(python3 -c "print(int($BUDGET_USD / $RATE_PER_HOUR * 3600))")
# Age of PID 1 (the container's first process, started with the pod), from /proc; no ps needed.
# Fails closed: an unreadable clock stops the stage instead of silently reading 0.
# STAGE2_TEST_ELAPSED_FILE is a test seam only (the local stop-condition test drives the clock with it).
pod_elapsed() {
  if [ -n "${STAGE2_TEST_ELAPSED_FILE:-}" ]; then cat "$STAGE2_TEST_ELAPSED_FILE"; return; fi
  python3 -c "import os; u=float(open('/proc/uptime').read().split()[0]); st=int(open('/proc/1/stat').read().rsplit(')',1)[1].split()[19]); print(int(u - st / os.sysconf('SC_CLK_TCK')))" \
    || { echo "cannot read pod age from /proc" >&2; kill -TERM $$; }
}
remaining() { echo $(( BUDGET_SECONDS - $(pod_elapsed) )); }
spend_line() { python3 -c "e=$(pod_elapsed); print(f'pod time {e/3600:.2f} h, spend so far ~\${e/3600*$RATE_PER_HOUR:.2f} of \$$BUDGET_USD')"; }
echo "== $(spend_line)"
[ "$(remaining)" -gt 1800 ] || stop "less than 30 min of the \$$BUDGET_USD budget left before training; projected spend would exceed it"

# ── bundle integrity (again, not only at setup) ──
( cd "$BUNDLE" && sha256sum --quiet -c BUNDLE.sha256 ) || stop "bundle file hash mismatch"
[ "$(sha256sum "$BUNDLE/data/locked/manifest.json" | cut -d' ' -f1)" = "$(cat "$BUNDLE/train/LOCKED_MANIFEST_SHA256")" ] || stop "locked manifest is not the frozen one"

# ── same GPU and software build as the reused baseline ──
python3 - "$BUNDLE/train/EXPECTED_RUNTIME.json" <<'PY' || stop "CUDA or hardware mismatch (see above)"
import json, sys, torch
from importlib.metadata import version
want = json.load(open(sys.argv[1]))
have = {"gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None, "torch": torch.__version__,
        "cuda": torch.version.cuda, "transformers": version("transformers"), "peft": version("peft")}
bad = {k: (want[k], have[k]) for k in have if want[k] != have[k]}
print(json.dumps({"runtime": have, "mismatch": bad}))
sys.exit(1 if bad else 0)
PY
# Reuse the verified RTX 4000 Ada baseline shipped in the bundle when stage 1 was not re-run.
if [ ! -e "$BASE" ] && [ -f "$BUNDLE/prior/baseline-released-2b/report.json" ]; then
  mkdir -p "$WS/reports" && cp -R "$BUNDLE/prior/baseline-released-2b" "$WS/reports/"
fi
[ -e "$BASE" ] || { echo "run stage 1 first"; exit 1; }
node -e 'const r=require(process.argv[1]); const want=require("fs").readFileSync(process.argv[2],"utf8").trim();
  if(!r.completeness.complete||r.locked.manifest_sha256!==want){console.error("baseline is not complete on the frozen locked set");process.exit(1)}' \
  "$BASE" "$BUNDLE/train/LOCKED_MANIFEST_SHA256"
[ ! -e "$RUN" ] || { echo "$RUN exists from an earlier attempt; move it aside (old snapshots cannot be resumed by the fixed trainer)"; exit 1; }
mkdir -p "$WS/runs"
cd "$WS/open-jev"
train_or_stop() {  # $1 = log file; rest = trainer arguments
  local log="$1"; shift
  local left; left=$(remaining)
  [ "$left" -gt 0 ] || stop "budget exhausted"
  if ! timeout --signal=INT "$left" python "$BUNDLE/train/grav_jev_train.py" "$@" 2>&1 | tee "$log"; then
    grep -q "determinism preflight failed" "$log" && stop "deterministic GPU preflight failed: the same backward pass gave different gradients"
    grep -q -E "does not have a deterministic implementation|use_deterministic_algorithms" "$log" && stop "an operation has no deterministic CUDA implementation (see $log); needs a reviewed code change, not a looser gate"
    stop "trainer failed or hit the budget timeout (see $log)"
  fi
}
T0=$(date +%s)
train_or_stop "$WS/runs/smoke.log" --config "$BUNDLE/train/configs/smoke.json" --data "$BUNDLE/data/train-view" \
  --open-jev "$WS/open-jev" --init-package "$PKG" --baseline-report "$BASE" --output "$RUN"
SMOKE_SECONDS=$(( $(date +%s) - T0 ))
# the resume run repeats half the steps plus loading and one validation: project it before spending it
PROJECTED=$(( $(pod_elapsed) + SMOKE_SECONDS * 7 / 10 + 300 ))
echo "== smoke took ${SMOKE_SECONDS}s; projected pod time after the resume check: ${PROJECTED}s of ${BUDGET_SECONDS}s"
[ "$PROJECTED" -le "$BUDGET_SECONDS" ] || stop "projected spend for the resume check exceeds \$$BUDGET_USD"

echo "== resume check from step 50"
rm -rf "$RUN-resume" && mkdir -p "$RUN-resume"
head -n 50 "$RUN/training.jsonl" > "$RUN-resume/training.jsonl"
train_or_stop "$WS/runs/smoke-resume.log" --config "$BUNDLE/train/configs/smoke.json" --data "$BUNDLE/data/train-view" \
  --open-jev "$WS/open-jev" --init-package "$PKG" --baseline-report "$BASE" \
  --output "$RUN-resume" --resume "$RUN/training-checkpoints/step-00000050"
python - "$RUN" "$RUN-resume" <<'PY' || stop "resume divergence >= 0.005 over steps 51-100"
import json, sys
a = {r["step"]: r["loss"] for r in map(json.loads, open(sys.argv[1] + "/training.jsonl"))}
b = {r["step"]: r["loss"] for r in map(json.loads, open(sys.argv[2] + "/training.jsonl"))}
diff = max(abs(a[s] - b[s]) for s in range(51, 101))
tok = sum(json.loads(l)["input_tokens"] for l in open(sys.argv[1] + "/training.jsonl"))
sec = sum(json.loads(l)["step_seconds"] for l in open(sys.argv[1] + "/training.jsonl"))
print(json.dumps({"resume_check": "steps 51-100", "max_abs_loss_difference": diff, "training_tokens_per_second": round(tok / sec)}))
assert diff < 5e-3, "resumed run diverged from the original"
PY
python - "$RUN" "$RUN-resume" <<'PY' || stop "a determinism preflight record is not identical"
import json, sys
for d in sys.argv[1:]:
    p = json.load(open(d + "/determinism_preflight.json"))
    print(json.dumps({"run": d, "determinism_preflight_identical": p["identical"], "repeats": p["repeats"]}))
    assert p["identical"]
PY
echo "== $(spend_line)"
echo "STAGE 2 DONE — stage 3 is NOT started automatically. Collect (stage6_collect.sh) and decide."
