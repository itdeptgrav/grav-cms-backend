# Sales Accounts — Budget Feature

> **Status:** Proposed product/implementation spec. No application code written.
>
> **Backend:** `/Users/risheeray/grav-cms-backend`
>
> **Frontend:** `/Users/risheeray/grav-cms`
>
> **Primary surface:** Sales Account workspace at
> `/sales/dashboard/accounts/[id]`.
>
> **Goal:** Add a proper customer/account budget feature to Accounts: what this
> customer is expected to buy, in which period, how much has converted into live
> enquiry/order pipeline, what is still left to win, and why the number is
> trusted.

---

## 1. What exists today

### 1.1 Sales Accounts

The Account workspace is a two-column dossier:

- Left rail: account facts, contacts and commercial terms.
- Right workspace: Pipeline, then tabs for Profile, Customer history, Contacts,
  Sites, Departments, Relationships, Team, Activities, Commercial, Garment
  profile, Documents, Audit and MPC.

Relevant files:

- Frontend page:
  `/Users/risheeray/grav-cms/app/sales/dashboard/accounts/[id]/page.js`
- Commercial section:
  `/Users/risheeray/grav-cms/app/sales/dashboard/accounts/[id]/_sections/CommercialSection.js`
- Backend route:
  `/Users/risheeray/grav-cms-backend/routes/CMS_Routes/Sales/accounts.js`
- Account model:
  `/Users/risheeray/grav-cms-backend/models/CMS_Models/Sales/Account.js`

The Account model already carries commercial profile fields such as currency,
payment terms, credit days, advance percentage, annual revenue estimate, annual
volume estimate and the detailed `garmentSalesProfile`. These are standing
commercial facts, not a tracked budget.

### 1.2 Leads and Journeys

Lead has a loose `budget` text field and researched annual-potential fields:

- `estimatedAnnualQuantity`
- `estimatedAnnualRevenue`
- `estimatedUnitPrice`
- confidence/source fields for each estimate

Sales Journey has `expectedValue` and account links, but there is no account
budget record that rolls these up by period.

### 1.3 Accountant budgets

The backend already has a serious accounting budget engine:

- Route: `/api/accountant/budgets`
- Model: `Acc_Budget` in `Acc_OperationalModels.js`
- Services:
  - `budgetActuals.service.js`
  - `budgetVariance.service.js`

That module budgets company revenue and expenses against ledger heads, computes
actuals from posted vouchers, handles revenue/expense variance correctly, and
supports department submissions.

This is not the same product object as an Account budget. Accountant budgets ask:

> What should the company earn/spend against ledger heads this period?

Account budgets ask:

> What should this customer account buy from us this period, and how much of
> that plan is already in pipeline/orders?

The two should integrate later, but the Sales Account feature should not write
directly into `Acc_Budget` rows.

---

## 2. Product decision

Create a Sales-side Account Budget object, not just more fields on
`CRMAccount`.

Reasons:

- An account can have many budget periods: FY, half-year, quarter, season or
  buying cycle.
- Each period can have multiple lines: product/category, site, department,
  buyer division, currency and confidence.
- A budget has workflow state: draft, reviewed, active, revised, closed.
- A budget needs audit and history; overwriting one annual field on Account
  would destroy the story.
- Sales needs budget-versus-pipeline; Accounting needs ledger actuals. Those
  are related, but not identical.

The Account record can keep summary fields and derived counters later, but the
source of truth should be a new collection.

---

## 3. User jobs

| # | Who | Job | Decision it drives |
|---|---|---|---|
| J1 | Sales owner | Set a realistic annual/seasonal buying target for this account | How much effort the account deserves |
| J2 | Merchandiser / Sales owner | Split that target by product/category/site/department | Which lines to push and prepare |
| J3 | Sales manager | Compare account budget against live journeys | Whether the account is under-covered |
| J4 | Sales owner | Record source and confidence for the budget | Whether the number is real or hopeful |
| J5 | CEO / Sales manager | See top account gaps and risks | Which accounts need intervention |
| J6 | Finance | Understand expected customer revenue without confusing it with ledger budgets | Planning and forecast context |

---

## 4. Proposed backend model

Add `models/CMS_Models/Sales/AccountBudget.js`.

### 4.1 AccountBudget fields

- `budgetId`: generated human code, e.g. `ABUD-...`
- `accountId`: `CRMAccount` ref, required, indexed
- `name`: e.g. `FY 2026-27 Annual Buying Plan`
- `financialYear`
- `period`: `monthly | quarterly | half_yearly | yearly | seasonal | custom`
- `startDate`, `endDate`
- `currency`: default from account
- `status`: `draft | reviewed | active | revised | closed | archived`
- `ownerId`, `ownerName`
- `reviewedBy`, `reviewedAt`
- `source`: `customer_confirmed | historical | sales_estimate | tender | contract | imported | other`
- `confidence`: `low | medium | high | confirmed`
- `notes`
- `revisionOf`: optional previous `AccountBudget` ref
- `createdBy`, `updatedBy`
- timestamps

### 4.2 Budget lines

Each budget has `lines[]`:

- `lineId`
- `label`
- `productCategory`
- `departmentId` or free text department name
- `siteId`
- `quantityTarget`
- `unitPriceTarget`
- `amountTarget`
- `confidence`
- `sourceNote`
- `phasing`: optional monthly weights, same concept as Accountant budgets
- cached evaluated fields:
  - `pipelineAmount`
  - `wonAmount`
  - `lostAmount`
  - `remainingAmount`
  - `coveragePct`
  - `risk`

`amountTarget` can be entered directly or derived from quantity x unit price.
Store the entered/derived mode so the UI can explain the figure.

### 4.3 Indexes

- `{ accountId: 1, startDate: -1 }`
- `{ accountId: 1, status: 1 }`
- `{ financialYear: 1, status: 1 }`
- `{ "lines.productCategory": 1 }`

---

## 5. Evaluation rules

Account budget actual/coverage should be recomputed on read, not trusted from
cached fields.

Inputs, in priority order:

1. Won/completed Sales Journeys for the account, once order value is real.
2. Active Sales Journeys with `expectedValue`, weighted by stage/probability.
3. Lead researched potential only as context, not as actual coverage.
4. Manual adjustment lines, if a later slice adds them.

The first MVP can compute:

- `targetAmount`
- `pipelineAmount`: sum of active journeys' expected value
- `wonAmount`: zero until order outcome/value is reliable
- `remainingAmount = targetAmount - wonAmount - pipelineAmount`
- `coveragePct = (wonAmount + pipelineAmount) / targetAmount`
- `state`:
  - `uncovered`: coverage below 40%
  - `building`: 40-79%
  - `covered`: 80-109%
  - `overplanned`: 110%+

Do not call this "actual sales" until order/invoice data is integrated. In the
MVP it is "pipeline coverage".

---

## 6. API shape

Mount under Sales CRM:

- `GET /api/cms/crm/accounts/:accountId/budgets`
- `POST /api/cms/crm/accounts/:accountId/budgets`
- `GET /api/cms/crm/account-budgets/:budgetId`
- `PATCH /api/cms/crm/account-budgets/:budgetId`
- `POST /api/cms/crm/account-budgets/:budgetId/activate`
- `POST /api/cms/crm/account-budgets/:budgetId/close`
- `DELETE /api/cms/crm/account-budgets/:budgetId`

Rules:

- Use `salesAuth`.
- Sales write guard/approval rules should match other account sub-entities.
- Every mutation writes `ChangeLog` with entity `crm-account-budget`.
- Budget reads should include evaluated totals and line coverage.
- Account detail can optionally include a compact `budgetSummary`, but the full
  list should be fetched by the Budget tab to keep the account payload lean.

---

## 7. Frontend surface

### 7.1 Account workspace

Add a new tab in `/sales/dashboard/accounts/[id]/page.js`:

- Tab label: `Budget`
- Count: number of active/reviewed budgets, or attention count if stronger
- Component: `_sections/BudgetSection.js`

Place it near `Commercial`, because it is a plan built from commercial facts,
but keep it separate from Commercial terms.

### 7.2 Budget section

The section should show:

- Active budget header: name, period, status, confidence
- KPI strip:
  - Target
  - Pipeline covered
  - Won/converted when available
  - Remaining
  - Coverage %
- Lines table:
  - Product/category
  - Quantity
  - Rate
  - Target
  - Pipeline/won
  - Remaining
  - Confidence/source
- Journey coverage panel:
  - active journeys contributing to coverage
  - journeys without value that cannot contribute
- Empty state:
  - "No budget set for this account"
  - primary action: `Create budget`

### 7.3 Dossier rail

Add one compact rail fact/card only after the Budget tab exists:

- Current FY target
- Covered %
- Remaining

This should be a signal, not an editor.

### 7.4 Form

Use a CRM drawer/modal pattern, not a page jump:

- Period and date range
- Currency
- Source/confidence
- Budget lines with add/remove
- Quantity x unit price helper
- Notes

Avoid copying the current Accountant budget form directly. It is built for
ledger heads and uses older accounting styling; the Account budget form should
use Sales/CRM primitives.

---

## 8. Integration with Accountant budgets

Do not auto-create `Acc_Budget` from Account budgets in the MVP.

Later integration options:

1. Account budgets feed a Sales revenue planning view.
2. Finance can import reviewed account budgets into a company revenue budget.
3. Cash-flow forecasting can use active account budgets only as low-confidence
   planned inflows, below committed invoices and pipeline with payment terms.

Boundary rule:

- Account Budget = customer buying plan and pipeline coverage.
- Accountant Budget = company ledger revenue/expense control.
- Cash Flow Forecast = dated cash movement.

---

## 9. Implementation slices

### Slice 1 — Backend foundation

- Add `AccountBudget` model.
- Add account-budget routes.
- Add evaluation service that reads Sales Journeys for the account.
- Add tests for create/update/read/evaluation.
- Add ChangeLog child entity support so account audit shows budget changes.

### Slice 2 — Account workspace MVP

- Add `BudgetSection`.
- Add Budget tab.
- Add create/edit drawer.
- Show budget list, active budget KPIs and line table.
- Show pipeline coverage from existing Journeys.

### Slice 3 — Account rail and list summaries

- Add compact rail signal.
- Add optional budget summary to account list/detail APIs if needed.
- Surface "budget missing" or "under-covered" as account attention states.

### Slice 4 — Better coverage sources

- Connect won/lost order values once Journey/order value is reliable.
- Add budget revisions.
- Add source/confidence filters and manager review.

### Slice 5 — Finance integration

- Export/import reviewed Account budgets into Accountant revenue budgets.
- Feed account budget plans into cash-flow forecasting only as planned,
  low-confidence rows.

---

## 10. Acceptance criteria

- An account can have a dated budget with one or more budget lines.
- Users can see target, covered, remaining and coverage percentage on the
  account.
- Coverage is computed from Sales Journeys on read, not manually typed as a
  fake actual.
- Budget values are clearly labelled as target/pipeline/won, not blended into
  one misleading number.
- Commercial terms remain separate from budget planning.
- Accounting `Acc_Budget` behavior is untouched.
- Account audit history includes budget create/update/close events.
- The UI follows the current Sales account workspace design language.

---

## 11. Open decisions

- Should one account have only one active budget per overlapping period?
  Recommended: yes, unless it is a revision of the previous one.
- Should budget lines use controlled product categories from garment profile
  options, free text, or both?
  Recommended: controlled when possible, free-text fallback.
- Should manager review be required before a budget becomes active?
  Recommended: not for MVP; support `reviewed` state in the model.
- Should lead annual-potential estimates seed the first account budget after
  conversion?
  Recommended: yes later, but as a suggested draft, not an automatic active
  budget.
