// services/storePurchase/stockCount.service.js
//
// Warehouse Stock Count V1 — the shared, testable core of a cycle count.
//
// ── ONE STOCK AUTHORITY, REUSED ─────────────────────────────────────────────
// Posting a count does NOT invent a second way to change stock. Every reviewed
// non-zero variance becomes ONE ordinary correction through the exact operation
// the canonical stock adjustment already uses:
//   · RawItem.quantity (+ the variant's quantity) — the company-wide on-hand,
//   · a RawItem.stockTransactions[] row — which is ALSO the valuation input the
//     inventoryValuation replay reads, so valuation follows for free and once,
//   · locStock.applyLocationIn / applyLocationOut — the immutable LocationMovement
//     ledger and its guarded LocationBalance projection.
// This file orchestrates those; it never holds a balance of its own.
//
// The pure functions below (variance, unit grouping, review validation, request
// hashing) touch no database and are unit-tested directly; the frontend mirrors
// their contract so desktop and mobile agree with the server on every figure.

"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const LocationBalance = require("../../models/CMS_Models/Inventory/Operations/LocationBalance");
const locStock = require("./locationStock.service");

const round4 = (n) => Math.round((Number(n) + Number.EPSILON) * 10000) / 10000;
const QTY_TOL = 1e-6;
const oid = (v) => (v == null ? null : new mongoose.Types.ObjectId(String(v)));

// ── PURE: one line's variance ────────────────────────────────────────────────
// A line only has a variance once it has actually been counted. "Not counted"
// is never a variance — it is an unanswered question, distinct from a recorded
// zero (`counted:true, countedQty:0`) which IS a variance against a positive
// expectation.
function lineVariance(line) {
  const counted = line.counted === true && typeof line.countedQty === "number";
  if (!counted) {
    return { counted: false, variance: null, hasVariance: false, direction: null };
  }
  const variance = round4(line.countedQty - line.expectedQty);
  const hasVariance = Math.abs(variance) > QTY_TOL;
  return {
    counted: true,
    variance,
    hasVariance,
    direction: !hasVariance ? null : variance > 0 ? "in" : "out",
  };
}

// ── PURE: progress across a set of lines ─────────────────────────────────────
function countProgress(lines = []) {
  let counted = 0;
  let remaining = 0;
  let discrepancies = 0;
  for (const l of lines) {
    const v = lineVariance(l);
    if (v.counted) {
      counted += 1;
      if (v.hasVariance) discrepancies += 1;
    } else {
      remaining += 1;
    }
  }
  return { total: lines.length, counted, remaining, discrepancies };
}

// ── PURE: review summary, grouped by unit — NEVER summed across units ────────
// Kilograms, metres and pieces are different quantities; adding them is adding
// nonsense. Every quantity total is kept inside its own unit, and rows with no
// recorded unit are counted separately rather than folded into a "0" bucket.
function summariseByUnit(lines = []) {
  const byUnit = new Map();
  let unitlessRows = 0;
  for (const l of lines) {
    const v = lineVariance(l);
    const unit = (l.baseUnit || "").trim();
    if (!unit) {
      unitlessRows += 1;
      // still track its variance count, but never a summed quantity
    }
    const key = unit || "(no unit)";
    const row = byUnit.get(key) || {
      unit: unit || null,
      lines: 0,
      counted: 0,
      expectedTotal: 0,
      countedTotal: 0,
      varianceTotal: 0,
      discrepancies: 0,
    };
    row.lines += 1;
    row.expectedTotal = round4(row.expectedTotal + (Number(l.expectedQty) || 0));
    if (v.counted) {
      row.counted += 1;
      row.countedTotal = round4(row.countedTotal + Number(l.countedQty));
      row.varianceTotal = round4(row.varianceTotal + v.variance);
      if (v.hasVariance) row.discrepancies += 1;
    }
    byUnit.set(key, row);
  }
  return { groups: [...byUnit.values()], unitlessRows };
}

// ── PURE: a "large variance" flag WITHOUT inventing an approval threshold ─────
// The brief forbids inventing an approval gate, but a big swing still deserves
// the eye. So this only FLAGS (never blocks): a variance is "large" when its
// magnitude is at least half of the expected quantity (or any positive count
// against a zero expectation). It changes nothing about whether a post is
// allowed — it is a visual cue, and the caller may ignore it.
function isLargeVariance(line) {
  const v = lineVariance(line);
  if (!v.counted || !v.hasVariance) return false;
  const exp = Math.abs(Number(line.expectedQty) || 0);
  if (exp <= QTY_TOL) return true; // stock where none was expected, or vice versa
  return Math.abs(v.variance) >= exp * 0.5;
}

// ── PURE: is this set ready to be REVIEWED / POSTED? ──────────────────────────
// Every non-zero variance must carry a reason. Missing is not zero: a row that
// was never counted is fine to leave (it simply will not post), but a counted
// row whose figure differs from expected must say why.
const MIN_REASON = 3;
function reviewProblems(lines = []) {
  const problems = [];
  for (const l of lines) {
    const v = lineVariance(l);
    if (v.counted && v.hasVariance) {
      const reason = String(l.varianceReason || "").trim();
      if (reason.length < MIN_REASON) {
        problems.push({
          lineId: String(l._id || ""),
          rawItemId: String(l.rawItemId || ""),
          variantId: l.variantId ? String(l.variantId) : null,
          reason: "REASON_REQUIRED",
        });
      }
    }
  }
  return problems;
}

// ── PURE: the canonical fingerprint of a review/post request ─────────────────
// The counted figures and reasons, in a stable order, so "the same post again"
// and "a different post under the same key" stay distinguishable forever — long
// after the temporary idempotency row has expired.
function hashCountRequest(lines = []) {
  const canonical = [...lines]
    .map((l) => ({
      lineId: String(l._id || l.lineId || ""),
      counted: l.counted === true,
      countedQty: l.counted === true ? round4(l.countedQty) : null,
      reason: String(l.varianceReason || "").trim(),
    }))
    .sort((a, b) => a.lineId.localeCompare(b.lineId));
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ── PURE: honest scope of what this count actually covers ─────────────────────
// A count is one LOCATION, never a "full warehouse". Within that, it may be the
// complete location snapshot, a search/category-filtered subset, and/or a subset
// that a counter added items to at the shelf. The outcome must say which, so a
// partially-counted, filtered session is never read as a complete one.
function countScope(count) {
  const f = count.filter || {};
  const hasFilter = Boolean(String(f.search || "").trim() || String(f.category || "").trim());
  const hasAdded = (count.lines || []).some((l) => l.addedDuringCount === true);
  let type;
  let label;
  if (hasFilter && hasAdded) { type = "FILTERED_PLUS_ADDED"; label = "A filtered selection of this location, plus items added during counting"; }
  else if (hasFilter) { type = "FILTERED"; label = "A filtered selection of this location"; }
  else if (hasAdded) { type = "SNAPSHOT_PLUS_ADDED"; label = "This location's stock on hand, plus items added during counting"; }
  else { type = "COMPLETE_LOCATION"; label = "The complete stock on hand at this location"; }
  return {
    type, hasFilter, hasAdded, label,
    search: String(f.search || "").trim(), category: String(f.category || "").trim(),
  };
}

// ── DB: build the frozen expected snapshot for a location ─────────────────────
// Expected = the location's projected on-hand for each (item, variant) that has
// a positive balance at this location right now. An empty location yields zero
// lines — a valid count. Optionally narrowed by an item/category search.
async function snapshotLines({ companyId, warehouseId, locationId, search = "", category = "", session = null }) {
  const balances = await LocationBalance.find({
    companyId: oid(companyId),
    warehouseId: oid(warehouseId),
    locationId: oid(locationId),
  })
    .session(session || null)
    .lean();

  // Positive balances only; the sentinel row (null location) never matches this
  // filter, so it cannot leak in.
  const held = balances.filter((b) => Number(b.onHand) > QTY_TOL);
  if (!held.length) return [];

  const itemIds = [...new Set(held.map((b) => String(b.itemId)))];
  const items = await RawItem.find({ companyId: oid(companyId), _id: { $in: itemIds.map(oid) } })
    .select("name sku unit customUnit category variants")
    .session(session || null)
    .lean();
  const itemById = new Map(items.map((it) => [String(it._id), it]));

  const esc = String(search || "").trim().toLowerCase();
  const cat = String(category || "").trim().toLowerCase();

  const lines = [];
  for (const b of held) {
    const item = itemById.get(String(b.itemId));
    if (!item) continue; // an orphan balance is never guessed into a fake row
    if (cat && String(item.category || "").toLowerCase() !== cat) continue;
    const variant = b.variantId
      ? (item.variants || []).find((v) => String(v._id) === String(b.variantId)) || null
      : null;
    if (esc) {
      const hay = `${item.name || ""} ${item.sku || ""} ${variant?.sku || ""} ${(variant?.combination || []).join(" ")}`.toLowerCase();
      if (!hay.includes(esc)) continue;
    }
    lines.push({
      rawItemId: item._id,
      rawItemName: item.name || "",
      rawItemSku: item.sku || "",
      variantId: variant ? variant._id : null,
      variantCombination: variant ? variant.combination || [] : [],
      variantSku: variant ? variant.sku || "" : "",
      baseUnit: item.customUnit || item.unit || "",
      expectedQty: round4(b.onHand),
      counted: false,
      countedQty: null,
      varianceReason: "",
    });
  }
  // Stable order: item name, then variant sku, so two snapshots of the same
  // location read the same way.
  lines.sort((a, b) =>
    (a.rawItemName || "").localeCompare(b.rawItemName || "") ||
    (a.variantSku || "").localeCompare(b.variantSku || ""));
  return lines;
}

// ── DB: apply ONE reviewed non-zero variance as a canonical correction ────────
// Called inside the post transaction, once per line that moved stock. Returns
// the before/after facts read from the ATOMIC writes, never a re-read.
//
// Conflict, not absorption: if the location's on-hand no longer equals the
// frozen expected, the shelf moved since the count began. This is thrown as a
// stable conflict for the caller to surface — never silently folded into the
// correction, which would post a figure nobody counted against.
async function applyLineCorrection(session, {
  tenant, count, line, actor, opKey, RawItemModel = RawItem, fail,
}) {
  const v = lineVariance(line);
  if (!v.counted || !v.hasVariance) return null; // zero-variance rows move nothing

  const companyId = tenant.companyId;
  const itemId = line.rawItemId;
  const variantId = line.variantId || null;
  const qty = Math.abs(v.variance);
  const signed = v.variance; // + for in, − for out
  const expected = round4(line.expectedQty);

  // 1 · CONFLICT CHECK — has the location balance moved since the snapshot?
  const currentLoc = await locStock.locationOnHand(
    session, companyId, itemId, variantId, count.warehouseId, count.locationId,
  );
  if (Math.abs(currentLoc - expected) > QTY_TOL) {
    throw fail("CONFLICT",
      `${line.rawItemName} moved at ${count.locationCode || "this location"} after the count began (expected ${expected}, now ${currentLoc}). Re-count before posting.`,
      { reason: "BALANCE_CHANGED", lineId: String(line._id), rawItemId: String(itemId), expected, current: currentLoc });
  }

  // 2 · COMPANY ON-HAND — atomic, guarded so a negative result is refused, and
  // so a value that moved under us matches nothing (a conflict, not a clobber).
  const guard = signed < 0 ? { quantity: { $gte: qty - QTY_TOL } } : {};
  const variantGuard = variantId
    ? (signed < 0
        ? { variants: { $elemMatch: { _id: oid(variantId), quantity: { $gte: qty - QTY_TOL } } } }
        : { variants: { $elemMatch: { _id: oid(variantId) } } })
    : {};
  const inc = { $inc: { quantity: signed } };
  const arrayFilters = [];
  if (variantId) {
    inc.$inc["variants.$[v].quantity"] = signed;
    arrayFilters.push({ "v._id": oid(variantId) });
  }
  const updated = await RawItemModel.findOneAndUpdate(
    { companyId: oid(companyId), _id: oid(itemId), ...guard, ...variantGuard },
    inc,
    { new: true, session, ...(arrayFilters.length ? { arrayFilters } : {}) },
  );
  if (!updated) {
    throw fail("CONFLICT",
      `${line.rawItemName} could not be corrected: its company balance changed while the count was posting. Re-read and count again.`,
      { reason: "COMPANY_BALANCE_CHANGED", lineId: String(line._id), rawItemId: String(itemId) });
  }

  const companyAfter = round4(updated.quantity);
  const companyBefore = round4(companyAfter - signed);
  const uv = variantId ? (updated.variants || []).find((x) => String(x._id) === String(variantId)) : null;
  const variantAfter = uv ? round4(uv.quantity) : null;
  const variantBefore = uv ? round4(variantAfter - signed) : null;

  // 3 · LOCATION LEDGER + PROJECTION — the immutable movement and its guard.
  const warehouse = { _id: count.warehouseId, name: count.warehouseName, shortName: count.warehouseShortName };
  const location = { _id: count.locationId, code: count.locationCode, name: count.locationName };
  const common = {
    companyId, siteId: tenant.siteId || null,
    item: updated, variantId,
    warehouse, location, quantity: qty,
    type: "adjustment",
    source: { kind: "stock_count", id: count._id, reference: count.countNumber },
    actor: { id: actor.id, name: actor.name },
    note: String(line.varianceReason || "").trim(),
    idempotencyKey: locStock.movementLineKey(opKey, String(line._id), "count"),
    operationKey: opKey || "",
  };
  let movement;
  if (signed > 0) {
    const res = await locStock.applyLocationIn(session, { ...common, intent: "receive" });
    movement = res.movement;
  } else {
    const res = await locStock.applyLocationOut(session, common);
    if (!res.ok) {
      // Location matched `expected` above, so this is a genuine race, not a plain
      // shortfall — reported as a stable conflict.
      throw fail("CONFLICT",
        `${line.rawItemName} moved at ${count.locationCode || "this location"} while the count was posting. Re-count before posting.`,
        { reason: "LOCATION_BALANCE_CHANGED", lineId: String(line._id), rawItemId: String(itemId) });
    }
    movement = res.movement;
  }
  const locationAfter = round4(expected + signed);

  // 4 · CANONICAL STOCK HISTORY / VALUATION INPUT — one stockTransaction row,
  // in the exact shape the valuation replay and the movement history already
  // read. Positive variance is an ADD, negative a REDUCE (variant-scoped when a
  // variant was counted).
  const txType = signed > 0
    ? (variantId ? "VARIANT_ADD" : "ADD")
    : (variantId ? "VARIANT_REDUCE" : "REDUCE");
  const tx = {
    type: txType,
    quantity: qty,
    previousQuantity: companyBefore,
    newQuantity: companyAfter,
    reason: `Stock count ${count.countNumber}: ${String(line.varianceReason || "").trim()}`,
    notes: `Counted ${round4(line.countedQty)} vs expected ${expected} ${line.baseUnit || ""}`.trim(),
    performedBy: actor.id || null,
    operationId: count._id,
    ...locStock.txLocationSnapshot(warehouse, location),
  };
  if (variantId) {
    tx.variantId = oid(variantId);
    tx.variantCombination = line.variantCombination || [];
  }
  if (variantBefore !== null) {
    tx.variantPreviousQuantity = variantBefore;
    tx.variantNewQuantity = variantAfter;
  }
  updated.stockTransactions.push(tx);
  updated.status = updated.quantity <= 0 ? "Out of Stock"
    : updated.quantity <= (updated.minStock || 0) ? "Low Stock" : "In Stock";
  await updated.save({ session });

  return {
    lineId: line._id,
    rawItemId: itemId,
    rawItemName: line.rawItemName,
    variantId,
    direction: signed > 0 ? "in" : "out",
    quantity: qty,
    companyBefore,
    companyAfter,
    variantBefore,
    variantAfter,
    locationBefore: expected,
    locationAfter,
    movementId: movement ? movement._id : null,
    unit: line.baseUnit || "",
  };
}

module.exports = {
  round4,
  QTY_TOL,
  MIN_REASON,
  lineVariance,
  countProgress,
  summariseByUnit,
  isLargeVariance,
  reviewProblems,
  hashCountRequest,
  countScope,
  snapshotLines,
  applyLineCorrection,
};
