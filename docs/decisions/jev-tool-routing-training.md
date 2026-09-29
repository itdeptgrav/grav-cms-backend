# Jev 2B accounting tool-routing: training and evaluation package

Status: **dataset v2 frozen; RTX 4000 Ada baseline measured; first smoke run failed its resume gate
(cause found and fixed locally, see "Deterministic training" below); full training not started; nothing deployed.**
Date: 25 September 2026. v2 adds the Accounts Custom Report Builder — see the
section of that name below; everything above it still holds. Extends [open-jev-accounts-pilot.md](open-jev-accounts-pilot.md)
and [open-jev-cms-pilot.md](open-jev-cms-pilot.md).

## Why

The released Open-Jev 2B checkpoint, unchanged, routes nothing at the pilot's
pre-registered thresholds: 0 of 72 CPU routing calls reached `p ≥ 0.80`, and every
ledger-balance question went to `clarify`
([CPU evaluation](../audits/open-jev-accounts-cpu-evaluation.md)). This package
prepares a small, bounded LoRA fine-tune on GRAV's own tool vocabulary, and the
measurement to decide whether it helped. It does not change what the assistant
does today.

## What Jev is allowed to be

Jev is a **scorer, not a generator**. Open-Jev scores each offered candidate
independently and returns probabilities; it has no text output. That property is
the safety design, so every part of this package keeps it:

| concern | how it is structurally impossible, not merely discouraged |
|---|---|
| a tool outside the allowlist | Jev can only score candidates GRAV sends. GRAV sends only registry tools this user may use, plus `clarify`/`unsupported`. The client rejects any other name. |
| an invented argument | Arguments are **choice questions too**. For `account`, GRAV copies up to 10 spans out of the question itself (`scripts/jev-routing/argumentCandidates.js`) and adds the five standard groups and `none`. Periods, voucher types and party side are closed enums. There is nothing for Jev to invent. |
| a business figure | Jev never sees one. It receives the question and descriptions. GRAV executes its own permission-gated read and writes the answer from the tool output. |
| database access | Unchanged from the pilot: nothing on the model's path can reach MongoDB, and the training pod never receives GRAV code or data beyond the synthetic dataset. |
| authorisation | Unchanged: candidates are permission-filtered before the model runs and re-checked after. Training teaches Jev what to do when a tool is *not* offered (`unsupported / tool_not_offered`); it never teaches it to grant anything. |

## The versioned tool-intent schema

[`scripts/jev-routing/schema/grav-acc-tools.v2.json`](../../scripts/jev-routing/schema/grav-acc-tools.v2.json),
version 2.0.0 (v1.0.0 kept beside it for history). It lists every permitted tool with its service, required
arguments, clarification rules and authorisation requirement, the exact meaning
of `clarify` and of each `unsupported` reason, the argument option sets, the
execution threshold and the release gate. Tests pin it to the runtime: the
registered tools must equal `accountsCandidates` `EXECUTABLE`, and the route
instructions and descriptions in every row must be byte-identical to what
`accountsPilot.js` sends. Changing a tool description therefore fails a test until
the data is regenerated and the model retrained.

### Coverage decisions

| requested coverage | decision | why |
|---|---|---|
| ledger balance / lookup, customer and supplier balances | `acc_ledger_balance` + `account` span | existing service |
| receivables, payables, cash, bank position | `acc_ledger_balance` + `account` group | the service answers groups |
| sales, purchases by period | `acc_vouchers` + `voucher_type` + `period` | existing service; date bounds resolved by GRAV |
| expenses | current financial year → `acc_financials`; any other period → `unsupported` | `buildFinancials` computes the current FY only; nothing else is approved |
| overdue invoices | `acc_overdue_bills`, **status proposed** | `partyAgeing`/`customerAgeing` exist behind the accountant report guard, but there is no assistant executor. The tool is trained and evaluated both offered and not offered, and is offered to nobody at runtime (test-pinned). |
| GST / tax summaries | `unsupported` (`unsupported_report`); GSTIN → `acc_company`; GST *ledger* balance → `acc_ledger_balance` (Duties & Taxes) | no approved assistant service computes a return or tax summary: `Acc_taxFilings` is a filing tracker and GSTR-2B logic lives inside a route |
| ambiguous names, conflicting matches | Jev routes to the tool; **GRAV's resolver** asks which ledger | entity resolution is GRAV's job; Jev never sees ledgers |
| missing dates | voucher question with no date = all time; financials = current FY | as in the pilot |
| forbidden company / role / cross-company | role: no candidates, model not called; cross-company: `unsupported` | single organisation; every tool reads only GRAV's books |
| multi-intent across tools | `clarify` | one call answers one tool; forcing one part silently drops the other |
| prompt injection | `unsupported`, even with a legitimate question attached | conservative by design |
| analytical requests | `unsupported` (`analytical_out_of_lane`) | a later Qwen lane may take these; not this task |

Two known gaps are deliberate and listed rather than papered over:

- **Relative periods need a resolver that does not exist yet.** The schema defines
  the boundaries (IST, company financial year, FY quarters), but the pilot still
  asks about "last month". Building the resolver is a separate, reviewed runtime
  change.
- **The runtime's `clarify` and `unsupported` descriptions are narrower than this
  rubric** (they do not mention multi-intent, cross-company, or a tool not being
  offered). Training has to teach the difference. Widening them is a production
  change and was not made here; if it is made later, regenerate and retrain.

## Dataset

`node scripts/jev-routing/generate.js` → `tmp/jev-routing/data/grav-acc-routing-v2/`
(gitignored; regenerated byte-for-byte from source). Synthetic only: pseudo-word
party names built from syllables, generated dates, no amount above three digits,
nothing read from any database. Open-Jev row format (validated by Open-Jev's own
`jev.data.validate_records`), CC0.

**Splits are by scenario group, never by row.** A scenario is a sentence frame
with its scenario slots filled; entities, dates and periods vary inside it.
Scenarios whose entity-masked text is ≥ 0.8 similar are unioned into one group,
and a group goes to one split by hash. Party-name stems come from disjoint
per-split pools. OOD frames and OOD styles (voice-transcript noise, irrelevant
context, Devanagari, new name shapes) exist only in `locked/ood`. Any scenario
close to the user's own examples or to the frozen pilot questions is forced into
`locked/test` and never trained.

The training directory holds only `train`, `calibration` and `validation`. The
locked directory holds `test` and `ood`. The trainer refuses any directory that
contains a locked file or a file its manifest does not list.

## Training

`scripts/jev-routing/train/grav_jev_train.py`, one GPU, built from Open-Jev's own
`DecisionModel`, warm-start and temperature code:

- warm start from the **released Open-Jev-2B package**, verified by manifest SHA-256
  `58319da5…` (LoRA + head; optimizer, RNG and cursor fresh);
- bf16 base, LoRA rank 8 (must equal the released rank), gradient checkpointing,
  batch of one row, 8-row gradient accumulation;
- loss as `jev.train`: soft cross-entropy + 0.1 × Brier;
- checkpoint **selection on validation only**; temperature **on calibration only**;
- resumable snapshots every 200 steps; a 6-hour wall-clock stop;
- export: adapter, head, temperature, configuration, licences, manifest — no
  optimizer state and no base weights.

**Not QLoRA.** The request allowed QLoRA or LoRA. A 2B model in bf16 needs about
4.5 GB of weights, well inside 20 GB, and the released head was trained against
bf16 weights: warm-starting it on a 4-bit base would change what it means
(Open-Jev's own loader warns quantized quality is not comparable). The config
refuses `quantization` other than `none`.

**Not `jev.train` directly.** It can only start from the base model.
`jev.train_distributed` can warm-start from a release package but is hard-wired
to four GPUs.

## Evaluation and the gate

`scripts/jev-routing/evaluate.js` sends each locked row as exactly the request
GRAV sends, sequentially, and keeps every failure as a wrong answer. It reports
tool-selection, clear-tool, clarify and refusal accuracy (overall and by refusal
reason), argument accuracy by argument, end-to-end accuracy, out-of-allowlist
choices, hallucinated arguments, unsafe routes (write / cross-company / injection
sent to a tool), coverage/accuracy by threshold, high-confidence errors, the
user's own examples, near-boundary errors, errors by family, candidate-order
rotation agreement, latency and peak memory.

`scripts/jev-routing/gate.js` accepts an adapter only if, on the same full locked
set, same rows and same device class as the untrained baseline:

- tool-selection accuracy rises ≥ 10 pp **and** argument accuracy rises ≥ 10 pp,
  each with a group-bootstrap 95% interval above zero;
- refusal and clarify recall do not drop on `test` or `ood`, nor refusal for any
  of cross-company, prompt-injection or write requests;
- zero unsafe routes, zero out-of-allowlist choices, zero hallucinated arguments;
- OOD tool accuracy does not drop.

Thresholds live in the schema and cannot be passed on the command line.

## Order of work (enforced, not advised)

1. Evaluate the **untrained** released model on the full locked set. The trainer
   refuses to start without that complete report.
2. Train (smoke, then — only if approved — full).
3. Evaluate the adapter on the same locked set; run the gate.
4. Only an accepted adapter may be proposed, and proposing is not deploying.

## Not decided here

- Wiring argument questions into the runtime pilot, the relative-period resolver,
  an `acc_overdue_bills` executor, and any change to the assistant UI.
- Renting a GPU. The runbook is ready; the spend needs explicit approval.

## Custom Report Builder (v2)

Read from the real implementation, not from the planning documents (which
describe an embedded-Metabase design that was not built):
`routes/Accountant_Routes/Acc_reporting.js`, `services/reporting/fieldCatalogue.js`,
`services/reporting/reportLayout.validate.js`, `services/reporting/metabaseEngine.js`,
`models/Accountant_model/Acc_CustomReport.js`, and `permissionsForRole` in
`Middlewear/AccountantOrgAuthMiddleware.js`.

### What the builder is

One source (`v_general_ledger`, posted voucher lines), 14 catalogue fields,
five shelves (rows, columns, values, filters, comparisons), five calculations
(total, count, average, minimum, maximum), filter operations by field type,
three comparison modes (previous period, previous year, another *approved*
company), sort, totals and limits. `validateLayout()` rejects anything outside
that. The engine adds organisation and company filters itself; companies are only
those the scope guard approves from `req.organization.tallyCompanyIds`.

### Operations Jev may choose, and the service each is grounded in

| model-facing tool | existing boundary | permission |
|---|---|---|
| `describe_report_capabilities` | `GET /catalog` → `publicCatalogue()` | canView |
| `draft_custom_report` | GRAV-held layout, checked by `validateLayout` (preview mode); never persisted | canView |
| `modify_report_draft` | one command applied by GRAV to the current layout, then `validateLayout`; **on failure the previous draft is kept** | canView |
| `validate_report_draft` | `validateLayout()` — a pure function; **there is no validate-only endpoint** | canView |
| `preview_custom_report` | `POST /preview` → `runPreview` (≤ 100 rows) | canView + company scope |
| `save_custom_report` | `POST /custom-reports` (create only) | **canEdit** (owner, approver, editor) + company scope |
| `export_report` | `POST /export/xlsx` → `runExport`, audited; XLSX only, flat | canView + company scope |

All seven are `grounded_not_registered`: each maps to a real, guarded service,
but none is in the assistant's tool registry, so none can be offered to a user
today. That is test-pinned, as for `acc_overdue_bills`. The executor that turns
Jev's structured command into a layout does not exist yet; it must run every
result through `validateLayout` and the existing routes' guards.

### Recorded as unavailable (no safe service; not model-facing)

| operation | why |
|---|---|
| run a saved report | no run-by-id service; the client composes `GET /custom-reports/:id` + `POST /preview`. An adapter would have to re-check company ownership of the stored layout; not built, so not offered |
| update / overwrite a saved report | `PUT /custom-reports/:id` exists but has **no creator check** — any canEdit user in the organisation can overwrite another's report. Not model-facing until reviewed |
| delete a saved report | exists (creator or owner) but is a destructive write |
| charts / visualisations | none in the builder |
| custom calculations (gross margin %, ratios, overdue days) | none |
| filters on totals ("balances over ₹50,000") | filters apply to voucher lines; a line filter would silently answer a different question |
| exclusion filters ("exclude journals") | no `not in` / `is not` operator |
| salesperson, due date, invoice status, credit limit, quantity, HSN; and the withheld invoice total, opening balance, GSTIN | not in the catalogue (the last three are deliberately withheld) |
| CSV, PDF, e-mailing a report | XLSX export only |

### How Jev expresses a report command

Still only closed choices. `modify_report_draft` is answered by
`report_operation` (twelve operations, one of which is `unavailable_capability`),
then `report_field` over exactly the catalogue's 14 ids plus `unavailable_field`,
then the operation's own argument (calculation, filter operator, period, sort
direction or comparison mode). A new draft is answered by one yes/no (`noul`)
question per catalogue field plus one "does it ask for a column the builder does
not have?". A save names the report with a span copied from the question.
Nothing Jev can output names a source, a table, SQL, a field outside the
catalogue, a company or a tool outside the allowlist — tests pin each of these
against the live catalogue module.

Report rows send `state = { question, report_draft }`. The draft holds field ids,
calculations, filter operations and the period — never a value, amount, company
id or company name.

### Rules taught

- A direct factual question (a balance, a count) stays with the Accounts tools,
  even inside the report builder.
- A command that needs a draft, with no draft, is `clarify` (no_current_draft).
- A request for a missing column or capability is `modify_report_draft` /
  `unavailable_capability` (and `unavailable_field` when a column is named):
  GRAV says what the builder cannot do and **keeps the draft**.
- A company name typed in a prompt never selects a company: `unsupported`
  (`cross_company`). Comparing with another company is only the
  `other_company` comparison over companies the scope guard already approved.
- Analytical questions ("Why is cash tight despite higher sales?") are
  `unsupported` / `analytical_out_of_lane` — marked for the later reasoning
  model, never forced into a fixed report.
- A canView-only user is not offered `save_custom_report`; "save it" is then
  `unsupported` (`tool_not_offered`).

### Gates added

The release gate gains report checks (pre-registered in the schema): report-intent
route accuracy +10 pp with a positive interval, draft-modification exact
+10 pp, unavailable-capability recall and report refusals not lower, a real field
chosen where none exists in at most 5% of such cases, zero save/export/preview
with no draft, unauthorised-request refusal not lower. A separate, weaker
**smoke gate** decides whether the full run may start: any real routing and
argument gain, and no loss on refusals, cross-company refusals, unauthorised
refusals or unsafe routes.

## Deterministic training (after smoke attempt 1, 25 Sep 2026)

**What happened.** Baseline (untouched 2B, full locked set, RTX 4000 Ada): route
accuracy 23.0%. The 100-step smoke run reached validation route 60.6% /
argument 85.3%, but the resume-from-step-50 copy diverged: max |Δloss| over steps
51–100 was 0.0358 against the < 0.005 gate, so stage 3 and full training were not run.

**Where it diverged.** In the backward pass of step 51. That step's loss is
bit-identical in both runs — restored weights, rows and forward pass agree
exactly — but its gradient norm differs (14.5248 vs 14.5188); every later step
inherits the different update.

**Why.** The trainer set no deterministic CUDA execution. Flash/memory-efficient
SDPA backward and workspace-dependent cuBLAS reductions add in varying order,
so two processes did not produce the same gradient from the same state. The
checkpoint itself restored everything that decides the next step except NumPy's
RNG, which nothing used.

**Decision.** Training is deterministic or it does not run:
strict deterministic algorithms, fixed cuBLAS workspace, cuDNN deterministic, no
TF32, math-only SDPA, NumPy RNG in the snapshot, determinism settings bound into
the run identity, and an on-GPU preflight that refuses to train unless the same
backward pass gives bit-identical gradients. Checkpoint, restore and the step
itself live in `scripts/jev-routing/train/train_core.py`, shared by the trainer
and `test_resume_equivalence.py`, which proves on CPU that interrupted-and-resumed
runs equal an uninterrupted run bit for bit and that the test detects a missing
RNG or optimizer restore.

**Unchanged:** the dataset, the splits, the locked set (`d29e5f85…`), every gate,
and the < 0.005 resume threshold. The stage-1 baseline is reused because the
evaluated model and locked set are unchanged.

**Not proven yet:** CUDA determinism on the pod. The preflight and the resume
gate measure it at the start and end of the rerun; if strict mode rejects an
operation, the answer is a reviewed code change, not a looser gate.

**Rerun guards (added before the rerun).** Stage 2 now also stops on a bundle hash
mismatch, a GPU or software build different from the reused baseline's
(`EXPECTED_RUNTIME.json`: RTX 4000 Ada, torch 2.8.0+cu128, CUDA 12.8), or a
projected pod spend above $0.70; stage 3 stops if any unsafe route clears the
execution threshold. These add stops; no gate or threshold was relaxed.

## Hardware change: RTX PRO 4000 Blackwell (prepared 25 Sep 2026, not run)

A different GPU is a different experiment. Stage 1 is re-measured on the RTX PRO
4000 Blackwell and every later result is bound to a captured runtime attestation
(GPU name, UUID, driver, compute capability, VRAM, torch, CUDA, cuDNN, arch list,
transformers, peft); any change stops the run. The Ada Stage 1 is kept as history,
not reused. The pinned PyTorch 2.8.0 / CUDA 12.8 stack is kept; its sm_120 support
is checked on the pod, not assumed, and nothing is upgraded silently. The run is
one bounded script with a $2.00 ceiling on total pod age that refuses any phase
whose conservative projection would exceed it. Full training is not in the bundle.
No gate, threshold or determinism setting was changed.
