"use strict";
/**
 * services/accountingContext.js — the accountant module's data, exposed to the
 * central GRAV assistant as read-only, permission-gated context.
 *
 * Single company/organization in this deployment, so everything is scoped to the
 * one primary company (cached). All amounts are returned as plain integers (INR,
 * no commas) so the grounding guard can verify every figure the model states.
 *
 * Collections are read directly (read-only aggregation) rather than via models,
 * since the Acc_ models live in the accountant subsystem.
 */

const mongoose = require("mongoose");

const col = (name) => mongoose.connection.db.collection(name);
const inr = (n) => Math.round(Number(n) || 0);
const money = (n) => Number((Number(n) || 0).toFixed(2));

// Indian-style words for an amount ("2630726" -> "26.31 lakh") so the model can
// quote the lakh/crore figure directly instead of computing (and mis-computing)
// it. Trailing zeros trimmed.
function lc(n) {
  const v = Math.round(Number(n) || 0);
  const a = Math.abs(v);
  const trim = (x) => String(x).replace(/\.?0+$/, "");
  if (a >= 1e7) return `${trim((v / 1e7).toFixed(2))} crore`;
  if (a >= 1e5) return `${trim((v / 1e5).toFixed(2))} lakh`;
  if (a >= 1e3) return `${trim((v / 1e3).toFixed(2))} thousand`;
  return String(v);
}
// "26,30,726 (26.31 lakh)" — both forms, so either is grounded.
const amt = (n) => `${inr(n)} (${lc(n)})`;

let _company = null;
async function company() {
  if (_company) return _company;
  _company =
    (await col("acc_companies").findOne({ isPrimary: true })) || (await col("acc_companies").findOne({})) || null;
  return _company;
}
async function companyId() {
  const c = await company();
  return c ? c._id : null;
}

// ── Company / GST profile ──────────────────────────────────────────────────────
async function buildCompanyInfo() {
  const c = await company();
  if (!c) return { available: false };
  return {
    name: c.companyName || null,
    gstin: c.gstin || null,
    pan: c.pan || null,
    financialYear: c.currentFinancialYear || c.financialYearStart || null,
    baseCurrency: c.baseCurrency || "INR",
    address: c.address && typeof c.address === "object" ? undefined : c.address || undefined,
  };
}

// ── P&L + Balance Sheet ────────────────────────────────────────────────────────
// Mirrors the accountant module's own /profit-loss report EXACTLY so GRAV's
// numbers match what the user sees on screen: P&L = movement of POSTED vouchers
// within the current financial year, per ledger, grouped by GROUP nature
// (revenue = credit side = -net, expense = debit side = +net). Not the raw
// ledger currentBalance (which is cumulative and gave wrong figures).
async function buildFinancials() {
  const c = await company();
  const cid = c._id;

  // Current financial year window from the company's configured FY start.
  const from = new Date(c.financialYearStart || c.booksFromDate || `${new Date().getUTCFullYear()}-04-01`);
  const to = new Date(from);
  to.setUTCFullYear(to.getUTCFullYear() + 1);
  to.setUTCDate(to.getUTCDate() - 1);
  to.setUTCHours(23, 59, 59, 999);

  const [groups, ledgers, movements] = await Promise.all([
    col("acc_groups").find({ companyId: cid, isActive: true }).toArray().catch(() => []),
    col("acc_ledgers").find({ companyId: cid, isActive: true }).toArray().catch(() => []),
    col("acc_vouchers")
      .aggregate([
        { $match: { companyId: cid, status: "posted", voucherDate: { $gte: from, $lte: to } } },
        { $unwind: "$ledgerEntries" },
        { $group: { _id: "$ledgerEntries.ledgerId", net: { $sum: "$ledgerEntries.signedAmount" } } },
      ])
      .toArray()
      .catch(() => []),
  ]);

  const groupMap = {};
  for (const g of groups) groupMap[g._id.toString()] = g;
  const moveMap = {};
  for (const m of movements) if (m && m._id) moveMap[m._id.toString()] = m.net;

  // Gross-profit classification follows the chart-of-accounts hierarchy, not
  // user wording and not the dashboard's unrelated CRM/purchase-order data.
  // Tally's primary Sales/Direct Income groups are gross-profit revenue;
  // Purchase/Direct Expense groups are COGS/direct cost. Descendants inherit
  // their primary ancestor's classification.
  const rootGroupName = (group) => {
    let current = group;
    const seen = new Set();
    while (current && current.parent) {
      const key = String(current._id || current.name || "");
      if (seen.has(key)) break;
      seen.add(key);
      current = groupMap[String(current.parent)] || current;
      if (seen.has(String(current._id || current.name || ""))) break;
    }
    return String((current && current.name) || (group && group.name) || "").trim();
  };

  let revenue = 0;
  let expenses = 0;
  let directRevenue = 0;
  let directExpenses = 0;
  const bs = { asset: 0, liability: 0, equity: 0 };
  for (const led of ledgers) {
    const grp = led.groupId && groupMap[led.groupId.toString()];
    if (!grp) continue;
    const net = moveMap[led._id.toString()] || 0;
    const root = rootGroupName(grp).toLowerCase();
    if (grp.nature === "revenue") {
      const amount = -net; // credit side gives income
      revenue += amount;
      if (["sales accounts", "direct incomes", "closing stock"].includes(root)) directRevenue += amount;
    } else if (grp.nature === "expense") {
      const amount = net; // debit side gives expense
      expenses += amount;
      if (["purchase accounts", "direct expenses", "opening stock"].includes(root)) directExpenses += amount;
    }
    // Balance sheet uses closing (current) balances by nature.
    if (grp.nature === "asset") bs.asset += led.currentBalance || 0;
    else if (grp.nature === "liability") bs.liability += led.currentBalance || 0;
    else if (grp.nature === "equity") bs.equity += led.currentBalance || 0;
  }

  revenue = money(revenue);
  expenses = money(expenses);
  directRevenue = money(directRevenue);
  directExpenses = money(directExpenses);
  const grossProfit = money(directRevenue - directExpenses);
  const netProfit = money(revenue - expenses);
  const percentage = (numerator, denominator) =>
    denominator === 0 ? 0 : Number(((numerator / denominator) * 100).toFixed(2));
  const grossProfitMargin = percentage(grossProfit, directRevenue);
  const netProfitMargin = percentage(netProfit, revenue);
  const assets = money(Math.abs(bs.asset));
  const liabilities = money(Math.abs(bs.liability));
  const equity = money(Math.abs(bs.equity));
  const fy = c.currentFinancialYear || `${from.getUTCFullYear()}-${String((from.getUTCFullYear() + 1) % 100).padStart(2, "0")}`;

  return {
    baseCurrency: c.baseCurrency || "INR",
    financialYear: fy,
    period: `${from.toISOString().slice(0, 10)} to ${to.toISOString().slice(0, 10)}`,
    profitAndLoss: {
      totalRevenue: revenue,
      totalExpenses: expenses,
      directRevenue,
      directExpenses,
      grossProfit,
      grossProfitMargin,
      netProfit,
      netProfitMargin,
      result: netProfit >= 0 ? "profit" : "loss",
    },
    balanceSheet: { totalAssets: assets, totalLiabilities: liabilities, equity },
    readable:
      `Profit & Loss for FY ${fy} (INR): total revenue ${amt(revenue)}, total expenses ${amt(expenses)}, ` +
      `net ${netProfit >= 0 ? "profit" : "loss"} ${amt(Math.abs(netProfit))}. ` +
      `Balance sheet (closing): total assets ${amt(assets)}, total liabilities ${amt(liabilities)}, equity ${amt(equity)}.`,
  };
}

// ── One ledger / account balance, OR a group's accounts ("top 5 Sundry Debtors") ─
const LEDGER_STOP = /\b(what|whats|what's|is|are|was|the|balance|balances|bal|blnc|blnce|balnc|balnce|cb|closing|leisure|leasure|ledger|ledgers|of|for|show|me|tell|about|account|accounts|current|how much|in|do we have|owe|owed|to|from|please|give|get|amount|due|top|five|ten|highest|lowest|biggest|largest|list)\b/gi;
// Fix common speech mishearings only (not synonyms).
const fixMishears = (s) => String(s || "").replace(/\bdaughters?\b/gi, "debtors").replace(/\bdet(er|or)s?\b/gi, "debtors");
// Detect an ACCOUNT-GROUP intent and return the exact group name (so "sundry
// debtors" / "receivables" / "who owes us" -> the Sundry Debtors group, etc.).
const GROUP_INTENT = [
  [/\b(sundry\s+)?debtors?\b|\breceivables?\b|\bcustomers?\b|owes? us/i, "Sundry Debtors"],
  [/\b(sundry\s+)?creditors?\b|\bpayables?\b|\bsuppliers?\b|\bvendors?\b|we owe/i, "Sundry Creditors"],
  [/\bcash(\s*in\s*hand)?\b/i, "Cash-in-Hand"],
  [/\bbank\s*(accounts?)?\b/i, "Bank Accounts"],
];
function groupIntent(text) {
  const s = fixMishears(text);
  for (const [rx, group] of GROUP_INTENT) if (rx.test(s)) return group;
  return null;
}
const cleanLedger = (s) =>
  fixMishears(s)
    // Standard accounting shorthand: CB / C.B. / C-B = closing balance.
    // It describes the requested figure and is never part of the ledger name.
    .replace(/\bc\s*[./-]?\s*b(?:\.(?=\s|$))?/gi, " cb ")
    .replace(LEDGER_STOP, " ")
    .replace(/[^a-zA-Z0-9&.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// A comparison form used only to decide whether a database result is the exact
// ledger the user named. Punctuation and case are presentation details here;
// token order and every word still have to match.
const normalizeLedgerName = (s) =>
  String(s || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function preferExactLedgerName(term, matches) {
  const wanted = normalizeLedgerName(term);
  if (!wanted || !Array.isArray(matches)) return matches || [];
  const exact = matches.filter((match) => normalizeLedgerName(match && match.name) === wanted);
  return exact.length ? exact : matches;
}

// Levenshtein distance + a 0..1 token similarity, mirroring hrEmployeeContext so
// a mis-heard/mis-typed party name still resolves ("Davidat Mangeeral" ->
// "Debidutt Mangilall"). Whisper mangles unusual Indian names, so the ledger
// lookup needs a fuzzy safety net, not just substring matching.
function editDistance(a, b) {
  a = String(a || "");
  b = String(b || "");
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function tokSim(a, b) {
  a = String(a || "").toLowerCase();
  b = String(b || "").toLowerCase();
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (b.startsWith(a) || a.startsWith(b)) return 0.9;
  return 1 - editDistance(a, b) / Math.max(a.length, b.length);
}
// Score how well a (possibly garbled) query name matches a real ledger name.
// EVERY query token must find a decent match in the ledger name (we take the
// weakest token match), so a single coincidental word can't produce a false hit.
function nameScore(query, name) {
  const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const q = norm(query);
  const nm = norm(name);
  if (!q || !nm) return 0;
  const whole = tokSim(q.replace(/ /g, ""), nm.replace(/ /g, ""));
  const qt = q.split(" ").filter((t) => t.length >= 2);
  const nt = nm.split(" ").filter((t) => t.length >= 2);
  if (!qt.length || !nt.length) return whole;
  let minTok = 1;
  for (const t of qt) {
    let best = 0;
    for (const u of nt) best = Math.max(best, tokSim(t, u));
    minTok = Math.min(minTok, best);
  }
  // Weight the all-tokens-must-match signal heavily; whole-string is a tiebreak.
  return 0.75 * minTok + 0.25 * whole;
}

// Single capitalised words that are query/command noise, never a party name.
// Used to stop sentence-initial words ("Top 5…", "Show me…") from being read as
// a proper-noun ledger to search for.
const CAPS_STOPWORDS = new Set([
  "top", "show", "list", "give", "tell", "find", "get", "fetch", "display",
  "what", "which", "who", "whose", "how", "the", "me", "my", "our", "all",
  "most", "highest", "lowest", "largest", "biggest", "smallest", "total",
  "ledger", "ledgers", "ledges", "account", "accounts", "balance", "balances",
  "debit", "credit", "group", "groups", "please", "hey", "grav",
]);

// Real ledger balances, computed the way the accountant module's reports do:
// closing = openingBalance + Σ signedAmount over POSTED vouchers (positive = Dr,
// negative = Cr), or the trial-balance figure when the ledger is TB-flagged. The
// stored `currentBalance` field is unmaintained and disagrees with the ledger
// report, so it is never used as the calculation source. A disagreement is a
// cache diagnostic, not grounds to suppress a complete posted-voucher result.
// We fail closed only when the traceable source itself is structurally
// incomplete: a zero-opening ledger has settlement-side movement but no
// normal-side posting (for example a liability with payments but no accrual).
// Returns Map<idString, {abs, drCr, signed, reconciliation}>.
async function computeLedgerBalances(cid, ledgers) {
  const scopedCompanyId = typeof cid === "string" && mongoose.Types.ObjectId.isValid(cid)
    ? new mongoose.Types.ObjectId(cid)
    : cid;
  const ids = ledgers.map((l) => l._id).filter(Boolean);
  const moveMap = {};
  if (ids.length) {
    const agg = await col("acc_vouchers")
      .aggregate([
        { $match: { companyId: scopedCompanyId, status: "posted" } },
        { $unwind: "$ledgerEntries" },
        { $match: { "ledgerEntries.ledgerId": { $in: ids } } },
        {
          $group: {
            _id: "$ledgerEntries.ledgerId",
            net: { $sum: "$ledgerEntries.signedAmount" },
            debit: {
              $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Dr"] }, "$ledgerEntries.amount", 0] },
            },
            credit: {
              $sum: { $cond: [{ $eq: ["$ledgerEntries.type", "Cr"] }, "$ledgerEntries.amount", 0] },
            },
            count: { $sum: 1 },
          },
        },
      ])
      .toArray()
      .catch(() => []);
    for (const m of agg) if (m && m._id) moveMap[String(m._id)] = {
      net: Number(m.net) || 0,
      debit: Number(m.debit) || 0,
      credit: Number(m.credit) || 0,
      count: Number(m.count) || 0,
    };
  }
  const out = new Map();
  for (const led of ledgers) {
    const movement = moveMap[String(led._id)] || { net: 0, debit: 0, credit: 0, count: 0 };
    const opening = Number(led.openingBalance) || 0;
    const signed =
      led.balanceFromTrialBalance === true
        ? opening
        : opening + movement.net;
    const storedRaw = Number(led.currentBalance);
    const storedSigned = Number.isFinite(storedRaw)
      ? (storedRaw < 0 || led.currentBalanceType !== "Cr" ? storedRaw : -storedRaw)
      : null;
    const difference = storedSigned === null ? null : signed - storedSigned;
    const nature = String(led.nature || "").toLowerCase();
    const normalCredit = ["liability", "equity", "income", "revenue"].includes(nature);
    const normalDebit = ["asset", "expense"].includes(nature);
    const sourceIncomplete = led.balanceFromTrialBalance !== true
      && Math.abs(opening) <= 0.5
      && movement.count > 0
      && ((normalCredit && movement.credit <= 0.5 && movement.debit > 0.5)
        || (normalDebit && movement.debit <= 0.5 && movement.credit > 0.5));
    const reconciliation = sourceIncomplete
      ? {
          status: "source_incomplete",
          storedSigned,
          calculatedSigned: signed,
          difference,
          reason: normalCredit ? "missing_normal_credit" : "missing_normal_debit",
        }
      : storedSigned === null
        ? { status: "unavailable", storedSigned: null, calculatedSigned: signed, difference: null }
        : Math.abs(difference) <= 0.5
          ? { status: "reconciled", storedSigned, calculatedSigned: signed, difference }
          : { status: "cache_stale", storedSigned, calculatedSigned: signed, difference };
    out.set(String(led._id), {
      abs: Math.abs(signed),
      drCr: signed >= 0 ? "Dr" : "Cr",
      signed,
      reconciliation,
    });
  }
  return out;
}

async function buildLedgerLookup({ query, hint } = {}) {
  const cid = await companyId();
  const project = {
    name: 1,
    groupName: 1,
    nature: 1,
    openingBalance: 1,
    balanceFromTrialBalance: 1,
    currentBalance: 1,
    currentBalanceType: 1,
  };

  // Build candidate search phrases, most specific first. A NAMED party/account
  // wins over a group so "Mayfair Lagoon owes us" resolves the party, not every
  // debtor; a group-synonym ("receivables", "who owes us") is the fallback.
  const terms = [];
  const push = (t) => {
    const v = (t || "").trim();
    if (v.length >= 2 && !terms.some((x) => x.toLowerCase() === v.toLowerCase())) terms.push(v);
  };
  if (hint) {
    const caps = (String(fixMishears(hint)).match(/\b[A-Z][A-Za-z0-9&.-]{2,}(?:\s+[A-Z][A-Za-z0-9&.-]{2,})*\b/g) || [])
      // Drop single capitalised words that are just query/command noise (a
      // sentence-initial "Top", "Show", "What"...) — otherwise "Top 5 ledgers…"
      // makes "Top" a party name and matches "Top Light Fabrics" / "LAPtop A/c",
      // hijacking the search before the real group/party term is tried. Multi-word
      // candidates are kept (a real party could legitimately start with one).
      .filter((c) => c.includes(" ") || !CAPS_STOPWORDS.has(c.toLowerCase()))
      .sort((a, b) => b.length - a.length);
    for (const c of caps) push(c);
  }
  push(cleanLedger(query));
  if (hint) push(cleanLedger(hint));
  // Group-synonym fallback (exact group name -> all its member ledgers).
  const grp = groupIntent(`${query || ""} ${hint || ""}`);
  if (grp) push(grp);

  // Fetch a generous set (there can be dozens of same-named parties / a group of
  // 50 debtors) so ranking like "top 5 by balance" is over ALL matches.
  const LIMIT = 80;
  // Match on ledger NAME or its GROUP name — so "Sundry Debtors" returns every
  // customer in that group, and a party name still matches directly.
  // Exclude inactive/merged shells — they carry a 0 balance and only add noise
  // ("[MERGED] Debidutt Mangilal" next to the real "Debidutt Mangilall").
  const activeOnly = { companyId: cid, isActive: { $ne: false }, name: { $not: /^\s*\[merged/i } };
  const search = (rx) =>
    col("acc_ledgers")
      .find({ ...activeOnly, $or: [{ name: rx }, { groupName: rx }] })
      .project(project)
      .limit(LIMIT)
      .toArray()
      .catch(() => []);
  let matches = [];
  let exactNamedMatch = false;
  let uniqueNamedMatch = false;
  for (const term of terms) {
    const toks = term.split(" ").filter((t) => t.length >= 2);
    if (!toks.length) continue;
    // All meaningful tokens must occur, in order. The former any-token (`|`)
    // fallback turned a failed phrase such as "blnce mayfair lagoon" into a
    // search for every Mayfair ledger. If this strict lookup misses, the fuzzy
    // resolver below scores complete names and asks the user before answering.
    matches = await search(new RegExp(toks.map(escapeRegExp).join(".*"), "i"));
    const isGroupTerm = grp && normalizeLedgerName(term) === normalizeLedgerName(grp);
    if (matches.length && !isGroupTerm) {
      matches = preferExactLedgerName(term, matches);
      uniqueNamedMatch = matches.length === 1;
      exactNamedMatch = matches.length === 1
        && normalizeLedgerName(term) === normalizeLedgerName(matches[0].name);
    }
    if (matches.length) break;
  }
  // Fuzzy fallback: no exact/substring hit, so the name was likely mis-heard or
  // mis-typed ("Davidat Mangeeral"). Score every ledger by name similarity and
  // keep the closest — this is what rescues garbled party names.
  let fuzzy = false;
  if (!matches.length) {
    const nameQuery = cleanLedger(query) || cleanLedger(hint) || terms[0] || "";
    if (nameQuery && nameQuery.replace(/[^a-z0-9]/gi, "").length >= 4) {
      const all = await col("acc_ledgers")
        .find(activeOnly)
        .project(project)
        .limit(3000)
        .toArray()
        .catch(() => []);
      const scored = all
        .map((m) => ({ m, s: nameScore(nameQuery, m.name) }))
        .filter((x) => x.s >= 0.5)
        .sort((a, b) => b.s - a.s)
        .slice(0, 5);
      if (scored.length) {
        matches = scored.map((x) => x.m);
        fuzzy = true;
      }
    }
  }

  if (!matches.length)
    return { found: false, query: (terms[0] || String(query || "")).slice(0, 60), note: "No matching ledger/account or group was found." };

  const totalMatched = matches.length;
  // Compute REAL balances from posted vouchers (the stored currentBalance is
  // stale and disagrees with the ledger report).
  const balMap = await computeLedgerBalances(cid, matches);
  const bal = (m) => balMap.get(String(m._id)) || { abs: 0, drCr: "Dr" };
  const mapItem = (m) => {
    const b = bal(m);
    return {
      name: m.name,
      group: m.groupName,
      nature: m.nature,
      balance: inr(b.abs),
      drCr: b.drCr,
      reconciliation: b.reconciliation,
    };
  };
  // Fuzzy hits keep their similarity order (closest name first — the party the
  // user meant). Exact/group hits sort by balance magnitude, so "top N by
  // balance" is correct and the biggest account leads a single lookup.
  const items = fuzzy
    ? matches.map(mapItem).slice(0, 5)
    : matches.map(mapItem).sort((a, b) => b.balance - a.balance).slice(0, 20);

  // Combined total over ALL matched accounts (not just the shown 20), so
  // "total X" is a real, grounding-verifiable number.
  const combinedTotal = inr(matches.reduce((s, m) => s + bal(m).abs, 0));
  // Lead: for a fuzzy hit, name the ACTUAL matched ledger as the subject and
  // instruct the model to use that exact name (not the user's garbled spelling).
  // Amounts are stated in Indian words only (lc, e.g. "11.66 lakh") — no raw
  // integer, so text-to-speech doesn't read it as "one million…".
  const lead = fuzzy
    ? `Closest matching ledger (use this EXACT name in your answer, best match first)`
    : "Ledger balances, highest first";
  const readable =
    `${lead} — ${items.map((i) => `${i.name} (${i.group}): ${lc(i.balance)} ${i.drCr}`).join("; ")}.` +
    (!fuzzy && totalMatched > 1 ? ` (${totalMatched} matching accounts; combined total ${lc(combinedTotal)}.)` : "");
  return {
    found: true,
    matches: items,
    totalMatched,
    combinedTotal,
    fuzzy,
    exactNamedMatch,
    uniqueNamedMatch,
    readable,
  };
}

// All-ledger ranking for an explicitly requested debit/credit balance side.
// This is separate from name/group lookup so an ordinary vague name can never
// accidentally expand into the whole chart of accounts.
async function buildLedgerRanking({ balanceSide, ranking = "largest", limit = 5 } = {}) {
  const side = String(balanceSide || "").toLowerCase();
  if (!["dr", "cr"].includes(side)) return { found: false, note: "A debit or credit balance side is required." };
  const cid = await companyId();
  const ledgers = await col("acc_ledgers")
    .find({ companyId: cid, isActive: { $ne: false }, name: { $not: /^\s*\[merged/i } })
    .project({
      name: 1,
      groupName: 1,
      nature: 1,
      openingBalance: 1,
      balanceFromTrialBalance: 1,
      currentBalance: 1,
      currentBalanceType: 1,
    })
    .limit(5000)
    .toArray()
    .catch(() => []);
  const balances = await computeLedgerBalances(cid, ledgers);
  const rows = ledgers
    .map((ledger) => {
      const balance = balances.get(String(ledger._id)) || { abs: 0, drCr: "Dr" };
      return {
        name: ledger.name,
        group: ledger.groupName,
        nature: ledger.nature,
        balance: inr(balance.abs),
        drCr: balance.drCr,
        reconciliation: balance.reconciliation,
      };
    })
    .filter((row) => row.drCr.toLowerCase() === side)
    .sort((a, b) => ranking === "smallest" ? a.balance - b.balance : b.balance - a.balance);
  const safeLimit = Math.max(1, Math.min(15, Number(limit) || 5));
  return {
    found: rows.length > 0,
    fuzzy: false,
    matches: rows.slice(0, safeLimit),
    totalMatched: rows.length,
    balanceSide: side,
  };
}

// ── Vouchers / transactions summary and recent list ────────────────────────────
const VOUCHER_ALIASES = {
  sales: ["sales", "sale", "invoice", "invoices"],
  purchase: ["purchase", "purchases", "bill", "bills"],
  payment: ["payment", "payments", "paid"],
  receipt: ["receipt", "receipts", "received"],
  journal: ["journal"],
  contra: ["contra"],
  credit_note: ["credit note", "credit_note", "credit-note"],
  debit_note: ["debit note", "debit_note", "debit-note"],
};
function normVoucherType(t) {
  const s = String(t || "").toLowerCase();
  for (const [canon, aliases] of Object.entries(VOUCHER_ALIASES)) {
    if (aliases.some((a) => s.includes(a))) return canon;
  }
  return null;
}

async function buildVouchers({ voucherType, partyName, from, to } = {}) {
  const cid = await companyId();
  const match = { companyId: cid };
  const canon = normVoucherType(voucherType);
  if (canon) match.voucherTypeName = new RegExp(`^${canon}$`, "i");
  if (partyName) {
    // `partyName` is resolved against this company's ledgers before it reaches
    // here. Match the complete recorded ledger name; never let model text
    // become an open-ended database expression.
    match["ledgerEntries.ledgerName"] = new RegExp(`^${escapeRegExp(String(partyName).trim())}$`, "i");
  }
  if (from || to) {
    match.voucherDate = {};
    if (from) match.voucherDate.$gte = new Date(from);
    if (to) match.voucherDate.$lte = new Date(`${to}T23:59:59.999Z`);
  }

  const project = { voucherTypeName: 1, voucherNumber: 1, voucherDate: 1, grandTotal: 1, ledgerEntries: 1 };
  const [byType, recentDocs, largestDocs] = await Promise.all([
    col("acc_vouchers")
      .aggregate([{ $match: match }, { $group: { _id: "$voucherTypeName", count: { $sum: 1 }, total: { $sum: "$grandTotal" } } }, { $sort: { count: -1 } }])
      .toArray()
      .catch(() => []),
    // Most RECENT (for "recent/latest sales/payments").
    col("acc_vouchers").find(match).project(project).sort({ voucherDate: -1 }).limit(15).toArray().catch(() => []),
    // LARGEST by amount (for "biggest sale", "top invoices", "highest payment") —
    // ranked over ALL matches, not just the recent ones.
    col("acc_vouchers").find(match).project(project).sort({ grandTotal: -1 }).limit(15).toArray().catch(() => []),
  ]);

  const row = (v) => ({
    type: v.voucherTypeName || "unknown",
    number: v.voucherNumber,
    date: v.voucherDate ? new Date(v.voucherDate).toISOString().slice(0, 10) : null,
    amount: inr(v.grandTotal),
    party: (v.ledgerEntries && v.ledgerEntries[0] && v.ledgerEntries[0].ledgerName) || null,
  });
  const summary = byType.filter((r) => r._id).map((r) => ({ type: r._id, count: r.count, total: inr(r.total) }));
  const recent = recentDocs.map(row);
  const largest = largestDocs.map(row);
  const summaryText =
    (summary.length
      ? "Voucher totals (INR): " + summary.map((s) => `${s.type} — ${s.count} vouchers, total ${amt(s.total)}`).join("; ") + "."
      : "No vouchers found for that filter.") +
    (largest.length ? ` Largest by amount: ${largest.slice(0, 5).map((v) => `${v.type} ${v.number} ${amt(v.amount)} (${v.party || "-"})`).join("; ")}.` : "");
  return { filterType: canon || "all", filterParty: partyName || null, summary, recent, largest, readable: summaryText };
}

const PARTY_REPORTS = Object.freeze({
  customer_outstanding: ["./customerOutstanding.service", "customerOutstandingReport"],
  customer_ageing: ["./customerAgeing.service", "customerAgeingReport"],
  supplier_outstanding: ["./supplierOutstanding.service", "supplierOutstandingReport"],
  supplier_ageing: ["./supplierAgeing.service", "supplierAgeingReport"],
});

async function buildPartyReport({ report, asOf = null, search = null } = {}) {
  const selected = PARTY_REPORTS[report];
  if (!selected) return { available: false, reason: "unknown_party_report" };
  const cid = await companyId();
  if (!cid) return { available: false, reason: "company_unavailable" };
  const [modulePath, fnName] = selected;
  const service = require(modulePath);
  const result = await service[fnName]({
    companyId: cid,
    scope: "all",
    asOf: asOf ? new Date(`${asOf}T23:59:59.999Z`) : null,
    search: search || "",
    balanceSide: "both",
    minOutstanding: 0,
    ledgerIds: [],
    restrictToIds: false,
  });
  return result || { available: false, reason: "report_unavailable" };
}

module.exports = {
  buildCompanyInfo,
  buildFinancials,
  buildLedgerLookup,
  buildLedgerRanking,
  buildVouchers,
  buildPartyReport,
  // Exported for the Open-Jev Accounts pilot, which must resolve a voucher type
  // from the user's words the SAME way this module does. Sharing the table is
  // the point: a second alias list in the pilot would drift from this one, and
  // the two would disagree about what "invoice" means.
  normVoucherType,
  VOUCHER_ALIASES,
  // Pure resolver helpers are exported so regression tests can prove that
  // spelling variants are cleaned generically and exact names always win.
  cleanLedger,
  preferExactLedgerName,
  computeLedgerBalances,
};
