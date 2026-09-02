# Item-wise Budget Attribution

> **Status:** Chunk 1 (foundation) + Chunk 1.1 (integrity corrections) shipped.
> The mechanism is INERT — nothing in the live budget path reads it yet, by
> design.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Goal:** Let one request charge several unrelated items to several approved
> budget lines, without asking the requester to name an accounting head.

---

## The target model

```
Request
  └── item line          ─┬─ resolves to a budget head (item override → category → nothing)
                          └─ becomes ONE allocation
        ↓
   allocations ──► commitments (one per allocation, not one per request)
        ↓
   voucher actuals attributed per allocation
```

Today the chain is one head per request. `IntakeRequest.ledgerId` /
`budgetLineId`, `SpendRequest.budgetLineId` and a single
`Acc_BudgetCommitment` per request are the live authority, and they remain so
until a later chunk migrates the workflow deliberately.

### Why per-category, not per-item and not per-vendor

**Not per requester.** A requester knows they need cotton fabric. Making them
also name the head it is budgeted under asks the wrong person a question the
item already answers, and every wrong answer is a budget that reads
incorrectly for a year.

**Not per item.** 15 categories is a meeting that finishes. 259 items is a
project that never does, and the master grows weekly. Items inherit; an
override exists for the genuine exception.

**Never per vendor.** A vendor supplies more than one kind of thing — the live
data shows VRL Logistics at 83% freight and 17% labour across 69 bills. Keying
on the vendor is wrong 17% of the time forever. Rule 3 forbids inferring a head
from vendor, free-text name, posting ledger or voucher history, and nothing in
this chunk does.

---

## What Chunk 1 established

### Data

| Thing | Where | Note |
|---|---|---|
| `Acc_ItemCategoryBudget` | `models/Accountant_model/` | category → budget head, per company |
| `RawItem.budgetLedgerId` (+ name, setBy, setByName, setAt) | item master | the rare per-item override |
| `budgetAllocation` on item lines | `SpendRequest`, `IntakeRequest` | **inert** — see below |

### The resolver

`services/itemBudgetHead.service.js` — one answer, one vocabulary, used by the
APIs and (later) by the request flow. Three copies of this rule would drift,
and the shape of the drift would be a request approved against one head and
charged to another.

Precedence, in order:

1. `RawItem.budgetLedgerId` → `source: "item_override"`
2. Finance's category mapping → `source: "category_mapping"`
3. Nothing → `source: "unresolved"`, `budgetLedgerId: null`

Result shape, identical whatever the outcome (a key that appears only on the
happy path becomes an `undefined` in a stored document):

```js
{ budgetLedgerId, budgetLedgerName, source, category, message }
```

**Unresolved is an answer, not an error.** A guessed head that fills itself in
is worse than an empty field, because nobody re-checks something that already
looks answered. The two unresolved messages point at different desks: an
unmapped category is finance's decision, an uncategorised item is the store's
data.

### APIs

All under `/api/accountant/chart-of-accounts`, all `accountantAuth`, all
writes Finance-only (`owner`/`approver`/`admin`/`accountant`, or
`permissions.canApprove`).

| Method | Path | Does |
|---|---|---|
| `GET` | `/item-categories` | every category with item count, mapping status, mapped head; plus `itemsTotal`, `itemsMapped`, `itemsUnmapped`, `itemsUncategorised`, `pctMapped` |
| `PUT` | `/item-categories/:category` | set or clear one category's head |
| `PUT` | `/raw-items/:id/budget-head` | set or clear one item's override (company-scoped ledger check) |
| `GET` | `/item-budget-heads/items` | search the master, each item with its resolution (`search`, `category`, `onlyOverridden`; capped at 50, reports `capped`) |
| `POST` | `/item-budget-heads/resolve` | resolve `itemIds[]` for inspection/testing; answers for ids that match nothing, with `found: false` |

A mapping is checked three ways at the moment it is set, and they are
different questions (`assertMappable`):

1. **Does the ledger exist?** A client-supplied id is never trusted.
2. **Does it belong to this company?** A budget-eligible head belonging to
   another company is still another company's head. Refused with the *same
   wording* as a missing ledger — saying "exists, but not yours" confirms the
   existence of another company's records.
3. **Is it an `expense_budget`?** Not merely "budgeted". `revenue_target` is
   refused as well as `not_budgeted`.

**Why revenue targets are refused.** This mapping decides where purchase and
service SPEND is charged. A revenue target is a figure to hit, not an envelope
to spend from, so mapping a purchasable item to one is meaningless in a way
that would only surface as a sales target quietly consumed by procurement.
`budgetControlOf` allows both budgetable classes because the budget PICKERS
legitimately need both; this gate is narrower on purpose. The mapping pickers —
API and screen — request `?type=expense_budget` and never offer a revenue head.

GST, bank, cash, creditor, inventory, fixed asset, tax and rounding heads are
refused at the moment of mapping, not months later on a bill nobody can check.

### Category identity is normalised

`Fabric`, `fabric` and `Fabric ` reached the database as three rows, and a
mapping set on one spelling silently failed to apply to items carrying another
— a budget head that existed, was configured, and did nothing.

One rule, `itemBudgetHead.categoryKeyOf`: **strings only, trimmed, internal
whitespace collapsed, lower-cased.** Non-strings normalise to `""` rather than
being coerced, so a `0` cannot invent the category `"0"`.

It is used for writes, reads, uniqueness and coverage. A second normalisation
anywhere — even an equivalent one — would be a rule that can drift, and the
drift would look like a mapping that exists and does not work.

- Stored as `categoryKey` on the mapping; `category` is kept as the display
  label and is deliberately NOT unique, so a legitimate re-spelling is allowed.
- Unique compound index on `{ companyId, categoryKey }`, so the database
  refuses the duplicate rather than relying on every write path remembering to.
- Coverage groups by the key too, and reports the folded `spellings[]`. Two
  rows for one category would report the mapped half as covered and the other
  half as work no mapping could ever close.

**Duplicates are never resolved by guessing.** If two rows share a key and
point at *different* heads, `categoryMap` reports them on `conflicts` and
resolves that category to nothing. Picking either would charge real spend to a
head nobody chose, silently, and differently depending on which row the
database returned first. The Finance screen shows the conflict.

`reconcile_item_category_keys.js` backfills `categoryKey` on any pre-existing
rows and drops the superseded `{companyId, category}` index. It collapses
duplicates only where they **agree**; where they disagree it reports and leaves
them exactly as found. Dry run by default, `--apply` to write.

### Coverage is counted in ITEMS

"13 of 15 categories mapped" reads as nearly finished when the two missing ones
are Fabric and Accessories — half the master between them. Every figure on the
Finance screen is an item count.

Uncategorised items are reported **separately** from unmapped ones. An item
with no category cannot inherit anything and no amount of mapping fixes it; it
is the store's data to correct, so it is not counted as work finance has failed
to do.

### Frontend

`app/accountant/budgets/item-categories/page.js`, linked from the Budgets slab
beside Departments — a setup screen reachable only by typing its URL is a setup
screen nobody completes.

Two panels: categories (the rule) and single-item override (the exception,
placed second and worded to make the category the default answer). The override
table shows *why* an item resolves as it does, because an override and an
inherited head look identical otherwise.

Uses the accountant visual language (`AcctPageSlab`, `PageShell`, `Panel`,
`SearchableSelect`) and the shared head list from
`/api/accountant/budgets/ledger-options?type=expense_budget` — building a second
picker here would let this screen offer a head the budget check then refuses.

---

## What is deliberately INACTIVE

`budgetAllocation` is written into both request models and **populated by
nothing**. No commitment reads it, no budget check consults it, no request form
sets it.

This is the point. Two authorities for "which budget is this?" running at once
is exactly the ambiguity the field exists to remove. The request-level
`ledgerId` / `budgetLineId` stay the single source of truth until a later chunk
migrates the workflow in one deliberate move.

`status` is not derivable from `budgetLedgerId` alone: a null head means
`unresolved` when nobody has looked, and `manual_selection_required` once a
human has been asked and has not answered. The difference decides whether a
screen shows a prompt or a warning.

### Why the allocation shape is on `IntakeRequest` too

An intake request becomes a spend request, carrying its item lines with it. If
the shape existed only on `SpendRequest`, the conversion would be the moment a
resolution was invented rather than carried — and inventing it there would put a
second resolver in the codebase, which is what the single service exists to
prevent. Same field, same vocabulary, same `resolutionSource` values, added
additively to both.

---

## Compatibility guarantees

- **No migration is required.** Every field added is additive.
- `budgetAllocation` has `default: undefined`, so a legacy request line loads
  with the field **absent**, not defaulted. A default would manufacture an
  `unresolved` decision on thousands of historical lines that nobody ever made.
  Pinned by a test.
- A `RawItem` with no override resolves through its category exactly as if the
  field did not exist. Pinned by a test.
- Accounting posting is untouched. No voucher rule, commitment rule, actuals
  calculation or approval behaviour changed in this chunk.

---

## Known limits

**`RawItem` carries no `companyId`, so an override is GLOBAL.** The item master
is one shared catalogue in this deployment. An override set by one company's
finance team applies to that item for everyone, and this route cannot scope it
by company because there is nothing to scope it by.

What *is* enforced: the LEDGER an override points at must belong to the calling
company, and only Finance may write at all. The category mapping an item
resolves through is company-scoped, so two companies still get different heads
for the same item whenever no override exists.

**This remains a deliberate, documented limitation.** Making an override
per-company means adding a company dimension to the item master — a model
redesign with consequences well beyond budgets — and is not to be attempted
without its own approved task.

**The item master covers a minority of what is bought.** 384 items exist
(259 raw + 125 stock) against 1,276 distinct item names appearing on actual
vouchers, and 112 of 259 raw items carry no category. Mapping every category
still leaves free-typed items resolving to nothing. That is data work, not code.

---

## Chunk 1.1 — what it corrected

Four integrity gaps in the Chunk 1 foundation, all closed:

1. **Ledger company ownership** was unchecked — eligibility was the only test,
   so the sole barrier between two companies' charts was that nobody had tried
   pasting an id.
2. **Category identity** was matched case-insensitively at read time but stored
   raw, so duplicates could exist and a mapping could silently fail to apply.
3. **`revenue_target` was accepted** by a mapping that governs spend.
4. **Wording promised a workflow that does not exist** — "requesters will be
   asked to pick one" described a screen nobody can open. API messages and the
   Finance page now say the mapping is unresolved and will require resolution
   *when item-wise request allocation is enabled*, and state plainly that
   saving moves no budget.

## Next chunk (not started)

1. Request form resolves and displays a head per line, requester never types one.
2. `budgetAllocation` populated on submit; `manual_selection_required` where
   the resolver returns nothing.
3. Approver sees and can correct a head per line.
4. Commitments split per allocation instead of one per request.
5. Budget check attributes voucher legs per allocation.

Steps 4 and 5 are where the live budget path changes. Nothing before them
alters a number anybody currently reads.
