"use strict";
/**
 * scripts/open-jev-pilot/accounts-fixtures.js — the invented ledgers the
 * Accounts evaluation runs against.
 *
 * Every name and figure here is made up. Nothing is read from a database and
 * nothing real may be added: these fixtures are committed, and the numbers
 * derived from them are shared outside the team.
 *
 * The resolver stub reproduces the SHAPES the real `buildLedgerLookup` returns
 * — exact hit, several hits, fuzzy hits, nothing — because those shapes are
 * what the pilot's clarify-versus-answer decision turns on. It is not a
 * reimplementation of the resolver and is not used to judge the resolver.
 */

const LEDGERS = [
  { name: "Ariel Fabrics", group: "Sundry Debtors", balance: 1284300.5, drCr: "Dr" },
  { name: "Ariel Fabrications", group: "Sundry Debtors", balance: 91250, drCr: "Dr" },
  { name: "Bramble Supplies", group: "Sundry Creditors", balance: 640775.25, drCr: "Cr" },
  { name: "Petty Cash Unit 2", group: "Cash-in-Hand", balance: 0, drCr: "Cr" },
  { name: "Current Account", group: "Bank Accounts", balance: 2210430, drCr: "Dr" },
  // A second bank ledger, so "Bank Accounts" is a GROUP of more than one. With
  // a single member the group case is indistinguishable from a named ledger and
  // the clarify-versus-answer decision has nothing to decide.
  { name: "Savings Account", group: "Bank Accounts", balance: 385000, drCr: "Dr" },
  { name: "Harrow Textiles", group: "Sundry Debtors", balance: 45800, drCr: "Dr" },
];

const GROUPS = ["Sundry Debtors", "Sundry Creditors", "Cash-in-Hand", "Bank Accounts"];

const COMPANY = {
  available: true,
  name: "Northwind Example Pvt Ltd",
  gstin: null,
  pan: null,
  financialYear: "2026-27",
  baseCurrency: "INR",
};

const FINANCIALS = {
  available: true,
  readable:
    "Profit & loss for 2026-27: revenue 48.2 lakh, expenses 39.6 lakh, net profit 8.6 lakh. " +
    "Balance sheet: assets 1.12 crore, liabilities 64.4 lakh, equity 47.6 lakh.",
};

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();

/** Crude token similarity, only good enough to decide "this was a near miss". */
function similar(a, b) {
  const x = norm(a).replace(/ /g, "");
  const y = norm(b).replace(/ /g, "");
  if (!x || !y) return 0;
  let hits = 0;
  for (const ch of new Set(x)) if (y.includes(ch)) hits += 1;
  const lenRatio = Math.min(x.length, y.length) / Math.max(x.length, y.length);
  return (hits / new Set(x).size) * lenRatio;
}

const tokens = (s) => norm(s).split(" ").filter((t) => t.length >= 4);

/**
 * Stands in for `buildLedgerLookup`, returning its shapes.
 *
 * The distinction that matters to the pilot is exact-versus-fuzzy, so that is
 * what this reproduces: a query token that hits a ledger's token exactly is an
 * exact match; one that only nearly hits it makes the whole result fuzzy, which
 * is the case the pilot must ask about rather than answer from.
 *
 * @returns {Promise<object>}
 */
async function lookupLedger({ query, hint }) {
  const text = norm(`${query || ""} ${hint || ""}`);
  const qTokens = tokens(text);

  const full = LEDGERS.filter((l) => text.includes(norm(l.name)));
  if (full.length) {
    return { found: true, fuzzy: false, totalMatched: full.length, matches: full };
  }

  // Token hits: exact on at least one token, and whether any token was only a
  // near miss (a misspelling) rather than an exact hit.
  let sawNearMiss = false;
  const hits = LEDGERS.filter((l) => {
    const lTokens = tokens(l.name);
    let exact = false;
    for (const q of qTokens) {
      if (lTokens.includes(q)) { exact = true; continue; }
      if (lTokens.some((t) => similar(q, t) >= 0.7)) sawNearMiss = true;
    }
    return exact;
  });
  if (hits.length) {
    return { found: true, fuzzy: sawNearMiss, totalMatched: hits.length, matches: hits };
  }

  // A group name, or a phrase meaning one, resolves to every member.
  const group = GROUPS.find((g) => text.includes(norm(g)))
    || (/debtor|receivable|owes us/.test(text) ? "Sundry Debtors" : null)
    || (/creditor|payable|we owe|dena hai/.test(text) ? "Sundry Creditors" : null)
    || (/\bbank\b|current account|paisa bacha/.test(text) ? "Bank Accounts" : null)
    || (/\bcash\b/.test(text) ? "Cash-in-Hand" : null);
  if (group) {
    const members = LEDGERS.filter((l) => l.group === group);
    if (members.length) {
      return { found: true, fuzzy: false, totalMatched: members.length, matches: members };
    }
  }

  // Whole-name near miss, with no token landing at all.
  const scored = LEDGERS.map((l) => ({ l, s: similar(text, l.name) }))
    .filter((x) => x.s >= 0.55)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  if (scored.length) {
    return { found: true, fuzzy: true, totalMatched: scored.length, matches: scored.map((x) => x.l) };
  }

  return { found: false, query: String(query || "").slice(0, 60) };
}

/**
 * Stands in for `buildVouchers`, returning its shape.
 *
 * Invented vouchers, invented parties. It honours the type filter through the
 * accounting module's OWN `normVoucherType`, so the fixture cannot disagree
 * with the service about what "invoice" means, and it honours an explicit
 * date range so the range-passing path is genuinely exercised.
 */
const VOUCHERS = [
  { type: "Sales", number: "S-1001", date: "2026-04-12", amount: 184000, party: "Ariel Fabrics" },
  { type: "Sales", number: "S-1002", date: "2026-05-11", amount: 210500, party: "Harrow Textiles" },
  { type: "Sales", number: "S-1003", date: "2026-06-28", amount: 96750, party: "Ariel Fabrics" },
  { type: "Purchase", number: "P-2001", date: "2026-04-20", amount: 143200, party: "Bramble Supplies" },
  { type: "Purchase", number: "P-2002", date: "2026-07-03", amount: 88400, party: "Bramble Supplies" },
  { type: "Payment", number: "PY-3001", date: "2026-05-02", amount: 120000, party: "Bramble Supplies" },
  { type: "Payment", number: "PY-3002", date: "2026-08-14", amount: 64500, party: "Bramble Supplies" },
  { type: "Receipt", number: "R-4001", date: "2026-06-09", amount: 175000, party: "Ariel Fabrics" },
];

async function buildVouchers({ voucherType, from, to } = {}) {
  const { normVoucherType } = require("../../services/accountingContext");
  const canon = normVoucherType(voucherType);

  let rows = VOUCHERS;
  if (canon) rows = rows.filter((v) => v.type.toLowerCase() === canon.replace(/_/g, " "));
  if (from) rows = rows.filter((v) => v.date >= from);
  if (to) rows = rows.filter((v) => v.date <= to);

  const byType = new Map();
  for (const v of rows) {
    const row = byType.get(v.type) || { type: v.type, count: 0, total: 0 };
    row.count += 1;
    row.total += v.amount;
    byType.set(v.type, row);
  }

  return {
    filterType: canon || "all",
    summary: [...byType.values()].sort((a, b) => b.count - a.count),
    recent: [...rows].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 15),
    largest: [...rows].sort((a, b) => b.amount - a.amount).slice(0, 15),
    readable: "…",
  };
}

const companyProfile = async () => ({ ...COMPANY });
const financials = async () => ({ ...FINANCIALS });

module.exports = {
  LEDGERS, GROUPS, COMPANY, FINANCIALS, VOUCHERS,
  lookupLedger, companyProfile, financials, buildVouchers,
};
