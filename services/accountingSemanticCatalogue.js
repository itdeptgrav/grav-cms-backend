"use strict";

const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");

const ACCOUNTING_CATALOGUE_ID = "accounting";

const FINANCIAL_YEAR = "current_financial_year";

const FINANCIAL_METRICS = Object.freeze([
  {
    id: "financials.summary",
    label: "Financial summary",
    aliases: ["profit and loss", "p&l", "p and l", "financial position", "balance sheet summary"],
    toolMetric: "summary",
    path: "readable",
    valueType: "financial_summary",
  },
  {
    id: "financials.revenue",
    label: "Total revenue",
    aliases: ["revenue", "turnover", "total income"],
    toolMetric: "revenue",
    path: "profitAndLoss.totalRevenue",
    valueType: "money",
  },
  {
    id: "financials.expenses",
    label: "Total expenses",
    aliases: ["expenses", "expense", "total expense"],
    toolMetric: "expenses",
    path: "profitAndLoss.totalExpenses",
    valueType: "money",
  },
  {
    id: "financials.direct_revenue",
    label: "Direct revenue",
    aliases: ["direct income"],
    toolMetric: "direct_revenue",
    path: "profitAndLoss.directRevenue",
    valueType: "money",
  },
  {
    id: "financials.direct_expenses",
    label: "Direct expenses",
    aliases: ["direct expense", "cost of goods sold", "cogs"],
    toolMetric: "direct_expenses",
    path: "profitAndLoss.directExpenses",
    valueType: "money",
  },
  {
    id: "financials.gross_profit",
    label: "Gross profit",
    aliases: [],
    toolMetric: "gross_profit",
    path: "profitAndLoss.grossProfit",
    valueType: "money",
  },
  {
    id: "financials.gross_profit_margin",
    label: "Gross profit margin",
    aliases: ["gross margin"],
    toolMetric: "gross_profit_margin",
    path: "profitAndLoss.grossProfitMargin",
    valueType: "percent",
  },
  {
    id: "financials.net_profit",
    label: "Net profit",
    aliases: ["profit", "net loss", "profit after expenses"],
    toolMetric: "net_profit",
    path: "profitAndLoss.netProfit",
    valueType: "money",
  },
  {
    id: "financials.net_profit_margin",
    label: "Net profit margin",
    aliases: ["net margin"],
    toolMetric: "net_profit_margin",
    path: "profitAndLoss.netProfitMargin",
    valueType: "percent",
  },
  {
    id: "financials.assets",
    label: "Total assets",
    aliases: ["assets"],
    toolMetric: "assets",
    path: "balanceSheet.totalAssets",
    valueType: "money",
  },
  {
    id: "financials.liabilities",
    label: "Total liabilities",
    aliases: ["liabilities"],
    toolMetric: "liabilities",
    path: "balanceSheet.totalLiabilities",
    valueType: "money",
  },
  {
    id: "financials.equity",
    label: "Total equity",
    aliases: ["equity", "net worth"],
    toolMetric: "equity",
    path: "balanceSheet.equity",
    valueType: "money",
  },
].map((definition) => Object.freeze({
  ...definition,
  domain: "financials",
  entity: "company",
  source: "posted_accounting_entries",
  temporal: FINANCIAL_YEAR,
  aliases: Object.freeze(definition.aliases),
})));

const CATALOGUE = compileSemanticCatalogue({
  id: ACCOUNTING_CATALOGUE_ID,
  domains: [
    { id: "financials", label: "financials", aliases: ["profit", "loss", "p&l", "revenue", "income", "expense", "expenses", "assets", "liabilities", "equity", "balance sheet", "gross profit", "net profit"] },
    { id: "ledger", label: "ledger", aliases: ["account balance", "closing balance", "cash balance", "bank balance", "receivable", "receivables", "payable", "payables", "debtor", "creditor", "outstanding", "owe", "owed"] },
    { id: "vouchers", label: "vouchers", aliases: ["voucher", "transaction", "transactions", "sales invoice", "purchase invoice", "payment", "receipt", "journal", "contra", "credit note", "debit note"] },
    { id: "company", label: "company registration", aliases: ["gstin", "gst number", "pan", "legal name", "financial year", "base currency"] },
    { id: "party", label: "party reports", aliases: ["ageing", "aging", "overdue", "customer outstanding", "supplier outstanding", "customer invoices", "supplier bills"] },
    { id: "report", label: "accounting report", aliases: ["total debit", "total credit", "voucher lines", "ledger group", "group by", "ranked ledgers", "gst classification"] },
  ],
  entities: [
    { id: "ledger", label: "ledger", aliases: ["account"] },
    { id: "party", label: "party", aliases: ["customer", "supplier"] },
    { id: "voucher", label: "voucher", aliases: ["transaction"] },
    { id: "company", label: "company", aliases: ["business"] },
  ],
  metrics: FINANCIAL_METRICS,
});

const metric = (id) => CATALOGUE.metrics[id] || null;
const metricFromText = (value) => CATALOGUE.resolveMetric(value);
const metricFromToolValue = (value) => FINANCIAL_METRICS.find((definition) => definition.toolMetric === value) || null;
const metricIds = () => FINANCIAL_METRICS.map((definition) => definition.id);

module.exports = {
  ACCOUNTING_CATALOGUE_ID,
  FINANCIAL_YEAR,
  CATALOGUE,
  metric,
  metricFromText,
  metricFromToolValue,
  metricIds,
};
