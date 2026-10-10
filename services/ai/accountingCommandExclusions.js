"use strict";
/**
 * services/ai/accountingCommandExclusions.js — every accounting collection,
 * and whether Cmd/Ctrl K reads it.
 *
 * The books own 45 modelled collections. Five hold the records people search
 * for by what they would type, and Cmd/Ctrl K reads them
 * (`ACCOUNTING_SEARCHED`). Every other one is listed here with WHY it is not
 * searched and WHAT answers instead — usually the page that owns it, which the
 * palette opens by name. `accountingCollectionCoverage.test.js` fails on an
 * accounting collection in neither list, so a collection added tomorrow has
 * to be decided rather than silently missed.
 *
 * Decided 8 Oct 2026 from each model and the pages that use it.
 */

/** Read by services/ai/accountingCommandSearch.service.js, always by companyId. */
const ACCOUNTING_SEARCHED = Object.freeze({
  acc_vouchers: "voucher — every type, by number, reference, party, status, date",
  acc_ledgers: "ledger, customer, supplier — by name, alias, GSTIN, PAN; with balance",
  acc_stock_items: "stock item — by name, alias, HSN; with closing stock",
  acc_groups: "account group — by name",
  acc_proforma_invoices: "proforma invoice — by number",
});

const reason = (why, instead) => Object.freeze({ why, instead });

const ACCOUNTING_NOT_SEARCHED = Object.freeze({
  /* ── Legacy, with no companyId: cannot be scoped, so never searched ── */
  acc_invoices: reason("Legacy invoices with no company field; a search cannot be held to one company.", "Sales vouchers, which replaced them, are searched."),
  acc_expenses: reason("Legacy expenses with no company field.", "Purchase and payment vouchers are searched; Expenses page."),
  acc_bank_transactions: reason("Legacy bank lines with no company field.", "Bank Transactions page."),
  acc_credit_debit_notes: reason("Legacy notes with no company field.", "Credit and debit note vouchers are searched."),
  acc_tax_filings: reason("Legacy filings with no company field.", "Tax Filings page."),

  /* ── Records a page lists, with no page of their own to open ── */
  acc_journal_entries: reason("Older journal entries with no record page; the list page shows them.", "Journal Entries page; journal vouchers are searched."),
  acc_budgets: reason("Budgets are read per financial year, with their own figures.", "Budgets page and its year pages."),
  acc_budgetcommitments: reason("Commitments against a budget head, read on the head's page.", "Budgets → the year → heads."),
  acc_budget_departments: reason("The departments budgets name.", "Budget departments page."),
  acc_itemcategorybudgets: reason("Which budget each item category draws on.", "'Which budget each item comes out of' page."),
  acc_approval_requests: reason("Approval queue items, acted on where they are listed.", "Approvals page."),
  acc_ledger_reclass_requests: reason("Requests to move a ledger between groups, decided on their own screen.", "Chart of Accounts."),
  acc_audit_notes: reason("Notes left by auditors, read where they are listed.", "Audit Notes page."),
  acc_custom_reports: reason("Saved report layouts, not business records.", "Custom Reports page."),
  acc_recurring_items: reason("Templates for recurring entries.", "Recurring Items page."),
  acc_gstr2bs: reason("Imported GSTR-2B statements, matched on the GST screens.", "GST Summary page."),
  acc_cashflow_adjustments: reason("Manual adjustments to the cash-flow forecast.", "Cash-flow Forecast page."),
  acc_forecast_cash_ledger_config: reason("Which ledgers the forecast treats as cash.", "Cash-flow Forecast page."),

  /* ── Masters a person does not look up by name in the palette ── */
  acc_companies: reason("The companies themselves — chosen with the company switcher, which scopes every search.", "The company switcher; Companies page."),
  acc_cost_centres: reason("Cost centres, picked inside vouchers.", "Settings."),
  acc_units: reason("Units of measure, picked inside stock items.", "Settings."),
  acc_stock_groups: reason("Stock groups; each stock item's card names its group.", "Stock items are searched."),
  acc_godowns: reason("Godowns, picked inside stock vouchers.", "Settings."),
  acc_bill_terms: reason("Payment terms text used on invoices.", "Settings."),
  acc_chart_of_accounts: reason("An older chart-of-accounts store; groups and ledgers are the live chart.", "Chart of Accounts page; groups and ledgers are searched."),
  acc_departments: reason("Accounting's own departments list.", "Departments page."),

  /* ── Access, credentials and system records: never searchable ── */
  acc_organizations: reason("The organisation that owns the books — access control.", "Nothing; not business data."),
  acc_users: reason("Accounting sign-in accounts.", "Team page."),
  acc_invites: reason("Pending invitations with their tokens.", "Team page."),
  acc_activity_logs: reason("Who did what, when — an audit trail.", "Change History page."),
  acc_settings: reason("A company's accounting settings — one row.", "Settings page."),
  acc_pinned_items: reason("A person's own pinned shortcuts.", "Nothing; personal."),
  acc_row_priorities: reason("A person's own row ordering.", "Nothing; personal."),
  acc_backup_config: reason("Backup configuration.", "Settings."),
  acc_backup_records: reason("Backup run records.", "Settings."),
  acc_field_mappings: reason("Import column mappings.", "Data import screens."),
  acc_import_sessions: reason("A record of each data-import run.", "Data import screens."),
  acc_payroll_ledger_maps: reason("Which ledger each payroll head posts to.", "Payroll page."),
  acc_payroll_external_posts: reason("Payroll postings received from HR.", "Payroll page."),
  acc_setu_consents: reason("Bank-data consents with the account aggregator.", "Bank Reconciliation."),
});

module.exports = { ACCOUNTING_SEARCHED, ACCOUNTING_NOT_SEARCHED };
