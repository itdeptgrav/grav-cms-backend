// services/storePurchase/receiveWorkspace.service.js
//
// ONE RECEIVING READ: WHAT IS COMING, WHAT NEEDS WORK, AND WHAT IS DONE.
//
// ── WHY AN ADAPTER AND NOT FOUR BROWSER REQUESTS ────────────────────────────
// The Receive workspace answers one question — "what should a receiver do
// next" — from four authoritative sources: outstanding purchase orders,
// outstanding customer-material expectations, recorded goods receipts, and the
// receipt-control state derived from inspection / put-away / disposition /
// supplier-return records. Composing that in the browser means four requests
// whose failures the page has to reconcile, and a stage vocabulary duplicated
// in JavaScript. So it is composed once, here, and the page renders a closed
// DTO.
//
// ── IT ADDS NO AUTHORITY ────────────────────────────────────────────────────
// Every fact is read through the service that already owns it:
//   · stage and flags      → goodsReceiptControl.deriveControl
//   · customer standing    → customerMaterial.register (→ standingFor)
//   · outstanding purchase → PurchaseOrder's own stored pendingQuantity
// Nothing here recomputes a control decision, and nothing writes.
//
// ── AND OWNERSHIP IS EXPLICIT ───────────────────────────────────────────────
// Purchased or customer-owned comes from `GoodsReceipt.sourceType`, never from
// "there is no supplier, so it must be the customer's". An inference is a
// guess, and a guess about whether goods were bought decides whether they show
// up as spend.

"use strict";

const mongoose = require("mongoose");

const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const GoodsReceiptInspection = require("../../models/CMS_Models/StorePurchase/GoodsReceiptInspection");
const GoodsReceiptPutaway = require("../../models/CMS_Models/StorePurchase/GoodsReceiptPutaway");
const GoodsReceiptDisposition = require("../../models/CMS_Models/StorePurchase/GoodsReceiptDisposition");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

const tenantContext = require("./tenantContext.service");
const control = require("./goodsReceiptControl.service");

/* The tabs, as the URL spells them. ALL (1 Oct 2026, the owner: "by default
   keep the filter for all") is every expected arrival and every recorded
   receipt in one list, and the default when nothing is asked for. */
const STAGE = Object.freeze({
  ALL: "all",
  EXPECTED: "expected",
  ACTION: "action-required",
  COMPLETED: "completed",
});
const STAGES = Object.freeze([STAGE.ALL, STAGE.EXPECTED, STAGE.ACTION, STAGE.COMPLETED]);
const STAGE_ORDER = Object.freeze({ [STAGE.EXPECTED]: 0, [STAGE.ACTION]: 1, [STAGE.COMPLETED]: 2 });

/* The source filter. `customer-owned` is the user's word; `CUSTOMER_MATERIAL`
   is the stored one, and they are mapped rather than conflated. */
const SOURCE = Object.freeze({
  ALL: "all",
  PURCHASED: "purchased",
  CUSTOMER: "customer-owned",
});
const SOURCES = Object.freeze([SOURCE.ALL, SOURCE.PURCHASED, SOURCE.CUSTOMER]);

const SOURCE_TYPE = Object.freeze({
  PURCHASE: "PURCHASE_ORDER",
  CUSTOMER: "CUSTOMER_MATERIAL",
});

/* One next action per row, derived from authoritative flags only. The order is
   the priority: rejected stock outranks quarantine, which outranks inspection,
   because that is the order in which a receiver is blocked. */
const ACTION = Object.freeze({
  RETURN_REJECTED: { code: "RETURN_REJECTED", label: "Return rejected stock" },
  RESOLVE_QUARANTINE: { code: "RESOLVE_QUARANTINE", label: "Resolve quarantined stock" },
  INSPECT: { code: "INSPECT", label: "Inspect receipt" },
  PUTAWAY: { code: "PUTAWAY", label: "Put away accepted stock" },
  RECONCILE: { code: "RECONCILE", label: "Reconcile interrupted receipt" },
  VIEW: { code: "VIEW", label: "View receipt" },
  RECEIVE_PURCHASE: { code: "RECEIVE_PURCHASE", label: "Receive against this order" },
  RECEIVE_CUSTOMER: { code: "RECEIVE_CUSTOMER", label: "Record customer delivery" },
  /* Customer-owned material has no purchased control pipeline — its one action
     is to open the customer-material document that owns its issue/return/labels. */
  VIEW_CUSTOMER: { code: "VIEW_CUSTOMER", label: "View customer-supplied receipt" },
});

/* Bounded by default. Stage is DERIVED for recorded receipts, so the scan is
   newest-first over a cap and the response says so rather than implying a
   company-wide total. */
const scanCap = () => Math.max(1, parseInt(process.env.RECEIVE_WORKSPACE_SCAN_CAP, 10) || 500);
const EXPECTED_CAP = () => Math.max(1, parseInt(process.env.RECEIVE_EXPECTED_SCAN_CAP, 10) || 200);

const str = (v) => (typeof v === "string" ? v.trim() : "");
const rxOf = (s) => new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// A REAL calendar YYYY-MM-DD, else "". Shape alone is not enough: 2026-02-31,
// 2026-13-01 and 0000-00-00 all match the pattern but are not dates, and must
// never reach Mongo as an invalid `new Date(...)`. This confirms the format, a
// real month/day, and round-trips the parsed value back to the same y/m/d (which
// also gives correct leap-year behaviour: 2028-02-29 valid, 2026-02-29 not).
function validDate(v) {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return "";
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return "";
  return s;
}

// The application's business timezone is IST (Asia/Kolkata, +05:30) — the same
// clock HR/attendance/deadlines use. A date-only filter must mean the WHOLE IST
// day, so the boundaries are built with an explicit offset rather than left to
// ambiguous date-only parsing (which Node reads as UTC midnight and would drop
// receipts recorded later on the To day).
const IST_OFFSET = "+05:30";

/**
 * Inclusive IST day boundaries for a receipt-date range (pure, testable).
 *   from → 00:00:00.000 IST of dateFrom
 *   to   → 23:59:59.999 IST of dateTo (the FULL end day is included)
 * `invalid` is true when a complete range has From after To.
 */
function dateBoundaries(dateFrom, dateTo) {
  const df = validDate(dateFrom);
  const dt = validDate(dateTo);
  const from = df ? new Date(`${df}T00:00:00.000${IST_OFFSET}`) : null;
  const to = dt ? new Date(`${dt}T23:59:59.999${IST_OFFSET}`) : null;
  const invalid = Boolean(from && to && from.getTime() > to.getTime());
  return { from, to, invalid };
}

// ── TENANT-SAFE FILTER MERGE ──────────────────────────────────────────────────
// tenantFilter() returns an `$or` under legacy read-through (companyId | absent |
// null). Spreading it and then assigning `filter.$or = [search…]` OVERWRITES the
// tenant `$or`, dropping company scope and leaking other tenants' receipts on any
// search. So caller clauses — including a search `$or` — are folded under `$and`
// with the tenant scope, never merged by assignment. Same guard the valuation
// route uses. `extra` is the non-tenant clause object (sourceType, receiptDate,
// status, $or:[search], …).
function scoped(tenant, extra = {}) {
  const t = tenantContext.tenantFilter(tenant);
  if (!extra || !Object.keys(extra).length) return t;
  return { $and: [t, extra] };
}

/** Normalise whatever the URL carried into the closed vocabulary. */
function readQuery(q = {}) {
  const stage = STAGES.includes(str(q.stage)) ? str(q.stage) : STAGE.ALL;
  // Canonical is `customer-owned`; accept the `customer` shorthand (customer-
  // material back link / older links) so it opens the customer view, not All.
  const rawSource = str(q.source);
  const source = SOURCES.includes(rawSource)
    ? rawSource
    : rawSource === "customer" ? SOURCE.CUSTOMER
      : rawSource === "purchase" ? SOURCE.PURCHASED
        : SOURCE.ALL;
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
  // Date range for RECORDED receipts (by receipt date). Deliberately NOT applied
  // to Expected: an expected arrival has no receipt date, and quietly filtering
  // it by one would hide orders that are simply still coming. Expected therefore
  // leaves date filtering UNAVAILABLE (dateFilterApplies=false below).
  const rawFrom = str(q.dateFrom);
  const rawTo = str(q.dateTo);
  const dateFrom = validDate(rawFrom);
  const dateTo = validDate(rawTo);
  // A date param that was SENT but is not a real calendar date. It must not be
  // silently dropped (which would run an unfiltered query and show records
  // outside the range the user thinks is active) — the caller surfaces it as a
  // validation response instead.
  const dateInputInvalid = Boolean((rawFrom && !dateFrom) || (rawTo && !dateTo));
  return { stage, source, search: str(q.search).slice(0, 200), page, pageSize, dateFrom, dateTo, dateInputInvalid };
}

/**
 * The one action a recorded receipt needs next.
 *
 * Reads `flags` from `deriveControl` and nothing else — no second opinion about
 * what "complete" means.
 */
function nextActionFor(flags = {}) {
  if (flags.hasRejected) return ACTION.RETURN_REJECTED;
  if (flags.hasQuarantined) return ACTION.RESOLVE_QUARANTINE;
  if (flags.awaitingInspection) return ACTION.INSPECT;
  if (flags.awaitingPutaway) return ACTION.PUTAWAY;
  if (flags.complete) return ACTION.VIEW;
  /* Every flag false on a receipt with lines is not a state the control
     service describes. Saying "reconcile" is honest; picking one of the
     above would be inventing a diagnosis. */
  return ACTION.RECONCILE;
}

/** Which tab a recorded receipt belongs to. */
const stageOfReceipt = (flags = {}) => (flags.complete ? STAGE.COMPLETED : STAGE.ACTION);

/**
 * A recorded receipt as one workspace row.
 *
 * ── NO FINANCIAL LANGUAGE ON CUSTOMER-OWNED MATERIAL ────────────────────────
 * A customer-owned row carries the customer and their order reference. It
 * carries no supplier, no invoice number and no price, because the factory
 * bought nothing — and a supplier column holding a customer's name turns a
 * buyer into a vendor in every report that groups by one.
 */
function receiptRow(g, flags, counts, stage) {
  const customerOwned = g.sourceType === SOURCE_TYPE.CUSTOMER;

  /* ── CUSTOMER-OWNED: A DIFFERENT LIFECYCLE, NOT THE PURCHASED ONE ───────────
     Customer-supplied material is not inspected, put away, quarantined or
     returned to a supplier through the purchased control pipeline. For Receive
     it is COMPLETE the moment its customer-material receipt transaction
     succeeded; everything after — issue to production, return to the customer,
     labels, movements — lives on the customer-material document. So its stage is
     always Completed, its one action opens that document, and `deriveControl` is
     never consulted for it (the caller does not even compute it). It never
     borrows the goods-receipt control workspace, and never a supplier-return or
     any financial action. */
  if (customerOwned) {
    const target = String(g.sourceDocumentId || g.sourceDocumentNumber || "");
    return {
      id: String(g._id),
      sourceType: SOURCE.CUSTOMER,
      reference: g.receiptNumber || "",
      partyLabel: g.customerMaterial?.customerLabel || "",
      partyKind: "customer",
      /* The customer's own order reference — never a PO number it does not have. */
      orderReference: g.customerMaterial?.orderRef || g.sourceDocumentNumber || "",
      /* The customer's challan/reference — explicitly NOT a supplier invoice. */
      customerReference: g.customerMaterial?.customerReference || "",
      recordedDate: g.receiptDate || g.createdAt || null,
      lineCount: Array.isArray(g.lines) ? g.lines.length : 0,
      warehouseName: g.warehouseName || "",
      locationLabel: [g.locationName, g.locationCode].filter(Boolean).join(" · "),
      /* Receiving is done; the customer lifecycle continues on its own document. */
      stage: STAGE.COMPLETED,
      controlStage: "",
      flags: { awaitingInspection: false, awaitingPutaway: false, hasQuarantined: false, hasRejected: false, complete: true },
      counts: {},
      nextAction: {
        ...ACTION.VIEW_CUSTOMER,
        href: target ? `/store/dashboard/operations/customer-materials/${target}` : null,
      },
      /* No supplier, no invoice, no price — the factory bought nothing. */
      invoiceNumber: "",
      recordedByName: g.recordedBy?.name || "",
    };
  }

  const action = nextActionFor(flags);
  return {
    id: String(g._id),
    sourceType: SOURCE.PURCHASED,
    reference: g.receiptNumber || "",
    partyLabel: g.supplierName || "",
    partyKind: "supplier",
    orderReference: g.poNumber || "",
    /* Absent stays absent — an invented date reads as a recorded one. */
    recordedDate: g.receiptDate || g.createdAt || null,
    lineCount: Array.isArray(g.lines) ? g.lines.length : 0,
    warehouseName: g.warehouseName || "",
    locationLabel: [g.locationName, g.locationCode].filter(Boolean).join(" · "),
    stage,
    controlStage: flags.controlStage || "",
    flags: {
      awaitingInspection: Boolean(flags.awaitingInspection),
      awaitingPutaway: Boolean(flags.awaitingPutaway),
      hasQuarantined: Boolean(flags.hasQuarantined),
      hasRejected: Boolean(flags.hasRejected),
      complete: Boolean(flags.complete),
    },
    counts: counts || {},
    nextAction: { ...action, href: `/store/dashboard/operations/goods-receipts/${String(g._id)}` },
    invoiceNumber: g.invoiceNumber || "",
    recordedByName: g.recordedBy?.name || "",
  };
}

/**
 * Recorded receipts, with their control state.
 *
 * Bounded newest-first. Stage is derived, so a truthful answer describes the
 * inspected set rather than implying it counted every receipt ever recorded.
 */
async function readRecordedReceipts(tenant, { source, search, dateFrom, dateTo }) {
  const extra = {};
  if (source === SOURCE.PURCHASED) extra.sourceType = SOURCE_TYPE.PURCHASE;
  if (source === SOURCE.CUSTOMER) extra.sourceType = SOURCE_TYPE.CUSTOMER;
  // From/To filter recorded receipts by their RECEIPT DATE (the same field the
  // legacy register filtered). Applied in the DB before the bounded scan so the
  // coverage note describes the dated set honestly.
  const { from, to } = dateBoundaries(dateFrom, dateTo);
  if (from || to) {
    extra.receiptDate = {};
    if (from) extra.receiptDate.$gte = from; // 00:00:00.000 IST of dateFrom
    if (to) extra.receiptDate.$lte = to; // 23:59:59.999 IST of dateTo (inclusive)
  }
  if (search) {
    const rx = rxOf(search);
    /* Customer fields are searched too, so a customer-owned arrival is findable
       by the reference its own side uses. The search $or is folded under $and
       with the tenant scope (see scoped) so it can never widen it. */
    extra.$or = [
      { receiptNumber: rx }, { poNumber: rx }, { supplierName: rx }, { invoiceNumber: rx },
      { sourceDocumentNumber: rx },
      { "customerMaterial.customerLabel": rx }, { "customerMaterial.orderRef": rx },
      { "customerMaterial.customerReference": rx },
    ];
  }
  const filter = scoped(tenant, extra);

  const cap = scanCap();
  const storedMatchCount = await GoodsReceipt.countDocuments(filter);
  const docs = await GoodsReceipt.find(filter)
    .select("receiptNumber poNumber purchaseOrderId supplierName supplierId receiptDate "
      + "warehouseName locationCode locationName warehouseId locationId invoiceNumber "
      + "sourceType sourceDocumentId sourceDocumentNumber customerMaterial "
      + "recordedBy lines createdAt")
    .sort({ receiptDate: -1, _id: -1 })
    .limit(cap)
    .lean();

  const ids = docs.map((d) => d._id);
  const poIds = [...new Set(docs.map((d) => d.purchaseOrderId).filter(Boolean).map(String))];
  const [inspections, putaways, dispositions, pos] = await Promise.all([
    ids.length ? GoodsReceiptInspection.find({ companyId: tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
    ids.length ? GoodsReceiptPutaway.find({ companyId: tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
    ids.length ? GoodsReceiptDisposition.find({ companyId: tenant.companyId, goodsReceiptId: { $in: ids } }).lean() : [],
    poIds.length
      ? PurchaseOrder.find({ _id: { $in: poIds }, ...tenantContext.tenantFilter(tenant) }).select("returnRequests").lean()
      : [],
  ]);

  const inspByGrn = new Map(inspections.map((i) => [String(i.goodsReceiptId), i]));
  const group = (rows) => {
    const out = new Map();
    for (const r of rows) {
      const k = String(r.goodsReceiptId);
      if (!out.has(k)) out.set(k, []);
      out.get(k).push(r);
    }
    return out;
  };
  const putawaysByGrn = group(putaways);
  const dispsByGrn = group(dispositions);
  const returnsByGrn = new Map();
  for (const po of pos) {
    for (const r of po.returnRequests || []) {
      if (!r.goodsReceiptId) continue;
      const k = String(r.goodsReceiptId);
      if (!returnsByGrn.has(k)) returnsByGrn.set(k, []);
      returnsByGrn.get(k).push(r);
    }
  }

  const rows = docs.map((g) => {
    /* Customer-owned receipts have NO purchased control state — deriveControl is
       for the inspection/put-away/supplier-return pipeline, which they never
       enter. Running it on one would falsely read "awaiting inspection" and
       strand a completed customer receipt in Action required. So it is skipped
       entirely for them; receiptRow classifies them as Completed. */
    if (g.sourceType === SOURCE_TYPE.CUSTOMER) return receiptRow(g, {}, {}, STAGE.COMPLETED);

    const k = String(g._id);
    /* The one authority on stage for a PURCHASED receipt. Not re-derived here. */
    const c = control.deriveControl(g, inspByGrn.get(k) || null, putawaysByGrn.get(k) || [], {}, {
      dispositions: dispsByGrn.get(k) || [],
      supplierReturns: returnsByGrn.get(k) || [],
    });
    const flags = { ...c.flags, controlStage: c.stage };
    return receiptRow(g, flags, c.counts, stageOfReceipt(c.flags));
  });

  return {
    rows,
    coverage: {
      scannedCount: docs.length,
      scanCap: cap,
      storedMatchCount,
      truncated: storedMatchCount > cap,
    },
  };
}

/**
 * Purchased arrivals nobody has recorded yet.
 *
 * Outstanding is the PO's own stored `pendingQuantity` — not a subtraction this
 * adapter performs, because the receiving engine already maintains it and two
 * answers to "how much is still owed" is one too many.
 *
 * Quantities are NEVER summed across lines: a line in metres and a line in
 * kilograms have no total, and printing one invites somebody to divide by it.
 * The row carries a COUNT of outstanding lines.
 */
async function readExpectedPurchased(tenant, { search }) {
  const extra = { status: { $in: ["ISSUED", "PARTIALLY_RECEIVED"] } };
  if (search) {
    const rx = rxOf(search);
    // Folded under $and with the tenant scope (see scoped) — a search $or must
    // never widen the company boundary.
    extra.$or = [{ poNumber: rx }, { vendorName: rx }, { supplierName: rx }];
  }
  const filter = scoped(tenant, extra);

  const cap = EXPECTED_CAP();
  const storedMatchCount = await PurchaseOrder.countDocuments(filter);
  const docs = await PurchaseOrder.find(filter)
    .select("poNumber status vendorName supplierName expectedDeliveryDate warehouseName "
      + "warehouseId items.pendingQuantity items.status items.unit items.expectedDeliveryDate createdAt")
    .sort({ expectedDeliveryDate: 1, _id: -1 })
    .limit(cap)
    .lean();

  const rows = [];
  for (const po of docs) {
    const outstanding = (po.items || []).filter(
      (i) => i.status !== "CANCELLED" && num(i.pendingQuantity) > 0,
    );
    if (!outstanding.length) continue;
    /* The earliest line date where the header has none — a due date is a fact
       somebody recorded, so it is read rather than assumed. */
    const lineDue = outstanding
      .map((i) => i.expectedDeliveryDate)
      .filter(Boolean)
      .sort((a, b) => new Date(a) - new Date(b))[0] || null;
    rows.push({
      id: String(po._id),
      sourceType: SOURCE.PURCHASED,
      reference: po.poNumber || "",
      partyLabel: po.vendorName || po.supplierName || "",
      partyKind: "supplier",
      orderReference: po.poNumber || "",
      /* Only when recorded. */
      expectedDate: po.expectedDeliveryDate || lineDue || null,
      recordedDate: null,
      /* A count, never a sum across units. */
      lineCount: outstanding.length,
      warehouseName: po.warehouseName || "",
      locationLabel: "",
      stage: STAGE.EXPECTED,
      controlStage: "",
      flags: {},
      counts: {},
      nextAction: {
        ...ACTION.RECEIVE_PURCHASE,
        href: `/store/dashboard/operations/purchase-order/${String(po._id)}/receive`,
      },
      invoiceNumber: "",
      recordedByName: "",
    });
  }

  return {
    rows,
    coverage: { scannedCount: docs.length, scanCap: cap, storedMatchCount, truncated: storedMatchCount > cap },
  };
}

/**
 * Customer-owned arrivals nobody has recorded yet.
 *
 * Read through `customerMaterial.register`, which already computes each
 * document's per-line standing. This adapter only asks "does any line still
 * expect something" and never recomputes a pending quantity.
 */
async function readExpectedCustomer(ctx, { search }) {
  /* Required lazily: the Merchandising service pulls a wide model graph, and a
     top-level require would load it for every Store request. */
  const customerMaterial = require("../merchandising/customerMaterial.service");
  const cap = EXPECTED_CAP();
  const out = await customerMaterial.register(ctx, {
    q: search, state: "ISSUED", page: 1, limit: Math.min(cap, 100),
  });

  const rows = [];
  for (const row of out.rows || []) {
    const lines = row.standing?.lines || [];
    const outstanding = lines.filter((l) => num(l.pendingQuantity) > 0);
    if (!outstanding.length) continue;
    rows.push({
      id: String(row.id || row.documentRef || ""),
      sourceType: SOURCE.CUSTOMER,
      reference: row.documentRef || "",
      /* The customer, named as one. No supplier field is populated anywhere on
         a customer-owned row. */
      partyLabel: row.buyerDisplayLabel || row.buyerName || "",
      partyKind: "customer",
      orderReference: row.orderRef || "",
      expectedDate: row.requiredBy || row.expectedAt || null,
      recordedDate: null,
      lineCount: outstanding.length,
      warehouseName: "",
      locationLabel: "",
      stage: STAGE.EXPECTED,
      controlStage: "",
      flags: {},
      counts: {},
      nextAction: {
        ...ACTION.RECEIVE_CUSTOMER,
        href: `/store/dashboard/operations/customer-materials/${String(row.id || row.documentRef || "")}`,
      },
      invoiceNumber: "",
      recordedByName: "",
    });
  }

  return {
    rows,
    coverage: {
      scannedCount: (out.rows || []).length,
      scanCap: cap,
      storedMatchCount: num(out.total),
      truncated: num(out.total) > (out.rows || []).length,
    },
  };
}

/**
 * The whole workspace, as one closed DTO.
 *
 * ── A FAILED SOURCE IS NEVER ZERO ROWS ──────────────────────────────────────
 * Each source is read independently and its failure is reported as
 * `available: false` with the reason. A source that could not be read looks
 * nothing like a source that genuinely has nothing in it, and collapsing the
 * two is how a receiver concludes there is no work waiting.
 */
async function workspace(tenant, ctx, query = {}) {
  const { stage, source, search, page, pageSize, dateFrom, dateTo, dateInputInvalid } = readQuery(query);

  // Date filtering is a RECORDED-receipt feature (Action required / Completed),
  // by receipt date. Expected arrivals have no receipt date, so it is left
  // UNAVAILABLE there rather than silently reinterpreted.
  const dateFilterApplies = stage !== STAGE.EXPECTED;
  // Two ways the range is unusable, both a user mistake and NOT "no receipts":
  // an impossible date that was sent (e.g. 2026-02-31), or From after To. In
  // either case stop and show a clear validation message rather than an empty
  // register (or, worse, an unfiltered query) that reads as "nothing received".
  const rangeInverted = dateBoundaries(dateFrom, dateTo).invalid;
  const dateInvalid = dateFilterApplies && (dateInputInvalid || rangeInverted);
  const dateMessage = !dateInvalid
    ? null
    : dateInputInvalid
      ? "That is not a real calendar date. Enter a valid From/To date (YYYY-MM-DD)."
      : "The From date is after the To date. Adjust the range to see receipts.";

  const wantPurchased = source === SOURCE.ALL || source === SOURCE.PURCHASED;
  const wantCustomer = source === SOURCE.ALL || source === SOURCE.CUSTOMER;

  const sources = {};
  let rows = [];

  const attempt = async (key, fn) => {
    try {
      const out = await fn();
      sources[key] = { available: true, unavailableReason: null, coverage: out.coverage };
      return out.rows;
    } catch (err) {
      sources[key] = {
        available: false,
        unavailableReason: err?.message || "This source could not be read.",
        coverage: null,
      };
      return [];
    }
  };

  const byExpectedDate = (a, b) => {
    /* Earliest expected first; rows with no recorded date sit after the dated
       ones rather than being given a date to sort by. */
    if (!a.expectedDate && !b.expectedDate) return 0;
    if (!a.expectedDate) return 1;
    if (!b.expectedDate) return -1;
    return new Date(a.expectedDate) - new Date(b.expectedDate);
  };
  if (stage === STAGE.EXPECTED) {
    if (wantPurchased) rows = rows.concat(await attempt("expectedPurchased", () => readExpectedPurchased(tenant, { search })));
    if (wantCustomer) rows = rows.concat(await attempt("expectedCustomer", () => readExpectedCustomer(ctx, { search })));
    rows.sort(byExpectedDate);
  } else if (dateInvalid) {
    // Do not query an impossible range — that would return zero and read as
    // "no receipts exist". The page shows the validation message instead.
    rows = [];
  } else if (stage === STAGE.ALL) {
    /* ── EVERYTHING, IN THE ORDER A RECEIVER WORKS (1 Oct 2026) ──────────
       Expected arrivals first (earliest due first), then the recorded
       receipts that still need work, then the completed ones — each group in
       its own tab's order. A date range filters the RECORDED rows by receipt
       date, as on those tabs; an expected arrival has no receipt date, so
       while a range is set none is listed rather than one being guessed in. */
    let expected = [];
    if (!(dateFrom || dateTo)) {
      if (wantPurchased) expected = expected.concat(await attempt("expectedPurchased", () => readExpectedPurchased(tenant, { search })));
      if (wantCustomer) expected = expected.concat(await attempt("expectedCustomer", () => readExpectedCustomer(ctx, { search })));
      expected.sort(byExpectedDate);
    }
    const recorded = await attempt("recordedReceipts", () => readRecordedReceipts(tenant, { source, search, dateFrom, dateTo }));
    const ordered = recorded.slice().sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9));
    rows = expected.concat(ordered);
  } else {
    const recorded = await attempt("recordedReceipts", () => readRecordedReceipts(tenant, { source, search, dateFrom, dateTo }));
    rows = recorded.filter((r) => r.stage === stage);
  }

  const totalItems = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const current = Math.min(page, totalPages);
  const paged = rows.slice((current - 1) * pageSize, (current - 1) * pageSize + pageSize);

  const truncatedSources = Object.entries(sources).filter(([, v]) => v.coverage?.truncated);
  const unavailable = Object.entries(sources).filter(([, v]) => !v.available);

  return {
    stage, source, search,
    // Echo the date range and say plainly whether it was applied, so the page
    // never implies a filter took effect on Expected.
    dateFrom, dateTo,
    dateFilter: {
      applies: dateFilterApplies,
      field: dateFilterApplies ? "receiptDate" : null,
      timezone: "Asia/Kolkata",
      invalid: dateInvalid,
      message: dateMessage,
      note: dateFilterApplies
        ? null
        : "Date range filters recorded arrivals by receipt date; it does not apply to Expected.",
    },
    rows: paged,
    pagination: {
      page: current, pageSize, totalItems, totalPages,
      hasNextPage: current < totalPages, hasPrevPage: current > 1,
      /* Honest about what was counted: the derived stages mean this describes
         the inspected set, not a company-wide total. */
      scope: stage === STAGE.EXPECTED ? "outstandingSet" : "inspectedSet",
    },
    sources,
    coverage: {
      truncated: truncatedSources.length > 0,
      note: truncatedSources.length
        ? `Showing the newest records from ${truncatedSources.map(([k]) => k).join(", ")}; older matching records may exist. Counts and pagination describe only this set.`
        : null,
    },
    /* Said plainly rather than left for the page to infer from empty rows. */
    unavailable: unavailable.length
      ? unavailable.map(([key, v]) => ({ source: key, reason: v.unavailableReason }))
      : [],
    stages: STAGES,
    sourceOptions: SOURCES,
  };
}

module.exports = {
  workspace, readRecordedReceipts, readExpectedPurchased, readExpectedCustomer,
  STAGE, STAGES, SOURCE, SOURCES, SOURCE_TYPE, ACTION,
  readQuery, nextActionFor, stageOfReceipt, receiptRow,
  dateBoundaries, IST_OFFSET, validDate,
  scanCap, EXPECTED_CAP,
  GoodsReceipt, GoodsReceiptInspection, GoodsReceiptPutaway, GoodsReceiptDisposition,
  PurchaseOrder, tenantContext, control, mongoose, str, rxOf, num,
};
