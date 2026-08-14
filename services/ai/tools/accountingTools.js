"use strict";
/**
 * services/ai/tools/accountingTools.js — the accountant module's data exposed to
 * the central assistant as permission-gated, read-only tools.
 *
 * Requiring this module registers the tools. All are gated by the shared
 * accounting-access resolver (services/access/accountingAccess), attached to the
 * user as `user.accountingAccess` before tools run — so a CEO/admin or an
 * accountant-module user can use them from ANY app, and no one else can.
 */

const { registerTool } = require("../toolRegistry");
const {
  buildCompanyInfo,
  buildFinancials,
  buildLedgerLookup,
  buildVouchers,
} = require("../../accountingContext");

const accAuthorised = (user) => Boolean(user && user.accountingAccess && user.accountingAccess.allowed === true);

// Month-number map + a spelled/relative date helper reused from the same idea as
// HR; the tool-calling path gets concrete YYYY-MM-DD from the model anyway.
const validDate = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

registerTool({
  name: "acc_financials",
  description:
    "Company FINANCIAL SUMMARY for authorised accounting/CEO: profit & loss (total revenue, total expenses, net profit/loss) and balance-sheet totals (assets, liabilities, equity) for the current financial year, from the ledger balances. Read-only.",
  permission: accAuthorised,
  parameters: { type: "object", properties: {} },
  matches: (msg) =>
    /\b(profit|loss|p&l|p and l|revenue|turnover|income|expenses?|balance sheet|financials?|net worth|assets|liabilit|how are we doing financially|financial (position|health|summary))\b/i.test(
      msg,
    ),
  provideContext: async () => ({ financials: await buildFinancials() }),
});

registerTool({
  name: "acc_ledger_balance",
  description:
    "Balance of a specific LEDGER/ACCOUNT, or all accounts in an account GROUP (for 'top debtors', 'biggest creditors', etc.), for authorised accounting/CEO. " +
    "The standard account GROUPS are: Sundry Debtors (customers who owe us / receivables), Sundry Creditors (suppliers we owe / payables), Cash-in-Hand, Bank Accounts, " +
    "Current Assets, Fixed Assets, Investments, Loans & Advances, Duties & Taxes (GST etc.), Capital Account, Reserves & Surplus, Sales Accounts, Purchase Accounts, Direct/Indirect Expenses. " +
    "Map the user's wording — even if mis-spelled or mis-heard (e.g. 'sundry daughters' means Sundry Debtors) — to the closest of these. Read-only.",
  permission: accAuthorised,
  parameters: {
    type: "object",
    properties: {
      account: {
        type: "string",
        description:
          "The account/party name, OR the account-group name to list (map mis-heard words to the closest real group, e.g. 'sundry daughters' -> 'Sundry Debtors', 'people we owe' -> 'Sundry Creditors').",
      },
    },
    required: ["account"],
  },
  matches: (msg) =>
    /\b(ledger|account balance|balance of|cash balance|bank balance|how much (cash|in the bank)|outstanding|receivable|payable|debtor|creditor|owe|owed|balance)\b/i.test(
      msg,
    ),
  provideContext: async ({ message, args }) => ({
    // Pass the full message as `hint` too, so a wrong `account` param still
    // resolves via the proper-noun words in the question.
    ledger: await buildLedgerLookup({ query: (args && args.account) || message, hint: message }),
  }),
});

registerTool({
  name: "acc_vouchers",
  description:
    "Vouchers / TRANSACTIONS for authorised accounting/CEO: counts and totals by type (sales, purchase, payment, receipt, journal, etc.) and a recent list, optionally filtered by type or date range. Use for 'how many sales', 'recent payments', 'purchases this month'. Read-only.",
  permission: accAuthorised,
  parameters: {
    type: "object",
    properties: {
      voucherType: { type: "string", description: "One of: sales, purchase, payment, receipt, journal, contra, credit_note, debit_note. Omit for all." },
      from: { type: "string", description: "Start date YYYY-MM-DD, if a range is asked." },
      to: { type: "string", description: "End date YYYY-MM-DD, if a range is asked." },
    },
  },
  matches: (msg) =>
    /\b(voucher|vouchers|transactions?|sales|purchases?|invoices?|payments?|receipts?|journal|contra|credit note|debit note|how many (sales|purchases|invoices|payments))\b/i.test(
      msg,
    ),
  provideContext: async ({ args }) => ({
    vouchers: await buildVouchers({
      voucherType: args && args.voucherType,
      from: validDate(args && args.from),
      to: validDate(args && args.to),
    }),
  }),
});

registerTool({
  name: "acc_company",
  description:
    "The company's registration / tax profile for authorised accounting/CEO: legal name, GSTIN, PAN, financial year and base currency. Read-only.",
  permission: accAuthorised,
  parameters: { type: "object", properties: {} },
  matches: (msg) => /\b(gstin|gst number|pan\b|company (name|details|registration)|financial year|which company|legal name)\b/i.test(msg),
  provideContext: async () => ({ company: await buildCompanyInfo() }),
});
