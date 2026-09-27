#!/usr/bin/env bash
# scripts/jev-routing/train/collect.sh — pack the bounded experiment's evidence. Runs automatically at the
# end of bounded_smoke.sh (also after a stop); safe to run again by hand.
#
# Included: runtime attestation and verify log, budget ledger, Stage 1 report, preflight, both Stage 2
# runs (run.json, summary.json, training.jsonl = loss traces, determinism preflight, logs), resume
# comparison, step-50/step-100 snapshot METADATA (digests, shapes, optimizer counts, RNG digests,
# data cursor — no tensor values), adapter evaluation and smoke-gate record, export manifests and
# provenance, and experiment_summary.json (throughput, elapsed, peak VRAM, projected full-run cost).
# Excluded: every weight file (adapters, heads, snapshots' training_state.pt), base models, env, keys.
set -uo pipefail
WS=${WS:-/workspace}
T="$WS/grav-jev/train"
STAGE="$WS/results/blackwell-bounded"
rm -rf "$STAGE" && mkdir -p "$STAGE/snapshots"

copy() { for p in "$@"; do [ -e "$WS/$p" ] && mkdir -p "$STAGE/$(dirname "$p")" && cp -R "$WS/$p" "$STAGE/$p"; done; return 0; }
copy experiment
for r in reports/baseline-released-2b-blackwell reports/smoke-adapter-blackwell; do
  for f in report.json report.md rows.jsonl server.log runtime-attestation.json runtime-attestation.sha256 smoke-gate.json memory.json; do copy "$r/$f"; done
done
copy runs/preflight.log runs/smoke.log runs/smoke-resume.log runs/stage1.log runs/adapter-eval.log runs/resume-comparison.json
for r in preflight smoke smoke-resume; do
  for f in run.json summary.json training.jsonl determinism_preflight.json; do copy "runs/$r/$f"; done
  for d in "$WS/runs/$r"/export/*/; do
    [ -d "$d" ] || continue
    rel="runs/$r/export/$(basename "$d")"
    copy "$rel/manifest.json" "$rel/provenance.json"
  done
done
for snap in "$WS"/runs/smoke/training-checkpoints/step-00000050 "$WS"/runs/smoke/training-checkpoints/step-00000100 \
            "$WS"/runs/smoke-resume/training-checkpoints/step-00000100; do
  [ -f "$snap/training_state.pt" ] || continue
  name="$(basename "$(dirname "$(dirname "$snap")")")-$(basename "$snap").json"
  python "$T/snapshot_meta.py" "$snap" > "$STAGE/snapshots/$name" 2>>"$STAGE/snapshots/errors.log" || echo "metadata failed for $snap" >>"$STAGE/snapshots/errors.log"
done

python3 - "$WS" "$STAGE" <<'PY'
import json, os, sys
from pathlib import Path
ws, stage = Path(sys.argv[1]), Path(sys.argv[2])
def load(p):
    try: return json.loads(Path(p).read_text())
    except Exception: return None
def lines(p):
    try: return [json.loads(l) for l in Path(p).read_text().splitlines() if l.strip()]
    except Exception: return []
rate = float(os.environ.get("JEV_POD_HOURLY_USD", "nan"))
measured = load(ws / "experiment/budget-measured.json") or {}
main = lines(ws / "runs/smoke/training.jsonl")
resumed = [r for r in lines(ws / "runs/smoke-resume/training.jsonl") if r.get("step", 0) > 50]
def tput(rows):
    sec = sum(r.get("step_seconds", 0) for r in rows); tok = sum(r.get("input_tokens", 0) for r in rows)
    return round(tok / sec, 1) if sec else None
base = load(ws / "reports/baseline-released-2b-blackwell/report.json") or {}
adapter = load(ws / "reports/smoke-adapter-blackwell/report.json") or {}
try:
    uptime = float(Path("/proc/uptime").read_text().split()[0]); st = int(Path("/proc/1/stat").read_text().rsplit(")", 1)[1].split()[19])
    age = int(uptime - st / os.sysconf("SC_CLK_TCK"))
except Exception:
    age = None
tps = tput(main)
full = None
if tps and main:
    rows_per_step = 8
    tokens_per_row = sum(r["input_tokens"] for r in main) / (len(main) * rows_per_step)
    train_s = 2190 * rows_per_step * tokens_per_row / tps
    val_s = 11 * 600 * tokens_per_row / (3 * tps)          # forward-only validation, assumed 3x faster than training
    eval_s = measured.get("stage1") or 0                    # final adapter evaluation ≈ Stage 1
    hours = (train_s + val_s + eval_s + 600) / 3600
    full = {"assumptions": "2 epochs = 2,190 steps x 8 rows at the measured smoke throughput; 11 validations of 600 rows at 3x; one full evaluation; 10 min load/export",
            "training_hours": round(train_s / 3600, 2), "total_hours": round(hours, 2),
            "usd_at_configured_rate": round(hours * rate, 2) if rate == rate else None,
            "exceeds_6h_training_cap": train_s + val_s > 6 * 3600}
summary = {
    "attestation": (load(ws / "experiment/runtime-attestation.json") or {}).get("runtime"),
    "stop_reason": (ws / "experiment/STOP_REASON").read_text().strip() if (ws / "experiment/STOP_REASON").exists() else None,
    "phase_seconds": measured, "pod_age_seconds": age, "rate_usd_per_hour": rate if rate == rate else None,
    "spent_usd_conservative": round((age + 600) / 3600 * rate, 3) if age is not None and rate == rate else None,
    "throughput_tokens_per_second": {"smoke_main": tps, "smoke_resume_steps_51_100": tput(resumed)},
    "peak_vram_gib": {"training": max([r.get("peak_reserved_gib", 0) for r in main + resumed] or [0]),
                      "stage1_server_mib": (base.get("memory") or {}).get("peak_used_mib"),
                      "adapter_server_mib": (adapter.get("memory") or {}).get("peak_used_mib")},
    "resume_comparison": load(ws / "runs/resume-comparison.json"),
    "stage1": {"complete": (base.get("completeness") or {}).get("complete"), "route_accuracy": ((base.get("overall") or {}).get("route") or {}).get("tool_selection_accuracy")},
    "adapter": {"complete": (adapter.get("completeness") or {}).get("complete"), "route_accuracy": ((adapter.get("overall") or {}).get("route") or {}).get("tool_selection_accuracy"),
                "unsafe_routes_executable": ((adapter.get("overall") or {}).get("route") or {}).get("unsafe_routes_executable")},
    "projected_full_training": full,
}
(stage / "experiment_summary.json").write_text(json.dumps(summary, indent=2) + "\n")
print(json.dumps({k: summary[k] for k in ("stop_reason", "phase_seconds", "throughput_tokens_per_second", "spent_usd_conservative", "projected_full_training")}))
PY

# never ship weights or secrets
if find "$STAGE" \( -name '*.safetensors' -o -name '*.bin' -o -name '*.pt' -o -name '*.pth' -o -name '*.gguf' -o -name '*.ckpt' -o -name '.env*' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "weights or key files reached the results staging; refusing to pack"; exit 1
fi
if grep -rIl -E "(BEGIN [A-Z ]*PRIVATE KEY|AKIA[0-9A-Z]{16}|hf_[A-Za-z0-9]{30,}|rpa_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|RUNPOD_API_KEY=)" "$STAGE"; then
  echo "secret-looking content in results; refusing to pack (inspect the files listed above)"; exit 1
fi
( cd "$STAGE" && find . -type f ! -name RESULTS.sha256 -print0 | sort -z | xargs -0 sha256sum > RESULTS.sha256 )
tar -C "$WS/results" -czf "$WS/results-blackwell.tgz" blackwell-bounded
sha256sum "$WS/results-blackwell.tgz" | tee "$WS/results-blackwell.tgz.sha256"
echo "RESULTS READY: $WS/results-blackwell.tgz"
