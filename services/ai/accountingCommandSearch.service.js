"use strict";
/**
 * services/ai/accountingCommandSearch.service.js — Cmd/Ctrl K for the books,
 * answered without a model.
 *
 * Same contract as Store's palette (`{ state, note, groups }`, the same result
 * kinds, the same cards), so the shared palette renders both identically.
 * What it answers, for the ONE company the accounting middleware has already
 * checked against the person's organisation:
 *
 *   a record by what you'd type    "INV/0012", "Gaurav Enterprises", a GSTIN,
 *                                  an HSN code, a group, a proforma number
 *   a balance                      "balance of Gaurav Enterprises"
 *   a stock figure                 "stock of cotton fabric"
 *   vouchers, filtered             "draft sales vouchers", "payments last month",
 *                                  "receipts from Gaurav in June 2026"
 *   how many / total / latest      "how many journal vouchers this month",
 *                                  "total sales this FY", "latest five receipts"
 *   lists of masters               "customers", "suppliers", "stock items", "groups"
 *
 * ── THE RULES IT KEEPS ────────────────────────────────────────────────────
 *   · Every query carries `companyId`. There is no code path without it.
 *   · A word the person typed is never dropped. "receipts from Nobody" names a
 *     party; if no ledger is called that, the answer is "nothing matches",
 *     never every receipt.
 *   · Totals are of POSTED vouchers unless the question names a status, and
 *     the sentence says so — a draft is not money that moved.
 *   · A balance is `computeLedgerBalances` — the same calculation the ledger
 *     page uses — and one it cannot vouch for says "needs reconciliation".
 *
 * No model, no assistant tool, no `accountingContext.company()` (which reads
 * the primary company, not the selected one).
 */

const mongoose = require("mongoose");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");
const { Acc_Ledger, Acc_StockItem, Acc_Group } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_ProformaInvoice } = require("../../models/Accountant_model/Acc_ProformaInvoice");
const { computeLedgerBalances } = require("../accountingContext");
const { partyGroupIds } = require("../partyOutstanding.service");
const { compileIntent } = require("./storeCommandIntent");
const {
  text, exactRx, containsRx, plural, longestName, strip, periodFrom, dayStart, dayEnd,
} = require("./commandSearch/words");
const { sanitizeAssistantLinks } = require("./assistantLinks");
const cards = require("./commandSearch/cards");
const C = require("./accountingCommandContract");
const { closestMatches, approximateNote } = require("./commandSearch/closest");

const { money, date, number, words } = cards.FORMAT;
const MAX_QUERY = 200;
const MAX_ROWS = 12;
const DEFAULT_LIST = 10;

const RESULT_KIND = Object.freeze({ RECORD: "record", FACT: "fact" });
const oid = (v) => (mongoose.Types.ObjectId.isValid(String(v)) ? new mongoose.Types.ObjectId(String(v)) : null);

/* ── READING THE WORDS ─────────────────────────────────────────────────── */

const OPERATIONS = Object.freeze({
  count: /\b(how many|number of|count of|count|tally of)\b/i,
  total: /\b(total|sum of|sum|value of all)\b/i,
  latest: /\b(latest|newest|most recent|recent|last \d+|last (?:one|two|three|four|five|six|seven|eight|nine|ten))\b/i,
  balance: /\b(closing balance|balance|outstanding|owes?|dues?)\b/i,
  stock: /\b(stock|quantity|qty|in hand|on hand)\b/i,
});
const FILLER = /\b(show|list|find|open|give|get|me|all|the|any|our|my|what|which|whose|is|are|was|were|there|do|we|have|of|for|from|by|with|to|in|on|dated|at|please|current|vouchers?|records?|named|called)\b/gi;

/**
 * What the question asks, in the books' own terms.
 *
 * Returns the family (voucher type, voucher, ledger, party, group, stock item,
 * proforma), the status, the window, the operation and — the part that must
 * never be dropped — whatever words are left over, which name a record or a
 * party.
 */
function parse(query, now) {
  const raw = text(query, MAX_QUERY);
  const lower = raw.toLowerCase();
  const grammar = compileIntent(raw);

  const voucherType = longestName(lower, C.VOUCHER_TYPES);
  const family = longestName(lower, C.FAMILIES);
  /* A voucher-type name and a family name can overlap ("journal entry" vs
     "entry"); the longer one is what was said. */
  /* A voucher TYPE is always more specific than the bare word "voucher" —
     "sales vouchers" is sales, whichever name is longer. */
  const pickType = voucherType && (!family || family.entry.id === "voucher" || voucherType.name.length >= family.name.length);
  const statusList = (pickType || family?.entry.id === "voucher") ? C.VOUCHER_STATUSES
    : family?.entry.id === "proforma_invoice" ? C.PROFORMA_STATUSES : [];
  const status = statusList.length ? longestName(lower, statusList) : null;
  const window = periodFrom(lower, now) || grammar.dateRange || null;

  let op = null;
  if (OPERATIONS.count.test(raw)) op = "count";
  else if (OPERATIONS.total.test(raw)) op = "total";
  else if (OPERATIONS.balance.test(raw)) op = "balance";
  /* "stock items" names the FAMILY; "stock of cotton" asks a figure. */
  else if (OPERATIONS.stock.test(raw) && !pickType && !["voucher", "stock_item"].includes(family?.entry.id)) op = "stock";
  else if (OPERATIONS.latest.test(raw) && !/\blast (month|year|fy|financial year)\b/i.test(raw)) op = "latest";

  /* ── A BALANCE OR A STOCK FIGURE NAMES A RECORD, NOT A FAMILY ─────────
       "balance of Sales" asks about the ledger called Sales; the word is a
       name there, not the sales vouchers. So for those questions nothing is
       read as a family, and every word after the question is the name. */
  const aboutOne = op === "balance" || (op === "stock" && !pickType && family?.entry.id !== "voucher");

  /* What is left once everything understood is taken out. */
  let rest = ` ${lower} `;
  if (!aboutOne && pickType) {
    rest = strip(rest, voucherType.name);
    /* …and the generic word that came with it ("sales VOUCHERS"). */
    if (family?.entry.id === "voucher") rest = strip(rest, family.name);
  } else if (!aboutOne && family) rest = strip(rest, family.name);
  if (status) rest = strip(rest, status.name);
  if (window?.source) rest = rest.replace(window.source.toLowerCase(), " ");
  for (const rx of Object.values(OPERATIONS)) rest = rest.replace(new RegExp(rx.source, "gi"), " ");
  rest = rest.replace(/\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|twenty)\b(?=\s|$)/gi, (n) => (grammar.limit && op === "latest" ? " " : n));
  rest = rest.replace(FILLER, " ").replace(/\s+/g, " ").trim();

  return {
    raw,
    voucherType: !aboutOne && pickType ? voucherType.entry : null,
    family: aboutOne ? null : pickType ? { id: "voucher" } : family?.entry || null,
    status: status?.entry.status || null,
    window,
    op,
    limit: grammar.limit || null,
    rest: rest || null,
  };
}

/* ── READERS — every one filtered by companyId ─────────────────────────── */

async function ledgersNamed(companyId, name, { limit = 20 } = {}) {
  const base = { companyId, isActive: { $ne: false } };
  const exact = await Acc_Ledger.find({ ...base, $or: [{ name: exactRx(name) }, { aliases: exactRx(name) }, { gstin: exactRx(name) }, { panNumber: exactRx(name) }] })
    .select(C.PROJECTIONS.ledger).limit(limit).lean();
  if (exact.length) return exact;
  if (String(name).trim().length < 3) return [];
  return Acc_Ledger.find({ ...base, $or: [{ name: containsRx(name) }, { aliases: containsRx(name) }] })
    .select(C.PROJECTIONS.ledger).limit(limit).lean();
}

async function partyFilter(companyId, partyKind) {
  if (!partyKind) return {};
  const ids = await partyGroupIds(partyKind, companyId);
  return { groupId: { $in: ids } };
}

async function cardFor(companyId, { entity, recordId }) {
  const id = oid(recordId);
  if (!id) return null;
  const scoped = { companyId, _id: id };
  if (entity === "ledger") {
    const ledger = await Acc_Ledger.findOne(scoped).select(C.PROJECTIONS.ledger).lean();
    if (!ledger) return null;
    const balance = (await computeLedgerBalances(companyId, [ledger])).get(String(ledger._id));
    return cards.buildCard(C.CARDS.ledger, ledger, { balance });
  }
  if (entity === "voucher") {
    const voucher = await Acc_Voucher.findOne(scoped).select(C.PROJECTIONS.voucher).lean();
    return voucher ? cards.buildCard(C.CARDS.voucher, voucher) : null;
  }
  if (entity === "stock_item") {
    const item = await Acc_StockItem.findOne(scoped).select(C.PROJECTIONS.stock_item).lean();
    return item ? cards.buildCard(C.CARDS.stock_item, item) : null;
  }
  if (entity === "group") {
    const group = await Acc_Group.findOne(scoped).select(C.PROJECTIONS.group).lean();
    if (!group) return null;
    const ledgers = await Acc_Ledger.countDocuments({ companyId, groupId: id, isActive: { $ne: false } });
    return cards.buildCard(C.CARDS.group, group, { ledgers: String(ledgers) });
  }
  if (entity === "proforma_invoice") {
    const pi = await Acc_ProformaInvoice.findOne(scoped).select(C.PROJECTIONS.proforma_invoice).lean();
    return pi ? cards.buildCard(C.CARDS.proforma_invoice, pi) : null;
  }
  return null;
}

/* ── ROWS — the shared shapes ──────────────────────────────────────────── */

const link = (href, label) => sanitizeAssistantLinks([{ href, label }])[0]?.href || null;

function ledgerRow(ledger, balance, { concept = null, single = true } = {}) {
  return {
    id: `record:ledger:${ledger._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(ledger.name, 200),
    subtitle: text([ledger.groupName, ledger.gstin].filter(Boolean).join(" · "), 200) || null,
    value: balance ? C.balanceText(balance) : null,
    href: link(C.ACCOUNTING_RECORD_ROUTES.ledger(ledger._id), ledger.name),
    entityType: "ledger",
    metadata: { single, concept, record: { entity: "ledger", recordId: String(ledger._id) } },
  };
}
function voucherRow(voucher, { single = true } = {}) {
  return {
    id: `record:voucher:${voucher._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(voucher.voucherNumber, 200),
    subtitle: text([words(C.voucherTypeLabel(voucher.voucherType)), date(voucher.voucherDate), voucher.partyLedgerName, words(voucher.status)]
      .filter(Boolean).join(" · "), 200),
    value: money(voucher.grandTotal),
    href: link(C.voucherRoute(voucher), voucher.voucherNumber),
    entityType: "voucher",
    metadata: { single, record: { entity: "voucher", recordId: String(voucher._id) } },
  };
}
function stockRow(item, { concept = null, single = true } = {}) {
  return {
    id: `record:stock_item:${item._id}`,
    /* No page of its own: the row is the answer, and its card the detail. */
    kind: RESULT_KIND.FACT,
    title: text(item.name, 200),
    subtitle: text([item.stockGroupName, item.hsnCode && `HSN ${item.hsnCode}`].filter(Boolean).join(" · "), 200) || null,
    value: number(item.closingQuantity) === null ? null : `${number(item.closingQuantity)} ${text(item.baseUnit) || ""}`.trim(),
    href: null,
    entityType: "stock_item",
    metadata: { single, concept, record: { entity: "stock_item", recordId: String(item._id) } },
  };
}
function groupRow(group, { single = true } = {}) {
  return {
    id: `record:group:${group._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(group.name, 200),
    subtitle: text([words(group.nature), group.parentName && `under ${group.parentName}`].filter(Boolean).join(" · "), 200) || null,
    href: link(C.ACCOUNTING_RECORD_ROUTES.group(group._id), group.name),
    entityType: "group",
    metadata: { single, record: { entity: "group", recordId: String(group._id) } },
  };
}
function proformaRow(pi, { single = true } = {}) {
  return {
    id: `record:proforma_invoice:${pi._id}`,
    kind: RESULT_KIND.RECORD,
    title: text(pi.voucherNumber, 200),
    subtitle: text([words(pi.status), date(pi.voucherDate), pi.buyer?.name].filter(Boolean).join(" · "), 200),
    value: money(pi.grandTotal),
    href: link(C.ACCOUNTING_RECORD_ROUTES.proforma_invoice(pi._id), pi.voucherNumber),
    entityType: "proforma_invoice",
    metadata: { single, record: { entity: "proforma_invoice", recordId: String(pi._id) } },
  };
}
const fact = (id, sentence, extra = {}) => ({ id, kind: RESULT_KIND.FACT, title: text(sentence), value: null, href: null, metadata: { single: false }, ...extra });

const answered = (label, results, note = null) => ({ state: "answered", note, groups: [{ label, results: results.slice(0, MAX_ROWS) }] });
const nothing = (note) => ({ state: "no_match", groups: [], note });

/* ── THE QUESTIONS ─────────────────────────────────────────────────────── */

/** "balance of Gaurav Enterprises" */
async function balanceOf(companyId, q) {
  if (!q.rest) return nothing("Say whose balance — a ledger, customer or supplier name.");
  const ledgers = await ledgersNamed(companyId, q.rest, { limit: 6 });
  if (!ledgers.length) return nothing(`No ledger in these books is called "${text(q.rest, 80)}".`);
  const balances = await computeLedgerBalances(companyId, ledgers);
  if (ledgers.length === 1) {
    const [ledger] = ledgers;
    const balance = balances.get(String(ledger._id));
    const sentence = balance?.reconciliation?.status === "source_incomplete"
      ? `${ledger.name}'s balance needs reconciliation before it can be stated.`
      : `${ledger.name}'s balance is ${C.balanceText(balance)} (posted vouchers).`;
    return answered("Answer", [{ ...ledgerRow(ledger, balance, { concept: "balance" }), title: text(sentence), value: null }]);
  }
  return answered("Which ledger?", ledgers.map((l) => ledgerRow(l, balances.get(String(l._id)), { single: false })),
    `More than one ledger matches "${text(q.rest, 80)}" — each with its balance.`);
}

/** "stock of cotton fabric" */
async function stockOf(companyId, q) {
  if (!q.rest) return nothing("Say which stock item.");
  const base = { companyId, isActive: { $ne: false } };
  let items = await Acc_StockItem.find({ ...base, $or: [{ name: exactRx(q.rest) }, { aliases: exactRx(q.rest) }, { hsnCode: exactRx(q.rest) }] })
    .select(C.PROJECTIONS.stock_item).limit(6).lean();
  if (!items.length && q.rest.length >= 3) {
    items = await Acc_StockItem.find({ ...base, $or: [{ name: containsRx(q.rest) }, { aliases: containsRx(q.rest) }] })
      .select(C.PROJECTIONS.stock_item).limit(6).lean();
  }
  if (!items.length) return nothing(`No stock item in these books is called "${text(q.rest, 80)}".`);
  if (items.length === 1) {
    const [item] = items;
    const qty = number(item.closingQuantity);
    const sentence = qty === null
      ? `${item.name} has no closing quantity recorded.`
      : `${item.name}: ${qty} ${text(item.baseUnit) || ""} in stock${item.closingValue != null ? `, valued ${money(item.closingValue)}` : ""}.`.replace(/\s+/g, " ");
    return answered("Answer", [{ ...stockRow(item, { concept: "stock" }), title: text(sentence), value: null }]);
  }
  return answered("Which item?", items.map((i) => stockRow(i, { single: false })));
}

/** Vouchers: list, latest, how many, total — filtered by type, status, window, party. */
async function vouchers(companyId, q) {
  const filter = { companyId };
  if (q.voucherType) filter.voucherType = q.voucherType.type;
  if (q.status) filter.status = q.status;
  /* A total counts money that moved: posted, unless a status was named. */
  if (q.op === "total" && !q.status) filter.status = "posted";
  if (q.window) filter.voucherDate = { $gte: dayStart(q.window.from), $lte: dayEnd(q.window.to) };

  let partyNote = "";
  if (q.rest) {
    /* ── THE LEFTOVER WORDS NAME SOMETHING, AND ARE NEVER DROPPED ─────────
         A voucher number, a reference, or a party. If none of those matches,
         the answer is that nothing does — not every voucher of the type. */
    const asNumber = await Acc_Voucher.find({ ...filter, $or: [{ voucherNumber: exactRx(q.rest) }, { referenceNumber: exactRx(q.rest) }] })
      .select(C.PROJECTIONS.voucher).sort({ voucherDate: -1 }).limit(MAX_ROWS).lean();
    if (asNumber.length) return answered("Vouchers", asNumber.map(voucherRow));
    const parties = await ledgersNamed(companyId, q.rest);
    if (!parties.length) return nothing(`Nothing in these books matches "${text(q.rest, 80)}".`);
    filter.partyLedgerId = { $in: parties.map((p) => p._id) };
    partyNote = parties.length === 1 ? ` for ${parties[0].name}` : ` for ${parties.length} ledgers matching "${text(q.rest, 60)}"`;
  }

  const what = q.voucherType ? plural(q.voucherType.label) : "vouchers";
  const statusWord = filter.status ? `${words(filter.status).toLowerCase()} ` : "";
  const when = q.window
    ? ` dated ${(q.window.source || `${q.window.from} to ${q.window.to}`).replace(/\bfy\b/i, "FY")}`
    : "";

  if (q.op === "count") {
    const n = await Acc_Voucher.countDocuments(filter);
    return answered("Answer", [fact("fact:count", `There ${n === 1 ? "is" : "are"} ${n} ${statusWord}${n === 1 ? (q.voucherType?.label || "voucher") : what}${when}${partyNote}.`)]);
  }
  if (q.op === "total") {
    const [sum] = await Acc_Voucher.aggregate([{ $match: filter }, { $group: { _id: null, total: { $sum: "$grandTotal" }, n: { $sum: 1 } } }]);
    const n = sum?.n || 0;
    return answered("Answer", [fact("fact:total", n
      ? `Total of ${n} ${statusWord}${n === 1 ? (q.voucherType?.label || "voucher") : what}${when}${partyNote}: ${money(sum.total)}.`
      : `There are no ${statusWord}${what}${when}${partyNote}.`)]);
  }

  const limit = Math.min(MAX_ROWS - 1, q.limit || (q.op === "latest" ? 5 : DEFAULT_LIST));
  const [rows, total] = await Promise.all([
    Acc_Voucher.find(filter).select(C.PROJECTIONS.voucher).sort({ voucherDate: -1, _id: -1 }).limit(limit).lean(),
    Acc_Voucher.countDocuments(filter),
  ]);
  if (!rows.length) return nothing(`There are no ${statusWord}${what}${when}${partyNote}.`);
  const head = fact("fact:summary", total > rows.length
    ? `${total} ${statusWord}${what}${when}${partyNote} — the ${rows.length} newest:`
    : `${total} ${statusWord}${total === 1 ? (q.voucherType?.label || "voucher") : what}${when}${partyNote}:`);
  /* A list: each row says its own facts; cards are for ONE record. */
  return answered("Vouchers", [head, ...rows.map((v) => voucherRow(v, { single: false }))]);
}

/** Masters: ledgers, customers, suppliers, groups, stock items, proforma invoices. */
async function masters(companyId, q) {
  const id = q.family.id;
  const named = q.rest ? { $or: [{ name: containsRx(q.rest) }, { aliases: containsRx(q.rest) }] } : {};
  const limit = Math.min(MAX_ROWS - 1, q.limit || DEFAULT_LIST);
  let model; let projection; let filter; let row; let sort = { name: 1 };
  if (["ledger", "customer", "supplier"].includes(id)) {
    model = Acc_Ledger; projection = C.PROJECTIONS.ledger; row = null;
    filter = { companyId, isActive: { $ne: false }, ...(await partyFilter(companyId, q.family.party)), ...named };
  } else if (id === "group") {
    model = Acc_Group; projection = C.PROJECTIONS.group; row = groupRow;
    filter = { companyId, isActive: { $ne: false }, ...(q.rest ? { name: containsRx(q.rest) } : {}) };
  } else if (id === "stock_item") {
    model = Acc_StockItem; projection = C.PROJECTIONS.stock_item; row = stockRow;
    filter = { companyId, isActive: { $ne: false }, ...named };
  } else if (id === "proforma_invoice") {
    model = Acc_ProformaInvoice; projection = C.PROJECTIONS.proforma_invoice; row = proformaRow;
    filter = { companyId, ...(q.status ? { status: q.status } : {}), ...(q.rest ? { $or: [{ voucherNumber: containsRx(q.rest) }, { "buyer.name": containsRx(q.rest) }] } : {}) };
    sort = { voucherDate: -1 };
  } else {
    return null;
  }
  const what = plural(q.family.label);
  const named2 = q.rest ? ` matching "${text(q.rest, 60)}"` : "";
  if (q.op === "count") {
    const n = await model.countDocuments(filter);
    return answered("Answer", [fact("fact:count", `There ${n === 1 ? "is" : "are"} ${n} ${n === 1 ? q.family.label : what}${named2}.`)]);
  }
  const [records, total] = await Promise.all([
    model.find(filter).select(projection).sort(sort).limit(limit).lean(),
    model.countDocuments(filter),
  ]);
  if (!records.length) return nothing(q.rest ? `No ${q.family.label} matches "${text(q.rest, 80)}".` : `There are no ${what} in these books.`);
  let rows;
  if (row) rows = records.map((r) => row(r, { single: false }));
  else {
    const balances = await computeLedgerBalances(companyId, records);
    rows = records.map((l) => ledgerRow(l, balances.get(String(l._id)), { single: false }));
  }
  const head = fact("fact:summary", total > records.length
    ? `${total} ${what}${named2} — the first ${records.length}:` : `${total} ${total === 1 ? q.family.label : what}${named2}:`);
  return answered(q.family.label.replace(/^./, (c) => c.toUpperCase()), [head, ...rows]);
}

/** Nothing named a family: the words are a record — find it by what identifies it. */
async function lookup(companyId, q, { exactOnly = false } = {}) {
  const term = q.raw;
  const base = { companyId };
  const active = { companyId, isActive: { $ne: false } };
  const [vExact, lExact, sExact, gExact, pExact] = await Promise.all([
    Acc_Voucher.find({ ...base, $or: [{ voucherNumber: exactRx(term) }, { referenceNumber: exactRx(term) }] }).select(C.PROJECTIONS.voucher).sort({ voucherDate: -1 }).limit(6).lean(),
    Acc_Ledger.find({ ...active, $or: [{ name: exactRx(term) }, { aliases: exactRx(term) }, { gstin: exactRx(term) }, { panNumber: exactRx(term) }] }).select(C.PROJECTIONS.ledger).limit(6).lean(),
    Acc_StockItem.find({ ...active, $or: [{ name: exactRx(term) }, { aliases: exactRx(term) }, { hsnCode: exactRx(term) }] }).select(C.PROJECTIONS.stock_item).limit(6).lean(),
    Acc_Group.find({ ...active, name: exactRx(term) }).select(C.PROJECTIONS.group).limit(3).lean(),
    Acc_ProformaInvoice.find({ ...base, voucherNumber: exactRx(term) }).select(C.PROJECTIONS.proforma_invoice).limit(3).lean(),
  ]);
  const exactCount = vExact.length + lExact.length + sExact.length + gExact.length + pExact.length;
  /* ── WHAT WAS TYPED EXACTLY WINS ─────────────────────────────────────────
       "1" is voucher 1, not every voucher with a 1 in it — the old search's
       own rule, kept. Only when nothing is called exactly that are records
       that CONTAIN the words offered. */
  let found = { v: vExact, l: lExact, s: sExact, g: gExact, p: pExact };
  if (!exactCount) {
    if (exactOnly || term.length < 3) return nothing("No record in these books is called that.");
    const rx = containsRx(term);
    const [v, l, s, g, p] = await Promise.all([
      Acc_Voucher.find({ ...base, $or: [{ voucherNumber: rx }, { referenceNumber: rx }, { partyLedgerName: rx }, { "inventoryEntries.stockItemName": rx }] })
        .select(C.PROJECTIONS.voucher).sort({ voucherDate: -1 }).limit(6).lean(),
      Acc_Ledger.find({ ...active, $or: [{ name: rx }, { aliases: rx }] }).select(C.PROJECTIONS.ledger).limit(6).lean(),
      Acc_StockItem.find({ ...active, $or: [{ name: rx }, { aliases: rx }] }).select(C.PROJECTIONS.stock_item).limit(4).lean(),
      Acc_Group.find({ ...active, name: rx }).select(C.PROJECTIONS.group).limit(3).lean(),
      Acc_ProformaInvoice.find({ ...base, voucherNumber: rx }).select(C.PROJECTIONS.proforma_invoice).limit(3).lean(),
    ]);
    found = { v, l, s, g, p };
  }
  const balances = found.l.length ? await computeLedgerBalances(companyId, found.l) : new Map();
  /* Ledgers and items first: a name is more often a party or a material than
     a document; a document number has already won above if it was exact. */
  const rows = [
    ...found.p.map(proformaRow),
    ...(exactCount ? found.v.map(voucherRow) : []),
    ...found.l.map((l) => ledgerRow(l, balances.get(String(l._id)))),
    ...found.s.map((s) => stockRow(s)),
    ...found.g.map(groupRow),
    ...(exactCount ? [] : found.v.map(voucherRow)),
  ];
  if (!rows.length) return exactOnly ? nothing("No record in these books matches that.") : closestInBooks(companyId, term);
  return answered("Records", rows);
}

/* ── NOTHING EXACT: THE CLOSEST, WITH A WARNING ────────────────────────────
   Owner's call, 9 Oct 2026 (services/ai/commandSearch/closest.js): a name
   that matched nothing — "gaurav enterprize" — is compared word by word with
   this company's ledgers, stock items and groups, and the closest are
   offered under a note that they are not exact. Never a voucher number:
   that path returned before this. */
async function closestInBooks(companyId, term) {
  const active = { companyId, isActive: { $ne: false } };
  const [ledgers, items, groups] = await Promise.all([
    Acc_Ledger.find(active).select(C.PROJECTIONS.ledger).limit(5000).lean(),
    Acc_StockItem.find(active).select(C.PROJECTIONS.stock_item).limit(5000).lean(),
    Acc_Group.find(active).select(C.PROJECTIONS.group).limit(1000).lean(),
  ]);
  const candidates = [
    ...ledgers.map((l) => ({ label: l.name, words: (l.aliases || []).join(" "), row: () => ledgerRow(l, null, { single: false }) })),
    ...items.map((i) => ({ label: i.name, words: (i.aliases || []).join(" "), row: () => stockRow(i, { single: false }) })),
    ...groups.map((g) => ({ label: g.name, row: () => groupRow(g, { single: false }) })),
  ].filter((c) => c.label);
  const near = closestMatches(term, candidates, { limit: 5 });
  if (!near.length) return nothing("No record in these books matches that.");
  const rows = near.map(({ candidate }, i) => {
    const row = candidate.row();
    return { ...row, metadata: { ...row.metadata, single: i === 0, approximate: true } };
  });
  return { ...answered("Closest matches", rows), note: approximateNote(term) };
}

/**
 * THE ENTRY POINT.
 *
 * @param {object} args
 * @param {string} args.companyId  already checked by `requireCompanyScope`
 * @param {string} args.query
 * @param {number} [args.now]      the clock, for the periods
 */
async function search({ companyId, query, now = Date.now() } = {}) {
  const cid = oid(companyId);
  if (!cid) return { state: "unauthorised", groups: [] };
  const raw = text(query, MAX_QUERY);
  if (!raw) return { state: "unsupported", groups: [] };
  const q = parse(raw, now);

  let out;
  if (q.op === "balance") out = await balanceOf(cid, q);
  else if (q.op === "stock" && !q.family) out = await stockOf(cid, q);
  else if (q.family?.id === "voucher") out = await vouchers(cid, q);
  else if (q.family) out = await masters(cid, q);
  if (!out) out = await lookup(cid, q);

  /* ── A FAMILY WORD THAT IS ALSO A NAME ─────────────────────────────────
       "Sales" is both the sales vouchers and, in most books, a ledger called
       Sales; "Purchase" and "Payment" the same. A bare family word lists the
       family AND offers whatever is called exactly that, beneath — so the
       ledger is never hidden behind the list it shares a word with. */
  if (q.family && !q.op && !q.status && !q.window && !q.rest) {
    const named = await lookup(cid, q, { exactOnly: true });
    if (named.state === "answered") {
      out = out.state === "answered"
        ? { ...out, groups: [...out.groups, { label: `Called "${text(raw, 40)}"`, results: named.groups[0].results }] }
        : named;
    }
  }

  /* Cards for the results about one record — the shared rule and look. */
  if (out.state === "answered") {
    out.groups = await Promise.all(out.groups.map(async (group) => ({
      ...group,
      results: await cards.withCards(group.results, { cardFor: (record) => cardFor(cid, record) }),
    })));
  }
  return out;
}

module.exports = { search, parse, periodFrom, cardFor, MAX_QUERY };
