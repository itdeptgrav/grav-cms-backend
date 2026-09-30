// services/storePurchase/poMaterialLink.service.js
//
// REPAIR A MISSING MATERIAL IDENTITY ON AN ISSUED PURCHASE-ORDER LINE.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
// A legacy line saved without `rawItem` cannot be received: the receiving
// engine has no stock balance to credit and no registered unit to convert
// into. This command supplies that one missing identity — the material, and
// the exact variant where the material has variants — and nothing else.
//
// It is NOT an editor for issued orders. The description, the ordered
// quantity, the PO unit, the price, the tax, the supplier, the totals, the
// approval state and every receipt already recorded are read and left exactly
// as they are. A line that already carries a valid link is refused, because
// replacing an identity is a different decision with a different audit trail.
//
// ── EVERY REFUSAL IS A NAMED ONE ────────────────────────────────────────────
// Company scope (another company's order or material answers as missing),
// order state, line existence, an existing link, receipt history, variant
// membership and unit compatibility are each checked and each refused with a
// code a screen can act on. Nothing is mutated before every check has passed,
// and the state change and its history entry commit together where the
// deployment supports a transaction.
"use strict";

const mongoose = require("mongoose");

const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const GoodsReceipt = require("../../models/CMS_Models/StorePurchase/GoodsReceipt");
const tenantContext = require("./tenantContext.service");
const actionHistory = require("./actionHistory.service");
const { resolveConversion } = require("./receiptPosting.service");
const { fail } = require("./errors");

const ENTITY = "PURCHASE_ORDER";
/** The audit reason every repair carries, verbatim. */
const REASON = "REPAIR_MISSING_MATERIAL_LINK";
const ACTION = "MATERIAL_LINK_REPAIRED";

/** Issued orders only: a draft is edited through the editor; a cancelled or
 *  completed order has nothing left to receive. */
const REPAIRABLE_STATES = Object.freeze(["ISSUED", "PARTIALLY_RECEIVED"]);

const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
const validId = (v) => mongoose.isValidObjectId(str(v));

/** The registered stock unit of a material, as the catalogue states it. */
const registeredUnitOf = (rawItem) => str(rawItem?.customUnit) || str(rawItem?.unit);

/** The variant's attributes as words — the same joining the PO line uses. */
const combinationOf = (variant) => (Array.isArray(variant?.combination) ? variant.combination : [])
  .map(str).filter(Boolean);

/**
 * Has anything ever been received against this line?
 *
 * Two places can say so, and both are read: the line's own received figure
 * (which every receipt path, legacy included, updates) and an authoritative
 * goods receipt naming the line. Either refuses the repair — changing the
 * identity behind a receipt would orphan the stock it moved. The order's
 * `deliveries` are un-itemised summaries and cannot name a line, so they are
 * not consulted; the line figure already carries what they recorded.
 */
async function receiptHistoryOf(ctx, purchaseOrder, line) {
  if (Number(line.receivedQuantity) > 0) {
    return { any: true, source: "line", description: `${line.receivedQuantity} ${line.unit || ""} already received on this line`.trim() };
  }
  const receipts = await GoodsReceipt.countDocuments({
    companyId: ctx.companyId,
    purchaseOrderId: purchaseOrder._id,
    "lines.poItemId": line._id,
  });
  if (receipts > 0) {
    return { any: true, source: "goodsReceipts", description: `${receipts} goods receipt(s) name this line` };
  }
  return { any: false };
}

/**
 * Repair one line's missing material link.
 *
 * @param ctx      the tenant context from requireTenant (company, actor, caps)
 * @param command  { poId, lineId, rawItemId, variantId? }
 * @param meta     { idempotencyKey?, requestId? }
 * @returns {{ purchaseOrder, line, unit, unchanged }}
 */
async function repairMissingMaterialLink(ctx, { poId, lineId, rawItemId, variantId = null } = {}, meta = {}) {
  if (!ctx?.companyId) throw fail("UNAUTHENTICATED", "Sign in to use Store & Purchase.");
  if (!validId(poId)) throw fail("NOT_FOUND", "Purchase order not found.");
  if (!validId(lineId)) throw fail("NOT_FOUND", "That purchase-order line was not found on this order.");
  if (!validId(rawItemId)) {
    throw fail("VALIDATION", "Choose the material this line is for.", { field: "rawItemId", reason: "MATERIAL_REQUIRED" });
  }
  if (variantId !== null && variantId !== undefined && str(variantId) && !validId(variantId)) {
    throw fail("VALIDATION", "That variant reference is not valid.", { field: "variantId", reason: "VARIANT_INVALID" });
  }

  /* ── The order, in this company ────────────────────────────────────────── */
  const purchaseOrder = await PurchaseOrder.findOne({ _id: poId, ...tenantContext.tenantFilter(ctx) });
  if (!purchaseOrder) throw fail("NOT_FOUND", "Purchase order not found.");

  if (!REPAIRABLE_STATES.includes(str(purchaseOrder.status))) {
    if (purchaseOrder.status === "DRAFT") {
      throw fail("LIFECYCLE_BLOCKED", "This order is still a draft. Set the material on the line in the order editor instead.",
        { reason: "ORDER_NOT_ISSUED", status: purchaseOrder.status });
    }
    throw fail("LIFECYCLE_BLOCKED", `This order is ${str(purchaseOrder.status).toLowerCase().replace(/_/g, " ")}, so its lines are no longer repaired.`,
      { reason: "ORDER_CLOSED", status: purchaseOrder.status });
  }

  const line = purchaseOrder.items.id(lineId);
  if (!line) throw fail("NOT_FOUND", "That purchase-order line was not found on this order.");

  /* ── The material and its variant, in this company only ────────────────
     Strict company scope: a material that is legacy-global or another
     company's answers exactly as one that does not exist. */
  const rawItem = await RawItem.findOne({ _id: rawItemId, companyId: ctx.companyId })
    .select("name sku unit customUnit variants")
    .lean();
  if (!rawItem) throw fail("NOT_FOUND", "That material was not found in this company's catalogue.", { reason: "MATERIAL_NOT_FOUND" });

  const variants = Array.isArray(rawItem.variants) ? rawItem.variants : [];
  let variant = null;
  if (variants.length > 0) {
    if (!str(variantId)) {
      throw fail("VALIDATION", "This material has variants. Choose the exact variant this line is for.",
        { field: "variantId", reason: "VARIANT_REQUIRED", variantCount: variants.length });
    }
    variant = variants.find((v) => String(v._id) === str(variantId)) || null;
    if (!variant) {
      throw fail("VALIDATION", "That variant does not belong to the chosen material.",
        { field: "variantId", reason: "VARIANT_MISMATCH" });
    }
  } else if (str(variantId)) {
    throw fail("VALIDATION", "This material has no variants, so a variant cannot be chosen for it.",
      { field: "variantId", reason: "VARIANT_NOT_APPLICABLE" });
  }

  /* ── Already linked: same answer is idempotent, a different one is refused ── */
  const existing = str(line.rawItem?._id || line.rawItem);
  if (existing) {
    const sameMaterial = existing === String(rawItem._id);
    const sameVariant = str(line.variantId) === str(variant?._id);
    if (sameMaterial && sameVariant) {
      return {
        purchaseOrder: await readBack(ctx, purchaseOrder._id),
        line: summarise(line, rawItem, variant),
        unit: await unitCheck(line, rawItem),
        unchanged: true,
      };
    }
    throw fail("CONFLICT", "This line already has a material link. Repairing replaces nothing — a different material is a different decision.",
      { reason: "LINE_ALREADY_LINKED", rawItemId: existing });
  }

  /* ── Receipt history refuses the repair ─────────────────────────────────── */
  const history = await receiptHistoryOf(ctx, purchaseOrder, line);
  if (history.any) {
    throw fail("LIFECYCLE_BLOCKED", "Something has already been received against this line, so its identity cannot be changed. This needs reconciliation.",
      { reason: "LINE_HAS_RECEIPTS", source: history.source, description: history.description });
  }

  /* ── Units: identical, or a recorded conversion. Never assumed. ─────────── */
  const unit = await unitCheck(line, rawItem);

  /* ── The one change, with its history, together ─────────────────────────── */
  const previous = { rawItem: null, variantId: str(line.variantId) || null, baseUnit: str(line.baseUnit) || null };
  await actionHistory.recordWithState(ctx, async (session) => {
    line.rawItem = rawItem._id;
    line.variantId = variant ? variant._id : null;
    if (variant && !(Array.isArray(line.variantCombination) && line.variantCombination.length)) {
      line.variantCombination = combinationOf(variant);
    }
    /* The registered unit at repair time — what the receipt engine converts
       into. A snapshot the architecture requires; nothing commercial. */
    line.baseUnit = unit.registeredUnit;
    await purchaseOrder.save(session ? { session } : {});
    return {
      result: null,
      entry: {
        entityType: ENTITY,
        entityId: purchaseOrder._id,
        documentNumber: purchaseOrder.poNumber,
        action: ACTION,
        previousState: purchaseOrder.status,
        resultingState: purchaseOrder.status,
        reason: REASON,
        requestId: meta.requestId || "",
        idempotencyKey: meta.idempotencyKey || "",
        changes: [
          { field: `items.${line._id}.rawItem`, from: previous.rawItem, to: String(rawItem._id) },
          { field: `items.${line._id}.variantId`, from: previous.variantId, to: variant ? String(variant._id) : null },
          { field: `items.${line._id}.baseUnit`, from: previous.baseUnit, to: unit.registeredUnit },
        ],
        metadata: {
          poId: String(purchaseOrder._id),
          poNumber: str(purchaseOrder.poNumber),
          poLineId: String(line._id),
          /* History metadata keeps scalars only and drops nulls, so absence is
             said in words rather than left as a missing key. */
          previousIdentity: "MISSING",
          rawItemId: String(rawItem._id),
          rawItemName: str(rawItem.name),
          rawItemSku: str(rawItem.sku),
          variantId: variant ? String(variant._id) : "NOT_APPLICABLE",
          variantSku: variant ? str(variant.sku) || "NONE" : "NOT_APPLICABLE",
          variantAttributes: variant ? combinationOf(variant) : [],
          poUnit: unit.poUnit,
          registeredUnit: unit.registeredUnit,
          conversionFactor: unit.factor,
        },
      },
    };
  });

  return {
    purchaseOrder: await readBack(ctx, purchaseOrder._id),
    line: summarise(line, rawItem, variant),
    unit,
    unchanged: false,
  };
}

/** PO unit against the material's registered unit: same, or a recorded conversion. */
async function unitCheck(line, rawItem) {
  const poUnit = str(line.unit);
  const registeredUnit = registeredUnitOf(rawItem);
  if (!registeredUnit) {
    throw fail("VALIDATION", "This material has no registered stock unit, so what a receipt would put into stock cannot be established. Set its base unit first.",
      { field: "rawItemId", reason: "MATERIAL_UNIT_MISSING" });
  }
  if (!poUnit) {
    throw fail("VALIDATION", "This line has no recorded unit, so it cannot be matched to a material's unit.",
      { field: "lineId", reason: "LINE_UNIT_MISSING" });
  }
  if (poUnit === registeredUnit) return { poUnit, registeredUnit, factor: 1, same: true };
  let conv;
  try {
    conv = await resolveConversion({ quantity: 1, fromUnit: poUnit, toUnit: registeredUnit });
  } catch (err) {
    if (err?.name === "StorePurchaseError") {
      throw fail("VALIDATION",
        `No unit conversion from "${poUnit}" to "${registeredUnit}" is recorded, so this line cannot be linked to this material yet. Add the conversion in the unit master, then link.`,
        { field: "unit", reason: "UOM_CONVERSION_MISSING", poUnit, registeredUnit });
    }
    throw err;
  }
  if (!Number.isFinite(conv.factor) || conv.factor <= 0) {
    throw fail("VALIDATION", `The recorded conversion from "${poUnit}" to "${registeredUnit}" is not a usable number.`,
      { field: "unit", reason: "UOM_CONVERSION_INVALID", poUnit, registeredUnit });
  }
  return { poUnit, registeredUnit, factor: conv.factor, same: false };
}

function summarise(line, rawItem, variant) {
  return {
    id: String(line._id),
    rawItemId: String(rawItem._id),
    rawItemName: str(rawItem.name),
    rawItemSku: str(rawItem.sku),
    variantId: variant ? String(variant._id) : null,
    variantSku: variant ? str(variant.sku) : null,
    variantAttributes: variant ? combinationOf(variant) : [],
  };
}

/** The order as GET /:id returns it, so a client can replace what it holds. */
async function readBack(ctx, id) {
  return PurchaseOrder.findOne({ _id: id, ...tenantContext.tenantFilter(ctx) })
    .populate("vendor", "companyName contactPerson phone email address gstNumber bankDetails")
    .populate("items.rawItem", "name sku unit description sellingPrice defaultOwnership")
    .populate("createdBy", "name email")
    .populate("approvedBy", "name email")
    .lean();
}

module.exports = { repairMissingMaterialLink, REASON, ACTION, REPAIRABLE_STATES, unitCheck };
