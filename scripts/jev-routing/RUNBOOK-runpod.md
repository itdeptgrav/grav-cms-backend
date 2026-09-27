# RunPod runbook — Jev 2B GRAV routing (Accounts + Custom Report Builder), dataset v2

**Nothing in this runbook has been executed. Do not start it without explicit
approval of the spend.** Planning price: **$0.28/hour**, one **RTX 4000 Ada
(20 GB)**. Check the live price when creating the pod.

The earlier plan to measure a baseline on the Mac CPU is **withdrawn**: a
partial CPU run (20 of 218 rows, dataset v1) is kept only as a diagnostic in
`tmp/jev-routing/reports/DIAGNOSTIC-INCOMPLETE-…` and must not be compared with
anything. Every before/after number comes from the same GPU, on the same frozen
locked set:

| frozen item | SHA-256 |
|---|---|
| locked set manifest (`data/locked/manifest.json`) | `d29e5f8562edd64b265a191138c4a94301382e7b121a9436e95249e7d27a70bc` |
| `locked/test.jsonl` | `974dbf512f78e87ccb6ef708267b1fc8ad50a6d8f7839811ceb0c758de0111c4` |
| `locked/ood.jsonl` | `26e1741dd032cf8a11c283726902077cfa0430802059f4102b022fcae1a30d6c` |
| training view manifest | `a315052dd82f12e355320a8e2a06d81b70ce84fd53e9f90289e365beaee0afa1` |
| released Open-Jev-2B package manifest | `58319da5c2a948a4645e46d9c982be44867d78779ea1c3bfb81b64867f58ef3a` |

`stage1_baseline.sh` refuses to run if the shipped locked manifest differs.

## CURRENT: bounded experiment on RTX PRO 4000 Blackwell (24 GB) — prepared, not run

This supersedes the RTX 4000 Ada rerun below. RTX PRO 4000 Blackwell is a new
hardware/runtime experiment: **Stage 1 is re-measured on it**; the Ada Stage 1
baseline is historical evidence only (`tmp/jev-routing/prior/`, not shipped).
Dataset, splits, locked set (`d29e5f85…`), evaluator, gates, determinism
safeguards, the < 0.005 resume gate and zero unsafe executable routes are unchanged.

| | |
|---|---|
| archive | `/Users/risheeray/grav-cms-backend/tmp/jev-routing/bundle/grav-jev.tar.gz` |
| bytes | 1,548,391 |
| SHA-256 | `aa213e9c627afece2c9ec8d6b5b1fbcf3e32a2dbf76f62f5c989ff5bead76011` |
| RunPod template | the same RunPod **PyTorch 2.8.0 / CUDA 12.8** template as the 25 Sep pod (torch `2.8.0+cu128`) — attestation stops on any other build; nothing is upgraded |
| GPU | **1 × RTX PRO 4000 Blackwell (24 GB)** — not the SFF edition |
| container disk | **≥ 30 GB** (40 GB recommended): base weights ≈ 4.6 GB, Python packages, three snapshots and reports < 1 GB |
| volume, ports, env | no volume; SSH only; no tokens |

**Blackwell compatibility.** RTX PRO 4000 Blackwell is compute capability 12.0
(sm_120). CUDA 12.8 builds of PyTorch 2.7+ ship sm_120 kernels, so the pinned
2.8.0+cu128 is expected to work with a ≥ R570 driver — **expected, not verified**:
no GPU is available locally. The pod proves or disproves it before any model
loads: attestation checks the driver, `torch.cuda.get_arch_list()` for `sm_120`,
and runs a deterministic CUDA self-test; then the real-model three-pass preflight
runs. If either fails, the run stops and the incompatibility is reported.

```bash
# 1. local → pod
scp -P <port> /Users/risheeray/grav-cms-backend/tmp/jev-routing/bundle/grav-jev.tar.gz root@<host>:/workspace/
# 2. on the pod: checksum, extract
cd /workspace && echo "aa213e9c627afece2c9ec8d6b5b1fbcf3e32a2dbf76f62f5c989ff5bead76011  grav-jev.tar.gz" | sha256sum -c - && tar -xzf grav-jev.tar.gz
# 3. on the pod, inside tmux: the whole bounded run (price = the pod's hourly rate shown in the RunPod console)
JEV_POD_HOURLY_USD=<price per hour> bash /workspace/grav-jev/train/bounded_smoke.sh
# 4. local ← pod, then TERMINATE the pod
scp -P <port> root@<host>:/workspace/results-blackwell.tgz root@<host>:/workspace/results-blackwell.tgz.sha256 tmp/jev-routing/pod-results/
```

`bounded_smoke.sh` runs: bundled-hash check → price and pod age → setup →
runtime attestation → deterministic GPU preflight → Stage 1 on this GPU (entire
locked set) → 100-step smoke → resume from 50, compare 51–100 → smoke-adapter
evaluation → evidence collection → stop. Collection also runs after any stop.
Full training is **not in the bundle** (no `full.json`, no full-run script) and the
trainer refuses a full config without `JEV_FULL_TRAINING_APPROVED=yes-full-training-approved`.
The smoke gate's continue/stop decision is recorded only.

**Spend ceiling $2.00 of total pod age.** Pod age = age of the container's PID 1
from `/proc` + 10 minutes for time billed before the container started; price =
`JEV_POD_HOURLY_USD`. Either missing → stop. Before setup, the preflight, Stage 1,
the smoke run and the resume run, the projection of *that phase and every later
phase* (estimates start at 2× the Ada measurements, then use this pod's own
measurements) plus a 5-minute collection reserve must fit, or the phase is not
started; every phase also runs under a `timeout` that ends at the ceiling.

| | expected | conservative (what the guard projects) |
|---|---|---|
| duration | ≈ 1.4–1.7 h (Ada-like speed, 15–25 min setup) | 2.86 h |
| cost | 1.4–1.7 h × price (e.g. $0.49–0.60 at $0.35/h) | 2.86 h × price |
| starts at all only if | — | price ≤ **$0.6985/h** (2.86 h × price ≤ $2.00) |

The ceiling covers the script's run; the pod keeps billing until you terminate it.

**Stop conditions** (each ends the run with `STOP: <class>: …`, collects evidence, starts nothing else):

| condition | detected by |
|---|---|
| archive hash mismatch | `sha256sum -c` before extraction |
| bundled-file hash mismatch / locked manifest changed | phase 0 |
| price or pod age cannot be established | phase 0 (`budget.py`, fails closed) |
| projected spend > $2.00 before setup, preflight, Stage 1, smoke or resume; elapsed pod age at the ceiling | `budget.py check` / `timeout` |
| wrong GPU (RTX 4000 Ada, RTX A4000, laptop, SFF, other), GPU count ≠ 1, VRAM < 23 GiB, compute capability ≠ 12.0 | attestation (`hardware:`) |
| unsupported Blackwell driver/PyTorch/CUDA (driver < 570, no sm_120 kernels, pinned versions differ, CUDA self-test fails or is not bit-identical) | attestation (`runtime:`) |
| any bound runtime field (GPU name, UUID, driver, compute capability, VRAM, torch, CUDA, cuDNN, arch list, transformers, peft) changes | re-verified before every phase and inside evaluations; bound into Stage 1 reports and training identity |
| deterministic preflight failure | three-pass bit-identical check on the real model |
| operation unsupported in strict deterministic mode | trainer error, reported as an incompatibility |
| incomplete or failed Stage 1 (or adapter) evaluation | complete, full subset, 0 failed rows, frozen locked hash, bound to this runtime |
| resume divergence ≥ 0.005 over steps 51–100 | phase 6 |
| any unsafe executable route | phase 7 |

**Evidence** (`results-blackwell.tgz`, with `RESULTS.sha256`): runtime attestation
and verify log, run log with every budget projection, Stage 1 report and rows,
preflight, both Stage 2 runs (run/summary/loss traces/preflight/logs), resume
comparison with the first bitwise-differing step, step-50/100 snapshot metadata
(digests, shapes, optimizer counts, RNG digests, data cursor — no tensor values),
adapter evaluation and smoke-gate record, export manifests/provenance, and
`experiment_summary.json` (throughput, per-phase time, peak VRAM, spend, projected
full-run cost). No weights, keys or environment.

**Local proof:** trainer unit 14/14; bounded-experiment unit 15/15; resume
equivalence 15/15 × 5 clean containers; dataset/evaluator/gate 34/34; 25/25
scripted stop scenarios against the bundled orchestrator (stub GPU, trainer,
server and pod clock); clean Linux extraction checks. GPU determinism and
Blackwell support are **not** proven locally.

---

## Smoke attempt 1 (25 Sep 2026): resume gate failed — cause and fix

Evidence: `tmp/jev-routing/pod-results/results.tgz` (SHA-256 `cb619591af45d3524dcf8529942989f13f33b7ae3746643b8eb96bff04a020d5`,
not modified). Stage 1 baseline complete; smoke training reached validation route
accuracy 60.6% / argument accuracy 85.3% at step 100; the resume-from-50 run
diverged (max |Δloss| over steps 51–100 = 0.0358 against the < 0.005 gate).
Stage 3 and full training were correctly not run.

**First point of divergence: the backward pass of step 51.** Step 51's loss is
bit-identical in both runs (1.2293725465424359): same restored weights, same
rows (token counts match on every step), same forward pass. Its gradient norm is
not (14.524821 vs 14.518844). Step 52 is the first step computed after that
different update, and the gap compounds from there.

**Cause:** the trainer requested no deterministic CUDA execution. SDPA was free to
use flash / memory-efficient attention, whose backward accumulates with atomics,
and cuBLAS ran without a fixed workspace, so two processes summed the same
gradients in different orders. Checkpoint contents were complete for what was
saved (adapter + head, AdamW state, Python/torch-CPU/CUDA RNG, data cursor by
step index; no scheduler or scaler exist); NumPy's RNG was not saved (unused,
now saved anyway).

**Fix** (`train/train_core.py`, used by the trainer):
strict `torch.use_deterministic_algorithms(True)`; `CUBLAS_WORKSPACE_CONFIG=:4096:8`
set before CUDA initialises; cuDNN deterministic, benchmark off; TF32 off; SDPA
limited to the math kernel; NumPy RNG saved/restored; the settings are part of the
run identity and a snapshot is refused if they differ; the data cursor is recorded
and checked; and a **determinism preflight** repeats the first step's backward
three times from identical state and refuses to train unless the gradients are
bit-identical.

**Local proof** (`train/test_resume_equivalence.py`, CPU, separate processes per
segment): resumed runs — mid-epoch, across an epoch boundary, and with two
interruptions — equal an uninterrupted run **bitwise** (every loss, every gradient
norm, final parameters and optimizer state); two negative controls (RNG not
restored, optimizer not restored) are detected; the preflight catches a
nondeterministic backward. 14/14, five consecutive runs.

**What the local test cannot prove:** that CUDA on the RTX 4000 Ada is now
deterministic — the Mac has no GPU, and CPU kernels were already deterministic.
That is exactly what the on-pod preflight checks before step 1, and what the
unchanged < 0.005 resume gate checks after step 100. Remaining risks:
- strict mode may reject an operation in Qwen3.5's torch fallback that has no
  deterministic CUDA kernel — the run then stops within minutes of loading, at
  cents of cost, and needs a code decision (not a looser gate);
- the math SDPA kernel and deterministic algorithms may slow training; stage 2
  prints the measured tokens/s;
- bitwise equality holds only on the same GPU model, driver, torch and CUDA build;
- the first smoke numbers (60.6% / 85.3%) came from nondeterministic kernels; the
  rerun will produce its own, slightly different numbers.

### Exact rerun on RTX 4000 Ada (superseded by the Blackwell experiment above; bundle no longer current)

| | |
|---|---|
| archive | `tmp/jev-routing/bundle/grav-jev.tar.gz` |
| bytes | 2,231,995 |
| SHA-256 | `b5ceb1635494ec3afd14f931c8694a1e923c9410c33a89a7bdb30be66f64186e` |
| verified | fresh Linux extraction: 32/32 file hashes, 30 expected files, no `._*`/`.DS_Store`/xattrs, no weights, credentials, secrets or previous-run files; locked manifest `d29e5f85…`; reused baseline complete 4,341/4,341 on it |

The stage-1 baseline is **reused** (shipped in `prior/`, re-verified by stage 2); do
not run stage 1. Create the pod with the **same image family as the first run**
(RunPod PyTorch, torch `2.8.0+cu128`, CUDA 12.8) on an **RTX 4000 Ada**: stage 2
stops on any other GPU or build (`train/EXPECTED_RUNTIME.json`).

```bash
# local → pod
scp -P <port> /Users/risheeray/grav-cms-backend/tmp/jev-routing/bundle/grav-jev.tar.gz root@<host>:/workspace/
# on the pod: verify, extract
cd /workspace && echo "b5ceb1635494ec3afd14f931c8694a1e923c9410c33a89a7bdb30be66f64186e  grav-jev.tar.gz" | sha256sum -c - && tar -xzf grav-jev.tar.gz
# on the pod, inside tmux: setup, then the corrected stage 2 (and nothing else)
bash /workspace/grav-jev/train/setup_pod.sh && bash /workspace/grav-jev/train/stage2_smoke_train.sh
```

Stage 2 does **not** start stage 3 or full training. Afterwards run
`bash /workspace/grav-jev/train/stage6_collect.sh`, download `results.tgz`, terminate the pod.

**Stop conditions (each makes stage 2 exit non-zero with `STAGE 2 STOP: …`; do not retry by relaxing anything):**

| condition | where it is enforced |
|---|---|
| bundle / hash mismatch | `sha256sum -c` of the archive (above), `setup_pod.sh`, and again at the start of stage 2 (all 32 files + frozen locked manifest) |
| CUDA or hardware mismatch | stage 2 compares GPU name, torch, CUDA, transformers, peft with `EXPECTED_RUNTIME.json` |
| projected spend above $0.70 | stage 2 reads pod age from `/proc` (fails closed): stops if < 30 min of the 2.5 h budget remain before training, if the resume check is projected past it, and each trainer call runs under `timeout` of the remaining budget |
| deterministic GPU preflight failure | trainer refuses to train unless 3 backward passes give bit-identical gradients; stage 2 re-checks both preflight records |
| unsupported deterministic operation | strict `use_deterministic_algorithms` raises; stage 2 reports it — needs a reviewed code change |
| resume divergence ≥ 0.005 | unchanged gate over steps 51–100 |
| unexpected unsafe executable routes | measured only when stage 3 evaluates the smoke adapter (not in this rerun): `stage3_smoke_eval.sh` stops if any unsafe route clears the execution threshold (baseline: 0), and the smoke gate stops if unsafe routes rise |

Each stop condition was exercised locally against the bundled script with a stub
trainer and pod clock (`tmp/jev-routing/verify/stage2_scenarios.sh`): 8/8 behave as
specified, and none starts a later stage. **GPU determinism itself is not proven
locally** — only the pod's preflight and resume gate can show it.

Throughput note for a later full-run decision: the first smoke run trained at
651 tokens/s (below the 700 tokens/s re-plan line for a full run), and math-only
SDPA may be slower. This does not threaten the stage-2 budget (the whole first
smoke run trained in ~16 min).

## Before renting (local, free)

```bash
node scripts/jev-routing/generate.js
node --test scripts/jev-routing/test/jevRouting.test.js
python3 -m unittest discover -s scripts/jev-routing/train -p 'test_*.py'
bash scripts/jev-routing/bundle.sh          # prints the archive SHA-256
```

Cap the account itself: prepay a small balance (e.g. $5) with no auto top-up.

## Create the pod

RTX 4000 Ada × 1 · RunPod PyTorch ≥ 2.8 / CUDA 12.x image · 40 GB container disk ·
no volume · **SSH only** (the model server binds to 127.0.0.1) · no environment
variables, no tokens (both Hugging Face repositories are public).

## Upload and set up (≈ 0.3 h)

```bash
scp -P <port> tmp/jev-routing/bundle/grav-jev.tar.gz root@<host>:/workspace/
ssh -p <port> root@<host>
cd /workspace && sha256sum grav-jev.tar.gz      # compare with bundle.sh output
tar -xzf grav-jev.tar.gz
bash /workspace/grav-jev/train/setup_pod.sh     # ends with SETUP OK
```

Setup verifies the bundle file by file, pins Open-Jev to `3308a15c…`, fetches the
base (`15852e8c…`) and the released package (`0c7aa498…`) through Open-Jev's own
verifying fetcher, checks the package manifest hash, installs a checksum-verified
Node 20 and runs the trainer's unit tests.

Run every stage inside tmux (`tmux new -s jev`) so a dropped SSH session does not
stop it.

## The seven stages

| # | command (on the pod) | what it does | expected | ceiling |
|---|---|---|---|---|
| 1 | `bash /workspace/grav-jev/train/stage1_baseline.sh` | untouched released Jev 2B on the **entire** locked set (4,341 rows) → `reports/baseline-released-2b/` | 0.15–0.3 h | 0.5 h |
| 2 | `bash /workspace/grav-jev/train/stage2_smoke_train.sh` | determinism preflight (bit-identical gradients or stop); 100 steps × 8 rows from the released package; validation at 0/50/100; snapshots at 50/100; resume-from-50 must reproduce steps 51–100 (< 0.005); prints measured training tokens/s. Reuses the shipped stage-1 baseline if stage 1 was not run on this pod | 0.25–0.45 h | 1.25 h |
| 3 | `bash /workspace/grav-jev/train/stage3_smoke_eval.sh` | smoke adapter on the **same** locked set → `reports/smoke-adapter/` | 0.15–0.3 h | 0.5 h |
| 4 | (printed by stage 3) | pre-registered smoke gate: routing **and** argument accuracy improve (95% interval above zero), refusal, cross-company and unauthorised refusal not lower, unsafe routes not higher → **CONTINUE** or **STOP** | 0 | 0 |
| 5 | `bash /workspace/grav-jev/train/stage5_full.sh` | **refuses unless stage 4 said CONTINUE**; 2,190 steps (2 epochs), validation every 200 steps on a fixed 600-row sample, early stop after 4 flat evaluations, hard stop at 6 h; then the final adapter on the **same** locked set and the release gate | 1.4–4.5 h | 6.5 h |
| 6 | `bash /workspace/grav-jev/train/stage6_collect.sh` | packs adapters (export only: adapter, head, temperature, config, licences, manifest), all manifests and hashes, metrics, gate results and logs into `results.tgz` + its SHA-256 | 0.1 h | 0.25 h |
| 7 | RunPod console → **Terminate** (or `runpodctl remove pod <id>`) | then confirm on the Pods page that nothing is running | — | — |

Stage 5 needs its own go-ahead: stage 4 saying CONTINUE is a precondition, not an approval.
If stage 4 says STOP, go straight to 6 and 7.

If the pod is interrupted during stage 5:

```bash
RESUME=/workspace/runs/full/training-checkpoints/step-000XXXXX bash /workspace/grav-jev/train/stage5_full.sh
```

Download (stage 6), locally:

```bash
mkdir -p tmp/jev-routing/pod-results
scp -P <port> root@<host>:/workspace/results.tgz tmp/jev-routing/pod-results/
shasum -a 256 tmp/jev-routing/pod-results/results.tgz     # must match the pod's results.tgz.sha256
```

Re-check both gates locally from the downloaded reports:

```bash
node scripts/jev-routing/gate.js --mode=smoke --baseline=<unpacked>/reports/baseline-released-2b --trained=<unpacked>/reports/smoke-adapter
node scripts/jev-routing/gate.js --baseline=<unpacked>/reports/baseline-released-2b --trained=<unpacked>/reports/final-adapter
```

## Time and money at $0.28/hour

| stage | expected hours | expected cost | ceiling hours | ceiling cost |
|---|---|---|---|---|
| setup + upload | 0.25–0.35 | $0.07–0.10 | 0.5 | $0.14 |
| 1 baseline | 0.15–0.30 | $0.04–0.08 | 0.5 | $0.14 |
| 2 smoke training + resume check | 0.25–0.45 | $0.07–0.13 | 1.25 | $0.35 |
| 3 smoke evaluation (+ 4 decision) | 0.15–0.30 | $0.04–0.08 | 0.5 | $0.14 |
| 5 full training + final evaluation | 1.40–4.50 | $0.39–1.26 | 6.5 | $1.82 |
| 6 collect + download | 0.10 | $0.03 | 0.25 | $0.07 |
| operator idle margin | — | — | 0.5 | $0.14 |
| **stop after stage 4** | **0.9–1.5 h** | **$0.25–0.42** | 3.5 h | **$0.98** |
| **all stages** | **2.3–6.0 h** | **$0.64–1.68** | **10.0 h** | **$2.80** |

Basis, measured locally with the real Qwen3.5-2B tokenizer on the frozen v2 data:
8,761 training rows, **≈ 6.9 M training tokens per epoch** (≈ 13.9 M for two);
locked set 4,341 rows / ≈ 3.4 M tokens; longest single prompt 246 tokens. Not
measured: the RTX 4000 Ada's throughput on this model. The ranges assume
1,000–3,500 training tokens/s and 5,000–15,000 inference tokens/s with Open-Jev's
torch reference kernels (the optional flash-linear-attention fast path is not
installed, so every evaluation uses identical kernels). Stage 2 prints the
measured rate: **below 700 tokens/s the full run would hit its 6 h cap — stop at
stage 4 and re-plan instead.** Storage is zero with no volume.
