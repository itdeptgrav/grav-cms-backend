# Accounting Custom Reports — semantic contract audit

> **Slices B1 and B2 are implemented** (26 September 2026). §2 and §3 describe
> the defects as they were found; what shipped is recorded in **§16**, and the
> contract Lane A should consume is **§17**. Findings 1, 2 and 8 in the summary
> below are fixed; everything else stands.

**Date:** 26 September 2026
**Scope:** `grav-cms-backend` only. Nothing in `grav-cms` was read except
`docs/accounting-reporting-api-contract.md`, read-only, and nothing there was
changed.
**Behaviour changed by the audit itself:** none — it added two characterization
test files and nothing else. **Slices B1 and B2 were implemented afterwards**
against this document; see §16.
**Evidence:** every figure below was measured on 26 September 2026 against the
running local stack — Metabase v1.63.1, the `reporting` mart in PostgreSQL 16,
the dev MongoDB, and the real routes behind a real Accounting session for
GRAV CLOTHING PVT LTD (5,604 posted voucher lines, 1,776 vouchers). The exact
commands are in §14.

---

## 0. Summary of what is wrong

| # | Finding | Severity | Where |
|---|---|---|---|
| 1 | **FIXED — B1.** The catalogue carried no semantic type: Month, Voucher Date and a future Quarter were all `type: "date"`, so a client had to guess a month from the English word "Month". | **High** | §2, §3, §16 |
| 2 | **FIXED — B2.** A detail cell returns the engine's timestamp (`2025-07-01T00:00:00+05:30`) tagged `display: "date"`. Every client renders a month as a day, and a client outside IST renders it as the **wrong** day. | **High** | §3 |
| 3 | **FIXED — B3.** A summary's `sort` was validated, stored, compiled into MBQL — and then discarded by the matrix. Descending did nothing; sorting by a calculated value did nothing. | **High** | §7.2, §18 |
| 4 | **FIXED — B4.** `previewRowCount` was the group count, not the number of rows returned: 333 ledgers capped at 100 rows answered `100 rows / previewRowCount 333`. | **High** | §8, §19 |
| 5 | **MEASURABLE — B4.** The 100-row preview cap omits 70% of a 333-ledger summary and 85% of its money. It still omits them; the response now says so, and says exactly what they were worth. Whether to draw an "Other" bucket or refuse the chart is Lane A's decision. | **High** | §8, §19 |
| 6 | **FIXED — B5.** XLSX headings were the mart's own column names — `Period Month`, `Group Name`, `Period Month: Day`, `Sum of Debit` — not the user's. Internal column names reached the user's file. | **High** | §9, §20 |
| 7 | **FIXED — B5.** XLSX wrote a month as an Excel date formatted `mmmm d, yyyy` → "August 1, 2025" for a period that is a month. | Medium | §9, §20 |
| 8 | **FIXED — B2.** Voucher Type displays as the raw enum (`credit_note`) although the catalogue ships the label ("Credit Note") in `choices`. | Medium | §4 |
| 9 | `Count` is unreachable for every business entity. No text/date field may enter Values, so "how many vouchers" cannot be asked; the only count available counts **lines** and is headed "Debit". | Medium | §6 |
| 10 | `tax.classification` (GST Classification) is advertised and is **100% NULL** — 5,604 of 5,604 rows. | Medium | §1, §4 |
| 11 | `date.financial_year` is NULL on 944 of 5,604 lines (₹3.63 crore of debit), which groups as "(none)" with no explanation. | Medium | §4 |
| 12 | A detail list is capped at **5 columns** (`MAX_ROWS`), while `MAX_DETAIL_COLUMNS: 20` sits unreachable in the same file. The list-first UI hits this immediately. | Medium | §5 |
| 13 | `GET /custom-reports?companyId=<not yours>` **ignores** the parameter and answers 200; every other route refuses it 403. | Low | §11 |
| 14 | Twelve columns of the source view are neither offered nor recorded as withheld, including `dr_cr` and `is_optional`. | Low | §1.3 |
| 15 | **BOUNDED — B6.** The reported `ERR_EMPTY_RESPONSE` **could not be reproduced**: 5,472 groups, 649–1,078 ms, 200 OK, six concurrent runs fine. What the audit did find is that one legal layout can cost 22 sequential engine queries and a 1.76 MB response. Those layouts are now refused before the engine runs, and a preview has one deadline and a byte ceiling. | — | §12, §21 |

No security defect was found. Every scope, permission and injection probe
behaved correctly (§11).

---

## 1. Complete field inventory

### 1.1 The public contract, exactly as the browser receives it

`GET /api/accountant/reporting/catalog?companyId=…` returns `{ "fields": [...] }`
and nothing else. Every field carries exactly these keys: `id, label, category,
type, description, placements, calculations, filterOperations, comparisons,
compatibleWith, choices, defaultWidth`.

| Public id | Label | Category | Type | Placements | Calculations | Filter operations | Comparisons | Compatible with |
|---|---|---|---|---|---|---|---|---|
| `company.name` | Company | Company | text | rows, columns, filters | — | is, contains, starts_with | — | any |
| `date.voucher` | Voucher Date | Dates | date | rows, columns, filters | — | between, on, before, after | — | any |
| `date.month` | Month | Dates | date | rows, columns, filters | — | between, on, before, after | — | any |
| `date.financial_year` | Financial Year | Dates | text | rows, columns, filters | — | is, contains, starts_with | — | any |
| `voucher.number` | Voucher Number | Voucher | text | rows, filters | — | is, contains, starts_with | — | any |
| `voucher.type` | Voucher Type | Voucher | choice | rows, columns, filters | — | is, in | — | any (14 choices) |
| `voucher.narration` | Narration | Voucher | text | rows, filters | — | is, contains, starts_with | — | any |
| `ledger.name` | Ledger Name | Ledger | text | rows, columns, filters | — | is, contains, starts_with | — | any |
| `ledger.group` | Ledger Group | Ledger | text | rows, columns, filters | — | is, contains, starts_with | — | any |
| `party.name` | Party | Party | text | rows, columns, filters | — | is, contains, starts_with | — | any |
| `amount.debit` | Debit | Amounts | money | rows, values, filters, comparisons | total, average, maximum, minimum, count | equals, greater_than, less_than, between | previous_period, previous_year, other_company × side_by_side, difference, percentage_difference | any |
| `amount.credit` | Credit | Amounts | money | rows, values, filters, comparisons | (as Debit) | (as Debit) | (as Debit) | any |
| `amount.signed` | Signed Amount | Amounts | money | rows, values, filters, comparisons | (as Debit) | (as Debit) | (as Debit) | any |
| `tax.classification` | GST Classification | Tax | text | rows, columns, filters | — | is, contains, starts_with | — | any |

No private key leaks: no `column`, no `temporalUnit`, no view name, no table or
field id (verified by walking every served field, §14).

### 1.2 Internal mapping and measured statistics — **audit only, never served**

Source view for all of them: `reporting.v_general_ledger` (one row per posted,
live `ledgerEntries[]` element). Counts are for GRAV CLOTHING, 5,604 lines.

| Public id | Source column | PG type | Nullable | Nulls (live) | Distinct | Actual semantic meaning | Identifier? | Sensitive? | Safe default chart grouping? |
|---|---|---|---|---|---|---|---|---|---|
| `company.name` | `company_name` | text | yes | 0 | 1 | the company the line belongs to | no | no | yes (very low cardinality) |
| `date.voucher` | `voucher_date` | **date** | yes | 0 | 350 | accounting date of the voucher | no | no | only bucketed |
| `date.month` | `period_month` | **date** | yes | 0 | 15 | **first day of the calendar month** of `voucher_date` | no | no | **yes — the intended time axis** |
| `date.financial_year` | `financial_year` | text | yes | **944** | 2 (+null) | Indian FY label, e.g. `2025-26` | no | no | yes |
| `voucher.number` | `voucher_number` | text | yes | 0 | 1,650 | voucher number **as entered**; 1,607 lines are all-digits and 25 have leading zeroes (`00531`) | **yes** | no | **no — high cardinality** |
| `voucher.type` | `voucher_type` | text | yes | 0 | 8 of 14 | voucher-type enum (`sales`, `credit_note`, …) | no | no | yes |
| `voucher.narration` | `narration` | text | yes | **4,169** | 445 | free text on the line or voucher; max length 190; 252 rows contain non-ASCII | no | no | **no — free text** |
| `ledger.name` | `ledger_name` | text | yes | 0 | 333 | ledger account, resolved through `dim_ledger` | no | no | borderline (333) |
| `ledger.group` | `group_name` | text | yes | 0 | 26 | chart-of-accounts group, resolved through `dim_ledger` | no | no | **yes** |
| `party.name` | `party_ledger_name` | text | yes | **1,781** | 203 | customer/supplier on the voucher header | no | no | borderline (203 + a large null bucket) |
| `amount.debit` | `debit` | numeric(18,2) | yes | 0 | — | debit side of the line; **0.00**, never null, on a credit line (2,524 zeros) | no | no | n/a (a measure) |
| `amount.credit` | `credit` | numeric(18,2) | yes | 0 | — | credit side; 0.00 on a debit line | no | no | n/a |
| `amount.signed` | `signed_amount` | numeric(18,2) | yes | 0 | — | +Dr / −Cr; **sums to exactly 0.00** company-wide | no | no | n/a |
| `tax.classification` | `gst_classification` | text | yes | **5,604 (100%)** | **0** | GST classification of the line — **no data at all** | no | no | no (empty) |

Measured totals: debit ₹14,54,02,590.99 = credit ₹14,54,02,590.99, signed
₹0.00. Largest single amount ₹30,00,000.00; smallest signed −₹30,00,000.00.

List/summary/export support is uniform and follows `placements`: everything
with `rows` is list-capable; everything with `rows`/`columns` is groupable;
only the three money fields are summable. Everything offered is exportable —
the XLSX path runs the same compiled query (§9).

### 1.3 In the view, offered to nobody, recorded nowhere

`WITHHELD` records five columns with reasons (`grand_total`, `opening_balance`,
`gstin`, `organization_id`, `company_id`) and a test asserts they never appear.
Twelve more exist in the view and are simply absent, with no record of a
decision:

`voucher_id`, `voucher_type_name`, `line_no`, `ledger_id`, `party_ledger_id`,
`dr_cr`, `amount`, `is_party_ledger`, `is_optional`, `synced_at`,
`ledger_name_on_voucher`, `ledger_nature`.

Two of them matter for the product:

- **`dr_cr`** (`Dr` 3,080 / `Cr` 2,524) is the natural "Side" field and is
  currently only obtainable by reading the sign of `signed_amount`.
- **`is_optional`** distinguishes Tally's planning-only vouchers. The mart's
  own curated views carry it deliberately so the divergence between the two
  in-app reports is *visible and filterable* (`R__curated_views.sql`) — and the
  builder cannot see or filter it. All 5,604 rows are `false` today, so nothing
  is wrong on screen yet.

`voucher_type_name` is **not** a usable display label: it is null on ~40% of
lines and otherwise mostly a copy of the enum with inconsistent case
(`journal`, `Journal`).

---

## 2. Missing semantic metadata

`type` is a primitive. It answers "how do I align this" and nothing else.

### 2.1 What the catalogue can and cannot distinguish today

| Class asked about | Distinguishable? | How, today |
|---|---|---|
| Voucher Date | partly | `type: "date"` — same as Month |
| **Month** | **no** | only the English label `"Month"` |
| **Quarter** | **n/a and unsupported** | no quarter field exists, and nothing in the contract could express one |
| Financial Year | no | `type: "text"`, same as a ledger name |
| Currency (money) | yes | `type: "money"` |
| **Percentage** | **no** | only as a comparison cell's `display: "percent"`; no field, no `type` |
| Quantity | n/a | no quantity field in this universe |
| **Count** | **no** | a count is a `calculation` on a money field; the result column is headed "Debit" |
| Voucher/invoice number | no | `type: "text"`, same as Narration |
| GST rate | n/a | no rate field; `tax.classification` is a label and is empty |
| Debit / Credit / Signed | partly | all three are `type: "money"`; nothing says one is a signed movement |
| Company | no | `category: "Company"` only |
| Ledger / Ledger Group / Party | no | category only |
| Voucher Type | partly | `type: "choice"` + `choices[]` |
| Status | n/a | not exposed (the mart filters to posted) |
| Boolean | declared, unused | `TYPES.BOOLEAN` exists; no field uses it |
| Identifier | **no** | nothing marks `voucher.number` as an identifier |
| Narration | no | `type: "text"` |

`category` carries some of this by accident — it is a **grouping for the
left-hand panel**, ordered for humans, and using it as a type is how a UI ends
up treating "Dates → Financial Year" as a date.

### 2.2 Proposed metadata

Additive only: every existing key keeps its meaning, so a client that ignores
the new ones behaves exactly as today. Follows the file's existing convention —
built by the `field()` factory, stripped of private keys by `publicCatalogue()`.

```jsonc
{
  "id": "date.month",
  "type": "date",                     // unchanged
  "semanticType": "month",            // NEW — the meaning
  "display": {                        // NEW — how to render and order it
    "format": "month_year",           // "July 2025"
    "sort": "chronological"
  },
  "chart": {                          // NEW — how to chart it
    "defaultGroupingPriority": 30,    // lower is preferred as an axis
    "highCardinality": false,
    "role": "temporal"                // temporal | category | measure | identifier | text
  }
}
```

Proposed values for every field (`priority` = `chart.defaultGroupingPriority`;
`hc` = `highCardinality`):

| Field | `semanticType` | `display.format` | `display.sort` | role | priority | hc |
|---|---|---|---|---|---|---|
| `company.name` | `company` | `text` | `alphabetical` | category | 20 | no |
| `date.voucher` | `date` | `day_month_year` | `chronological` | temporal | 40 | no |
| `date.month` | `month` | `month_year` | `chronological` | temporal | **30** | no |
| `date.financial_year` | `financial_year` | `text` | `chronological` | temporal | 25 | no |
| `voucher.number` | `identifier` | `text_exact` | `natural` | identifier | 95 | **yes** |
| `voucher.type` | `enum` | `choice_label` | `alphabetical` | category | 35 | no |
| `voucher.narration` | `free_text` | `text` | `alphabetical` | text | 99 | **yes** |
| `ledger.name` | `ledger` | `text` | `alphabetical` | category | 50 | yes |
| `ledger.group` | `ledger_group` | `text` | `alphabetical` | category | **10** | no |
| `party.name` | `party` | `text` | `alphabetical` | category | 45 | yes |
| `amount.debit` | `currency` | `currency_inr` | `numeric` | measure | — | — |
| `amount.credit` | `currency` | `currency_inr` | `numeric` | measure | — | — |
| `amount.signed` | `currency_signed` | `currency_inr` | `numeric` | measure | — | — |
| `tax.classification` | `enum` | `text` | `alphabetical` | category | 60 | no |

Reserved for fields that do not exist yet, so the vocabulary does not have to
change when they do: `quarter`, `percentage`, `quantity`, `count`, `gst_rate`,
`boolean`, `status`.

A comparison column's cells already carry `display: "percent"`; with
`semanticType` in the catalogue the matrix can say `semanticType: "percentage"`
on the leaf column too, and no client has to infer it from a heading.

---

## 3. Month, end to end

### 3.1 The live path

```
reporting.v_general_ledger.period_month        PostgreSQL date,
                                               = date_trunc('month', voucher_date)
                                               0 of 5,604 rows disagree
   ↓
Metabase field metadata                        base_type type/Date,
                                               semantic_type NULL  ← Metabase does not know either
   ↓
catalogue                                      { id: "date.month", type: "date" }
                                               (private: column "period_month")
   ↓
MBQL                                           breakout ["field", <id>, null]
                                               no :temporal-unit is ever set
   ↓
result rows                                    "2025-07-01T00:00:00+05:30"
                                               (the instance's timezone; report-timezone is unset,
                                                so the JVM's IST is used)
   ↓
matrix — SUMMARY                               labelOf() → "Jul 2025"      ← correct
       — DETAIL                                cell.value = the raw string,
                                               cell.display = "date"       ← wrong
   ↓
frontend                                       formatCell(value, "date") → "01 Jul 2025"
   ↓
XLSX                                           Excel Date, numFmt "mmmm d, yyyy" → "August 1, 2025"
                                               under the heading "Period Month"
```

### 3.2 Why Month reaches the frontend as `01 Jul 2025`

Because in a **detail list** the backend sends the raw engine value and a
display hint that says *date*. The client is doing exactly what it was told.
The month-ness exists in exactly one place — `matrix.labelOf`, used for
**group labels only** — and never reaches a cell, a leaf column or the
catalogue.

### 3.3 Raw, formatted, or both

**Raw only, in detail mode. Label only, in summary mode.** Neither mode gives
both, and that is the defect:

| | value | display | period key | period label |
|---|---|---|---|---|
| detail cell | `2025-07-01T00:00:00+05:30` | `"date"` | — | — |
| summary row | — (labels are strings) | — | — | `"Jul 2025"` |
| summary column | inside the leaf id: `["2025-07-01T00:00:00+05:30"]::amount.debit:total` | — | — | header `"Jul 2025"` |

A client that wants to sort or bucket a summary row by period has nothing to
sort *by* except the label. A client that wants to display a detail month has
nothing to display *from* except a timestamp.

**The backend can supply all three**, at no query cost: the month key is a
substring of the value it already has, the label is `labelOf`, and the sort
value is the key. Recommended shape in §13, Slice 1.

### 3.4 Financial Year and Quarter

- **Financial Year** has the same class of problem plus one of its own: it is
  `type: "text"`, so a client cannot know it is a period, and it sorts
  alphabetically — which is *accidentally* chronological for `2025-26` /
  `2026-27` and stops being so the moment a label like `FY2025-26` or
  `2025-2026` appears. It is also **null on 944 lines (₹3.63 crore)**, which
  groups as "(none)" with no explanation.
- **Quarter does not exist.** There is no quarter column in the mart, no
  catalogue entry, and no way to ask for one: the compiler never sets an MBQL
  `:temporal-unit`, so a client cannot request quarterly bucketing of
  `date.voucher` either.

### 3.5 Timezone

Three timezones are in play: PostgreSQL is **UTC**, the Node process is
**Asia/Calcutta**, and Metabase's `report-timezone` is **unset** so it uses the
JVM's, reported as **IST**. `voucher_date` and `period_month` are PostgreSQL
`date` columns — no instant, no zone — and Metabase stamps `+05:30` on them on
the way out.

- **Inside the backend: safe.** `formatPeriodLabel` slices the ISO string and
  never constructs a `Date`, so a `+05:30` month cannot become the previous
  one. `compareValues` does parse, but a parsed instant still orders correctly.
  A characterization test pins both (§13, `reporting-semantic-contract.test.js`).
- **Filter boundaries: safe.** Filters are sent as `YYYY-MM-DD` strings against
  a `date` column; all fifteen live filter probes matched the mart exactly
  (§7.1).
- **In the browser: not safe.** `2025-07-01T00:00:00+05:30` parsed by a client
  in UTC is 30 June 2025 18:30 → "30 Jun 2025". Today every reader is in IST,
  so nobody has seen it. A month key (`"2025-07"`) removes the hazard entirely.
- **If the Metabase container is ever moved to UTC**, the same values come back
  as `…T00:00:00Z` and every client-side parse shifts differently. The contract
  should not depend on an unset instance setting.

### 3.6 Calendar or financial month?

**Calendar.** `period_month = date_trunc('month', voucher_date)` for all 5,604
rows. The financial calendar appears only in `financial_year`. Nothing supports
a company-specific year start, and nothing claims to.

### 3.7 The year-boundary test

Live data spans **Jul 2025 → Sep 2026**, so the boundary is real, not
simulated. Grouping by Month returns:

```
Jul 2025, Aug 2025, Sep 2025, Oct 2025, Nov 2025, Dec 2025,
Jan 2026, Feb 2026, Mar 2026, Apr 2026, May 2026, Jun 2026,
Jul 2026, Aug 2026, Sep 2026
```

Chronological, as rows and as columns. `Dec 2025 → Jan 2026` is correct because
`compareValues` orders dates **by value**, not by label. A unit test now pins
exactly that transition.

---

## 4. Value representations

### 4.1 Financial values

| Concern | Today |
|---|---|
| Raw result | `numeric(18,2)` → JSON number (`243432`, `-5796`, `1475286`) |
| `cell.value` | that number, untouched |
| `cell.display` | `"money"` (or `"percent"` for a percentage comparison) |
| Indian digit grouping | **client-side only.** The backend never formats. Correct — one formatter, in the place that renders. |
| Decimal precision | exact from `numeric(18,2)`; no rounding anywhere in the matrix, by design |
| Floating-point noise | none observed; the largest figure is 3,00,00,000.00 and totals reconcile to the paisa |
| Negative values | real negatives (`-5796`), not parentheses or strings |
| **Zero vs null** | **distinguished and meaningful**: `debit = 0.00` on a credit line is a real zero (2,524 of them); `null` appears only where a group has no rows at all. `formatCell` renders `null` as blank and `0` as `₹0.00` |
| Percentages | comparison cells only; value is already ×100 (`2706.0469488452277`), `display: "percent"`; **null when the base is zero**, never `Infinity` |
| GST rates | not exposed |
| Quantities | not exposed |
| Counts | integers, but headed with the money field's name (§6) |

### 4.2 Text and identifiers

| Concern | Today |
|---|---|
| **Voucher numbers with leading zeroes** | **safe on every path measured.** `00531` is a JSON string in the preview, a `String` cell in XLSX (`type: 3`), and a text filter matches it exactly (4 lines) |
| Invoice numbers | same column; `R&C/003/25-26`, `03/2026-27` survive verbatim |
| Company / Ledger / Party names | verbatim; `null` party (1,781 lines) becomes the label `"(none)"` in a summary and `null` in a list cell |
| **Voucher types** | **inconsistent.** The cell and the row label carry the raw enum `credit_note`; the catalogue ships `{value:"credit_note", label:"Credit Note"}`. The filter UI can say "Credit Note" while the sheet says `credit_note` |
| Status values | not exposed |
| Booleans | no boolean field is offered |
| Narration | verbatim, max length 190, **252 rows contain non-ASCII** and survive intact |
| Long values | not truncated by the backend; `defaultWidth` is a hint only |
| Unicode | survives (no mangling observed in narration) |
| **Unknown enum values** | a `voucher_type` outside the 14 choices would be **refused as a filter value** but would still **display raw** if present in the data |

---

## 5. List-mode grain

**One list row is one voucher LINE** — one element of `ledgerEntries[]` on a
posted, live voucher. Live: 5,604 lines over 1,776 vouchers, **3.16 lines per
voucher**, up to 13 on one voucher.

Verified against the mart for every combination asked for. `totalRowCount` is
the line count in all eight cases, with no duplication and no de-duplication:

| Fields in the list | `totalRowCount` | Mart line count | |
|---|---|---|---|
| Voucher Date | 5,604 | 5,604 | same |
| Month | 5,604 | 5,604 | same |
| Voucher Number | 5,604 | 5,604 | same |
| Ledger Name | 5,604 | 5,604 | same |
| Voucher Number + Ledger Name | 5,604 | 5,604 | same |
| Ledger Name + Debit + Credit | 5,604 | 5,604 | same |
| Party + Debit | 5,604 | 5,604 | same |
| Company + Voucher Number + Voucher Date | 5,604 | 5,604 | same |

Why it cannot duplicate: a detail query is a `fields` SELECT over **one view**
with no `joins`, no `breakout`, no `source-query` and no aggregation. A
characterization test asserts exactly that, so a future join would fail a test
rather than change the grain quietly.

**Consequence the frontend must be able to explain:** listing Voucher Number
alone shows each voucher ~3 times, because a voucher has several lines. That is
correct behaviour for a ledger-line report and looks like a bug. The catalogue
says nothing about grain today; §13 Slice 1 adds it.

**Related limit:** `LIMITS.MAX_ROWS = 5` caps a list at five columns, while
`LIMITS.MAX_DETAIL_COLUMNS = 20` is defined and unreachable. A six-column list
is refused with *"A report may have at most 5 field(s) in Rows."*

---

## 6. Grouping and calculations

### 6.1 Advertised vs accepted

Every field × every calculation was run against the live engine. **The
catalogue advertises nothing it cannot do**, and nothing it refuses is
reachable:

| Fields | total | count | average | minimum | maximum |
|---|---|---|---|---|---|
| `amount.debit`, `amount.credit`, `amount.signed` | advertised, **works** | advertised, **works** | advertised, **works** | advertised, **works** | advertised, **works** |
| the other eleven | not advertised, refused | not advertised, refused | not advertised, refused | not advertised, refused | not advertised, refused |

### 6.2 What `count` means, and what it is called

`count` on a money field compiles to MBQL `["count"]` — **rows in the group**,
which at this grain means **voucher lines**. Live, grouped by voucher type:

| Voucher type | `count` returns | Lines in the mart | **Vouchers** in the mart |
|---|---|---|---|
| contra | 28 | 28 | 14 |
| journal | 749 | 749 | 172 |
| payment | 1,692 | 1,692 | 809 |
| purchase | 2,002 | 2,002 | 446 |
| sales | 724 | 724 | 162 |

So the count is arithmetically correct and **semantically mislabelled**: the
leaf column is headed **"Debit"**, and a user who asked for a count of sales
gets 724 where the business answer is 162. There is no `count distinct` in the
contract and no way to count vouchers.

### 6.3 Totals, subtotals, comparisons

- **Total Debit / Credit reconcile exactly**: ₹14,54,02,590.99 each; signed
  sums to ₹0.00.
- **Subtotals and grand totals are not duplicated.** Every total is its own
  aggregate query at its own grain (`mbqlCompiler.compilePlan`), and the matrix
  places rather than sums. The previously-fixed double grand total is still
  fixed: a `total` row and a `grandTotal` are never both drawn.
- **Average / minimum / maximum keep `numeric(18,2)` precision**; nothing in
  the matrix rounds.
- **Zero denominators produce `null`**, never `Infinity` — in the matrix
  (`comparisonValue`) and in the chart's MBQL, which were verified to agree to
  the last decimal (`2706.0469488452277`).
- **Period comparisons use equal-length windows** (1 Aug–31 Oct 2025 → 1 May–31
  Jul 2025), documented as a deliberate semantic, and the chart path reuses the
  same shift function.

---

## 7. Filters and sorting

### 7.1 Filters — all correct

Fifteen probes, each compared with the same predicate executed directly on the
mart. **Every one matched exactly:**

| Field | Operation | Value | Rows | Mart |
|---|---|---|---|---|
| `date.voucher` | between | 2025-08-01 … 2025-08-31 | 215 | 215 |
| `date.voucher` | on | 2025-08-04 | 4 | 4 |
| `date.voucher` | before | 2025-08-01 | 10 | 10 |
| `date.voucher` | after | 2026-08-31 | 206 | 206 |
| `date.month` | on | 2025-08-01 | 215 | 215 |
| `date.month` | between | 2025-08-01 … 2025-09-01 | 613 | 613 |
| `date.financial_year` | is | 2025-26 | 1,742 | 1,742 |
| `voucher.type` | is | sales | 724 | 724 |
| `voucher.type` | in | sales, purchase | 2,726 | 2,726 |
| `ledger.name` | contains | bank | 995 | 995 |
| `ledger.name` | starts_with | IND | 758 | 758 |
| `amount.debit` | greater_than | 100000 | 288 | 288 |
| `amount.debit` | between | 1000 … 2000 | 256 | 256 |
| `amount.signed` | less_than | 0 | 2,524 | 2,524 |
| `voucher.number` | is | `00531` | 4 | 4 |

Notes: `between` is **inclusive** on both ends, matching SQL `BETWEEN`.
Month filtering works on the month-start value, so `on 2025-08-01` means "in
August" — correct, but only discoverable by knowing that Month is a date.

**Invalid values are refused, never ignored** — nine probes, all 422 with a
sentence a person can act on:

| Probe | Answer |
|---|---|
| unknown field (`voucher_date`) | `"voucher_date" is not a field.` |
| operation not offered (`ledger.name between`) | `Ledger Name cannot be filtered by "between".` |
| choice outside the list | `The value for Voucher Type is not one of the offered choices.` |
| `on "yesterday"` | `The value for Voucher Date must be a date (YYYY-MM-DD).` |
| `greater_than "lots"` | `The value for Debit must be a number.` |
| `between []` | `The value for Voucher Date needs exactly two values.` |
| `is null` | `The value for Ledger Name must be text of at most 200 characters.` |
| array where a scalar belongs | `The value for Ledger Name takes a single value.` |
| `company_id` smuggled as a field | `"company_id" is not a field.` |
| `2025-13-45` | `The value for Voucher Date is not a real date.` |

An empty `filters: []` changes nothing — the tenant clauses remain and are the
only filter.

### 7.2 Sorting — correct in a list, a no-op in a summary

> **FIXED in B3.** Everything below describes the behaviour the audit found.
> What replaced it, and the evidence for it, is §18.

| Case | Result |
|---|---|
| detail, `date.voucher asc` | 2025-07-17 … — correct |
| detail, `date.voucher desc` | 2026-09-11 … — correct |
| **summary, `ledger.group asc`** | Administrative Expenses, Bank Accounts, Capital Account |
| **summary, `ledger.group desc`** | **identical to asc** — the direction is discarded |
| **summary, `amount.debit desc`** | alphabetical by group — the request has no effect at all |
| months, either direction | always ascending |

Two independent causes, both in the code:

1. `mbqlCompiler.compilePlan` forwards **only sorts naming a row field**, so a
   sort on a calculated value never reaches `order-by`.
2. `matrix.distinctTuples` re-sorts the distinct groups **ascending by the
   field's own value** whatever the query returned, so even a correctly
   compiled descending sort is undone.

The sort is validated and stored, so a user can save a report whose stated sort
is a fiction.

**Sort keys are values, not labels** — the one property that is right:
`compareValues` orders dates as dates, money as numbers, and text with
`localeCompare(..., {numeric: true})`. Nulls sort **last** and are labelled
`"(none)"`. Voucher numbers sort as text (`00531` < `0114` < `015` <
`03/2026-27`), which is the documented natural behaviour for an identifier.

**Interaction with truncation:** because nulls sort last and a summary is cut
at 100 rows, the `(none)` party bucket — 1,781 lines — is **invisible** in a
204-group Party summary.

---

## 8. Chart-data suitability

### 8.1 What the preview gives a chart

| Needed | Present? |
|---|---|
| stable column identifiers | partly — `leafColumns[].id` is stable but composite (`["2025-07-01T00:00:00+05:30"]::amount.debit:total`) and undocumented |
| friendly headings | yes — `leafColumns[].heading`, `rowLevels[].heading` |
| **semantic type** | **no** — only `type` and the cell's `display` |
| exact numeric value | yes — `cell.value` |
| formatted display string | **no** — group labels only |
| **period key** | **no** for rows; only parseable out of a leaf id for columns |
| period label | for columns and row labels; not for cells |
| total/subtotal markers | yes — `row.kind` ∈ data/subtotal/total, `leafColumns[].isTotal`, `isComparison` |
| truncation information | **yes (B4)** — `truncated`, `previewRowCount`, `groupCount`, `omitted.rows` |
| complete-series indication | **partly (B4)** — `omitted.values[leafId]` gives the exact figure the missing groups were worth, per series; their identities are still not listed |

### 8.2 The 100-row cap makes charts materially wrong

> **B4 made this measurable, not smaller.** The cap is unchanged and is still
> finding 5; what changed is that the response now reports it exactly. §19 has
> the implemented contract and the live reconciliation.

Measured, summarising 333 ledgers by Total Debit with the default limit:

| | As the audit found it | After B4 |
|---|---|---|
| rows returned | 100 | 100 |
| `previewRowCount` | **333** ← the group count | **100** |
| `groupCount` | — | **333** |
| `totalRowCount` | 333 | 333 (the complete count, unchanged) |
| `truncated` | true | true |
| `omitted.rows` | — | **233** |
| `omitted.values["[]::amount.debit:total"]` | — | **₹12,30,08,184.55** |

- **sum of the 100 visible rows: ₹2,23,94,406.44** against a true total of
  **₹14,54,02,590.99 — 15.4%**, and 22,394,406.44 + 123,008,184.55 =
  145,402,590.99 exactly.

A chart drawn from that preview still shows a seventh of the money. The
difference is that the payload now says so in figures rather than in a boolean,
so a client can label the gap, draw an "Other" bucket, or refuse to draw at
all — **that decision is Lane A's and B4 does not make it.** `grandTotal` is
present but its cells are `null` when row totals are off, which is why
`omitted.values` is summed from the omitted rows rather than read off a total.

Additional counting hazard, now pinned: a "100-row preview" of a two-level
summary returned **236 rows**, because the limit applies to data rows and
subtotal/total rows are added afterwards. All three counts deliberately ignore
subtotals, so the physical array may be longer than `previewRowCount` — and
`previewRowCount` still says how many groups are on screen.

### 8.3 Recommended contract for a dedicated chart-data endpoint

**Not implemented in this audit.** Proposed shape:

```
POST /api/accountant/reporting/chart-data          Cache-Control: no-store
```

Request: the same validated layout, plus
`series: { maxCategories: <1..500>, otherBucket: true|false }`.

Behaviour, in this order — the same order `/preview` uses:
1. Accounting authentication (`reportingAuth`).
2. Organisation from the session, never the body.
3. `reportingCompanyScope()` — every company independently, all-or-nothing.
4. `requirePermission("canView")`.
5. `validateLayout` against the live catalogue.
6. `compileChartQuery` — **the existing single-question compiler**, with the
   immutable tenant clauses built first.
7. Bounded execution: `maxCategories` (default 100, hard ceiling 500) and the
   existing 30 s engine timeout.

Response:

```jsonc
{
  "ok": true,
  "mode": "summary",
  "dimensions": [
    { "id": "date.month", "heading": "Month", "semanticType": "month" }
  ],
  "series": [
    { "id": "amount.debit:total", "heading": "Total of Debit",
      "semanticType": "currency", "isComparison": false }
  ],
  "points": [
    { "keys": ["2025-07"], "labels": ["July 2025"], "values": [370784.00] }
  ],
  "truncation": {
    "truncated": true,
    "shown": 100,
    "totalGroups": 333,
    "omittedValue": { "amount.debit:total": 123008184.55 },
    "otherBucket": { "labels": ["Other (233 ledgers)"], "values": [123008184.55] }
  },
  "grandTotal": { "amount.debit:total": 145402590.99 },
  "dataAsOf": "2026-09-24T18:21:34.520Z"
}
```

- `keys` are **raw, sortable, timezone-free** (`"2025-07"`, not a timestamp).
- `labels` are the server's display strings, so the chart and the sheet agree.
- **`omittedValue` and `otherBucket` are the point of the endpoint**: a chart
  may be cut, and must be able to say by how much.
- Exposes no SQL, MBQL, Metabase id, key, URL or column name — same rule, same
  tests as `/preview`.

---

## 9. XLSX correctness

> **FIXED in B5.** Everything in §9.1 and §9.2 describes the workbook as the
> audit found it — Metabase's own file. GRAV now writes the workbook from the
> same compiled plan's rows; the file as it stands today, and the evidence for
> it, is §20. The flat SHAPE (§9.3) is unchanged and still disclosed.

Two representative exports were opened cell by cell with ExcelJS.

### 9.1 Detail list — Voucher Date, Month, Voucher Number, Debit, Signed Amount, filtered to August 2025

| | Value | Excel type | Number format | Verdict |
|---|---|---|---|---|
| Voucher Date | `2025-08-04T00:00:00.000Z` | Date | `mmmm d, yyyy` | acceptable |
| **Month** | `2025-08-01T00:00:00.000Z` | Date | `mmmm d, yyyy` | **wrong — prints "August 1, 2025"** |
| Voucher Number | `"R&C/003/25-26"`, `"00531"` | **String** | — | **correct; leading zeroes safe** |
| Debit | `243432` | Number | **none** | no grouping, no 2dp |
| Signed Amount | `-5796` | Number | none | a real negative |
| Row count | 215 data rows = the preview's 215 | | | correct |
| Headings | `Voucher Date`, **`Period Month`**, `Voucher Number`, `Debit`, `Signed Amount` | | | **`Period Month` is a mart column name** |

### 9.2 Summary — Ledger Group × Month, Total Debit, Aug–Oct 2025

| | Observed |
|---|---|
| Headings | **`Group Name`**, **`Period Month: Day`**, **`Sum of Debit`** — all three are the engine's, none is the user's |
| Month cell | Excel Date, `mmmm d, yyyy` |
| Money | plain Number, no format |
| Rows | 49 = one per (group, month), the documented flat layout |
| Totals | ₹2,10,24,380.25, equal to the preview |

### 9.3 Export vs preview, when the preview is truncated

Summarising 333 ledgers: the preview shows 100 rows totalling ₹2.23 crore; the
export contains **all 333 rows totalling ₹14,54,02,590.99**, which matches the
mart exactly. The workbook is complete and the screen is not — correct, and
invisible to a user who is told "100 of 333".

Filters, sort order and comparisons carry into the export because it runs the
same compiled plan. The flat-layout limitation is disclosed in the response
headers (`X-Reporting-Layout: flat-aggregation`) and remains acceptable.

### 9.4 What a month should be in the workbook

**Recommended: an Excel date at the month start, formatted `mmmm yyyy`**, under
the user's own heading ("Month"). It stays a real date — so Excel can group,
filter and chart it as time — and prints "August 2025". Text (`"2025-08"`)
would be safe but would stop Excel treating it as time; a day-formatted date is
the one option that is actively misleading, and it is the current one.

**Adopted in B5, exactly as recommended:** an Excel date at the month start,
`mmmm yyyy`, under the user's heading — built from the ISO date PART so a UTC
process cannot slide August into July.

---

## 10. Saved-report contract

### 10.1 What the backend stores and returns today

`POST/PUT/GET /custom-reports` return exactly:

```
id, name, companyIds[], companyNames[], updatedAt, layoutSummary,
createdBy, canDelete, schemaVersion, layout, visualization, staleProblems
```

The list returns a narrower row: `id, name, companyIds, companyNames,
updatedAt, layoutSummary`.

| Aspect | Today |
|---|---|
| Layout | the **rebuilt** object (`toStoredLayout`), never the caller's — `rows, columns, values, filters, comparisons, sort, showRowTotals, showColumnTotals, showGrandTotal` |
| Name | required, ≤120 chars, unique per organisation (case-insensitive) |
| Schema version | `2`; a v1 report returns `needsRecreation: true`, `layout: null`, original kept verbatim, never reinterpreted |
| Visualization | the approved chart settings only (`type, title, showLegend, showDataLabels, stacked, xAxisLabel, yAxisLabel, dimensions, metrics, palette, goal`), rebuilt by the allowlist |
| Company scope | `companyIds[]`, re-checked against `tallyCompanyIds` on **every** read |
| Ownership | `createdBy`, `createdByName`; `canDelete` = creator, owner, or `canManageSettings` |
| Update semantics | **PUT updates in place** — same id, one row, verified live |
| Chart identity | the hidden Metabase question is **not** in any response; it lives in `reporting.report_chart` in PostgreSQL |
| **Worksheet** | **not accepted** — `POST` with a `worksheet` key is refused 422 *"The report has an unrecognised property "worksheet"."* |

### 10.2 What Slice 4 will need

| Requirement | Ready? |
|---|---|
| Open | yes — `GET /custom-reports/:id` returns the layout re-validated, with `staleProblems` |
| Update rather than duplicate | yes — `PUT` is in place and idempotent |
| Duplicate | **client-side today**: no server duplicate; a client must GET then POST with a new name (the unique index enforces the rename) |
| Export the selected report | **no** — `/export/xlsx` takes a layout, never a `reportId` |
| Delete | yes — creator/owner, and it archives the chart question |
| Worksheet persistence | **no** |
| Multiple charts, positions, sizes | **no** — one `visualization` object |
| Backward compatibility | v1 handled; a v2 report with no worksheet must present as an empty worksheet |

### 10.3 Proposed `worksheet` allowlist

Rebuilt server-side from an allowlist, exactly as `visualization` is — never
stored as sent.

```jsonc
{
  "version": 1,
  "table": { "startRow": 1, "startColumn": 1 },        // 1..512
  "charts": [                                          // ≤ 8
    {
      "id": "c1",                                      // ^[A-Za-z0-9_-]{1,24}$
      "type": "bar",                                   // ∈ supportedTypes for the layout
      "title": "Debit by ledger group",                // ≤ 120 chars, control chars stripped
      "row": 3, "column": 7,                           // 1..512
      "rowSpan": 12, "columnSpan": 8,                  // 1..64
      "visualization": { /* the existing approved settings object */ }
    }
  ]
}
```

Limits: at most 8 charts; ids unique within a worksheet; every string length-
capped; every integer range-checked; **total serialized size ≤ 16 KB**; unknown
keys refused with the same 422 vocabulary as a layout. Never accepts a token, a
URL, an engine or card id, SQL or MBQL — and, as with `visualization`, the
chart's own Metabase question stays in `reporting.report_chart`.

---

## 11. Security

Probed live on every path with a company id **no organisation holds**
(`6ab7bf42588e9ce3cfab0792`) — the dev database's single organisation holds all
three real companies, so a non-existent id is the only honest way to exercise
the guard:

| Probe | Result |
|---|---|
| `/preview` with the unowned company alone | **403 REPORTING_FORBIDDEN** |
| `/preview` with owned + unowned | **403** — no partial run |
| `/preview` with unowned **first** | **403** |
| `/export/xlsx` with the unowned company | **403** |
| `/chart-session` with the unowned company | **403** |
| `/catalog?companyId=<unowned>` | **403** |
| comparison naming an unowned company as `with` | 422 *"The company to compare with is not one this request approved."* |
| `GET /custom-reports?companyId=<unowned>` | **200 — the parameter is ignored** |

Injection and shape probes, all refused before anything reached the engine:

| Probe | Result |
|---|---|
| `native: { query: … }` | 422 unrecognised property |
| `sql: "SELECT 1"` | 422 unrecognised property |
| `database: 2` | 422 unrecognised property |
| a caller-supplied field **descriptor** object | 422 `"[object Object]" is not a field.` |
| a raw column name as a field id (`gstin`) | 422 `"gstin" is not a field.` |
| a withheld field (`amount.voucher_total`) | 422 not a field |
| `visualization.dataset_query` | 422 `"dataset_query" is not a chart setting.` |

Also verified: authentication is required on every route and a legacy CMS
session is refused; permissions come from the **stored** role; the organisation
is taken from the session and never from the body; no response carries a key,
URL, database/table/field/card/collection id, MBQL or SQL; engine errors are
translated to four codes with the detail logged, not sent; `no-store` on
`/chart-session` and on the export.

**Cache:** the only server-side cache is the engine's 5-minute metadata cache —
Metabase **table and field ids**, no tenant data, no rows — so it cannot mix
organisations. The hidden-chart registry is keyed on `(organization_id, kind,
layout_hash)` with the organisation inside the hash.

**Two findings, neither a vulnerability:**

1. `GET /custom-reports` ignores `companyId` instead of refusing it. Nothing
   leaks — the listing is organisation-scoped and intersected with owned
   companies — but a filter that is silently ignored is inconsistent with every
   other route, and a client could believe it is filtering.
2. A field id that does not exist and a field id that is **deliberately
   withheld** produce the same message. That is the right call for
   confidentiality and worth stating explicitly so nobody "improves" it.

---

## 12. The heavy query

> **BOUNDED in B6 (§21).** The costs measured below are unchanged facts about
> the plan; what changed is that the two layouts marked expensive here are now
> refused before a query runs, every preview shares one deadline instead of
> restarting the clock per query, and an oversized body is refused whole.

**The reported `ERR_EMPTY_RESPONSE` for *Voucher Number + Ledger Name + Count*
could not be reproduced from the backend.**

| Shape | Status | Duration | Result |
|---|---|---|---|
| summary: Voucher Number + Ledger Name, **count**, limit 100 | 200 | 769 ms / 1,078 ms / 649 ms | 128 rows of 5,472 groups |
| the same, total | 200 | 646 ms | 128 rows |
| list: Voucher Number + Ledger Name, limit 100 | 200 | 276 ms | 100 rows of 5,604 |
| export, no limit (5,472 groups) | 200 | 285 ms | full workbook |
| chart-session, no limit | 200 | 406 ms | token issued |
| **six concurrent previews** | all 200 | 1,014–1,275 ms, 1,277 ms wall | no starvation |

What the audit *did* find is how expensive a **legal** layout can become,
because a summary is a plan of separate aggregate queries:

| Layout | Sequential engine queries | Duration | Response |
|---|---|---|---|
| 1 row + 1 value | 3 | 1,137 ms | 3 KB |
| 2 rows + 1 column | 6 | 767 ms | 74 KB |
| 5 rows (the cap) | 10 | 1,521 ms | 38 KB |
| **5 rows + 3 columns + 8 values** | **12** | 2,443 ms | **1.76 MB** |
| **5 rows + 1 comparison** | **22** | 2,770 ms | 46 KB |

Timeouts in force: engine preview **30 s**, engine export **120 s**, PostgreSQL
`statement_timeout` **2 min**. None was reached.

So, against the list of candidate causes: **not** excessive cardinality (5,472
groups answer in under a second), **not** a query timeout, **not** worker
starvation (six concurrent requests succeeded), **not** the view plan, **not**
connection-pool exhaustion, **not** concurrent question creation. Result size
is the only one with real evidence behind it — a 1.76 MB JSON preview is
reachable — and it produces a slow response, not an empty one.

`ERR_EMPTY_RESPONSE` is a Chrome network error meaning the socket closed with
no response. Nothing in the backend was observed doing that. **What remains
unverified is the browser side**: an aborted or superseded fetch, a dev-server
restart mid-request (hot reload was active during the reported failure), or a
proxy. The recommendation in §13 is therefore a *bound and a refusal*, not a
fix for a cause that has not been demonstrated.

---

## 13. Recommended backend changes, in slices

Each slice is independently shippable and independently testable. None changes
a figure; the first four change what is *said* about a figure.

### Slice B1 — Semantic metadata in the catalogue *(small, additive)*

1. Add `semanticType`, `display {format, sort}` and `chart
   {defaultGroupingPriority, highCardinality, role}` to `field()` in
   `fieldCatalogue.js`, with the values in §2.2.
2. Serve them through `publicCatalogue()`; keep `column` and `temporalUnit`
   private.
3. Add `grain: "voucher_line"` and a one-line description of what a list row is
   to the catalogue response, so the frontend can explain repeated values.
4. Update `docs/accounting-reporting-api-contract.md` **in the frontend repo**
   — by Lane A, or by Lane B in a separate agreed change.

*Risk: none. Purely additive; a client that ignores the keys is unaffected.*

### Slice B2 — Periods and enums carry their meaning into every cell

1. `matrix.shapeDetail` / `shapeSummary`: for a field whose `semanticType` is a
   period, emit `cell.value` **unchanged** plus `cell.key` (`"2025-07"`) and
   `cell.text` (`"July 2025"`), and set `cell.display` to `"month"`.
2. Emit `semanticType` on `leafColumns[]` and `rowLevels[]`.
3. Give summary rows a `keys[]` beside `labels[]`, so a client can sort or
   bucket without parsing a label.
4. For `type: "choice"`, resolve the value to its catalogue **label** in
   `cell.text` and in row labels; keep the raw value in `cell.value`.

*Risk: low. Existing keys keep their meaning and values.*

### Slice B3 — Make `sort` mean something in a summary

1. `matrix.distinctTuples`: order by the layout's `sort` when it names a row
   field, then by the remaining row fields ascending.
2. `mbqlCompiler`: forward a sort naming a **value** as
   `["order-by", [direction, ["aggregation", <index>]]]`.
3. Keep nulls last in both directions and keep value-based comparison.
4. Update the two `GAP` tests in `reporting-semantic-contract.test.js` and the
   live one in `reporting-integration.route.test.js` to assert the new
   behaviour.

*Risk: medium — it changes the order of rows in existing saved reports (in the
direction the report actually asked for).*

### Slice B4 — Honest counts and a complete-series signal — **SHIPPED** (§19)

1. ✅ `previewRowCount` = the number of **data rows returned**; `groupCount`
   added for the number of distinct groups (`null` in a detail list).
2. ✅ `omitted: { rows, values: { <leafId>: <sum> } }` when `truncated`,
   summed from the omitted rows themselves, in the B3 order.
3. ✅ Subtotal and total rows are excluded from all three counts, and that is
   stated in the matrix header and here.
4. ✅ `totalRowCount` kept and documented: the COMPLETE count — groups in a
   summary, records in a list.

*Risk: low, and it was purely additive — no existing field changed meaning
except `previewRowCount`, which had never been right.*

### Slice B5 — The workbook tells the truth — **SHIPPED** (§20)

1. ✅ The engine's column names replaced with the user's headings, read from
   the validated layout; a renamed heading is used exactly as typed.
2. ✅ A month is an Excel date with `mmmm yyyy`; a full date is `dd mmm yyyy`.
3. ✅ Money carries an Indian-grouping rupee format with two decimals and an
   explicit negative section; counts are integers with no rupee sign.
4. ✅ Voucher numbers stay text — still correct, still pinned, now also under
   a mutation check.

*Taken by generating the workbook here with the already-installed ExcelJS,
from the rows of the same compiled plan. The decision in
`metabase-pivot-export-capability.md` is refined rather than reversed:
Metabase owns every figure, GRAV owns presentation, and the file is still the
flat aggregation.*

### Slice B6 — Bounds and a refusal instead of a silent cost — **SHIPPED** (§21)

1. ✅ A complexity budget judged on the **complete compiled plan** — queries
   and layout units — refusing with a 422 that names what to remove. The
   per-shelf limits are untouched.
2. ✅ `/preview` has **one** deadline for the whole request (20 s, under the
   engine's per-call 30 s), shared by every query in the plan, and returns
   `REPORTING_UNAVAILABLE` with actionable text. A client disconnect stops the
   plan too.
3. ✅ One structured line per preview: outcome, counts, bytes, milliseconds —
   and no report name, filter value, ledger name, figure or engine vocabulary.
4. ✅ A response-byte ceiling, measured on the finished body, refusing the
   whole result rather than trimming it.

### Slice B7 — Fields and consistency *(small)*

1. Record the twelve unlisted view columns in `WITHHELD` with a reason, or
   offer them. `dr_cr` (Side) and `is_optional` are the two worth offering.
2. Decide `tax.classification`: it is 100% empty. Either hide it until the sync
   populates it, or mark it `"no data yet"` in its description.
3. Make `GET /custom-reports` refuse an unapproved `companyId` like every other
   route.
4. Add a server-side **duplicate** (`POST /custom-reports/:id/duplicate`) and
   accept `reportId` on `/export/xlsx`, both of which Slice 4 needs.

---

## 14. Tests and live commands run

### 14.1 Added in this audit

| File | Kind | Tests | Proves |
|---|---|---|---|
| `test/accountant/reporting-semantic-contract.test.js` | pure/unit, real functions | 20 | month labelling and chronology across a year boundary; value-not-label sort keys; voucher number stays text; no identifier is calculable; every advertised calculation and filter operation is accepted and nothing else is; withheld columns unreachable; nothing private served; list grain is a SELECT with no join/breakout; tenant clauses on detail, count and chart queries; and the **documented gaps** of the day — all but one since closed as property tests by B1–B4 (no semantic type, engine timestamps in cells, summary sort ignored, value sort dropped, `previewRowCount`); the 5-column detail cap remains |
| `test/accountant/reporting-integration.route.test.js` (3 added) | live Metabase + live mart | 32 total | `00531` exports as a String; a month exports as a day-formatted date under the heading `Period Month`; a summary's ascending and descending order are identical |

The `GAP` tests pass today and each one carries the assertion its fix must
replace. None of them is a source-regex test.

### 14.2 Test kinds in the reporting suite as a whole

| Kind | Files | Count |
|---|---|---|
| pure/unit (real functions, no I/O) | `reporting-layout`, `reporting-chart`, `reporting-semantic-contract` | 133 |
| route (real middleware, fake engine, in-memory Mongo) | `reporting.route`, `reporting-chart.route` | 78 |
| mutation (breaks a copy of a module, asserts a test dies) | `reporting-mutation` | 14 |
| live Metabase + live mart | `reporting-integration`, `reporting-chart-integration` | 32 |
| live PostgreSQL only | `test/reporting/*` | 65 |
| source-pattern | one assertion inside `reporting-chart` (the admin credential has one call site), one in `company-isolation` | 2 |

Source-pattern assertions are used for exactly two properties that cannot be
observed at runtime — "there is only one privileged call site" and "a guard is
mounted on this route" — and are labelled as such. **No claim in this audit
rests on one.**

### 14.3 Commands

```bash
# offline suites
npx jest test/accountant/reporting-semantic-contract.test.js          # 20 passed
npx jest test/accountant/reporting-layout.test.js \
         test/accountant/reporting.route.test.js \
         test/accountant/reporting-chart.test.js \
         test/accountant/reporting-chart.route.test.js \
         test/accountant/reporting-mutation.test.js                   # 205 passed

# live, serially — they share one Metabase
npm run test:reporting:live                                           # 32 passed
```

Live probes (written to `/tmp`, scripts removed afterwards): mart column types,
nullability and cardinality; Metabase field metadata; the served catalogue;
detail and summary cell shapes; the month path; list-grain row counts for eight
field combinations; the full calculation matrix (14 fields × 5 calculations);
fifteen filter probes against the mart; nine invalid-filter probes; sorting in
both modes; the 100-row cap against the mart's totals; two XLSX exports opened
cell by cell; eight security probes with an unowned company; seven injection
probes; seven heavy-query shapes and a six-way concurrency run.

---

## 15. Not verified

1. **The `ERR_EMPTY_RESPONSE` itself.** Not reproducible from the backend in
   any shape tried (§12). The browser side — an aborted fetch, a dev-server
   restart, a proxy — was not instrumented and is Lane A's to capture with a
   HAR.
2. **PostgreSQL query plans.** `EXPLAIN` was not run: the mart's admin role can
   run it, but no query was slow enough to justify it, and a plan for a query
   that answers in 650 ms would be evidence of nothing.
3. **Process resource evidence** (heap, file descriptors, event-loop lag) under
   load. Six concurrent heavy previews all succeeded, so there was no failure
   to attribute.
4. **Behaviour with more than one organisation.** The dev database has exactly
   one, holding all three companies. Cross-organisation isolation was probed
   with an unowned company id and is covered by the route and mutation suites
   against fixtures, but not against two real organisations with real data.
5. **A second company's data.** IE Demo Garments and IE Demo Textiles have no
   synced mart rows, so multi-company arithmetic (an `other_company` comparison
   over two populated companies) was not verified against real figures.
6. **Unicode and long values in the workbook.** Narration contains 252
   non-ASCII rows and survives the preview; it was not exported and opened.
7. **Quarter and any non-calendar financial period.** Neither exists; nothing
   to verify.
8. **`tax.classification` with data.** It is empty in every row, so its
   grouping, filtering and display are untested against real values.
9. **The frontend contract document.** Read only. Its illustrative JSON still
   shows `"id": "voucher_date"` while its own table forbids a column name as an
   id; the backend follows the table. Correcting the document is Lane A's.

---

## 16. What slices B1 and B2 shipped

Implemented 26 September 2026. **No accounting figure changed** — proved below.

### 16.1 Files

| File | Change |
|---|---|
| `services/reporting/semantics.js` | **new** — the four closed vocabularies, the rules that police them, and the key/label arithmetic |
| `services/reporting/fieldCatalogue.js` | every field declares `semanticType`, `display` and `chart`; `field()` validates at build time; `publicCatalogue()` serves the semantics and a `grain` block |
| `services/reporting/matrix.js` | `semanticCell`, `semanticLabel`, `semanticKey`; semantics on `leafColumns[]` and `rowLevels[]`; `keys[]` on every summary row |
| `test/accountant/reporting-semantics.test.js` | **new** — 32 tests, including five mutation tests |
| `test/accountant/reporting-semantic-contract.test.js` | the two closed gaps became PROPERTY tests; 25 tests |
| `test/accountant/reporting-layout.test.js`, `reporting.route.test.js`, `reporting-integration.route.test.js` | updated for `grain`, full month names and the new column keys |

Nothing in `routes/`, `mbqlCompiler.js`, `metabaseEngine.js` or the export path
was touched. The frontend repository was not touched.

### 16.2 The vocabulary, and the rules it is held to

`semanticType` — `date`, `month`, `quarter`, `financial_year`, `currency`,
`currency_signed`, `percentage`, `quantity`, `count`, `gst_rate`, `company`,
`ledger`, `ledger_group`, `party`, `enum`, `status`, `boolean`, `identifier`,
`free_text`, `text`.

`display.format` — `text`, `text_exact`, `choice_label`, `day_month_year`,
`month_year`, `quarter_year`, `financial_year`, `currency_inr`, `number`,
`integer`, `percent`, `boolean`.

`display.sort` — `chronological`, `alphabetical`, `numeric`, `natural`.

`chart.role` — `temporal`, `category`, `measure`, `identifier`, `text`.

Seven of those words (`quarter`, `percentage`, `quantity`, `count`, `gst_rate`,
`boolean`, `status`) are reserved for fields that do not exist yet, so adding
one later is a catalogue entry and not a contract change.

`assertSemantics` runs **while the catalogue array is being built**, so a typo
is a `require` that throws — the server does not start and every test fails.
It enforces:

- a measure has no grouping priority and no cardinality flag;
- an identifier or free text must declare `highCardinality: true`;
- a chronological format must be sorted chronologically, and so must any period;
- `text_exact` belongs to a text field and may be neither calculated nor placed
  in Values — which is what protects `00531`;
- money is formatted as currency and is a measure.

### 16.3 What changed in a response

**Added** to every catalogue field: `semanticType`, `display {format, sort}`,
`chart {role, defaultGroupingPriority?, highCardinality?}`.
**Added** to the catalogue: `grain {id, label, description}`.
**Added** to `leafColumns[]` and `rowLevels[]`: `semanticType`, `display`
(and `chart` on `rowLevels`, which are fields).
**Added** to summary rows: `keys[]`, aligned with `rowLevels`.
**Added** to period and coded cells: `key`, `text`, `semanticType`. Other cells
gain `semanticType` only.

**Nothing was removed or renamed.** `type`, `value`, `display` (the string),
`heading`, `labels` all keep their meaning.

Three labels now read differently, which is the point of the slice:

| | Before | After |
|---|---|---|
| a month, as a row label or column heading | `Jul 2025` | `July 2025` |
| a voucher type, as a row label | `contra` | `Contra` |
| a financial year, as a row label | `2025-26` | `2025–26` (key stays `2025-26`) |

### 16.4 The backward-compatibility decision

**`cell.display` still says `"date"` for a month.** The frontend formats a cell
by switching on that string and has no `month` branch: `display: "month"` would
fall through to `String(value)` and print `2025-07-01T00:00:00+05:30` — worse
than the `01 Jul 2025` the audit set out to fix. Verified read-only in
`grav-cms/lib/reporting/format.js`.

So the primitive hint is left exactly as it was and the meaning travels beside
it in `semanticType`, `key` and `text`. **Lane A should render `cell.text` when
present and fall back to `formatCell(value, display)`** — one line, and the
month is right. Once the frontend reads `text`, a later slice can narrow the
hint to `"month"`.

### 16.5 Live verification, 26 September 2026, GRAV CLOTHING

Detail list:

```json
"Voucher Date"   {"value":"2025-08-04T00:00:00+05:30","display":"date","key":"2025-08-04","text":"4 August 2025","semanticType":"date"}
"Month"          {"value":"2025-08-01T00:00:00+05:30","display":"date","key":"2025-08","text":"August 2025","semanticType":"month"}
"Financial Year" {"value":"2025-26","display":"text","key":"2025-26","text":"2025–26","semanticType":"financial_year"}
"Voucher Type"   {"value":"sales","display":"choice","key":"sales","text":"Sales","semanticType":"enum"}
"Debit"          {"value":243432,"display":"money","semanticType":"currency"}
```

- **Month summary** — fifteen months, each appearing once; labels
  `July 2025 … September 2026`; keys `2025-07 … 2026-09`; sorting the keys
  reproduces the order on screen, **including `2025-12 → 2026-01 → 2026-02`**.
- **Month as a column axis** — `August 2025, September 2025, October 2025, Total`.
- **Voucher Date** — the value's UTC instant is `2025-08-03`; the key is
  `2025-08-04`. The date does not slip.
- **Financial Year** — `["2025–26", "2025-26"]`, `["2026–27", "2026-27"]`, and
  the 944 lines with no year remain `["(none)", null]`. No period is invented.
- **Voucher Type** — every one of the eight present types reads as its label and
  keys as its code.
- **Calculated columns** — `["Debit", "currency", "currency_inr"]`,
  `["Signed Amount", "count", "integer"]` for a count, and
  `["Debit — % change vs previous period", "percentage", "percent"]`.
- **Boundary** — no source column, view name, engine word or private key in any
  payload.

### 16.6 Before and after: every figure identical

Six live shapes captured through the real route before the change and again
after it. **1,515 figures, every one identical, `Object.is` by position:**

| Shape | Figures | Sum before | Sum after |
|---|---|---|---|
| detail list of periods | 25 | 243,432.00 | 243,432.00 |
| summary by Month | 17 | 145,402,590.99 | 145,402,590.99 |
| 2 rows × Month × 3 values | 1,416 | 122,750,232.91 | 122,750,232.91 |
| summary with a % comparison | 42 | 21,029,211.31 | 21,029,211.31 |
| summary by Voucher Type | 10 | 145,402,590.99 | 145,402,590.99 |
| summary by Financial Year | 5 | 145,402,590.99 | 145,402,590.99 |

### 16.7 Tests

| Suite | Kind | Tests |
|---|---|---|
| `reporting-semantics` | pure, real functions + 5 mutation tests | 32 |
| `reporting-semantic-contract` | pure, real functions | 25 |
| `reporting-layout` | pure | 78 |
| `reporting.route`, `reporting-chart.route` | route, real middleware | 78 |
| `reporting-chart`, `reporting-mutation` | pure + mutation | 51 |
| live (`npm run test:reporting:live`) | real Metabase + real mart | 32 |
| mart (`test/reporting`) | live PostgreSQL | 65 |

**294 offline + 32 live + 65 mart, all passing.**

The five mutation tests each break the real module in a copy and require a test
to die: removing Month's semantic type, using the formatted label as the month
key, making a numeric-looking voucher number a number, leaking a source column
through `publicCatalogue()`, and removing summary row keys.

### 16.8 Not verified in this slice

1. **How the current UI renders the new payload.** The frontend was read but
   not run; the compatibility decision above is what makes that safe, and Lane
   A owns the browser check.
2. **`quarter`.** The vocabulary reserves it; no quarter field or MBQL temporal
   unit exists, so nothing exercises `periodKey("quarter", …)` against real
   data — only unit tests.
3. **A non-IST engine.** The keys are sliced from the ISO string and unit tests
   cover `Z` and `-08:00` offsets, but the instance has only ever answered with
   `+05:30`.
4. **`tax.classification` with data.** Still 100% null, so its `enum` semantics
   are untested against real values.
5. **The export path.** Untouched: the workbook still carries the engine's
   headings and a day-formatted month. That is slice B5.

---

## 17. The public contract, for Lane A

Additive. Everything an existing client reads is unchanged.

### 17.1 `GET /catalog?companyId=…`

```jsonc
{
  "grain": {
    "id": "voucher_line",
    "label": "Voucher line",
    "description": "Each row is one ledger entry within a voucher. A voucher with several entries appears once for each of them, so its date, number and party repeat down the list."
  },
  "fields": [
    {
      "id": "date.month",
      "label": "Month",
      "category": "Dates",
      "type": "date",                     // unchanged
      "description": "The month the voucher falls in. The usual thing to put across the top.",
      "placements": ["rows", "columns", "filters"],
      "calculations": [],
      "filterOperations": ["between", "on", "before", "after"],
      "comparisons": null,
      "compatibleWith": null,
      "choices": null,
      "defaultWidth": 120,

      "semanticType": "month",            // NEW
      "display": { "format": "month_year", "sort": "chronological" },   // NEW
      "chart": { "role": "temporal", "defaultGroupingPriority": 30, "highCardinality": false }  // NEW
    }
  ]
}
```

Use `grain.description` to explain repeated values in List mode. Use
`chart.defaultGroupingPriority` (lowest first) to pick an axis, and
`chart.highCardinality` to refuse one: `ledger.group` is 10, `voucher.number`
is 95 and high-cardinality.

### 17.2 `POST /preview`, detail mode

```jsonc
{
  "mode": "detail",
  "leafColumns": [
    { "id": "date.month", "heading": "Month", "type": "date",
      "isTotal": false, "isComparison": false,
      "semanticType": "month",
      "display": { "format": "month_year", "sort": "chronological" } }
  ],
  "rows": [
    { "kind": "data", "depth": 0, "labels": [],
      "cells": [
        { "value": "2025-08-01T00:00:00+05:30",   // unchanged
          "display": "date",                       // unchanged — see below
          "semanticType": "month",
          "key": "2025-08",
          "text": "August 2025" }
      ] }
  ]
}
```

**Render `cell.text` when it is there**; fall back to
`formatCell(cell.value, cell.display)` when it is not. `cell.display` still
carries the primitive hint deliberately, so nothing breaks before Lane A makes
that change — but until it does, a month still renders as `01 Aug 2025`.

`cell.key` is what to sort, group, compare or use as a chart category by. It is
timezone-free: `2025-08` for a month, `2025-08-04` for a date, `2025-26` for a
financial year, the raw code for an `enum`, and `null` when the value is null.

### 17.3 `POST /preview`, summary mode

```jsonc
{
  "mode": "summary",
  "rowLevels": [
    { "heading": "Month", "semanticType": "month",
      "display": { "format": "month_year", "sort": "chronological" },
      "chart": { "role": "temporal", "defaultGroupingPriority": 30, "highCardinality": false } }
  ],
  "leafColumns": [
    { "id": "[]::amount.debit:total", "heading": "Debit", "type": "money",
      "isTotal": false, "isComparison": false,
      "semanticType": "currency", "display": { "format": "currency_inr", "sort": "numeric" } },
    { "id": "[]::cmp0", "heading": "Debit — % change vs previous period", "type": "number",
      "isTotal": false, "isComparison": true,
      "semanticType": "percentage", "display": { "format": "percent", "sort": "numeric" } }
  ],
  "rows": [
    { "kind": "data", "depth": 0,
      "labels": ["August 2025"],          // the sentence
      "keys": ["2025-08"],                // the stable key, aligned with rowLevels
      "cells": [ { "value": 7823251.17, "display": "money" } ] },
    { "kind": "subtotal", "depth": 0,
      "labels": ["Bank Accounts total"], "keys": ["Bank Accounts"], "cells": [] },
    { "kind": "total", "depth": 0, "labels": ["Total"], "keys": [null], "cells": [] }
  ],
  "grandTotal": { "labels": ["Grand total"], "keys": [null], "cells": [] }
}
```

`keys[i]` always answers for `rowLevels[i]`: a group's own key on data and
subtotal rows (a subtotal's key has no `" total"` on it), `null` on total rows.
Summary value cells carry no `key`/`text` — a figure is a figure; the period
lives in `keys[]` and in the column headings.

`columnLevels[].headers[].label` is the same sentence as a row label:
`August 2025`, `Credit Note`, `2025–26`.

### 17.4 What still is not there

Slice B7 remains: a detail list is still capped at five columns,
`tax.classification` is still advertised and empty, the twelve unlisted view
columns are still unrecorded, and `GET /custom-reports` still ignores an
unapproved `companyId`. The 100-row preview cap also still truncates, though
no longer silently (B4, §19). B3 (§18) made `sort` real, B4 (§19) made
truncation measurable, B5 (§20) made the workbook readable, and B6 (§21)
bounded what a preview may cost.

---

## 18. What slice B3 shipped — sorting that means what it says

### 18.1 The contract, unchanged

**No request or response field was added, removed or renamed.** The existing
`sort: [{ field, direction }]` already expresses everything requirement B3
asks for: `field` names either a row field or a field used in Values, and
`direction` is `asc` | `desc`. The one ambiguity the existing shape carries —
the same field appearing twice in Values, e.g. Total Debit *and* Average
Debit — is resolved by a documented rule rather than by a new field:

> **First-value rule.** A sort naming a field that is not a row field is
> matched to the **first** entry in `values` with that field id. The matrix and
> the compiler apply the identical rule, so the sheet and the query agree.

A request that needs the *second* Debit column cannot be expressed. That is a
real limit of the current shape and is recorded here rather than papered over;
it needs a `valueIndex` (or a value-id) on the sort entry whenever a user can
actually create two calculations of one field. Nothing was changed for it now,
per the slice's instruction to report rather than extend.

### 18.2 The four rules, as implemented

Written on `matrix.rowComparator`, applied in `matrix.shapeSummary`, and
mirrored in `mbqlCompiler.summaryOrderBy`:

1. **A named level goes in the direction asked for**, ordered by its **semantic
   key** — `periodKey` for months, quarters and financial years; a real date
   for dates; a number for money and numbers; `localeCompare(..., {numeric:
   true, sensitivity: "base"})` for text. Never the display label: `August
   2025` sorts before `December 2025` because `2025-08 < 2025-12`, not because
   A precedes D.
2. **A measure sort orders the deepest row level by that level's row total.**
   Outer levels keep their own order, so a nested report stays a nested report.
3. **An unnamed level is ascending**, which is what it was before.
4. **Ties break on the next level, then on the engine's order** (`Array.sort`
   is stable), so two runs of the same report are identical row for row.

Two consequences are deliberate and documented in the code:

- **Blank groups.** `(none)` sorts **last when ordering by a key**, in either
  direction — a descending report should not open on "(none)". When ordering by
  a **measure**, a blank group takes the place its figure earns: a `(none)`
  bucket holding ₹3.63 crore is the most interesting row on the sheet, and
  burying it would hide exactly what the audit found (§7.2, truncation).
- **Column levels are never re-ordered by a row sort.** The column axis stays
  chronological/ascending, so a descending row sort cannot reverse the months
  across the top of a pivot.

### 18.3 Where the order is decided

| Layer | What it does |
|---|---|
| `mbqlCompiler.summaryOrderBy` | emits `order-by` with the **row levels in nesting order**, each with its requested direction, and the aggregation inserted **before the deepest level** |
| `matrix.rowComparator` | re-establishes the same order over the distinct row tuples, because the matrix builds groups from three separate queries (main, row totals, grand) |
| `matrix.distinctTuples` | takes the comparator for rows; columns keep ascending-by-key |

The aggregation is inserted *before* the deepest level, not appended after all
of them. Appended, a single-level report's unique dimension settles every
comparison first, and the engine's order — and therefore the XLSX export, which
is the engine's rows written straight out — comes back alphabetical while the
sheet is correctly by figure. That is the one non-obvious line in the slice.

Compiled shapes, from `test/accountant/reporting-sorting.test.js`:

```
sort: Total Debit desc, rows [Ledger]
  order-by  [["desc", ["aggregation", 0]], ["asc", ["field", <ledger>, null]]]

sort: Total Debit desc, rows [Group, Ledger]
  order-by  [["asc",  ["field", <group>,  null]],
             ["desc", ["aggregation", 0]],
             ["asc",  ["field", <ledger>, null]]]
```

**Comparison charts are the exception.** `compileChartQuery` passes
`includeMeasure: false` for a layout with comparisons, because conditional
aggregations renumber the aggregation indexes and a stale index would order the
chart by the wrong figure in silence. Such a chart falls back to dimension
order. Ordering by the wrong column is worse than ordering by the obvious one.

### 18.4 Evidence — offline

`npx jest test/accountant/reporting --testPathIgnorePatterns 'reporting-integration.route|reporting-chart-integration.route'`

```
Test Suites: 8 passed, 8 total
Tests:       292 passed, 292 total
```

Of those, **29 are the new `test/accountant/reporting-sorting.test.js`**:
dimension asc/desc; Month asc/desc across December→January; financial-year
keys; Total Debit asc/desc; Count asc/desc; the first-value rule; a missing row
total falling back rather than throwing; equal figures stable from both input
orders; blanks last for a key sort and in their figure's place for a measure
sort; nested groups kept whole with their subtotals; an outer level sorted
while the inner is not; the column axis staying chronological under a
descending row sort; totals and grand totals never sorted in as ordinary rows;
export/chart order agreement; and a saved-layout round trip that preserves the
sort.

The two sorting **GAP** tests in `reporting-semantic-contract.test.js` were
converted to **property** tests (a summary honours its direction; a sort by a
calculated value orders by the figure), and the two in
`reporting-layout.test.js` to assertions on nesting order and on a measure sort
reaching the query.

**Mutation checks — five, all caught** (each copies the module beside itself,
edits one expression, and asserts a passing check now fails):

| Mutation | Caught by |
|---|---|
| the requested direction ignored (`direction` forced to `asc`) | dimension desc |
| measure ordering disabled (`measureValueOf` dropped) | Total Debit desc |
| semantic keys replaced with formatted text (`periodKey` → `periodText`) | Month across the year boundary |
| tie-breaking removed (comparator returns 0 on equal figures) | equal-figure determinism |
| the measure dropped from `order-by` | compiled-query assertion |

### 18.5 Evidence — live, against the mart

`npm run test:reporting:live` → **37 passed, 2 suites** (Metabase v1.63.1 OSS,
the real reporting mart). Every new check compares the returned order with a
**direct Postgres query on `reporting.v_general_ledger`**, not with another
GRAV response.

Mart totals for the window used throughout (company GRAV CLOTHING,
2025-08-01 – 2025-10-31): **debit ₹21,024,380.25, credit ₹21,024,380.25,
921 lines** — unchanged by this slice, as expected: B3 reorders rows and
computes nothing.

| Live check | Compared with |
|---|---|
| Ledger Group asc **and** desc | `GROUP BY group_name ORDER BY group_name ASC/DESC` — exact match, and desc is the reverse of asc |
| Ledger Name by Total Debit, desc **and** asc | `GROUP BY ledger_name ORDER BY SUM(debit) DESC/ASC` — figure sequence exact; names within one figure compared as a set |
| Month asc **and** desc, unfiltered | `GROUP BY period_month ORDER BY period_month` — exact, including `…,2025-12,2026-01,…` ascending and `…,2026-01,2025-12,…` descending |
| Sorted pivot (Group › Ledger × Month, group desc) | groups in mart's descending order, each contiguous and closed by its own subtotal; column headings equal the mart's months in chronological order |
| XLSX vs preview, sorted by Total Debit desc | row-for-row equal, and the first row is the mart's largest group |
| Bar chart, sorted by Total Debit desc | Metabase's own `/api/embed/card/…/query` rows equal `ORDER BY SUM(debit) DESC, group_name ASC` and equal the preview |

Two honest caveats, both written into the tests:

- **Collation.** GRAV breaks ties with JavaScript's locale collation
  (case-insensitive) and Postgres with its own (`ROUND OFF` before
  `Reliance …`). The figure sequence must match exactly; the names *inside one
  figure* are compared as a set. The tie-break itself is pinned offline.
- **The preview cap.** Preview returns at most 100 rows, so a mart comparison
  compares the prefix and drops the tie-group the cap lands inside, and a
  sorted pivot's final group may be cut off before its subtotal. That cap is
  finding 5 and is slice B4/B5 work, untouched here.

### 18.6 Before and after, from the live pilot

Ledger Group × Total Debit, GRAV, Aug–Oct 2025 (first six rows):

| Request | Before B3 | After B3 |
|---|---|---|
| `ledger.group asc` | Administrative Expenses, Bank Accounts, Capital Account, Cash-in-Hand, Current Assets, Direct Expenses | *(unchanged)* |
| `ledger.group desc` | **identical to asc** | Unsecured Loans, Sundry Debtors, Sundry Creditors, Sales Accounts, Loans & Advances (Asset), Inventory |
| `amount.debit desc` | alphabetical — the request had no effect | Bank Accounts ₹7,552,307 · Sundry Creditors ₹5,246,026 · Sundry Debtors ₹2,261,500 · Fixed Assets ₹1,731,976.78 · Administrative Expenses ₹1,475,286 · Inventory ₹1,372,699.95 |
| `date.month desc` (unfiltered) | always ascending | September 2026 … January 2026, December 2025 … July 2025 |

### 18.7 Files touched

| File | Change |
|---|---|
| `services/reporting/matrix.js` | `compareValues` takes the field and uses `semantics.periodKey`; new `rowComparator`; `distinctTuples` accepts a comparator; `shapeSummary` builds the measure lookup from the row-total index |
| `services/reporting/mbqlCompiler.js` | new `summaryOrderBy`, used by `compilePlan` and `compileChartQuery` |
| `test/accountant/reporting-sorting.test.js` | new — 29 tests including 5 mutation checks |
| `test/accountant/reporting-semantic-contract.test.js`, `reporting-layout.test.js` | four GAP tests became property tests |
| `test/accountant/reporting-integration.route.test.js`, `reporting-chart-integration.route.test.js` | the live GAP test became five mart-checked ordering tests |

No route, no response shape, no figure changed.

---

## 19. What slice B4 shipped — the response says how much it is showing

### 19.1 The contract, additive

Two new fields on every matrix, and one field that finally means what its name
says. Nothing was removed or renamed.

```jsonc
{
  "previewRowCount": 100,       // data rows actually in `rows`
  "groupCount": 333,            // every distinct data group, before the limit
  "totalRowCount": 333,         // unchanged: the COMPLETE count
  "truncated": true,
  "omitted": {
    "rows": 233,
    "values": {
      "[]::amount.debit:total":  123008184.55,
      "[]::amount.credit:total": 115481026.93,
      "[]::amount.signed:total":   7527157.62
    }
  }
}
```

| Field | Means |
|---|---|
| `previewRowCount` | the number of `kind: "data"` rows in `rows`. Never the group count. |
| `groupCount` | every distinct data group the filters match, before the preview limit. `null` in a detail list, which has records rather than groups. |
| `totalRowCount` | **kept for compatibility**, meaning unchanged: the COMPLETE count — identical to `groupCount` in a summary, the record count in a list. |
| `truncated` | `groupCount > previewRowCount`. |
| `omitted` | `null` when nothing was left out. Otherwise `rows` = `groupCount − previewRowCount`, and `values` carries one entry per leaf column, keyed by the **stable public leaf id the response already publishes**. |

`omitted.values[leafId]` is `null` — present, not absent — for a column no
honest sum exists for: an **average**, a **minimum**, a **maximum**, and a
**percentage change**. An average of averages is not an average. Every additive
column (`total`, `count`, a `difference` comparison, a `side_by_side` prior
value, and the row-total column) carries a real number, with its own sign.

In **detail mode** `groupCount` is `null` and `omitted` is
`{ rows: <known exactly from the count query>, values: null }` — a list is not
aggregated, so the omitted records' figures are genuinely unknown without
fetching them, and `null` says so rather than returning zeroes.

Nothing else changed: no new endpoint, no engine field, no MBQL, no table or
column name. The keys in `omitted.values` are the same `leafColumns[].id`
strings the browser already receives.

### 19.2 How the omitted figure is obtained

`shapeSummary` builds the **whole** report in the B3 order, then cuts it. What
follows the cut is, by construction, the tail of the sorted result — so
ascending and descending drop different groups, and each reports its own tail.
The figure is summed **from those omitted rows, cell by cell**.

It is deliberately *not* computed as `grandTotal − visible`. A subtraction
always reconciles: it would absorb any disagreement between the grand-total
query and the group query into a number that looks correct. It also could not
work at all here — `grandTotal`'s cells are `null` when row totals are off.

This is the one place in `matrix.js` that adds anything up, and the file's
header now records the exception and why it is safe: those rows are on no
screen and in no workbook, so there is nothing for the arithmetic to contradict.

**One bound worth stating:** `groupCount` is the number of groups the engine
returned, and Metabase's `/api/dataset` applies its own result ceiling
(10,000 rows for an aggregated query). A report with more distinct groups than
that would under-report `groupCount`; no layout in the pilot comes close, and
bounding the query is slice B6.

### 19.3 Evidence — offline

`npx jest test/accountant/reporting --testPathIgnorePatterns 'reporting-integration.route|reporting-chart-integration.route'`

```
Test Suites: 9 passed, 9 total
Tests:       322 passed, 322 total
```

**New: `test/accountant/reporting-counts.test.js` — 28 tests**, covering the
333-groups-capped-at-100 case (100 / 333 / 233); returned rows + omitted rows =
`groupCount`; visible + omitted = complete for every leaf; debit and credit
reconciling independently; a signed amount staying signed; ascending and
descending dropping disjoint tails and both reconciling; two-level grouping
counting only leaf groups while the physical array runs longer than the limit;
a column grouping reporting under the correct stable leaf ids with nothing
internal in the keys; average/minimum/maximum and percentage-change columns as
`null` while the measure beside them still reconciles; a `count` omitted as a
count; an untruncated report returning `omitted: null`; a report exactly at its
limit not counting as truncated; detail-mode semantics; and a JSON round trip
that keeps `omitted: null` as a present null.

**Mutation checks — six, all caught:**

| Mutation | Caught by |
|---|---|
| `previewRowCount` set back to the group count | the 333-row case |
| subtotal rows counted as preview rows | the nested case |
| the omitted tail taken from the unsorted engine result | the sorted tail's own sum |
| `omitted.values` dropped | the flat case |
| the visible rows summed instead of the omitted ones | the reconciliation |
| signs stripped (`Math.abs`) | the signed-amount case |

The GAP test `previewRowCount is the GROUP count` in
`reporting-semantic-contract.test.js` became the property test
`previewRowCount is the number of DATA ROWS RETURNED`. At the route level
(`reporting.route.test.js`, real middleware and a fake engine) the matrix
contract's key list now includes `groupCount` and `omitted`, a test reads the
whole B4 payload back off the wire including the negative, and a second test
pins that an unowned or mixed company request is refused **403 with the engine
never called**.

### 19.4 Evidence — live, against the mart

`npm run test:reporting:live` → **39 passed, 2 suites**.

The audit's own case — every ledger for GRAV CLOTHING, unfiltered, limit 100:

```
previewRowCount 100 · groupCount 333 · totalRowCount 333 · truncated true · omitted.rows 233
```

| Series | Visible (100 rows) | Omitted (233 rows) | Sum | Mart |
|---|---:|---:|---:|---:|
| Debit  | 22,394,406.44 | 123,008,184.55 | **145,402,590.99** | 145,402,590.99 |
| Credit | 29,921,564.06 | 115,481,026.93 | **145,402,590.99** | 145,402,590.99 |
| Signed | −7,527,157.62 | +7,527,157.62 | **0.00** | 0.00 |

`SELECT count(DISTINCT ledger_name), SUM(debit), SUM(credit), SUM(signed_amount)
FROM reporting.v_general_ledger WHERE company_id = <GRAV>` → 333 ledgers and
those three totals. Visible debit is **15.4%** of the money, which is the
finding — now a number in the response instead of a boolean.

A second live test sorts the same report by Total Debit ascending and
descending: the two keep disjoint sets of a hundred ledgers, report different
omitted figures, and both reconcile to 145,402,590.99. The live detail-mode
test now also pins `groupCount: null` and `omitted: { rows, values: null }`.

### 19.5 What B4 does not do

B4 **measures** truncation. It does not reduce it, and it does not decide what
to do about it:

- the 100-row preview cap is unchanged (finding 5, slice B6);
- the omitted groups' **identities** are still not listed — only their count
  and their value;
- **Lane A must still decide** whether to draw an "Other" bucket from
  `omitted.values`, annotate the chart with what is missing, or refuse to draw
  an incomplete chart at all. The backend now gives it the figures to do any of
  the three honestly; it does not choose for it.
- a sorted pivot's final group may still be cut off before its subtotal — the
  cut is counted in data rows, and that is the cap's behaviour, not B4's.

### 19.6 Files touched

| File | Change |
|---|---|
| `services/reporting/matrix.js` | `shapeSummary` cuts first and counts what it kept; new `omittedValues`; `shapeDetail` gains `groupCount: null` and `omitted`; header documents the counts and the one arithmetic exception |
| `test/accountant/reporting-counts.test.js` | new — 28 tests including 6 mutation checks |
| `test/accountant/reporting-semantic-contract.test.js` | the count GAP became a property test |
| `test/accountant/reporting-layout.test.js` | detail-mode counts pinned |
| `test/accountant/reporting.route.test.js` | the contract's key list, the payload off the wire, and refusal-before-engine |
| `test/accountant/reporting-integration.route.test.js` | the 333-ledger reconciliation and the asc/desc tails, live |

No route, no engine call, no figure on any existing row changed.

---

## 20. What slice B5 shipped — a workbook, not a database dump

### 20.1 The architecture line

Recorded in full in `docs/decisions/metabase-pivot-export-capability.md`, and
repeated here because it is the thing that must not erode:

| Owner | Responsibility |
|---|---|
| **Metabase** | filtering, grouping, calculation, comparison, and the ORDER of the result. Every figure in the file is one it computed. |
| **GRAV** | the heading a person reads, whether a cell is a date, a number or text, the number format, and basic worksheet usability. |

`services/reporting/workbook.js` writes the rows of **the same compiled export
plan** — same filters, same grouping, same B3 order — row for row. It adds,
totals, averages, pivots, compares, re-sorts and drops nothing, and a mutation
check fails if it ever starts. There is no second aggregation path.

**The file is still the flat aggregation and still says so.** A Ledger Group ×
Month report is a three-column list; `X-Reporting-Layout: flat-aggregation` and
its note are unchanged. Nothing claims parity with the pivoted worksheet, and
B5 did not take the pivoted-workbook decision.

### 20.2 Transport, and why it is bounded

The workbook is built from `POST /api/dataset` (JSON rows) instead of
`/api/dataset/xlsx`, and streamed out through ExcelJS's `WorkbookWriter`
straight into the response. **No workbook is loaded on either side** — not the
engine's, and not ours; shared strings are off deliberately, since that table
would have to be held to the end.

Measured before implementing, at the 100,000-row export ceiling
(5 columns, this machine):

| | |
|---|---|
| result rows held in memory | +25 MB |
| RSS peak while writing | ~197 MB (from a 72 MB baseline) |
| workbook produced | 3.5 MB |
| time | 0.71 s |

One thing had to change with it: `/api/dataset` applies a default ceiling of
**2,000 bare rows**. Measured on the pilot, an unconstrained detail query
returned exactly 2,000 of 5,604 rows, so the export passes explicit
constraints **one above** the 100,000-row ceiling — an oversized report is
refused with a message rather than silently trimmed. That closes a gap the old
path had for summaries, which were never row-capped at all.

### 20.3 The cell rules

Read from the B1/B2 semantic type, never from the heading text.

| Semantic type | Cell | Format |
|---|---|---|
| `month` | Excel **date** at the month start | `mmmm yyyy` |
| `date` | Excel **date** | `dd mmm yyyy` |
| `quarter`, `financial_year` | **text** (`Q3 2025`, `2025–26`) | — |
| `currency`, `currency_signed` | **number**, sign intact | `₹#,##,##0.00;-₹#,##,##0.00` |
| `count` | **number** | `#,##0` — no rupee sign, no decimals |
| `quantity` | **number** | `#,##0.###` |
| `percentage`, `gst_rate` | **number**, the engine's own value | `0.00"%"` |
| `boolean` | text `Yes` / `No` | — |
| `enum`, `status` | the choice's **label** (`Credit Note`) | — |
| `identifier`, `free_text`, text | **text** — `00531` keeps its zeroes | — |
| null / undefined / `""` | **empty cell** | — |

Three of these are decisions rather than mechanics:

- **Nothing is a formatted string.** It would be easy to write `"₹1,23,456.78"`
  everywhere and have the file look perfect; it would also be a spreadsheet
  nobody can sum, sort or filter, which is why an accountant asked for Excel
  rather than a PDF.
- **The percentage does not multiply.** A GST rate arrives as `18`, meaning
  18%. Excel's own `0.00%` would print `1800.00%`, and dividing by 100 to suit
  the format would put a number in the cell that is not the engine's. So the
  value stays `18` and the sign is a literal in the format.
- **A quarter and a financial year are text.** Excel's number formats have no
  quarter token, and `2025–26` is not a date at all; writing either as a date
  would mean picking a day to stand for it and hoping nobody sorts by it.

`gst_rate`, `quantity` and `boolean` are in the B1 vocabulary but no catalogue
field carries them yet, so they cannot be reached through a layout. They are
pinned at the formatter so they are right the day such a field is offered,
rather than discovered in a customer's file — and the audit says so rather
than implying live coverage.

**Headings.** A dimension uses the layout's heading. A calculated column uses
the user's heading *as typed* when they renamed it, and otherwise qualifies
the field's own label with its calculation — `Total Debit`, `Count of Debit`,
`Average Debit` — because a column of summed debits headed "Debit" is the
engine's `Sum of Debit` problem in a friendlier font.

**Usability.** Frozen heading row; autofilter over the whole range; bold,
shaded, ruled headings; column widths from the actual contents, floored at 10
and capped per type (narration at 60, so a 4,000-character narration cannot
create an unbounded column); the report's own name as the worksheet name,
sanitised to Excel's rules (31 characters, no `[ ] : * ? / \`). Filename,
`Content-Disposition`, `Cache-Control: no-store, private` and the layout
headers are unchanged.

### 20.4 Evidence — offline

`npx jest test/accountant/reporting --testPathIgnorePatterns 'reporting-integration.route|reporting-chart-integration.route'`

```
Test Suites: 10 passed, 10 total
Tests:       351 passed, 351 total
```

**New: `test/accountant/reporting-workbook.test.js` — 29 tests.** Every
workbook is written with the real streaming writer and **opened again with
ExcelJS**, then read cell by cell: a test that asserted on the writer's inputs
would pass while the file said something else.

**Mutation checks — seven, all caught, and each required to die of the
assertion rather than of a crash:**

| Mutation | Caught by |
|---|---|
| the engine's heading restored | the month summary's headings |
| a month written `mmmm d, yyyy` | the month cell's format |
| a voucher number turned into a number | `00531` |
| money written as text | the money cell's Excel type |
| a percentage format that multiplies | the rate cell |
| a null turned into zero | the blank cell |
| the rows re-sorted on this side | the engine's order |

### 20.5 Evidence — live, four workbooks opened and reconciled

`npm run test:reporting:live` → **45 passed, 2 suites.**

**1. Detail — August 2025** (`August detail`, 215 rows, autofilter `A1:E216`):

| Column | Value | Excel type | Format |
|---|---|---|---|
| Voucher Number | `"1"` | **String** | — |
| Voucher Date | `2025-08-12T00:00:00.000Z` | **Date** | `dd mmm yyyy` |
| Party | *(empty)* | **Null** | — |
| Debit | `2000` | **Number** | `₹#,##,##0.00;-₹#,##,##0.00` |
| Credit | `0` | **Number** | `₹#,##,##0.00;-₹#,##,##0.00` |

Reconciliation: 215 rows and ΣDebit **7,823,251.17** against the mart's 215
lines and 7,823,251.17 for August. A zero is written as a zero and a genuinely
absent party as an **empty cell** — the two are different facts and the file
keeps them different.

**2. Month summary** — headings `Month | Total Debit`; `2025-08-01T00:00:00.000Z`
as a **Date** formatted `mmmm yyyy` (not `mmmm d, yyyy`, and not July); three
rows totalling **21,024,380.25**.

**3. Ledger Group × Month, flat** — headings `Ledger Group | Month | Total Debit`;
49 rows, one per combination; total **21,024,380.25**;
`X-Reporting-Layout: flat-aggregation` present.

**4. Count and money together** — headings `Ledger Group | Count of Debit |
Total Debit`; `7` as a **Number** formatted `#,##0` with no rupee sign beside
`1,475,286` formatted as rupees; 19 rows; total **21,024,380.25**, and every
row's count and figure checked against `GROUP BY group_name` in the mart.

All three summaries reconcile to the mart's **₹2,10,24,380.25** for
2025-08-01 – 2025-10-31, and the detail workbook to **₹78,23,251.17** for
August — the same figures the audit recorded before B5, which is the point:
presentation changed, arithmetic did not.

Also pinned live: `00531` survives as text; an unowned **and** a mixed company
request are refused **403 before any export runs**, with a JSON body and no
`Content-Disposition`; and no cell, sheet name, workbook property or response
header carries `v_general_ledger`, a mart column name, MBQL vocabulary,
"metabase" or a credential — the one deliberate exception being
`flat-aggregation` itself, which exists so nobody assumes the file is the pivot.

### 20.6 Files touched

| File | Change |
|---|---|
| `services/reporting/workbook.js` | new — columns, headings, cell rules, widths, the streaming writer |
| `services/reporting/metabaseEngine.js` | `runExport` returns the plan's raw rows with explicit constraints and an overflow refusal, instead of the engine's workbook stream |
| `routes/Accountant_Routes/Acc_reporting.js` | the export route writes the workbook into the response; headers unchanged |
| `docs/decisions/metabase-pivot-export-capability.md` | the ownership line recorded |
| `test/accountant/reporting-workbook.test.js` | new — 29 tests, 7 mutation checks |
| `test/accountant/reporting.route.test.js` | the fake engine returns rows |
| `test/accountant/reporting-integration.route.test.js` | the XLSX GAP test became seven live workbook tests |

No preview response, chart, saved report, sort or count changed.

---

## 21. What slice B6 shipped — a budget, a deadline, a ceiling and one log line

### 21.1 The constants, and where they come from

A summary is not one query: it is a plan of separate aggregate queries — the
cells, the row totals, the column totals, the grand total, a pair per nesting
level for the subtotals, and the whole lot again per comparison. Judging a
report by its shelves therefore says almost nothing about what it costs, which
is how a 22-query layout passed every limit the product had.

Measured on the pilot, with the query count recomputed from the plan the
compiler actually builds (§12 counted 10 for five rows by observation; the
plan holds 11):

| Layout | Queries | Units | Live result after B6 |
|---|---:|---:|---|
| detail list, 4 columns | 2 | 4 | **200** · 574 ms · 37 KB |
| 1 row + 1 value | 3 | 1 | **200** · 295 ms · 3 KB |
| Ledger Group × Month, Debit + Credit | 4 | 2 | **200** · 396 ms · 10 KB |
| 2 rows + 1 column | 6 | 2 | passes |
| 4 rows × 2 columns × 3 values | 10 | **24** | **200** · 1,107 ms · 207 KB |
| 5 rows (the shelf cap) | **11** | 5 | **200** · 1,012 ms · 82 KB |
| 5 rows × 1 column × 5 values | 11 | **25** | **422** · 3 ms |
| 5 rows + 3 columns + 8 values | **12** | 120 | **422** · 5 ms *(was 2,443 ms / 1.76 MB)* |
| 5 rows + 1 comparison | **22** | 10 | **422** · 3 ms *(was 2,770 ms)* |

```
maxQueries        11        the heaviest plan that behaved well (1.5 s, 82 KB);
                            the two that did not are 12 and 22
maxLayoutUnits    24        the other axis — the 12-query layout is one query
                            over the line but 120 units over it, and what made
                            it 1.76 MB was 3 × 8 leaf columns against five
                            levels of grouping, not the query count
maxResponseBytes  1,500,000 seven times the largest accepted body measured
                            (207 KB) and BELOW the 1.76 MB case, so the same
                            layout gets the same answer whichever gate catches it
previewDeadlineMs 20,000    seven times the slowest legal preview measured
                            (2.8 s), and under the engine's per-call 30 s
```

`layoutUnits = max(rowFields,1) × max(columnFields,1) × (values + comparisons)`
— the structural size of the sheet, before any figure is known. Cardinality
cannot be known at preflight; this is the part of the cost the layout decides.

**The per-shelf limits were not reduced.** Five row levels is still a legal
report and still previews. B6 added a gate on the whole plan; it did not shrink
the product to make the gate easy.

### 21.2 The count is the compiler's, not a formula

`previewBudget.estimate` obtains `queryCount` by compiling the real plan with
`compilePlan` and counting what it holds. A structural formula written by hand
would be a second definition of the plan's shape and would drift the first time
a total or a subtotal moved — and a mutation check fails if the count is
replaced by one derived from the shelves.

The compile uses **placeholder field ids**: a plan's shape does not depend on
which table it points at. So the estimator makes no network call and needs no
engine metadata, which is what lets an over-budget report be refused with the
engine never contacted — measured live at **3–5 ms and 231 bytes**.

### 21.3 One deadline for the whole preview

Before B6 every query in a plan received the engine's full 30-second timeout of
its own: twelve queries could occupy a request for six minutes while each call
was individually "in time". Now a deadline is created once per request and
handed down; each call gets whatever is **left** of it, and the plan checks it
**before** starting the next query rather than after wasting one.

- Expiry → `REPORTING_UNAVAILABLE`, 504, *"This report took too long to
  preview. Add a filter or remove part of the breakdown and try again."*
- **Nothing partial is returned** — no rows, no totals, no comparisons. The
  results object is never half-built.
- A **client disconnect** aborts the in-flight call and stops the rest of the
  plan. It is not an error: a superseded preview is a person typing, so it is
  recorded as `outcome: "cancelled"` and never logged as a crash.
- The clock is **injected**, so the tests prove all of this without sleeping.

### 21.4 The byte ceiling

Measured on the finished body, because the honest size of a matrix is decided
by cardinality and is not knowable from the layout. Over the ceiling the
**whole** result is refused with the same actionable text; it is never trimmed.
A preview cut to fit would be a report missing rows with nothing saying which —
the exact failure B4 exists to prevent.

Refusal (422 `REPORTING_INVALID_SPEC`), as the browser receives it:

```json
{
  "ok": false,
  "code": "REPORTING_INVALID_SPEC",
  "message": "This report is too large to preview. Remove a grouping or calculated amount, or add a filter.",
  "report": { "rowGroupings": 5, "columnGroupings": 3, "calculations": 8, "comparisons": 0 }
}
```

It says what the person must change and names no table, column, query, card or
engine. The over-size variant carries the same `report` block with *"This
report produced too much data to preview. Narrow the report — …"*.

### 21.5 One line per preview

```json
{"outcome":"ok","refusedBy":null,"mode":"summary","queryCount":4,"rowFields":1,
 "columnFields":1,"values":2,"comparisons":0,"layoutUnits":2,"previewRowCount":19,
 "bytes":10103,"ms":396}
```

Counts and outcomes only: **no report name, no filter value, no ledger or party
name, no figure, no row, no query, no identifier of anything inside the
engine** — a log carrying a company's numbers is a second copy of the accounts
in a place nobody is guarding. `outcome` is `ok` | `refused` | `cancelled` |
`invalid` | `error`, and `refusedBy` is `complexity` | `size` | `deadline` |
`client` | null. **One line per request, not per query**: a twelve-query plan
writing twelve lines would bury the one fact worth having.

### 21.6 The order, which is the security property

```
authentication → organisation from the session → every company, all-or-nothing
→ canView → layout validation → COMPLEXITY → the engine
```

An unowned or mixed-company request answers **403 with zero engine calls and no
hint that its layout was expensive** — a probe learns nothing about another
organisation's data, not even its shape. Two mutation checks enforce this: one
moves the complexity gate after execution, one moves the company check after
the gate, and both are caught.

### 21.7 Evidence

`npx jest test/accountant/reporting --testPathIgnorePatterns 'reporting-integration.route|reporting-chart-integration.route'`

```
Test Suites: 12 passed, 12 total
Tests:       394 passed, 394 total
```

Two new suites: **`reporting-bounds.test.js` (23 tests)** for the budget, the
injected-clock deadline and the ceiling, and **`reporting-bounds.route.test.js`
(20 tests)** for the route — the only place that can prove a refusal happens
with the engine never contacted, because its fake engine counts calls.

**Mutation checks — eight, all caught** (four in the pure suite, four against a
copy of the route module mounted on its own port):

| Mutation | Caught by |
|---|---|
| cost guessed from the shelves instead of the plan | the 22-query comparison |
| a fresh deadline per query | the three-call plan under one clock |
| execution continuing after expiry | no call is made at all |
| the byte ceiling raised past the measured case | 1.76 MB |
| complexity checked after the engine runs | zero engine calls |
| the company check moved after the complexity gate | 403 without a `report` block |
| an oversized body returned trimmed | the refusal's own size |
| the layout logged in the telemetry line | the report's name |

Live (`npm run test:reporting:live` → **48 passed, 2 suites**): the boundary
layout previews in 1,107 ms; the 1.76 MB layout and the 22-query comparison are
refused in 3–5 ms with 231-byte bodies and the engine never asked; and the same
five levels **without** the comparison still return 200, so it is the plan being
judged and not the shelves.

B3 ordering, B4 counts and B5 exports are unchanged — all their suites pass
untouched, and the export's 100,000-row ceiling is a separate bound that B6 did
not alter.

### 21.8 Files touched

| File | Change |
|---|---|
| `services/reporting/previewBudget.js` | new — the budget, the plan-derived query count, the refusal body, the byte ceiling |
| `services/reporting/deadline.js` | new — one injectable clock per request |
| `services/reporting/metabaseEngine.js` | the deadline threaded through `call`/`runQuery`/`runPlan`/`runPreview`; `timedOut` and `clientGone` on `ReportingError`; `previewDeadlineMs` |
| `routes/Accountant_Routes/Acc_reporting.js` | the gate before the engine, one deadline per request, the size check, and `auditPreview` |
| `test/accountant/reporting-bounds.test.js`, `reporting-bounds.route.test.js` | new — 43 tests, 8 mutation checks |
| `test/accountant/reporting-integration.route.test.js` | three live boundary tests |

No preview shape, sort, count, workbook or saved report changed.

