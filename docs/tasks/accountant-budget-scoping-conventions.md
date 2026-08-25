# Accountant — Budget scoping: company, department and project

> **Status:** §4, §6.1 and the `scope` field are BUILT. §5 (project spend
> attribution) and §6.3 (`Office Budget`) are still open.
>
> - **Chunk A — shipped.** `Acc_Budget.scope` (`company | department |
>   project`) with its owner fields, the list/dashboard scope filter, and the
>   scoping UI. An unset scope on a pre-existing row reads as `company`, so no
>   migration was needed.
> - **Chunk B — shipped.** §4's double-count. The dashboard roll-up now gives
>   each voucher to one budget, by the precedence recommended in §4.2(b):
>   `project ▸ department ▸ company`, then the narrower period, then the later
>   `createdAt`, then a stable id. Lives in
>   `services/budgetOverlap.service.js`. Per-budget detail and budget control
>   are deliberately unchanged — see below.
> - **Chunk C — shipped.** §6.1's free-text department. A department now has
>   one identity: `services/budgetDepartment.service.js` folds case, spacing,
>   punctuation, accents and `&`/`and` into a slug, and a new company-scoped
>   registry (`Acc_BudgetDepartment`) supplies canonical names and aliases for
>   the misspellings no rule can fold. Grouping, filters and budget-control
>   matching all compare identity rather than the stored string. See §6.1 for
>   why none of the three existing department tables could be reused.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Goal:** make all three ways of scoping a budget — **company-wide**,
> **per-department**, and **per-project / cost-centre** — first-class options
> that can be used together, rather than three shapes that happen to fit in the
> same collection.
>
> **Headline constraint — RESOLVED by Chunk B.** The module used to assume
> each rupee of spend belonged to exactly one budget: two budgets covering the
> same head over the same dates both claimed the same voucher, and the
> dashboard headline read double. That was the prerequisite for using the three
> conventions together, and it is now fixed. On the demo dataset the correction
> removed ₹14,30,000 of double-counted spend, and the dashboard headline now
> matches the monthly chart exactly — the two disagreed for as long as the
> defect existed.
>
> **Still true:** a *project* budget cannot yet attribute spend to its project
> (§5). Scope decides which budget owns a voucher; it does not decide which
> project the money was for. A project budget's actuals are still every rupee
> on its heads.

---

## 1. The three conventions

### 1.1 Convention 1 — one budget per financial year, company-wide

One envelope per FY. Departments appear as **lines** inside it.

```
FY26-27 Company Budget          ← one budget
  ├─ Freight & Forwarding      · Logistics   · ₹56,00,000
  ├─ Repairs & Maintenance     · Admin       · ₹9,00,000
  ├─ Marketing & Exhibitions   · Marketing   · ₹14,00,000
  └─ Export Sales              · Sales       · ₹1,60,00,000  (revenue)
```

This is what the module was **built for**. The department request flow
(Chunk 2) → finance review (Chunk 3) assumes departments *ask into* a shared
budget: a department raises a request, finance agrees it, and the agreement
becomes a line in that budget. Under any other convention that exchange gets
strange — a department would be requesting into an envelope it already owns.

Department-wise reporting is **not lost**: `byDepartment` on the dashboard
rolls every line across every budget up by department, which is what the
Departments tab renders.

### 1.2 Convention 2 — one budget per department per year

Each department holds its own approved envelope.

```
Logistics — FY26-27     ₹65,00,000
Marketing — FY26-27     ₹14,00,000
Admin — FY26-27         ₹9,00,000
```

Appropriate when departments are genuinely accountable for their own envelope
and finance does not need one consolidated instrument. Costs: the request
flow loses its meaning (see above), and the free-text `department` problem in
§6.1 bites much harder, because the department is now the identity of the
budget rather than a tag on a line.

### 1.3 Convention 3 — one budget per project / cost-centre

```
Greenfield Industrial Park      ₹2,40,00,000
Meramandali Site Setup          ₹85,00,000
```

Standard in construction, site work, job-work manufacturing and agencies —
i.e. genuinely relevant to this business. **It does not work today**, and the
reason is not cosmetic: see §5.

---

## 2. What already supports all three

Worth stating plainly, because it is more than expected:

- **The schema imposes no convention.** `Acc_Budget` is a name, a period, a
  status and a list of `items[]`. Any of the three shapes is expressible now.
- **Everything per-budget already works under any shape** — the detail drawer,
  voucher drilldown, department requests, finance review, adjustments,
  transfers, and the over-budget control on posting. All of these operate on
  one budget at a time and are unaffected by how budgets are scoped.
- **Company scoping and the legacy fallback** hold in all cases.

The problems are confined to (a) rolling several budgets up together, and
(b) attributing spend to anything narrower than a ledger head.

---

## 3. What the live database actually shows

Checked against the production Atlas cluster, 2026-08-25:

| Fact | Value |
|---|---|
| `Acc_CostCentre` model exists | yes (Tally-style) |
| Voucher lines can carry `costCentreAllocations` | yes |
| Cost centres created | **0** |
| Vouchers carrying a cost-centre allocation | **0 of 1,679** |
| Budget line fields | `ledgerId, ledgerName, groupName, category, sourceRequestId, nature, department, ownerEmail, allocatedAmount, phasing, spentAmount, remainingAmount, variance, notes` |
| Budget line has a project / cost-centre field | **no** |
| Budgets with no `companyId` (visible under every company) | 1 — `Office Budget` |
| `Office Budget` lines bound to a ledger | **0 of 6** — which is why it reads ₹0 everywhere |

---

## 4. Prerequisite — overlapping budgets double-count actuals

> **BUILT (Chunk B).** What follows is the analysis that led to the fix, kept
> as written. The recommendation at the end of §4.2 is what shipped. What
> actually got built, and the parts of it this section did not anticipate, are
> in §4.4.

**This blocks conventions 1+2 or 1+3 coexisting. It is not optional.**

### 4.1 The defect

`GET /budgets/dashboard` builds `totals` by evaluating each budget's own lines
and summing across budgets. A head budgeted in two overlapping budgets
therefore has its spend counted once per budget.

```
FY26-27 Company Budget   Freight & Forwarding   allocated ₹56,00,000
Freight — Q2             Freight & Forwarding   allocated ₹13,00,000
                         ↑ same head, Q2 falls inside the FY

One ₹1,00,000 purchase voucher in August
  → counted in BOTH budgets' roll-ups
  → totals.expense.actual reads ₹2,00,000
```

On the first demo dataset this inflated total spend by **42%**.

It predates the chart and is pinned by a test rather than worked around:
`test/accountant/budgets.route.test.js` →
*"KNOWN: overlapping budgets double-count actuals in the totals, not in the
series"*. The `monthly[]` series counts each voucher once and is the
deduplicated truth of the two, which is why they disagree.

### 4.2 The design question this forces

Deduplicating is not mechanical. When several budgets match one voucher,
something has to decide what the roll-up means. Four options:

**(a) Most specific wins.** The narrowest matching budget owns the voucher —
a Q2 budget beats a yearly one; a project budget beats a department one.
Intuitive, needs no new field, but "narrowest" has to be defined for ties
(same period, different scope).

**(b) Explicit precedence on the budget.** A `scope` field
(`company | department | project`) with a fixed ordering. Explicit and
inspectable, and it is the field conventions 2 and 3 want anyway (§5, §6.2).
Costs a migration and a decision on every existing budget.

**(c) Deduplicate at the roll-up only.** `totals` counts each voucher once
(attributing arbitrarily); per-budget figures stay as they are. Smallest
change, but "total ≠ sum of the rows above it" is confusing in a different
way, and the arbitrary attribution will be asked about.

**(d) Report both.** Keep per-budget sums, add an explicit
`totals.deduplicated`, and label the headline. Honest, no behaviour change,
but pushes the ambiguity onto the reader.

**Recommendation: (b), with (a) as the tie-break inside a scope level.**
It is the only option that also serves §5 and §6.2, so the migration is paid
for once rather than twice.

### 4.3 Blast radius

The roll-up feeds four surfaces: the dashboard KPI figures, `byDepartment`,
`byHead`, and the attention lists. All four move when this changes. This is
why it needs its own slice with its own tests, not a change made in passing.

**Explicitly out of scope for the fix:** budget control on posting
(`checkBudgetAvailability`) already sums the *allocations* of every matching
line, which is correct — two budgets each allocating to a head genuinely do
authorise the sum. Only the *actuals* double-count.

### 4.4 What shipped, and three things §4.2 did not anticipate

Option (b) with (a) as the tie-break, as recommended. The rule is a total
order, so the same data always totals the same way:

1. scope — `project ▸ department ▸ company` (an unset scope IS company)
2. narrower period wins
3. later `createdAt` wins
4. budget id, then line id, ascending

Three things this section did not foresee, each of which changed the design:

**The tie-break is reached more often than expected, and is admitted to.**
Two budgets of the same scope over the same period created in the same
millisecond are genuinely indistinguishable — rule 4 then picks arbitrarily.
It is deterministic, so a refresh never moves the figure, but the response
counts those decisions as `overlap.ambiguousMovements` and the dashboard says
so rather than letting an arbitrary pick look considered.

**A department filter must not change who owns what.** `department` is the one
dashboard filter that slices *inside* a budget rather than deciding whether a
budget is in force. Deduplicating within the filtered subset would hand a
Logistics line a payment that Admin's budget actually won, and the same line
would then report different actuals depending on what was on screen. So the
contest set deliberately drops that one filter. The others
(`financialYear`, `status`, `period`, `scope`) do narrow the contest, and that
is intended — they select which budgets the reader treats as in force.

**Half a deduplication is worse than none.** Past a cap on contested voucher
movements the roll-up publishes the *un-deduplicated* figure and labels it,
rather than a partially corrected one that reconciles to nothing.

**Deliberately unchanged**, and pinned by tests so they stay that way:
per-budget detail (opening one budget still shows every rupee spent on its own
heads — true of both budgets, and the question a reader of one budget is
asking), the list endpoint, and budget control on posting.

---

## 5. Convention 3 needs spend attribution, not a label

Today a budget line binds to `ledgerId` + `department`, and
`movementByLedger` matches spend on **ledger + company + date window**. A
budget named after a project therefore claims **every rupee spent on that head
company-wide**, not the project's share.

That makes a project budget a *label, not a control*, and one that reports
inflated actuals — the failure mode this module exists to prevent.

Making it real needs three things, in order:

1. **`costCentreId` on the budget line.** Additive, low risk.
2. **`movementByLedger` filters by cost centre when a line carries one.** The
   voucher already stores `ledgerEntries[].costCentreAllocations[]`, so the
   data path exists. Note the allocation is *per amount*, so a voucher split
   across two cost centres contributes proportionally — the aggregation has to
   sum allocations, not the whole entry.
3. **Cost centres actually tagged at voucher entry.** This is the real cost
   and it is **not a code change**: 0 of 1,679 vouchers carry one today. A
   project budget is meaningless until whoever books a voucher reliably tags
   it. Needs a required-when-project-active rule on the voucher forms, a
   seeded cost-centre master, and agreement from the people doing data entry.

**Do not build 1 and 2 without a commitment to 3.** Shipping project budgets
that silently under-report because nothing is tagged is worse than not having
them: the number looks like a control and is not one.

---

## 6. Supporting work

### 6.1 `department` is free text

> **BUILT (Chunk C).** The analysis below is kept as written; what shipped and
> what it does not cover are in §6.1.1.

`items[].department` and `budgetRequests[].department` are free-text slugs
against a registry nothing seeds. "Logistics", "logistics" and "Logistcs" are
three departments in every roll-up.

Tolerable under convention 1, where department is a tag on a line. **Serious
under convention 2**, where it becomes the identity of the budget. Also the
reason per-department *authorization* could not be enforced in the hardening
pass — there is no department on the auth token and no registry to check
against.

Needs: a seeded department master, a picker instead of a text field, and a
one-off normalisation of existing values.

#### 6.1.1 What shipped

**A new registry, not a reused one.** Three department tables already existed
and none of them fits:

| table | what it actually is | why not |
|---|---|---|
| `AccessDepartment` (`access_departments`) | the org-wide **login portal** registry — `accountant`, `hr`, `qc`, `cutting-master`. Seeded at boot, contrary to the code comments this chunk corrected. | deliberately global; every accounting model is company-scoped, and giving it a `companyId` would change how people log in. Its vocabulary is also not the budgets' — the live budgets name Logistics, Admin, Facilities and Projects, none of which is a login portal. |
| `Acc_Department` (`acc_departments`) | the accountant **login table**, despite the name | its ~40 inbound refs are `createdBy`/`approvedBy` and point at people |
| `departments` (HR) | the **factory floor** master — CUTTING, SCREEN, WASHING, PATTERN | no `companyId`, and it carries the same case problem itself (`MARKETING` beside the budgets' `Marketing`) |
| `Acc_CostCentre` | company-scoped and accounting-owned | it is the **project** dimension §5 will attribute spend through; merging departments into it now would weld together two dimensions that must stay separable |

So: `Acc_BudgetDepartment` — `companyId`, `slug`, `name`, `aliases[]`,
`isActive`, `createdBy`/`updatedBy`, unique on `(companyId, slug)`.

**Nothing was migrated, and no budget field became a ref.** Reads derive the
slug, so every row written before the registry existed groups correctly the
moment this shipped. Writes store the canonical *display name* when the
registry knows the department, and exactly what was typed when it does not.
A company that never opens the departments screen keeps working and still gets
case- and spacing-tolerant grouping; registering only sharpens it.

**What normalisation can and cannot do.** `slugify` folds case, surrounding
and repeated whitespace, punctuation, accents, and `&` vs `and`. It cannot fold
a *misspelling*: `Logistcs` is honestly a different word, and merging it on a
guess would silently move money between departments. That is what `aliases[]`
is for — a human says once what the typo means, and every past and future row
carrying it resolves. The picker exists to stop the typo being entered at all.

**Still not done: department authorization.** §6.1 named the missing registry
as the reason per-department authorization could not be enforced. That was only
half the reason. Knowing which departments exist is not knowing which one the
person signing in belongs to, and `AccountantAuthMiddleware` puts no department
on `req.user` at all. "Logistics may only raise Logistics requests" therefore
still needs a membership model. This chunk removed one of the two blockers.

### 6.2 A `scope` field on the budget

Whichever convention is used, the budget itself should say which it is:

```
scope: "company" | "department" | "project"
```

It drives the precedence in §4.2, lets the list group and filter by scope, and
lets the card lead with the right thing — the year for a company budget, the
department for a department budget, the project for a project one. Right now
the card cannot know, which is exactly why the list reads as arbitrary.

### 6.3 `Office Budget` needs attention regardless

The one real budget in the database has no `companyId` (so it appears under
every company, including the demo one) and none of its 6 lines is bound to a
ledger (so it reads ₹0 spent forever). Assign it a company and bind its lines,
or close it.

---

## 7. Suggested order

Each slice is independently shippable and independently useful.

| # | Slice | Unlocks | Risk |
|---|---|---|---|
| **A** | `scope` field + budget card leads with the right thing | Conventions 1 and 2 read clearly; list stops looking arbitrary | Low — additive, presentational |
| **B** | Fix the actuals double-count (§4) | **1 + 2 usable together** | Medium — moves a figure four surfaces read |
| **C** | Department master + picker + normalisation (§6.1) | Convention 2 trustworthy; unblocks per-department authorization | Medium — touches existing data |
| **D** | `costCentreId` on budget lines + cost-centre-aware actuals (§5.1–5.2) | Project budgets technically possible | Medium |
| **E** | Cost centres enforced at voucher entry (§5.3) | Project budgets **meaningful** | High — process change, not code |

**A** and **B** are worth doing whatever is decided, because the double-count
is a live defect today, not only a blocker for the future.

**D** without **E** should not ship.

---

## 8. Open decisions

These are the user's to make; nothing above assumes an answer.

1. **Which convention is primary?** The recommendation is **1** — it is what
   the request → review → allocation flow was built around, and it gives
   department reporting for free.
2. **Precedence when budgets overlap** — §4.2, options (a)–(d).
3. **Is project budgeting worth §5.3?** If cost centres will not be tagged at
   entry, convention 3 should be dropped rather than half-built.
4. **Do budgets of different scopes need to reconcile?** i.e. must the sum of
   department budgets equal the company budget, and should the system enforce
   or merely report a mismatch? This is a policy question with no default.
