# Open-Jev routing pilot — evaluation record

Date: 22 September 2026. Decision: [open-jev-cms-pilot.md](../decisions/open-jev-cms-pilot.md).

## Status

| Item | State |
|---|---|
| Adapter contract (`services/ai/openJev/openJevClient.js`) | Built; contract-tested against a hand-written HTTP double |
| GRAV-side attendance step (`attendanceToday.js`, `mongoPorts.js`) | Built; evaluated offline on fixtures |
| Assistant hook (`gravAssistant.chat` / `chatStreaming`) | Built, behind `GRAV_OPEN_JEV_PILOT_ENABLED` (off by default) |
| Held-out set + harness (`scripts/open-jev-pilot/`) | Built and run offline |
| **Live Open-Jev inference** | **BLOCKED** — no compatible host |
| **Live Ollama baseline (tool selection and end-to-end)** | **BLOCKED** — Ollama is running, but no model is installed |
| Mongo ports against real data | Not run; no live attendance was queried |

### Why live Open-Jev is blocked

The published requirements were checked on 22 Sep 2026 in the upstream README, `jev/client.py`, `jev/api.py`,
`jev/serving.py` and the 2B model card:

- The releases are LoRA adapters plus a scalar decision head and a calibration temperature. They need the pinned
  upstream weights (2B: `Qwen/Qwen3.5-2B@15852e8c…`) and Open-Jev's own loader.
- The model card says "A suitable GPU … [is] required". The README says the full GPU workflow targets Linux, and the
  server's `--device` defaults to `cuda:0`. Nothing mentions macOS or MPS.
- This development host is Darwin arm64 with no NVIDIA GPU. It has Python 3.14, and upstream says only "3.10 or newer".

Nothing was installed or downloaded. The harness probed `http://127.0.0.1:8791/v1/systemone` and got
`unavailable (network_error)`. No Open-Jev numbers are reported.

To unblock it, provision a Linux/CUDA host inside the approved deployment boundary and install from the repository.
Serve with `python -m jev.server --checkpoint … --device cuda:0`, then run the harness with `--live-open-jev` and
`GRAV_OPEN_JEV_URL`. Trying `--device mps` on this Mac is undocumented. It would also need about 4 GB or more of
downloaded weights, so it needs an explicit decision.

## Held-out set

`scripts/open-jev-pilot/heldout-cases.json` has 57 cases. They cover canonical and terse questions, typos, ambiguous
and near names, not-found and inactive employees, other dates, leave, group and self questions, and ordinary
questions. They also cover unclear questions, three unauthorised actors, a CEO, cross-company cases, stale syncs and
days with no sync. The fixtures are synthetic (`fixtures.js`), and the clock is fixed at 11:00 IST on 22 Sep 2026.

The thresholds (p ≥ 0.80, margin ≥ 0.30) were fixed before any model output and have not been tuned. **Caveat:** the
same author wrote the cases, GRAV's rules and the deterministic comparator. The cases are held out from the models
only, so the oracle and deterministic figures are optimistic.

## Results (offline run, Node v24.18.0, darwin arm64)

Run with `node scripts/open-jev-pilot/evaluate.js --live-open-jev --live-ollama`. Both live probes reported blocked.

### Intent routers, then GRAV's pilot step

| Router | Intent accuracy | Abstention | Mis-routes to attendance | End-to-end outcome accuracy | Wrong factual answers | Refusal violations | Out-of-scope reads | Routing p50 / p95 |
|---|---|---|---|---|---|---|---|---|
| oracle (labels) | 1.000 | 0.000 | 0 | 1.000 | 0 | 0 | 0 | ~0 ms |
| deterministic (keyword rules) | 0.930 | 0.035 | 0 | 1.000 | 0 | 0 | 0 | 0.026 / 0.074 ms |
| Open-Jev | blocked | blocked | blocked | blocked | blocked | blocked | blocked | blocked |

End-to-end latency with fixture ports: p50 0.07 ms and p95 0.36 ms (deterministic). This excludes Mongo I/O and any
model call, so it is **not** a production latency figure. The deterministic router's 4 intent misses (ord-03, ord-06,
ord-07 → `leave_today`; unc-03 → `other`) all ended in deferral to the assistant, so end-to-end outcomes were
unaffected.

### Existing tool selection (the baseline)

| Path | Scored cases | Tool-selection accuracy | Mean tools attached | p50 / p95 |
|---|---|---|---|---|
| regex fallback (`relevantTools`) | 52 | 0.769 | 2.0 | 0.004 / 0.20 ms |
| Ollama tool round (`chatWithTools`) | blocked: `qwen3:8b` not installed | — | — | — |
| existing end-to-end answer | blocked: needs the Ollama answer model | — | — | — |

The regex fallback misses the terse form. "Rishee present?", "RISHEE PRESENT TODAY???", Hinglish and typo forms get
`hr_daily_attendance` or nothing, not `hr_employee`. On the fallback path these questions depend on the whole-day
list, which is capped at 40 rows.

### Operating cost

Regex and deterministic routing need no model call. The Ollama and Open-Jev costs were not measured. Open-Jev needs a
dedicated CUDA host, which is a new fixed cost this pilot has not priced. **Latency and cost claims for Open-Jev are
unverified.**

## Findings in existing code (not changed by this pilot)

1. **`hr_employee` returns attendance on directory permission alone.** It is gated by `people.read.directory`, yet it
   returns `statusOnDate` and a 30-day attendance tally. The harness's synthetic `directory_only_A` actor (HR access
   and directory, no `attendance.read`) got `hr_employee` from the regex path. No current role template grants
   directory without attendance, so the gap is latent. The pilot path requires both capabilities through
   `authorizeHr`.
2. **`hr_employee` never reports check-out.** `attendanceOnDate` reads `employees.outTime`, but the DailyAttendance
   schema has `finalOut`.
3. **`resolveEmployeeByQuery` silently picks one match.** For "Priya" it returns the first active match rather than
   asking. For a typo it answers about the best fuzzy match. The pilot asks for clarification instead.
4. **No company scope on HR reads.** Employee and DailyAttendance carry no company field, so the live Mongo ports
   (like `hr_employee`) see the whole deployment. Cross-company isolation is verified only in fixtures.

## Adoption gate (unchanged)

Adopt only if a live run on a provisioned host shows Open-Jev beats the deterministic comparator or the existing
path on a defined outcome, with zero refusal violations and zero wrong factual answers. On the offline evidence,
GRAV's deterministic step plus keyword rules already route this narrow intent without a model. Open-Jev's case rests
on paraphrase coverage that has not been measured.
