# Accounting App Professionalisation Plan

## Objective

Make the Accounting app secure, reliable, fast, and easy for internal company teams. This is not a SaaS expansion: subscriptions, public onboarding, marketing features, and unnecessary tenant-management complexity are out of scope.

## 1. Secure the foundation

- Enforce organisation and company access on every Accounting API.
- Remove unrestricted legacy authentication.
- Scope settings, bank accounts, consents, and every financial record by company.
- Use clear roles: Viewer, Accountant, Approver, and Admin.
- Require approval for sensitive actions and retain a complete audit history.

## 2. Protect accounting integrity

- Make posted vouchers immutable.
- Correct errors through reversal and replacement entries.
- Add financial-period closing and controlled reopening.
- Make voucher numbering atomic and duplicate-safe.
- Run posting, cancellation, reconciliation, and balance updates in transactions.
- Add automated reconciliation between vouchers, ledgers, customer and supplier balances, and the trial balance.

## 3. Professionalise core workflows

Standardise the principal daily workflows:

- Sales invoices, credit notes, and receipts.
- Purchase bills, debit notes, and payments.
- Journals, contra entries, and opening balances.
- Customer and supplier ledgers.
- Bank matching and reconciliation.
- Expense management.
- GST returns and supporting reconciliation.
- Budgets, item usage, and approvals.

Every workflow must use consistent statuses, permissions, attachments, approval history, posting information, and correction actions.

## 4. Reports and exports

Provide a consistent Reporting Centre with Excel and professionally formatted PDF exports for:

- Trial Balance, General Ledger, Profit and Loss, and Balance Sheet.
- Customer and supplier outstanding summaries.
- Invoice-wise ageing.
- Detailed customer and supplier ledgers.
- Receivables and payables.
- Cash flow, bank book, and bank reconciliation.
- Sales, purchases, expenses, tax, and budgets.

From the Customers screen, users must be able to export selected, filtered, or all customers as:

- Outstanding summary.
- Detailed ledger with invoices, receipts, credit notes, and adjustments.
- Invoice-wise ageing.
- Individual customer statements.
- One combined file or separate PDFs in a ZIP.

Equivalent quick-export options should be available for Suppliers. Every report must show the company, date range or as-of date, applied filters, opening and closing balances, and totals that reconcile with the General Ledger.

## 5. Standardise the interface

- Retain the existing visual shell, company switcher, and Accounting search.
- Introduce reusable financial tables, filter bars, forms, status indicators, and accessible dialogs.
- Replace browser alerts and confirmations with professional notifications and confirmation flows.
- Add bulk actions and quick Excel/PDF downloads where useful.
- Support keyboard navigation, clear labels, and predictable focus behaviour.
- Standardise loading, empty, error, and permission-denied states.
- Split oversized screens into smaller maintainable modules.

## 6. Improve performance and reliability

- Use server-side pagination, filtering, and sorting for invoices, ledgers, and reports.
- Load heavy PDF, Excel, and GST functionality only when required.
- Add indexes aligned with company, date, account, and status queries.
- Prevent duplicate submissions and stale-request updates.
- Standardise request validation and API error messages.
- Remove unused, duplicated, and retired Accounting code.

## 7. Establish release controls

Automated coverage is required for:

- Company isolation, roles, and permissions.
- Posting, reversal, and cancellation.
- Voucher numbering and duplicate prevention.
- Period closing and reopening.
- Tax, discount, and rounding calculations.
- Customer and supplier balances.
- Bank reconciliation.
- Report-to-ledger reconciliation.
- Excel and PDF totals.
- Critical user journeys.

Accounting tests, code-quality checks, type checks, and the production build must pass before release.

## Execution order

1. Authentication and company isolation.
2. Ledger integrity and period closing.
3. Test and release gates.
4. Sales, purchases, receipts, payments, and banking.
5. Reports and bulk exports.
6. Shared UI and accessibility.
7. Performance and legacy-code cleanup.
8. Final reconciliation and user acceptance testing.

## Completion criteria

An authorised accountant can enter, approve, post, reverse, reconcile, report, and export company accounts confidently. Every displayed or exported balance is traceable to its source transaction and reconciles with the General Ledger.
