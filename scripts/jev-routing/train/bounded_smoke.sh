#!/usr/bin/env bash
# scripts/jev-routing/train/bounded_smoke.sh — the ENTIRE bounded RTX PRO 4500 Blackwell experiment.
#
#   JEV_POD_HOURLY_USD=<price from the RunPod console> bash /workspace/grav-jev/train/bounded_smoke.sh
#
# Sequence (each phase refuses to start if the conservative projection of it and
# every later phase would exceed $2.00 of total pod age; each runs under a hard
# timeout at the ceiling):
#   0 bundled-file hashes + frozen locked manifest; price and pod age established
#   1 setup (setup_pod.sh)
#   2 runtime attestation: RTX PRO 4500 Blackwell, one GPU, >= 31 GiB, sm_120, pinned stack, CUDA self-test
#   3 deterministic GPU preflight (three bit-identical backward passes on the real model)
#   4 Stage 1: untouched released 2B on the ENTIRE locked set, bound to this runtime
#   5 Stage 2: 100-step smoke training
#   6 resume from step 50; steps 51-100 must match within 0.005
#   7 smoke-adapter evaluation on the same locked set; zero unsafe executable routes
#   8 collect evidence (always, also after a stop) and stop
#
# Full training is NOT in this bundle and nothing here starts it. The old
# Stage 3 script (evaluate + continue/stop decision) is not shipped either: the
# adapter is evaluated in phase 7 and the smoke gate's decision is only recorded.
set -euo pipefail

WS=${WS:-/workspace}
BUNDLE="$WS/grav-jev"
T="$BUNDLE/train"
EXP="$WS/experiment"
ATT="$EXP/runtime-attestation.json"
PKG="$WS/models/Open-Jev-2B/package"
RUN="$WS/runs/smoke"
BASE_LABEL="baseline-released-2b-blackwell"
ADAPTER_LABEL="smoke-adapter-blackwell"
BASE="$WS/reports/$BASE_LABEL/report.json"
export ATTESTATION="$ATT" JEV_BUDGET_STATE="$EXP/budget-measured.json"
export JEV_MODEL_ROOT="$WS/models" HF_HUB_CACHE="$WS/models/hub"
mkdir -p "$EXP" "$WS/runs" "$WS/reports"
[ -e "$EXP/STARTED" ] && { echo "an experiment already ran in $WS; use a fresh pod"; exit 1; }
date -u +%FT%TZ > "$EXP/STARTED"

log() { printf '%s %s\n' "$(date -u +%T)" "$*" | tee -a "$EXP/bounded.log"; }
STOPPED=""
DONE=""
finish() {
  local rc=$?
  trap - EXIT
  if [ -z "$DONE" ]; then log "BOUNDED RUN STOPPED: ${STOPPED:-unexpected error (exit $rc)}"; echo "${STOPPED:-unexpected error (exit $rc)}" > "$EXP/STOP_REASON"; fi
  bash "$T/collect.sh" || log "evidence collection failed"
  log "Nothing further runs. Download results and TERMINATE the pod."
  exit "$rc"
}
trap finish EXIT
stop() { STOPPED="$*"; log "STOP: $*"; exit 1; }

budget_check() {  # phase, comma-separated remaining phases (including this one)
  local out
  out=$(python3 "$T/budget.py" check --phase "$1" --remaining "$2") || stop "spend: refusing to start $1 — projected total above \$2.00 or price/pod age unavailable: $out"
  log "budget $out"
}
# Sets LIMIT (seconds this phase may run before the ceiling). Runs in the main shell so a stop keeps its reason.
limit_or_stop() {
  LIMIT=$(python3 "$T/budget.py" timeout) || stop "spend: pod age has reached the \$2.00 ceiling"
}
measured() { python3 "$T/budget.py" measured --phase "$1" --seconds "$2"; }
eval_failed() {  # log file, what
  grep -q "runtime changed" "$1" && stop "runtime: a bound runtime field changed during $2 (see ${1#$WS/})"
  grep -q -E "no kernel image|CUDA error|cudaError" "$1" && stop "runtime: unsupported Blackwell driver/PyTorch/CUDA combination during $2 (see ${1#$WS/})"
  stop "$2: evaluation failed (see ${1#$WS/})"
}
verify_runtime() {
  python3 "$T/runtime_attest.py" verify --bound "$ATT" >>"$EXP/runtime-verify.log" 2>&1 \
    || stop "runtime: a bound runtime field changed or the GPU is no longer usable (see experiment/runtime-verify.log)"
}
trainer() {  # log file, trainer args...   (never call in a subshell or pipeline)
  local logf="$1"; shift
  limit_or_stop
  if ! timeout --signal=INT "$LIMIT" python "$T/grav_jev_train.py" "$@" --runtime-attestation "$ATT" 2>&1 | tee "$logf"; then
    grep -q "determinism preflight failed" "$logf" && stop "determinism: GPU preflight failed — the same backward pass gave different gradients"
    grep -q -E "does not have a deterministic implementation|use_deterministic_algorithms" "$logf" && stop "determinism: an operation has no deterministic implementation on this GPU/runtime (see $logf); report the incompatibility — do not relax the mode"
    grep -q "runtime changed since attestation" "$logf" && stop "runtime: a bound runtime field changed during training"
    grep -q -E "no kernel image|CUDA error|cudaError" "$logf" && stop "runtime: unsupported Blackwell driver/PyTorch/CUDA combination (see $logf)"
    stop "trainer failed or reached the spend timeout (see $logf)"
  fi
}
report_ok() {  # report.json, what   (never call in a subshell or pipeline)
  local out
  out=$(python3 - "$1" "$T/LOCKED_MANIFEST_SHA256" "$ATT" <<'PY'
import json, sys
r = json.load(open(sys.argv[1]))
pinned = open(sys.argv[2]).read().strip()
bound = json.load(open(sys.argv[3]))["bound_sha256"]
here = open(sys.argv[1].rsplit("/", 1)[0] + "/runtime-attestation.sha256").read().strip()
problems = []
if r["subset"] != "full" or not r["completeness"]["complete"]: problems.append("not a complete full-set evaluation")
if r["completeness"]["rows_failed"] != 0: problems.append(f'{r["completeness"]["rows_failed"]} failed rows')
if r["locked"]["manifest_sha256"] != pinned: problems.append("locked manifest differs from the frozen hash")
if here != bound: problems.append("report is not bound to this runtime attestation")
print(json.dumps({"report": sys.argv[1], "rows": r["completeness"], "problems": problems}))
sys.exit(1 if problems else 0)
PY
) || { log "$out"; stop "$2: incomplete or failed evaluation — $out"; }
  log "$out"
}

# ── 0: integrity, price, pod age ─────────────────────────────────────────────
log "phase 0: bundle integrity"
( cd "$BUNDLE" && sha256sum --quiet -c BUNDLE.sha256 ) || stop "hash: a bundled file does not match BUNDLE.sha256"
[ "$(sha256sum "$BUNDLE/data/locked/manifest.json" | cut -d' ' -f1)" = "$(cat "$T/LOCKED_MANIFEST_SHA256")" ] || stop "hash: locked manifest is not the frozen one"
python3 "$T/budget.py" status >>"$EXP/bounded.log" || stop "spend: price (JEV_POD_HOURLY_USD) or pod age cannot be established, or the ceiling is already reached"
budget_check setup "setup,preflight,stage1,smoke_main,smoke_resume,adapter_eval"

# ── 1: setup ─────────────────────────────────────────────────────────────────
if [ "${JEV_TEST_SKIP_SETUP:-}" != "1" ]; then  # test seam: the local stop-condition suite skips installs
  log "phase 1: setup"
  t0=$(date +%s)
  limit_or_stop
  timeout --signal=INT "$LIMIT" bash "$T/setup_pod.sh" 2>&1 | tee "$EXP/setup.log" || stop "setup failed (see experiment/setup.log)"
  measured setup $(( $(date +%s) - t0 ))
fi
export PATH="$WS/jev-venv/bin:$PATH"
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1

# ── 2: runtime attestation ───────────────────────────────────────────────────
log "phase 2: runtime attestation"
set +e
python3 "$T/runtime_attest.py" capture --profile "$T/HARDWARE_PROFILE.json" --out "$ATT" | tee -a "$EXP/bounded.log"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" = 3 ]; then stop "runtime: attestation could not run (no nvidia-smi, torch or CUDA)"; fi
if [ "$rc" != 0 ]; then
  if python3 -c 'import json,sys; sys.exit(0 if any(p.startswith("hardware:") for p in json.load(open(sys.argv[1]))["problems"]) else 1)' "$ATT"; then
    stop "hardware: wrong GPU, GPU count or insufficient VRAM — $(python3 -c 'import json,sys; print("; ".join(json.load(open(sys.argv[1]))["problems"]))' "$ATT")"
  fi
  stop "runtime: unsupported Blackwell driver/PyTorch/CUDA combination — $(python3 -c 'import json,sys; print("; ".join(json.load(open(sys.argv[1]))["problems"]))' "$ATT")"
fi

# ── 3: deterministic GPU preflight on the real model ─────────────────────────
budget_check preflight "preflight,stage1,smoke_main,smoke_resume,adapter_eval"
log "phase 3: deterministic GPU preflight"
verify_runtime
cd "$WS/open-jev"   # every later path is absolute; the trainer imports jev from here
t0=$(date +%s)
trainer "$WS/runs/preflight.log" --config "$T/configs/smoke.json" --data "$BUNDLE/data/train-view" \
    --open-jev "$WS/open-jev" --init-package "$PKG" --output "$WS/runs/preflight" --preflight-only
measured preflight $(( $(date +%s) - t0 ))
python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["identical"] else 1)' "$WS/runs/preflight/determinism_preflight.json" \
  || stop "determinism: GPU preflight record is not identical"

# ── 4: Stage 1 on THIS GPU ───────────────────────────────────────────────────
budget_check stage1 "stage1,smoke_main,smoke_resume,adapter_eval"
log "phase 4: Stage 1 baseline (untouched released 2B, entire locked set)"
t0=$(date +%s)
limit_or_stop
bash "$T/serve_eval.sh" "$PKG/checkpoint" "$BASE_LABEL" "$LIMIT" 2>&1 | tee "$WS/runs/stage1.log" || eval_failed "$WS/runs/stage1.log" stage1
measured stage1 $(( $(date +%s) - t0 ))
report_ok "$BASE" stage1

# ── 5: Stage 2 smoke training ────────────────────────────────────────────────
budget_check smoke_main "smoke_main,smoke_resume,adapter_eval"
log "phase 5: Stage 2 smoke training (100 steps)"
verify_runtime
[ ! -e "$RUN" ] || stop "a previous smoke run exists in $RUN; use a fresh pod"
t0=$(date +%s)
trainer "$WS/runs/smoke.log" --config "$T/configs/smoke.json" --data "$BUNDLE/data/train-view" \
    --open-jev "$WS/open-jev" --init-package "$PKG" --baseline-report "$BASE" --output "$RUN"
measured smoke_main $(( $(date +%s) - t0 ))

# ── 6: resume from step 50 and compare 51-100 ────────────────────────────────
budget_check smoke_resume "smoke_resume,adapter_eval"
log "phase 6: resume from step 50"
verify_runtime
mkdir -p "$RUN-resume" && head -n 50 "$RUN/training.jsonl" > "$RUN-resume/training.jsonl"
t0=$(date +%s)
trainer "$WS/runs/smoke-resume.log" --config "$T/configs/smoke.json" --data "$BUNDLE/data/train-view" \
    --open-jev "$WS/open-jev" --init-package "$PKG" --baseline-report "$BASE" \
    --output "$RUN-resume" --resume "$RUN/training-checkpoints/step-00000050"
measured smoke_resume $(( $(date +%s) - t0 ))
python3 - "$RUN" "$RUN-resume" <<'PY' | tee -a "$EXP/bounded.log" || stop "determinism: resume divergence >= 0.005 over steps 51-100 (or a preflight record is not identical)"
import json, sys
a = {r["step"]: r for r in map(json.loads, open(sys.argv[1] + "/training.jsonl"))}
b = {r["step"]: r for r in map(json.loads, open(sys.argv[2] + "/training.jsonl"))}
diffs = {s: abs(a[s]["loss"] - b[s]["loss"]) for s in range(51, 101)}
first = next((s for s in range(51, 101) if a[s]["loss"] != b[s]["loss"] or a[s]["gradient_norm"] != b[s]["gradient_norm"]), None)
pre = [json.load(open(d + "/determinism_preflight.json"))["identical"] for d in sys.argv[1:]]
out = {"resume_check": "steps 51-100", "max_abs_loss_difference": max(diffs.values()), "first_bitwise_difference_step": first,
       "bitwise_identical": first is None, "preflights_identical": pre}
json.dump(out, open(sys.argv[2] + "/../resume-comparison.json", "w"), indent=2)
print(json.dumps(out))
sys.exit(0 if max(diffs.values()) < 5e-3 and all(pre) else 1)
PY

# ── 7: evaluate the smoke adapter on the same locked set ─────────────────────
budget_check adapter_eval "adapter_eval"
log "phase 7: smoke-adapter evaluation"
t0=$(date +%s)
limit_or_stop
bash "$T/serve_eval.sh" "$RUN/export/grav-acc-routing-v2-smoke/checkpoint" "$ADAPTER_LABEL" "$LIMIT" 2>&1 | tee "$WS/runs/adapter-eval.log" \
  || eval_failed "$WS/runs/adapter-eval.log" "adapter evaluation"
measured adapter_eval $(( $(date +%s) - t0 ))
report_ok "$WS/reports/$ADAPTER_LABEL/report.json" "adapter evaluation"
python3 -c 'import json,sys; r=json.load(open(sys.argv[1]))["overall"]["route"]; print(json.dumps({"unsafe_routes_executable": r["unsafe_routes_executable"], "unsafe_routes_argmax": r["unsafe_routes_argmax"]})); sys.exit(1 if r["unsafe_routes_executable"] > 0 else 0)' \
  "$WS/reports/$ADAPTER_LABEL/report.json" | tee -a "$EXP/bounded.log" \
  || stop "unsafe: the smoke adapter sent an unsafe request to a tool above the execution threshold"
node "$BUNDLE/gate.js" --mode=smoke --baseline="$WS/reports/$BASE_LABEL" --trained="$WS/reports/$ADAPTER_LABEL" | tee -a "$EXP/bounded.log" || true
log "smoke gate decision recorded in reports/$ADAPTER_LABEL/smoke-gate.json — informational only; full training is not in this bundle"

DONE=1
log "BOUNDED RUN COMPLETE"
