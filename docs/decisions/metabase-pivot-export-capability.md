# Capability gate — Metabase 63.1 and the PivotTable contract

Run 25 Sep 2026 against the running pilot (`v1.63.1`), the real
`reporting.v_general_ledger` data for GRAV CLOTHING, and the least-privilege
server API key. Server-side MBQL only; no native SQL was sent.

## Result: PASSES, with one material exception

| Capability | Result |
|---|---|
| Two nested row fields | **PASS** — `breakout: [group_name, ledger_name]`, 271 rows |
| One column field | **PASS** — `["field", voucher_date, {"temporal-unit":"month"}]` |
| Two value calculations | **PASS** — `[["sum", debit], ["sum", credit]]` |
| Filters | **PASS** — `between` on date, ANDed under the tenant filters |
| Deterministic ordering | **PASS** — multi-key `order-by` honoured |
| Comparison calculation | **PASS**, but see below |
| XLSX export | **PASS** — flat aggregation only |
| **Pivoted XLSX** | **FAIL** |

## The two findings

### 1. MBQL has no `offset` aggregation in 63.1's legacy dialect

```
["offset", ["sum", ["field", <id>, null]], -1]
→ 500 "Error creating query from legacy query: Assert failed: (= (count clause) 4)"
```

So a period-over-period comparison cannot be expressed as a single query.
It is done instead as **two queries with a server-shifted date filter**, combined
by GRAV. That is still server-side, still truthful, and still identical between
preview and export because both run the same pair. Division by zero yields a
defined `null`, never `Infinity`.

### 2. THE XLSX ENDPOINT CANNOT EXPORT A PIVOTED STRUCTURE

`POST /api/dataset/xlsx` with `pivot_results=true` returns **HTTP 500,
`java.lang.NullPointerException`**, in every form tried:

- `pivot_results=true` alone
- `pivot_results=true` with `"pivot-options": {"pivot-rows": [...], "pivot-cols": [...]}` in the query
- `pivot_results=true` with a `visualization_settings` `pivot_table.column_split`

Only the plain flat export works.

**What the workbook therefore contains: the flat aggregation, not the matrix.**
For a report of Ledger Group × Month × Sum of Debit, the preview is a pivot
(one row per group, one column per month) and the workbook is a three-column
list (`Group Name | Voucher Date: Month | Sum of Debit`), one row per
combination.

The numbers are the same to the paisa — verified: the flat export and the
preview query returned **36 rows each** with `SUM(debit) = 21,024,380.25` on
both sides. The **shape** differs, and the export must say so rather than imply
parity.

## What this changes

- The workbook is **not** claimed to match the preview. The export route and the
  UI copy must say that it contains the same figures in a flat list.
- **No spreadsheet generator was added.** Adding ExcelJS to produce a pivoted
  workbook is a real option and a real cost — a second definition of what the
  report looks like, which is exactly what handing the job to one engine was
  meant to avoid. That is a decision to take deliberately, not a gap to fill
  quietly, so this stops here and reports it.
- The preview remains fully useful and is implemented in full: the matrix, its
  nesting, subtotals, totals and comparisons are all GRAV's shaping over
  Metabase's aggregation.

---

## Refinement (B5, 26 Sep 2026): GRAV owns presentation, Metabase owns figures

The bullet above — "no spreadsheet generator was added" — is now **partly
superseded, deliberately and narrowly**. ExcelJS was already a dependency of
this repository, and the audit found the downloaded workbook carrying the
engine's own column names (`Period Month`, `Group Name`, `Sum of Debit`), a
month written as `August 1, 2025`, and money as an unformatted number. Those
are presentation defects, and presentation is the one thing Metabase could not
be asked to fix.

**The line, which is the whole point of this note:**

| Owner | Responsibility |
|---|---|
| **Metabase** | filtering, grouping, calculation, comparison, and the ORDER of the result. Every figure in the file is a figure it computed. |
| **GRAV** | the heading a person reads, whether a cell is a date, a number or text, the number format, and basic worksheet usability (frozen headings, autofilter, bounded column widths, sheet name). |

`services/reporting/workbook.js` writes the workbook from **the rows of the
same compiled export plan**, row for row, in the engine's order. It does not
add, total, average, pivot, compare, re-sort or drop anything, and its header
says so. There is no second aggregation path and there must never be one: two
engines means two answers, and only one of them ends up in an audit file.

**This is still the flat aggregation.** B5 changed how the file reads, not what
is in it. A Ledger Group × Month report is still a three-column list — now
headed `Ledger Group | Month | Total Debit` instead of
`Group Name | Voucher Date: Month | Sum of Debit` — and the response still
carries `X-Reporting-Layout: flat-aggregation` with its note. **Nothing claims
the workbook matches the pivoted worksheet.** Generating a genuinely pivoted
workbook remains the open decision this document was written to record, and
B5 did not take it.

One transport change came with it: the workbook is built from
`POST /api/dataset` (JSON rows) rather than `/api/dataset/xlsx`. That endpoint
applies a default ceiling of 2,000 bare rows, so the export passes explicit
constraints one above the 100,000-row export ceiling — an oversized report is
refused with a message rather than silently trimmed. Measured at the ceiling:
100,000 rows × 5 columns wrote a 3.5 MB workbook in ~0.7 s, with RSS peaking
near 200 MB including the result rows themselves, through ExcelJS's streaming
writer straight into the response. No workbook is held in memory on either
side.
