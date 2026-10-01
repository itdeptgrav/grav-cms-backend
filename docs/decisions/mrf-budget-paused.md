# MRF budget & Finance review is paused

**Status:** in force since 30 Sep 2026. Temporary.
**Restore:** set `mrfBudgetEnabled` back to `true`. That is the entire action.

## What is switched off

When Store decides an MRF needs buying (`buy_or_service` or
`partial_buy_balance`), the spend request it spins off normally starts at
`pending_finance` and waits for Finance to approve the budget and create a
commitment before a purchase order can be raised.

While this is paused, that request starts at `approved` instead, stamped
`budgetApprovalMode: "BUDGET_PAUSED"`. The approved buying balance is
immediately eligible for a purchase order.

## Where the switch is

One document. Not an environment variable, not a constant, not a commented-out
branch.

| | |
|---|---|
| Collection | `requestssettings` |
| Document | `{ key: "requests" }` (singleton, unique index on `key`) |
| Field | `mrfBudgetEnabled` (Boolean, **default `true`**) |
| Model | `models/CMS_Models/Configurations/RequestsSettings.js` |
| Read by | `routes/CMS_Routes/Inventory/Operations/mrfRoutes.js` — `/:id/budget-head` and `/:id/fulfilment-decision` |

It is read fresh on every request with no cache, so a change takes effect on the
next request. No restart, no redeploy.

Absence reads as enabled: every consumer tests `mrfBudgetEnabled !== false`, so
a missing document behaves exactly as the system did before the switch existed.

## How to restore it

Any one of these. They do the same thing.

1. The CEO settings screen.
2. `PUT /api/cms/requests/settings` with `{ "mrfBudgetEnabled": true }` and a
   ceo/admin token.
3. `node -r dotenv/config scripts/migrations/pause-mrf-budget.js --restore --apply`
   (dry run without `--apply`).

## Nothing was deleted

No code was removed, disabled, stubbed or commented out to achieve this, so
there is nothing to recover when it is turned back on. The budget path, the
commitment machinery, `spendApproval.service.js` and the accountant module are
all untouched and fully exercised by tests. `test/requests/store-fulfilment.route.test.js`
covers both paths and proves the switch moves between them, including that
flipping it back restores the Finance path for the next request.

## What it does not do

**It does not touch requests that already exist.** `budgetApprovalMode` is
stamped on a spend request when it is raised, from the setting as it stood at
that moment. Flipping the switch cannot rewrite what an earlier request was
approved under, and a request already sitting at `pending_finance` stays there
waiting for Finance until somebody decides otherwise.

At the time of the pause there were **0** requests at `pending_finance`, so no
migration question arose. If that is ever not the case, those requests are a
separate decision and must not be swept up in a settings change.

**It does not weaken anything that is not budget.** Manager/TL approval, the
Store's issue-or-buy decision, supplier, rate, tax, expected delivery,
quantities, tenant scoping and purchase-order provenance all still apply. A
purchase order must still prove its source MRF, its source lines, its approved
quantities, its supplier and its totals — `governedPurchaseOrder.service.js` is
unchanged.

**A missing marker still fails closed.** `budgetApprovalMode` has no default by
design. A request raised before the field existed carries nothing, and
`governedPurchaseOrder.service.js` treats an unproven mode as
`COMMITMENT_REQUIRED` and demands a commitment. Only an explicit persisted
`BUDGET_PAUSED` waives it. Do not backfill that field — the absence is
load-bearing.
