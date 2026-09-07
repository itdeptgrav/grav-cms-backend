// services/storePurchaseBaselineAudit.service.js
//
// Store & Purchase professionalisation — Chunk 0, Deliverable 2.
//
// READ-ONLY reconciliation calculations over the CURRENT Store/Purchase data
// model. Every function here is pure: plain document arrays in, a plain
// report object out. Nothing in this file touches mongoose, the network or
// the clock — `now` is an argument precisely so two runs over the same data
// produce byte-identical output.
//
// The gathering (which collections to read, with which projections) lives in
// scripts/store-purchase-baseline-audit.js. Keeping the arithmetic here means
// it can be tested against fixtures without a database, and the runner can be
// audited for writes by reading one short file.
//
// ── WHAT "UNRECONCILED" MEANS HERE, AND WHAT IT DOES NOT ────────────────────
// This report DESCRIBES the present data; it never repairs it. Two rules from
// the chunk brief are load-bearing:
//
//   1. "No linked record" is not corruption where the legacy model never
//      stored a link. Only a NON-NULL reference pointing at a document that
//      does not exist is reported as an orphan. Absent/null links are counted
//      separately as "unlinked", which is the ordinary state of legacy data.
//
//   2. Historic balances often CANNOT be reconstructed: the raw-item PUT
//      route (routes/CMS_Routes/Inventory/Products/rawItems.js) overwrites
//      `quantity` directly from the request body without writing a stock
//      transaction, so an item whose balance disagrees with its embedded
//      history may simply have been edited that way. Such items are reported
//      as UNRECONCILED-with-limitation, not as corrupt.

"use strict";

const {
  computeItemMasterReport,
  renderItemMasterSummary,
} = require("./storePurchaseItemMasterAudit.service");

const EPS = 0.001;

// Embedded stock-transaction types, signed. This mirrors the writers:
//   +  ADD / VARIANT_ADD          (PO receive, MRF return, stock credit)
//   -  REDUCE / VARIANT_REDUCE / CONSUME   (MRF issue, stock debit)
//   +  PURCHASE_ORDER             (legacy PO-receipt type; additive)
const TXN_SIGN = {
  ADD: 1,
  VARIANT_ADD: 1,
  PURCHASE_ORDER: 1,
  ADD_STOCK: 1, // defensive: legacy free-typed values survive strict:false
  REDUCE: -1,
  VARIANT_REDUCE: -1,
  CONSUME: -1,
};

const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;
const approxEqual = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) <= EPS;

const sortStrings = (arr) => [...arr].sort((a, b) => String(a).localeCompare(String(b)));

/** Deterministic tally of a field's values. Missing/empty → "(none)". */
function countBy(docs, pick) {
  const counts = {};
  for (const d of docs) {
    const key = String(pick(d) ?? "(none)") || "(none)";
    counts[key] = (counts[key] || 0) + 1;
  }
  // Stable key order so JSON output is diffable run-to-run.
  return Object.fromEntries(
    Object.keys(counts)
      .sort((a, b) => a.localeCompare(b))
      .map((k) => [k, counts[k]]),
  );
}

function recencyBuckets(docs, now) {
  const nowMs = new Date(now).getTime();
  const DAY = 24 * 60 * 60 * 1000;
  let last30 = 0;
  let last90 = 0;
  let newest = null;
  for (const d of docs) {
    const t = d.createdAt ? new Date(d.createdAt).getTime() : null;
    if (t === null || Number.isNaN(t)) continue;
    if (nowMs - t <= 30 * DAY) last30 += 1;
    if (nowMs - t <= 90 * DAY) last90 += 1;
    if (newest === null || t > newest) newest = t;
  }
  return {
    createdLast30Days: last30,
    createdLast90Days: last90,
    newestCreatedAt: newest === null ? null : new Date(newest).toISOString(),
  };
}

const normKey = (s) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");

/**
 * Values that collide after trim/case/whitespace normalisation.
 *
 * TWO different collisions matter and they are counted separately:
 *
 *   occurrences       — how many DOCUMENTS carried a value in this group.
 *                       Two items both spelled exactly "Meters" is a
 *                       duplicate identity even though there is only one
 *                       spelling, and an earlier version of this function
 *                       dropped that case entirely by filtering on the
 *                       number of distinct spellings.
 *   distinctSpellings — how many different renderings a human would see
 *                       ("Meters" / "meters" / " METERS ").
 *
 * `kind` says which problem a group is: REPEATED_VALUE is a straight
 * duplicate, SPELLING_VARIANTS is one concept written several ways. A group
 * can be both (three docs across two spellings) and is then reported as
 * SPELLING_VARIANTS, which is the harder of the two to clean up.
 */
const DUPLICATE_KIND = {
  REPEATED_VALUE: "REPEATED_VALUE",
  SPELLING_VARIANTS: "SPELLING_VARIANTS",
};

function duplicateCandidates(values) {
  const groups = new Map();
  for (const v of values) {
    const raw = String(v ?? "").trim();
    if (!raw) continue;
    const key = normKey(raw);
    if (!groups.has(key)) groups.set(key, { spellings: new Map() });
    const g = groups.get(key).spellings;
    g.set(raw, (g.get(raw) || 0) + 1);
  }
  const out = [];
  for (const [key, { spellings }] of groups) {
    const occurrences = [...spellings.values()].reduce((a, b) => a + b, 0);
    const distinctSpellings = spellings.size;
    out.push({
      normalized: key,
      occurrences,
      distinctSpellings,
      kind: distinctSpellings > 1 ? DUPLICATE_KIND.SPELLING_VARIANTS : DUPLICATE_KIND.REPEATED_VALUE,
      variants: sortStrings([...spellings.keys()]),
    });
  }
  return out
    // More than one DOCUMENT used this identity — whether spelled one way or
    // several. Filtering on spelling count alone hid every exact repeat.
    .filter((g) => g.occurrences > 1)
    .sort((a, b) => a.normalized.localeCompare(b.normalized));
}

/** Split a duplicate-candidate list into the two problems it mixes. */
function summariseDuplicates(groups) {
  const repeated = groups.filter((g) => g.kind === DUPLICATE_KIND.REPEATED_VALUE);
  const variants = groups.filter((g) => g.kind === DUPLICATE_KIND.SPELLING_VARIANTS);
  return {
    groups: groups.length,
    repeatedValueGroups: repeated.length,
    spellingVariantGroups: variants.length,
    totalOccurrences: groups.reduce((s, g) => s + g.occurrences, 0),
    candidates: groups.slice(0, LIST_CAP),
    shown: Math.min(groups.length, LIST_CAP),
  };
}

/** Exact-value duplicates across docs (e.g. two POs with one poNumber). */
function exactDuplicates(docs, pick) {
  const counts = new Map();
  for (const d of docs) {
    const v = pick(d);
    if (v === null || v === undefined || String(v).trim() === "") continue;
    const key = String(v).trim();
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => a.value.localeCompare(b.value));
}

// ─────────────────────────────────────────────────────────────────────────────
// Raw-item balance vs embedded movement history
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile one raw item's `quantity` against its embedded
 * `stockTransactions[]` two independent ways:
 *
 *   signedSum — Σ(±quantity) over every transaction. Only reconstructs the
 *     balance if the item's ENTIRE life is in the history (an opening
 *     transaction exists and nothing ever edited quantity directly).
 *
 *   latestNewQuantity — the `newQuantity` snapshot on the most recent
 *     transaction (by createdAt; writers disagree on push vs unshift, so
 *     array position is NOT trustworthy). Matches whenever nothing has
 *     changed quantity since the last recorded movement.
 *
 * status:
 *   NO_HISTORY   — no transactions at all; nothing to reconcile against.
 *   RECONCILED   — latestNewQuantity matches the current balance.
 *   DRIFTED      — latest snapshot disagrees with the balance: something
 *                  changed quantity without writing a movement (the direct
 *                  PUT edit path), or a movement was written without the
 *                  snapshot. Cannot distinguish which from data alone.
 */
function reconcileRawItem(rawItem) {
  const txns = rawItem.stockTransactions || [];
  const quantity = Number(rawItem.quantity) || 0;
  const variants = rawItem.variants || [];
  const variantSum = variants.reduce((s, v) => s + (Number(v.quantity) || 0), 0);

  let signedSum = 0;
  let unknownTypes = new Set();
  let latest = null;
  for (const t of txns) {
    const sign = TXN_SIGN[t.type];
    if (sign === undefined) unknownTypes.add(String(t.type));
    else signedSum += sign * (Number(t.quantity) || 0);
    const at = t.createdAt ? new Date(t.createdAt).getTime() : 0;
    if (!latest || at >= latest.at) latest = { at, newQuantity: Number(t.newQuantity) || 0 };
  }
  signedSum = round4(signedSum);

  const hasHistory = txns.length > 0;
  const matchesSignedSum = hasHistory && approxEqual(quantity, signedSum);
  const matchesLatestSnapshot = hasHistory && approxEqual(quantity, latest.newQuantity);
  const variantSumMatches = variants.length === 0 || approxEqual(quantity, round4(variantSum));

  return {
    id: String(rawItem._id),
    sku: rawItem.sku || "",
    name: rawItem.name || "",
    quantity: round4(quantity),
    transactionCount: txns.length,
    signedSum,
    latestNewQuantity: hasHistory ? round4(latest.newQuantity) : null,
    matchesSignedSum,
    matchesLatestSnapshot,
    variantCount: variants.length,
    variantQuantitySum: round4(variantSum),
    variantSumMatches,
    unknownTransactionTypes: sortStrings([...unknownTypes]),
    status: !hasHistory ? "NO_HISTORY" : matchesLatestSnapshot ? "RECONCILED" : "DRIFTED",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Operational PO: received totals vs line receipts vs delivery records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three numbers on an operational PO claim to describe the same fact:
 *   po.totalReceived, Σ items[].receivedQuantity, Σ deliveries[].quantityReceived.
 * All are written by the same /receive handler in one pass, so on an
 * untouched document they agree. Divergence means a partial write (the
 * handler saves each RawItem then the PO, with no transaction) or a later
 * edit. Surplus deliveries are stock-only by design and appear in NONE of the
 * three, so they cannot explain a mismatch here.
 */
function reconcileOperationalPO(po) {
  const items = po.items || [];
  const deliveries = po.deliveries || [];
  const lineReceived = round4(items.reduce((s, i) => s + (Number(i.receivedQuantity) || 0), 0));
  const lineOrdered = round4(items.reduce((s, i) => s + (Number(i.quantity) || 0), 0));
  const linePending = round4(items.reduce((s, i) => s + (Number(i.pendingQuantity) || 0), 0));
  const deliverySum = round4(deliveries.reduce((s, d) => s + (Number(d.quantityReceived) || 0), 0));
  const totalReceived = round4(Number(po.totalReceived) || 0);
  const totalPending = round4(Number(po.totalPending) || 0);

  const headerMatchesLines = approxEqual(totalReceived, lineReceived);
  const deliveriesMatchLines = approxEqual(deliverySum, lineReceived);
  const pendingConsistent = approxEqual(totalPending, linePending);
  const statusConsistent = !(
    (po.status === "COMPLETED" && linePending > EPS) ||
    (po.status === "PARTIALLY_RECEIVED" && lineReceived <= EPS) ||
    ((po.status === "DRAFT" || po.status === "ISSUED") && lineReceived > EPS)
  );

  return {
    id: String(po._id),
    poNumber: po.poNumber || "",
    status: po.status || "(none)",
    lineOrdered,
    lineReceived,
    linePending,
    deliverySum,
    totalReceived,
    totalPending,
    headerMatchesLines,
    deliveriesMatchLines,
    pendingConsistent,
    statusConsistent,
    reconciled: headerMatchesLines && deliveriesMatchLines && pendingConsistent && statusConsistent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// MRF: line issued/returned totals vs their own histories vs stock records
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per MRF line, `issuedQty`/`returnedQty` should equal the sums of the
 * line's own issueHistory/returnHistory (all in the REQUESTER's unit).
 *
 * The stock side is checked separately by the caller: MRF stock movements
 * live as embedded RawItem.stockTransactions whose `reason` carries
 * "MRF Issue — <mrfNumber>" / "MRF Return — <mrfNumber>" — but in the
 * catalogue BASE unit. Where the line's unit differs from its baseUnit the
 * two quantities differ legitimately (unit conversion at the stock
 * boundary), so quantity comparison is only attempted when units match.
 */
function reconcileMrf(mrf) {
  const lines = (mrf.items || []).map((item) => {
    const issueSum = round4((item.issueHistory || []).reduce((s, h) => s + (Number(h.issuedQty) || 0), 0));
    const returnSum = round4((item.returnHistory || []).reduce((s, h) => s + (Number(h.returnedQty) || 0), 0));
    const issuedQty = round4(Number(item.issuedQty) || 0);
    const returnedQty = round4(Number(item.returnedQty) || 0);
    const issueHistoryMatches = approxEqual(issuedQty, issueSum) || (item.issueHistory || []).length === 0;
    const returnHistoryMatches = approxEqual(returnedQty, returnSum) || (item.returnHistory || []).length === 0;
    // Legacy MRFs predate issueHistory: an issuedQty with NO history rows is
    // a documented limitation, not a mismatch.
    const issueHistoryAbsent = issuedQty > EPS && (item.issueHistory || []).length === 0;
    const returnHistoryAbsent = returnedQty > EPS && (item.returnHistory || []).length === 0;
    return {
      itemId: String(item._id),
      rawItem: item.rawItem ? String(item.rawItem) : null,
      rawItemName: item.rawItemName || "",
      unit: item.unit || "",
      baseUnit: item.baseUnit || "",
      unitsComparable: !item.baseUnit || item.unit === item.baseUnit,
      requestedQty: round4(Number(item.requestedQty) || 0),
      issuedQty,
      returnedQty,
      issueSum,
      returnSum,
      issueHistoryMatches,
      returnHistoryMatches,
      issueHistoryAbsent,
      returnHistoryAbsent,
      returnExceedsIssue: returnedQty > issuedQty + EPS,
    };
  });

  const ok = lines.every(
    (l) => l.issueHistoryMatches && l.returnHistoryMatches && !l.returnExceedsIssue,
  );
  return {
    id: String(mrf._id),
    mrfNumber: mrf.mrfNumber || "",
    status: mrf.status || "(none)",
    lines,
    reconciled: ok,
    hasLegacyHistoryGaps: lines.some((l) => l.issueHistoryAbsent || l.returnHistoryAbsent),
  };
}

/**
 * Cross-check MRF movement against the embedded raw-item transactions that
 * name it. Returns per-MRF issue/return stock sums (BASE unit) found in the
 * embedded histories, keyed by mrfNumber.
 */
function mrfStockMovementIndex(rawItems) {
  const index = new Map(); // mrfNumber → {issued, returned}
  const ISSUE = /^MRF Issue — (.+)$/;
  const RETURN = /^MRF Return — (.+)$/;
  for (const item of rawItems) {
    for (const t of item.stockTransactions || []) {
      const reason = String(t.reason || "");
      let m = ISSUE.exec(reason);
      if (m) {
        const e = index.get(m[1]) || { issued: 0, returned: 0 };
        e.issued = round4(e.issued + (Number(t.quantity) || 0));
        index.set(m[1], e);
        continue;
      }
      m = RETURN.exec(reason);
      if (m) {
        const e = index.get(m[1]) || { issued: 0, returned: 0 };
        e.returned = round4(e.returned + (Number(t.quantity) || 0));
        index.set(m[1], e);
      }
    }
  }
  return index;
}

/**
 * Which WRITE PATH produced an embedded stock transaction.
 *
 * The movement rows carry no source-path field, so the writer is inferred
 * from the `reason` string each route stamps. These signatures are read off
 * the routes themselves (S1–S10 in docs/audits/store-purchase-baseline.md);
 * anything unrecognised is reported as UNCLASSIFIED rather than guessed at,
 * because a reason is free text on two of the paths and a user can type
 * anything into it.
 */
const REASON_SIGNATURES = [
  { path: "S1_PO_RECEIPT", test: (r) => /^Purchase Order Delivery/.test(r) },
  { path: "S2_VENDOR_RETURN_DEDUCT", test: (r) => /^Return request —/.test(r) },
  { path: "S3_VENDOR_REPLACEMENT_RECEIPT", test: (r) => /^Return receipt from vendor/.test(r) },
  { path: "S4_MRF_ISSUE", test: (r) => /^MRF Issue — /.test(r) },
  { path: "S5_MRF_RETURN", test: (r) => /^MRF Return — /.test(r) },
  { path: "S8_VARIANT_ADD_STOCK_DEFAULT", test: (r) => /^Stock Addition from Purchase$/.test(r) },
  { path: "S9_VARIANT_REDUCE_STOCK_DEFAULT", test: (r) => /^Stock Consumption$/.test(r) },
  { path: "S10_MANUFACTURING_ISSUANCE_DEFAULT", test: (r) => /^Stock (Debit|Credit)$/.test(r) },
];

function classifyTransactionPath(txn) {
  const reason = String(txn.reason || "").trim();
  // A PO id is harder evidence than any string, so it wins where present.
  if (txn.purchaseOrderId && !/^Return/.test(reason)) return "S1_PO_RECEIPT";
  for (const sig of REASON_SIGNATURES) if (sig.test(reason)) return sig.path;
  return reason ? "UNCLASSIFIED_WITH_REASON" : "UNCLASSIFIED_NO_REASON";
}

// ─────────────────────────────────────────────────────────────────────────────
// Orphan references
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A reference is an ORPHAN only when it is present (non-null) and its target
 * does not exist. Null/absent references are legal legacy state and are
 * tallied as `unlinked`, never as orphans.
 */
function findOrphans({ docs, pick, targets, refName }) {
  const targetIds = targets instanceof Set ? targets : new Set(targets.map((t) => String(t._id)));
  let linked = 0;
  let unlinked = 0;
  const orphans = [];
  for (const doc of docs) {
    for (const { id, where } of pick(doc)) {
      if (id === null || id === undefined || String(id) === "") {
        unlinked += 1;
        continue;
      }
      if (targetIds.has(String(id))) linked += 1;
      else orphans.push({ from: String(doc._id), where, missing: String(id) });
    }
  }
  orphans.sort((a, b) => a.from.localeCompare(b.from) || a.missing.localeCompare(b.missing));
  return { refName, linked, unlinked, orphanCount: orphans.length, orphans };
}

/**
 * Variant references are two-level: a document names a RawItem AND a
 * `variantId` inside that item's `variants[]`. A variant id is only
 * checkable when its parent item exists, so three outcomes are reported and
 * never conflated:
 *
 *   linked          — parent found, variant id present in parent.variants[]
 *   orphanCount     — parent found, variant id NOT in it (a real dangling ref)
 *   parentMissing   — parent item itself is gone; the variant is
 *                     UNVERIFIABLE here and is already counted by the
 *                     corresponding rawItem orphan check
 *   unlinked        — no variantId at all, which is the ordinary state of a
 *                     non-variant line and never a fault
 */
function findVariantOrphans({ docs, pick, variantIndex, refName }) {
  let linked = 0;
  let unlinked = 0;
  let parentMissing = 0;
  const orphans = [];
  for (const doc of docs) {
    for (const { rawItemId, variantId, where } of pick(doc)) {
      if (variantId === null || variantId === undefined || String(variantId) === "") {
        unlinked += 1;
        continue;
      }
      const parent = rawItemId ? variantIndex.get(String(rawItemId)) : undefined;
      if (!parent) {
        parentMissing += 1;
        continue;
      }
      if (parent.has(String(variantId))) linked += 1;
      else orphans.push({ from: String(doc._id), where, missing: String(variantId), rawItem: String(rawItemId) });
    }
  }
  orphans.sort((a, b) => a.from.localeCompare(b.from) || a.missing.localeCompare(b.missing));
  return { refName, linked, unlinked, parentMissing, orphanCount: orphans.length, orphans };
}

/** rawItemId → Set(variantId) for every raw item gathered. */
function buildVariantIndex(rawItems) {
  const index = new Map();
  for (const item of rawItems) {
    index.set(
      String(item._id),
      new Set((item.variants || []).map((v) => String(v._id)).filter((id) => id && id !== "undefined")),
    );
  }
  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Company scoping
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Scoping is checked on the DOCUMENTS, not the schemas — several of these
 * models use `strict:false`, so a field can be present in data that the
 * schema never declared, and absent in data on a model that does declare it.
 *
 * `companyId` and `siteId` are reported SEPARATELY because they answer
 * different questions: which books a record belongs to, and which physical
 * site it happened at. `declaresCompanyId` records what the schema promises,
 * so "the model has the field but 0 documents carry it" is distinguishable
 * from "the model has no such field at all".
 *
 * Today exactly one collection in this domain declares `companyId`
 * (spendrequests, ref Acc_Company) and NO collection declares `siteId` — an
 * earlier version of this report claimed no collection was scoped at all,
 * which was wrong about SpendRequest.
 */
function scopePresence(name, docs, { declaresCompanyId = false, declaresSiteId = false } = {}) {
  const has = (d, f) => d[f] !== undefined && d[f] !== null && String(d[f]) !== "";
  return {
    collection: name,
    documents: docs.length,
    declaresCompanyId,
    declaresSiteId,
    withCompanyId: docs.filter((d) => has(d, "companyId")).length,
    withSiteId: docs.filter((d) => has(d, "siteId")).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

const LIST_CAP = 50; // full counts always reported; document lists are capped

function capped(list) {
  return { total: list.length, shown: Math.min(list.length, LIST_CAP), items: list.slice(0, LIST_CAP) };
}

/**
 * @param {object} data — plain lean documents per collection. All optional;
 *   missing collections are treated as empty (and reported as such).
 * @param {string|Date} data.now — REQUIRED. The clock, injected.
 */
function computeBaselineReport(data) {
  const {
    now,
    rawItems = [],
    operationalPOs = [],
    storePOs = [],
    mrfs = [],
    requisitions = [],
    stockIssuances = [],
    stockLedgers = [],
    intakeRequests = [],
    spendRequests = [],
    rawItemAddRequests = [],
    barcodes = [],
    stockItems = [],
    vendors = [],
    warehouses = [],
    units = [],
    /* Optional and NULLABLE by design. `null` means "not gathered / not
     * deployed", which the item-master report distinguishes from `[]`
     * ("deployed and empty") — the difference between unknown coverage and
     * zero coverage, and between a complete company universe and an
     * incomplete one. */
    itemCategoryBudgets = null,
    ledgers = null,
    companies = null,
  } = data;
  if (!now) throw new Error("computeBaselineReport requires `now` (injected clock)");

  // ── A. Collection counts ──────────────────────────────────────────────────
  const collections = {
    rawItems: rawItems.length,
    operationalPurchaseOrders: operationalPOs.length,
    worksheetPurchaseOrders: storePOs.length,
    mrfs: mrfs.length,
    requisitions: requisitions.length,
    stockIssuances: stockIssuances.length,
    stockLedgerEntries: stockLedgers.length,
    intakeRequests: intakeRequests.length,
    spendRequests: spendRequests.length,
    rawItemAddRequests: rawItemAddRequests.length,
    barcodes: barcodes.length,
    stockItems: stockItems.length,
    vendors: vendors.length,
    warehouses: warehouses.length,
    units: units.length,
  };

  // ── B. The two PO systems ─────────────────────────────────────────────────
  const purchaseOrders = {
    operational: {
      count: operationalPOs.length,
      statuses: countBy(operationalPOs, (po) => po.status),
      paymentStatuses: countBy(operationalPOs, (po) => po.paymentStatus),
      withSpendRequestLink: operationalPOs.filter((po) => po.spendRequestId).length,
      emergencyOrders: operationalPOs.filter((po) => po.isEmergencyOrder === true).length,
      withPayments: operationalPOs.filter((po) => (po.payments || []).length > 0).length,
      ...recencyBuckets(operationalPOs, now),
    },
    worksheet: {
      count: storePOs.length,
      statuses: countBy(storePOs, (po) => po.status),
      ...recencyBuckets(storePOs, now),
    },
    duplicatePoNumbers: {
      operational: exactDuplicates(operationalPOs, (po) => po.poNumber),
      worksheet: exactDuplicates(storePOs, (po) => po.poNumber),
      acrossSystems: (() => {
        const a = new Set(operationalPOs.map((po) => String(po.poNumber || "").trim()).filter(Boolean));
        return sortStrings(
          [...new Set(storePOs.map((po) => String(po.poNumber || "").trim()))].filter((n) => n && a.has(n)),
        );
      })(),
    },
    // IntakeRequest and Requisition BOTH mint "REQ-YYMM-####" numbers from
    // independent counters, so the same human-readable number can name two
    // different documents. Counted, not judged.
    reqNumberCollisions: (() => {
      const intakeNums = new Set(
        intakeRequests.map((r) => String(r.requestNumber || "").trim()).filter(Boolean),
      );
      return sortStrings(
        [...new Set(requisitions.map((r) => String(r.requisitionNumber || "").trim()))].filter(
          (n) => n && intakeNums.has(n),
        ),
      );
    })(),
  };

  // ── C. Request/demand doors ───────────────────────────────────────────────
  const requestDoors = {
    intakeRequests: {
      count: intakeRequests.length,
      statuses: countBy(intakeRequests, (r) => r.status),
      ...recencyBuckets(intakeRequests, now),
    },
    mrfs: {
      count: mrfs.length,
      statuses: countBy(mrfs, (r) => r.status),
      creationModes: countBy(mrfs, (r) => r.creationMode),
      fromIntakeDesk: mrfs.filter((r) => r.intakeRequestId).length,
      withSpendRequestLink: mrfs.filter((r) => r.spendRequestId).length,
      linesWithPurchaseFormRaised: mrfs.reduce(
        (s, r) => s + (r.items || []).filter((i) => i.purchaseFormRaised).length,
        0,
      ),
      ...recencyBuckets(mrfs, now),
    },
    spendRequests: {
      count: spendRequests.length,
      statuses: countBy(spendRequests, (r) => r.status),
      ...recencyBuckets(spendRequests, now),
    },
    rawItemAddRequests: {
      count: rawItemAddRequests.length,
      statuses: countBy(rawItemAddRequests, (r) => r.approvalStatus || r.status),
      ...recencyBuckets(rawItemAddRequests, now),
    },
    requisitions: {
      count: requisitions.length,
      statuses: countBy(requisitions, (r) => r.status),
      withPurchaseOrderLink: requisitions.filter((r) => r.purchaseOrder).length,
      withSourceMrfLink: requisitions.filter((r) => r.sourceMrfId).length,
      ...recencyBuckets(requisitions, now),
    },
  };

  // ── D. Stock-update paths, as recorded ────────────────────────────────────
  const allTxns = rawItems.flatMap((i) => i.stockTransactions || []);
  // Items whose balance can only have arrived without a movement: an opening
  // quantity with no history at all. These are the clearest evidence of the
  // unmeasurable paths below, and the only part of them that IS countable.
  const itemsWithBalanceAndNoHistory = rawItems.filter(
    (i) => (Number(i.quantity) || 0) !== 0 && (i.stockTransactions || []).length === 0,
  ).length;

  const stockWritePaths = {
    embeddedStockTransactions: {
      total: allTxns.length,
      byType: countBy(allTxns, (t) => t.type),
      withPurchaseOrderRef: allTxns.filter((t) => t.purchaseOrderId).length,
      mrfIssueOrReturn: allTxns.filter((t) => /^MRF (Issue|Return) — /.test(String(t.reason || ""))).length,
      // Which writer produced each movement, inferred from its reason
      // signature. UNCLASSIFIED_* are not errors — two paths let a user type
      // the reason, so a free-text reason is expected and simply cannot be
      // attributed.
      byWritePath: countBy(allTxns, classifyTransactionPath),
      withPerformedBy: allTxns.filter((t) => t.performedBy).length,
    },
    // ── Paths that leave NO row to count ───────────────────────────────────
    // Reported as measurement limits, not as zeros: a zero here would read
    // as "this never happens", and the truth is "this happens and is not
    // recorded".
    unmeasurablePaths: {
      note:
        "These write paths change stock without writing a movement row, so their usage CANNOT be counted from stored data — historically or now. Only their side effects are visible.",
      paths: [
        {
          path: "S7_DIRECT_QUANTITY_EDIT",
          route: "PUT /api/cms/raw-items/:id",
          effect: "Sets quantity / variants[].quantity straight from the request body.",
          measurable: false,
          evidenceAvailable:
            "None per event. Its cumulative effect appears as items whose balance disagrees with their movement history (rawItemReconciliation.drifted).",
        },
        {
          path: "S12_INITIAL_BALANCE",
          route: "POST /api/cms/raw-items (and MRF register / legacy product approve)",
          effect: "Opening quantities are stored with no opening transaction.",
          measurable: false,
          evidenceAvailable:
            "Partially: items holding a non-zero balance with no movement history at all are counted below.",
          itemsWithBalanceAndNoHistory,
        },
        {
          path: "S11_HARD_DELETE",
          route: "DELETE /api/cms/raw-items/:id",
          effect: "Removes the item and its entire embedded movement history.",
          measurable: false,
          evidenceAvailable:
            "None. Deleted items leave no tombstone; documents still referencing them appear as orphan rawItem references.",
        },
        {
          path: "S6_LEDGER_CORRECTION_REWRITE",
          route: "PATCH /api/cms/inventory/stock-ledger/:rawItemId/txn/:txnId/edit",
          effect: "Rewrites an existing transaction's quantity in place; the delta lives only in the StockLedger COMPENSATING entry.",
          measurable: true,
          evidenceAvailable: "stockLedger.byTxnType.COMPENSATING and stockLedger.edited below.",
        },
      ],
    },
    stockIssuances: {
      total: stockIssuances.length,
      byDirection: countBy(stockIssuances, (s) => s.direction),
      withManufacturingOrder: stockIssuances.filter((s) => s.manufacturingOrder).length,
    },
    stockLedger: {
      total: stockLedgers.length,
      byTxnType: countBy(stockLedgers, (l) => l.txnType),
      voided: stockLedgers.filter((l) => l.isVoided).length,
      edited: stockLedgers.filter((l) => l.isEdited).length,
    },
  };

  // ── E. Raw-item balance reconciliation ────────────────────────────────────
  const rawItemResults = rawItems
    .map(reconcileRawItem)
    .sort((a, b) => a.sku.localeCompare(b.sku) || a.id.localeCompare(b.id));
  const rawItemReconciliation = {
    totalItems: rawItemResults.length,
    reconciled: rawItemResults.filter((r) => r.status === "RECONCILED").length,
    drifted: rawItemResults.filter((r) => r.status === "DRIFTED").length,
    noHistory: rawItemResults.filter((r) => r.status === "NO_HISTORY").length,
    signedSumMatches: rawItemResults.filter((r) => r.matchesSignedSum).length,
    variantSumMismatches: capped(
      rawItemResults.filter((r) => !r.variantSumMatches).map(({ id, sku, quantity, variantQuantitySum }) => ({ id, sku, quantity, variantQuantitySum })),
    ),
    driftedItems: capped(
      rawItemResults
        .filter((r) => r.status === "DRIFTED")
        .map(({ id, sku, quantity, latestNewQuantity, signedSum, transactionCount }) => ({
          id, sku, quantity, latestNewQuantity, signedSum, transactionCount,
        })),
    ),
  };

  // ── F. PO receipt reconciliation (operational only — the worksheet PO has
  //       no quantities-received concept at all, which is itself a finding) ──
  const poResults = operationalPOs
    .map(reconcileOperationalPO)
    .sort((a, b) => a.poNumber.localeCompare(b.poNumber) || a.id.localeCompare(b.id));
  const poReceiptReconciliation = {
    totalPOs: poResults.length,
    reconciled: poResults.filter((r) => r.reconciled).length,
    unreconciled: capped(poResults.filter((r) => !r.reconciled)),
  };

  // ── G. MRF reconciliation ─────────────────────────────────────────────────
  const mrfResults = mrfs
    .map(reconcileMrf)
    .sort((a, b) => a.mrfNumber.localeCompare(b.mrfNumber) || a.id.localeCompare(b.id));
  const stockIdx = mrfStockMovementIndex(rawItems);
  const mrfStockCrossChecks = mrfResults.map((r) => {
    const stock = stockIdx.get(r.mrfNumber) || { issued: 0, returned: 0 };
    // Only lines whose unit === baseUnit are quantity-comparable against the
    // base-unit stock records; others are flagged, not judged.
    const comparable = r.lines.every((l) => l.unitsComparable);
    const lineIssued = round4(r.lines.reduce((s, l) => s + l.issuedQty, 0));
    const lineReturned = round4(r.lines.reduce((s, l) => s + l.returnedQty, 0));
    return {
      id: r.id,
      mrfNumber: r.mrfNumber,
      comparable,
      lineIssued,
      lineReturned,
      stockIssued: stock.issued,
      stockReturned: stock.returned,
      stockMatches:
        comparable && approxEqual(lineIssued, stock.issued) && approxEqual(lineReturned, stock.returned),
      // An MRF that issued stock but has NO matching stock transactions at
      // all predates the reason-tagging convention — a limitation, not rot.
      noStockRecords: lineIssued > EPS && stock.issued === 0 && stock.returned === 0,
    };
  });
  const mrfReconciliation = {
    totalMrfs: mrfResults.length,
    internallyReconciled: mrfResults.filter((r) => r.reconciled).length,
    withLegacyHistoryGaps: mrfResults.filter((r) => r.hasLegacyHistoryGaps).length,
    internallyUnreconciled: capped(mrfResults.filter((r) => !r.reconciled)),
    stockCrossCheck: {
      comparable: mrfStockCrossChecks.filter((c) => c.comparable).length,
      unitNotComparable: mrfStockCrossChecks.filter((c) => !c.comparable).length,
      stockMatches: mrfStockCrossChecks.filter((c) => c.stockMatches).length,
      noStockRecords: mrfStockCrossChecks.filter((c) => c.noStockRecords).length,
      mismatches: capped(
        mrfStockCrossChecks.filter((c) => c.comparable && !c.stockMatches && !c.noStockRecords),
      ),
    },
  };

  // ── H. Orphan references ──────────────────────────────────────────────────
  const rawItemIds = new Set(rawItems.map((d) => String(d._id)));
  const vendorIds = new Set(vendors.map((d) => String(d._id)));
  const opPoIds = new Set(operationalPOs.map((d) => String(d._id)));
  const spendIds = new Set(spendRequests.map((d) => String(d._id)));
  const intakeIds = new Set(intakeRequests.map((d) => String(d._id)));
  const mrfIds = new Set(mrfs.map((d) => String(d._id)));

  const orphanReferences = [
    findOrphans({
      refName: "operationalPO.items[].rawItem → RawItem",
      docs: operationalPOs, targets: rawItemIds,
      pick: (po) => (po.items || []).map((i) => ({ id: i.rawItem, where: "items[].rawItem" })),
    }),
    findOrphans({
      refName: "operationalPO.vendor → Vendor",
      docs: operationalPOs, targets: vendorIds,
      pick: (po) => [{ id: po.vendor, where: "vendor" }],
    }),
    findOrphans({
      refName: "operationalPO.spendRequestId → SpendRequest",
      docs: operationalPOs, targets: spendIds,
      pick: (po) => [{ id: po.spendRequestId, where: "spendRequestId" }],
    }),
    findOrphans({
      refName: "mrf.items[].rawItem → RawItem",
      docs: mrfs, targets: rawItemIds,
      pick: (m) => (m.items || []).map((i) => ({ id: i.rawItem, where: "items[].rawItem" })),
    }),
    findOrphans({
      refName: "mrf.intakeRequestId → IntakeRequest",
      docs: mrfs, targets: intakeIds,
      pick: (m) => [{ id: m.intakeRequestId, where: "intakeRequestId" }],
    }),
    findOrphans({
      refName: "mrf.spendRequestId → SpendRequest",
      docs: mrfs, targets: spendIds,
      pick: (m) => [{ id: m.spendRequestId, where: "spendRequestId" }],
    }),
    findOrphans({
      refName: "requisition.purchaseOrder → operational PO",
      docs: requisitions, targets: opPoIds,
      pick: (r) => [{ id: r.purchaseOrder, where: "purchaseOrder" }],
    }),
    findOrphans({
      refName: "requisition.sourceMrfId → MRF",
      docs: requisitions, targets: mrfIds,
      // sourceMrfId may legitimately point at a legacy product-request doc
      // rather than an MRF (the model deliberately sets no ref) — orphans
      // here are CANDIDATES for that, not corruption. See limitations.
      pick: (r) => [{ id: r.sourceMrfId, where: "sourceMrfId" }],
    }),
    findOrphans({
      refName: "rawItem.stockTransactions[].purchaseOrderId → operational PO",
      docs: rawItems, targets: opPoIds,
      pick: (i) => (i.stockTransactions || []).map((t) => ({ id: t.purchaseOrderId, where: "stockTransactions[].purchaseOrderId" })),
    }),
    findOrphans({
      refName: "rawItem.primaryVendor → Vendor",
      docs: rawItems, targets: vendorIds,
      pick: (i) => [{ id: i.primaryVendor, where: "primaryVendor" }],
    }),
    findOrphans({
      refName: "stockLedger.rawItem → RawItem",
      docs: stockLedgers, targets: rawItemIds,
      pick: (l) => [{ id: l.rawItem, where: "rawItem" }],
    }),
    findOrphans({
      refName: "stockLedger.mrfId → MRF",
      docs: stockLedgers, targets: mrfIds,
      pick: (l) => [{ id: l.mrfId, where: "mrfId" }],
    }),
    findOrphans({
      refName: "stockIssuance.items[].rawItem → RawItem",
      docs: stockIssuances, targets: rawItemIds,
      pick: (s) => (s.items || []).map((i) => ({ id: i.rawItem, where: "items[].rawItem" })),
    }),
    findOrphans({
      refName: "rawItem.alternateVendors[] → Vendor",
      docs: rawItems, targets: vendorIds,
      pick: (i) => (i.alternateVendors || []).map((v) => ({ id: v, where: "alternateVendors[]" })),
    }),
    findOrphans({
      refName: "rawItem.variants[].vendorNicknames[].vendor → Vendor",
      docs: rawItems, targets: vendorIds,
      pick: (i) =>
        (i.variants || []).flatMap((v) =>
          (v.vendorNicknames || []).map((n) => ({ id: n.vendor, where: "variants[].vendorNicknames[].vendor" })),
        ),
    }),
    findOrphans({
      refName: "rawItem.stockTransactions[].supplierId → Vendor",
      docs: rawItems, targets: vendorIds,
      pick: (i) => (i.stockTransactions || []).map((t) => ({ id: t.supplierId, where: "stockTransactions[].supplierId" })),
    }),
    findOrphans({
      refName: "stockLedger.vendorId → Vendor",
      docs: stockLedgers, targets: vendorIds,
      pick: (l) => [{ id: l.vendorId, where: "vendorId" }],
    }),
    findOrphans({
      refName: "stockLedger.purchaseOrderId → operational PO",
      docs: stockLedgers, targets: opPoIds,
      pick: (l) => [{ id: l.purchaseOrderId, where: "purchaseOrderId" }],
    }),
    findOrphans({
      refName: "barcode.rawItem → RawItem",
      docs: barcodes, targets: rawItemIds,
      pick: (b) => [{ id: b.rawItem, where: "rawItem" }],
    }),
    findOrphans({
      refName: "barcode.purchaseOrder → operational PO",
      docs: barcodes, targets: opPoIds,
      pick: (b) => [{ id: b.purchaseOrder, where: "purchaseOrder" }],
    }),
    findOrphans({
      refName: "barcode.vendor → Vendor",
      docs: barcodes, targets: vendorIds,
      pick: (b) => [{ id: b.vendor, where: "vendor" }],
    }),
    findOrphans({
      refName: "spendRequest.purchaseOrderId → operational PO",
      docs: spendRequests, targets: opPoIds,
      pick: (r) => [{ id: r.purchaseOrderId, where: "purchaseOrderId" }],
    }),
    findOrphans({
      refName: "spendRequest.sourceMrfId → MRF",
      docs: spendRequests, targets: mrfIds,
      pick: (r) => [{ id: r.sourceMrfId, where: "sourceMrfId" }],
    }),
    findOrphans({
      refName: "intakeRequest.mrfId → MRF",
      docs: intakeRequests, targets: mrfIds,
      pick: (r) => [{ id: r.mrfId, where: "mrfId" }],
    }),
    findOrphans({
      refName: "intakeRequest.spendRequestId → SpendRequest",
      docs: intakeRequests, targets: spendIds,
      pick: (r) => [{ id: r.spendRequestId, where: "spendRequestId" }],
    }),
  ].map((r) => ({ ...r, orphans: capped(r.orphans) }));

  // ── H2. Variant references, checked against the parent item's variants ────
  const variantIndex = buildVariantIndex(rawItems);
  const variantOrphanReferences = [
    findVariantOrphans({
      refName: "operationalPO.items[].variantId → RawItem.variants[]",
      docs: operationalPOs, variantIndex,
      pick: (po) => (po.items || []).map((i) => ({ rawItemId: i.rawItem, variantId: i.variantId, where: "items[].variantId" })),
    }),
    findVariantOrphans({
      refName: "mrf.items[].variantId → RawItem.variants[]",
      docs: mrfs, variantIndex,
      pick: (m) => (m.items || []).map((i) => ({ rawItemId: i.rawItem, variantId: i.variantId, where: "items[].variantId" })),
    }),
    findVariantOrphans({
      refName: "stockIssuance.items[].variantId → RawItem.variants[]",
      docs: stockIssuances, variantIndex,
      pick: (s) => (s.items || []).map((i) => ({ rawItemId: i.rawItem, variantId: i.variantId, where: "items[].variantId" })),
    }),
    findVariantOrphans({
      refName: "stockLedger.variantId → RawItem.variants[]",
      docs: stockLedgers, variantIndex,
      pick: (l) => [{ rawItemId: l.rawItem, variantId: l.variantId, where: "variantId" }],
    }),
    findVariantOrphans({
      refName: "barcode.variantId → RawItem.variants[]",
      docs: barcodes, variantIndex,
      pick: (b) => [{ rawItemId: b.rawItem, variantId: b.variantId, where: "variantId" }],
    }),
    findVariantOrphans({
      // The movement history's own variant pointers, checked against the
      // item that CONTAINS them — a variant deleted by a raw-item edit
      // leaves its past movements pointing at nothing.
      refName: "rawItem.stockTransactions[].variantId → own RawItem.variants[]",
      docs: rawItems, variantIndex,
      pick: (i) =>
        (i.stockTransactions || []).map((t) => ({
          rawItemId: i._id, variantId: t.variantId, where: "stockTransactions[].variantId",
        })),
    }),
  ].map((r) => ({ ...r, orphans: capped(r.orphans) }));

  // ── H3. What cannot be checked at all ─────────────────────────────────────
  // Stated rather than silently omitted: an absent reference cannot be
  // validated, and its absence is the finding.
  const uncheckableReferences = [
    {
      reference: "warehouse / storage location on any stock-bearing document",
      reason:
        "No operational document in this domain carries a warehouse or location reference. RawItem, its variants, its stockTransactions, both PurchaseOrder models, MRF, StockIssuance, StockLedger and Barcode all store quantities with no place attached, so warehouse orphan validation is IMPOSSIBLE — not clean. Warehouse records exist only as standalone configuration.",
      warehousesConfigured: warehouses.length,
    },
    {
      reference: "MRF → stock movement",
      reason:
        "Stock transactions carry no mrfId. The join exists only as the free-text reason 'MRF Issue — <mrfNumber>' / 'MRF Return — <mrfNumber>', so a movement whose reason was edited or which predates the convention cannot be attributed to its request.",
    },
    {
      reference: "per-item delivery quantity on an operational PO",
      reason:
        "deliveries[] stores one aggregate quantityReceived per delivery event with no item breakdown, so which item arrived in which delivery is unrecoverable from stored data.",
    },
    {
      reference: "unit / category identity on RawItem",
      reason:
        "Items reference units and categories by free text (unit/customUnit, category/customCategory), not by id. There is no Category collection at all, so these cannot be orphan-checked — only duplicate-candidate grouped.",
    },
  ];

  // ── I. Duplicate identity candidates ──────────────────────────────────────
  const variantSkus = rawItems.flatMap((i) => (i.variants || []).map((v) => v.sku).filter(Boolean));
  // Each entry separates the two collisions: exact repeats of one spelling,
  // and one identity written several ways. `totalOccurrences` counts
  // documents, `groups` counts identities.
  const duplicates = {
    rawItemSkus: summariseDuplicates(duplicateCandidates(rawItems.map((i) => i.sku))),
    variantSkus: summariseDuplicates(duplicateCandidates(variantSkus)),
    categories: summariseDuplicates(
      duplicateCandidates(rawItems.flatMap((i) => [i.category, i.customCategory]).filter(Boolean)),
    ),
    units: summariseDuplicates(
      duplicateCandidates([
        ...units.map((u) => u.name),
        ...rawItems.flatMap((i) => [i.unit, i.customUnit]).filter(Boolean),
      ]),
    ),
    vendorNames: summariseDuplicates(duplicateCandidates(vendors.map((v) => v.companyName))),
    // GSTIN is a formal identifier: case-folding it would be wrong, so this
    // one stays an exact-value check.
    vendorGstNumbers: exactDuplicates(vendors, (v) => v.gstNumber),
  };

  // ── J. Company scoping ────────────────────────────────────────────────────
  // Every collection the runner gathers is reported — including the three
  // request doors, which the first version of this report omitted entirely.
  // `declaresCompanyId` mirrors the schema as it stands today.
  const companyScoping = [
    scopePresence("rawitems", rawItems),
    scopePresence("purchaseorders (operational)", operationalPOs),
    scopePresence("storepurchaseorders (worksheet)", storePOs),
    scopePresence("mrves (material requests)", mrfs),
    scopePresence("requisitions", requisitions),
    scopePresence("stockissuances", stockIssuances),
    scopePresence("stockledger", stockLedgers),
    scopePresence("intakerequests", intakeRequests),
    // The one company-scoped model in the domain.
    scopePresence("spendrequests", spendRequests, { declaresCompanyId: true }),
    scopePresence("rawitemaddrequests", rawItemAddRequests),
    scopePresence("barcodes", barcodes),
    scopePresence("stockitems", stockItems),
    scopePresence("vendors", vendors),
    scopePresence("warehouses", warehouses),
    scopePresence("units", units),
  ];
  const scopeSummary = {
    collectionsGathered: companyScoping.length,
    collectionsDeclaringCompanyId: companyScoping.filter((c) => c.declaresCompanyId).length,
    collectionsDeclaringSiteId: companyScoping.filter((c) => c.declaresSiteId).length,
    documentsWithCompanyId: companyScoping.reduce((s, c) => s + c.withCompanyId, 0),
    documentsWithSiteId: companyScoping.reduce((s, c) => s + c.withSiteId, 0),
  };

  // ── K. Known limitations — printed with every report ──────────────────────
  const limitations = [
    "RawItem quantity can be edited directly (PUT /api/cms/inventory/raw-items/:id) without writing a stock transaction, so DRIFTED items may reflect legitimate-but-unrecorded edits. The data cannot distinguish an unrecorded edit from a lost movement.",
    "Items with NO_HISTORY have no embedded transactions to reconcile against; their balances are unverifiable from movement data.",
    "MRF line quantities are stored in the requester's unit; stock transactions are in the catalogue base unit. Cross-checks are only quantity-compared where the two units are equal.",
    "MRFs and raw items that predate issueHistory/reason-tagging conventions legitimately lack matching records; they are counted as legacy gaps, not mismatches.",
    "The worksheet PO system (storepurchaseorders) records no received quantities or stock effects; nothing about it can be reconciled to stock, by design of the legacy model.",
    "Requisition.sourceMrfId may point at a legacy product-request document rather than an MRF (the model sets no ref); such ids appear as orphan CANDIDATES against the MRF collection.",
    "StockLedger holds only compensating/edit entries; the primary movement history is embedded in RawItem.stockTransactions.",
    "Company scope is uneven, not absent: SpendRequest declares companyId (ref Acc_Company) and is the only Store/Purchase model that does. Every other gathered collection — including IntakeRequest and RawItemAddRequest — has no companyId in its schema, and NO collection in this domain declares siteId. companyId and siteId presence is therefore reported per collection and separately, on documents rather than schemas (several models use strict:false).",
    "Warehouse/location orphan validation is impossible rather than clean: no stock-bearing document stores a warehouse or location reference at all. See uncheckableReferences.",
    "Variant references are only verifiable where the parent RawItem still exists; where it does not, the variant is counted as parentMissing and the missing parent is reported by the corresponding rawItem orphan check.",
    "Which write path produced an embedded movement is INFERRED from its reason string (no source-path field exists); two paths accept a user-typed reason, so UNCLASSIFIED entries are expected and are not faults.",
    "Direct quantity edits (S7), opening balances (S12) and hard deletes (S11) write no movement row, so their usage cannot be counted historically or now — only their side effects are visible. They are reported as unmeasurable paths, never as zero usage.",
  ];

  return {
    generatedAt: new Date(now).toISOString(),
    collections,
    purchaseOrders,
    requestDoors,
    stockWritePaths,
    rawItemReconciliation,
    poReceiptReconciliation,
    mrfReconciliation,
    // Item Master addendum — the catalogue's own identity, hygiene and
    // reference integrity, measured for the Chunk 2 decomposition.
    itemMaster: computeItemMasterReport({
      rawItems, stockItems, units, vendors, barcodes,
      operationalPOs, mrfs, stockIssuances, stockLedgers,
      // Optional and NULLABLE: null means "not gathered / not deployed",
      // which the item-master report distinguishes from "deployed and
      // empty". Forwarding them is what lets budget coverage be
      // company-safe and the company universe complete.
      itemCategoryBudgets, ledgers, companies,
    }),
    orphanReferences,
    variantOrphanReferences,
    uncheckableReferences,
    duplicates,
    companyScoping,
    scopeSummary,
    limitations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable rendering (pure string building; no console here)
// ─────────────────────────────────────────────────────────────────────────────

function renderSummary(report) {
  const L = [];
  const push = (s = "") => L.push(s);
  push(`Store & Purchase baseline audit — generated ${report.generatedAt}`);
  push("READ-ONLY report. Nothing was modified.");
  push("");
  push("── Collections ──");
  for (const [k, v] of Object.entries(report.collections)) push(`  ${k}: ${v}`);
  push("");
  const op = report.purchaseOrders.operational;
  const ws = report.purchaseOrders.worksheet;
  push("── Purchase order systems ──");
  push(`  Operational (purchaseorders): ${op.count} docs, ${op.createdLast90Days} created in last 90d`);
  push(`    statuses: ${JSON.stringify(op.statuses)}`);
  push(`    linked to a SpendRequest: ${op.withSpendRequestLink}; carrying payments: ${op.withPayments}; emergency: ${op.emergencyOrders}`);
  push(`  Worksheet (storepurchaseorders): ${ws.count} docs, ${ws.createdLast90Days} created in last 90d`);
  push(`    statuses: ${JSON.stringify(ws.statuses)}`);
  push(`  PO numbers duplicated across the two systems: ${report.purchaseOrders.duplicatePoNumbers.acrossSystems.length}`);
  push("");
  push("── Request doors (created last 90 days / total) ──");
  const rd = report.requestDoors;
  push(`  IntakeRequest: ${rd.intakeRequests.createdLast90Days} / ${rd.intakeRequests.count}`);
  push(`  MRF: ${rd.mrfs.createdLast90Days} / ${rd.mrfs.count} (from intake desk: ${rd.mrfs.fromIntakeDesk})`);
  push(`  SpendRequest: ${rd.spendRequests.createdLast90Days} / ${rd.spendRequests.count}`);
  push(`  RawItemAddRequest (legacy): ${rd.rawItemAddRequests.createdLast90Days} / ${rd.rawItemAddRequests.count}`);
  push(`  Requisition (purchase form): ${rd.requisitions.createdLast90Days} / ${rd.requisitions.count} (→PO links: ${rd.requisitions.withPurchaseOrderLink})`);
  push("");
  push("── Stock write paths (as recorded) ──");
  const sw = report.stockWritePaths;
  push(`  Embedded stock transactions: ${sw.embeddedStockTransactions.total} — by type ${JSON.stringify(sw.embeddedStockTransactions.byType)}`);
  push(`  StockIssuance batches: ${sw.stockIssuances.total} ${JSON.stringify(sw.stockIssuances.byDirection)}`);
  push(`  StockLedger (corrections only): ${sw.stockLedger.total} ${JSON.stringify(sw.stockLedger.byTxnType)}`);
  push("");
  push("── Reconciliation ──");
  const rr = report.rawItemReconciliation;
  push(`  Raw items: ${rr.reconciled} reconciled, ${rr.drifted} drifted, ${rr.noHistory} without history (of ${rr.totalItems})`);
  push(`  Variant-sum mismatches: ${rr.variantSumMismatches.total}`);
  const pr = report.poReceiptReconciliation;
  push(`  Operational POs: ${pr.reconciled} of ${pr.totalPOs} internally consistent; ${pr.unreconciled.total} not`);
  const mr = report.mrfReconciliation;
  push(`  MRFs: ${mr.internallyReconciled} of ${mr.totalMrfs} internally consistent; legacy history gaps on ${mr.withLegacyHistoryGaps}`);
  push(`  MRF↔stock cross-check: ${mr.stockCrossCheck.stockMatches} match, ${mr.stockCrossCheck.mismatches.total} mismatch, ${mr.stockCrossCheck.noStockRecords} with no stock records (legacy), ${mr.stockCrossCheck.unitNotComparable} not unit-comparable`);
  push("");
  push("── Orphan references (non-null links to missing documents) ──");
  for (const o of report.orphanReferences) {
    push(`  ${o.refName}: ${o.orphanCount} orphans (${o.linked} linked, ${o.unlinked} unlinked/legacy)`);
  }
  push("");
  push("── Variant references (checked against the parent item's variants) ──");
  for (const o of report.variantOrphanReferences) {
    push(`  ${o.refName}: ${o.orphanCount} orphans (${o.linked} linked, ${o.unlinked} no variant named, ${o.parentMissing} parent item missing → unverifiable)`);
  }
  push("");
  push("── References that CANNOT be validated at all ──");
  for (const u of report.uncheckableReferences) push(`  ${u.reference}: ${u.reason}`);
  push("");
  push("── Unmeasurable stock-write paths (no row is written; usage is uncountable) ──");
  for (const u of report.stockWritePaths.unmeasurablePaths.paths.filter((x) => !x.measurable)) {
    push(`  ${u.path} (${u.route}) — ${u.evidenceAvailable}`);
  }
  push("");
  push("── Duplicate identity candidates (groups / documents involved) ──");
  const d = report.duplicates;
  const dup = (label, g) =>
    push(`  ${label}: ${g.groups} groups over ${g.totalOccurrences} documents — ${g.repeatedValueGroups} exact repeats, ${g.spellingVariantGroups} spelling variants`);
  dup("Raw-item SKUs", d.rawItemSkus);
  dup("Variant SKUs", d.variantSkus);
  dup("Categories", d.categories);
  dup("Units", d.units);
  dup("Vendor names", d.vendorNames);
  push(`  Vendor GSTINs (exact): ${d.vendorGstNumbers.length}`);
  push("");
  push("── Company / site scope ──");
  push(`  ${report.scopeSummary.collectionsDeclaringCompanyId} of ${report.scopeSummary.collectionsGathered} gathered collections declare companyId; ${report.scopeSummary.collectionsDeclaringSiteId} declare siteId`);
  for (const c of report.companyScoping) {
    push(
      `  ${c.collection}: companyId ${c.withCompanyId}/${c.documents}${c.declaresCompanyId ? " (declared)" : " (not in schema)"}` +
        ` · siteId ${c.withSiteId}/${c.documents}${c.declaresSiteId ? " (declared)" : " (not in schema)"}`,
    );
  }
  push("");
  push(renderItemMasterSummary(report.itemMaster));
  push("");
  push("── Limitations ──");
  for (const l of report.limitations) push(`  • ${l}`);
  return L.join("\n");
}

module.exports = {
  EPS,
  computeBaselineReport,
  renderSummary,
  // exported for focused tests
  reconcileRawItem,
  reconcileOperationalPO,
  reconcileMrf,
  mrfStockMovementIndex,
  duplicateCandidates,
  summariseDuplicates,
  DUPLICATE_KIND,
  exactDuplicates,
  findOrphans,
  findVariantOrphans,
  buildVariantIndex,
  classifyTransactionPath,
  scopePresence,
  countBy,
};
