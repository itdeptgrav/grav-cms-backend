# Jev 2B accounting + Custom Report Builder routing — training and evaluation package (dataset v2)

Decision record: [docs/decisions/jev-tool-routing-training.md](../../docs/decisions/jev-tool-routing-training.md).
GPU runbook: [RUNBOOK-runpod.md](RUNBOOK-runpod.md). Nothing here is read by the
running assistant.

## Files

| file | what it is |
|---|---|
| `schema/grav-acc-tools.v2.json` | versioned tool-intent schema 2.0.0: Accounts tools, the seven grounded report tools, unavailable report operations, report-builder vocabulary (pinned to `services/reporting/fieldCatalogue.js`), rubric, authorisation, release and smoke gates (`v1.json` kept for history) |
| `argumentCandidates.js` | deterministic span proposer — arguments are chosen from words copied out of the question |
| `lexicon.js` | synthetic names, slot fillers and sentence frames (English, Hinglish, short forms, typos, OOD styles) |
| `reportLexicon.js` | report-builder phrases → catalogue field ids (checked against the live catalogue at load), unavailable columns, report command frames |
| `reportGenerate.js` | report scenarios, draft-in-state rendering, report argument questions (choice and yes/no) |
| `generate.js` | dataset generator: scenario groups → near-duplicate clustering → group-level splits → Open-Jev rows |
| `audit.js` | build-failing checks: isolation, near-duplicates, frozen-set leakage, allowlist, privacy, balance, coverage |
| `evaluate.js` | locked-set evaluator against any Open-Jev endpoint (Node stdlib only; runs unchanged on the pod) |
| `metrics.js` | pure scoring: confusion, per-class, refusal by reason, arguments, end-to-end, unsafe routes, coverage curve, failure cases |
| `gate.js` | accept/reject a trained adapter against the untrained baseline, thresholds from the schema only |
| `bundle.sh` | assembles the pod upload (no GRAV services, secrets or data) |
| `train/grav_jev_train.py` | single-GPU LoRA fine-tune from the released Open-Jev-2B package; resume; compact export |
| `train/configs/{smoke,full}.json` | immutable configs pinned to data, package, base and Open-Jev hashes |
| `train/setup_pod.sh`, `train/serve_eval.sh`, `train/stage{1,2,3,5,6}_*.sh` | pod scripts, one per RunPod stage |
| `train/LOCKED_MANIFEST_SHA256` | the frozen locked-set hash stage 1 checks |
| `test/jevRouting.test.js`, `train/test_grav_jev_train.py` | tests |

## Local commands

```bash
# dataset (deterministic; ~15 s) → tmp/jev-routing/data/grav-acc-routing-v2/
node scripts/jev-routing/generate.js

# optional: Open-Jev's own validator over every split at once
python3 -c "import sys,json; sys.path.insert(0,'<open-jev checkout>'); from jev.data import read_split_directory as r, validate_records as v; d='tmp/jev-routing/data/grav-acc-routing-v2'; print(json.dumps(v(list(r(d+'/train-view'))+list(r(d+'/locked')))['splits']))"

# tests
node --test scripts/jev-routing/test/jevRouting.test.js
python3 -m unittest discover -s scripts/jev-routing/train -p 'test_*.py'

# evaluate any running Open-Jev endpoint on the locked set (full, or the CPU core subset)
node scripts/jev-routing/evaluate.js --locked=tmp/jev-routing/data/grav-acc-routing-v2/locked \
  --endpoint=http://127.0.0.1:8791/v1/systemone --label=<label> --device=cpu --subset=core \
  --out=tmp/jev-routing/reports/<label> --memory-probe=docker:open-jev-open-jev-cpu-1

# compare two FULL evaluations (release gate), or decide smoke → full
node scripts/jev-routing/gate.js --baseline=<dir> --trained=<dir>
node scripts/jev-routing/gate.js --mode=smoke --baseline=<dir> --trained=<dir>

# build the pod upload
bash scripts/jev-routing/bundle.sh
```

The tests live here rather than in `test/` because Jest collects `test/` and
cannot run `node:test` files.
