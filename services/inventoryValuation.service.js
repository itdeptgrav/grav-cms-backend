"use strict";

// ── Inventory Valuation V1 — honest weighted-average stock value ─────────────
//
// A PURE, testable management valuation over the movements a RawItem actually
// stores. It replaces the misleading "current quantity × last purchase price"
// figure with a moving weighted-average replayed from real stock movements.
//
// It NEVER mutates a document, a transaction or a cached balance. It reads what
// is there and reports — including, honestly, what it cannot value and why.
//
// ── The real movement types (read from every writer, not from memory) ────────
// RawItem.stockTransactions[].type is one of six strings actually written:
//   IN  (increase): ADD, VARIANT_ADD, and the legacy PURCHASE_ORDER
//   OUT (decrease): REDUCE, VARIANT_REDUCE, and the legacy CONSUME
// Writers and their prices:
//   · PO receipt            → ADD / VARIANT_ADD, unitPrice = PO line price
//   · manual variant add    → VARIANT_ADD, unitPrice = entered price
//   · MRF issue             → REDUCE / VARIANT_REDUCE, no price
//   · MRF return (into store)→ ADD / VARIANT_ADD, NO captured cost
//   · supplier return (out) → REDUCE / VARIANT_REDUCE, no price, links a PO
//   · vendor replacement in → ADD / VARIANT_ADD, no captured cost
//   · stock adjustment      → ADD / REDUCE (± variant), no price
// Anything else is an UNKNOWN type — an exception, never assumed to be stock-in.
//
// The only cost field is `unitPrice` (schema default 0). Because internal
// returns/adjustments push an inbound with a default 0 they never meant as a
// cost, a bare 0 is treated as a RECORDED zero only when the movement is a
// genuinely priced source (a PO/invoice-linked receipt); otherwise a 0 on an
// un-priced inbound reads as MISSING, and its quantity becomes unvalued rather
// than silently valued at ₹0.

const KNOWN_IN = new Set(["ADD", "VARIANT_ADD", "PURCHASE_ORDER"]);
const KNOWN_OUT = new Set(["REDUCE", "VARIANT_REDUCE", "CONSUME"]);

// Quantity tolerance for reconciliation and pool arithmetic (absorbs float
// noise from fractional units like KG/M without hiding a real mismatch).
const QTY_TOL = 1e-6;

const REASON = Object.freeze({
  MISSING_INBOUND_PRICE: "MISSING_INBOUND_PRICE",
  UNKNOWN_MOVEMENT_TYPE: "UNKNOWN_MOVEMENT_TYPE",
  INVALID_QUANTITY: "INVALID_QUANTITY",
  INVALID_PRICE: "INVALID_PRICE",
  BALANCE_MISMATCH: "BALANCE_MISMATCH",
  VARIANT_TOTAL_MISMATCH: "VARIANT_TOTAL_MISMATCH",
  NEGATIVE_REPLAY: "NEGATIVE_REPLAY",
  // An outbound happened while unpriced stock was on hand: we can no longer say
  // which units left, so the remaining cost composition is unknowable.
  COST_COMPOSITION_INDETERMINATE: "COST_COMPOSITION_INDETERMINATE",
  // A correction row exists that has not been APPLIED to stock — it is a claim,
  // not a movement, so it changes nothing but is worth attention.
  UNAPPLIED_CORRECTION: "UNAPPLIED_CORRECTION",
});

const STATUS = Object.freeze({
  COMPLETE: "complete",
  INCOMPLETE: "incomplete",
  INDETERMINATE: "indeterminate",
  UNRECONCILED: "unreconciled",
});

const isNum = (x) => typeof x === "number" && Number.isFinite(x);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
// Null-safe rounder — an indeterminate quantity/value stays null, never 0.
const r4 = (n) => (n == null ? null : round4(n));

function timeOf(m) {
  const d = m && (m.createdAt || m.updatedAt);
  const t = d ? new Date(d).getTime() : 0;
  return Number.isFinite(t) ? t : 0;
}

// Deterministic chronological order with an _id tie-break, so two movements at
// the same instant always replay in the same sequence.
function chronological(txns) {
  return [...(txns || [])].sort((a, b) => {
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta - tb;
    return String(a && a._id != null ? a._id : "").localeCompare(
      String(b && b._id != null ? b._id : ""),
    );
  });
}

// Is a zero unitPrice a genuinely RECORDED zero (a priced source) rather than
// the schema default of an inbound that captured no cost?
function pricedSource(m) {
  return (
    m.purchaseOrderId != null ||
    m.type === "PURCHASE_ORDER" ||
    (typeof m.purchaseOrder === "string" && m.purchaseOrder.trim() !== "") ||
    (typeof m.invoiceNumber === "string" && m.invoiceNumber.trim() !== "") ||
    /purchase order/i.test(m.reason || "")
  );
}

// Classify a raw (lean) movement into a normalized shape, or an exception.
function classify(m) {
  const type = m.type;
  const dir = KNOWN_IN.has(type) ? "in" : KNOWN_OUT.has(type) ? "out" : null;
  if (!dir) return { ok: false, reason: REASON.UNKNOWN_MOVEMENT_TYPE, type };

  const qty = m.quantity;
  if (!isNum(qty) || qty < 0) {
    return { ok: false, reason: REASON.INVALID_QUANTITY, type };
  }

  const up = m.unitPrice;
  const hasNumericPrice = isNum(up);
  if (hasNumericPrice && up < 0) {
    return { ok: false, reason: REASON.INVALID_PRICE, type };
  }

  if (dir === "out") return { ok: true, dir: "out", qty, type };

  // inbound — decide whether a reliable cost is present
  if (!hasNumericPrice) {
    // absent / null / NaN — no cost captured
    return { ok: true, dir: "in", qty, type, priced: false, reason: REASON.MISSING_INBOUND_PRICE };
  }
  if (up > 0) return { ok: true, dir: "in", qty, type, priced: true, unitCost: up };
  // up === 0
  if (pricedSource(m)) {
    return { ok: true, dir: "in", qty, type, priced: true, unitCost: 0, recordedZero: true };
  }
  return { ok: true, dir: "in", qty, type, priced: false, reason: REASON.MISSING_INBOUND_PRICE };
}

// Replay a chronological list of movements through a moving weighted-average,
// WITHOUT ever guessing which units left the shelf.
//
//   · While no unpriced stock has been received, ordinary moving average works.
//   · An unpriced inbound creates an identifiable UNVALUED portion — the item
//     is incomplete but its known (valued) portion is still exact.
//   · The moment an OUTBOUND happens while unpriced stock is on hand, we can no
//     longer say whether valued or unvalued units left. The remaining cost
//     composition is INDETERMINATE: from here we return no current average and
//     no current known value (null, not ₹0), only the on-hand quantity.
//   · If the replayed balance later reaches EXACTLY zero, the uncertainty
//     resets — nothing is left, so the remaining value is exactly zero — and a
//     subsequent fully-priced receipt starts a clean valuation period.
function replayMovements(sortedWithClass) {
  let qtyOnHand = 0; // running replayed balance across ALL movements
  let valuedQty = 0; // meaningful only while !indeterminate
  let value = 0; // meaningful only while !indeterminate
  let unvaluedQty = 0; // meaningful only while !indeterminate
  let indeterminate = false;
  let indeterminateFrom = null;
  let latestPricedAt = null;
  const reasons = new Set();
  const exceptions = [];
  let negativeReplay = false;

  const resetIfEmpty = () => {
    if (Math.abs(qtyOnHand) <= QTY_TOL) {
      qtyOnHand = 0;
      valuedQty = 0;
      value = 0;
      unvaluedQty = 0;
      indeterminate = false;
      indeterminateFrom = null; // a clean slate — remaining value is exactly 0
    }
  };

  for (const m of sortedWithClass) {
    const c = m.__class;
    if (!c.ok) {
      exceptions.push({ reason: c.reason, type: c.type, _id: String(m._id || "") });
      reasons.add(c.reason);
      continue; // an exception moves no stock — it is reported, not guessed
    }
    if (c.dir === "in") {
      qtyOnHand += c.qty;
      if (c.priced) {
        if (!indeterminate) {
          valuedQty += c.qty;
          value += c.qty * c.unitCost;
        }
        const t = timeOf(m);
        if (t && (latestPricedAt == null || t > latestPricedAt)) latestPricedAt = t;
      } else {
        if (!indeterminate) unvaluedQty += c.qty;
        reasons.add(c.reason || REASON.MISSING_INBOUND_PRICE);
      }
      resetIfEmpty();
    } else {
      // OUTBOUND. If unpriced stock is present now, composition becomes
      // indeterminate from this movement on.
      if (!indeterminate && unvaluedQty > QTY_TOL) {
        indeterminate = true;
        indeterminateFrom = {
          reason: REASON.COST_COMPOSITION_INDETERMINATE,
          _id: String(m._id || ""),
          at: timeOf(m) ? new Date(timeOf(m)) : null,
        };
        reasons.add(REASON.COST_COMPOSITION_INDETERMINATE);
      }
      if (!indeterminate) {
        // Clean moving average: no unvalued stock exists here, so removal is
        // unambiguous — at the average of the valued pool.
        const avg = valuedQty > QTY_TOL ? value / valuedQty : 0;
        const fromValued = Math.min(c.qty, valuedQty);
        valuedQty -= fromValued;
        value -= fromValued * avg;
        if (c.qty - fromValued > QTY_TOL) negativeReplay = true; // out > on hand
      }
      qtyOnHand -= c.qty;
      if (qtyOnHand < -QTY_TOL) negativeReplay = true;
      resetIfEmpty();
    }
  }

  if (Math.abs(value) < 0.005) value = 0; // clear float dust to a clean zero
  if (valuedQty < 0 && valuedQty > -QTY_TOL) valuedQty = 0;
  if (unvaluedQty < 0 && unvaluedQty > -QTY_TOL) unvaluedQty = 0;
  if (negativeReplay) reasons.add(REASON.NEGATIVE_REPLAY);

  // Value state on the value dimension (reconciliation is separate).
  let valueState;
  if (indeterminate) valueState = "indeterminate";
  else if (unvaluedQty > QTY_TOL) valueState = "partly_unvalued";
  else valueState = "complete";

  const avgCost = indeterminate
    ? null
    : valuedQty > QTY_TOL
      ? round4(value / valuedQty)
      : null;
  const knownValue = indeterminate ? null : round2(value);

  return {
    qtyOnHand,
    valuedQty: indeterminate ? null : valuedQty,
    unvaluedQty: indeterminate ? null : unvaluedQty,
    replayQty: qtyOnHand,
    value: knownValue, // null when indeterminate — never ₹0
    avgCost, // null when indeterminate
    valueState,
    indeterminate,
    indeterminateFrom,
    latestPricedAt: latestPricedAt ? new Date(latestPricedAt) : null,
    reasons: [...reasons],
    exceptions,
    negativeReplay,
  };
}

const variantKeyOf = (m) => (m.variantId != null ? String(m.variantId) : "__unassigned__");

/**
 * Value a single RawItem (a plain/lean object) with moving weighted-average.
 * Pure — does not touch the database or mutate the input.
 *
 * @param {object} item  lean RawItem: { _id, sku, name, unit, category,
 *   quantity, variants[], stockTransactions[] }
 * @param {object} [opts] { withVariants, pendingCorrectionCount }
 */
function valueItem(item, opts = {}) {
  const withVariants = opts.withVariants === true;
  const pendingCorrectionCount = Number.isFinite(opts.pendingCorrectionCount)
    ? opts.pendingCorrectionCount
    : 0;
  const unit = item.unit || item.customUnit || "";
  const txns = Array.isArray(item.stockTransactions) ? item.stockTransactions : [];
  const sorted = chronological(txns).map((m) => ({ ...m, __class: classify(m) }));

  const itemReplay = replayMovements(sorted);

  const storedOnHand = isNum(item.quantity) ? item.quantity : 0;
  const difference = round4(storedOnHand - itemReplay.replayQty);
  const reconciled = Math.abs(difference) <= QTY_TOL;

  const reasons = new Set(itemReplay.reasons);
  if (!reconciled) reasons.add(REASON.BALANCE_MISMATCH);

  // Variant breakdown (only when asked). Whole-item / unassigned movements are
  // replayed in their own bucket, never distributed across variants by guess.
  let variants;
  let variantTotalMismatch = false;
  if (withVariants) {
    const buckets = new Map();
    for (const m of sorted) {
      const k = variantKeyOf(m);
      if (!buckets.has(k)) buckets.set(k, []);
      buckets.get(k).push(m);
    }
    const storedVariants = Array.isArray(item.variants) ? item.variants : [];
    const storedById = new Map(
      storedVariants
        .filter((v) => v && v._id != null)
        .map((v) => [String(v._id), v]),
    );
    variants = [];
    for (const [k, group] of buckets) {
      const r = replayMovements(group);
      const stored = k === "__unassigned__" ? null : storedById.get(k);
      const storedQty = stored && isNum(stored.quantity) ? stored.quantity : null;
      const vDiff = storedQty == null ? null : round4(storedQty - r.replayQty);
      const vReconciled = storedQty == null ? null : Math.abs(vDiff) <= QTY_TOL;
      variants.push({
        variantId: k === "__unassigned__" ? null : k,
        unassigned: k === "__unassigned__",
        sku: stored ? stored.sku || "" : "",
        combination: stored ? stored.combination || [] : [],
        unit, // variants share the item's base unit — never a second unit
        storedOnHand: storedQty,
        replayedOnHand: round4(r.replayQty),
        valuedQty: r4(r.valuedQty),
        unvaluedQty: r4(r.unvaluedQty),
        avgCost: r.avgCost, // null when indeterminate
        knownValue: r.value, // null when indeterminate — never ₹0
        valueState: r.valueState,
        indeterminate: r.indeterminate,
        reconciled: vReconciled,
        difference: vDiff,
        reasons: r.reasons,
      });
    }
    // Do variant stored totals add up to the item's stored total?
    const sumVariantStored = storedVariants.reduce(
      (t, v) => t + (isNum(v.quantity) ? v.quantity : 0),
      0,
    );
    if (storedVariants.length > 0 && Math.abs(sumVariantStored - storedOnHand) > QTY_TOL) {
      variantTotalMismatch = true;
      reasons.add(REASON.VARIANT_TOTAL_MISMATCH);
    }
  }

  // A pending / unapplied correction is a claim, not a movement: it changed no
  // quantity or value above, but it IS attention evidence.
  if (pendingCorrectionCount > 0) reasons.add(REASON.UNAPPLIED_CORRECTION);

  const indeterminate = itemReplay.indeterminate;
  const fullyValued =
    itemReplay.valueState === "complete" &&
    itemReplay.exceptions.length === 0 &&
    pendingCorrectionCount === 0;

  const status = !reconciled
    ? STATUS.UNRECONCILED
    : indeterminate
      ? STATUS.INDETERMINATE
      : fullyValued
        ? STATUS.COMPLETE
        : STATUS.INCOMPLETE;

  return {
    itemId: String(item._id || ""),
    sku: item.sku || "",
    name: item.name || "",
    category: item.category || "",
    unit,
    storedOnHand,
    replayedOnHand: round4(itemReplay.replayQty),
    valuedQty: r4(itemReplay.valuedQty), // null when indeterminate
    unvaluedQty: r4(itemReplay.unvaluedQty), // null when indeterminate
    avgCost: itemReplay.avgCost, // moving weighted-average, or null when indeterminate
    knownValue: itemReplay.value, // known value, or null when indeterminate — never ₹0
    valueState: itemReplay.valueState, // complete | partly_unvalued | indeterminate
    indeterminate,
    indeterminateFrom: itemReplay.indeterminateFrom, // first movement where certainty was lost
    reconciled,
    difference,
    fullyValued,
    hasExceptions: itemReplay.exceptions.length > 0,
    exceptions: itemReplay.exceptions,
    pendingCorrections: pendingCorrectionCount,
    variantTotalMismatch,
    status,
    reasons: [...reasons],
    latestPricedReceiptAt: itemReplay.latestPricedAt,
    ...(withVariants ? { variants } : {}),
  };
}

/**
 * Summarize a set of already-valued items. Currency values may be totalled;
 * quantities are NEVER summed across units — they stay grouped by unit.
 */
function summarizeValued(valuedItems) {
  const rows = Array.isArray(valuedItems) ? valuedItems : [];
  let knownInventoryValue = 0;
  let completeCount = 0;
  let incompleteCount = 0;
  let indeterminateCount = 0;
  let unreconciledCount = 0;
  let excludedCount = 0; // items whose value is partly/fully excluded
  const onHandByUnit = {};
  const unvaluedByUnit = {};

  for (const it of rows) {
    // Only a genuinely-known value contributes. An indeterminate item's
    // knownValue is null and is excluded from the company total — never as ₹0.
    knownInventoryValue += isNum(it.knownValue) ? it.knownValue : 0;
    if (it.status === STATUS.COMPLETE) completeCount += 1;
    if (it.indeterminate) indeterminateCount += 1;
    else if (!it.fullyValued) incompleteCount += 1; // partly-unvalued / exceptions / pending
    if (!it.reconciled) unreconciledCount += 1;
    if (!it.fullyValued || it.indeterminate || it.hasExceptions) excludedCount += 1;

    const unit = it.unit || "—";
    onHandByUnit[unit] = round4((onHandByUnit[unit] || 0) + (isNum(it.replayedOnHand) ? it.replayedOnHand : 0));
    if (isNum(it.unvaluedQty) && it.unvaluedQty > QTY_TOL) {
      unvaluedByUnit[unit] = round4((unvaluedByUnit[unit] || 0) + it.unvaluedQty);
    }
  }

  return {
    knownInventoryValue: round2(knownInventoryValue),
    totalItems: rows.length,
    completeCount,
    incompleteCount,
    indeterminateCount,
    unreconciledCount,
    excludedCount,
    onHandByUnit,
    unvaluedByUnit,
  };
}

// Match a valued item against the API status filter. An item can qualify under
// more than one real condition — the filter tests the condition, not only the
// single display status.
function matchesStatus(it, status) {
  if (!status || status === "all") return true;
  if (status === STATUS.COMPLETE) return it.reconciled && it.fullyValued && !it.indeterminate;
  if (status === STATUS.INDETERMINATE) return !!it.indeterminate;
  if (status === STATUS.INCOMPLETE) return !it.fullyValued && !it.indeterminate;
  if (status === STATUS.UNRECONCILED) return !it.reconciled;
  return true;
}

// The lean projection the engine needs — used by the route and the overview so
// both read exactly the same evidence and can never disagree.
const VALUATION_PROJECTION =
  "sku name unit customUnit category quantity variants stockTransactions companyId";

module.exports = {
  valueItem,
  summarizeValued,
  matchesStatus,
  chronological,
  classify,
  KNOWN_IN,
  KNOWN_OUT,
  REASON,
  STATUS,
  VALUATION_PROJECTION,
};
