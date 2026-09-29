# Jev routing dataset v2 and GPU-readiness audit

Date: 25 September 2026. Dataset `grav-acc-routing-v2` (seed 20260925), tool
schema `grav.jev.acc-tools` 2.0.0. **No model has been evaluated on v2.** No GPU
was rented, no database was connected, nothing was committed.

## Frozen hashes

| item | SHA-256 |
|---|---|
| **locked evaluation set manifest** | `d29e5f8562edd64b265a191138c4a94301382e7b121a9436e95249e7d27a70bc` |
| locked `test.jsonl` | `974dbf512f78e87ccb6ef708267b1fc8ad50a6d8f7839811ceb0c758de0111c4` |
| locked `ood.jsonl` | `26e1741dd032cf8a11c283726902077cfa0430802059f4102b022fcae1a30d6c` |
| training view manifest | `a315052dd82f12e355320a8e2a06d81b70ce84fd53e9f90289e365beaee0afa1` |
| `train.jsonl` / `calibration.jsonl` / `validation.jsonl` | `3b1d4ffbb387de0b…` / `1214fa164440ef23…` / `8b141bb2dffbab9a…` |
| tool schema v2 | `7798f25eeb7b8642487a0e2c17ce67c5a597fe2c77848281a635f9040ea48f74` |

Pinned in `scripts/jev-routing/train/LOCKED_MANIFEST_SHA256` and both training
configs; a test fails if regeneration produces anything else.

## Splits and statistics

Splits are by **scenario group** (a sentence frame with its scenario slots;
names, dates, periods, drafts and styles vary inside it), after unioning groups
whose entity-masked text is ≥ 0.8 similar. Within each gold route label, groups
are dealt to splits by hash so every label reaches every split. OOD frames and
styles exist only in `ood`; party-name stems come from disjoint per-split pools.
23 groups echoing the user's own examples or the frozen pilot questions
were forced into `test` and never trained.

|  | train | calibration | validation | test | ood | total |
| --- | --- | --- | --- | --- | --- | --- |
| scenario groups | 1016 | 129 | 132 | 198 | 212 | 1686 |
| rows | 8761 | 1058 | 1152 | 1812 | 2529 | 15312 |
| route `acc_ledger_balance` | 657 | 65 | 78 | 236 | 228 | 1264 |
| route `acc_vouchers` | 608 | 70 | 74 | 102 | 207 | 1061 |
| route `acc_financials` | 156 | 17 | 16 | 42 | 32 | 263 |
| route `acc_company` | 106 | 10 | 22 | 17 | 26 | 181 |
| route `acc_overdue_bills` | 102 | 10 | 15 | 15 | 36 | 178 |
| route `describe_report_capabilities` | 36 | 4 | 6 | 9 | 4 | 59 |
| route `draft_custom_report` | 132 | 20 | 19 | 22 | 52 | 245 |
| route `modify_report_draft` | 206 | 25 | 25 | 43 | 27 | 326 |
| route `validate_report_draft` | 54 | 11 | 6 | 6 | 5 | 82 |
| route `preview_custom_report` | 53 | 3 | 9 | 13 | 4 | 82 |
| route `save_custom_report` | 43 | 6 | 6 | 12 | 5 | 72 |
| route `export_report` | 50 | 4 | 3 | 16 | 5 | 78 |
| route `clarify` | 390 | 44 | 44 | 71 | 32 | 581 |
| route `unsupported` | 817 | 100 | 105 | 155 | 135 | 1312 |
| argument `account` | 871 | 96 | 109 | 257 | 269 | 1602 |
| argument `comparison_mode` | 18 | 0 | 2 | 4 | 4 | 28 |
| argument `filter_operator` | 12 | 6 | 2 | 2 | 2 | 24 |
| argument `party_side` | 254 | 32 | 32 | 40 | 76 | 434 |
| argument `period` | 782 | 99 | 108 | 142 | 263 | 1394 |
| argument `report_calculation` | 36 | 4 | 4 | 6 | 4 | 54 |
| argument `report_field` | 214 | 24 | 24 | 34 | 26 | 322 |
| argument `report_name` | 69 | 6 | 7 | 13 | 5 | 100 |
| argument `report_operation` | 242 | 30 | 32 | 52 | 34 | 390 |
| argument `sort_direction` | 26 | 2 | 2 | 2 | 8 | 40 |
| argument `voucher_type` | 562 | 70 | 72 | 96 | 200 | 1000 |
| argument `report_includes:*` (15 yes/no each) | 2265 | 300 | 330 | 405 | 840 | 4140 |

Candidate sets on route rows: with_proposed 1663, registered 1954, subset1 167, subset0 158, report_editor 1276, report_viewer 566.
Refusal/clarify reasons: missing_account 72, tool_not_offered 605, multiple_voucher_types 123, unclear_period 123, prompt_injection 370, multi_intent 218, analytical_out_of_lane 60, no_current_draft 36, vague_report 9, cross_company 64, report_operation_unavailable 15, write_request 67, non_accounting 45, unsupported_period 39, unsupported_report 47.
Coverage tags (rows): typo 2296, style 6881, malformed_argument 252, short_name 131, grav_expected 1326, misspelled_name 72, missing_date 871, near_boundary 200, prompt_injection 296, legit_core_attached 296, multi_intent 218, escalate_to_reasoning_model 21, report 6780, user_example 60, multi_turn 1977, shorthand 1105, duplicate_ledger_name 8, calc_swap 40, grav_note 4, no_exclusion_operator 4.
Dropped while rendering: 1280 duplicate renderings, 29 argument rows whose gold span the proposer could not offer, 0 frozen-set near-duplicates.

## Audits (all pass; any failure stops the build)

| audit | result |
|---|---|
| Open-Jev `jev.data.validate_records` over **all five splits at once** | pass — 15,312 records, 1,687 groups; no group, input, entity or OOD template crosses splits. 11 exact duplicate inputs exist, each inside one split with the same target |
| group / question text / party stem isolation | pass |
| near-duplicates, locked vs trainable (character trigrams, entities and digits masked) | max 0.826 (fail at 0.90); p50 0.375, p90 0.594, p99 0.750; 2 of 1367 locked questions ≥ 0.80 |
| frozen pilot evaluation material | 100 questions and 9 fixture names: none in trainable rows; max similarity 0.76 |
| privacy (email, url, gstin, pan, phone, aadhaar_like, object_id, large_figure) | 0 hits in 15312 rows |
| synthetic name stems also present in tracked repo files | 0 |
| allowlist: route options ⊆ schema tools + controls; report_field = catalogue ids + unavailable_field; drafts use catalogue ids only; no figure in any draft | pass |
| every route label in every split; no label above 35% of training routes | pass |

## Tests

| suite | result |
|---|---|
| `node --test scripts/jev-routing/test/jevRouting.test.js` | **34/34** |
| `python3 -m unittest discover -s scripts/jev-routing/train -p 'test_*.py'` | **14/14** |
| `npm run test:openjev` (existing) | 48/48 — unchanged |
| `npm test` (existing, services) | 2007/2007 — unchanged |
| `npx jest test/accountant/reporting test/reporting --runInBand` (existing report builder) | 7 suites, 217/217 |
| `npx jest test/hr-ai --runInBand` (existing) | 61/61 tests; **pre-existing** suite failure: `openJevAccountsPilot.test.js` is a node:test file and Jest reports "must contain at least one test" — identical before this work |

## Baseline status

No valid baseline exists yet, by design. The v1 Mac-CPU run was stopped at 20 of
218 subset rows and is kept only as
`tmp/jev-routing/reports/DIAGNOSTIC-INCOMPLETE-baseline-released-2b-cpu-core-v1/`
(marked unsuitable). The official baseline is RunPod stage 1: the untouched
released 2B on all 4,341 locked rows, on the same GPU as every later evaluation.

## Estimated GPU time and spend ($0.28/h)

Expected 2.3–6.0 h ($0.64–1.68) for all stages; 0.9–1.5 h ($0.25–0.42) if the
smoke gate says STOP. Ceiling with every cap hit: 10.0 h, **$2.80**. Per-stage
table and assumptions: `scripts/jev-routing/RUNBOOK-runpod.md`.

## Known limitations

- Small evaluation cells: comparison_mode 4 test / 4 OOD rows, filter_operator 2/2,
  sort_direction 2/8, unavailable-field report rows ≈ 8 in the locked set. Those
  per-argument figures will be noisy; the gate uses pooled report metrics.
- The executors for all seven report tools, the relative-period resolver and the
  `acc_overdue_bills` executor do not exist; this package trains and measures
  routing and structure only.
- Every scenario was written by the same author as the rubric; the locked set
  measures agreement with that rubric on unseen wording, not with real users.
- `receipts` as a column is treated as unavailable (it needs a filter plus a
  measure, not a single column) — a rubric choice, documented in the schema.
