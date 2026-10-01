# Open-Jev Accounts pilot — live CPU evaluation

Date: 25 September 2026. Device: **CPU**. Published Open-Jev 2B checkpoint,
unchanged, no fine-tuning. Thresholds pre-registered and not altered:
`p ≥ 0.80`, `margin ≥ 0.30`.

**Headline: the pilot abstained on 100% of the questions that should have
routed. Not one of 72 routing calls reached the confidence threshold — the
highest top-probability observed anywhere in the run was 0.753.**

## What was run

`GRAV_OPEN_JEV_MODE=jev_only_accounts`, 36 cases × 2 runs = 72 live routing
calls. The five transport-fault cases are excluded (a fault cannot honestly be
simulated on top of an endpoint that is answering; they are proven separately
under `--router=absent`, where 34/34 supported questions were refused and none
was rescued by another path).

Per-case rows: `scripts/open-jev-pilot/accounts-rows-cpu.json`.

### Test machine

| | |
|---|---|
| Host | Apple M4, 10 cores (4 performance + 6 efficiency), 16 GiB, macOS 26.5.1, arm64 |
| Container runtime | Colima / Docker 29.5.2, VM linux/aarch64, **4 vCPU**, 5.77 GiB |
| Container limits | none set; inherits the VM |
| Model | `Qwen/Qwen3.5-2B` + `lora_decision_head`, official `open-jev-cpu` service |
| Serving config | `JEV_DEVICE=cpu`, `batch_size=8`, `max_length=4096`, `prefix_cache=off` |
| Peak container RAM | **2.56 GiB** of 5.77 GiB (44%), 263 samples |
| Sustained CPU | ~368% of 400% available — fully saturated, no headroom |

## 1. Routing confusion matrix

Rows: the tool the question should reach. Columns: what Jev chose.
72 calls, 36 cases × 2 runs.

| expected ↓ / chosen → | ledger | financials | vouchers | company | clarify | unsupported |
|---|---|---|---|---|---|---|
| `acc_ledger_balance` | **0** | 0 | 0 | 0 | 38 | 0 |
| `acc_financials` | 0 | **2** | 0 | 0 | 4 | 0 |
| `acc_vouchers` | 0 | 0 | **14** | 0 | 2 | 0 |
| `acc_company` | 0 | 0 | 0 | **2** | 2 | 0 |
| `clarify` | 0 | 0 | 0 | 0 | **4** | 0 |
| `unsupported` | 0 | 0 | 0 | 0 | 2 | **2** |

| tool | argmax accuracy |
|---|---|
| `acc_ledger_balance` | **0/38 — 0.0%** |
| `acc_financials` | 2/6 — 33.3% |
| `acc_vouchers` | 14/16 — 87.5% |
| `acc_company` | 2/4 — 50.0% |
| `clarify` | 4/4 — 100% |
| `unsupported` | 2/4 — 50.0% |

**Every ledger-balance question routed to `clarify`** — all 38 calls, 19 cases,
across plain English, Hinglish, abbreviations, misspellings, group questions and
zero-balance questions. The best top-probability on any ledger question was
0.680, and `clarify` won every one of them. This is the single largest finding:
the most common accounting question the pilot exists to answer is the one tool
Jev never selects.

Vouchers is the opposite: 87.5% argmax accuracy. The model has real signal on
some tools and none on the most important one.

## 2. Clarification and unsupported accuracy

| | |
|---|---|
| questions that genuinely need clarification, routed to `clarify` | **4/4 — 100%** |
| questions that are genuinely unsupported, routed to `unsupported` | **2/4 — 50%** (the other 2 chose `clarify`) |
| final outcome `clarified` delivered to a user | **0/72 — 0%** |
| final outcome `unsupported` delivered to a user | **0/72 — 0%** |

The last two rows are the important ones. Jev *chose* `clarify` 52 times, but
because no choice reached `p ≥ 0.80`, no clarification was ever shown. The user
sees "Jev could not confidently route this question" instead. A correct decision
that cannot clear the threshold produces the same output as a failure.

## 3. Abstention on questions that should route

**64/64 — 100%.** Every reason: `below_threshold`. None were timeouts, transport
failures or refused permissions.

Top-probability distribution across all 72 calls:

| min | P25 | P50 | P75 | P95 | max |
|---|---|---|---|---|---|
| 0.330 | 0.436 | 0.518 | 0.595 | 0.683 | **0.753** |

- **0 of 72 reached `p ≥ 0.80`.**
- 40 of 72 cleared `margin ≥ 0.30`, so **probability is the sole binding
  constraint**. Margin is not what is stopping this.
- When Jev picked the *right* tool (24 calls), its median confidence was 0.503
  and its best was 0.753 — still short.

## 4. High-confidence wrong routes

**None.** No call reached `p ≥ 0.80`, so by construction none could be a
high-confidence wrong route. The safety property held perfectly, but it held
vacuously: nothing was confident about anything.

## 5. Latency — CPU

| | n | P50 | P95 | max |
|---|---|---|---|---|
| cold (first call per case) | 36 | 21,309 ms | 25,737 ms | 32,504 ms |
| warm (second call) | 36 | 21,284 ms | 25,567 ms | 46,022 ms |
| total answer (warm) | 36 | 21,284 ms | 25,567 ms | — |
| accounting read | 0 | — | — | — |

**Cold and warm are indistinguishable** (21.3 s vs 21.3 s): the model is loaded
before the port opens, so there is no warm-up to pay for. What there is, is a
flat ~21 s of compute per routing decision.

The accounting read has no measurement because it never ran — every call
abstained before reaching it. From the deterministic runs, reads are sub-
millisecond against fixtures. **Routing is effectively the entire cost.**

Uncontended end-to-end, through `gravAssistant`'s own entry point:

| question | wall | chose | p | margin | outcome |
|---|---|---|---|---|---|
| "What is the balance of Bramble Supplies?" | 40,731 ms | `clarify` | 0.433 | 0.174 | refused |
| "how many sales vouchers" | 26,120 ms | `acc_vouchers` | 0.683 | 0.478 | refused |

The second is the whole problem in one line: correct tool, healthy margin,
refused on confidence.

## 6. Peak RAM and machine

See the table above. **2.56 GiB peak**, well inside an 8 GB budget. Memory is
not the constraint; wall-clock is.

## 7. Results by question kind

| kind | cases (calls) | behaved as expected | routed correctly |
|---|---|---|---|
| clear | 42 | 0/42 | 12/42 |
| ambiguous | 26 | 0/26 | 10/26 |
| unsupported | 4 | 0/4 | 2/4 |
| permission-limited | 4 | **4/4** | n/a |

Permission-limited is the only category that behaved correctly end to end — and
it does so **without the model being called at all**: an unauthorised user is
offered no accounting candidate, so no probability can route them. The
permission boundary does not depend on Jev working.

## 8. Do paraphrases reach the same tool?

| tool | n | agreement | spread |
|---|---|---|---|
| `acc_ledger_balance` | 22 | 100% | `clarify` × 22 |
| `acc_financials` | 6 | 67% | `clarify` × 4, `acc_financials` × 2 |
| `acc_vouchers` | 10 | 80% | `acc_vouchers` × 8, `clarify` × 2 |
| `acc_company` | 4 | 50% | `acc_company` × 2, `clarify` × 2 |

Ledger shows 100% agreement on the **wrong** answer — consistency and
correctness are different things, and this table is why both were asked for.

**Determinism: 36/36 cases chose identically across both runs.** The model is
deterministic at this temperature; a second run buys nothing. Variance is not
the problem.

## Two runs were voided before this one

Recorded because the cause is an operational property of the deployment, not a
setup error to be forgotten.

Open-Jev **does not cancel work when the HTTP client aborts**. A routing call
costs ~21 s; the pilot's transport ceiling was 30 s (1.4× headroom). One call
crossing 30 s left an orphaned computation on the CPU, the next call queued
behind it, and the backlog compounded — run 1 timed out on 38/38 cases, run 2
degraded to ~4 minutes per call. Neither measured the model.

Fix: `GRAV_OPEN_JEV_TIMEOUT_MS`'s ceiling raised from 30 s to 5 min, run at
120 s. **That is the transport bound, not a decision threshold** —
`minProbability` and `minMargin` were never touched and are printed on every
run. Evidence: `voided-run-timeout-cascade.log`.

**Deployment note for whoever runs this next:** the transport timeout must be
several times worst-case inference, because a timeout sheds no load — it adds
to it. GRAV's 1500 ms default would abort every CPU call and pile up orphaned
work until the process died.

## What this run does and does not establish

**Establishes:** the integration works end to end against the real checkpoint —
candidates built from live permissions, request carrying only the question and
six descriptions (1481 bytes, no record values), thresholds applied, refusals
correct, no fallback, no writes. And it establishes that at the pre-registered
thresholds this checkpoint routes nothing.

**Does not establish:** anything about latency on hardware anyone would deploy.
CPU and GPU are separate measurements and are not averaged or compared here. A
Linux NVIDIA host with ≥8 GB VRAM is still required for a speed figure.

**Does not establish** that the thresholds are wrong. They were pre-registered,
and the correct response to "nothing cleared the bar" is not to lower the bar.

## The decision this is for

Three readings, stated without a recommendation because the choice is not mine:

1. **Calibration, not capability.** Argmax was right on 24/72 calls and 87.5% on
   vouchers; the model has signal it cannot express above 0.75. If the
   probabilities are systematically compressed, the question is whether a
   calibration step is legitimate — and whether re-deriving a threshold against
   held-out results is still a held-out comparison.
2. **A genuine routing failure on the main case.** 0/38 on ledger balances is
   not a calibration artefact. `clarify` beat the correct tool every time, on
   every phrasing. No threshold change fixes that.
3. **Cost.** ~21 s per routing decision on CPU, against an accounting read that
   is sub-millisecond. Even at GPU speeds the model is being asked to do
   something the deterministic path already does in microseconds for these
   questions — the parent decision's original observation, now measured.
