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
const { ACCOUNTING_CATALOGUE_ID } = require("../../accountingSemanticCatalogue");
const {
  buildCompanyInfo,
  buildFinancials,
  buildLedgerLookup,
  buildVouchers,
} = require("../../accountingContext");
const { formatAmount, formatEffective } = require("../openJev/ledgerAnswer");

const accAuthorised = (user) => Boolean(user && user.accountingAccess && user.accountingAccess.allowed === true);
const semantic = (domains, subjects = []) => ({ catalogue: ACCOUNTING_CATALOGUE_ID, domains, subjects });

// Month-number map + a spelled/relative date helper reused from the same idea as
// HR; the tool-calling path gets concrete YYYY-MM-DD from the model anyway.
const validDate = (d) => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);

// A verified business entity is stronger evidence than an overlapping domain
// word.  For example, "Salary Payable" is both payroll vocabulary and the
// exact name of an accounting ledger.  Resolve the entity from master data
// before asking the model to choose a domain; claim only one unambiguous named
// ledger, never a fuzzy hit or a multi-ledger group.  This rule therefore works
// for every ledger in the chart of accounts without teaching the router any
// ledger-specific phrase.
async function claimUniqueLedgerBalance({ message } = {}) {
  if (!/\b(balance|outstanding|owe|owed|payable|receivable)\b/i.test(String(message || ""))) return null;
  const ledger = await buildLedgerLookup({ query: message, hint: message });
  if (!ledger?.found || ledger.fuzzy || ledger.totalMatched !== 1) return null;
  if (!ledger.exactNamedMatch && !ledger.uniqueNamedMatch) return null;
  const account = ledger.matches?.[0]?.name;
  return account ? { account } : null;
}

function renderSingleLedgerBalance({ data } = {}) {
  const ledger = data?.ledger;
  if (!ledger || ledger.found !== true) {
    return "I could not find an account with that name in this company's ledgers. Please give me the exact ledger name as it appears in the books.";
  }
  const matches = Array.isArray(ledger.matches) ? ledger.matches : [];
  // Lists and groups keep their existing grounded synthesis path. This renderer
  // owns only the exact one-ledger fact where a second model pass adds risk but
  // no value.
  if (ledger.fuzzy || matches.length !== 1 || ledger.totalMatched !== 1) return null;
  const row = matches[0];
  if (row?.reconciliation?.status === "source_incomplete") {
    return `${row.name}${row.group ? ` (${row.group})` : ""} cannot be reported reliably yet: ` +
      "the posted vouchers contain settlement-side movement but no opening or normal-side posting. " +
      "Please reconcile the missing opening/accrual entries before using this figure.";
  }
  const currency = data?.company?.available === false ? null : data?.company?.baseCurrency;
  const amount = currency ? formatAmount(row?.balance, currency) : null;
  if (!amount) return "I found the ledger, but its balance or currency could not be verified safely.";
  const effectiveAt = formatEffective(new Date(data.readAt), "Asia/Kolkata");
  return `${row.name}${row.group ? ` (${row.group})` : ""}: ${amount} ${row.drCr === "Cr" ? "Cr" : "Dr"}, as at ${effectiveAt}.`;
}

registerTool({
  name: "acc_financials",
  semantic: semantic(["financials"]),
  description:
    "Company FINANCIAL METRICS for authorised accounting/CEO. Returns the exact requested figure: total revenue, total expenses, direct revenue, direct expenses/COGS, gross profit, gross-profit margin, net profit/loss, net-profit margin, assets, liabilities or equity; use the full summary only when explicitly requested. Read-only and calculated from posted accounting entries.",
  permission: accAuthorised,
  parameters: {
    type: "object",
    properties: {
      metric: {
        type: "string",
        enum: [
          "summary", "revenue", "expenses", "direct_revenue", "direct_expenses", "gross_profit",
          "gross_profit_margin", "net_profit", "net_profit_margin", "assets", "liabilities", "equity",
        ],
      },
    },
    required: ["metric"],
    additionalProperties: false,
  },
  matches: (msg) =>
    /\b(profit|loss|p&l|p and l|revenue|turnover|income|expenses?|balance sheet|financials?|net worth|assets|liabilit|how are we doing financially|financial (position|health|summary))\b/i.test(
      msg,
    ),
  provideContext: async ({ args }) => ({ requestedMetric: args && args.metric, financials: await buildFinancials() }),
});

registerTool({
  name: "acc_ledger_balance",
  semantic: semantic(["ledger"], ["ledger"]),
  description:
    "Current closing balance of one ledger/account or a ranked account group. It does NOT answer total debit/credit, turnover or activity, which are sums of posted voucher lines and belong to the general accounting report. It cannot apply a date/financial-year filter or create an arbitrary grouped breakdown, which belongs to the general accounting report. " +
    "The standard account GROUPS are: Sundry Debtors (customers who owe us / receivables), Sundry Creditors (suppliers we owe / payables), Cash-in-Hand, Bank Accounts, " +
    "Current Assets, Fixed Assets, Investments, Loans & Advances, Duties & Taxes (GST etc.), Capital Account, Reserves & Surplus, Sales Accounts, Purchase Accounts, Direct/Indirect Expenses. " +
    "Map the user's wording — even if mis-spelled or mis-heard (e.g. 'sundry daughters' means Sundry Debtors) — to the closest of these. " +
    "This is a current closing-balance lookup; it cannot preserve a date/financial-year filter or an arbitrary group-by breakdown. " +
    "Use the general accounting report for those combined dimensions. Read-only.",
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
  claim: claimUniqueLedgerBalance,
  provideContext: async ({ message, args }) => {
    const readAt = new Date().toISOString();
    const [ledger, company] = await Promise.all([
      // Pass the full message as `hint` too, so a wrong `account` param still
      // resolves via the proper-noun words in the question.
      buildLedgerLookup({ query: (args && args.account) || message, hint: message }),
      buildCompanyInfo(),
    ]);
    return { ledger, company, readAt };
  },
  renderAnswer: renderSingleLedgerBalance,
});

registerTool({
  name: "acc_vouchers",
  semantic: semantic(["vouchers"], ["voucher"]),
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
  semantic: semantic(["company"], ["company"]),
  description:
    "The company's registration / tax profile for authorised accounting/CEO: legal name, GSTIN, PAN, financial year and base currency. Read-only.",
  permission: accAuthorised,
  parameters: { type: "object", properties: {} },
  matches: (msg) => /\b(gstin|gst number|pan\b|company (name|details|registration)|financial year|which company|legal name)\b/i.test(msg),
  provideContext: async () => ({ company: await buildCompanyInfo() }),
});

registerTool({
  name: "acc_party_reports",
  semantic: semantic(["party", "ledger"], ["party"]),
  description:
    "Authoritative read-only CUSTOMER RECEIVABLE and SUPPLIER PAYABLE reports: outstanding balances and invoice/bill ageing, " +
    "including ranked largest/smallest parties, optional party search, and an as-of date. Use for debtors ageing, creditors ageing, " +
    "who owes us, whom we owe, overdue customer invoices, overdue supplier bills, receivables and payables summaries.",
  permission: accAuthorised,
  parameters: {
    type: "object",
    properties: {
      report: {
        type: "string",
        enum: ["customer_outstanding", "customer_ageing", "supplier_outstanding", "supplier_ageing"],
      },
      asOf: { type: ["string", "null"], description: "As-of date YYYY-MM-DD, or null for today." },
      search: { type: ["string", "null"], description: "Optional party-name search." },
      ranking: { type: "string", enum: ["none", "largest", "smallest"] },
      limit: { type: "integer", minimum: 1, maximum: 15 },
    },
    required: ["report", "asOf", "search", "ranking", "limit"],
  },
  matches: (msg) =>
    /\b(receivables?|payables?|outstanding|ageing|aging|overdue|debtors?|creditors?|customers? owe|owe suppliers?|supplier bills?|customer invoices?)\b/i.test(msg),
  provideContext: async ({ args }) => ({
    partyReport: await require("../../accountingContext").buildPartyReport(args || {}),
  }),
});

registerTool({
  name: "acc_report_query",
  semantic: semantic(["report", "financials", "ledger", "vouchers", "party"], ["ledger", "party", "voucher", "company"]),
  description:
    "General read-only accounting report for posted voucher-line turnover/activity and combined dimensions: the only capability that answers total debit/credit and preserves arbitrary grouping plus explicit date or financial-year filters, ranking and calculations over voucher lines. Use when the question combines or " +
    "ranks companies, dates, financial years, voucher numbers/types/narrations, ledger names/groups, parties, debit, credit, " +
    "signed amounts or GST classification, including filtered detail lists and grouped totals. This is the broad semantic " +
    "catalogue for valid accounting questions not better answered by a specialist balance, financial, voucher or ageing tool.",
  permission: accAuthorised,
  parameters: require("../accountingReportQuery").parameters,
  // Relevance for the ordinary non-Jev assistant. The hybrid accounting
  // router receives every authorised tool definition directly and therefore
  // does not depend on phrase matching.
  matches: () => true,
  provideContext: async ({ user, args }) => {
    const result = await require("../accountingReportQuery").runAccountingReport({ user, query: args });
    return { accountingReport: result.ok ? result.reply : null };
  },
});
