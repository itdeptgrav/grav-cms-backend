# Department Head Budget App

> **Status:** Chunk 1 shipped as a STANDALONE BUDGET APP. Chunk 2 is next.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Goal:** Give department heads a finance-styled budget app where they can
> submit budget lines, see finance's answer, and later track approved budget
> without getting access to the accounting workspace.

---

## Product Rule

This is a department-facing app over the Accountant budget engine, not a second
budget ledger. Finance remains the owner of budget cycles, approvals,
adjustments and transfers. Department heads only see data mapped to their
budget department through `Acc_BudgetDepartment.accessSlug`.

The UI should visually match the finance/accountant budget app:

- Same slab page header.
- Same frosted panels, hairlines, muted normal state and colored exception
  states.
- Same language distinction between expense budget and revenue target.
- No broad finance dashboard data exposed to a department portal.

---

## Chunk 1 - Standalone Budget app shell + proposal workflow

**Purpose:** Make a usable first screen for department heads, in an app of its
own.

### Department-specific nav mounting was rejected and replaced by `/budget`

The first cut of this chunk mounted the same body inside six department shells
— Sales, HR, Store, Merchandising, R&D, Project Manager — each with a `Budget`
item in its own nav. That was replaced.

Why it was wrong:

- Six routes, six wrappers and six nav entries for ONE screen. Every later
  chunk (approved-budget tracking, adjustment and transfer asks) would have had
  to land in six places.
- Budgeting is not any of those departments' work. It is a finance
  conversation a department head takes part in, and hanging it off HR's or
  Sales' chrome made one feature look like six unrelated ones.
- The chrome was the ONLY thing that differed. `/api/budget-proposals` already
  scopes every read and write to the caller's own budget department through
  `Acc_BudgetDepartment.accessSlug`, so the department in the URL never
  decided anything.
- It scaled by department. A seventh mapped department meant a seventh copy.

What replaced it: one app at `/budget`, for a head of ANY mapped department.
The server decides which department's data comes back, not the route.

Frontend:

- `app/budget/page.js` — the only route.
- `components/Budget_DashboardLayout.js` — shared `FrostShell`, department
  label `Budget`, `IndianRupee` icon, one nav item (`My budget` → `/budget`).
- `components/budget/BudgetProposals.js` — unchanged body, still
  layout-agnostic. Only its header comment moved with the feature.
- No `guardSlug` on the shell: it locks to one department, and this app serves
  any mapped one. Authorisation stays server-side in
  `services/budgetProposals.service.js`.
- No `appLogoSlug`: it renders a `DepartmentIcon`, and there is no `budget`
  slug in that registry, so the plate draws empty. Register one there first if
  the back-to-apps control is wanted.
- The app links nowhere into `/accountant`.

Removed by this chunk:

- `app/{hr,sales,store,merchandiser,research-development,project-manager}/dashboard/budget-proposals/`
- The `Budget` nav item from those six layouts (and the now-unused
  `IndianRupee` import in each).

Backend:

- Reuse the existing `/api/budget-proposals` API. Unchanged.
- No schema changes in this chunk.

Done when:

- A mapped department head can open `/budget` and see their own department's
  cycles.
- They can see open cycles, submit a line and revise a finance counter.
- An unmapped department sees the setup message, not another department's data.
- No department app carries a Budget page or nav item.

---

## How a caller is mapped to a budget department

Two vocabularies, linked by one stored field. `Acc_BudgetDepartment.accessSlug`
holds the ACCESS-CONTROL department slug (`sales`, `store`, `hr`) that may
propose for that budget department (`Logistics`, `Marketing`). Matching them by
name would work often enough to be trusted and then quietly let one department
propose as another, so the link is explicit.

### Grant-based identity, not the active portal

The standalone Budget app made the original rule unusable. Opening `/budget`
from the launcher calls `switch-department`, which sets the session's
`deptSlug` to `"budget"` — a portal, not a department anyone budgets for, and
one that can never appear as an `accessSlug`. Read literally, every Budget-app
session mapped to nothing.

Resolution now runs in this order (`routes/Access/budgetProposals.js`):

1. A real portal slug answers for itself. A head working inside Sales resolves
   to `["sales"]` — one slug, one query, exactly as before.
2. `deptSlug` of `"budget"` (or absent) resolves from the caller's GRANTS
   instead: the union of `DeptUser` rows (the account that belongs to a
   department) and `DepartmentRole` rows (a role held inside one), keyed on
   email. A person can have either without the other, so the union is the
   entitlement.
3. `"budget"` and `"platform-admin"` are stripped from any grant list. Neither
   is a department, and listing either would let a mapping to it widen access.

`departmentsForAccessSlugs` in `services/budgetDepartment.service.js` does the
many-slug lookup; the original single-slug function is unchanged.

### Empty mapping fails closed

No email, no grants, or no `accessSlug` pointing at them ⇒ an empty list, never
all departments. Blank and duplicate slugs are dropped before the query, so an
empty grant list cannot widen into `{ accessSlug: { $in: [""] } }`. Reads return
200 with nothing (an unlinked department is not doing anything wrong); writes
refuse.

There is deliberately **no administrator bypass**. This is a money boundary, and
an admin with no department grant and no mapping legitimately has nothing to
propose. An admin who needs to see the app should be granted a department, or
map one to a portal they hold.

### Maintaining the mapping

`accessSlug` is settable on the safe create/update path
(`routes/Accountant_Routes/Acc_budgetDepartments.js`) and returned on reads.
Finance sets it at **Budgets → Budget departments**
(`app/accountant/budgets/departments/page.js`): a select of real portals from
`/api/public/departments`, falling back to a text field if that list cannot be
read. Clearing the field revokes on the next request — no sign-out needed.

It is not validated against the AccessDepartment registry on purpose: a
department can legitimately be mapped before its portal row is seeded, and
refusing that would make ordering the setup steps a puzzle. An unmatched slug
simply resolves to nobody.

---

## Chunk 2 - Approved Budget Tracking

**Purpose:** Let a department head answer "what did finance approve, what have
we used, and what is left?"

Backend:

- Add a department-safe read to `services/budgetProposals.service.js`.
- Return approved lines and evaluated actuals only for the caller's allowed
  department slugs.
- Keep voucher details out unless a later explicit decision allows them.

Frontend:

- Add an `Approved budget` section under the proposal screen.
- Show approved, spent/earned, left/to-go and utilization by head.
- Use the same table treatment as finance budget department pages.

Done when:

- Department heads can track their approved envelope without entering
  `/accountant`.

---

## Chunk 3 - Adjustment And Transfer Asks

**Purpose:** After budgets are active, department heads need a controlled way
to ask for more budget or move unused allocation.

Backend:

- Add department-safe adjustment request endpoints under `/api/budget-proposals`.
- Add department-safe transfer request endpoints only for lines owned by the
  caller's allowed department slugs.
- Preserve finance approval and four-eyes rules in `/api/accountant/budgets`.

Frontend:

- Add "Request extra" on an approved line.
- Add "Move budget" between eligible own lines.
- Add a review/history panel for pending, approved, rejected and cancelled asks.

Done when:

- Department heads can request changes after approval, and finance remains the
  only actor that applies money.

---

## Chunk 4 - Department Budget Alerts

**Purpose:** Make the app useful day to day, not just at planning time.

Scope:

- Near-limit and over-budget alerts for the department's own heads.
- Counter waiting / finance response indicators.
- Links from alerts to the relevant budget row.

Out of scope until requested:

- Push/email notifications.
- CEO rollups.
- Budget forecasts.
