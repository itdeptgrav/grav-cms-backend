# Item-wise Budget Attribution

> **Status:** Chunk 1 (foundation) + Chunk 1.1 (integrity corrections) + B1
> (service defaults) + B2 (service classification before approval) + B3A
> (line-wise allocation) + B3B (voucher-line mapping, partial release) shipped.
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

## Chunk B1 — the service default contract (shipped, inert)

Services are bought and budgeted like materials and behave nothing like them
afterwards, so the Service Master is a separate master with a separate
resolution rule. B1 makes its `budgetLedgerId` operational and visible to
Finance. It does **not** touch the live budget path.

### The rule

| | Item | Service |
|---|---|---|
| 1 | `RawItem.budgetLedgerId` → `item_override` | `Service.budgetLedgerId` → `service_default` |
| 2 | category mapping → `category_mapping` | *(none)* |
| 3 | nothing → `unresolved` | nothing → `unresolved` |

**A service never falls through to an Item Category mapping.** A service has a
`category` field that looks exactly like an item's, and the Item Category
mappings describe what the STORE STOCKS. A service called "Consultancy"
inheriting the head mapped for consumables would charge professional fees to a
materials budget and look entirely deliberate on the report.

`headForService(service)` therefore takes **no map** — not "ignores one",
cannot receive one. `resolveServiceIds` never builds one. Both are pinned by
tests, one behavioural and one structural. Nothing is inferred from the
service's category, supplier, SAC code or GST rate either: a supplier sells
more than one kind of thing, a SAC code is a tax classification rather than a
budget one, and a GST rate is a percentage.

Result shape is identical to `headForItem`'s, so a caller handling both never
branches on which it received.

### Company scope — better than the item path

`resolveServiceIds` **is** company-scoped, because `Service` carries a
`companyId` and `RawItem` does not. Another company's service returns
`found: false` with no name, category, billing unit or configuration, worded
identically to a genuinely absent id — telling them apart would confirm that
the other company holds that record.

### APIs

All under `/api/accountant/chart-of-accounts`, all `accountantAuth`, all
gated by the same `financeOnly` + `mappingCompany` pair the item routes use.

| Method | Path | Does |
|---|---|---|
| GET | `/service-budget-heads/services` | search by name/code, `status`, `onlyUnresolved`, capped at 50 with `capped: true`, company-wide `coverage` |
| PUT | `/services/:id/budget-head` | set or clear one default; clearing writes id **and** name together |
| POST | `/service-budget-heads/resolve` | bulk, one row per requested id |

### One classification contract, not two

The Service Master's own form validated its budget head with
`ledger.nature === "expense"`, which is **not** the rule Finance uses.
Measured against real chart shapes the two disagreed on four heads out of five,
all permissive: `Round Off`, `Suspense`, `Opening Stock` and any head Finance
had manually marked `not_budgeted` were accepted by the Store and refused by
Finance. A service could therefore carry a head that Finance's own screen
would not let it have.

`routes/CMS_Routes/Inventory/Services/services.js` now calls
`itemBudgetHead.assertMappable`, and its `/options` picker filters through
`budgetClassification` so it cannot offer a head the save would refuse.
`assertMappable` gained an optional `subject` for the noun in its refusal
message; the gate itself is unchanged, and item behaviour is unchanged.

**A head with no derivable nature is refused, not assumed.** That was already
true — `classify` lands on `not_budgeted` — but the message now says which of
the two reasons applied, because "not a budget head" reads as a policy
decision while a blank nature is a gap in the chart somebody can go and fix.

### The Finance screen

`/accountant/budgets/item-categories` is now **Purchasing budget defaults**,
with three sections: Item categories, Item overrides, Services. The existing
two are unchanged. The Services section shows code, name, category, billing
unit, active/inactive status, current head and resolved/unresolved state, and
allows change and clear. Inactive services are **labelled and readable** — a
classification made last year has to stay understandable — and the screen
cannot reactivate one; that is the Store's decision.

### What B1 deliberately does NOT do

- `SpendRequest.items[].budgetAllocation` is **not** populated for services.
- `service_default` is **not** added to the request-line `resolutionSource`
  enum. That enum is `["item_override", "category_mapping", "unresolved"]` and
  adding a fourth value is Lane B's call once `SpendRequest` and Service Order
  work settles.
- No commitment, no budget reduction, no supplier bill, no expense posting,
  no change to Service Order creation.

A test counts twelve collections before and after a save and asserts none
moved.

### Known limit

`assertMappable` derives a head's nature from its **group**, not from the
ledger's own `nature` field. A ledger whose group is missing or has no nature
is refused even when the ledger itself says `expense`. That is pre-existing
item behaviour, deliberately left alone here, and worth revisiting on its own
— changing it would accept heads this gate refuses today.

---

## Chunk B2 — service classification before budget approval (shipped)

B1 made a service's budget default visible to Finance in setup. B2 makes it
visible **during the request**, before the money is promised.

### The problem

A service line was matched to the Service Master while the SERVICE ORDER was
raised — which happens after finance approved and after the commitment was
written. So "this service normally comes out of Repairs; are we approving it
against Repairs?" was asked at the one moment the answer changed nothing.

### Vocabulary

`budgetAllocation.resolutionSource` gained two values, in both request models:

| Value | Means |
|---|---|
| `service_default` | the head in force IS the service's own configured default |
| `manual_selection` | a person chose it, over or in the absence of a rule |

Plus `resolutionReason` on the subdocument — populated only where a person
contradicted a configured default. The three item values are unchanged, and
`budgetAllocation` is still `default: undefined`, so a legacy line has **no**
allocation rather than a manufactured "unresolved" one.

**The vocabulary lives in `services/budgetAllocationVocabulary.js` — a leaf
module with no `require` of its own.** The first version defined it in
`itemBudgetHead.service.js` and had the schemas import that, which pulled in
`Acc_ItemCategoryBudget` and `Acc_Ledger`; registering a mongoose model builds
its indexes, which CREATES the collection. The baseline audit reads a
collection's absence as "never deployed", so merely loading a request model
started manufacturing that evidence. `itemBudgetHead` re-exports the leaf, so
there is still exactly one definition.

### Matching moves before finance

`PATCH /api/requests/spend/:id/service-lines` — Store, any stage before
approval. Validates same company, ACTIVE, real line; snapshots `service`,
`serviceCode`, `billingUnit`, `sacCode`; records the proposed resolution from
`headForService`.

`GET /api/requests/spend/:id/service-classification` — what Store and Finance
both read. Per line: the identity snapshot, the quote, the service default,
the four-state agreement, and the master/quote differences.

**The quote is never overwritten.** The matching route's projection does not
even SELECT `defaultRate`, `defaultGstRate` or `preferredVendorId`, so there is
nothing in scope to copy over a negotiated price. Differences are reported as
a comparison carrying both figures.

### The four states

| State | Meaning |
|---|---|
| `default_matches_request_head` | nothing to decide |
| `different_head_selected` | finance must say why |
| `service_default_unresolved` | no head configured on the service |
| `default_not_available_in_department` | the head exists, this department has no approved budget on it |

**Availability is checked before the comparison.** "Available" means an
approved BUDGET LINE for this department, from `budgetCommitment.approvedHeadsFor`
— not the set of mappable expense ledgers. A default this department cannot
spend against is not "a different head"; it is not a choice at all, and only an
available head is offerable.

### Finance must answer

Approving a SERVICE request whose lines contradict a **configured** default is
refused with `SERVICE_CLASSIFICATION_UNRESOLVED`, carrying every mismatched
line and both head names. Finance re-approves with
`serviceClassification: { reason }` or `{ lines: [{ spendLineId, reason }] }`.

- **Match** → `service_default`, `resolved`, no reason, no selector.
- **Deliberate difference** → `manual_selection`, `resolved`, reason + selector
  id/name/time.
- **No default** → blocks nothing (nobody expressed an intention to
  contradict); recorded as `manual_selection`. The Service Master is **not**
  retroactively called resolved.
- **Unbudgeted exception path** → preserved unchanged; the line is honestly
  `unresolved` with a null head, never "manual selection of nothing".
- **Unmatched line** → does not block. Matching is Store's job; refusing here
  would strand a priced, confirmed request behind somebody else's queue.
- **Rejection** → never gated.

### Commitment is unchanged

One request-level commitment, on the request's `ledgerId`, for the approved
grand total. Every line's stored head is the REQUEST's head — a line claiming a
different one would be a second authority. Only the SOURCE varies.

### Conversion

The service order is built from the **approved line snapshot**, not the live
master. This was a real defect found by test: the conversion read
`svc.serviceCode` straight off the master, so renaming a service after approval
silently restated the order that approval produced.

`lineMatches` in the body is now **only** the legacy late-match path, for
requests approved before B2. It cannot reach a line that already stored a
match, and a response that used it says so (`legacyLateMatch`).

### Correction — unmatched lines now BLOCK

The first pass reported and did not enforce identity, on the reasoning that
matching is Store's job and blocking would strand a priced request behind
somebody else's queue. That was wrong. An approval is the moment the money is
promised, and promising it against lines nobody has identified is the thing
this chunk exists to stop. The queue argument is an argument for Store
classifying promptly, not for finance committing blind.

**`SpendRequest.serviceClassificationPolicy`** — a server-stamped version
marker with **no schema default**. Absence is the legacy signal: a default
would stamp every historical document on its next save and convert it into a
new-policy request the late-match door then refuses, stranding
already-committed work. Stamped in `spendRequestCreate.service.js`, the one
function all three creation doors call, for `SERVICE`/`SOFTWARE` only. Never
read from a client payload.

Finance approval of a stamped request is refused with
`SERVICE_LINES_UNCLASSIFIED` when any line has an identity fault:

| Fault | Cause |
|---|---|
| `NOT_MATCHED` | no service on the line |
| `SERVICE_NOT_IN_COMPANY` | the match is gone, or belongs to another company |
| `SERVICE_INACTIVE` | the matched service has been retired |

"Gone" and "another company's" share one message deliberately: the lookup is
company-scoped, and distinguishing them would confirm a record exists
elsewhere.

**This gate runs before the mismatch check and never consults `reason`.** A
reason explains WHICH head was chosen; it cannot explain away a line whose
service is unknown. The finance UI reflects that — an unclassified refusal
opens a notice with no text box at all, not the reason dialog.

`lineMatches` on the service-order route is now refused outright
(`LATE_MATCH_NOT_ALLOWED`) for a stamped request: it was classified before
approval by definition, so a late match could only supply an identity the
approval never saw. Only an unstamped request may still use it.

### What B2 deliberately does NOT do

No commitment split, no per-line commitment, no budget reduction, no supplier
bill, no expense posting, no voucher, no PO, no GRN, no stock movement, and no
change to `ServiceOrder` or `serviceOrders.js`. A test counts seven collections
before and after and asserts none moved.

### One widened permission, named

`maySeeRequest` admits Store only from APPROVED onward — right while their
first job was raising the order, wrong now they have an earlier one. Widened on
the classification READ route only; `maySeeRequest` itself is untouched, because
changing it would open every other route on that router at once.

---

## Chunk B3A — line-wise allocation and multi-head commitments (shipped)

One request buys fabric from Raw Materials, packaging from Packaging, freight
from Freight and a repair from Repairs & Maintenance. A commitment could
express one head, so finance either split the request into four or charged
three of them somewhere they do not belong.

### Schema

`Acc_BudgetCommitment` gains `allocations[]` — one row per approved line —
plus `allocationMode` (`single_head` | `line_wise`) and `headCount`.

**Still one document per request.** `spendRequestId` stays unique; one
commitment per LINE would hand back the idempotency that index exists to give.

`allocations` has **no schema default**. Absence is the legacy signal, and a
default `[]` would make every historical commitment look line-wise with nothing
in it — contributing zero to its own head.

Each row: `spendLineId`, `name`, item/service identity, `budgetId`,
`budgetLineId`, `financialYear`, `ledgerId`, `ledgerName`, `amount`,
`adjustment`, `status` (`committed` | `unbudgeted`), `resolutionSource`,
`resolutionReason`, `selectedByName`/`selectedAt`, and its own `snapshot`.

**No fake primary head.** On a line-wise commitment the top-level
`ledgerId`/`ledgerName`/`budgetId`/`budgetLineId`/`snapshot` are absent — naming
one of several would be a figure every report reads and no human chose.
Single-head commitments keep every one of them populated.

### Line amount and rounding

`services/lineAllocation.service.js`, pure:

1. `lineTotal` where usable — it is what Store quoted and the requester
   confirmed, and recomputing would silently disagree with it
2. otherwise `amount + taxAmount`
3. explicit `0` survives; absent is refused, and a present-but-unreadable value
   is a fault rather than a free line
4. negative or non-finite refuses the whole allocation

A header discount/freight/round-off makes the lines disagree with `grandTotal`.
The difference is spread **proportionally over non-zero lines**, each share
rounded to the paise, and the **remainder placed on the last eligible line** —
computed as "everything not yet placed", so the parts equal the whole by
construction rather than by luck. Deterministic. A 112-combination sweep asserts
the invariant. If the difference cannot be placed honestly (every line zero, or
a discount larger than the lines) the approval is **refused**, never rounded
away.

### Grouped availability

Lines sharing a `budgetLineId` are ONE claim. `₹10,000` available against lines
of `₹6,000` and `₹5,000` reports a **₹1,000 shortage** on the group; either
line alone would have passed, which is the trap.

Grouping feeds the **existing** over-budget vocabulary at the grouped level —
`within_budget` / `over_budget` / `unbudgeted`. Finance is not blocked by an
over-budget group; the request records which kind of yes it was, exactly as
before. No second approval framework.

**Blocked, by contrast:** a line nothing resolves and finance did not choose; a
head that is not an approved budget line for this department; an override of a
configured suggestion with no reason. An arbitrary expense ledger is not an
approved budget head merely because it exists in the chart.

`SOURCE_REQUEST_HEAD` (`request_head`) is new: a line whose own rule produces
nothing falls back to the head the REQUEST was approved against. That was the
only authority before B3A and is a real decision. It is a distinct value
precisely so nobody later mistakes it for a line-level classification.

### Legacy compatibility

`committedByLine` reads two shapes through **mutually exclusive** queries: the
legacy branch requires `allocations` absent/null/empty, the line-wise branch
requires it present. A document satisfies exactly one.

The trap is the **single-head** commitment, which carries the compatibility
fields AND an `allocations[]` — that is the document counted twice without the
exclusion, and it is the ordinary shape of almost every request. Pinned by a
test that fails when the exclusion is removed.

Unbudgeted allocations reduce nothing (null `budgetLineId`). Released
commitments do not count. Repeated approval creates no second commitment.
Cancellation releases the one commitment once.

### Correction — mounted on both real Finance surfaces

The engine and `LineAllocationReview` shipped correct and **mounted nowhere**,
while both live finance paths kept approving through a single-head button. A
component nobody can reach is not a feature, and a unit test of its
presentation cannot tell you that.

`LineAllocationReview` no longer imports a client. The Request Desk
authenticates as a CMS employee and Payables as an accounting user; a component
importing one of those could only ever mount on one surface, which is how it
ended up on none. Callers now pass `fetchAllocation`, `submitApproval` and an
optional `decisionFields` slot.

| Surface | Change |
|---|---|
| `components/mrf/PurchaseOrService.js` | review mounted at `r.step === "finance"`; the direct finance Approve removed. The TL's plain Approve is untouched — a TL answers whether the department needs this, which has no heads in it. |
| `app/accountant/payables/spend-approvals/[id]/page.js` | review mounted; direct Approve removed; note and expected-payment-date render inside its action row so there is one Approve carrying the allocation. The single-head "Budget position" panel is hidden only when several heads genuinely apply. |
| `routes/Accountant_Routes/Acc_spendApprovals.js` | `GET /:id/line-allocations` on the accountant session, gated by the `isApprover` check the file already makes; `lineAllocations` forwarded into the shared `financeDecision.decide`; the approval message no longer names one head when there are several. |

`allocationSummary` moved into `spendFinanceDecision` so both routes read one
implementation. Rejection and the budget exception need no allocation and keep
their own controls.

### B3B — SHIPPED: voucher-line mapping and partial release

The limitation below is closed. Kept for the record of what it was.

**Line identity, end to end.** `SpendRequest.items[]._id` →
`PurchaseOrder.items[].spendLineId` (new; the service chain already had it) →
purchase-voucher `inventoryEntries[].spendLineId`. Every id is derived on the
SERVER from the authoritative order — a client that could set one could point a
bill at whichever allocation had the most budget left. Nothing is matched by
item name, vendor, amount or array position.

The goods provenance gap is closed with it: a PO-linked voucher now derives
`spendRequestId` and `budgetCommitmentId` from the order, as Service Order
billing already did.

**Per-allocation release.** Each `allocations[]` row gains `releasedAmount`,
`remainingAmount`, a `releases[]` audit trail (voucher id, number, line, amount,
actor, time) and the states `partially_released` / `released`. The approved
`amount` and its snapshot are never rewritten: "what was promised" and "what is
still promised" stay two questions with two answers. The document is `released`
only when every allocation has nothing left.

**Release uses exact voucher lines.** Mapped lines group by `spendLineId`; a
genuine voucher-level adjustment is spread proportionally with the remainder on
the last line; each allocation releases `min(billed, remaining)`. Over-billing
exhausts the promise and never makes remaining negative — the excess is real
spending no commitment covered, and the screen says so. An unmapped charge line
releases nothing and is not treated as an adjustment.

**Idempotent and reversible.** A voucher already present in `releases[]`
releases nothing more, so repeated saving or posting is safe. Cancelling
restores only the rows THAT voucher wrote — a second still-posted bill keeps
its discharge. Re-posting after cancellation writes exactly one set again.

**`committedByLine` counts `remainingAmount`**, falling back to `amount` on
rows written before B3B (which have released nothing), and treats
`partially_released` as live. A commitment is still never counted through both
the legacy and line-wise paths.

**Compatibility.** A commitment with no `allocations[]` keeps whole-document
release, unchanged. A line-wise one NEVER falls back to it — not even when
nothing mapped: the bill posts, the commitment stays live, and a
`reconciliationWarning` says why. Posting is never blocked by a release that
could not be resolved; refusing a real supplier bill over an unreconciled
promise would be the worse failure.

Accounting postings are untouched. The voucher remains the actual.

### B3B correction — the lifecycle conflict, and exact line identity

The first B3B pass had the engine right and the wiring wrong.

**One orchestrator.** The voucher's post-save hook still called the legacy
whole-document release, and the create route called the new line-wise one.
For a line-wise commitment the hook usually won and freed every head — the bug
the chunk existed to fix, reintroduced by the fix. The hook is now the single
entry point (it is the chokepoint all six posting paths share), it loads
`inventoryEntries` (without which partial release is impossible), and it calls
`commitmentRelease.orchestrate`, which decides legacy versus line-wise from the
COMMITMENT. The route's three helpers are deleted rather than left dormant.

**Exact line identity.** `poItemId` and `serviceOrderLineId` are new on the
voucher line, carried by the form through prefill, edit and submit; the server
deletes any client `spendLineId` and resolves them against the linked order.
The raw-item fallback survives only for legacy data and only where **exactly
one** order line matches — two PO lines naming the same fabric stay unmapped,
because releasing the wrong allocation would look entirely correct.

**Grouped audit.** A release row keeps `contributions[]` — every contributing
bill line with its own share, scaled if the release was capped — not just the
first id.

**Unbudgeted lifecycle.** Unbudgeted allocations now carry released/remaining
and hold the document open until billed. They remain excluded from every
availability figure: the word `unbudgeted` is fixed, only the figures move.

**Persistent reconciliation.** `GET /vouchers/:id` reconstructs it from the
commitment's stored release rows, so reopening a voucher tomorrow shows what it
showed today. It used to ride back only on the creation response.

### Superseded — what B3A did not solve

**Partial actual release is not built.** A commitment is still released
whole-document, by `commitmentForVoucher` / `releaseForVoucher`, exactly as
before. That means:

- a supplier bill for ONE line of a four-line request releases the WHOLE
  commitment, freeing budget on three heads nothing has been billed against;
- there is no mapping from a voucher line to the `allocations[]` row it
  discharges;
- `allocations[].status` has no `released` value, because nothing can set it
  correctly yet.

B3B must map voucher lines to commitment allocations, add per-allocation
release, and handle partial supplier bills. Until then, treat multi-head
commitments as released all-or-nothing. This is a real limitation, not an
oversight, and B3A does not pretend otherwise.

Untouched: `Acc_VoucherModels.js`, `Acc_vouchers.js`, Service Order billing,
voucher prefill, inventory valuation.

---

## Next chunk (not started)

1. Request form resolves and displays a head per line, requester never types one.
2. `budgetAllocation` populated on submit; `manual_selection_required` where
   the resolver returns nothing.
3. Approver sees and can correct a head per line.
4. Commitments split per allocation instead of one per request.
5. Budget check attributes voucher legs per allocation.

Steps 4 and 5 are where the live budget path changes. Nothing before them
alters a number anybody currently reads.
