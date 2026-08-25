# Accountant — Cash Flow Forecasting

> **Status:** Proposed product/implementation spec. No code written.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Route (proposed):** `/accountant/reports/cash-flow-forecast`, under **Reports** in the accounting nav.
>
> **Core formula:** `Opening cash + expected receipts − expected payments = projected cash`, rolled forward day by day across 7 / 15 / 30 / 60 / 90 day horizons.
>
> **Headline constraint, established by audit (§3.6):** the commitment data a classical forecast runs on — invoice and bill **due dates** — is effectively absent from this database today. A due-date-driven MVP would ship an empty chart. §7 and §8 are ordered around fixing that rather than around pretending otherwise. The prerequisite slice is **C0 — Accounting data readiness for forecasting**.

---

## 1. What Cash Flow Forecasting is

### 1.1 The distinction that defines the feature

The accounting module already has a **Cash Flow report** at `/accountant/reports/cash-flow`. That is a *historical* statement: it explains where cash went over a period that has already happened. It is a record.

Cash Flow **Forecasting** answers a different question, in the opposite direction in time:

> *Will we have enough cash to meet what we owe, on the dates we owe it?*

The forecast is not a report. It is a **control instrument**. Its value is measured entirely by whether it changes a decision before the fact — delaying a purchase, chasing a specific customer this week rather than next, drawing on the OD facility, or holding a payment run for four days. A forecast that is only read after the month closes has failed, however accurate it was.

### 1.2 The arithmetic

For each day `d` in the horizon:

```
projected_closing[d] = projected_closing[d-1] + receipts[d] − payments[d]
projected_closing[0] = opening_cash            (actual, from the ledger)
```

`opening_cash` is the sum of every cash and bank ledger balance at the run date, computed from **posted vouchers** — never a stored `currentBalance` field, which drifts. This matches the rule already settled for ledger balances and for the budget module's actuals.

Everything after day 0 is an estimate. The entire design problem of this feature is **making the reader understand precisely how much of the line is fact and how much is guess** — which is what §5 exists for.

### 1.3 What it is explicitly not

- **Not a P&L forecast.** Profit is accrual; cash is timing. A profitable month with 90-day receivables can still fail payroll. Revenue recognised is irrelevant here; cash landing is everything.
- **Not the budget module.** Budgets (just rebuilt) plan *whether* money should be earned or spent against a ledger head. The forecast plans *when cash actually moves*. A budget line of ₹12,00,000 in annual salaries becomes twelve dated ₹1,00,000 outflows here. They share ledger heads but answer different questions, and neither should be derived from the other automatically.
- **Not a bank balance viewer.** Opening cash is one input, not the product.

---

## 2. User jobs

Written as jobs, with the decision each one drives. If a screen element serves none of these, it should not ship.

| # | Who | Job | Decision it drives | Horizon |
|---|---|---|---|---|
| J1 | Accountant / Finance owner | "Can I clear this week's payment run without going overdrawn?" | Release or hold the payment batch | 7 days |
| J2 | Accountant | "Which day do we go negative, if any?" | Escalate early, arrange OD or a delay | 30–90 days |
| J3 | Finance owner | "Which receipts must land for the plan to hold?" | Targeted collection calls, ranked by impact | 15–30 days |
| J4 | CEO | "Can we commit to this capex / new hire / fabric order?" | Approve, defer, or stage the commitment | 60–90 days |
| J5 | Accountant | "Payroll is on the 1st — is it covered?" | Sequence other payments around the fixed date | 7–30 days |
| J6 | Finance owner | "What happens if our biggest customer pays 30 days late?" | Contingency, or renegotiate terms | 30–90 days |
| J7 | Accountant | "Was last month's forecast right?" | Trust calibration; tune the model | retrospective |

**J7 is not optional.** A forecast nobody scores is a forecast nobody should trust. Forecast-vs-actual accuracy is what converts this from a chart into an instrument, and it is the cheapest possible feature to add *if* snapshots are stored from day one — and impossible to add retroactively if they are not. This is why snapshotting is in the MVP (§7) despite having no visible UI there.

---

## 3. Data inputs

### 3.1 Opening cash — **available today**

Sum of posted movement across ledgers in the cash/bank groups.

- **3 groups present:** `Cash-in-Hand`, `Bank Accounts`, `Bank OD A/c`
- **9 ledgers**, including `Cash in Hand`, `Petty Cash A/c`, `INDIAN BANK (CA-3512)`, `HDFC BANK A/C (CA-6085)`, `CEO's HDFC BANK A/C (PA-6160)`, `CEO Bank A/c (PA-6353)`

Two design notes:

- **OD accounts are not cash.** `Bank OD A/c` is a liability with a limit. It must be shown as *available headroom*, on a separate line, never added into opening cash. Treating an overdraft as cash is the single most common way a forecast tells a comforting lie.
- **Personal/director accounts** (`CEO's HDFC`, `CEO Bank A/c`) are in the tree but are probably not company operating cash. Which ledgers count must be an **explicit, configurable set**, not "everything under the Bank group". Ship with a setting; default to bank + cash groups excluding OD, and let finance uncheck.

### 3.2 Committed receipts (AR) — **structurally supported, unpopulated**

Sales invoices with a due date, less what has been received against them.

### 3.3 Committed payments (AP) — **structurally supported, unpopulated**

Purchase bills with a due date, less what has been paid.

### 3.4 Recurring and scheduled outflows — **partially available, the strongest real input**

- **Payroll** is the largest and most predictable outflow. `payrolls` shows a clean monthly cadence (Apr, May, Jun, Jul 2026; statuses `processed` / `paid`) over `payrollitems` (326 rows). Posted salary expense to date is **₹1,14,05,448** — by a wide margin the biggest single line in the books.
- **Statutory**: PF/ESI/TDS/GST follow fixed statutory calendars and are highly forecastable *by rule*, independent of any transaction data.
- **Rent, utilities, EMIs**: recurring in reality, not modelled anywhere yet. Requires a recurring-item register (§7).

### 3.5 Pipeline / planned inflows — **not usable yet**

- `salesjourneys`: **7 records**, furthest stage `poContract`, and **0 carry an order value**. There is no pipeline money to forecast.
- `acc_proforma_invoices`: **1 record**.
- The Sales journey model does carry a payment gate with `advancePercent`, which is the correct hook for "advance expected on PO signature" once journeys carry values.

### 3.6 Data reality audit — the finding that shapes this spec

Measured directly against the live database:

| Signal | Measured | Consequence |
|---|---|---|
| Posted vouchers | **1,581** of 1,621 | Strong historical base; behavioural modelling is viable |
| Voucher mix | payment 732 · purchase 404 · sales 147 · receipt 137 · journal 128 · credit_note 17 · contra 13 · debit_note 3 | 869 payment+receipt vouchers = enough signal for lag statistics |
| Purchase vouchers with `dueDate` | **1 of 404** | AP due-date forecasting impossible today |
| Sales vouchers with `dueDate` | **3 of 147** | AR due-date forecasting impossible today |
| Posted vouchers with a **future** `dueDate` | **1** | A commitment-only forecast renders one bar |
| Bill allocations | **277** rows across 247 vouchers | Bill-wise plumbing exists and is used |
| Bill allocations with `dueDate` | **0** | The finer-grained source is empty too |
| Bill allocations with `creditDays` | **0** | No terms to derive a date from |
| Sundry Debtors | 50 ledgers, net **−₹1,64,703** (credit) | AR control is net *credit* — no meaningful open receivable |
| Sundry Creditors | 172 ledgers, net **−₹4,95,403** | ~₹5L payable, undated |
| Bank transaction tables | **0 rows** (all three collection names) | No cleared-bank feed |
| Setu AA consents | **0** | Live bank sync built but never credentialed |
| `acc_cashflowadjustments` | **0** | Manual adjustment model exists, unused |

**Conclusion.** Every ingredient of a textbook AR/AP-driven forecast is missing, while the ingredients of a *behavioural* forecast (1,581 posted vouchers with dates and amounts) and a *recurring* forecast (monthly payroll) are present and strong.

The MVP is therefore built on recurring + behavioural + manual, with committed AR/AP wired but honestly reporting near-zero until **C0 — Accounting data readiness for forecasting** lands. Shipping commitment-first would produce a screen that is technically correct, visibly empty, and abandoned in a week.

---

## 4. Forecast date rules

The forecast is only as good as its answer to "*on what date does this cash actually move?*". Rules are applied in strict priority order; the first that resolves wins, and the winning rule is **recorded on the row** so the UI can always explain a date.

### 4.1 Resolution ladder

| Priority | Rule | Source | Confidence granted |
|---|---|---|---|
| 1 | **Cleared date** — money already moved | Bank feed / reconciliation | `confirmed` |
| 2 | **Explicit due date** on the bill allocation | `ledgerEntries[].billAllocations[].dueDate` | `committed` |
| 3 | **Explicit due date** on the voucher header | `Acc_Voucher.dueDate` | `committed` |
| 4 | **Derived from terms** — `voucherDate + creditDays` | `billAllocations[].creditDays`, or party ledger default | `committed` |
| 5 | **Derived from parsed text terms** — "Net 30" → +30d | `Acc_Voucher.paymentTerms` (free text) | `committed`, flagged `derived` |
| 6 | **Statutory calendar** — GST 20th, TDS 7th, PF 15th | Rule table, no transaction needed | `scheduled` |
| 7 | **Recurring schedule** — payroll on the 1st, rent on the 5th | Recurring register | `scheduled` |
| 8 | **Behavioural** — historical median lag for this party | Computed from posted receipts/payments | `expected` |
| 9 | **Pipeline** — journey stage × expected close × advance % | Sales journeys | `planned` |
| 10 | **Manual** — a human typed a date and amount | `Acc_CashFlowAdjustment` | as entered |

### 4.2 Overdue handling

An item past its due date has **not** disappeared; it is the most likely near-term receipt. Overdue items must never silently vanish from the forecast, and must never sit on their original past date either.

Rule: an overdue item is re-dated to `run_date + expected_collection_lag(party)`, retains an `overdue_by_days` marker, and drops one confidence tier (`committed` → `expected`). Age increases the haircut (§6.3), because a bill 90 days late is materially less likely to be paid than one 5 days late.

### 4.3 Working-day adjustment

Bank movement does not happen on Sundays or bank holidays. Any resolved date landing on a non-working day shifts:

- **Receipts** shift **forward** to the next working day (pessimistic — money arrives later).
- **Payments** shift **backward** to the prior working day (pessimistic — money leaves earlier).

Both directions are deliberately conservative. A forecast should never be optimistic by accident of the calendar. This requires an India bank-holiday calendar, configurable per company; a `budgetNegotiation`-adjacent office-calendar service already exists in this codebase (`officeDeadline.service.js`) and its holiday reading is the natural thing to reuse rather than duplicate.

### 4.4 Bucketing

Horizons of **7 / 15 / 30 / 60 / 90 days** are *view windows*, not separate computations. The engine always computes **daily** rows to 90 days; a horizon is a slice, and weekly is an aggregation of the same rows. One engine, one set of numbers, five views — anything else produces windows that disagree with each other.

Default granularity by horizon: **7d and 15d → daily**; **30d → daily, weekly toggle**; **60d and 90d → weekly**. Ninety daily bars is noise, not information.

---

## 5. Confidence states

The most important design element in the feature. A single projected line implies a precision that does not exist, and readers who are burned once by a confident wrong number stop opening the screen.

### 5.1 The five states

| State | Meaning | Typical source | Default weight |
|---|---|---|---|
| `confirmed` | Cash has moved, or is irrevocably in flight | Bank-cleared, reconciled | **100%** |
| `committed` | A dated obligation exists on both sides | Invoice/bill with due date | **95%** |
| `scheduled` | Fixed by rule or calendar, not by a counterparty | Payroll, GST, rent | **100% (outflow)** |
| `expected` | Behavioural estimate from history | Party payment-lag median | **60–85%**, by party history |
| `planned` | Intent, not obligation | Pipeline, budget-derived | **20–50%**, by stage |

Two rules that must not be negotiated away:

- **Outflows are never discounted below 100% in the base scenario.** Assuming you might not have to pay something is how a forecast becomes a comfort object. You *will* pay payroll. Discounting applies to *inflows* only.
- **Confidence is displayed, not just applied.** The chart is stacked by confidence band, so the reader sees the solid floor (confirmed + committed) separately from the soft top (expected + planned). The single most useful number on the screen is *"the lowest your balance goes if only the confirmed and committed items happen."*

### 5.2 Flags — a second, independent axis

Confidence answers *"how likely is this amount, on this date?"*. It does not answer *"where did this row come from"*, *"has it already gone wrong"*, or *"did a human type it"*. Those are different questions and they must not be folded into the same enum — a row can be `committed` **and** overdue **and** derived all at once, and collapsing that into one value loses exactly the detail an accountant is looking for.

So every movement row carries a **set of flags** alongside its single confidence state:

| Flag | Meaning | Set when | UI treatment |
|---|---|---|---|
| `manual` | A human entered this, it is not derived from a transaction | Created via `Acc_CashFlowAdjustment` or a what-if overlay promoted to a saved row | Visible **"Manual"** chip. Always attributable — who added it, when |
| `derived` | The **date** was inferred, not stated on the document | Date resolved by rule 4 (credit days) or rule 5 (parsed text terms) — see §4.1 | **"Derived"** chip; the "why this date" column names the rule |
| `overdue` | The due date has already passed and the item is unsettled | Committed item past due at run date; carries `overdueByDays` | **"Overdue"** chip with age; row re-dated per §4.2 |
| `at_risk` | Judgment that this is unlikely to land as modelled | Ageing haircut ≥ 25% (§6.3), a party with a poor settlement history, or set manually by a user | **"At risk"** chip; excluded from the floor line |

Rules that keep the two axes honest:

- **Flags never silently change the number.** `overdue` triggers the §4.2 re-dating and `at_risk` triggers the §6.3 haircut, but both effects are visible on the row rather than folded invisibly into the total.
- **`at_risk` is the one flag a human may set directly.** An accountant who knows a customer is in trouble must be able to say so, and that judgment should outrank a cheerful statistical median.
- **`manual` is never hidden.** A forecast that mixes typed-in numbers with ledger-derived ones without saying which is which cannot be audited. Manual rows are filterable and countable, and `coverage` (§10.4) reports how much of the projection they represent.
- **Flags are filter chips in the UI**, so "show me only the at-risk receipts" and "show me what a human typed" are one click each.

### 5.3 The floor line

Every horizon shows two curves:

- **Projected** — all states, weighted.
- **Floor** — `confirmed` + `committed` inflows only, against **all** outflows.

If the floor goes negative, that is an actionable fact regardless of how healthy the projected line looks. J1 and J2 are answered by the floor, not the projection.

---

## 6. Scenario rules

### 6.0 Phasing — read this before building anything in §6

The scenario **strategy** below is approved and should be designed for. Its **implementation is deliberately staged**:

- **Phase 1 ships Base only.** One scenario, computed and trusted end to end. The base case has to be right before variants of it mean anything — a best case built on an untrusted base is two wrong numbers instead of one.
- **Design may show the scenario control** in Phase 1. The segmented Base / Best / Worst selector can appear in the layout with Best and Worst visibly unavailable (disabled with a "coming in a later phase" affordance, not a dead control that silently does nothing). This keeps the eventual shape honest and avoids re-laying out the header later.
- **Best and Worst logic lands in Phase 3** (§8), because both depend on the per-party lag statistics that Phase 2 produces. Modelling a "worst case" before behavioural lags exist means inventing a multiplier, which is theatre.
- **Pulling scenarios forward requires an explicit decision.** If Best/Worst are wanted in Phase 1, they must be based on flat configurable multipliers rather than party statistics, and that trade-off should be stated rather than discovered.

The engine must nevertheless be **written scenario-shaped from day one** — a `scenario` parameter threaded through, with only `base` implemented. Retrofitting a scenario axis into a single-path engine is the expensive version of this.

### 6.1 Three scenarios, one engine

Scenarios are **parameter sets over the same rows**, never separately maintained data. A scenario that can be edited independently drifts from the base within a week.

| Scenario | Collection lag | Inflow weighting | Pipeline included |
|---|---|---|---|
| **Base** | Party median lag | Per §5.1 defaults | `planned` at stage weight |
| **Best** | Party P25 lag (fast payers) | `expected` → 95% | Yes, at higher weight |
| **Worst** | Party P75 lag + 15 days | `expected` → 40%, `planned` → 0% | **No** |

### 6.2 Worst case is the one that matters

Best case exists for completeness; nobody makes a decision on it. **Worst case is the scenario the feature is actually for** — it answers J6 directly and should be one click from the default view, not buried in a dropdown.

### 6.3 Ageing haircut

Applied to overdue receivables, multiplicatively on top of scenario weighting:

| Days overdue | Retained |
|---|---|
| 1–30 | 90% |
| 31–60 | 75% |
| 61–90 | 50% |
| 91–180 | 25% |
| 180+ | 0% — excluded, and surfaced as a write-off candidate |

These are **defaults, stored as settings**, not constants in code. Every business argues with them, and a hard-coded number becomes a reason to distrust the whole screen.

### 6.4 What-if overlays

A user must be able to add a temporary row — "₹15,00,000 fabric purchase on the 12th" — and see the curve move **without saving anything**. This is J4, and it is the difference between a report and a decision tool. Overlays are session-local until explicitly promoted to an `Acc_CashFlowAdjustment`.

---

## 7. MVP scope

Ordered so that each step is independently useful. **C0 is a prerequisite slice, not optional groundwork — without it the rest has no fuel** (§3.6).

### C0 — Accounting data readiness for forecasting *(prerequisite slice)*

> **This is a prerequisite slice, not groundwork inside Chunk 1.** It is scoped, built and verified on its own, before any forecast engine work begins. Its deliverable is not a screen — it is a database in which obligations have dates.
>
> **The slice, in four parts:** party credit terms · due-date backfill · due-date capture at entry · recurring items.
>
> **Why it is separable:** every part of C0 improves the accounting module on its own merits. Due dates make the Invoices page's overdue status real, credit terms belong on the party master regardless, and a recurring register is useful to payables whether or not a forecast is ever built. None of it is throwaway scaffolding for the forecast.
>
> **Exit criterion:** `dueDate` coverage above 80% on open items, and payroll/rent/statutory dues present in the recurring register. Chunk 1 does not start until this holds — see R1.

1. **Default credit terms per party ledger.** A `creditDays` field on the party ledger (debtors and creditors), editable in bulk. This alone converts 551 dateless sales+purchase vouchers into dated obligations via rule 4.
2. **Backfill due dates** for open items using party terms; store the derivation so it is visibly *derived*, not asserted.
3. **Capture due date at entry.** Voucher forms default `dueDate` from the party's terms so the hole stops growing.
4. **Recurring-item register.** A small model for payroll, rent, EMIs, statutory dues: amount, cadence, next date, ledger, active flag.

*Without step 1 or 4, the forecast shows opening cash and a nearly flat line — which is why C0 gates Chunk 1 rather than running alongside it.*

### Chunk 1 (Phase 1) — The forecast engine and screen

5. Opening cash from posted vouchers across a **configurable** cash/bank ledger set, with OD shown as separate headroom.
6. Daily roll-forward to 90 days, horizon slices at 7/15/30/60/90, weekly aggregation.
7. Confidence states with the **floor line** and stacked bands.
8. Committed AR/AP from due dates (real once C0 lands).
9. Scheduled outflows from the recurring register + statutory calendar.
10. Manual adjustments via the existing, currently unused `Acc_CashFlowAdjustment` model.
11. **Daily snapshots** of the forecast, for J7. No UI in MVP — but the data must start accumulating now, because it cannot be reconstructed later.

### Chunk 1 exclusions (deliberate)

- Behavioural lag modelling — needs the C0 dates to calibrate against.
- **Best/Worst scenario logic** — Base only in Chunk 1; the control may be shown disabled. See §6.0.
- Multi-currency. All 1,581 vouchers are INR.
- Live bank sync (Setu AA is built but has 0 consents and no credentials).

---

## 8. Later phases

**Phase 2 — Behaviour.** Per-party payment-lag statistics (median, P25, P75) from the 869 posted payment/receipt vouchers. Turns `expected` from a guess into a measurement, and unlocks the three scenarios in §6.

**Phase 3 — Scenarios and what-if.** Best and Worst logic lands here, not in Chunk 1 (§6.0), because both depend on the Phase 2 party lag statistics. Also: unsaved overlays, and ageing haircuts exposed as settings.

**Phase 4 — Accuracy feedback.** Forecast-vs-actual on the stored snapshots; MAPE by horizon. Auto-tunes lag assumptions and, more importantly, tells the reader how much to trust the number.

**Phase 5 — Live bank position.** Activate Setu AA (§3.6: built, dormant) so `confirmed` reflects cleared bank reality rather than posted vouchers. Materially raises the floor line's quality.

**Phase 6 — Cross-module inflows.** Sales journeys with real order values feed `planned` inflows via the existing `advancePercent` payment gate; the budget module's revenue lines (now ledger-bound) provide a top-down sanity check against bottom-up pipeline.

**Phase 7 — Alerts.** "Projected to go negative on 14 Oct" pushed to the accountant, not waiting to be discovered. A forecast that must be visited is a forecast that will not be.

---

## 9. UI structure

Route `/accountant/reports/cash-flow-forecast`, under **Reports**.

### 9.0 Design language — binding

This screen is built in the **approved GRAV Frost / Sales Accounting redesign direction**. It must **not** be built in the legacy raw-Tailwind accounting idiom (hard-coded `slate-*` / `indigo-*` / `rose-*` utilities, ad-hoc spacing) that the older accounting pages still carry. Those pages are being migrated onto the Frost direction; a new screen must not add to the pile being migrated away from.

Concretely:

- **Frost tokens and shell.** Token-based surfaces, hairlines and ink levels, consistent with the Frost/Sales direction rather than literal colour utilities. Semantic state colour (positive / at-risk / adverse) comes from tokens so light and dark both hold.
- **Accounting-specific density.** This is a finance instrument read by an accountant at a desk, not a marketing surface. Tighter vertical rhythm and smaller row heights than the Sales screens, without dropping below comfortable hit targets.
- **Compact tables.** The movement table is the workhorse: dense rows, sticky header, grouped by date, no card-per-row. Wide content scrolls inside its own container; the page body never scrolls sideways.
- **Tabular numbers everywhere.** Every figure uses tabular/lining numerals so columns align digit-for-digit down the page. Amounts are right-aligned; dates are consistent and unambiguous. A finance table where digits do not line up is unreadable at a glance, which defeats the point of the screen.
- **Restrained finance UI.** No decorative gradients, no oversized hero figures, no chart chrome that does not carry data. Colour is reserved for meaning — a breach, a risk flag, a trough — and carries a non-colour cue as well, so the signal survives greyscale printing and colour-blind readers.
- **One accent for money at risk.** Restraint is what makes the one red day on the curve land.

### 9.1 Layout, top to bottom

**A. Horizon bar** — `7 · 15 · 30 · 60 · 90` segmented control; granularity toggle (daily/weekly); scenario selector — **Base only in Chunk 1**, with Best/Worst visibly disabled per §6.0 (once shipped, Worst should be one click away, never buried); as-of date.

**B. Headline strip** — four figures, no more:

| Opening cash | Projected closing | **Lowest point** | Runway |
|---|---|---|---|
| today, actual | end of horizon | **value + the date it occurs** | days until negative, or "covered" |

**Lowest point is the most important number in the feature** and should be typographically dominant. "You dip to ₹2.1L on 14 Oct" is the sentence a finance owner acts on. A closing balance hides exactly the trough that matters.

**C. The curve** — projected line + **floor line**, stacked confidence bands, a zero rule that is visually unmissable, payroll and statutory dates marked as vertical pins. Days that breach zero are shaded.

**D. Movement table** — the workhorse. Compact, dense rows, sticky header, grouped by date, tabular numerals throughout. Columns: date · description · party · direction · **amount** (right-aligned, tabular) · **confidence** · **flags** · **why this date** (the §4.1 rule that resolved it).

- The **flags** column carries the §5.2 chips — **Manual**, **At risk**, **Derived**, **Overdue** — each also available as a filter chip above the table.
- The **"why this date"** column is what earns trust; a date the user cannot interrogate is a date they will not believe.
- Every chip pairs colour with a text label, so the state survives greyscale printing and colour-blind readers.

**E. Actions rail** — "Add expected item", "What-if overlay", "Export", "Which receipts must land?" (J3: inflows ranked by impact on the trough).

### 9.2 Empty and low-data states

Given §3.6 this is not an edge case, it is **the launch state**, and it must be designed first rather than retrofitted.

- If no due dates exist: show opening cash and scheduled outflows, and state plainly — *"No dated receivables found. Set credit terms on your customers to forecast collections."* with a direct link to the party terms screen.
- Never render a confident flat line implying no money is coming in. Absence of data must read as absence of data, not as a prediction of zero.

---

## 10. Backend service/API proposal

### 10.1 Shape — pure core, thin transport

Follows the pattern proven by `budgetVariance.service.js` / `budgetActuals.service.js`: the arithmetic is a pure, dependency-free, unit-tested module; the Mongo access is separate; the route is transport only.

```
services/cashFlowForecast.service.js     # PURE. roll-forward, weighting,
                                         # confidence, scenarios, trough
                                         # detection. No mongoose. asOf injected.
services/cashFlowForecast.test.js        # node --test, per repo convention
services/cashFlowSources.service.js      # Mongo → normalised movement rows
services/cashFlowSources.test.js         # pure helpers (date ladder, working day)
models/Accountant_model/Acc_RecurringItem.js
models/Accountant_model/Acc_ForecastSnapshot.js
routes/Accountant_Routes/Acc_cashFlowForecast.js
```

`Acc_CashFlowAdjustment` already exists and is unused — reuse it for manual items rather than adding a parallel concept.

### 10.2 Normalised movement row

Every source — AR, AP, payroll, statutory, manual, pipeline — is projected into one shape before the engine sees it. The engine must never know which source a row came from; that is what keeps it testable and keeps scenarios consistent.

```js
{
  date: Date,              // AFTER the §4 ladder and working-day shift
  direction: "in" | "out",
  amount: Number,          // always positive; direction carries the sign
  // ONE confidence state — how likely, on this date.
  confidence: "confirmed" | "committed" | "scheduled" | "expected" | "planned",

  // ZERO OR MORE flags — a separate axis (§5.2). A row can be `committed`
  // AND overdue AND derived at once; these are not confidence values and
  // must never be collapsed into the enum above.
  flags: Array<"manual" | "derived" | "overdue" | "at_risk">,
  riskReason: String | null,   // why at_risk — ageing, party history, or a person

  dateRule: "cleared" | "bill_due" | "voucher_due" | "credit_days"
          | "parsed_terms" | "statutory" | "recurring" | "behavioural"
          | "pipeline" | "manual",
  sourceType: "ar" | "ap" | "payroll" | "statutory" | "recurring"
            | "manual" | "pipeline",
  sourceId: ObjectId,
  partyLedgerId: ObjectId | null,
  label: String,
  overdueByDays: Number | null,
  originalDate: Date | null   // pre-shift, so the UI can explain the move
}
```

### 10.3 Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/accountant/cash-flow-forecast` | The forecast. Query: `horizon` (7/15/30/60/90), `granularity`, `scenario`, `asOf`, `companyId` |
| `GET` | `/api/accountant/cash-flow-forecast/movements` | The flat row list behind a date range — powers table 9.1D |
| `GET` | `/api/accountant/cash-flow-forecast/opening-cash` | Cash/bank breakdown incl. OD headroom |
| `POST` | `/api/accountant/cash-flow-forecast/what-if` | Stateless: rows + overlays in, curve out. Saves nothing |
| `GET`/`POST`/`PUT`/`DELETE` | `/api/accountant/recurring-items` | The recurring register |
| `GET`/`POST` | `/api/accountant/cash-flow-adjustments` | Manual items (existing model) |
| `GET` | `/api/accountant/cash-flow-forecast/accuracy` | Phase 4. Snapshot vs actual |

### 10.4 Response sketch

```jsonc
{
  "success": true,
  "asOf": "2026-08-24T00:00:00.000Z",
  "horizonDays": 30,
  "scenario": "base",
  "scenariosAvailable": ["base"],   // best/worst arrive in Phase 3 (§6.0)
  "openingCash": { "total": 0, "byLedger": [], "odHeadroom": 0 },
  "series": [
    {
      "date": "2026-08-25",
      "opening": 0, "in": 0, "out": 0, "closing": 0,
      "floorClosing": 0,
      "byConfidence": { "confirmed": 0, "committed": 0, "scheduled": 0,
                        "expected": 0, "planned": 0 },
      "breachesZero": false
    }
  ],
  "trough": { "date": "2026-10-14", "value": 0, "breachesZero": false },
  "runwayDays": null,
  "coverage": {
    "datedObligations": 0,
    "undatedOpenItems": 0,      // honesty: what the forecast could NOT see
    "derivedDates": 0,          // dates inferred by rule, not stated on a document
    "manualAmount": 0,          // how much of the projection a human typed
    "atRiskAmount": 0,          // inflow value flagged unlikely
    "overdueAmount": 0,
    "sourcesUnavailable": ["bank_feed", "pipeline_values"]
  }
}
```

`coverage` is deliberate. A forecast that does not declare what it could not see invites the reader to assume it saw everything.

### 10.5 Performance

Daily × 90 days × several sources, per page load. Guardrails: aggregate at the DB rather than looping vouchers in Node (the pattern used in `budgetActuals.service.js`); index on `voucherDate`, `dueDate`, `status`, `ledgerEntries.ledgerId` (all present today); cache a computed forecast for ~15 minutes keyed by `(companyId, scenario, asOf-day)`, invalidated on voucher post.

### 10.6 Permissions

Cash position is among the most sensitive figures in the company. Gate reads on an explicit permission rather than general `canView`; align with the tiering already used for cost visibility (`crmCostVisibility.js`) so one convention governs sensitive money. Writes to recurring items and adjustments require `canEdit`; adjustments above a threshold should route through the existing approvals flow.

---

## 11. Risks and assumptions

### 11.1 Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **No due dates exist** (1/404 AP, 3/147 AR). The forecast has nothing to project. | **Critical** | **C0 — Accounting data readiness for forecasting** completes before Chunk 1 begins. Do not run them in parallel: a forecast built first will demo empty and lose confidence permanently. |
| R2 | **False precision.** A crisp line implies certainty that is absent; one bad call destroys trust for good. | **Critical** | Confidence bands, floor line, and `coverage` are MVP, not polish. |
| R3 | **OD counted as cash.** ₹X of "cash" that is actually borrowing. | **High** | OD excluded from opening cash by construction; shown as separate headroom. |
| R4 | **Personal/director accounts inflate the position.** Four of nine cash/bank ledgers look personal. | **High** | Configurable ledger set; conservative default; visible list of what is counted. |
| R5 | **Garbage-in from imports.** Tally-imported vouchers may carry inconsistent dates. | **Medium** | `coverage.undatedOpenItems` surfaces what was skipped rather than hiding it. |
| R6 | **Behavioural model overfits** to 869 vouchers from a partly historical import. | **Medium** | Require a minimum sample per party (≥5 settled bills) before using a party median; otherwise fall back to a global default. |
| R7 | **Duplicate/void vouchers** double-count. | **Medium** | `status: "posted"` and `isOptional: {$ne: true}` only, same filter as the budget actuals engine. |
| R8 | **Performance** at daily × 90 days × multi-source. | **Low** | §10.5. |
| R9 | **Scenario sprawl** — scenarios become independently edited datasets that drift. | **Medium** | Scenarios are parameter sets over shared rows. Enforced at the service boundary. |
| R10 | **The AR control account is net credit** (−₹1,64,703), which is accounting-unusual and suggests advances or import artefacts. | **Medium** | Investigate before trusting AR-derived inflows; may indicate misposted advances. |

### 11.2 Assumptions

1. **Single currency (INR).** All 1,581 posted vouchers are INR. Multi-currency is out of scope and would require FX-dated revaluation.
2. **Single company per forecast run.** `companyId` scopes every query, matching the budget module.
3. **Posted vouchers are the source of truth** for both opening cash and actuals — never cached balance fields.
4. **Bank feed is absent.** All three bank-transaction collections are empty and Setu AA has 0 consents, so `confirmed` initially means "posted", not "cleared". This is a real quality ceiling on the floor line and should be stated in the UI, not glossed.
5. **Payroll continues monthly** at roughly its historical run-rate until the recurring register says otherwise.
6. **Statutory dates follow the standard Indian calendar** (GST 20th, TDS 7th, PF 15th), configurable per company.
7. **The office/bank holiday calendar** can be reused from `officeDeadline.service.js` rather than built again.
8. **Users will not maintain a separate forecast dataset.** Anything requiring duplicate data entry will rot. Every input must be a by-product of work already being done — which is exactly why C0 puts credit terms on the party master rather than asking for a date per invoice.

---

## 12. Definition of done

### C0 — Accounting data readiness for forecasting

- [ ] `creditDays` exists on the party ledger (debtors and creditors) and is bulk-editable
- [ ] Open items back-filled from party terms, with the derivation recorded so the date reads as **derived**, not asserted
- [ ] Voucher forms default `dueDate` from party terms, so the gap stops widening
- [ ] `dueDate` coverage **above 80%** on open items — the gate for starting Chunk 1
- [ ] Recurring register holds payroll, rent and statutory dues
- [ ] Each part stands on its own merits (overdue status on Invoices works, terms live on the party master) independent of any forecast

### Chunk 1 — Forecast engine and screen

#### Chunk 1-A — Base engine skeleton ✅ **DONE (24 Aug 2026)**

The first read-only Base forecast: daily projected cash movement from the three C0 inputs. Deliberately a **skeleton** — everything on the Chunk 1 checklist below that is not ticked here is genuinely not built, not stubbed.

- [x] **`services/cashFlowForecast.service.js`** — pure, no Mongo and no clock of its own. Rolls cash forward one day at a time and returns the documented shape: `rows[]` with `date/opening/inflows/outflows/netMovement/closing/sources{}`, `totals{}` including `minimumCash`/`minimumCashDate`, and `coverage{}`. Same pure/Mongo split as `creditTerms`/`voucherDueDateDefault` and `billTermsBackfillPlanner`/`Orchestrator`
- [x] **`services/cashFlowForecastOrchestrator.service.js`** — resolves opening cash from posted vouchers, dated open items through the C0-F ladder, and active C0-E recurring items; normalises them and calls the pure engine. Company-scoped, **fail-closed** on a missing/malformed `companyId`, in line with `openItems.service.js` and the backfill orchestrator
- [x] **`GET /api/accountant/cash-flow-forecast`** (`routes/Accountant_Routes/Acc_cashFlowForecast.js`, mounted in `server.js`) — accountant auth, read-only, `horizon` restricted to 7/15/30/60/90 (default 30), `asOfDate` optional. There is no POST/PUT/PATCH/DELETE on this router at all
- [x] **`/accountant/reports/cash-flow-forecast`** (frontend) — Frost/Sales primitives, summary slab, horizon segmented control, dense daily table (Date, Opening, Inflows, Outflows, Net, Closing). Labelled **"Base forecast"**; **Best/Worst render visibly DISABLED** rather than being hidden, so the screen is honest about what exists without implying a working control. Listed in Reports beside the existing Cash Flow report
- [x] **Recurring expansion is anchored, not stepped.** Weekly `+7d`; monthly/quarterly/yearly step calendar months from the **original** rule with month-end clamping. Stepping from the previously-clamped result would turn a 31st-of-the-month schedule into 31 Jan → 28 Feb → **28 Mar** — the classic recurring-date drift bug, which silently shortens every later month in a forecast. Anchoring gives 31 Jan → 28 Feb → 31 Mar, and a leap-day yearly rule correctly **recovers** to the 29th in the next leap year. All arithmetic is UTC, for the same DST reason `creditTerms.resolveDueDate` is
- [x] **`nextDueDate` is read, never advanced.** Pinned by a pure test (inputs deep-compared before/after) *and* an HTTP test that runs the forecast twice and asserts the stored value is byte-identical

**The one judgement call worth surfacing rather than burying: already-overdue open items are EXCLUDED from the projection and reported in coverage.** The alternative — dropping every overdue receivable onto day 1 — assumes money that is already late arrives today, which is the single most optimistic thing a cash forecast can do and the fastest way for one to lose its readers' trust. Placing it anywhere *else* requires knowing how long this company's overdue debts actually take to collect, which is precisely the behavioural model Chunk 1-A is scoped **not** to build. So it is neither guessed nor silently lost: excluded from the rows, counted in `coverage.openItemsOverdue` / `openItemsOverdueAmount`, and surfaced on screen in a "Not included in this projection" panel. Same discipline as the credit-terms and backfill slices. **If the intended contract was to place them on day 1, that is a small, isolated change — flagging it rather than deciding silently.**

- [x] Coverage additionally reports `openItemsUndated`, `openItemsBeyondHorizon`, `openItemsTotal`, `recurringOccurrences` and `recurringItemsActive`, so a reader can tell a genuinely quiet forecast from an empty one
- [x] Tests: **32 pure** (`services/cashFlowForecast.test.js`) — roll-forward, inflow/outflow signs, same-day netting with gross reporting, minimum cash and its date (including earliest-wins on ties), empty inputs giving a flat line, weekly/monthly/quarterly/yearly expansion, month-end clamp, leap-day recovery, `startDate`/`endDate` bounds, horizon-boundary inclusivity, no-mutation. **30 HTTP** (`test/accountant/cash-flow-forecast.route.test.js`) — missing/malformed/non-existent company, every valid horizon and several invalid ones, unparseable `asOfDate`, posted-only opening cash, same-day movement excluded from opening, ledger opening balances, dated receivable → inflow, dated payable → outflow, sidecar due date honoured, undated and overdue handling, active/paused/ended recurring, cross-company isolation proven in **both** directions, and an end-to-end roll-forward
- [x] **Scope guard proof**: a snapshot of every relevant collection's **counts *and* `updatedAt` stamps** is identical before and after three forecast runs — counts alone would miss an in-place replacement. Structurally, a regex sweep (comments stripped, since these files explain at length what they must never do) proves the route, orchestrator and engine contain **no** `create/save/update*/delete*/bulkWrite/replaceOne` call. Zero writes to `Acc_Voucher`, `Acc_BillTerms`, `Acc_RecurringItem`, `Acc_Ledger`, `Acc_Group` or `Acc_Company`
- [x] **Verified live against production data**: opening cash **₹9,61,659.99** computed from real posted vouchers across 9 cash/bank ledgers; a temporary ₹1,00,000 monthly schedule expanded correctly to 5 Sep / 5 Oct / 5 Nov with the roll-forward and `minimumCashDate` exact; probe deleted afterwards. The live forecast is currently a **flat line**, correctly: 205 of 208 open items have no due date and the other 3 are already overdue — the C0-F coverage gap, showing up honestly rather than being papered over
- [x] Pure suite **641 passing** (609 → 641; **+32 from this chunk**). Accountant route suites **246/246** across ten files, of which **+30 are this chunk's** (`cash-flow-forecast.route.test.js`); the remainder of the growth since the last count belongs to concurrent budget work in `budgets.route.test.js`, not to Chunk 1-A

**Still NOT started, and not stubbed:** scenarios and Best/Worst logic, scenario multipliers, confidence bands, the floor line, alerts, what-if overlays, forecast-vs-actual, AI insights, export, advanced charts, the behavioural collection-lag model, working-day adjustment, the four `manual`/`derived`/`overdue`/`at_risk` flags as chips or filters, OD-as-separate-headroom, configurable cash-ledger sets, and Phase 4 daily snapshots. Each remains unticked on the checklist below.

#### Data activation — the backfill was actually run (24 Aug 2026)

Not a code change. The C0-F mechanism and the Chunk 1-A engine were both already built and tested; this was the act of **applying** the backfill to real data and verifying the forecast came alive. No forecast logic, scenario, band, alert or chart code was touched, and no bug was found that required one.

**What was applied.** `POST /api/accountant/bill-terms/backfill/apply` with the preview's own unmodified `confirmationToken`. **205 rows written**, `unchanged: 0`, `skippedManual: 0`, `backfillRunId` **`6a8c0f4d3ceb6435b0e35f37`** — recorded here because it is the entire rollback key: `POST /backfill/rollback` with that id removes exactly these 205 rows and nothing else.

| | Before | After |
|---|---|---|
| Open items | 208 | 208 |
| Already dated | 3 | **208** |
| Ready to apply | 205 | **0** |
| Blocked | 0 | 0 |
| Coverage | 1.4% | **100%** |
| `alreadyDatedBySource` | `voucher_due_date: 3` | `voucher_due_date: 3`, `bill_terms: 205` |

All 205 derived from `company_default` at **46 days** (the figure set through the Settings → Credit Terms screen). Party terms contributed **0**, because `creditPeriodDays` is still unset on all 441 ledgers — the C0-B campaign remains the standing gap.

**Scope guard, measured before and after:** `Acc_Voucher` 1621 → 1621 with max `updatedAt` unchanged at `2026-08-22T06:57:48.067Z`; `Acc_Ledger` 441 → 441 with max `updatedAt` unchanged at `2026-08-22T04:31:32.144Z`; `Acc_RecurringItem` 0 → 0. Only `Acc_BillTerms` changed, 0 → 205, all under the single run id, `isManual: 0`. Timestamps as well as counts, because a count alone would miss an in-place rewrite.

**The forecast is now moving.** Same engine, same code, new data:

| Horizon | Inflows | Outflows | Closing | Lowest | Active days |
|---|---|---|---|---|---|
| 7d | ₹0 | ₹1,98,876 | ₹7,62,784 | ₹7,62,784 (29 Aug) | 2 |
| 15d | ₹6,56,550 | ₹4,83,107 | ₹11,35,103 | ₹5,90,161 (2 Sep) | 9 |
| 30d | ₹55,73,311 | ₹6,12,847 | ₹59,22,124 | ₹5,90,161 (2 Sep) | 19 |
| 60d | ₹56,12,713 | ₹6,93,456 | ₹58,80,917 | ₹5,90,161 (2 Sep) | 26 |
| 90d | ₹56,12,713 | ₹6,93,456 | ₹58,80,917 | ₹5,90,161 (2 Sep) | 26 |

Opening cash is **₹9,61,659.99 at every horizon**, unchanged from before the apply — exactly as it must be, since the backfill touched no voucher and no ledger. Horizons nest correctly (7 ⊂ 15 ⊂ 30 ⊂ 60), and 60d and 90d are identical because nothing is dated past **4 Oct 2026**. Recurring items contributed nothing because the register is empty; that behaviour is unchanged. Coverage now discloses `openItemsUndated: 0` (was 205) and `openItemsIncluded: 91`.

**Three things worth flagging rather than fixing.** None was "corrected" by inventing a date:

1. **A flat company default manufactures date clusters.** 23 bills land on **19 Sep 2026** (₹20,62,762) and 11 more on 20 Sep — a single day carrying **32.7% of all projected movement** across 90 days. This is an artifact of applying one 46-day figure to bills that shared an invoice date, not a real payment pattern. Only 26 of 90 days carry any movement at all. Party-level `creditPeriodDays` (C0-B) is what would disperse this honestly.
2. **Counterparty concentration is severe.** Of the ₹63,06,169 projected in, **MAYFAIR Lagoon alone is ₹31,51,410 (50.0%) across 29 bills**, and Mayfair Hotels (CORP) a further ₹6,31,396 (10.0%) — **60% of projected inflow from one group**. The forecast's shape is effectively one customer's payment behaviour.
3. **117 bills (₹72,76,693) are already overdue and are excluded from the projection**, per the Chunk 1-A rule. The oldest is Mayfair `GV007`, due **1 Sep 2025 — 357 days late** (₹1,01,640). Several 2025 payables sit 260–330 days late. These are excluded rather than guessed onto a date, and they are disclosed on screen; but ₹72.7L of undated-in-time obligation is a larger number than the ₹56L the forecast projects, so the projection should not be read as the whole picture until a collection model exists (a later chunk).

**Tests re-run, no code changed:** `services/cashFlowForecast.test.js` **32/32**; `bill-terms-backfill.route.test.js` + `cash-flow-forecast.route.test.js` **47/47**. No tests were added, since this was a data operation rather than a code change.

**Still not started:** Chunk 1-B, scenarios, Best/Worst, confidence bands, alerts, behavioural collection-lag model, what-if overlays, forecast-vs-actual, exports, advanced charts.

#### Chunk 1-B — Explainability ✅ **DONE (24 Aug 2026)**

The Base forecast now explains itself. **No forecast math changed** — the 32 Chunk 1-A pure tests and 30 Chunk 1-A route tests were re-run **unmodified** and still pass, which is the actual proof rather than an assertion. Everything below is an additive field.

- [x] **Per-day drilldown.** Every row carries `items[]`: `id`, `kind` (`open_item` | `recurring_item`), `direction`, `date`, `amount`, `partyOrLedgerName`, `billName`, `voucherNumber`, `source`, `sourceLabel`, `derived`, `overdue`, `ageDays`, `backfillRunId`. Sorted largest-first, so opening a heavy day leads with what made it heavy. A bill spanning several vouchers lists them all — a "bill" here is an aggregate, and the drilldown's job is to let someone find the document
- [x] **`inclusion`** — `includedOpenItems`, `includedOpenItemAmount`, `includedRecurringItems`, `excludedUndatedOpenItems`, `excludedUndatedAmount`, `excludedOverdueOpenItems`, `excludedOverdueAmount`
- [x] **`sourceBreakdown`** — the six documented buckets, each `{count, amount}`
- [x] **`diagnostics`** — `topMovementDates[]`, `concentration{maxDate, maxDateAmount, maxDateShareOfMovement, movingDays, horizonDays}`, `topParties[]`. Descriptive only: **no threshold, no severity, no verdict field**, and a test asserts none appears. Neutral wording throughout — "concentration", never "risk" or "warning". Deciding what counts as too concentrated is a later, explicit feature
- [x] Route unchanged: still `GET /api/accountant/cash-flow-forecast`, still read-only, still company-scoped and fail-closed

**The one design decision worth stating rather than burying: the source buckets are MUTUALLY EXCLUSIVE, and a sidecar row is reported as the term it was derived FROM.** A row backfilled from the company default is counted under `companyDefaultDerived`, **not** under `billTermsSidecar`. The obvious reading of the field names would have put every `Acc_BillTerms` row under "sidecar" — but the question a finance user is actually asking is *"how much of this did we invent from a blanket default"*, and burying that inside a generic sidecar total answers the wrong question. `billTermsSidecar` therefore holds only rows a **human** wrote directly (`source: "manual"`). The three sidecar buckets summed give every sidecar row; all six summed give exactly the projected total, which a test pins.

- [x] **`fetchExistingBillTerms` (C0-F) extended by one field** — `backfillRunId` added to its `select` and returned shape, so a drilldown can name the run that produced a derived date. Additive; the planner ignores it. C0-F's 26 planner tests and 17 route tests were re-run and pass unchanged. A second query purely to fetch one more field on the same documents would have been waste
- [x] **Frontend** (`/accountant/reports/cash-flow-forecast`): daily rows expand to their drilldown (one at a time — several open at once turns the table back into a wall); a "Not included in this projection" panel stating the overdue and undated amounts in factual language, including that overdue treatment is not built yet; a "Where these dates come from" panel with the company-default row marked by a quiet `derived` chip rather than a colour wash; and a "Concentration" panel showing top dates, top parties and moving-days-vs-horizon. Still labelled **"Base forecast"**, Best/Worst still visibly disabled, no chart, no new scenario control
- [x] Tests: **53 pure** (32 from 1-A untouched + **21 new**) and **42 HTTP** (30 from 1-A untouched + **12 new**), covering item grouping by date, row items summing to that row's own figures, breakdown totals matching the items that produced them, inclusion counts, concentration max date, top parties sorted by amount, company-default sidecar exposed distinctly, recurring items in the drilldown, cross-company leakage (asserting the other company's bill name appears nowhere in the serialised response), and an explicit "Chunk 1-A totals unchanged for the same fixture" test
- [x] **Scope guard**: a snapshot of counts **and** `updatedAt` stamps across `Acc_Voucher`, `Acc_BillTerms`, `Acc_RecurringItem` and `Acc_Ledger` is identical before and after three forecast runs. No voucher, ledger, bill-term, recurring-item or master was mutated
- [x] Suites: pure **662 passing** (641 → 662); accountant route **287/287** across ten files (246 → 287)

**Verified live on the activated data** — every figure identical to before Chunk 1-B (`opening ₹9,61,660`, `in ₹56,12,713`, `out ₹6,93,456`, `closing ₹58,80,917`), and the new fields tell the story the brief asked for:

- **100% of the projection's dates are `companyDefaultDerived`** — 91 items, ₹63,06,169, every one from backfill run `6a8c0f4d3ceb6435b0e35f37`. Not one projected date is a stated fact; all of them are the blanket 46-day figure. That is the single most important thing this chunk surfaced, and it was invisible before it.
- **Concentration**: 19 Sep carries ₹20,62,762 across 23 items — **32.7% of all 90-day movement** — with 20 Sep adding ₹15,97,029. Only **26 of 90 days** move at all. The 19/20 Sep cluster the brief predicted is visible on screen.
- **Top parties**: MAYFAIR Lagoon ₹31,51,410 (50.0%, 29 bills) and Mayfair Hotels CORP ₹6,31,396 (10.0%) — **60% of projected inflow from one group**.
- **Excluded and disclosed**: 117 overdue items, ₹72,76,693 — larger than the ₹56L projected. Undated is now 0.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag model, what-if overlays, forecast-vs-actual, exports, AI insights, advanced charts.

#### Chunk 1-C — Overdue treatment ✅ **DONE (24 Aug 2026)**

Chunk 1-B left 117 overdue bills worth ₹72,76,693 outside the projection — more than the ₹56L inside it. Chunk 1-C lets those bills in, but **only when a person has said when they expect them**. The default stays conservative: nothing is assumed to arrive today, and nothing is predicted.

- [x] **`Acc_BillTerms` extended** with `forecastExpectedDate`, `forecastExpectedDateSource`, `forecastExpectedDateNotes` and three provenance fields. **`dueDate` is untouched and stays the contractual/accounting date** — the two are separate fields rather than one field with a flag, so no report, ageing bucket or later chunk can mistake a collection assumption for a contractual term. Nothing outside the cash-flow forecast reads the new fields
- [x] **`services/forecastExpectedDate.service.js`** — pure validation. Whitelisted set/clear payloads, strict parsers that refuse booleans/objects/arrays, the `new Date(null)`-is-1970 trap guarded again, and provenance written from the actor and clock, never the body
- [x] **`PATCH` / `DELETE /api/accountant/bill-terms/forecast-expected-date`** — accountant auth, `canEdit` for writes, scoped by `{companyId, ledgerId, billName}` together. **Update-only: neither endpoint ever creates an `Acc_BillTerms` row.** Creating one would mean inventing values for its required `dueDate`, `source`, `creditDaysUsed` and `basisDate` — fabricating accounting data in order to hang a forecast note off it, which is backwards. A bill with no sidecar row 404s
- [x] **Engine rule.** An overdue bill is placed on its expected date when one exists, is not itself in the past, and falls inside the horizon. Its source becomes `manual_expected_date` ("Manual expected date"), it carries `overdue: true`, its **original `dueDate`**, its `forecastExpectedDate`, the note and the author — and its `ageDays` is measured from the **contractual due date**, because an expectation does not make a bill less late
- [x] **`sourceBreakdown.manualExpectedDate`** added; buckets remain mutually exclusive and still sum to the projected total
- [x] **`excludedOverdue[]`** added to the response — the actual rows, oldest first, so the screen can offer the action against them rather than only reporting a count nobody can act on
- [x] **Frontend**: a "Review overdue items (N)" action in the Not-included panel opens a dense drawer (bill, party, amount, due + age, expected-date input, note, Save/Clear). Header and footer both state **"Expected date for forecast only · does not change the voucher due date"**. Drilldown rows for included overdue bills show an `Overdue Nd` chip plus due-vs-expected, the note and the author. Factual chips, not warning colours — being late is a fact about the bill, and the expectation is a recorded decision

**Three rules worth stating rather than burying:**

1. **An expectation that has itself gone stale keeps the bill excluded.** The write endpoint refuses a past date, but a date set weeks ago can be overtaken by time. The engine re-checks, so a stale expectation can never resurrect a bill onto an earlier row.
2. **An overdue bill expected BEYOND the horizon is not in the rows, but is no longer counted as overdue-excluded** — it lands in `openItemsBeyondHorizon`. It is not a bill missing a date; it is one dated further out than this view reaches, and conflating the two would overstate how much is still unaccounted for.
3. **An expectation on a bill that is NOT overdue is ignored.** The feature is scoped to late bills; letting it move a future-dated bill would be an expectation quietly overriding a contractual date.

- [x] **Two exhaustive shape assertions failed and were updated deliberately** — the pure drilldown key-set and the route's `sourceBreakdown` key-set. Both are meant to be exhaustive precisely so a field cannot appear in a payload without someone deciding it should; they did their job
- [x] Tests: **26 pure** (`forecastExpectedDate.test.js`) + **16 new engine tests** (70 total in `cashFlowForecast.test.js`) + **11 new route tests** (28 total in `bill-terms-backfill.route.test.js`). Covering valid set, every rejection shape, past-date refusal, clear, provenance-not-from-body, read-only refusal, wrong-company refusal, no-sidecar-row 404, `dueDate` proven unmutated, no voucher or ledger writes, overdue with/without expectation, stale expectation, beyond-horizon, original due date and age preserved, `manualExpectedDate` counts, and **"with no expected dates anywhere, every 1-B figure is unchanged"**
- [x] Suites: pure **705 passing** (662 → 705); accountant route **298/298** across ten files (287 → 298)

**Live round trip on real data, then reverted.** Baseline: inflows ₹55,73,311, closing ₹59,22,124, 117 overdue excluded (₹72,76,693). Set an expected date of 10 Sep on **GV007** (M/s Mayfair Hotels & Resorts CORPORATE, ₹1,01,640, due 1 Sep 2025 — **357 days late**): forecast inflows rose by exactly ₹1,01,640, the bill appeared on 10 Sep labelled "Manual expected date" with `overdue: true`, `dueDate` **still 2025-09-01** and age **still 357d**, overdue-excluded fell 117 → 116, and `manualExpectedDate` showed `{count: 1, amount: 101640}`. Cleared it: every figure returned to baseline **exactly**. Verified afterwards that 0 rows carry an expectation, 0 carry the probe note, GV007's `dueDate` is unchanged, and all 205 bill-terms rows are intact — **no probe data left behind**.

**Still not started:** behavioural collection-lag prediction (nothing here suggests, estimates or derives a date — a pure test asserts no such export exists), scenarios and Best/Worst, confidence bands, alerts, what-if overlays, forecast-vs-actual, exports, AI insights, advanced charts.

**Known limitation, recorded rather than worked around:** bills dated straight from a voucher header have no `Acc_BillTerms` row, so they cannot yet take an expected date — on the live data that is 3 of the 117 overdue items. The fix is to give them sidecar rows, not to let this endpoint manufacture accounting data.

#### Chunk 1-D — Operating cash ledger configuration ✅ **DONE (24 Aug 2026)**

Opening cash was every ledger under "Cash-in-Hand", "Bank Accounts" and "Bank OD A/c", automatically. On the real chart that swept in **three accounts belonging to an officer of the company**. Which accounts are genuinely spendable operating cash is a finance judgement, so it is now recorded explicitly and the forecast reads it.

**The measured finding.** Of GRAV Clothing's ₹9,61,660 opening cash, **₹4,01,474 — 42% — was personal money**: `CEO Bank A/c (PA-6353)` ₹4,27,824, `CEO's HDFC BANK A/C (PA-6160)` ₹0, `CEO's Personal Cash` −₹26,350. Every day of the projection inherited that overstatement.

- [x] **`Acc_ForecastCashLedgerConfig`** — one config per company (unique `companyId`), holding three **separate** id lists plus notes and provenance. Stores choices, never balances; balances are always recomputed from posted vouchers at read time
- [x] **Three roles, deliberately distinct.** `included` is spendable cash. `excluded` is recorded rather than merely absent, so "nobody considered this" and "finance looked at this and said no" do not look the same a year later. `od` is kept apart on purpose: an overdraft balance is money **owed**, and folding it into "cash on hand" misstates both the cash and the headroom — it is reported beside cash as `odBalance`, never inside it
- [x] **`services/forecastCashLedgerConfig.service.js`** — pure. Whitelisted payload, array/id validation, duplicates refused rather than de-duplicated (a duplicate means the caller's state was inconsistent; collapsing it hides that), and all three role conflicts refused rather than resolved by precedence
- [x] **`GET`/`PATCH /api/accountant/forecast-cash-ledger-config`** — auth, `canEdit` for writes, company-scoped. Every named ledger is checked against the company's **real cash/bank/OD ledgers**, which closes two holes at once: naming another company's ledger, and naming an ordinary ledger of this company (a debtor, an expense head) whose balance would quietly become "cash on hand"
- [x] **Orchestrator wired.** A saved selection is authoritative and is intersected with the company's current cash ledgers, so one deleted or re-grouped since saving cannot contribute a balance it no longer has. `balancesByCashLedger` does one grouped aggregation rather than one query per ledger
- [x] **Frontend**: Settings → Cash-flow Readiness gains a dense "Operating cash ledgers" table — ledger, group, balance, and a Cash / Exclude / OD control per row — showing the opening cash the on-screen selection *would* produce before saving, whether the config is saved or suggested, and a "looks personal" chip explaining why a row is pre-set. The forecast page shows "Opening cash: N ledgers", plus a **Review cash ledger selection** link while unsaved
- [x] Tests: **30 pure** + **21 HTTP**. Covering valid config, every rejection shape, all three role conflicts, provenance-not-from-body, company-scoped candidates, OD suggested into its own bucket, personal accounts suggested excluded, read-only refusal, wrong-company ledger refused, non-cash ledger refused, upsert-not-duplicate, **forecast opening cash changing with the config**, `openingCashConfig` present, one company's config never affecting another's, and no voucher/ledger/bill-term/recurring writes
- [x] Suites: pure **735 passing** (705 → 735); accountant route **342/342** across eleven files (298 → 342)

**Two decisions worth stating rather than burying:**

1. **With no saved config, behaviour is UNCHANGED** — every cash-shaped ledger still counts, and the response says so via `openingCashConfig.status: "suggested_default"`. This chunk must not silently move a company's opening balance the day it ships; the number changes when finance decides it should. The screen prompts the review instead.
2. **The heuristics only ever suggest.** A rule that silently removed an account would be as wrong as the behaviour being replaced, just in the other direction. The signals used are ones actually present in this chart — the `PA-`/`CA-` account-numbering convention, the literal word "personal", and a **possessive** officer title. The possessive apostrophe is the discriminator on purpose: "CEO's HDFC Bank A/c" reads as a person's account while "CEO Operations Account" does not, and matching a bare title would flag the second. Nothing broader is matched, because a suggestion that is often wrong trains people to click past it.

- [x] **A real bug found by a test, not by inspection.** `resolveCashLedgers` did not `select` `groupName`, so the OD-group signal was invisible and **every overdraft ledger defaulted to being counted as spendable cash** — precisely the failure this chunk exists to prevent. Fixed and pinned.

**Live verification, and what was left in place.** Loaded the real candidates; the three personal accounts were suggested `excluded` with the signal shown, and the `Bank OD A/c` group was suggested `od`. Saved the finance-safe selection (6 included / 3 excluded), with the note *"Officer personal accounts (PA-6353, PA-6160, CEO personal cash) excluded from operating cash."* Forecast opening cash moved **₹9,61,660 → ₹5,60,186** (−₹4,01,474) and day 1 now opens on the corrected figure; `openingCashConfig` reports `saved · 6 included · 3 excluded`. An attempt to include a non-cash ledger was refused with `LEDGER_NOT_ELIGIBLE`. Counts **and** `updatedAt` for `Acc_Voucher` (1621), `Acc_Ledger` (441), `Acc_BillTerms` (205) and `Acc_RecurringItem` (0) are all unchanged — the only new document is the single config row. **This is a live selection, not a probe, and is meant to stay** — it is fully reversible from the Settings screen if finance disagrees.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag prediction, what-if overlays, forecast-vs-actual, exports, AI insights, bank integrations, chart redesign.

#### Chunk 1-E — Compact horizon UX ✅ **DONE (24 Aug 2026)**

60- and 90-day horizons were unreadable as flat daily tables. Weekly grouping is **presentation only** — the engine still computes every day, and weekly rows are aggregated **from** those daily rows rather than recomputed from raw inputs, so the two views cannot disagree.

- [x] **`grouping: { mode, available, defaultMode }`** and **`weeklyRows[]`** added to the response. `rows` stays daily and unchanged, and is kept in the payload even under weekly grouping so drilldown never becomes unreachable
- [x] **Aggregation rules as specified**: `opening` is the week's first daily opening, `closing` its last daily closing (both carried through, never re-derived, so the weekly line rolls forward exactly as the daily one does); inflows/outflows/net are sums; `minimumCash`/`minimumCashDate` is the lowest daily **closing** inside the week, earliest date on a tie; `items` concatenate; `dayCount`/`movingDayCount` describe the week honestly
- [x] **Monday–Sunday weeks** — the repo had no existing convention, so the specified one was used. `weekStart`/`weekEnd` are the first and last day **actually present**, not the calendar Monday and Sunday: a horizon rarely starts on a Monday, and reporting calendar bounds would claim days the forecast does not cover
- [x] **Default grouping by horizon** — daily for 7/15/30, weekly for 60/90 — with an explicit `groupBy=daily|weekly` overriding it. An **invalid `groupBy` is refused** (`400 INVALID_GROUPING`) rather than silently defaulted: a caller who asked for `monthly` should be told it does not exist, not handed weekly rows and left to assume they got what they asked for
- [x] **Frontend**: a Daily/Weekly segmented control beside the horizon control, following the backend default and reset when the horizon changes so the new horizon's default applies. Weekly rows show the week range, `movingDayCount/dayCount`, opening, inflows, outflows, net, closing and lowest; expanding a week reveals **its own daily rows** — the same numbers the daily table shows, read from the same `rows` array — and each of those still expands to the 1-B item drilldown. A line states that the summary panels cover the full horizon, not only the visible rows
- [x] Tests: **24 new pure** (94 total in `cashFlowForecast.test.js`) + **9 new route** (51 total). Covering Monday bucketing including the Sunday off-by-one, partial first/last week clipping, every day landing in exactly one week, weekly opening/closing/sums/minimum, week-to-week roll-forward, item concatenation losing nothing, items summing to their week's own figures, **daily totals equalling weekly totals at all five horizons**, default-by-horizon, explicit override, invalid `groupBy` refused, a Monday-start horizon giving full weeks, and a 7-day horizon from a Tuesday spanning two partial weeks
- [x] **The load-bearing guarantee**, pinned twice: `grouping changes no figure the earlier chunks published` (totals, inclusion, sourceBreakdown and diagnostics deep-equal across modes) and, through the real stack, `weekly and daily views agree on every total`
- [x] Suites: pure **759 passing** (735 → 759); accountant route **366/366** across eleven files (342 → 366)

**Live verification on real data.** 30d defaults to daily, 90d to weekly (13 weeks over 90 days). Daily and weekly agree exactly — sum of weekly inflows equals the horizon's ₹56,12,713, and the last week's closing equals the horizon's closing. Opening cash is still **₹5,60,186** from the saved Chunk 1-D 6-ledger config, unaffected by grouping. The 19/20 Sep cluster is visible inside the week of **14–20 Sep** (₹42,95,788 in, 42 items), and expanding that week gives its 7 daily rows, of which 19 Sep opens the same 23-item drilldown as before. An invalid `groupBy` returned `400 INVALID_GROUPING`.

**Scope guard.** The forecast stack still contains zero write calls; a snapshot of counts and `updatedAt` across `Acc_Voucher`, `Acc_BillTerms`, `Acc_RecurringItem`, `Acc_Ledger` and `Acc_ForecastCashLedgerConfig` is identical before and after six forecast requests across both modes and three horizons.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag prediction, what-if overlays, forecast-vs-actual, exports, AI insights, bank integrations, chart redesign.

#### Chunk 1-F — Party credit-terms cleanup ✅ **DONE (24 Aug 2026)** — preview **and** apply built

Chunk 1-B measured the distortion: **100% of projected open-item dates come from one blanket company default**, and Mayfair entities dominate. This chunk gives finance a focused way to replace that with real per-party terms, and to see exactly what moves before anything does.

**Apply WAS built, because C0-F's planner already supports safe recalculation.** That was checked before deciding rather than assumed: once a party has its own terms, `deriveFromTerms` returns `party_terms`, which no longer matches a stored `company_default` sidecar row, so the planner re-proposes it — while a **manual** row is protected at that same rung and never re-evaluated. Apply therefore **composes two existing safe paths and adds no new write logic**:

1. `creditTerms.buildUpdate` — the same whitelisted service the Parties screen writes through. Its `$set` is assembled field by field, so this can never become a broad ledger update however the body is shaped.
2. `billTermsBackfillOrchestrator.applyPlan`, narrowed to the one ledger.

Re-implementing sidecar writing here would have duplicated manual-row protection, the confirmation-token machinery and rollback-by-`backfillRunId`. Composing keeps one implementation of each, and the apply response returns the `backfillRunId` so the recalculation is rollback-able exactly like any other backfill run.

- [x] **`GET /api/accountant/forecast/party-terms-impact`** — parties ranked by **company-default-derived amount first**, total projected amount second. That order answers "where would real terms change the forecast most", which is money sitting on an invented date — not simply the biggest customer. A party whose bills already carry explicit dates needs no attention however large it is
- [x] **`POST .../preview`** — per-bill `currentDueDate → proposedDueDate`, `deltaDays`, `source`, `canRecalculate`, `blockedReason`, plus totals including an **amount-weighted** date shift (a ₹30L bill moving 40 days is not the same as a ₹300 one moving 40 days, and an unweighted mean would say it was). Writes nothing, by construction
- [x] **`POST .../apply`** — permission-gated, behind the preview's own confirmation token, refusing a stale preview with `409 STALE_PREVIEW`
- [x] **`services/partyTermsImpact.service.js`** — pure ranking, preview arithmetic and validation. Derives proposed dates through `creditTerms.resolveDueDate`, the same function the planner uses, so a previewed date and the date an apply writes can never come from two different arithmetics
- [x] **Frontend**: Settings → Cash-flow Readiness gains a ranked "Party credit terms" table (party, current terms, company-default-derived amount, open items, factual reason) with a per-party preview modal showing every bill's current → proposed date, blocked rows labelled alongside movable ones, and an explicit apply
- [x] Tests: **22 pure** + **22 route**. Covering ranking order, weighted shift, every block reason and its precedence, 0..365 validation, wrong-company refusal, **preview writing nothing** (counts and `updatedAt` across vouchers, ledgers and bill terms), apply recalculating only default-derived rows, a manual row proven untouched at its original date, read-only refusal, missing/stale token refusal, no voucher write, and one party's apply leaving another's rows alone
- [x] Suites: pure **781 passing** (759 → 781); accountant route **422/422**

**Three protections worth stating rather than burying:**

1. **A manual sidecar row is never recalculated** — protected in the preview, and again by the planner underneath.
2. **A row with a manual expected date (1-C) is BLOCKED, deliberately.** The alternative — moving the due date beneath it — was considered and rejected: the expectation was recorded about a bill someone judged **overdue**, and shifting the due date changes its age and can stop it being overdue at all, at which point Chunk 1-C ignores the expectation entirely. That is a real semantic change and belongs in front of a person, not inside a bulk recalculation. *If the intended product decision is that the expected date should survive while the due date moves beneath it, that is a small, isolated change — flagged rather than decided silently.*
3. **A stated date (bill-allocation or voucher-header) is blocked** — it outranks any derivation. So is a row already on party terms: it is already the goal.

**Live verification — preview only; nothing applied.** The ranked list returned 82 parties, with **MAYFAIR Lagoon first at ₹31,51,410 across 29 default-derived bills (20 landing on 2026-09-19)**, followed by four more Mayfair entities. Previewing Mayfair at 21 days showed 29 rows recalculable (₹31,51,410) and 1 blocked (₹14,152), with a **−25-day weighted shift**. A before/after snapshot proved the preview wrote nothing.

**Apply was NOT run against live data.** The instruction was to apply only to a deliberate small test party or not without approval — Mayfair is 29 bills and ₹31.5L, which is neither small nor reversible-by-accident, so it was left alone. The live database is unchanged: **0 ledgers have `creditPeriodDays` set, 0 sidecar rows are on `party_terms`**, and voucher/ledger/bill-term counts and timestamps are exactly as before. The apply path itself is proven by route tests, including the real recalculation and the manual-row protection. **Awaiting your approval to run it on a chosen party.**

**Scope guard.** The only model this route writes is `Acc_Ledger`, via `creditTerms.buildUpdate` (asserted structurally by a test); bill terms are written only transitively by C0-F's own apply. Zero `req.body` spreading. No posted voucher is touched, and no due date is rewritten as a side effect of editing terms — the preview shows the change first and apply is a separate, confirmed act.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag prediction, what-if overlays, forecast-vs-actual, exports, AI insights, bank integrations, chart redesign.

#### Chunk 1-G — Forecast action center ✅ **DONE (24 Aug 2026)**

Six slices produced a working, auditable Base forecast — and four separate tools to improve it (party terms, overdue expected dates, the recurring register, the cash-ledger config). What was missing was any answer to *"which do I do first?"*. This is a read-only guidance layer that ranks the work and links to the tools.

- [x] **`services/cashFlowForecastActionCenter.service.js`** — pure. Consumes the forecast's own `sourceBreakdown`/`inclusion`/`excludedOverdue`/`openingCashConfig`, the party impact analysis and a recurring-items count, and returns a `summary` plus 5–8 ranked `actions`
- [x] **`GET /api/accountant/cash-flow-forecast/action-center`** — accountant auth, read-only, fail-closed on companyId, same horizon validation as the forecast route (an input the forecast would refuse must not be silently answered from a different horizon)
- [x] **Ranking**: high — largest default-derived parties and largest overdue-excluded parties; medium — an empty or key-category-missing recurring register, and an unsaved cash config; low — smaller default-derived parties. **Room is reserved** (3 party + 3 overdue high slots) so the two setup actions cannot be buried by a wall of parties; a test with 30 competing parties pins that
- [x] **Overdue actions group by PARTY, not by bill.** A queue with 117 rows in it is a list, not guidance, and the person chasing them chases a counterparty
- [x] **Frontend**: a compact, collapsible "Improve forecast quality" panel above the Not-included block. Type chip, title, one-line factual reason, amount/count, per-row CTA. The overdue CTA **opens the existing drawer in place** rather than navigating; the others link to Settings anchors or the recurring register
- [x] **Refactor to avoid a second source of truth**: the Mongo-touching party analysis moved out of `Acc_partyTermsImpact.js` into **`services/partyTermsImpactOrchestrator.service.js`**, now shared by the cleanup workflow and the action center. Two copies of "which rung dated this bill, and is it protected" would be two things free to drift. Chunk 1-F's 22 route tests were re-run **unmodified** and still pass, which is what makes the refactor safe to claim
- [x] Tests: **24 pure** + **12 route** (63 total in the forecast route file). Covering ranking by amount, priority tiers, the cap, overdue grouping and its cap, empty vs key-category-missing register, saved config suppressing the cash action, every `scoreLabel` transition, cross-company isolation, invalid horizon/company refusal, and **no writes** to vouchers, bill terms, recurring items, ledgers or the cash config
- [x] Suites: pure **805 passing** (781 → 805); accountant route **470/470** across thirteen files

**The boundary this chunk exists to hold, and two tests that hold it.** The action center says *where* to look, never *what the answer is* — no credit-days figure, no expected date, no recurring amount, no ledger selection. One test asserts no action carries a recommended value or a mutation payload (`proposedCreditPeriodDays`, `forecastExpectedDate`, `includedLedgerIds`, `payload`, `method`) and that every action has an `href` and a `ctaLabel`; another asserts no action's text proposes a number of days. A helpful-looking default here would have reintroduced, one layer up, exactly the invented-number problem the previous six slices spent their time removing.

**And it is not an alert system.** `priority` orders a queue; it is not a severity. No thresholds, no breach conditions, neutral palette, and a test asserts the copy contains none of *urgent, critical, warning, danger, risk, alert, fail, wrong* or an exclamation mark. Alerts remain a later, explicit chunk.

**Live verification.** On real data the panel reports **"Partially ready"** (cash config saved, but 91 default-derived bills at ₹63,06,169 and 117 overdue at ₹72,76,693) and returns 8 actions: Mayfair-heavy party-terms actions led by **MAYFAIR Lagoon (₹31,51,410, 29 bills)**, overdue expected-date actions grouped by party (Mayfair Kalimpong ₹12,39,910 · oldest 99 days; Mayfair Bay Of Resort ₹11,74,891 · oldest 257 days), and the recurring-register action because it is empty. **No cash-ledger action appears — correctly, because Chunk 1-D's config is saved.** Clicking "Review overdue" opened the existing drawer without navigating.

**Scope guard.** Zero write calls across the action-center service, the extracted party orchestrator and the forecast route. Live counts and `updatedAt` unchanged: `Acc_Voucher` 1621, `Acc_Ledger` 441, `Acc_BillTerms` 205, `Acc_RecurringItem` 0, cash config 1; still 0 ledgers with credit terms set. No party terms and no expected dates were auto-applied.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag prediction, what-if overlays, forecast-vs-actual, exports, AI insights, bank integrations, chart redesign.

#### Chunk 1-H — QA + permission / read-only UX ✅ **DONE (24 Aug 2026)**

A safety and polish pass over Base forecast v1. No new financial logic.

**Permission audit — all eleven writes verified closed.** Every write endpoint the forecast surface exposes was audited rather than assumed: `bill-terms/backfill/apply`, `backfill/rollback`, `forecast-expected-date` PATCH and DELETE, `party-terms-impact/apply`, recurring-item create/update/delete, `forecast-cash-ledger-config` PATCH, and party credit-terms single + bulk. All eleven require accountant auth and gate on `canEdit`, and in every case the permission check is the **first** thing the handler does.

- [x] **`test/accountant/forecast-permissions.route.test.js`** — new, 9 tests holding the whole matrix in one place. Individual route files each test their own 403; the value of this file is the *surface*, so that a write endpoint added later and not listed here is an obvious gap. It proves: every read a finance reviewer needs answers 200 for a viewer (forecast daily and weekly, action center, backfill preview, party impact, party-terms **preview**, cash config, recurring items, parties); all **eleven** writes refuse a viewer with a clean **403 — asserted specifically, because a 500 would mean the permission check ran after something that could throw**; the same eleven refuse a user whose `permissions` object is missing entirely; the same eleven refuse an unauthenticated caller with 401; **nothing is written on the way to being refused** (counts *and* `updatedAt` across vouchers, ledgers, bill terms, recurring items and the cash config, over 33 refused calls); and an editor is genuinely not blocked — their writes return 200, and a stale-token apply returns **409, not 403**, proving the gate passed and the guard caught it
- [x] Read endpoints write nothing for anyone: forecast, action center and both previews snapshot-identical for editor and viewer alike

**Read-only UX.** The frontend now reads `can("canEdit")` from the accountant auth context, which **fails closed** when permissions have not loaded — the right default, since a control that briefly looks editable and then refuses is worse than one that appears once the answer is known.

- [x] Forecast page: a calm **"View only"** chip beside the as-of line; the overdue drawer keeps its list fully visible but disables the date and note inputs, hides Save/Clear, and carries the line *"View only — your accounting role cannot record expected dates."*
- [x] Settings: the cash-ledger panel's Save is replaced by a **View only** chip and its role controls and note are disabled; the party-terms preview modal still **previews** for a viewer (it is read-only) but replaces Apply with *"View only — preview available, apply is not."* Preview staying open to viewers is deliberate: seeing what a change would do is exactly the sort of thing a reviewer should be able to do without permission to make it

**Clarity polish.**

- [x] A single factual line above the controls: **"Base forecast · as of 24 Aug 2026 · Opening cash from 6 ledgers (saved selection)"** — the as-of date, the cash-config status and the included-ledger count, all previously only inferable
- [x] Empty states added: no overdue items excluded, no parties relying on the company default, and **no movement in the selected horizon** (stating the flat closing figure and pointing at the excluded items that may explain it)
- [x] Best/Worst remain visibly disabled with a title explaining why

**A real responsive defect found and fixed.** At 375px the action center's four-column table collapsed to roughly one word per line. It is now a flex list rather than a table — the content is a sentence and a button per row, with no columnar relationship worth preserving, so it reflows instead of forcing a sideways scroll. **QA matrix walked: 1600px, 1280px and 375px; 7/15/30 daily and 60/90 weekly; week → day → item drilldown; the overdue drawer; and every action-center CTA.** No horizontal page overflow at any width, and the wide forecast table scrolls inside its own container as before.

- [x] Suites: pure **805 passing** (unchanged — this pass added no pure logic); accountant route **505/505** across fourteen files (470 → 505; +35, of which 9 are the permission matrix and the rest pre-existing suites re-run)

**Honest limit on the frontend check.** The read-only *rendering* was verified by walking the editor path live (117 Save controls present and enabled, no view-only banner) and by inspection of the gating conditionals; a live session as a genuine viewer role was not exercised, because the dev environment authenticates as an editor. The enforcement boundary is the server, and that is proven by the 9 automated tests above — a hidden button is UX, not a control.

**Scope guard.** No posted voucher, ledger, bill term, recurring item or cash config was mutated by this pass; live counts and timestamps unchanged. No party terms, expected dates, recurring items or cash-ledger config were auto-applied.

**Still not started:** scenarios and Best/Worst, confidence bands, alerts, behavioural collection-lag prediction, what-if overlays, forecast-vs-actual, exports, AI insights, bank integrations, chart redesign.

#### Chunk 1 — remaining checklist

- [ ] Opening cash matches a manual trial-balance check of the configured cash/bank ledgers, to the rupee
- [ ] OD excluded from cash and shown as separate headroom; counted ledger set is configurable and visible
- [ ] Daily roll-forward to 90 days; all five horizons slice **one** computation and agree with each other
- [ ] Floor line and confidence bands render; `coverage` reports what was not seen, plus derived / manual / at-risk / overdue amounts
- [ ] The four flags (`manual`, `derived`, `overdue`, `at_risk`) render as labelled chips **and** as filter chips; `at_risk` is settable by a person
- [ ] Trough date and value correct against a hand-worked fixture
- [x] **Base scenario only**; the scenario control renders with Best/Worst visibly disabled, and the engine carries a `scenario` parameter from day one (§6.0) — **done in Chunk 1-A**: the response carries `scenario: "base"` and the screen's Best/Worst controls are rendered `disabled`
- [ ] Built in the **GRAV Frost / Sales Accounting redesign direction** (§9.0) — token-based, accounting density, compact tables, tabular numerals. No new raw-Tailwind colour utilities
- [ ] Light and dark both hold; every state chip pairs colour with a text label
- [ ] Pure service unit-tested per repo convention (`node --test`), including: inflow/outflow sign, working-day shift in **both** directions, overdue re-dating and tier drop, zero-crossing and trough detection, flag independence from confidence, empty-source behaviour
- [ ] Daily snapshots accumulating for Phase 4 (no UI, but the data cannot be reconstructed later)
- [ ] Permission-gated; sensitive-figure convention applied

---

# C0 implementation plan — Accounting data readiness for forecasting

> **Naming:** this is the plan for the **C0 prerequisite slice**, not for the forecast engine. The forecast engine is a later, separate chunk and must not be conflated with this one — C0 ships no forecast, no curve and no projection. Earlier drafts called this "Chunk 1"; that label is retired here to remove the ambiguity.
>
> **Status:** Implementation plan. C0 approved with refinements. No code written, no data changed.
>
> **Scope:** the prerequisite slice **C0 — Accounting data readiness for forecasting** only. No forecast engine, no forecast screen, no scenario work.
>
> **Method:** every claim below was verified against the live code and database on 24 Aug 2026. Counts are measured, not estimated.

---

## C1.0 Two findings that change the plan

### Finding A — the field already exists

`Acc_Ledger.creditPeriodDays` is **already in the schema** ([`Acc_MasterModels.js:471`](../../models/Accountant_model/Acc_MasterModels.js)), sitting beside `creditLimit` and `billWiseEnabled`.

`PUT /api/accountant/chart-of-accounts/ledgers/:id` currently does `const updates = { ...req.body }` and passes it straight to `findByIdAndUpdate`, which means the field is *technically* already writable. **That is a defect to work around, not a shortcut to lean on** — see the warning immediately below.

C0 step 1 is therefore not "add a field". It is **expose, populate and consume a field that has been there all along**:

| Measured | Value |
|---|---|
| `Acc_Ledger` documents | **441** |
| with `creditPeriodDays > 0` | **0** |
| with `billWiseEnabled: true` | **52** |
| with `creditLimit > 0` | **0** |
| references to `creditPeriodDays` in the frontend | **0** |

This removes a model migration from the plan and reduces step 1 to a UI surface plus a bulk endpoint.

### ⚠ Implementation warning — do not lean on `req.body` spreading

`PUT /chart-of-accounts/ledgers/:id` builds its update as `{ ...req.body }` and hands the whole object to `findByIdAndUpdate` ([`Acc_chartOfAccounts.js:1312`](../../routes/Accountant_Routes/Acc_chartOfAccounts.js)). `POST /ledgers` does the same with `...req.body`. This is **mass assignment**, and C0 must not rely on it.

Why it matters here specifically:

- **Any client can set any ledger field.** A payload that happens to carry `openingBalance`, `nature`, `groupId`, `companyId`, `isReserved` or `currentBalance` rewrites accounting fundamentals through a request that was only supposed to change credit terms. `nature` in particular drives the revenue/expense split the budget module and the forecast both depend on.
- **A credit-terms UI would silently become a whole-ledger editor.** F1's inline edit would `PUT` whatever object the form is holding — including stale copies of fields the user never saw.
- **Provenance cannot be trusted.** C0 adds `creditTermsSource` and `creditTermsUpdatedAt`; if the client can set them directly, they record whatever the client claims rather than what happened.

**Required approach for every C0 write path:**

1. **Whitelist explicitly.** Credit-term updates accept exactly `creditPeriodDays` and `creditLimit`. Nothing else is read from the body:

   ```js
   const CREDIT_TERM_FIELDS = ["creditPeriodDays", "creditLimit"];
   const updates = {};
   for (const k of CREDIT_TERM_FIELDS) {
     if (Object.prototype.hasOwnProperty.call(req.body, k)) updates[k] = req.body[k];
   }
   ```

2. **Validate before writing.** `creditPeriodDays` must be an integer in `0..365`. Reject `null`, `""`, negatives, non-numerics and absurd values with a 400 rather than coercing — `Number(null) === 0` would write "unset" as a real value, and §C1.3 depends on 0 meaning *unset*.
3. **Server sets provenance.** `creditTermsSource` and `creditTermsUpdatedAt` are written by the route from the authenticated user and the clock, never accepted from the body.
4. **Use dedicated endpoints**, not the general ledger `PUT`: `PATCH /parties/:ledgerId/credit-terms` (B7) and `PATCH /ledgers/bulk-credit-terms` (B6). The credit-terms UI must never call the general ledger update route.
5. **Do not silently widen the whitelist** to make a form work. If a screen needs another field, that is a deliberate decision with its own review.

**Out of C0's scope but worth logging:** the existing spread on `POST`/`PUT /ledgers` is a pre-existing mass-assignment hole independent of this work. C0 should not fix it as a side effect — that is a separate change with its own blast radius — but it should be raised rather than inherited quietly.

### Finding B — §3.6 understated the receivables position, materially

The original audit measured the **ledger control account** net (Dr − Cr across all entries) and found Sundry Debtors net **−₹1,64,703**, concluding there was "no meaningful open receivable". That reading was wrong at the level that matters.

Re-measured **bill-wise**, using this codebase's own open-item logic:

| Measured (posted vouchers, party ledgers) | Value |
|---|---|
| Distinct bills | **239** |
| **Open items** (\|remaining\| > ₹1) | **208** |
| — receivable side (Dr) | **100 bills, ₹99,42,397** |
| — payable side (Cr) | **108 bills, ₹36,40,465** |
| Open items **with** a due date | **0** |
| Open items **needing backfill** | **208** |
| Distinct parties holding open items | **82** |
| Oldest open item | GV007, M/s Mayfair Hotels & Resorts Ltd. (CORPORATE), ₹1,01,640, first seen **2025-07-17** |

The control account nets to near-zero because on-account payments were posted without being allocated against specific bills — the payments cancel the invoices in the ledger total while both remain open bill-wise.

**Consequence:** there is roughly **₹1 crore of open receivable and ₹36 lakh of open payable to forecast**, across 82 parties, and every one of them is undated. C0 is worth more than the original spec implied, and §3.6 should be read with this correction. The forecast is not being built on an empty book.

---

## C1.1 Exact files, models, routes and forms to change

### Backend — `/Users/risheeray/grav-cms-backend`

| # | Path | Change | Type |
|---|---|---|---|
| B1 | `models/Accountant_model/Acc_MasterModels.js` | `Acc_Ledger`: **no schema change needed** for `creditPeriodDays`. Add only `creditTermsSource` (`"manual" \| "inherited" \| "default"`) and `creditTermsUpdatedAt` for provenance | Modify (small) |
| B2 | `models/Accountant_model/Acc_BillTerms.js` | **New.** Sidecar due dates for historical open items, so posted vouchers are never rewritten (§C1.6) | New |
| B3 | `models/Accountant_model/Acc_RecurringItem.js` | **New.** Recurring/scheduled outflow register (§C1.8) | New |
| B4 | `services/creditTerms.service.js` + `.test.js` | **New, pure.** Resolve effective terms for a party; derive a due date from `voucherDate + days`; the resolution ladder in §C1.3 | New |
| B5 | `services/openItems.service.js` + `.test.js` | **Done.** Shared service introduced in C0-A (parties list) and extended to cover the ledger-detail statement's per-bill aging/bucketing in **C0-D** (24 Aug 2026), which replaced the inline aggregation in `Acc_chartOfAccounts.js` — see §C1.13. One implementation, no coexistence | Done |
| B6 | `routes/Accountant_Routes/Acc_chartOfAccounts.js` | Add `PATCH /ledgers/bulk-credit-terms` for the 82-party bulk edit, **explicitly whitelisted** (see the warning in §C1.0); add `creditPeriodDays` to the ledger list projection. Do **not** route credit-term edits through the existing spread-based `PUT /ledgers/:id` | Modify |
| B7 | `routes/Accountant_Routes/Acc_parties.js` | Currently **GET-only**. Add `GET /:ledgerId/open-items` and `PATCH /:ledgerId/credit-terms` | Modify |
| B8 | `Acc_vouchers.js` · `Acc_expenses.js` · `Acc_chartOfAccounts.js` · `Acc_import.js` · `Acc_approvals.js` | Default `dueDate` from party terms on **all eight** voucher-creating paths — enumerated in §C1.3.1. Do **not** touch the posted-edit path | Modify (5 files) |
| B9 | `routes/Accountant_Routes/Acc_billTerms.js` | **New.** CRUD for sidecar terms + the backfill preview/apply endpoints | New |
| B10 | `routes/Accountant_Routes/Acc_recurringItems.js` | **New.** CRUD for the recurring register | New |
| B11 | `scripts/backfill-bill-terms.js` | **New.** Dry-run-by-default backfill (§C1.9) | New |
| B12 | `server.js` | Mount B9, B10 alongside the existing accountant routes (~line 1650) | Modify (2 lines) |

### Frontend — `/Users/risheeray/grav-cms`

| # | Path | Change |
|---|---|---|
| F1 | `app/accountant/parties/page.js` (417 L) | Show **Credit days** and open-item count per party; inline edit; the bulk-set flow for 82 parties |
| F2 | `app/accountant/chart-of-accounts/…` ledger editor | Expose `creditPeriodDays` on party ledgers (Sundry Debtors / Creditors only) |
| F3 | `app/accountant/sales-vouchers/new/page.js` (3,592 L) | Default `dueDate` on party select. State and input already exist at lines 142 / 1736 — only the defaulting is missing |
| F4 | `app/accountant/purchase-vouchers/new/page.js` (2,561 L) | Same; state at line 99, input at line 1174 |
| F5 | `app/accountant/invoices/page.js` | Overdue status becomes real once dates exist; show whether a date is **derived** |
| F6 | `app/accountant/…/recurring-items/` | **New** small screen for the recurring register |
| F7 | `app/accountant/customers/page.js` (1,491 L) · `vendors/page.js` (423 L) | **Read-only surface** of the effective credit terms. **Do not** add a second editable field here — see §C1.2 |

All new/edited UI follows **§9.0** (Frost/Sales accounting direction, compact tables, tabular numerals), not the legacy raw-Tailwind idiom.

---

## C1.2 Where `creditDays` should live

### The problem: four party masters, only one joined to money

| Master | Model | Backing screen | Joined to vouchers? | Records |
|---|---|---|---|---|
| **Accounting ledger** | `Acc_Ledger` under Sundry Debtors/Creditors | `/accountant/parties` | **Yes** — `ledgerEntries[].ledgerId` | 441 ledgers; **82** hold open items |
| CMS customer | `Customer_Models/Customer` | `/accountant/customers` | No | — |
| CMS vendor | `CMS_Models/Inventory/Vendor-Buyer/Vendor` | `/accountant/vendors` | No | — |
| Sales CRM account | `CMS_Models/Sales/Account` (`creditDays`, line 230) | `/sales/dashboard/accounts` | No | **0 records** |

Verified: neither `Customer` nor `Vendor` carries any link to `Acc_Ledger`.

### Decision

> **`Acc_Ledger.creditPeriodDays` is the single source of truth for accounting credit terms.**

Because it is the only master the forecast can actually reach: the forecast reads vouchers, vouchers reference `ledgerId`, and `ledgerId` points at `Acc_Ledger`. Terms held anywhere else require a join that does not exist.

Three consequences, stated so they are not rediscovered later:

1. **`Account.creditDays` (Sales) is not merged and not synced.** It is a *commercial negotiating position* owned by Sales; `creditPeriodDays` is an *accounting parameter* used to date an obligation. They will legitimately differ — Sales may agree 45 days while accounts still runs an old 30. Two-way sync between modules with different owners produces silent overwrites. When Sales accounts exist (currently 0), Sales' figure may be offered as a **suggested default** during party setup, copied once, never live-linked.
2. **`Customer` / `Vendor` screens display, never edit.** A second editable field is a second truth. F7 is read-only with a link through to the ledger.
3. **`billAllocations[].creditDays` stays a per-bill override** and already exists ([`Acc_VoucherModels.js:44`](../../models/Accountant_model/Acc_VoucherModels.js)). A one-off 90-day deal on a single invoice must not rewrite the party default.

### Resolution ladder for effective terms

```
1. billAllocations[].creditDays      (this bill overrides everything)
2. Acc_Voucher.dueDate               (explicitly stated on the document)
3. Acc_Ledger.creditPeriodDays       (the party's standing terms)     ← C0's target
4. Group default                     (Sundry Debtors / Creditors — explicit, set by finance)
5. Company default                   (explicit, finance-approved — NO built-in fallback)
```

#### Rungs 4 and 5 are not hidden constants

> **There is no silent 30-day default.** The company default starts **unset**. Finance must set it, in the settings UI, before it can date anything. A number nobody approved must never be allowed to date ₹1.36 crore of historical obligations.

Earlier drafts of this plan said the company default "ships at 30". That is withdrawn. A built-in fallback is dangerous here for reasons specific to this data:

- **It is indistinguishable from a real term once written.** All 208 open items would receive a date derived from a number no human chose, and downstream the forecast would present them with the same visual weight as a negotiated term.
- **It sets the overdue clock.** With the oldest open item dating to **2025-07-17**, a wrong default does not just misplace a date — it decides whether roughly ₹1 crore of receivable reads as current or as a year overdue, and it would do that on the authority of a constant in a source file.
- **Nobody would ever revisit it.** A working default is invisible; it would silently become GRAV's official credit policy.

Required behaviour:

| Situation | Behaviour |
|---|---|
| Company default **unset** | Rungs 4 and 5 do not resolve. A party with no terms yields **no due date** — the item is reported as *undated*, never guessed |
| Backfill run with the default unset | Script **refuses to apply**. Dry run still produces the report, showing exactly how many items cannot be dated and why |
| Setting the default | Explicit settings field, with the value, who set it and when recorded; shown in the backfill dry-run header so the reviewer sees which number is about to be used |
| Group defaults | Same rule — explicit or absent. Debtors and creditors are set separately; they are rarely the same in practice |
| A date derived from rung 4 or 5 | Carries `derivedFrom: "group_default" \| "company_default"` and renders with the **`derived`** flag (§5.2), so it is visibly weaker than a party-level term |

**Undated is an acceptable, honest outcome.** The forecast's `coverage` block (§10.4) is built to report what it could not see. An item excluded for having no defensible date is better than an item included on a fabricated one — the first understates the forecast, the second corrupts it while looking complete.

The winning rung is recorded so the UI can always say **why** a date is what it is — which is what the spec's `derived` flag (§5.2) surfaces.

---

## C1.3 Defaulting due dates on voucher entry

### Present behaviour (verified)

Both forms already have everything except the defaulting:

| Form | State | Input | Submit |
|---|---|---|---|
| `sales-vouchers/new` | `dueDate: ""` (line 142) | line 1736 | `dueDate: form.dueDate \|\| undefined` (line 1476) |
| `purchase-vouchers/new` | `dueDate: ""` (line 99) | line 1174 | line 949 |

Nothing computes a default, which is exactly why coverage is **1/404** on purchases and **3/147** on sales. The field is not missing — it is simply never filled.

### Rule

On **party selection** or **voucher-date change**, if the user has not manually edited the due date:

```
dueDate = voucherDate + effectiveCreditDays(party)
```

Behavioural requirements:

- **Never overwrite a manual edit.** A `dueDateTouched` flag; once the user types, defaulting stops for that voucher.
- **Show the provenance inline** — "Due 23 Sep 2026 · 30-day terms" — so the number is explicable rather than mysterious.
- **Zero terms means no date, not today.** `creditPeriodDays: 0` is the current value on all 441 ledgers and means *unset*, not *due on receipt*. Treating 0 as same-day would date 208 open items to their invoice date and manufacture a fake overdue crisis. Due-on-receipt must be an explicit choice, not the default's shadow.
- **Server-side belt and braces** (B8): if a create arrives with no `dueDate` and the party has terms, the server fills it. Forms are not the only writer — see §C1.3.1, which names all eight paths.
- **Receipts, payments, contra, journal get no due date.** They settle obligations rather than create them; verified that those forms carry `billAllocations` UI but no `dueDate` field, which is correct and should stay.

### C1.3.1 Every voucher-creating path — the exact files to touch

Defaulting in the two forms covers a minority of writers. Grepped for every `Acc_Voucher` create/insert across `routes/`, `services/` and `scripts/`; there are **eight**:

| # | File : line | Route / function | What it creates | Needs defaulting? |
|---|---|---|---|---|
| P1 | [`Acc_vouchers.js:2486`](../../routes/Accountant_Routes/Acc_vouchers.js) | `POST /api/accountant/vouchers/` | The main create used by the sales and purchase forms | **Yes — primary** |
| P2 | [`Acc_expenses.js:474`](../../routes/Accountant_Routes/Acc_expenses.js) | `POST /api/accountant/expenses/` | Expense → voucher | **Yes** if it books to a creditor |
| P3 | [`Acc_chartOfAccounts.js:2183`](../../routes/Accountant_Routes/Acc_chartOfAccounts.js) | `POST /chart-of-accounts/ledgers/:id/transactions` | Quick entry from the ledger screen | **Yes** |
| P4 | [`Acc_chartOfAccounts.js:3424`](../../routes/Accountant_Routes/Acc_chartOfAccounts.js) | `createVoucherWithRetry(...)` helper | Shared creator behind P3 and others | **Yes — best single choke point in this file** |
| P5 | [`Acc_approvals.js:182`](../../routes/Accountant_Routes/Acc_approvals.js) | `applyApprovedAction(reqDoc, approver)` | Materialises an approved request **straight to `status: "posted"`** | **Careful — see below** |
| P6 | [`Acc_import.js:786`](../../routes/Accountant_Routes/Acc_import.js) | `POST /api/accountant/import/sessions/:id/commit` | Tally session commit, single create | **Yes** |
| P7 | [`Acc_import.js:1544`](../../routes/Accountant_Routes/Acc_import.js) | `POST /api/accountant/import/bsheet/commit` | Balance-sheet import, `insertMany(chunk)` | **Yes — bulk** |
| P8 | [`Acc_import.js:3195`](../../routes/Accountant_Routes/Acc_import.js) | `POST /api/accountant/import/combined/commit` | Combined import, `insertMany(chunk)` | **Yes — bulk** |

Notes that change how this is implemented:

- **`Acc_import.js` is the biggest hole.** Three of the eight paths live there, and it was confirmed by grep to set **neither** `dueDate` **nor** `creditPeriodDays` anywhere. The historical 1,581-voucher book came through here, which is a large part of why coverage is 4/551. Left alone, imports keep refilling the hole faster than the backfill empties it (risk C1-R10).
- **P7 and P8 are `insertMany`, not `create`.** Mongoose middleware on `save()` does **not** fire for `insertMany` by default. A `pre("save")` hook is therefore *not* a valid single fix — the two bulk import paths would silently skip it. This is the trap to avoid: one hook, three paths, two of them not covered.
- **P5 does not go through P1.** An approved voucher request is materialised directly from a stored payload with `status: "posted"`. If the payload was captured before defaulting existed, it carries no due date and this path will not add one. Defaulting must happen **when the request is created**, not when it is approved — adding a date at approval time would be writing a date onto a record the approver never reviewed.
- **`services/tallyMapper.service.js:248`** creates **ledgers** (`Acc_Ledger.insertMany`), not vouchers. It is out of scope for due dates but in scope for terms: auto-created party ledgers arrive with `creditPeriodDays: 0`, so every Tally import silently adds untermed parties.

**Recommended shape:** put the derivation in the pure `creditTerms.service.js` (B4) and call it explicitly from each path, rather than relying on a model hook. One tested function, eight named call sites, no invisible middleware — and `insertMany` is then handled by mapping the chunk through the resolver before insert.

---

## C1.4 Backfilling existing open items

**Scope: 208 open items across 82 parties.** All undated.

### Derivation, in priority order

1. `billAllocations[].creditDays` where present → **0 rows qualify** (measured)
2. Party `creditPeriodDays` → available for every party **once C0 step 1 is done** — this is the main path
3. Group default (Debtors / Creditors) — only if finance has set one
4. Company default — only if finance has set one; **there is no built-in fallback**, and an item that reaches this rung with nothing set stays **undated** rather than guessed

`dueDate = firstSeenVoucherDate + days`, where `firstSeenVoucherDate` is the earliest voucher date carrying that `billName` for that ledger — already computed by the existing aggregation.

### Where the backfilled date is written

**Into the `Acc_BillTerms` sidecar (B2), never onto the posted voucher.** Reasoning in §C1.6.

```js
// models/Accountant_model/Acc_BillTerms.js
{
  companyId:      ObjectId,
  ledgerId:       ObjectId,      // the party
  billName:       String,        // matches billAllocations[].billName
  dueDate:        Date,
  creditDaysUsed: Number,
  derivedFrom:    "bill_credit_days" | "party_terms" | "group_default"
                | "company_default" | "manual",
  isManual:       Boolean,       // a person overrode the derived date
  firstVoucherDate: Date,
  backfillRunId:  ObjectId,      // which run produced this — enables clean rollback
  createdBy:      ObjectId,
  createdAt:      Date,
}
// unique index: { companyId, ledgerId, billName }
```

Readers merge with this precedence: **voucher `dueDate` → sidecar → derived-on-the-fly**. A manual sidecar row always wins over a derived one.

### Ordering constraint

Backfill **cannot run before** party terms are set, or all 208 rows fall through to the company default and the exercise produces one uniform, meaningless date. Sequence is therefore: expose the field → set terms for the 82 parties that matter → dry run → apply.

---

## C1.5 What "open item" means in this codebase

Not invented here — this is the **existing** definition, implemented inline in [`Acc_chartOfAccounts.js:1855–1961`](../../routes/Accountant_Routes/Acc_chartOfAccounts.js):

> For a party ledger, take every `billAllocations` entry across **all posted vouchers**, group by `billName`, and sign each amount by its ledger-entry side (`Dr` = +, `Cr` = −). The bill is **open** when the signed sum is non-zero.

With:

- `new_ref` — the original invoice; establishes `originalAmount`
- `agst_ref` — a settlement against it
- `advance`, `on_account` — money not tied to a specific bill

Three properties that matter for C0:

1. **A bill is an aggregate, not a document.** It spans however many vouchers touched that `billName`. Due dates therefore belong to the *bill*, keyed `(ledgerId, billName)` — which is exactly the `Acc_BillTerms` key.
2. **Unnamed allocations are skipped** (`if (!a.billName) continue`). Any allocation without a bill name is invisible to open-item logic and will be invisible to the forecast. This should be *reported* in `coverage`, not silently dropped.
3. **Only `status: "posted"` counts.** Consistent with the budget actuals engine.

**Action:** extract this into `services/openItems.service.js` (B5) and have the chart-of-accounts route call it, rather than writing a second implementation for the forecast. Two implementations of "what is outstanding" will disagree, and the day they do, nobody will know which screen is lying.

**Status: migrated, 24 Aug 2026 (C0-D).** The chart-of-accounts route's inline aggregation has been replaced with calls into this shared service — see the C0-D section of the delivery-status checklist (§C1.13) for the full account, including a per-bill byte-for-byte comparison against the pre-migration output across every ledger with real open bills.

---

## C1.6 Not corrupting posted or locked vouchers

### What the codebase enforces today (verified)

- `cancelled` / `void` vouchers **cannot be edited at all** — hard 400.
- Editing a **posted** voucher requires either `canActDirectly`, or it is routed into an `Acc_ApprovalRequest` ([`Acc_vouchers.js:2012`](../../routes/Accountant_Routes/Acc_vouchers.js)).
- The edit path strips `_id`, `companyId`, `voucherType`, `status`, `autoPost`, `createdBy`, `createdAt`.

### The decision

> **The backfill writes nothing to `Acc_Voucher`. Not one document.**

`dueDate` is not a financial field — it changes no debit, credit, amount or trial-balance figure. That makes it *tempting* to write onto posted records. It should still not be done:

1. A bulk script writing to 200+ posted vouchers **bypasses the approval trail** the module deliberately builds around posted records. The precedent is worse than the benefit.
2. `updatedAt` would move on hundreds of posted vouchers at once, corrupting any audit reading of "what changed recently".
3. A derived date written into the same field as a stated one becomes **indistinguishable from fact** the moment it lands. The sidecar keeps "we inferred this" and "the document says this" permanently separable — which is precisely what the `derived` flag (§5.2) needs to render.
4. Rollback of a sidecar is a collection drop by `backfillRunId`. Rollback of an in-place mutation across posted vouchers is a restore from backup.

### Rules for the backfill script

- **Read-only against `Acc_Voucher`.** Enforced by using a projection-only query; no `save()`, no `updateMany`, no `bulkWrite` against that collection.
- **Dry run is the default.** `--apply` must be passed explicitly; without it the script writes a report and exits.
- **Idempotent** on `(companyId, ledgerId, billName)`; re-running changes nothing.
- **Never overwrite `isManual: true`** rows.
- **Stamped** with a `backfillRunId` so a run can be reverted precisely.
- **Skips** any bill whose voucher set includes a non-`posted` status.

New vouchers are different and unproblematic: they are not yet posted when the form fills `dueDate`, so that path writes to the header normally.

---

## C1.7 Header, bill allocation, or both?

**Both, with distinct and non-overlapping jobs.** They already exist; what is missing is a stated precedence.

| Location | Job | Written by | Status |
|---|---|---|---|
| `Acc_Voucher.dueDate` (header) | The document-level due date for a single-bill voucher — what prints on the invoice | Voucher forms, defaulted from party terms | Exists; 4 of 551 populated |
| `billAllocations[].dueDate` | Per-bill date where one voucher carries several bills on different terms | Bill-wise entry UI | Exists; **0 of 277** populated |
| `Acc_BillTerms` (new) | **Derived** dates for historical open items, and manual overrides, without touching posted records | Backfill script, manual override | New |

**Read precedence:** `billAllocations[].dueDate` → `Acc_Voucher.dueDate` → `Acc_BillTerms` → derive on the fly → none.

Rationale for keeping all three rather than collapsing:

- Header alone cannot express a voucher settling three bills on different terms — and 52 ledgers already run bill-wise.
- Allocation alone loses the printed invoice due date for the ordinary single-bill case, which is most vouchers.
- The sidecar alone cannot represent a date a human actually stated on a document.

Going forward, entry should populate the header always, and the allocation only when bill-wise is on and the bills genuinely differ.

---

## C1.8 Recurring item model

Payroll is the largest and most predictable outflow in the books (₹1,14,05,448 posted to date) and runs on a clean monthly cadence (`payrolls`: Apr/May/Jun/Jul 2026). But `Payroll` carries only `month` + `year` and **no pay date** — so the register must supply the day of month.

```js
// models/Accountant_model/Acc_RecurringItem.js
{
  companyId:   ObjectId,
  name:        String,          // "Monthly payroll", "Factory rent", "GST 3B"
  direction:   "in" | "out",
  kind:        "payroll" | "rent" | "statutory" | "emi" | "subscription" | "other",

  // Amount: fixed, or resolved live from a source
  amountMode:  "fixed" | "from_source",
  amount:      Number,          // when fixed
  sourceRef:   {                // when from_source — e.g. last payroll's totalNetPay
    model: String, field: String, lookback: Number,
  },

  // Cadence
  frequency:   "monthly" | "quarterly" | "yearly" | "weekly" | "one_off",
  dayOfMonth:  Number,          // 1..31; payroll's missing pay date lives here
  monthOfYear: Number,          // for yearly
  weekday:     Number,          // for weekly
  startDate:   Date,
  endDate:     Date,            // null = open-ended

  // Where it lands in the books
  ledgerId:      ObjectId,      // expense/revenue head
  bankLedgerId:  ObjectId,      // which account it moves through
  department:    String,

  confidence:  "scheduled",     // per §5.1 — rule-driven, not counterparty-driven
  isActive:    Boolean,
  lastGeneratedFor: Date,       // dedupe against a real posted voucher
  notes:       String,
}
// index: { companyId, isActive, frequency }
```

Design notes:

- **Month-end safety.** `dayOfMonth: 31` must resolve to the 28th/29th/30th where the month is shorter, never spill into the next month. A recurring rent that silently jumps to 1 March is a forecast that misses February.
- **`lastGeneratedFor` prevents double-counting.** Once October payroll is actually posted, the recurring projection for October must drop out — otherwise the forecast shows payroll twice for the month it is most important to get right.
- **Statutory items are rules, not amounts.** GST 20th, TDS 7th, PF 15th: the date is certain and the amount is computed from the period. Ship the dates as seeded rows with `amountMode: "from_source"`.
- **Seed from history, do not ask.** Populate the register by proposing rows from recurring posted vouchers, and let finance confirm. Requiring 20 rows of manual entry guarantees the register is never filled (§11.2 assumption 8).

---

## C1.9 Migration and backfill plan

No schema migration is required for `creditPeriodDays` — the field exists on all 441 documents with a default of `0`. New collections start empty. Nothing needs rewriting.

| Step | Action | Writes | Reversible |
|---|---|---|---|
| M1 | Add `creditTermsSource` / `creditTermsUpdatedAt` to `Acc_Ledger`; defaults only | none | n/a |
| M2 | Create `Acc_BillTerms`, `Acc_RecurringItem` with indexes | none | drop |
| M3 | Ship the UI (F1, F2) so terms are visible and editable | none | n/a |
| M4 | **Finance sets terms for the 82 parties holding open items** — bulk-set by group, then correct the exceptions | `Acc_Ledger` only | per-field |
| M5 | `node scripts/backfill-bill-terms.js` **dry run** — a CSV of all 208 proposed dates for review | none | n/a |
| M6 | Review with finance. The oldest bill dates to **2025-07-17**; some will backfill as long overdue and that must be a deliberate acceptance, not a surprise | none | n/a |
| M7 | `--apply` — writes `Acc_BillTerms` only, stamped with a `backfillRunId` | new collection only | delete by run id |
| M8 | Ship voucher-entry defaulting (F3, F4, B8) | new vouchers only | n/a |
| M9 | Seed the recurring register from proposals; finance confirms | new collection only | delete |
| M10 | Verify the C0 exit criterion: **>80% due-date coverage on open items** | none | n/a |

**M4 before M5 is not negotiable** — see §C1.4. **No step writes to `Acc_Voucher`.**

---

## C1.10 Test plan

Following the repo convention — pure services under `node --test`, per `budgetVariance.service.test.js`.

### `creditTerms.service.test.js`

- Resolution ladder returns the right rung, and **names** it, at each level
- `creditPeriodDays: 0` means **unset**, never "due today" — the trap in §C1.3
- `null` / `undefined` / `""` days do not become `0` (the `Number(null) === 0` bug this codebase has hit repeatedly)
- `new Date(null)` never becomes the epoch
- Month-end arithmetic: 31 Jan + 30 days lands correctly across a leap year
- Negative or absurd credit days (`-5`, `100000`) are rejected, not stored

### `openItems.service.test.js`

- Signed aggregation: `new_ref` Dr increases, `agst_ref` Cr decreases
- A fully settled bill (sum 0) is **not** open
- The ₹1 tolerance excludes rounding dust but not a real ₹2 balance
- Unnamed allocations are skipped **and counted**, never silently dropped
- Non-posted vouchers are excluded
- A bill spanning several vouchers aggregates into one item
- **Golden test:** against the live shape, the service reproduces **208 open items, 100 Dr / 108 Cr** — parity with the existing inline implementation before it is replaced

### `recurringItems.service.test.js`

- `dayOfMonth: 31` resolves to 28/29/30 in short months and never spills forward
- `lastGeneratedFor` suppresses a projection once the real voucher is posted
- `endDate` terminates the series; open-ended continues
- Quarterly/yearly land on the right months

### Backfill script

- **Dry run writes nothing** — asserted by count before/after on every collection
- Idempotent: second `--apply` changes zero documents
- `isManual: true` rows survive a re-run untouched
- **`Acc_Voucher` is byte-identical before and after** — the single most important assertion in this chunk
- Rollback by `backfillRunId` removes exactly what that run created

### Integration / manual

- Party select on both voucher forms defaults the date; a manual edit is never overwritten afterwards
- Receipts/payments still show no due-date field
- Invoices page overdue status becomes correct, and marks derived dates as derived
- Permission check: a non-owner cannot bulk-edit credit terms

---

## C1.11 Rollout plan

| Stage | What ships | Gate |
|---|---|---|
| **R1** | Read-only visibility: credit days and open-item count on `/accountant/parties` | Finance can see the 82 parties and the ₹99.4L / ₹36.4L position |
| **R2** | Editing: inline + bulk credit terms | Terms set for parties covering ≥90% of open value |
| **R3** | Entry defaulting on new vouchers | Coverage on **new** vouchers >80% for two weeks |
| **R4** | Backfill dry run → finance review → apply | Sign-off on the CSV, particularly the pre-2026 items |
| **R5** | Recurring register seeded and confirmed | Payroll, rent and statutory dues present |
| **R6** | **C0 exit gate** — >80% coverage on open items; recurring register populated | The forecast-engine chunk may begin |

Two sequencing rules:

- **R3 before R4.** Fix the leak before bailing out the boat, or the backlog regrows while it is being cleared.
- **R6 is a real gate.** Per R1 in §11.1, starting the forecast-engine chunk before this holds produces an empty screen and permanent loss of confidence.

Rollback: R1–R3 are additive and revert cleanly. R4 reverts by `backfillRunId`. No stage mutates existing accounting data except `Acc_Ledger.creditPeriodDays`, which is per-field revertible.

---

## C1.12 Risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| C1-R1 | **Backfill writes to posted vouchers**, bypassing the approval trail | **Critical** | Sidecar only (§C1.6); test asserts `Acc_Voucher` is unchanged |
| C1-R2 | **`creditPeriodDays: 0` read as "due on receipt"**, instantly making all 208 items overdue and the forecast hysterical | **Critical** | 0 means unset; due-on-receipt is an explicit separate value; unit-tested |
| C1-R3 | **Backfill runs before terms are set** → 208 identical default-derived dates that look authoritative and are not | **High** | M4 gates M5. The company default has **no built-in value** and must be explicitly finance-approved, so an unset default makes the script refuse to apply rather than fall back. Even once set, the script refuses when >20% of items would land on it |
| C1-R4 | **Manufactured overdue crisis.** The oldest open item dates to 2025-07-17; backfilling makes ~₹1cr appear as aged debt overnight | **High** | Dry-run CSV reviewed with finance (M6); ageing presented as *information*, not as new alarms; no notifications fire from the backfill |
| C1-R5 | **Two sources of credit terms** (Sales `Account.creditDays` vs `Acc_Ledger.creditPeriodDays`) drift | **Medium** | One source of truth (§C1.2); Sales value may seed once, never sync; other screens read-only |
| C1-R6 | ~~Two open-item implementations disagree.~~ **Resolved in C0-D (24 Aug 2026).** `Acc_chartOfAccounts.js`'s `GET /ledgers/:id/statement` handler no longer carries its own aggregation — it calls `openItems.billsByLedger` + `openItems.agedBillsForLedger`, the same shared service the parties list has used since C0-A. There is now exactly **one** canonical open-item implementation; a future third consumer (backfill, forecast) has one place to call, not a second definition to write | **Closed** | Golden parity re-verified through the migrated code path: **208 / 100 Dr / 108 Cr**, exact match. Per-bill output additionally compared byte-for-byte against the pre-migration formula across every ledger with real open bills (25 tested) — see §C1.13's C0-D entry |
| C1-R7 | **Unnamed bill allocations are invisible** — currently skipped silently | **Medium** | Count and report them in `coverage`; surface as a data-quality list |
| C1-R8 | **Recurring register is never filled**, so the largest predictable outflow is missing | **Medium** | Seed from history as proposals; do not require manual entry (§11.2 assumption 8) |
| C1-R9 | **Payroll double-counted** once real vouchers post | **Medium** | `lastGeneratedFor` dedupe; explicit test |
| C1-R10 | **Imports keep creating dateless vouchers.** Verified: the Tally import path sets neither `dueDate` nor `creditPeriodDays` | **Medium** | Apply the same server-side default (B8) to the import path, not only to form submissions |
| C1-R11 | **Concurrent edits** — another session is actively modifying accounting components | **Low** | C0's frontend surface is `parties`, chart-of-accounts and two voucher forms; coordinate before touching shared chrome |

---

## C1.13 Delivery status

C0 is being delivered in slices. Only **C0-A** has been implemented.

### C0-A — Terms visibility ✅ **DONE** (24 Aug 2026)

Read-only. No editing, no backfill, no voucher defaulting, no recurring items, no forecast engine.

- [x] `services/openItems.service.js` — **shared open-item service introduced, and now the ONLY open-item implementation.** Used by the parties list from the start; the chart-of-accounts route's inline aggregation (was [`Acc_chartOfAccounts.js:1861`](../../routes/Accountant_Routes/Acc_chartOfAccounts.js)) was migrated onto it in **C0-D** (24 Aug 2026) — see §C1.13 for the migration record. No second implementation remains
- [x] `services/openItems.test.js` — 23 tests; suite **446 passing**
- [x] **Golden parity against live data: 208 open items · ₹99,42,397 receivable · ₹36,40,465 payable · 82 parties** — matches the independent count in §C1.0 Finding B exactly
- [x] `creditPeriodDays` added to the parties list projection, **read-only**
- [x] `Acc_parties.js` remains **GET-only** — no write verb introduced
- [x] Parties list shows credit days, an explicit **"Not set"** state, open-item count, and receivable/payable kept apart
- [x] Forecast-readiness strip showing how many parties with open items lack terms, **explicitly labelled page-scoped** ("Forecast readiness on this page" / "not a company-wide total") — the aggregation covers only the ledgers on screen and moves with pagination
- [x] `unnamedAllocations` surfaced as a coverage caveat (currently **0** in this dataset)
- [x] No voucher data read as anything but read-only; nothing written to `Acc_Voucher`

#### Frontend dependency — do not revert the redesign primitives

The C0-A parties UI is built on Accounting-redesign primitives already present in the worktree:

| Component | Path | Used for |
|---|---|---|
| `AcctPageSlab` (+ `SlabAction`, `SlabGhost`) | `components/accountant/ui/AcctPageSlab.js` (256 L, tracked) | The page slab and its header actions |
| `PageContainer`, `PageHeader` | `components/accountant/ui/PageShell.js` (241 L, tracked) | Page container and heading |

Both are imported at the top of `app/accountant/parties/page.js`. They arrived with the broader Accounting redesign, not with C0, and they are the concrete expression of the Frost/Sales direction §9.0 requires.

> **Do not revert or remove these primitives.** Reverting them breaks the C0-A parties screen outright — the imports resolve to nothing and the page fails to render. If the redesign is rolled back for other reasons, the parties page must be migrated in the same change, not left pointing at absent modules.

Noted because this work spans a worktree where the Accounting redesign is being developed in parallel; C0 consumes those primitives and does not own them.

### C0-B — Terms editing

**C0-B1 — Safe single-party editing ✅ DONE, corrected (24 Aug 2026).** One party at a time. No bulk edit yet.

- [x] `PATCH /api/accountant/parties/:ledgerId/credit-terms` — the dedicated endpoint. `Acc_parties.js` gains exactly this one write verb; every other route in the file stays GET-only
- [x] **No `req.body` spreading.** `services/creditTerms.service.js#buildUpdate` assembles the `$set` field-by-field from a fixed whitelist (`EDITABLE_FIELDS = ["creditPeriodDays"]`); any other key in the body is **refused with 400**, not silently dropped — verified for `openingBalance`, `nature`, `groupId`, `companyId`, `name`, and `creditLimit` (deliberately *not* editable in this slice)
- [x] `creditPeriodDays` validated: integer, `0..365`, rejects negative/absurd/non-numeric/boolean/object/NaN/Infinity/fractional input
- [x] **`0` (and empty/blank) means unset** — stored as `0` with `creditTermsSource: null`, never read as "due on receipt"
- [x] Provenance — `creditTermsSource`, `creditTermsUpdatedAt`, `creditTermsUpdatedBy`, `creditTermsUpdatedByName` — added to `Acc_Ledger` and written **server-side only** (from `req.user` and `new Date()`); a client cannot set these directly, verified by test
- [x] Permission-gated via `creditTerms.canEditTerms(req.user)`, a pure tested predicate requiring `permissions.canEdit === true`; missing/malformed permission objects refuse rather than default open
- [x] **Company-scoped.** `companyId` is required on the request (body or query, matching the GET routes' convention) and BOTH the lookup and the update filter by `{ _id: ledgerId, companyId }` together. A ledger id from another company resolves to nothing — not a 500, not an accidental cross-company write. *(Fixed 24 Aug 2026 — the first cut looked up by `_id` alone, unlike every read route in this file.)*
- [x] **Frontend sends the raw, uncoerced string.** `saveTerms()` posts `{ creditPeriodDays: termsDraft, companyId: activeCompanyId }` — no client-side `Number()`. *(Fixed 24 Aug 2026 — the first cut sent `Number(termsDraft)`, and `JSON.stringify(NaN)` serialises to `null`, so a typo like "abc" would have silently arrived as "please clear this term" instead of failing. The backend's own parser is now the only thing that decides validity.)*
- [x] **No voucher mutation** — the endpoint touches only `Acc_Ledger`; grep-verified zero `Acc_Voucher` references in the diff, and a route test asserts the voucher collection has zero documents after a PATCH
- [x] **No due-date writes** — grep-verified zero `dueDate` writes in the diff
- [x] **No `Acc_BillTerms` writes** — that model doesn't exist yet; backfill is **C0-F** (renamed twice: was C0-C, then C0-D, when earlier drafts of this line were written)
- [x] Frontend: inline click-to-edit on the Credit days cell on `/accountant/parties`, opening a small single-party modal (no bulk UI). Copy states plainly that this controls **accounting due-date defaulting**, not a commercial term. "Not set" renders for `0`/null; the input treats blank or `0` as clearing the term
- [x] After save, the edited row is patched in place (id-matched), so the readiness strip recomputes without losing the caller's page/search
- [x] `services/creditTerms.test.js` — 31 tests (0-is-unset, negative, absurd, non-number/boolean/object, valid values, unrelated-field refusal incl. `companyId`, provenance-never-from-body, unauthorized refusal)
- [x] `test/accountant/parties-credit-terms.route.test.js` — **new.** 14 HTTP-level tests against a real (in-memory) MongoDB via the existing Jest + `mongodb-memory-server` harness, the one part of this correction pure unit tests cannot cover: missing/malformed/wrong `companyId` all refuse and leave the document untouched; a valid `companyId` saves; the raw-string contract survives an actual JSON round trip; garbage/negative/absurd input is rejected AND an existing term is provably unchanged afterward; a read-only role is refused; no voucher document exists after any of it
- [x] Pure suite: **477 passing** (`node --test`, was 446). Route suite: this file's 14/14 pass; the rest of the pre-existing Jest suite is unaffected (7 pre-existing, unrelated CRM/HR-AI failures confirmed present with this change stashed out — not introduced here)

- [ ] `creditLimit` editable (deliberately excluded from C0-B1/C0-B2)

**C0-B2 — Safe bulk editing ✅ DONE (24 Aug 2026).** An explicit selection of parties, one shared value, applied in one call.

- [x] `PATCH /api/accountant/parties/bulk-credit-terms` — dedicated endpoint, distinct from the single-party one. `Acc_parties.js` now has exactly two write verbs, both `PATCH`, both credit-terms-only; every other route stays GET-only
- [x] **Requires `companyId`** — 400 if absent or malformed, exactly as C0-B1
- [x] **Requires an explicit `ledgerIds` array** — 400 if missing or empty; capped at 500 (the same limit `GET /` already uses for a page), so a bulk edit stays a deliberate, reviewable action rather than a mechanism for editing the whole chart of accounts in one call
- [x] **Fail-closed scope, structurally, not by a checked-then-rejected step.** The only query that can ever write is `Acc_Ledger.find({ _id: {$in: ids}, companyId, groupId: {$in: partyGroupIds} })` — a ledger from another company, or one that isn't a Sundry Debtor/Creditor, is never read for write, so it cannot land in the `updateMany` scope no matter what the request claims. Every requested id that doesn't match comes back in `skipped`, with a reason (`not_found_in_company`, `not_a_party_ledger`, `invalid_id`, `duplicate`) — reconciliation invariant `updatedCount + skipped.length === requestedCount` holds and is tested
- [x] **Reuses `creditTerms.service.js` outright** — the same `buildUpdate` (whitelist + value validation), the same `canEditTerms` permission predicate, the same `CreditTermsError`. Nothing about value validation or the whitelist was reimplemented for bulk
- [x] **No `req.body` spreading.** `companyId` and `ledgerIds` are scope (stripped before validation, since they decide *where* the write lands, not *what* is set); the remainder goes through the same whitelist as C0-B1, so an unrelated field (`openingBalance`, `nature`, `groupId`, …) anywhere in the body refuses the **entire** request with 400, updating nothing
- [x] **The value is validated once, for the whole batch, before any database read.** `creditPeriodDays` is one shared parameter applied to every selected party, not N independent edits — invalid input (garbage text, negative, `>365`) refuses the entire request with zero writes, even when every selected id is otherwise perfectly eligible
- [x] Response returns `updatedCount`, `requestedCount`, `skipped` (id + reason for every id not updated), and `parties` (the full updated record for every id that was)
- [x] Permission-gated identically to C0-B1 (`creditTerms.canEditTerms`)
- [x] **No voucher mutation, no due-date writes, no `Acc_BillTerms` writes** — grep-verified zero references in the diff; a route test additionally asserts zero voucher documents exist after a bulk update and that no `dueDate` field appears anywhere in the response
- [x] Frontend: checkboxes per row + a "select all on this page" header checkbox (selects only what's rendered — not "apply to all filtered results", which stays out of scope); a bulk toolbar appears once something is selected; "Set credit terms…" opens a modal listing the selected parties, one days input, and **required confirmation copy** stating this sets accounting terms only and does not date any existing bill
- [x] After save, every updated row is patched in place; the modal shows a result — updated count plus a legible list of anything skipped and why, since bulk succeeding "mostly" (a stale selection, a bank ledger caught in a select-all) is the normal case, not an edge case to hide behind a toast
- [x] `test/accountant/parties-bulk-credit-terms.route.test.js` — **new.** 19 HTTP-level tests: missing/malformed `companyId`; missing/empty/over-cap `ledgerIds`; a wrong-company ledger skipped and provably untouched (including the all-wrong case, 200 with zero updates); a non-party ledger skipped; malformed id skipped as `invalid_id`; a duplicated id applied once and reported; a fully valid selection updating every member with matching provenance; an unrelated field refusing the whole batch; invalid value refusing the whole batch even against an all-eligible selection, with existing terms on those parties provably unchanged afterward; unauthorized role refused; zero voucher documents and no `dueDate` anywhere in the response
- [x] Pure suite: **477 passing**, unchanged (bulk reuses C0-B1's validation, so no new pure tests were needed beyond what C0-B1 already pinned). Route suite: **33/33** across both accountant route-test files; full pre-existing Jest suite shows the same 7 pre-existing, unrelated CRM/HR-AI failures as before this slice — nothing newly broken

- [ ] **Company and group defaults** explicit and finance-approved; no built-in 30-day fallback — still **C0-F**'s job (renamed twice: was C0-C, then C0-D, when earlier drafts of this line were written — C0-F is the historical-backfill slice)
- [ ] **"Apply to all filtered results"** (beyond the explicit on-screen selection) — deliberately not built; would need its own review
- [ ] Terms set for parties covering **≥90% of the ₹1.36cr open value** — the bulk tool now exists, which is what was missing; the campaign across the 82 parties still hasn't run

### C0-C — Due-date defaulting for new vouchers/imports ✅ **DONE** (24 Aug 2026)

> **Naming note.** Earlier drafts of this checklist used "C0-C" for the historical backfill and "C0-D" for voucher-entry defaulting. This turn's approval reassigned "C0-C" to defaulting, and the naming below follows that — historical backfill is now **C0-D** (unstarted, below). This is also the better build order: default new vouchers before backfilling old ones, so the backlog stops growing while it's being cleared (§C1.9's own M3-before-M4 rule, generalised).

**Scope, as delivered:** default `dueDate` on newly created **sales** and **purchase** vouchers only — the two voucher types that create a fresh payable/receivable bill, matching the codebase's own pre-existing design (only those two forms ever carried a `dueDate` field). Receipts, payments, contra, journals, and credit/debit notes are explicitly excluded — none of them represents a bill obligation with its own due date in this codebase.

- [x] **Pure resolver, exactly as specified**: `dueDate = voucherDate + effectiveCreditDays(partyLedger)`, added to `services/creditTerms.service.js` (`effectiveCreditDays`, `resolveDueDate`) — deliberately the narrowest rung of the forecast spec's full priority ladder; no group/company fallback is invented here
- [x] **`creditPeriodDays: 0` means unset** — reuses the exact `isTermSet` rule from C0-B; no due date defaults from an unset term
- [x] **A manual/existing `dueDate` is never overwritten** — every entry point checks `body.dueDate` first and returns immediately if anything is already there
- [x] **Real bug caught by the tests, fixed before merge**: `new Date(null)` is the Unix epoch, not an Invalid Date — the same trap this codebase has hit in `budgetNegotiation.service.js` and `leadNextAction.js`. `resolveDueDate` now explicitly guards `null`/`undefined`/`""` before ever constructing a `Date`
- [x] **Server-side defaulting applied to every path that actually needs it.** Investigation found only **5 of the 8** paths named in §C1.3.1 can ever produce a `sales`/`purchase` voucher — `Acc_expenses.js` (P2) only creates `payment`/`journal`, and both callers of `Acc_chartOfAccounts.js`'s `createVoucherWithRetry` (P3, P4 — payroll posting and ledger-transfer/reclass) only create `journal`/`payment` too. Wiring those three would have been dead code; §C1.3.1 flagged them as uncertain ("Yes if…") and this turn resolved the uncertainty by reading the code rather than guessing:
  - **P1** `POST /api/accountant/vouchers/` — the primary create route
  - **P5** `Acc_approvals.js`'s `applyApprovedAction`, `kind:"voucher" action:"create"` only — the sibling `action:"post"` branch materializes an already-fully-formed draft and needs nothing
  - **P6** `POST /import/sessions/:id/commit` — single-row Tally import
  - **P7** `POST /import/bsheet/commit` — bulk `insertMany`
  - **P8** `POST /import/combined/commit` — bulk `insertMany`
- [x] **`insertMany` handled correctly** — P7/P8 use a synchronous variant (`defaultDueDateSync`) fed by a party ledger already resolved in memory, rather than an async per-voucher lookup inside a loop that can run hundreds of times; the two `.select()` projections (plus three related fallback/refresh reads) that build those in-memory ledger maps were widened to include `creditPeriodDays`
- [x] Frontend: `app/accountant/sales-vouchers/new` and `purchase-vouchers/new` preview the due date live as the party/date change, with a hint naming the credit-period source; a manual edit (including clearing the field) permanently stops the preview from touching it for that voucher. **The preview decides nothing** — it's a client-side mirror of the same resolver, and the server computes and enforces its own default independently on save
- [x] `services/creditTerms.test.js` — resolver tests: **+11** (defaults from terms, no terms→no date, month/year rollover, UTC-not-local-time arithmetic, the epoch-trap regression)
- [x] `services/voucherDueDateDefault.test.js` — **new**, 16 tests: eligible-type allowlist, manual-value short-circuit (both sync and async, proven to skip the lookup entirely), ineligible types never default, missing/invalid party invents nothing, session pass-through for the transactional approval path (stubbed — see below)
- [x] `test/accountant/voucher-due-date-default.route.test.js` — **new**, 14 HTTP-level tests against a real in-memory MongoDB: due date defaults from party terms (sales AND purchase, symmetric); no terms → no date; a manual due date survives even when the party has different terms; a missing/invalid/absent party invents nothing; receipts and payments never get a due date even against a termed party; **P7 exercised as a genuine end-to-end import** (not a mock) — a sales voucher with a termed party defaults, a purchase voucher with an untermed vendor doesn't, in the same commit; a dedicated test proves creating new vouchers and editing an unrelated party's credit terms never changes an already-posted voucher's `dueDate` or `updatedAt`
- [x] **P5 is source-verified, not HTTP-tested**, and this is disclosed rather than glossed over: `applyApprovedAction`'s voucher-create branch runs inside a real Mongo multi-document transaction, and `mongodb-memory-server`'s default single-node instance — the same instance this repo's entire Jest harness (`test/setup.js`) runs on — cannot execute transactions ("Transaction numbers are only allowed on a replica set member or mongos"). That's a pre-existing constraint of `applyApprovedAction`, not something introduced here. Standing up a second, replica-set-mode Mongo for one branch, or rewriting the shared harness all 20+ existing suites depend on, would be disproportionate to one call site whose actual logic (`defaultDueDateOnVoucherBody`) is the same function already proven end-to-end at P1. What's verified instead: a source-inspection test confirms the call is present, in the correct branch, strictly before the voucher is persisted, with the transaction's `session` threaded through — and a unit test with a stubbed `Acc_Ledger` proves `opts.session` genuinely reaches the query builder
- [x] **P6/P8 wiring confirmed by source inspection** alongside the P1/P7 behavioral proof, rather than a third near-identical `insertMany` HTTP fixture that would exercise no new code path
- [x] Pure suite: **504 passing** (was 477 before C0-C; +11 resolver, +16 wrapper). Accountant route suites: **47/47** across all three files. Full pre-existing Jest suite: same 7 pre-existing, unrelated CRM/HR-AI failures as every prior slice — confirmed nothing new broke
- [x] **No historical backfill, no `Acc_BillTerms` writes, no posted-voucher mutation** — grep-verified: `Acc_BillTerms` is referenced nowhere (the model still doesn't exist — correct, that's **C0-F**'s job); no backfill script was written; nothing in this diff calls `findByIdAndUpdate`/`updateOne`/`updateMany` against an existing voucher

#### Correction — company-scope the lookup (24 Aug 2026, before final approval)

The first cut of `defaultDueDateOnVoucherBody` resolved `Acc_Ledger.findById(body.partyLedgerId)` — by `_id` alone, with no company filter. A `partyLedgerId` that happened to belong to a **different** company would still resolve, and that company's `creditPeriodDays` would leak into this voucher's defaulted due date. This is the exact same class of bug C0-B1's credit-terms PATCH route was corrected for one slice earlier (every read in `Acc_parties.js` filters `{ _id, companyId }` together, never `_id` alone) — caught here before merge rather than after.

- [x] `defaultDueDateOnVoucherBody` now **requires** `body.companyId`; missing or unparseable ⇒ no default is computed, and the database is **never even queried** (verified: a stub that throws if called proves the gate exits first)
- [x] The query is `Acc_Ledger.findOne({ _id: partyId, companyId }, ...)` — `{ _id, companyId }` together, matching every other party-scoped read in this codebase
- [x] `defaultDueDateSync` gained a defensive check: if **both** `partyLedger.companyId` and `body.companyId` are present and they **differ**, nothing defaults. If either side is absent, the check does not block — it only refuses a *proven* mismatch, since the sync callers' `ledgerByName` map is itself already company-scoped at the read that built it (real defence in depth, not the primary boundary)
- [x] The two `.select()` projections powering P7/P8's `ledgerByName` maps (plus the three related fallback/refresh reads, five in total) were widened to include `companyId` alongside the `creditPeriodDays` added earlier — otherwise the new defensive check would always see `partyLedger.companyId` as `undefined` and never actually compare anything
- [x] ObjectId-vs-string comparison uses `String(...)` on both sides, not `===` — an ObjectId instance and its string form (or two separate ObjectId instances of the same id) are never `===` equal, which would otherwise misreport a genuine match as a mismatch and silently disable a legitimate same-company default
- [x] Tests added — 5 required, delivered across both files at the appropriate level of rigor:
  1. **Same-company party terms default the due date** — dedicated HTTP test through the real route (`test/accountant/voucher-due-date-default.route.test.js`)
  2. **Wrong-company party id does not default** — HTTP test with two genuinely separate companies; company B's termed party is referenced from company A's voucher body, the voucher still creates (an unresolved/wrong-company party is never a reason to reject the voucher), no due date is set, and company B's ledger is confirmed untouched
  3. **Missing `companyId` does not default** — unit-tested, not HTTP-tested, and that choice is documented inline: P1's own route already refuses any request with no `companyId` with a 400 before it can reach the service, so there is no real HTTP path through this route that reaches the defaulting logic with a missing `companyId` — the case is real for other/future callers, which is exactly what the unit test (stubbed `Acc_Ledger.findOne` that throws if reached) isolates
  4. **Sync variant refuses a proven mismatch** — plus the flip sides tested alongside it: proceeds when both match, proceeds when only one side carries a `companyId` at all (not a mismatch — an absence), and proceeds correctly when the same id is represented as an ObjectId instance on one side and a string on the other
  5. **Manual `dueDate` still wins** — reconfirmed under the new company-scoped code path specifically (both HTTP, with company scoping genuinely active, and at the unit level, proving the manual-value check still runs strictly before the company gate is ever evaluated)
- [x] `services/voucherDueDateDefault.test.js`: **16 → 25** tests (+9)
- [x] `test/accountant/voucher-due-date-default.route.test.js`: **14 → 17** tests (+3)
- [x] Pure suite: **513 passing** (was 504). Accountant route suites: **50/50**. Full pre-existing Jest suite: same 7 pre-existing, unrelated failures — unchanged
- [x] **No other behavior changed**: scope (sales/purchase only), the manual-value-always-wins rule, the 0-means-unset rule, and which 5 call sites are wired are all exactly as before this correction

### C0-D — Open-item consolidation ✅ **DONE** (24 Aug 2026)

> **Naming note.** This slot was previously the un-lettered "Follow-up — open-item consolidation" item, carried over from C0-A ("two implementations currently coexist," §C1.0 Finding). This turn's instructions named it **C0-D**, which collided with the label the historical-backfill slice had been using since the C0-C correction. Backfill is relettered to **C0-F** below (content unchanged, still not started) — the same rename-and-disclose pattern used for the two earlier letter collisions in this document.

**Goal:** one canonical open-item definition, used by (1) `/accountant/parties`, (2) the ledger-detail statement, and (3) later backfill/forecast work — not three implementations that can silently drift apart.

- [x] **Inline aggregation found and replaced.** `Acc_chartOfAccounts.js`'s `GET /ledgers/:id/statement` handler (~L1848–L1985) carried its own copy of the bill-fold-and-age logic. That block now calls `openItems.billsByLedger(...)` + `openItems.agedBillsForLedger(...)` and assembles the exact same `billWiseOutstanding` response object — the route file no longer owns any open-item arithmetic of its own
- [x] **Response shape preserved exactly**: `{ applicable, totalOutstanding, closingType, bills: [{ billName, firstDate, dueDate, creditDays, originalAmount, remaining, remainingAbs, remainingType, daysOverdue, bucket, voucherCount }], agingBuckets: { current, "0-30", "31-60", "61-90", "90+" }, bucketTotals: { current, d0_30, d31_60, d61_90, d90Plus } }` — every key name, including the odd `d0_30`/`d90Plus` casing the frontend already reads, is untouched
- [x] **The pre-existing settled-threshold inconsistency was preserved, not fixed.** The ledger-detail view has always treated a bill as settled below ₹0.01 (`LEDGER_DETAIL_SETTLED_THRESHOLD`); the parties-list summary uses the shared ₹1 `SETTLED_TOLERANCE`. Unifying the two would be a behaviour change — out of scope for a migration — so `openItems.service.js` now holds both thresholds explicitly, named and documented, rather than silently picking one
- [x] **`dueDate`/`creditDays` capture-only-at-first-encounter preserved exactly** — the inline code set these fields once, on the first allocation row seen for a bill, and never updated them from later rows (not "earliest dueDate," not "most complete row wins"). `foldAllocations` now replicates this literally; a bill's due date genuinely differing across rows would have shown the FIRST one before this migration and shows the FIRST one after
- [x] **Unnamed bill allocations counted/reported consistently** — an allocation with no `billName` still moves the ledger's real balance but cannot be grouped into a bill; it now surfaces the same way it always did, as part of the "Opening / Unallocated" reconciliation line that keeps `totalOutstanding` equal to the ledger's actual closing balance. A dedicated HTTP test posts an on-account receipt with zero bill allocations and confirms the gap reconciles rather than vanishing
- [x] **Golden parity — exact match, re-verified against live data through the fully migrated code path**: **208 open items · ₹99,42,397 receivable (100 bills) · ₹36,40,465 payable (108 bills)**. Zero drift
- [x] **Per-bill parity — proven separately and more rigorously than the summary-level count.** Every ledger in the company with real open bills (25 tested, including a 30-bill case) was run through both the OLD inline formula (independently re-implemented for comparison) and the NEW `agedBillsForLedger` at the same instant, and the two outputs were `JSON.stringify`-compared **byte-for-byte identical** — not just matching totals, but matching bucket, `daysOverdue`, `voucherCount` and field ordering on every bill
- [x] **Service consolidated, not duplicated further.** `openItemsByLedger` (the parties-list summary) and the new `billsByLedger` (per-bill detail, feeding the ledger-detail view) now share one Mongo aggregate (`fetchAllocationRows`, internal) and one fold (`foldAllocations`) — the widened `$project` (adding `dueDate`, `creditDays`, `voucherNumber`) costs the summary path nothing, since `summariseByLedger` simply ignores fields it doesn't read
- [x] `services/openItems.test.js`: **23 → 41** tests (+18) — `dueDate`/`creditDays` first-encounter capture, `voucherNumbers` accumulation and de-duplication, all four bucket boundaries (0/30/60/90 days) tested explicitly, the reconciliation line (gap present, gap absent, non-number `closingBalance`), sort order, and a response-shape assertion that would fail if a key were ever renamed or dropped. One PRE-EXISTING test was corrected rather than left to silently pass for the wrong reason: "no due date is invented" previously asserted the `dueDate` key didn't exist at all on a folded bill; now that `foldAllocations` legitimately READS a stored due date (never DERIVES one), the correct invariant is that the key may exist but its value is never fabricated when the source had none — the test was rewritten to check that, not deleted
- [x] `test/accountant/ledger-statement-bill-wise.route.test.js` — **new**, 6 HTTP-level tests against a real in-memory database: the full response shape; a fully-settled bill correctly drops off the list; a partial payment reduces `remaining` without closing the bill; an unnamed on-account receipt reconciles via the Unallocated line rather than disappearing; a non-party ledger (a bank ledger) never gets `billWiseOutstanding` at all (still `null`); multiple open bills sort by days overdue
- [x] Pure suite: **531 passing** (was 513). Accountant route suites: **56/56** across all four files. Full pre-existing Jest suite: same 7 pre-existing, unrelated CRM/HR-AI failures as every prior slice
- [x] **No backfill, no `Acc_BillTerms`, no due-date writes, no voucher mutation, no forecast engine, no recurring items** — grep-verified: zero `Acc_BillTerms` references, zero new voucher-write calls in the diff, zero new write routes added to `Acc_chartOfAccounts.js`. This was a read-path migration only

#### Cleanup pass — stale docs + a real scoping gap in the shared service (24 Aug 2026)

Two corrections, both scoped to C0-D only — no C0-E/C0-F work included.

**1. Stale documentation fixed.** Three places still described the migration as pending after it had landed:

- **C1-R6**, the risk this exact concern was tracked under, said "two implementations disagree" and "is a LIVE condition" — now marked resolved, with the golden-parity and per-bill byte-for-byte comparison cited as the closing evidence
- The **B5** file-plan row said "still outstanding (C0-D); until then the two coexist" — updated to Done
- One line under C0-C said "backfill is C0-D" — a leftover from before backfill was relettered to **C0-F**; corrected

**2. A real company-scoping gap in `services/openItems.service.js`, found and fixed.** `fetchAllocationRows(companyId, ledgerIds)` — the one query both `openItemsByLedger` and `billsByLedger` share — used to do `if (cid) match.companyId = cid;`: when `companyId` was missing or malformed, it silently ran the aggregation **without** a company filter at all, matching on `ledgerIds` alone across every company's vouchers, rather than refusing. This is the same class of gap C0-B1's credit-terms write and C0-C's due-date defaulting were both corrected for — a read whose figures feed the parties list, the ledger statement, and later forecast/backfill work deserves the same "can't verify the scope → return nothing" discipline as a write does.

- [x] `fetchAllocationRows` now **fails closed**: `castId(companyId)` must succeed or the function returns `[]` before any query is built — verified structurally, not just by an empty result, with a spy proving `Acc_Voucher.aggregate` is never even called on the missing/malformed path
- [x] Both public entry points (`openItemsByLedger`, `billsByLedger`) inherit the fix automatically — neither has its own copy of the scoping logic to fall out of step
- [x] **Valid companyId behavior unchanged** — golden parity re-verified through the exact same live-data check used in every prior C0-D verification: **208 / ₹99,42,397 / ₹36,40,465**, exact match; both real callers (`Acc_parties.js`'s validated query param, `Acc_chartOfAccounts.js`'s `ledger.companyId`, a schema-required field) always supply a real ObjectId, so neither real code path is affected
- [x] `test/accountant/openItems-company-scoping.test.js` — **new**, 7 tests against a real in-memory database: `null`/`undefined`/malformed/empty-string `companyId` all return zero rows from both entry points, with the aggregation spy confirming it never runs; a wrong-but-validly-shaped `companyId` paired with another company's real ledger id returns nothing (no leak); the correct scope for that same ledger still finds it; a string-form `companyId` (not an ObjectId instance) works identically to a cast one; an empty `ledgerIds` array short-circuits before the company check is even reached
- [x] Pure suite: **531 passing**, unchanged (no new pure tests — the fix is entirely in Mongo-touching code, tested at the Jest/DB level, per this codebase's own convention for anything that needs a live query). Accountant route suites: **63/63** across all five files (was 56, +7). Full pre-existing Jest suite: same 7 pre-existing, unrelated failures — unchanged
- [x] **No voucher creation, due-date defaulting, `Acc_BillTerms`, backfill scripts, recurring items, or forecast engine code touched** — the diff for this pass is exactly `services/openItems.service.js` (one function), one new test file, and this doc

### C0-E — Recurring items ✅ **Mechanism DONE (24 Aug 2026)** — register only; seeding from history NOT built

- [x] Register holds payroll, rent, EMI, utilities, statutory dues and an `other` catch-all

The predictable future cash movements that exist nowhere in the books until someone posts them. C0-F can only ever date money **already invoiced**; a forecast built from open items alone would show a company with no salary bill and no rent. This slice is the other half of the input, and nothing more — **Chunk 1's forecast engine remains not started**, and no projection, scenario, chart, confidence band or alert was built.

**A collision checked before anything was written.** `Acc_CashFlowAdjustment` already existed and sounded adjacent. It is a genuinely different concept and there is no overlap: it holds manual rows explaining **historical** cash on the Cash Flow report, is scoped by `organizationId` (not `companyId` like the rest of C0), carries **signed** amounts, and runs an approval lifecycle. This register describes the **future**, is `companyId`-scoped, keeps amounts as unsigned magnitudes with `direction` carrying the sign, and has no approval flow. Neither reads the other.

- [x] **`models/Accountant_model/Acc_RecurringItem.js`** — new, and the ONLY collection this slice writes. Fields exactly as specified, plus the two indexes asked for: `{companyId, status, nextDueDate}` (the forecast's own future read — equality prefix then range scan) and `{companyId, type, status}` (the register screen, and the grouping a projection would explain a figure by)
- [x] **`services/recurringItems.service.js`** — pure validation, same pure/Mongo split as `creditTerms`/`voucherDueDateDefault` and `billTermsBackfillPlanner`/`Orchestrator`. Whitelisted `buildCreate`/`buildUpdate`, strict parsers that refuse booleans/objects/arrays rather than coercing them, and the `new Date(null)`-is-1970 trap guarded explicitly again
- [x] **`routes/Accountant_Routes/Acc_recurringItems.js`** — `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id`, mounted at `/api/accountant/recurring-items`. Auth on every route, `canEdit` on every write, `{_id, companyId}` together on every by-id read and write, fail-closed on a missing/malformed `companyId`, no `req.body` spreading anywhere
- [x] **`app/accountant/recurring-items/page.js`** (frontend) — dense table on the existing Frost/Sales primitives (`AcctPageSlab`, `PageShell`'s `Badge`/`EmptyState`/`NoCompanySelected`), reachable from **Admin → Recurring Items** in the accountant sidebar. Add/edit/pause/resume/end, `?status=`-backed "Show ended" toggle, and the required empty state ("No recurring items yet."). No chart, no projection, no hero marketing page
- [x] **Starter chips PREFILL, they never create.** Payroll / Rent / EMI / GST-TDS / Utilities open the add form with type, direction, frequency and a typical day filled in — and `amount` deliberately BLANK, so no number nobody chose can reach the register. The screen says so in as many words: "These only prefill the form — nothing is created until you save it"
- [x] **Settings → Cash-flow Readiness** now carries the optional line — "Recurring items: N active · Manage" linking to the register. Best-effort and read-only: a failed lookup renders nothing rather than blocking the preview beside it. This is the ONLY C0-F change in this slice

**Three design decisions worth stating rather than burying:**

1. **`nextDueDate` AND `dayOfMonth`/`dayOfWeek` are both stored, and are deliberately NOT cross-validated.** They answer different questions: `nextDueDate` is the next *occurrence* (which a forecast reads directly), the day field is the recurrence *rule* (for everything after). The case that proves they must be separate is month-end — "rent on the last day" is `dayOfMonth: 31`, and a projector that derives the rule from an already-clamped `nextDueDate` of 28 Feb emits the 28th forever after, the classic recurring-date drift bug. Requiring them to agree would also reject two legitimate cases: a pro-rated or deferred **first** occurrence, and any month-end rule mid-clamp. Both are pinned by tests.
2. **A day field that does not apply to the frequency is REFUSED, not ignored.** A monthly item carrying `dayOfWeek` means the sender misunderstood the schedule; storing-and-ignoring leaves a row that reads to the next person as though a weekday rule were in force. Same "refuse rather than silently drop" rule the unknown-key check applies, extended to keys that are known but nonsensical here.
3. **DELETE is a SOFT delete to `status: "ended"`.** A register whose rows a forecast reads should not be able to lose an input silently — "we stopped paying that rent in March" is information a projection wants, where a hard-deleted row leaves an unexplained gap. `?status=` lets the UI hide ended items without the data being destroyed to achieve it.

**Two traps this slice had to get right, both tested:**

- **`dayOfWeek: 0` is Sunday — a REAL value, not "unset".** This is the exact opposite of the "0 means unset" rule `creditPeriodDays`/`defaultCreditDays` follow everywhere else in C0, and any reader doing `if (!dayOfWeek)` silently turns every Sunday schedule into a missing one. Guarded with explicit presence checks in the service, `?? ""` (not `|| ""`) in the form, and pinned by both a pure test and an HTTP test that proves it survives JSON encoding and a real save.
- **`source` is server-owned and absent from the create whitelist.** A client that could set `seeded_from_history` on something a person typed would be claiming an origin the data does not have — the same provenance lie `creditTermsSource` is protected against. C0-E only ever writes `"manual"`; seeding from history (the other enum value, declared now so it needs no migration later) is **not built**.

- [x] **A real bug found by the tests, not by inspection.** `rejectCoercibles` refuses every object — and a `Date` **is** an object, so `buildUpdate` re-reading a stored `Date` from mongoose to validate a merged result was refusing perfectly good data. Fixed by handling `Date` instances first, on their own terms, before the coercible check.
- [x] Tests: **52 pure** (`services/recurringItems.test.js`) + **42 HTTP** (`test/accountant/recurring-items.route.test.js`, 32 at first ship → 42 after the correction pass below) against a real in-memory database. Covering every required case plus: company-scoped list isolation, a wrong-company update/delete refused with the document proven untouched, soft-delete proven to leave the row *present* with its history intact, merge-then-validate on frequency switches, and structural scope guards asserting the router **requires** no voucher/bill-terms/forecast model and the service exports no projection function
- [x] Pure suite: **609 passing** (557 → 609; +52). Accountant route suites: **145/145** across nine files — of which **+32 are this slice's**; the other new arrivals are `budgets.route.test.js`'s 11, which belong to the separate budget-alignment work and were simply passing alongside
- [x] **Scope guard proof** — no forecast engine, no projection, no scenario code, no chart, no confidence band, no alert; zero `Acc_Voucher` writes and zero `Acc_BillTerms` writes (asserted behaviourally against real collections AND structurally against the router's imports); C0-F code unchanged except the one optional readiness line; **Chunk 1 still not started**
#### Correction pass — three fixes before approval (24 Aug 2026)

**1. The optional ledger link is now VERIFIED, not cast.** The first version did `ledgerId = castId(ledgerId)` in the route, which had two failure modes and neither was visible to anyone: an unparseable id became `null`, so a typo was accepted as "no ledger linked" and reported as a successful create; and a well-formed id belonging to a **different company** was stored verbatim, quietly creating a cross-company reference inside a company-scoped collection. Now a supplied id must be well-formed **and** resolve through `Acc_Ledger.findOne({_id, companyId})`, or the whole write is refused — `400 INVALID_LEDGER_ID` and `400 LEDGER_NOT_IN_COMPANY` respectively. **400, not 404**, deliberately: the record being addressed is the recurring item, and a 404 here would read as "the item is missing" when the item is fine and one field of the request is not.

- [x] **`ledgerName` is now server-derived whenever an id is supplied** — the body's value is ignored and the matched ledger's real name is stored, so a client cannot label a link to "Freight & Forwarding" as "Director's Loan Account". A free-text `ledgerName` with **no** id is still allowed: that is a plain label for an item whose posting account nobody has decided yet, and it cannot misrepresent a link that does not exist.
- [x] **The subtler half of the same hole is closed too**, and was not on the brief's list: a **name-only** PATCH on an item that is *already* linked would have let the label drift from the id it belongs to. The update now resolves the link from the body's id when present and from the **stored** id otherwise, so any item that ends up with a ledgerId has its name re-derived from that ledger. Unlinking (`ledgerId: ""`) clears the name with it, rather than leaving a snapshot pointing at a ledger the item no longer references.
- [x] **The scope-guard test earned its keep.** It asserts the router's model imports as an exact list, so adding `Acc_MasterModels` (read-only, purely to verify the link) **failed the test** and forced the addition to be an explicit, recorded decision rather than a silent widening. The list was updated deliberately; the guard worked as designed.
- [x] Route tests: **+10** covering every case on the brief plus the extras above — valid same-company link stores the ledger's own name; malformed id rejected with nothing created; non-existent id rejected; wrong-company id rejected on **both** create and update with the document proven unmodified; body `ledgerName` proven unable to spoof a supplied id; name-only PATCH proven unable to spoof an existing link; free-text label with no id still accepted; unlink clears both fields

**2. "Money in / Money out" replaced with "Inflow / Outflow"** throughout the register — the table cell, its tooltip, and the form's direction select. The model has always called the field `direction` with values `inflow`/`outflow`; the UI was using a second vocabulary for the same thing.

**3. The slab's rupee aggregate is gone, replaced by counts.** It previously summed active outflows and labelled the total "per cycle". That figure was not a real quantity: it added a ₹42,000 **weekly** payout to a ₹8,00,000 **monthly** payroll and a **yearly** premium as though they were commensurable. Relabelling it was offered as an option and rejected — no label fixes a number that is meaningless until something normalises the frequencies onto a common period, which is precisely the forecast engine's job (**Chunk 1, still not started**). Showing it with a caveat would have been a confident-looking wrong number, the exact failure mode this document keeps refusing elsewhere. The slab now reads **Outflows / Inflows / Paused / Active schedules**, all counts, with the note "amounts differ by frequency".

- [x] Reran as asked: `node --test services/recurringItems.test.js` → **52/52**; `npx jest test/accountant/recurring-items.route.test.js --runInBand` → **42/42** (32 → 42; +10)
- [x] Verified live against the dev database at zero cost: malformed and non-existent ids both refused with the right codes; a real ledger linked and its name stored; a deliberately spoofed `ledgerName` overwritten with the ledger's actual name ("AMC/Repairs & Maintenance Expense"); the corrected slab and Inflow/Outflow wording confirmed on screen. Probe rows deleted afterwards — the register is back to 0 documents
- [x] **Still in scope, still untouched**: no forecast engine, no scenarios, no charts, no projections, no alerts, no seeding, no occurrence generation. **Chunk 1 remains not started**

- [ ] **Seeded from history — NOT built.** The original C0-E line said "seeded from history"; only the manual register exists. The `seeded_from_history` enum value is declared so that slice needs no migration, but nothing writes it. Deriving recurring items from posted-voucher patterns is genuinely separate work (it has to decide what counts as a pattern, and how confident it must be before asserting one), and inventing it inside a register slice would have produced exactly the confidently-wrong data this document keeps refusing elsewhere

### C0-F — Historical due-date backfill ⚠ **Mechanism DONE, corrected (24 Aug 2026); coverage target NOT met — see below**

*(Renamed from C0-D — see the naming note above.)*

> **Correction pass, same day.** The first cut treated an existing `Acc_BillTerms` row as purely informational — a bill it had already dated still showed as `to_apply` on every later preview, forever. That made coverage numbers permanently misleading: apply could genuinely be running and writing correctly, and the readiness screen would never show it. Fixed below; see "Correction — the sidecar is now a real dated source" after the main record.

**Scope, as delivered:** a safe sidecar backfill path — plan, preview, apply, rollback — that gives historical open bills due dates without ever writing to `Acc_Voucher` or `billAllocations`. No forecast engine, no recurring items, no charts/UI projection; none of those were touched.

- [x] **`models/Accountant_model/Acc_BillTerms.js`** — new. Keyed `{ companyId, ledgerId, billName }` with a unique index; stores `dueDate`, `source` (`party_terms` \| `company_default` \| `manual` — the last reserved for a future human-override feature, not written by C0-F), `creditDaysUsed`, `basisDate`, `backfillRunId`, `isManual`, and provenance (`createdBy`/`createdByName`/`updatedBy`/`updatedByName`, timestamps). This model is the only write target C0-F touches
- [x] **`Acc_Company.defaultCreditDays`** added — `null` by default, no built-in fallback number. Required for the planner's company-default rung to ever fire; did not exist anywhere in the codebase before this slice
- [x] **Pure planner** (`services/billTermsBackfillPlanner.service.js`) — **the corrected seven-rung ladder** (see the correction record below for what changed and why): `billAllocations[].dueDate` → voucher-header `dueDate` → an existing sidecar row (`Acc_BillTerms`) → no basis date (blocks either derivation rung identically) → party terms (always outrank the company default when set) → company default unset (blocked, never guessed) → company default (derives only when explicitly set). Reuses `creditTerms.isTermSet`/`resolveDueDate` directly rather than re-implementing "0 means unset" a fourth time
- [x] **Orchestrator** (`services/billTermsBackfillOrchestrator.service.js`) — company-scoped and **fail-closed from the start** (not a correction pass this time — built to the standard C0-B1/C0-C/C0-D's hardening passes established): a missing/malformed `companyId` returns an empty plan/result, never an unscoped query
- [x] **Preview** — `GET /api/accountant/bill-terms/backfill/preview?companyId=...`. Read-only; returns `rows`/`toApply`/`blocked`/`alreadyDated`, `totals` (by source, by blocked reason), `coverage.before`/`.after`, and a `confirmationToken`
- [x] **Apply** — `POST /api/accountant/bill-terms/backfill/apply`. Requires `companyId` + the `confirmationToken` from a preview; **recomputes the plan fresh** and refuses with `409 STALE_PLAN` if the token doesn't match — the only way to produce the right token is to have just asked for a live plan, which also protects against applying against data that moved since preview. Writes only `to_apply` rows; a `blocked` row (including one that depends on an unset company default) is never written, full stop — it stays undated in the same call that successfully dates everything else
- [x] **A design gap found and fixed before shipping, by the tests, not after**: the first version of `applyPlan` unconditionally upserted every row in the plan on every call. A second run of an UNCHANGED plan would still silently re-stamp every row's `backfillRunId` onto the new run — which would have made `rollback` imprecise (rolling back the *second*, no-op run would have deleted the *first* run's genuinely-dated rows too, since their provenance had been silently reassigned). Fixed: a row whose stored `dueDate`/`source`/`creditDaysUsed` already matches the proposal is left **completely untouched** — not re-written with identical values. `written` now means "rows this call actually changed"; a new `unchanged` count reports the rest. This is what makes rollback's "only that run's records" promise actually true rather than true-until-a-second-apply
- [x] **Idempotent, precisely**: re-running an identical apply writes 0 documents (`written: 0, unchanged: 1`), never duplicates (enforced structurally by the model's own unique index, not just by application logic), and never moves an unrelated row's provenance
- [x] **A genuine change re-derives correctly** — when a party's credit terms are edited between two runs, the second run's apply DOES re-derive and re-stamp with its own `backfillRunId`, proven directly against the no-op case above so the two behaviors can't be confused
- [x] **Never overwrites a manual override — now protected at the PLANNING stage, not only at write time.** A row with `isManual: true` is classified `already_dated` by the planner itself and never even reaches `toApply` — `applyPlan`'s own `isManual` check (which counts into `skippedManual`) is now a second, defensive line rather than the only one, for the case where a plan is stale or hand-constructed
- [x] **Rollback** — `POST /api/accountant/bill-terms/backfill/rollback`, `{ companyId, backfillRunId }`. `deleteMany({ companyId, backfillRunId })` — proven to delete only the named run's rows (a second, later run's rows survive a rollback of the first) and to never touch `Acc_Voucher`
- [x] **Wrong-company data cannot leak** — party-ledger resolution, the bill fetch, and every write are scoped by `companyId` together with the relevant id, never by id alone; proven by explicitly passing another company's real ledger id while scoped to company A and confirming zero rows result, and by confirming applying against A never writes into B's `Acc_BillTerms`
- [x] **`Acc_Voucher` provably unmodified** — `Acc_Voucher` is not even `require`d by any of the three new production files (the model, the two services, the route); grep-verified. A route test additionally asserts a specific voucher's document is **deep-equal, byte-for-byte, including `updatedAt`**, before vs. after an apply that dates its bill, and that neither the voucher header's `dueDate` nor `billAllocations[].dueDate` are ever populated by this slice
- [x] `services/billTermsBackfillPlanner.test.js` — **26 pure tests** (post-correction; see below for the count history): every rung of the corrected seven-rung ladder individually, including the sidecar-matching logic's four distinct outcomes (matches current terms → already-dated; manual → always already-dated regardless of mismatch; genuinely changed → falls through to to_apply; terms since cleared with nothing new to propose → stays already-dated on the stored value), `creditPeriodDays`/`companyDefaultCreditDays` of `0`/negative/absent read as unset at both rungs, open-only filtering, mixed-batch categorisation across every already-dated source plus to_apply and blocked, coverage arithmetic correctly counting sidecar-dated bills, zero-bills edge case, malformed input tolerance
- [x] `test/accountant/bill-terms-backfill.route.test.js` — **17 HTTP-level tests** (post-correction) against a real in-memory database, covering every item on the required list **plus** the five newly-required cases: a second preview after a successful apply shows the bill already dated by sidecar, not toApply; coverage before/after reflects sidecar dates; a manual sidecar row is already-dated and never proposed for write; a non-manual sidecar row whose value already matches is not proposed again; the changed-terms behaviour remains intentionally tested (kept, and still passes unmodified by this correction). Also still covering: preview writes nothing; apply writes only `Acc_BillTerms`; apply refuses per-row without a company default; wrong-company data cannot leak; rollback deletes only that run's records; posted vouchers unchanged
- [x] Pure suite: **557 passing** (531 → 550 at first C0-F ship → 557 after this correction). Accountant route suites: **80/80** across six files. Full pre-existing Jest suite: same 7 pre-existing, unrelated CRM/HR-AI failures — unchanged
- [x] **No forecast engine, no recurring items, no charts/UI projection** — grep-verified: no `Acc_RecurringItem` reference, no frontend file touched, the only cross-reference to "forecast" in the new files is a doc-comment citation, not implementation

**A design decision worth surfacing, not just implementing silently — unchanged by this correction:** the spec says apply "refuses if company default is unset and any row depends on it." This was built as a **per-row** refusal — a bill that needs the unset default is never written, while other bills in the *same* apply call that don't need it (already dated, or covered by party terms) still succeed. The alternative reading — refuse the entire request if *any* row is blocked on this — was considered and rejected, because it directly conflicts with requirement 4's own framing: "if a row cannot be dated honestly, it stays undated" describes a property of *individual rows*, and an operator with 200 party-termed bills and 8 untermed ones should not have the 200 blocked by the 8. If the intended contract was the stricter all-or-nothing read, that is a one-line change to `applyPlan` and easy to make — flagging it here rather than guessing silently either way. Named again here because "keep the current partial-apply behaviour if you believe it is the right choice, but document it explicitly" was reaffirmed as an instruction for this correction pass — it is unchanged, and remains explicitly documented as **partial apply**: dateable rows are written, blocked rows remain undated in the same call, and the C0 coverage target is not passed until it is actually met.

#### Correction — the sidecar is now a real dated source, not an FYI (24 Aug 2026)

**The bug.** `Acc_BillTerms` rows were fetched only as a `Set` of keys, used solely to set an informational `alreadyBackfilled` flag. The actual `already_dated`/`to_apply`/`blocked` classification never consulted them — so a bill this collection had already dated correctly still showed as `to_apply`, forever, on every subsequent preview. Apply itself was idempotent (thanks to the `unchanged`-skip logic from the immediately preceding correction), so it never duplicated writes — but *coverage*, the number a person actually reads to know whether the backfill worked, could never move past whatever it was before the very first successful apply. A working write path behind a permanently-wrong readiness screen.

**The fix — three files, one coherent change:**

- [x] **`services/openItems.service.js`** — the voucher HEADER's own `dueDate` (a genuinely different field from `billAllocations[].dueDate`) is now projected and folded onto each bill as `voucherDueDate`, first-non-null-value-wins across the bill's several vouchers (deliberately not "first row wins" — that rule exists for `dueDate`/`creditDays` to match an already-shipped implementation; this field has no such precedent, and "first row" could miss a real header date sitting on a later-iterated voucher). This closes rung 2 of the read precedence documented since §C1.7 (`billAllocations[].dueDate` → `Acc_Voucher.dueDate` → sidecar → derive → none) — built, not skipped, despite the correction request's own "if already exposed" qualifier giving room to defer it; it was a one-line addition to an aggregation already touching the field, not new infrastructure. **41 → 41 tests, unchanged count** (additive field, existing coverage still holds); **golden parity re-verified, exact 208/9,942,397/3,640,465 match**
- [x] **`services/billTermsBackfillPlanner.service.js`** — rewritten to a genuine seven-rung ladder (see the updated bullet above). The sidecar rung's logic is the real content of this fix:
  - a **manual** sidecar row is *always* already-dated, never re-evaluated against current terms, never overwritten — even when current terms would derive something completely different
  - a **non-manual** sidecar row is already-dated only while it still matches what current terms would derive right now; the moment terms change enough to produce a different date, source, or credit-days figure, the bill correctly falls through and becomes `to_apply` again — preserving "a genuine change may update a non-manual row" as a real, live behaviour, not a one-time event
  - a non-manual sidecar row that has **lost its derivation basis entirely** (terms cleared since the original run, nothing to compare against) still counts as already-dated on its stored value — losing today's justification does not retroactively un-date a bill; the stored fact stands until something *new* replaces it
- [x] **`services/billTermsBackfillOrchestrator.service.js`** — `fetchExistingBillTermsKeys` (a `Set`) replaced by `fetchExistingBillTerms` (a `Map` of the full row: `dueDate`, `source`, `creditDaysUsed`, `basisDate`, `isManual`), exactly as required — the planner cannot decide "does this still match" or "is this protected" from a bare key
- [x] **A visible source/count added, as required**: `totals.alreadyDatedBySource = { bill_allocation_due_date, voucher_due_date, bill_terms }`, alongside the existing `bySource` (for `to_apply`) and `byBlockedReason`. Every already-dated row also carries its own `alreadyDatedSource` and, when sourced from the sidecar, the sidecar's own `source`/`creditDaysUsed`/`isManual`
- [x] **Live production data confirms the fix has real, immediate effect** — a zero-risk dry-run preview (no writes) went from the previous correction's flat **0.0% coverage** to **1.4%** (3 of 208 open bills), purely because rung 2 now surfaces three vouchers that already carried a header due date the old ladder never looked at. Nothing about the underlying data changed; the ladder simply stopped ignoring data it already had access to. Golden 208/100/108 figures unaffected — this is additional information layered on the same open-item definition, not a redefinition of it
- [x] Tests updated per the required list, all five: a second preview after a successful apply shows the bill already dated by sidecar source, not `toApply`; coverage before/after correctly counts sidecar-dated bills; a manual sidecar row is proven already-dated and structurally unreachable by the write path (`skippedManual: 0` because it never got that far, not because it was caught late); a non-manual sidecar row whose value matches is proven not proposed again; the changed-terms test from the previous correction pass was re-run **unmodified** and still passes, proving the new sidecar-matching logic and the old genuine-change logic are the same code path now, not two competing ones
- [x] **No forecast engine, no recurring items, no C0-E, no UI charts** — this correction touched exactly three backend service files, their test files, and this doc

- [x] **≥80% due-date coverage — MET (100%) on 24 Aug 2026 by running the backfill. See the activation record below.** The text that follows describes the state BEFORE that run and is kept as the record of why it was blocked: at the time, of the **208 open items**, **3** were recognised as already dated (via voucher header due dates the previous version of this ladder could not see), and **0** had any credit-terms basis to derive from — **0 of 441 ledgers have `creditPeriodDays` set** (the C0-B tooling exists; the campaign to actually use it across the 82 parties holding open items still has NOT run), and `Acc_Company.defaultCreditDays` was `null` with no settings UI to set it from (fixed by the UI/admin slice below). The preview then reported **3 already dated, 0 to-apply, 205 blocked, 1.4% → 1.4% coverage** — correct output for that data, not a defect. Verified against live production data at zero risk (a genuine dry-run preview, no writes): of the **208 open items**, **3** are now correctly recognised as already dated (via voucher header due dates the previous version of this ladder could not see), and **0** have any credit-terms basis to derive from — **0 of 441 ledgers have `creditPeriodDays` set** (the C0-B tooling exists; the campaign to actually use it across the 82 parties holding open items has not run — a standing finding since C0-A), and `Acc_Company.defaultCreditDays` is a field that started `null` with no settings UI to set it from (fixed by the UI/admin slice immediately below). The live preview accordingly reports **3 already dated, 0 to-apply, 205 blocked, 1.4% → 1.4% coverage** — the correct output given the current data, not a defect in the backfill. This checkbox stays unchecked until either the party-terms campaign runs (C0-B's tooling) or someone with the authority to do so sets a company default — a business decision, not a code change, and explicitly out of scope for "C0-F only"

#### C0-F UI/admin slice — making the mechanism reachable (24 Aug 2026)

C0-F's backfill mechanism and its correction were both complete but invisible: `Acc_Company.defaultCreditDays` had no writer, and the preview/apply/rollback endpoints had no screen. This slice is UI/admin only — no forecast engine, no recurring items, no scenarios, no charts, no change to any planner/orchestrator logic.

- [x] **`PATCH /api/accountant/tally/companies/:id/default-credit-days`** (`routes/Accountant_Routes/Acc_companies.js`) — the only writer of `defaultCreditDays`. Reuses `creditTerms.parseCreditDays` directly (same rule as the party-level editor: `""`/`null`/`undefined`/`0` all clear to `null`, `1..365` stores, everything else — negative, fractional, >365, boolean, object, array, non-numeric string — is rejected). Whitelist-only body (`defaultCreditDays` is the only accepted key, no `req.body` spreading), gated by `creditTerms.canEditTerms` (not owner-only — carved out of this router's pre-existing owner-only gate, which the rest of the file keeps), scoped by `_id` (the company itself is the tenant boundary). Provenance (`defaultCreditDaysUpdatedAt/By/ByName`) added to `Acc_Company`'s schema, written from the authenticated user and the clock, never trusted from the body. **22 new HTTP tests** (`test/accountant/companies-default-credit-days.route.test.js`): valid save, string coercion, clear via `""`/`null`/`0`, all seven rejection shapes, unsupported-field refusal, missing-field refusal, read-only-role refusal, no-auth refusal, malformed/non-existent/cross-company id handling, and a scope guard proving neither `Acc_Voucher` nor `Acc_BillTerms` is ever touched by this endpoint
- [x] **Settings → Credit Terms** (`app/accountant/settings/page.js`) — a new tab beside the existing eight. Shows the active company's name and current `defaultCreditDays` (empty when unset), saves through the endpoint above, and refreshes `CompanyProvider` on success so the value updates everywhere else in the app immediately. Copy states plainly: "Used only when a party has no credit terms. Does not edit posted vouchers."
- [x] **Settings → Cash-flow Readiness** (same file) — a read-mostly window onto the existing `GET/POST /api/accountant/bill-terms/backfill/*` endpoints, built with the existing Frost/Sales settings primitives (`Section`, `Badge`, `StatCard` from `PageShell`). "Refresh preview" calls preview and renders: coverage before/after, total open items, already-dated/to-apply/blocked counts, the `alreadyDatedBySource` breakdown (bill allocation date / voucher due date / bill terms sidecar), the `bySource` breakdown (party terms / company default), the `byBlockedReason` breakdown (no basis date / company default unset), and a dense table (bill, party/ledger, amount, status, source or reason, proposed due date) covering every row the plan returns. Party/ledger names are a best-effort client-side join against `GET /chart-of-accounts/ledgers` — display only; nothing in the preview/apply/rollback flow depends on it, and a lookup failure just falls back to the raw ledger id. "Apply reviewed dates" is disabled until `toApplyCount > 0`, sends the preview's own `confirmationToken` unmodified, and is gated behind a confirmation dialog reading: "This writes due dates to `Acc_BillTerms` only — N open items will be dated. Posted vouchers are never modified." Status/source language throughout uses "open items", "due-date coverage", "blocked", "ready to backfill" — no "money in/out" phrasing anywhere on this screen, per instruction
- [x] **Live-verified end to end, then rolled back cleanly.** Set the dev company's default to 45 days through the new UI → live preview correctly jumped from 1.4% to a projected 100% coverage (205 of the 208 previously-blocked bills instantly became `to_apply` under `company_default`) → confirmed the apply dialog's copy and gating → applied for real against the local dev database → preview correctly showed 208/208 already-dated, 0 to-apply, 0 blocked, with the new company-default rows correctly labelled `bill_terms (sidecar)` and the 3 pre-existing voucher-header rows correctly left alone. Then rolled back via `POST /backfill/rollback` (205 deleted, confirming that endpoint too) and cleared the test default back to unset, restoring the dev database to its pre-verification state — `Acc_BillTerms` back to 0 documents. This was the same local dev database this document's other live-data findings were measured against, so it was left exactly as found rather than polluted with synthetic due dates
- [x] **No forecast engine, no recurring items, no scenarios, no charts, no C0-E** — this slice touched one backend route file, one model file (provenance fields only), one test file, and one frontend page. `billTermsBackfillPlanner.service.js` and `billTermsBackfillOrchestrator.service.js` are unchanged by this slice
- [x] Pure suite: **557 passing** (unchanged — this slice added no pure-service tests, since none of the new logic is pure decision logic). Accountant route suites: **102/102** across seven files (was 80/80 across six; +22 for the new endpoint)

### Cross-cutting

- [x] All new UI in the Frost/Sales accounting direction (§9.0) — compact table, tabular numerals
- [x] Pure services unit-tested per repo convention; full backend suite green

---

## C1.14 Original definition of done — C0 (full slice)

- [ ] `creditPeriodDays` visible and editable on party ledgers; bulk-set available
- [ ] **Credit-term writes are explicitly whitelisted** (`creditPeriodDays`, `creditLimit` only), validated `0..365`, and go through the dedicated endpoints — never the spread-based `PUT /ledgers/:id`
- [ ] Provenance recorded (`creditTermsSource`, `creditTermsUpdatedAt`), **set server-side**, never accepted from the request body
- [ ] **Company and group defaults are explicit and finance-approved**; no built-in 30-day fallback exists in code, and an item that reaches an unset default stays **undated** rather than guessed
- [ ] Backfill **refuses to apply** while the company default is unset
- [ ] Terms set for parties covering **≥90% of the ₹1.36cr open value**
- [ ] `openItems.service.js` extracted; golden test pins **208 / 100 Dr / 108 Cr**; the chart-of-accounts route consumes it
- [x] `Acc_BillTerms` populated for open items; **≥80% due-date coverage** — 205 rows written 24 Aug 2026, coverage 1.4% → **100%**
- [ ] **`Acc_Voucher` provably unmodified** by the backfill
- [ ] Backfill reversible by `backfillRunId`; re-run is a no-op
- [ ] Voucher entry defaults due dates from party terms across **all eight** creating paths (§C1.3.1) — including the three in `Acc_import.js`, two of which are `insertMany` and will not fire a `pre("save")` hook
- [ ] Manual edits never overwritten
- [ ] Recurring register holds payroll, rent, statutory dues, seeded from history
- [ ] All new UI in the Frost/Sales accounting direction (§9.0)
- [ ] Pure services unit-tested per repo convention; full backend suite green
