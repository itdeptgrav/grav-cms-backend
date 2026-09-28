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
  // A landed-cost allocation names a receipt movement that is not in this item's
  // stream — it is reported, never guessed onto some other movement.
  MISSING_ALLOCATION_TARGET: "MISSING_ALLOCATION_TARGET",
  // A landed-cost allocation targets a receipt whose base cost is unknown —
  // landed cost cannot make an unpriced receipt magically valued.
  LANDED_WITHOUT_BASE: "LANDED_WITHOUT_BASE",
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
  let value = 0; // EFFECTIVE value (base + landed), meaningful while !indeterminate
  let baseValue = 0; // BASE value (receipt price only), same qty flow as `value`
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
      baseValue = 0;
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
          const landedPerUnit = isNum(c.landedPerUnit) ? c.landedPerUnit : 0;
          valuedQty += c.qty;
          baseValue += c.qty * c.unitCost;
          value += c.qty * (c.unitCost + landedPerUnit); // effective = base + landed
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
        // unambiguous. Each lane is removed at its OWN average of the shared
        // valued quantity, so the landed portion left in stock stays exactly
        // proportional (a partial issue carries out its share of landed cost).
        const avg = valuedQty > QTY_TOL ? value / valuedQty : 0;
        const baseAvg = valuedQty > QTY_TOL ? baseValue / valuedQty : 0;
        const fromValued = Math.min(c.qty, valuedQty);
        valuedQty -= fromValued;
        value -= fromValued * avg;
        baseValue -= fromValued * baseAvg;
        if (c.qty - fromValued > QTY_TOL) negativeReplay = true; // out > on hand
      }
      qtyOnHand -= c.qty;
      if (qtyOnHand < -QTY_TOL) negativeReplay = true;
      resetIfEmpty();
    }
  }

  if (Math.abs(value) < 0.005) value = 0; // clear float dust to a clean zero
  if (Math.abs(baseValue) < 0.005) baseValue = 0;
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
  const baseStockValue = indeterminate ? null : round2(baseValue);
  const landedInStock = indeterminate ? null : round2(value - baseValue);
  const baseAvgCost = indeterminate
    ? null
    : valuedQty > QTY_TOL
      ? round4(baseValue / valuedQty)
      : null;

  return {
    qtyOnHand,
    valuedQty: indeterminate ? null : valuedQty,
    unvaluedQty: indeterminate ? null : unvaluedQty,
    replayQty: qtyOnHand,
    value: knownValue, // EFFECTIVE known value (base + landed) — null when indeterminate
    baseStockValue, // base receipt value only — null when indeterminate
    landedInStock, // landed cost still carried in on-hand stock — null when indeterminate
    avgCost, // effective moving average — null when indeterminate
    baseAvgCost, // base moving average — null when indeterminate
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

  // ── OWNERSHIP SPLIT ────────────────────────────────────────────────────────
  // Customer-supplied stock is physically on our shelves — it IS in
  // RawItem.quantity and in these movements — but it is the CUSTOMER'S property.
  // It must be excluded from company inventory value and company-owned on-hand,
  // never valued, never landed-costed, and never drag the company figure into
  // MISSING_INBOUND_PRICE / indeterminate merely for being unpriced. A movement
  // is customer-owned when its id is in the lot-provenance set
  // (CustomerMaterialLot.movements[].stockTransactionId — so HISTORICAL movements
  // are covered with no backfill) OR it carries the explicit `ownership:"CUSTOMER"`
  // marker written on new customer movements. With neither present the split is a
  // no-op and this behaves exactly as V1/V2 did.
  const custIds = opts.customerOwnedTxIds instanceof Set
    ? opts.customerOwnedTxIds
    : new Set(Array.isArray(opts.customerOwnedTxIds) ? opts.customerOwnedTxIds.map(String) : []);
  const isCust = (m) => custIds.has(String(m._id || "")) || m.ownership === "CUSTOMER";
  const companySorted = sorted.filter((m) => !isCust(m));
  const customerSorted = sorted.filter((m) => isCust(m));

  // ── LANDED-COST OVERLAY (V2) ───────────────────────────────────────────────
  // Layer active landed-cost allocations onto their EXACT receipt movements.
  // Never touches stockTransactions[].unitPrice; only annotates a per-unit
  // landed cost the replay adds on top of the base price for that receipt.
  // Customer-owned movements are NEVER landed-costed — an allocation naming one
  // falls through to LANDED_WITHOUT_BASE, reported, never applied.
  const landedMap =
    opts.landedByMovement instanceof Map
      ? opts.landedByMovement
      : new Map(Object.entries(opts.landedByMovement || {}));
  const receipts = [];
  const landedReasons = new Set();
  const landedExceptions = [];
  const resolvedTargets = new Set();
  for (const m of sorted) {
    const mid = String(m._id || "");
    const c = m.__class;
    const landed = landedMap.get(mid);
    if (c.ok && c.dir === "in" && c.priced && !isCust(m)) {
      const perUnit = landed && isNum(landed.perUnit) ? landed.perUnit : 0;
      c.landedPerUnit = perUnit; // consumed by replayMovements
      if (landed) resolvedTargets.add(mid);
      if (perUnit !== 0 || landed) {
        receipts.push({
          movementId: mid,
          variantId: m.variantId != null ? String(m.variantId) : null,
          quantity: c.qty,
          baseUnitCost: round4(c.unitCost),
          landedPerUnit: round4(perUnit),
          effectiveUnitCost: round4(c.unitCost + perUnit),
          sources: landed ? landed.sources || [] : [],
          at: timeOf(m) ? new Date(timeOf(m)) : null,
        });
      }
    } else if (landed) {
      // The allocation names a real movement, but it is not a company priced
      // inbound — landed cost cannot value an unpriced/customer/indeterminate one.
      resolvedTargets.add(mid);
      landedReasons.add(REASON.LANDED_WITHOUT_BASE);
    }
  }
  // An allocation whose target movement is not in this item at all is an
  // exception — reported, never guessed onto another movement.
  for (const mid of landedMap.keys()) {
    if (!resolvedTargets.has(mid)) {
      landedExceptions.push({ reason: REASON.MISSING_ALLOCATION_TARGET, _id: mid });
      landedReasons.add(REASON.MISSING_ALLOCATION_TARGET);
    }
  }

  // Company valuation replays ONLY company-owned movements; reconciliation
  // replays EVERY physical movement; customer on-hand is the customer net.
  const itemReplay = replayMovements(companySorted);
  itemReplay.exceptions.push(...landedExceptions);
  for (const r of landedReasons) itemReplay.reasons.push(r);
  const physicalReplay = replayMovements(sorted);
  const customerReplay = replayMovements(customerSorted);

  const storedOnHand = isNum(item.quantity) ? item.quantity : 0;
  // Reconciliation is PHYSICAL: the stored on-hand must equal every physical
  // movement, company and customer alike (customer goods are on the shelf).
  const difference = round4(storedOnHand - physicalReplay.replayQty);
  const reconciled = Math.abs(difference) <= QTY_TOL;

  const reasons = new Set(itemReplay.reasons);
  if (!reconciled) reasons.add(REASON.BALANCE_MISMATCH);
  if (physicalReplay.negativeReplay) reasons.add(REASON.NEGATIVE_REPLAY);

  const physicalOnHand = round4(physicalReplay.replayQty);
  const companyOwnedOnHand = round4(itemReplay.replayQty);
  const customerOwnedOnHand = round4(customerReplay.replayQty);

  // Variant breakdown (only when asked). Whole-item / unassigned movements are
  // replayed in their own bucket, never distributed across variants by guess.
  // Each variant separates the same three ways: physical reconcile, company
  // value, customer-owned quantity.
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
      const companyGroup = group.filter((m) => !isCust(m));
      const customerGroup = group.filter((m) => isCust(m));
      const r = replayMovements(companyGroup); // company value for this variant
      const phys = replayMovements(group); // physical, for reconciliation
      const cust = replayMovements(customerGroup); // customer-owned quantity
      const stored = k === "__unassigned__" ? null : storedById.get(k);
      const storedQty = stored && isNum(stored.quantity) ? stored.quantity : null;
      const vDiff = storedQty == null ? null : round4(storedQty - phys.replayQty);
      const vReconciled = storedQty == null ? null : Math.abs(vDiff) <= QTY_TOL;
      variants.push({
        variantId: k === "__unassigned__" ? null : k,
        unassigned: k === "__unassigned__",
        sku: stored ? stored.sku || "" : "",
        combination: stored ? stored.combination || [] : [],
        unit, // variants share the item's base unit — never a second unit
        storedOnHand: storedQty,
        replayedOnHand: round4(phys.replayQty), // physical
        physicalOnHand: round4(phys.replayQty),
        companyOwnedOnHand: round4(r.replayQty),
        customerOwnedOnHand: round4(cust.replayQty),
        valuedQty: r4(r.valuedQty),
        unvaluedQty: r4(r.unvaluedQty),
        avgCost: r.avgCost, // null when indeterminate
        knownValue: r.value, // company value only — null when indeterminate, never ₹0
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
    // Physical on-hand (every movement) — the figure reconciliation checks.
    replayedOnHand: physicalOnHand,
    physicalOnHand,
    // Company-owned on-hand and customer-owned on-hand, split explicitly.
    companyOwnedOnHand,
    customerOwnedOnHand,
    // CURRENT positive customer-owned on-hand (what is on the shelf now) —
    // distinct from mere historical presence, so a count of "items holding
    // customer property" means what it says.
    hasCustomerOwnedStock: customerOwnedOnHand > QTY_TOL,
    // Any customer movement ever (received/issued/returned), even if nothing is
    // held now — useful for provenance, never conflated with the current count.
    hadCustomerOwnedMovement: customerSorted.length > 0,
    valuedQty: r4(itemReplay.valuedQty), // null when indeterminate — COMPANY only
    unvaluedQty: r4(itemReplay.unvaluedQty), // null when indeterminate — COMPANY only
    avgCost: itemReplay.avgCost, // EFFECTIVE moving average (base+landed), or null when indeterminate
    baseAvgCost: itemReplay.baseAvgCost, // base-only moving average, or null when indeterminate
    knownValue: itemReplay.value, // COMPANY known value INCL. landed — excludes customer stock; null when indeterminate, never ₹0
    baseStockValue: itemReplay.baseStockValue, // base receipt value only (company)
    landedInStock: itemReplay.landedInStock, // landed cost still in company on-hand stock
    hasLandedCost: receipts.some((r) => r.landedPerUnit && r.landedPerUnit !== 0),
    receipts, // per priced COMPANY receipt: base / landed / effective unit cost + source
    valueState: itemReplay.valueState, // complete | partly_unvalued | indeterminate (company)
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
  let knownInventoryValue = 0; // includes landed cost still in stock
  let baseStockValue = 0; // base receipt value only
  let landedInStock = 0; // landed cost still carried in on-hand stock
  let completeCount = 0;
  let incompleteCount = 0;
  let indeterminateCount = 0;
  let unreconciledCount = 0;
  let excludedCount = 0; // items whose value is partly/fully excluded
  let itemsWithLandedCost = 0;
  let customerOwnedItemCount = 0; // items holding customer property NOW
  let itemsWithCustomerHistory = 0; // items with any customer movement ever
  const onHandByUnit = {}; // PHYSICAL on-hand (company + customer) — reconciliation view
  const companyOwnedOnHandByUnit = {};
  const customerOwnedOnHandByUnit = {};
  const unvaluedByUnit = {};

  const num = (v) => (isNum(v) ? v : 0);
  const physicalOf = (it) => (isNum(it.physicalOnHand) ? it.physicalOnHand : it.replayedOnHand);

  for (const it of rows) {
    // Only a genuinely-known COMPANY value contributes. Customer-owned stock is
    // never in it.knownValue (the engine excluded it), so the company total is
    // customer-free by construction — never as ₹0, never indeterminate for it.
    knownInventoryValue += num(it.knownValue);
    baseStockValue += num(it.baseStockValue);
    landedInStock += num(it.landedInStock);
    if (it.hasLandedCost) itemsWithLandedCost += 1;
    // Count only items with CURRENT positive customer-owned on-hand, not every
    // item that merely has historical customer movements.
    if (it.hasCustomerOwnedStock) customerOwnedItemCount += 1;
    if (it.hadCustomerOwnedMovement) itemsWithCustomerHistory += 1;
    if (it.status === STATUS.COMPLETE) completeCount += 1;
    if (it.indeterminate) indeterminateCount += 1;
    else if (!it.fullyValued) incompleteCount += 1; // partly-unvalued / exceptions / pending
    if (!it.reconciled) unreconciledCount += 1;
    if (!it.fullyValued || it.indeterminate || it.hasExceptions) excludedCount += 1;

    const unit = it.unit || "—";
    // Quantities never sum across units — each stays grouped by its own unit.
    onHandByUnit[unit] = round4((onHandByUnit[unit] || 0) + num(physicalOf(it)));
    companyOwnedOnHandByUnit[unit] = round4((companyOwnedOnHandByUnit[unit] || 0) + num(it.companyOwnedOnHand));
    if (num(it.customerOwnedOnHand) > QTY_TOL) {
      customerOwnedOnHandByUnit[unit] = round4((customerOwnedOnHandByUnit[unit] || 0) + num(it.customerOwnedOnHand));
    }
    if (isNum(it.unvaluedQty) && it.unvaluedQty > QTY_TOL) {
      unvaluedByUnit[unit] = round4((unvaluedByUnit[unit] || 0) + it.unvaluedQty);
    }
  }

  return {
    // Company inventory value — customer-owned property is excluded, by construction.
    knownInventoryValue: round2(knownInventoryValue), // incl. landed cost in stock
    companyInventoryValue: round2(knownInventoryValue), // explicit alias for the ownership-aware caller
    baseStockValue: round2(baseStockValue),
    landedInStock: round2(landedInStock),
    totalItems: rows.length,
    completeCount,
    incompleteCount,
    indeterminateCount,
    unreconciledCount,
    excludedCount,
    itemsWithLandedCost,
    customerOwnedItemCount, // items holding customer property NOW (positive customer on-hand)
    itemsWithCustomerHistory, // items with any customer movement ever (may hold none now)
    // Three on-hand views, each grouped by unit and never summed across units:
    onHandByUnit, // physical (company + customer) — what a stock-take counts
    physicalOnHandByUnit: onHandByUnit, // explicit alias
    companyOwnedOnHandByUnit, // the company's own goods
    customerOwnedOnHandByUnit, // customer property physically held, excluded from value
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
