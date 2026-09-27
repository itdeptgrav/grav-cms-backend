# Open-Jev Accounts pilot (`jev_only_accounts`)

Status: built, off by default, **routing unmeasured**. Date: 25 September 2026.
Extends [open-jev-cms-pilot.md](open-jev-cms-pilot.md).

## What this mode is for

The HR pilot returns `null` whenever Jev is unsure, and the existing Ollama
round plus regex fallback answer instead. That is right for production and
useless for measurement: every question Jev fumbles is quietly rescued, and the
numbers we would publish would be the fallback's.

So `GRAV_OPEN_JEV_MODE=jev_only_accounts` removes the rescue. A supported
accounting question is routed by Jev or it is not answered, and the user is told
which happened. Neither regex routing nor Gemini/Ollama runs for a supported
question in this mode.

It is a development-and-evaluation mode. With the variable unset — the default —
every existing path is byte-for-byte what it was.

## Order of authority

1. **GRAV decides what may be offered.** `accountsCandidates(user)` reads the
   tool registry's own permission checks. Candidates are *derived*, not a second
   intent list: the names, descriptions and permissions all come from the
   registry. Before any model runs.
2. **Jev picks one of the offered names.** It receives the question and the
   tools' safe descriptions. It receives no ledger, voucher, balance, internal
   id, database handle or general tool-execution interface.
3. **GRAV re-authorises,** independently of anything Jev returned, by asking the
   registry again — then runs its own permission-gated read.
4. **GRAV writes the answer from what it read.** No second model.

The probability is recorded for evaluation. It is never shown to the user, never
treated as a fact, and never used to grant access.

## Candidates

Built from `authorizedTools(user)` ∩ the tools the pilot can answer
deterministically: `acc_ledger_balance`, `acc_financials`, `acc_vouchers` and
`acc_company`, plus the control choices `clarify` and `unsupported`, which are
not tools and read nothing.

The list is built in a fixed order rather than registry order, so the candidate
set Jev sees is identical on every run — a list that reshuffles between runs
makes two evaluations of the same model incomparable.

## The voucher answer

`buildVouchers` does all the counting, totalling and ranking; the pilot adds no
accounting calculation. Two arguments have to be resolved without a model, and
they are resolved very differently.

**The voucher type** comes from the accounting module's own `normVoucherType`
and `VOUCHER_ALIASES`, imported rather than copied — a second list of what
"invoice" means would drift, and the two would eventually disagree. The one
thing the pilot adds is a check the shared table cannot make: when a question
names *more than one* type, `normVoucherType` silently returns whichever comes
first in its table, so "sales and purchase totals" would quietly become a
sales-only answer. That is asked about instead.

**The date range** is honoured only when written out in full. `2026-04-01` is
passed through; "last month", "this quarter", "Q1" and "April 2026" are not.
They are resolvable in principle, but only by choosing a boundary — whose month,
whose quarter, whose timezone, calendar or financial year — that neither the
pilot nor `buildVouchers` defines. A guessed range produces a confident wrong
count, which is worse than a question. A date that does not exist
(`2026-02-30`) is also a question rather than a silent all-time answer: dropping
it would report a number nobody asked for.

Two things are deliberately *not* treated as vague dates. **No date at all**
means all of them, which is what the service does with no range. And
**"recent"/"latest"** ask for a ranking, not a period — the service returns the
most recent entries with no date filter, so there is no boundary to guess. An
earlier version had these clarifying, which turned ordinary questions with exact
answers into questions back.

**A genuine zero is an answer.** A filter matching nothing reports "No payment
vouchers were recorded", with the filter and any range stated — "there were
none" and "I could not look" are different facts.

## The ledger answer

The original question goes to the **existing** resolver (`buildLedgerLookup`)
unchanged — it does its own mishearing repair and proper-noun extraction, and a
paraphrase of ours would only lose signal. The answer is then written by GRAV,
with no second model, and carries five things, none optional:

| | why it is not optional |
|---|---|
| the exact matched ledger name | the user's wording may be a misspelling; naming what GRAV actually read makes a wrong match visible |
| the amount, exact | an accountant reconciling needs the figure, not "11.66 lakh" |
| the currency | read from the company profile, never assumed; a figure without a unit is not a figure |
| Dr or Cr | the sign is the meaning |
| the effective time | a running balance is only true as at a moment |

**It does not answer from a guess.** The existing resolver falls back to fuzzy
name matching and returns its best guesses in similarity order; taking the first
is how an assistant confidently reports the wrong company's balance. A fuzzy
result, several matches, or a group is offered back as a question naming the
candidates.

**A genuine zero is an answer.** A ledger that exists and nets to nothing is
reported as zero. "The account is empty" and "I could not find the account" are
different facts and an accountant needs to tell them apart. Nothing in the code
tests the amount for truthiness.

## Diagnostics

`meta.pilotDiagnostics` on `POST /api/ai/assistant/message`: candidates offered,
chosen tool, probability, margin, Jev latency, accounting-read latency, total
latency, and the ending (`answered` / `clarified` / `unsupported` / `failed`).

Shown outside production, or to a platform admin. Ordinary users never receive
it: it carries no accounting data, but a list of the tools a user was offered is
a map of what else exists to ask for. It contains no question and no amount.

**It reports `answered`, not `correct`.** The runtime cannot know whether an
answer is right; correctness is adjudicated against expected values by the
evaluation harness.

## Structural proofs

Pinned by `test/hr-ai/openJevAccountsPilot.test.js` (31 tests), driving the real
code with a hostile model:

- **Cannot reach MongoDB.** The request body is asserted to carry the question
  and the descriptions and nothing from the records — no ledger name from the
  read, no group, no amount, no id, no connection string, no query operator. The
  modules on the model's path are asserted not to require mongodb, mongoose or
  the accounting context.
- **Cannot execute an unoffered tool.** A model naming `acc_vouchers` — which the
  user *is* authorised for — is refused, and nothing is read. Two independent
  gates: the client validates the choice against the candidates GRAV sent, and
  the pilot checks again.
- **Cannot widen a permission.** A user without accounting access is offered no
  accounting candidate, so the model is not even called. And permission is
  re-checked after the model answers, from the registry.
- **Cannot write.** The only accounting calls in the executor are the three
  read-only context builders; no write verb appears. A write request routes to
  `unsupported`.

## Deployment-level isolation (CPU container, measured 25 September 2026)

The code-level proofs above say the model is never handed data. The container
adds a second, independent layer, checked against the running deployment rather
than assumed:

| checked | result |
|---|---|
| networks the model container joins | `open-jev_default` only — not GRAV's, not the reporting pilot's |
| published ports | `127.0.0.1:8791` only |
| credential environment variables | none (`GPG_KEY`, `TOKENIZERS_PARALLELISM`) |
| can it open MongoDB on the host? | connection refused |
| can it resolve a sibling database container? | no such host — it is not on that network |

And the request itself, captured from the real pilot path: **1481 bytes**,
containing the question and the six candidate descriptions. No ledger name from
the read, no group, no amount, no currency, no id.

## Measurement status

| | |
|---|---|
| GRAV's half (`--router=oracle`) | **43/43** cases behave as expected; clarification rate 13/43 |
| No-fallback (`--router=absent`) | **34/34** supported questions refused with a message; **0** answered by another path |
| Jev routing accuracy, P50/P95, high-confidence wrong routes | **measured on CPU 25 Sep 2026** — see [the evaluation](../audits/open-jev-accounts-cpu-evaluation.md) |

**Result in one line: 0 of 72 routing calls reached `p ≥ 0.80` (max 0.753), so
the pilot abstained on 100% of questions that should have routed.** Every
ledger-balance question — the main case — chose `clarify` instead, 38/38.
Vouchers routed correctly 87.5% of the time. No high-confidence wrong routes,
vacuously. ~21 s per routing call on CPU, cold and warm identical.

### CPU and GPU results are separate measurements

They are never averaged or presented as one number. A P95 from a CPU container
is not a slower version of the GPU figure; it is a different measurement of a
different deployment. See the corrected runtime gate in the parent decision:
`docker compose up -d --build open-jev-cpu` is an officially supported
deployment, so **CUDA is not an absolute inference requirement** — but it is
what a meaningful speed number requires.

| | what it establishes | what it does NOT establish |
|---|---|---|
| CPU container | the integration works end to end against the real checkpoint: routing, thresholds, evidence, refusals | anything about latency worth deploying on |
| Linux NVIDIA ≥8 GB VRAM | warmed P50/P95 and cold start as a deployment would see them | — |
| Darwin-native | nothing; unproven and not attempted | — |

To produce GPU numbers: provision a Linux NVIDIA host with at least 8 GB VRAM
serving the unmodified published 2B checkpoint at `GRAV_OPEN_JEV_URL`, then

```
node scripts/open-jev-pilot/evaluate-accounts.js --router=live --runs=3
```

The first run per case is discarded as cold. Thresholds (`0.80` probability,
`0.30` margin) were fixed before any model output existed and must not be tuned
after seeing held-out results.

## Not in this pilot

- Any fallback for a supported question. That is the point.
- A voucher executor.
- Exposure to ordinary users: off by default, and gated twice.
