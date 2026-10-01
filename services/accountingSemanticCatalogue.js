"use strict";

const { compileSemanticCatalogue } = require("./ai/semanticCatalogue");

const ACCOUNTING_CATALOGUE_ID = "accounting";

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
  metrics: [],
});

module.exports = { ACCOUNTING_CATALOGUE_ID, CATALOGUE };
