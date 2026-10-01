# Accounting company-scope inventory — Lane A, Chunk 3A

Generated from the mounted router stacks in `server.js`, not from a file scan:
each `/api/accountant/*` router is loaded and its Express stack walked, so what
is listed is what the server actually dispatches.

| Class | Endpoints | Meaning |
|---|---:|---|
| ENFORCED | 149 | Company scope validated and ownership-checked |
| DERIVED | 159 | Company must come from an existing record — **Chunk 3B** |
| NO_SCOPE | 119 | No company dimension |

**Total mounted accounting endpoints: 427.**

## Enforced in this chunk

Guard: `requireCompanyScope` (aliased `companyScope`) where the endpoint
requires a company; `scopeCompanyIfPresent` (`companyScopeOptional`) where the
endpoint legitimately aggregates across the organisation when none is named —
absent is allowed there, but anything supplied is still ownership-checked.

| Mount | Method | Route | Scope source |
|---|---|---|---|
| `/api/accountant/approvals` | GET | `/list` | query+req.companyId |
| `/api/accountant/audit-notes` | GET | `/` | query+req.companyId |
| `/api/accountant/audit-notes` | POST | `/` | body+req.companyId |
| `/api/accountant/audit-notes` | GET | `/stats` | query+req.companyId |
| `/api/accountant/bank-recon` | GET | `/annual-summary` | query+req.companyId |
| `/api/accountant/bank-recon` | GET | `/bank-ledgers` | query+req.companyId |
| `/api/accountant/bank-recon` | GET | `/sessions` | query+req.companyId |
| `/api/accountant/bank-recon` | PUT | `/sessions/:id/ledger` | body+req.companyId |
| `/api/accountant/bank-recon` | GET | `/sessions/:id/match-candidates` | query+req.companyId |
| `/api/accountant/bank-recon` | POST | `/upload` | body+req.companyId |
| `/api/accountant/bill-terms` | POST | `/backfill/apply` | body+req.companyId |
| `/api/accountant/bill-terms` | GET | `/backfill/preview` | query+req.companyId |
| `/api/accountant/bill-terms` | POST | `/backfill/rollback` | body+req.companyId |
| `/api/accountant/budgets` | GET | `/` | query+req.companyId |
| `/api/accountant/budgets` | POST | `/` | body+req.companyId |
| `/api/accountant/budgets` | GET | `/dashboard` | query+req.companyId |
| `/api/accountant/budgets` | GET | `/item-usage` | query+req.companyId |
| `/api/accountant/cash-flow-forecast` | GET | `/` | query+req.companyId |
| `/api/accountant/cash-flow-forecast` | GET | `/action-center` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/ensure-defaults` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/groups` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/groups` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | PATCH | `/groups/:id/order` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/groups/:id/statement` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/ledgers` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers/:id/merge` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/ledgers/:id/statement` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers/:id/transactions` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers/:id/transfer-balance` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/ledgers/search-by-voucher` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/parties/preview` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/parties/sync` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/payroll/cleanup` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/payroll/ledger-map` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | PUT | `/payroll/ledger-map` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/payroll/runs` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/payroll/runs/:runId/mark-external` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | DELETE | `/payroll/runs/:runId/mark-external` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/payroll/runs/:runId/post` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/payroll/runs/:runId/preview` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/payroll/runs/:runId/unpost` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/payroll/runs/post-all` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/primary-invoice-bank` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | POST | `/seed-manufacturing` | body+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/tree` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/trial-balance` | query+req.companyId |
| `/api/accountant/chart-of-accounts` | GET | `/trial-balance/diagnose` | query+req.companyId |
| `/api/accountant/customers` | GET | `/` | query+req.companyId |
| `/api/accountant/customers` | GET | `/:customerId/accounting` | query+req.companyId |
| `/api/accountant/customers` | GET | `/all` | query+req.companyId |
| `/api/accountant/customers` | GET | `/export/pdf` | query+req.companyId |
| `/api/accountant/customers` | GET | `/export/xlsx` | query+req.companyId |
| `/api/accountant/customers/reports` | GET | `/ageing` | params+query+body |
| `/api/accountant/customers/reports` | POST | `/ageing` | params+query+body |
| `/api/accountant/customers/reports` | GET | `/ledger/:ledgerId` | params+query+body |
| `/api/accountant/customers/reports` | GET | `/outstanding` | params+query+body |
| `/api/accountant/customers/reports` | POST | `/outstanding` | params+query+body |
| `/api/accountant/eway-bill` | GET | `/eligible-vouchers` | query+req.companyId |
| `/api/accountant/eway-bill` | POST | `/generate` | body+req.companyId |
| `/api/accountant/eway-bill` | POST | `/preflight` | body+req.companyId |
| `/api/accountant/expenses` | GET | `/` | query+req.companyId |
| `/api/accountant/expenses` | GET | `/expense-ledgers` | query+req.companyId |
| `/api/accountant/expenses` | GET | `/gst-input-ledgers` | query+req.companyId |
| `/api/accountant/forecast-cash-ledger-config` | GET | `/` | query+req.companyId |
| `/api/accountant/forecast/party-terms-impact` | GET | `/` | query+req.companyId |
| `/api/accountant/forecast/party-terms-impact` | POST | `/apply` | body+req.companyId |
| `/api/accountant/gst-verification` | POST | `/scope` | body+req.companyId |
| `/api/accountant/gstr2b` | GET | `/:period` | query+req.companyId |
| `/api/accountant/gstr2b` | DELETE | `/:period` | query+req.companyId |
| `/api/accountant/gstr2b` | GET | `/:period/supplier-summary` | query+req.companyId |
| `/api/accountant/gstr2b` | GET | `/periods` | query+req.companyId |
| `/api/accountant/gstr2b` | GET | `/recon-range` | query+req.companyId |
| `/api/accountant/gstr2b` | POST | `/upload` | body+req.companyId |
| `/api/accountant/import-mapping` | POST | `/analyze` | body+req.companyId |
| `/api/accountant/import-mapping` | POST | `/commit` | body+req.companyId |
| `/api/accountant/import-mapping` | POST | `/suggest-from-session` | body+req.companyId |
| `/api/accountant/invoices` | GET | `/` | query+req.companyId |
| `/api/accountant/invoices` | GET | `/all` | query+req.companyId |
| `/api/accountant/invoices` | GET | `/next-number` | query+req.companyId |
| `/api/accountant/invoices` | GET | `/summary` | query+req.companyId |
| `/api/accountant/ledger-reclass` | GET | `/mine` | query+req.companyId |
| `/api/accountant/ledger-reclass` | GET | `/pending` | query+req.companyId |
| `/api/accountant/ledger-reclass` | POST | `/propose` | body+req.companyId |
| `/api/accountant/merge` | POST | `/add-alias` | body+req.companyId |
| `/api/accountant/merge` | GET | `/ledger-suggestions` | query+req.companyId |
| `/api/accountant/merge` | POST | `/ledgers` | body+req.companyId |
| `/api/accountant/merge` | POST | `/stock-items` | body+req.companyId |
| `/api/accountant/merge` | GET | `/stock-suggestions` | query+req.companyId |
| `/api/accountant/parties` | GET | `/` | query+req.companyId |
| `/api/accountant/parties` | GET | `/:ledgerId` | query+req.companyId |
| `/api/accountant/parties` | PATCH | `/:ledgerId/credit-terms` | query+body+req.companyId |
| `/api/accountant/parties` | GET | `/:ledgerId/transactions` | query+req.companyId |
| `/api/accountant/parties` | PATCH | `/bulk-credit-terms` | body+req.companyId |
| `/api/accountant/proforma-invoices` | GET | `/` | query+req.companyId |
| `/api/accountant/recurring-items` | PATCH | `/:id` | body+req.companyId |
| `/api/accountant/search` | GET | `/` | query+req.companyId |
| `/api/accountant/spend-approvals` | GET | `/` | query+req.companyId |
| `/api/accountant/tally/import` | POST | `/bsheet/commit` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/bsheet/preview` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/combined/commit` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/combined/preview` | body+req.companyId |
| `/api/accountant/tally/import` | GET | `/mappings` | query+req.companyId |
| `/api/accountant/tally/import` | POST | `/masters/commit` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/masters/preview` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/reconcile` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/reset-accounting` | body+req.companyId |
| `/api/accountant/tally/import` | GET | `/sessions` | query+req.companyId |
| `/api/accountant/tally/import` | PUT | `/sessions/:id/mapping` | body+req.companyId |
| `/api/accountant/tally/import` | POST | `/upload` | body+req.companyId |
| `/api/accountant/tally/reports` | GET | `/balance-sheet` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/cash-flow` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/dashboard` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/dashboard-overview` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/data-range` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/day-book` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/gst-summary` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/profit-loss` | query+req.companyId |
| `/api/accountant/tally/reports` | GET | `/trial-balance` | query+req.companyId |
| `/api/accountant/vendors` | GET | `/` | query+req.companyId |
| `/api/accountant/vendors` | GET | `/:id` | query+req.companyId |
| `/api/accountant/vendors` | POST | `/:id/merge` | query+body+req.companyId |
| `/api/accountant/vendors/reports` | GET | `/ageing` | params+query+body |
| `/api/accountant/vendors/reports` | POST | `/ageing` | params+query+body |
| `/api/accountant/vendors/reports` | GET | `/ledger/:ledgerId` | params+query+body |
| `/api/accountant/vendors/reports` | GET | `/outstanding` | params+query+body |
| `/api/accountant/vendors/reports` | POST | `/outstanding` | params+query+body |
| `/api/accountant/vouchers` | GET | `/` | query+req.companyId |
| `/api/accountant/vouchers` | POST | `/:id/link-po` | body+req.companyId |
| `/api/accountant/vouchers` | POST | `/:id/match-payment` | body+req.companyId |
| `/api/accountant/vouchers` | GET | `/bill-lookup` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/cash-bank-ledgers` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/gst-input-ledgers` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/gst-output-ledgers` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/invoice-lookup` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/next-number/:companyId/:voucherType` | params+query+req.companyId |
| `/api/accountant/vouchers` | GET | `/payment-match-candidates` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/po-match-candidates/:poId` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/purchase-ledgers` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/purchase-returns-ledger` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/raw-materials` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/roundoff-ledger` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/sales-ledgers` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/sales-returns-ledger` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/service-order/:id/billable` | query+body+req.companyId |
| `/api/accountant/vouchers` | GET | `/stock-items` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/summary/by-type` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/unpaid-bills` | query+req.companyId |
| `/api/accountant/vouchers` | GET | `/unpaid-invoices` | query+req.companyId |

## Deferred to Chunk 3B — company derived from a record id

These take a resource id (`:id`, `:ledgerId`, `:voucherId`…) and no companyId.
Guarding them needs the record loaded first and its `companyId` checked, which
is a per-endpoint change, not a middleware one. **Until 3B they remain
organisation-authenticated but not company-isolated.**

| Mount | Method | Route |
|---|---|---|
| `/api/accountant/approvals` | GET | `/:id` |
| `/api/accountant/approvals` | POST | `/:id/approve` |
| `/api/accountant/approvals` | POST | `/:id/cancel` |
| `/api/accountant/approvals` | POST | `/:id/reject` |
| `/api/accountant/audit-notes` | GET | `/:id` |
| `/api/accountant/audit-notes` | DELETE | `/:id` |
| `/api/accountant/audit-notes` | POST | `/:id/acknowledge` |
| `/api/accountant/audit-notes` | POST | `/:id/archive` |
| `/api/accountant/audit-notes` | POST | `/:id/comment` |
| `/api/accountant/audit-notes` | POST | `/:id/reject` |
| `/api/accountant/audit-notes` | POST | `/:id/resolve` |
| `/api/accountant/audit-notes` | POST | `/:id/unarchive` |
| `/api/accountant/audit-notes` | POST | `/:id/verify` |
| `/api/accountant/audit-notes` | GET | `/for/:targetType/:targetId` |
| `/api/accountant/backup` | GET | `/download/:fileId` |
| `/api/accountant/bank-recon` | GET | `/sessions/:id` |
| `/api/accountant/bank-recon` | DELETE | `/sessions/:id` |
| `/api/accountant/bank-recon` | PUT | `/sessions/:id/clear-ledger` |
| `/api/accountant/bank-recon` | PUT | `/sessions/:id/match` |
| `/api/accountant/bank-recon` | PUT | `/sessions/:id/reconcile` |
| `/api/accountant/bank-recon` | PUT | `/sessions/:id/unmatch` |
| `/api/accountant/bank-transactions` | DELETE | `/:id` |
| `/api/accountant/bank-transactions` | GET | `/:id/auto-match-suggestions` |
| `/api/accountant/bank-transactions` | POST | `/:id/reconcile` |
| `/api/accountant/bank-transactions` | POST | `/:id/unreconcile` |
| `/api/accountant/budget-departments` | PATCH | `/:id` |
| `/api/accountant/budgets` | GET | `/:id` |
| `/api/accountant/budgets` | PUT | `/:id` |
| `/api/accountant/budgets` | DELETE | `/:id` |
| `/api/accountant/budgets` | GET | `/:id/adjustments` |
| `/api/accountant/budgets` | POST | `/:id/adjustments` |
| `/api/accountant/budgets` | POST | `/:id/adjustments/:adjustmentId/approve` |
| `/api/accountant/budgets` | POST | `/:id/adjustments/:adjustmentId/cancel` |
| `/api/accountant/budgets` | POST | `/:id/adjustments/:adjustmentId/reject` |
| `/api/accountant/budgets` | POST | `/:id/close-collection` |
| `/api/accountant/budgets` | POST | `/:id/drafts` |
| `/api/accountant/budgets` | GET | `/:id/items/:itemId/vouchers` |
| `/api/accountant/budgets` | GET | `/:id/requests` |
| `/api/accountant/budgets` | POST | `/:id/requests` |
| `/api/accountant/budgets` | PUT | `/:id/requests/:requestId` |
| `/api/accountant/budgets` | DELETE | `/:id/requests/:requestId` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/agree` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/counter` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/lines/:rowId/decide` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/lines/:rowId/respond` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/reject` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/reopen` |
| `/api/accountant/budgets` | POST | `/:id/requests/:requestId/resolve-head` |
| `/api/accountant/budgets` | POST | `/:id/submissions` |
| `/api/accountant/budgets` | GET | `/:id/transfers` |
| `/api/accountant/budgets` | POST | `/:id/transfers` |
| `/api/accountant/budgets` | POST | `/:id/transfers/:transferId/approve` |
| `/api/accountant/budgets` | POST | `/:id/transfers/:transferId/cancel` |
| `/api/accountant/budgets` | POST | `/:id/transfers/:transferId/reject` |
| `/api/accountant/budgets` | GET | `/:id/transfers/available` |
| `/api/accountant/cashflow-adjustments` | PUT | `/:id` |
| `/api/accountant/cashflow-adjustments` | DELETE | `/:id` |
| `/api/accountant/cashflow-adjustments` | POST | `/:id/approve` |
| `/api/accountant/cashflow-adjustments` | POST | `/:id/reject` |
| `/api/accountant/change-history` | GET | `/record/:entity/:entityId` |
| `/api/accountant/chart-of-accounts` | PUT | `/groups/:id` |
| `/api/accountant/chart-of-accounts` | DELETE | `/groups/:id` |
| `/api/accountant/chart-of-accounts` | GET | `/ledgers/:id` |
| `/api/accountant/chart-of-accounts` | PUT | `/ledgers/:id` |
| `/api/accountant/chart-of-accounts` | DELETE | `/ledgers/:id` |
| `/api/accountant/chart-of-accounts` | PATCH | `/ledgers/:id/budget-control` |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers/:id/clear-primary-bank` |
| `/api/accountant/chart-of-accounts` | POST | `/ledgers/:id/set-primary-bank` |
| `/api/accountant/chart-of-accounts` | PUT | `/raw-items/:id/budget-head` |
| `/api/accountant/chart-of-accounts` | PUT | `/services/:id/budget-head` |
| `/api/accountant/cost-centres` | PATCH | `/:id` |
| `/api/accountant/customers` | GET | `/:customerId` |
| `/api/accountant/customers` | GET | `/:customerId/financial-summary` |
| `/api/accountant/customers` | GET | `/:customerId/payments` |
| `/api/accountant/customers` | POST | `/:customerId/payments/:paymentId/mark-reviewed` |
| `/api/accountant/customers` | GET | `/:customerId/requests` |
| `/api/accountant/customers` | POST | `/:customerId/requests/:requestId/quotations/:quotationId/approve` |
| `/api/accountant/customers` | POST | `/:customerId/requests/:requestId/quotations/:quotationId/revoke-approval` |
| `/api/accountant/customers` | GET | `/:customerId/statistics` |
| `/api/accountant/customers` | POST | `/:id/merge` |
| `/api/accountant/expenses` | GET | `/:id` |
| `/api/accountant/expenses` | POST | `/:id/approve` |
| `/api/accountant/expenses` | POST | `/:id/reject` |
| `/api/accountant/gst-verification` | POST | `/ledgers/:id/verify` |
| `/api/accountant/invoices` | GET | `/:id` |
| `/api/accountant/invoices` | PUT | `/:id` |
| `/api/accountant/invoices` | GET | `/:id/debug-dispatch` |
| `/api/accountant/invoices` | GET | `/:id/download-pdf` |
| `/api/accountant/invoices` | POST | `/:id/reminder` |
| `/api/accountant/invoices` | PATCH | `/:id/status` |
| `/api/accountant/journal-entries` | GET | `/:id` |
| `/api/accountant/journal-entries` | DELETE | `/:id` |
| `/api/accountant/journal-entries` | POST | `/:id/post` |
| `/api/accountant/journal-entries` | POST | `/:id/void` |
| `/api/accountant/ledger-reclass` | DELETE | `/:id` |
| `/api/accountant/ledger-reclass` | POST | `/:id/approve` |
| `/api/accountant/ledger-reclass` | POST | `/:id/reject` |
| `/api/accountant/payroll` | GET | `/employee/:employeeId` |
| `/api/accountant/payroll` | GET | `/runs/:runId/items` |
| `/api/accountant/pins` | DELETE | `/:entityType/:entityId` |
| `/api/accountant/priorities` | DELETE | `/:entityType/:entityId` |
| `/api/accountant/proforma-invoices` | GET | `/:id` |
| `/api/accountant/proforma-invoices` | PUT | `/:id` |
| `/api/accountant/proforma-invoices` | DELETE | `/:id` |
| `/api/accountant/proforma-invoices` | PATCH | `/:id/status` |
| `/api/accountant/recurring-items` | DELETE | `/:id` |
| `/api/accountant/setu-aa` | GET | `/consent/:id` |
| `/api/accountant/setu-aa` | POST | `/revoke/:id` |
| `/api/accountant/spend-approvals` | GET | `/:id` |
| `/api/accountant/spend-approvals` | POST | `/:id/approve` |
| `/api/accountant/spend-approvals` | POST | `/:id/budget-exception` |
| `/api/accountant/spend-approvals` | GET | `/:id/line-allocations` |
| `/api/accountant/spend-approvals` | POST | `/:id/reject` |
| `/api/accountant/tally/companies` | GET | `/:id` |
| `/api/accountant/tally/companies` | PUT | `/:id` |
| `/api/accountant/tally/companies` | DELETE | `/:id` |
| `/api/accountant/tally/companies` | PATCH | `/:id/default-credit-days` |
| `/api/accountant/tally/companies` | POST | `/:id/documents` |
| `/api/accountant/tally/companies` | GET | `/:id/documents` |
| `/api/accountant/tally/companies` | DELETE | `/:id/documents/:docId` |
| `/api/accountant/tally/companies` | GET | `/:id/documents/:docId/download` |
| `/api/accountant/tally/companies` | GET | `/:id/documents/:docId/download/:filename` |
| `/api/accountant/tally/companies` | DELETE | `/:id/documents/:docId/files/:fileId` |
| `/api/accountant/tally/companies` | GET | `/:id/documents/:docId/link` |
| `/api/accountant/tally/companies` | POST | `/:id/reseed-groups` |
| `/api/accountant/tally/import` | DELETE | `/mappings/:id` |
| `/api/accountant/tally/import` | GET | `/sessions/:id` |
| `/api/accountant/tally/import` | POST | `/sessions/:id/commit` |
| `/api/accountant/tally/import` | POST | `/sessions/:id/rollback` |
| `/api/accountant/tally/import` | POST | `/sessions/:id/suggest-mapping` |
| `/api/accountant/tally/import` | POST | `/sessions/:id/validate` |
| `/api/accountant/tax-filings` | PUT | `/:id` |
| `/api/accountant/tax-filings` | DELETE | `/:id` |
| `/api/accountant/tax-filings` | POST | `/:id/file` |
| `/api/accountant/team` | PATCH | `/:userId` |
| `/api/accountant/team` | DELETE | `/:userId` |
| `/api/accountant/team` | POST | `/:userId/activate` |
| `/api/accountant/team` | POST | `/:userId/deactivate` |
| `/api/accountant/team` | GET | `/:userId/nav-prefs` |
| `/api/accountant/team` | PUT | `/:userId/nav-prefs` |
| `/api/accountant/team` | POST | `/:userId/reset-password` |
| `/api/accountant/team` | DELETE | `/invites/:id` |
| `/api/accountant/vendors` | PUT | `/:id` |
| `/api/accountant/vendors` | DELETE | `/:id` |
| `/api/accountant/vendors` | POST | `/:id/payment` |
| `/api/accountant/vendors` | GET | `/:id/payments` |
| `/api/accountant/vendors` | GET | `/:id/purchase-orders` |
| `/api/accountant/vendors` | PATCH | `/:id/purchase-orders/:poId/payment-status` |
| `/api/accountant/vendors` | GET | `/:id/transactions` |
| `/api/accountant/voucher-files` | GET | `/:fileId` |
| `/api/accountant/vouchers` | GET | `/:id` |
| `/api/accountant/vouchers` | PUT | `/:id` |
| `/api/accountant/vouchers` | DELETE | `/:id` |
| `/api/accountant/vouchers` | POST | `/:id/approve` |
| `/api/accountant/vouchers` | POST | `/:id/cancel` |
| `/api/accountant/vouchers` | POST | `/:id/post` |
| `/api/accountant/vouchers` | POST | `/:id/reject` |
| `/api/accountant/vouchers` | POST | `/:id/void` |
| `/api/accountant/vouchers` | GET | `/po-detail/:poId` |

## No company dimension

| Module | Endpoints |
|---|---:|
| `Acc_auth` | 11 |
| `Acc_backup` | 11 |
| `Acc_bankTransactions` | 8 |
| `Acc_chartOfAccounts` | 8 |
| `Acc_reports` | 7 |
| `Acc_changeHistory` | 6 |
| `Acc_settings` | 5 |
| `Acc_vouchers` | 5 |
| `Acc_dashboard` | 4 |
| `Acc_setuAA` | 4 |
| `Acc_companies` | 4 |
| `Acc_team` | 3 |
| `Acc_pins` | 3 |
| `Acc_priorities` | 3 |
| `Acc_cashflowAdjustments` | 3 |
| `Acc_taxFilings` | 3 |
| `Acc_gstVerification` | 3 |
| `Acc_import` | 3 |
| `Acc_customers` | 2 |
| `Acc_journalEntries` | 2 |
| `Acc_payroll` | 2 |
| `Acc_budgets` | 2 |
| `Acc_billTerms` | 2 |
| `Acc_recurringItems` | 2 |
| `Acc_costCentres` | 2 |
| `Acc_budgetDepartments` | 2 |
| `Acc_gstr2b` | 2 |
| `Acc_approvals` | 1 |
| `Acc_expenses` | 1 |
| `Acc_proformaInvoices` | 1 |
| `Acc_vendors` | 1 |
| `Acc_voucherUploads` | 1 |
| `Acc_forecastCashLedgerConfig` | 1 |
| `Acc_partyTermsImpact` | 1 |

## Behaviour of the canonical guard

| Condition | Status | Code |
|---|---|---|
| No companyId anywhere (required routes) | 400 | `COMPANY_SCOPE_REQUIRED` |
| Not a 24-hex id | 400 | `COMPANY_SCOPE_INVALID` |
| Different values across params/query/body | 400 | `COMPANY_SCOPE_CONFLICT` |
| Repeated query param with two values | 400 | `COMPANY_SCOPE_CONFLICT` |
| Valid id the organisation does not own | 403 | `COMPANY_FORBIDDEN` |
| Valid id that does not exist | 403 | `COMPANY_FORBIDDEN` (identical — the two are not distinguishable by design) |
| Authenticated but no organisation | 403 | `NO_ORGANIZATION_CONTEXT` |
| Owned company | pass | `req.companyId` set |

## Deferred to Lane A Chunk 3B — company derived from a record id

These take a resource id and no `companyId`, so the company can only be
known by loading the record. That is a per-endpoint change, not a middleware
one. **Until 3B they are organisation-authenticated but not company-isolated.**

Total: 133 endpoints across 28 routers.

| Router | Endpoints |
|---|---:|
| `Acc_budgets.js` | 22 |
| `Acc_auditNotes.js` | 10 |
| `Acc_companies.js` | 10 |
| `Acc_customers.js` | 9 |
| `Acc_team.js` | 8 |
| `Acc_chartOfAccounts.js` | 7 |
| `Acc_vendors.js` | 7 |
| `Acc_bankRecon.js` | 6 |
| `Acc_vouchers.js` | 6 |
| `Acc_import.js` | 5 |
| `Acc_approvals.js` | 4 |
| `Acc_bankTransactions.js` | 4 |
| `Acc_cashflowAdjustments.js` | 4 |
| `Acc_journalEntries.js` | 4 |
| `Acc_expenses.js` | 3 |
| `Acc_invoices.js` | 3 |
| `Acc_ledgerReclass.js` | 3 |
| `Acc_spendApprovals.js` | 3 |
| `Acc_taxFilings.js` | 3 |
| `Acc_payroll.js` | 2 |
| `Acc_proformaInvoices.js` | 2 |
| `Acc_setuAA.js` | 2 |
| `Acc_backup.js` | 1 |
| `Acc_changeHistory.js` | 1 |
| `Acc_gstVerification.js` | 1 |
| `Acc_pins.js` | 1 |
| `Acc_priorities.js` | 1 |
| `Acc_voucherUploads.js` | 1 |

<details><summary>Full list</summary>

- `Acc_approvals.js GET /:id`
- `Acc_approvals.js POST /:id/approve`
- `Acc_approvals.js POST /:id/cancel`
- `Acc_approvals.js POST /:id/reject`
- `Acc_auditNotes.js DELETE /:id`
- `Acc_auditNotes.js GET /:id`
- `Acc_auditNotes.js GET /for/:targetType/:targetId`
- `Acc_auditNotes.js POST /:id/acknowledge`
- `Acc_auditNotes.js POST /:id/archive`
- `Acc_auditNotes.js POST /:id/comment`
- `Acc_auditNotes.js POST /:id/reject`
- `Acc_auditNotes.js POST /:id/resolve`
- `Acc_auditNotes.js POST /:id/unarchive`
- `Acc_auditNotes.js POST /:id/verify`
- `Acc_backup.js GET /download/:fileId`
- `Acc_bankRecon.js DELETE /sessions/:id`
- `Acc_bankRecon.js GET /sessions/:id`
- `Acc_bankRecon.js PUT /sessions/:id/clear-ledger`
- `Acc_bankRecon.js PUT /sessions/:id/match`
- `Acc_bankRecon.js PUT /sessions/:id/reconcile`
- `Acc_bankRecon.js PUT /sessions/:id/unmatch`
- `Acc_bankTransactions.js DELETE /:id`
- `Acc_bankTransactions.js GET /:id/auto-match-suggestions`
- `Acc_bankTransactions.js POST /:id/reconcile`
- `Acc_bankTransactions.js POST /:id/unreconcile`
- `Acc_budgets.js DELETE /:id`
- `Acc_budgets.js DELETE /:id/requests/:requestId`
- `Acc_budgets.js GET /:id/adjustments`
- `Acc_budgets.js GET /:id/transfers`
- `Acc_budgets.js GET /:id/transfers/available`
- `Acc_budgets.js POST /:id/adjustments`
- `Acc_budgets.js POST /:id/adjustments/:adjustmentId/approve`
- `Acc_budgets.js POST /:id/adjustments/:adjustmentId/cancel`
- `Acc_budgets.js POST /:id/adjustments/:adjustmentId/reject`
- `Acc_budgets.js POST /:id/close-collection`
- `Acc_budgets.js POST /:id/drafts`
- `Acc_budgets.js POST /:id/requests/:requestId/agree`
- `Acc_budgets.js POST /:id/requests/:requestId/counter`
- `Acc_budgets.js POST /:id/requests/:requestId/lines/:rowId/decide`
- `Acc_budgets.js POST /:id/requests/:requestId/lines/:rowId/respond`
- `Acc_budgets.js POST /:id/requests/:requestId/reject`
- `Acc_budgets.js POST /:id/requests/:requestId/reopen`
- `Acc_budgets.js POST /:id/submissions`
- `Acc_budgets.js POST /:id/transfers`
- `Acc_budgets.js POST /:id/transfers/:transferId/approve`
- `Acc_budgets.js POST /:id/transfers/:transferId/cancel`
- `Acc_budgets.js POST /:id/transfers/:transferId/reject`
- `Acc_cashflowAdjustments.js DELETE /:id`
- `Acc_cashflowAdjustments.js POST /:id/approve`
- `Acc_cashflowAdjustments.js POST /:id/reject`
- `Acc_cashflowAdjustments.js PUT /:id`
- `Acc_changeHistory.js GET /record/:entity/:entityId`
- `Acc_chartOfAccounts.js DELETE /groups/:id`
- `Acc_chartOfAccounts.js DELETE /ledgers/:id`
- `Acc_chartOfAccounts.js GET /ledgers/:id`
- `Acc_chartOfAccounts.js PATCH /ledgers/:id/budget-control`
- `Acc_chartOfAccounts.js POST /ledgers/:id/clear-primary-bank`
- `Acc_chartOfAccounts.js PUT /groups/:id`
- `Acc_chartOfAccounts.js PUT /ledgers/:id`
- `Acc_companies.js DELETE /:id`
- `Acc_companies.js DELETE /:id/documents/:docId`
- `Acc_companies.js DELETE /:id/documents/:docId/files/:fileId`
- `Acc_companies.js GET /:id`
- `Acc_companies.js GET /:id/documents`
- `Acc_companies.js GET /:id/documents/:docId/download`
- `Acc_companies.js GET /:id/documents/:docId/download/:filename`
- `Acc_companies.js GET /:id/documents/:docId/link`
- `Acc_companies.js POST /:id/documents`
- `Acc_companies.js PUT /:id`
- `Acc_customers.js GET /:customerId`
- `Acc_customers.js GET /:customerId/financial-summary`
- `Acc_customers.js GET /:customerId/payments`
- `Acc_customers.js GET /:customerId/requests`
- `Acc_customers.js GET /:customerId/statistics`
- `Acc_customers.js POST /:customerId/payments/:paymentId/mark-reviewed`
- `Acc_customers.js POST /:customerId/requests/:requestId/quotations/:quotationId/approve`
- `Acc_customers.js POST /:customerId/requests/:requestId/quotations/:quotationId/revoke-approval`
- `Acc_customers.js POST /:id/merge`
- `Acc_expenses.js GET /:id`
- `Acc_expenses.js POST /:id/approve`
- `Acc_expenses.js POST /:id/reject`
- `Acc_gstVerification.js POST /ledgers/:id/verify`
- `Acc_import.js DELETE /mappings/:id`
- `Acc_import.js GET /sessions/:id`
- `Acc_import.js POST /sessions/:id/commit`
- `Acc_import.js POST /sessions/:id/suggest-mapping`
- `Acc_import.js POST /sessions/:id/validate`
- `Acc_invoices.js GET /:id/debug-dispatch`
- `Acc_invoices.js PATCH /:id/status`
- `Acc_invoices.js POST /:id/reminder`
- `Acc_journalEntries.js DELETE /:id`
- `Acc_journalEntries.js GET /:id`
- `Acc_journalEntries.js POST /:id/post`
- `Acc_journalEntries.js POST /:id/void`
- `Acc_ledgerReclass.js DELETE /:id`
- `Acc_ledgerReclass.js POST /:id/approve`
- `Acc_ledgerReclass.js POST /:id/reject`
- `Acc_payroll.js GET /employee/:employeeId`
- `Acc_payroll.js GET /runs/:runId/items`
- `Acc_pins.js DELETE /:entityType/:entityId`
- `Acc_priorities.js DELETE /:entityType/:entityId`
- `Acc_proformaInvoices.js DELETE /:id`
- `Acc_proformaInvoices.js PATCH /:id/status`
- `Acc_setuAA.js GET /consent/:id`
- `Acc_setuAA.js POST /revoke/:id`
- `Acc_spendApprovals.js GET /:id/line-allocations`
- `Acc_spendApprovals.js POST /:id/approve`
- `Acc_spendApprovals.js POST /:id/reject`
- `Acc_taxFilings.js DELETE /:id`
- `Acc_taxFilings.js POST /:id/file`
- `Acc_taxFilings.js PUT /:id`
- `Acc_team.js DELETE /:userId`
- `Acc_team.js DELETE /invites/:id`
- `Acc_team.js GET /:userId/nav-prefs`
- `Acc_team.js PATCH /:userId`
- `Acc_team.js POST /:userId/activate`
- `Acc_team.js POST /:userId/deactivate`
- `Acc_team.js POST /:userId/reset-password`
- `Acc_team.js PUT /:userId/nav-prefs`
- `Acc_vendors.js DELETE /:id`
- `Acc_vendors.js GET /:id/payments`
- `Acc_vendors.js GET /:id/purchase-orders`
- `Acc_vendors.js GET /:id/transactions`
- `Acc_vendors.js PATCH /:id/purchase-orders/:poId/payment-status`
- `Acc_vendors.js POST /:id/payment`
- `Acc_vendors.js PUT /:id`
- `Acc_voucherUploads.js GET /:fileId`
- `Acc_vouchers.js DELETE /:id`
- `Acc_vouchers.js GET /:id`
- `Acc_vouchers.js GET /po-detail/:poId`
- `Acc_vouchers.js POST /:id/approve`
- `Acc_vouchers.js POST /:id/post`
- `Acc_vouchers.js POST /:id/reject`

</details>
