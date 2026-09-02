// routes/CMS_Routes/Inventory/Products/stockItemRoutes.js

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const StockItem = require("../../../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../../../models/Employee");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Unit = require("../../../../models/CMS_Models/Inventory/Configurations/Unit");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const OperationGroup = require("../../../../models/CMS_Models/Inventory/Configurations/OperationGroup");
const { recordChange, historyFor } = require("../../../../services/changeLog");
// departmentNotify is no longer imported here — the two product-creation
// emails it used to send were removed 28 Aug 2026 (see the note in POST /).

const STOCK_ITEM_CATEGORIES = [
  "T-Shirts", "Shirts", "Jeans", "Bottoms", "Ethnic Wear",
  "Kids Wear", "Sportswear", "Sweatshirts", "Outerwear",
  "Accessories", "Innerwear", "Formal Wear", "Casual Wear",
  "Traditional Wear", "Winter Wear", "Summer Wear"
];

const OPERATION_TYPES = [
  "Cutting", "Stitching", "Finishing", "Printing", "Embroidery",
  "Washing", "Ironing", "Quality Check", "Packing", "Labeling"
];

router.use(EmployeeAuthMiddleware);

// escapeHtml lived here only to build the two product-creation notification
// emails, and went with them (28 Aug 2026).

// ─────────────────────────────────────────────────────────────────────────────
// Helper: Build a map of unitName → { baseUnit, conversions: [{toUnit, factor}] }
// ─────────────────────────────────────────────────────────────────────────────
async function buildUnitConversionsMap() {
  try {
    const units = await Unit.find({ status: "Active" }).populate("conversions.toUnit", "name");
    const map = {};

    units.forEach(u => {
      if (!map[u.name]) map[u.name] = { baseUnit: u.name, conversions: [] };
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName) return;
        map[u.name].conversions.push({ toUnit: toUnitName, factor: c.quantity });
      });
    });

    units.forEach(u => {
      (u.conversions || []).forEach(c => {
        const toUnitName = c.toUnit?.name || c.toUnit;
        if (!toUnitName || !c.quantity) return;
        if (!map[toUnitName]) map[toUnitName] = { baseUnit: toUnitName, conversions: [] };
        const alreadyHas = map[toUnitName].conversions.some(x => x.toUnit === u.name);
        if (!alreadyHas) {
          map[toUnitName].conversions.push({ toUnit: u.name, factor: 1 / c.quantity });
        }
      });
    });

    return map;
  } catch (err) {
    console.error("buildUnitConversionsMap:", err);
    return {};
  }
}

async function processVariantRawItems(rawItemsInput) {
  const processedRawItems = [];
  if (!rawItemsInput || !Array.isArray(rawItemsInput) || !rawItemsInput.length) return processedRawItems;

  // requiredQuantity/allowancePercent drive the effective quantity — see below.
  // Legacy callers that only send `quantity` (no breakdown) fall back to
  // requiredQuantity = quantity, allowancePercent = 0, same as before.
  const validInputs = rawItemsInput.filter(ri => {
    const req = ri.requiredQuantity != null ? parseFloat(ri.requiredQuantity) : parseFloat(ri.quantity);
    return ri.rawItemId && req > 0;
  });
  if (!validInputs.length) return processedRawItems;

  // ── ONE batch query instead of N sequential findById calls ───────────────
  const uniqueIds = [...new Set(validInputs.map(ri => ri.rawItemId.toString()))];
  const rawDocs = await RawItem.find({ _id: { $in: uniqueIds } })
    .select("name sku unit customUnit variants sellingPrice stockTransactions")
    .lean();
  const rawDocMap = new Map(rawDocs.map(d => [d._id.toString(), d]));

  for (const rawItem of validInputs) {
    const rawItemData = rawDocMap.get(rawItem.rawItemId.toString());
    if (!rawItemData) continue;

    const registeredUnit = rawItemData.customUnit || rawItemData.unit || "Unit";
    const chosenUnit  = rawItem.unit     || registeredUnit;
    const baseUnit    = rawItem.baseUnit || registeredUnit;

    // ── Honour frontend-provided unitCost — user already confirmed the price
    const frontendCost = rawItem.unitCost != null ? parseFloat(rawItem.unitCost) : 0;
    let finalUnitCost = frontendCost > 0 ? frontendCost : 0;

    // ── Only derive from DB when frontend sent nothing / zero ─────────────
    if (finalUnitCost === 0) {
      if (rawItem.variantId) {
        const v = (rawItemData.variants || []).find(vv => vv._id?.toString() === rawItem.variantId.toString());
        if (v) {
          const aliasPrices = (v.vendorNicknames || []).map(vn => vn.price || 0).filter(p => p > 0);
          if (aliasPrices.length) finalUnitCost = aliasPrices.reduce((s, p) => s + p, 0) / aliasPrices.length;
          if (finalUnitCost === 0) {
            const tx = (rawItemData.stockTransactions || [])
              .filter(t => t.variantId?.toString() === rawItem.variantId.toString() && ["ADD","PURCHASE_ORDER","VARIANT_ADD"].includes(t.type))
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
            if (tx) finalUnitCost = tx.unitPrice || 0;
          }
        }
      }
      if (finalUnitCost === 0) {
        const tx = (rawItemData.stockTransactions || [])
          .filter(t => ["ADD","PURCHASE_ORDER"].includes(t.type))
          .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
        if (tx) finalUnitCost = tx.unitPrice || 0;
      }
      if (finalUnitCost === 0 && rawItemData.sellingPrice) finalUnitCost = rawItemData.sellingPrice * 0.8;
    }

    let variantCombination = rawItem.variantCombination || [];
    if (!variantCombination.length && rawItem.variantId) {
      const v = (rawItemData.variants || []).find(vv => vv._id?.toString() === rawItem.variantId.toString());
      if (v) variantCombination = v.combination || [];
    }

    // Effective/consumed qty is always derived server-side from the
    // required-qty + allowance-% breakdown, not trusted verbatim from the
    // client, so the two can never drift apart.
    const requiredQuantity = rawItem.requiredQuantity != null ? parseFloat(rawItem.requiredQuantity) : parseFloat(rawItem.quantity);
    const allowancePercent = parseFloat(rawItem.allowancePercent) || 0;
    // Rounded to 4dp so multiplying by a % doesn't leave binary-float noise
    // like 3.3000000000000003 sitting in the DB / on the view page.
    const finalQuantity = Math.round(requiredQuantity * (1 + allowancePercent / 100) * 10000) / 10000;

    processedRawItems.push({
      rawItemId:          rawItemData._id,
      rawItemName:        rawItemData.name,
      rawItemSku:         rawItemData.sku,
      variantId:          rawItem.variantId || rawItemData._id,
      variantCombination,
      requiredQuantity,
      allowancePercent,
      quantity:           finalQuantity,
      unit:               chosenUnit,
      baseUnit,
      unitCost:           finalUnitCost,
      totalCost:          finalQuantity * finalUnitCost,
    });
  }
  return processedRawItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: compute and update aggregate fields
// ─────────────────────────────────────────────────────────────────────────────
function updateStockItemAggregates(stockItem) {
  const variants = stockItem.variants || [];

  stockItem.totalQuantityOnHand = variants.reduce((s, v) => s + (v.quantityOnHand || 0), 0);

  if (variants.length > 0) {
    stockItem.averageCost = variants.reduce((s, v) => s + (v.cost || 0), 0) / variants.length;
    stockItem.averageSalesPrice = variants.reduce((s, v) => s + (v.salesPrice || 0), 0) / variants.length;
  } else {
    stockItem.averageCost = stockItem.baseCost || 0;
    stockItem.averageSalesPrice = stockItem.baseSalesPrice || 0;
  }

  if (stockItem.averageCost > 0 && stockItem.averageSalesPrice > 0) {
    stockItem.profitMargin = ((stockItem.averageSalesPrice - stockItem.averageCost) / stockItem.averageCost) * 100;
  } else {
    stockItem.profitMargin = 0;
  }

  stockItem.inventoryValue = stockItem.averageCost * stockItem.totalQuantityOnHand;
  stockItem.potentialRevenue = stockItem.averageSalesPrice * stockItem.totalQuantityOnHand;

  const outOfStockCount = variants.filter(v => (v.quantityOnHand || 0) <= 0).length;
  const lowStockCount = variants.filter(v =>
    (v.quantityOnHand || 0) > 0 && (v.quantityOnHand || 0) <= (v.minStock || 10)
  ).length;

  if (outOfStockCount === variants.length && variants.length > 0) {
    stockItem.status = "Out of Stock";
  } else if (lowStockCount > 0 || outOfStockCount > 0) {
    stockItem.status = "Low Stock";
  } else {
    stockItem.status = "In Stock";
  }

  stockItem.variants = variants.map(v => {
    if ((v.quantityOnHand || 0) <= 0) v.status = "Out of Stock";
    else if ((v.quantityOnHand || 0) <= (v.minStock || 10)) v.status = "Low Stock";
    else v.status = "In Stock";
    return v;
  });
}

/**
 * Derive each variant's `cost` from what it is actually MADE OF — the sum of
 * its BOM rows' totalCost, plus the shared operations' operator cost.
 *
 * WHY THIS EXISTS (24 Aug 2026, explicit bug report — "whatever the raw
 * items/operations are filled from here, the pricing or like some data are
 * not gonna put properly in the stock item hence it is showing 0 rupees").
 * Every writer of `variants[].rawItems` — the Merchandiser's Materials tab,
 * R&D's sample approval, this file's own create/update routes — was storing
 * correctly-priced BOM rows (unitCost and totalCost both resolved) while
 * leaving `variant.cost` at whatever it was seeded with, normally 0. Since
 * updateStockItemAggregates() reads `v.cost` and nothing else, averageCost /
 * inventoryValue / profitMargin all stayed 0 no matter how complete the BOM
 * was. Verified against the dev data before fixing: TECHNOSPORT Maroon
 * T-Shirt carried three variants each holding ₹880 of priced BOM rows and
 * still reported cost=0, averageCost=0.
 *
 * ONLY EVER RAISES A COST OFF A REAL FIGURE. A BOM that prices to zero — a
 * raw item nobody has quoted yet — leaves the existing cost alone rather
 * than wiping a manually-entered one back to 0. So this can add information
 * but never destroy it, which is what makes it safe to run on every sync.
 *
 * Returns true when something actually changed.
 */
function recomputeVariantCostsFromBom(stockItem) {
  const operationsCost = (stockItem.operations || [])
    .reduce((sum, o) => sum + (Number(o.operatorCost) || 0), 0);
  let changed = false;
  for (const v of stockItem.variants || []) {
    const bomCost = (v.rawItems || []).reduce((sum, r) => sum + (Number(r.totalCost) || 0), 0);
    const total = Math.round((bomCost + operationsCost) * 100) / 100;
    if (total > 0 && total !== v.cost) {
      v.cost = total;
      changed = true;
    }
  }
  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable change log lines (26 Aug 2026, explicit request: "the log is
// not representing the changes in an proper human language... make sure the
// logs should be properly understandable").
//
// WHY THIS EXISTS SEPARATELY FROM services/changeLog.js's generic diff: that
// diff compares whole top-level document fields, and ChangeLog.sanitise()
// truncates any object/array field over 500 chars to a raw, CUT-OFF JSON
// STRING (not even valid JSON — see models/Access/ChangeLog.js's sanitise).
// `variants` on a real product — several variants, each with several raw
// items — is comfortably over that limit, so the log was storing an
// unparseable JSON fragment and the Logs tab had nothing to render but that
// fragment. Building small, specific, English sentences here instead keeps
// each log entry tiny (well under the truncation limit) AND actually
// readable, rather than trying to parse/repair truncated JSON after the
// fact on the frontend.
// ─────────────────────────────────────────────────────────────────────────────
function variantLabel(v) {
  const attrs = (v.attributes || []).map(a => a.value).filter(Boolean).join("/");
  return `variant ${v.sku || "?"}${attrs ? ` (${attrs})` : ""}`;
}

function byKey(arr, keyFn) {
  const m = new Map();
  (arr || []).forEach((item, i) => m.set(String(keyFn(item, i) ?? i), item));
  return m;
}

function describeVariantsChange(before, after) {
  const lines = [];
  const b = byKey(before, v => v.sku);
  const a = byKey(after, v => v.sku);
  for (const [sku, v] of a) if (!b.has(sku)) lines.push(`Added ${variantLabel(v)}`);
  for (const [sku, v] of b) if (!a.has(sku)) lines.push(`Removed ${variantLabel(v)}`);
  for (const [sku, vAfter] of a) {
    if (!b.has(sku)) continue;
    const vBefore = b.get(sku);
    const label = variantLabel(vAfter);
    if (Number(vBefore.salesPrice) !== Number(vAfter.salesPrice))
      lines.push(`${label}: sales price changed from ₹${vBefore.salesPrice ?? 0} to ₹${vAfter.salesPrice ?? 0}`);
    if (Number(vBefore.cost) !== Number(vAfter.cost))
      lines.push(`${label}: cost changed from ₹${vBefore.cost ?? 0} to ₹${vAfter.cost ?? 0}`);
    if (Number(vBefore.quantityOnHand) !== Number(vAfter.quantityOnHand))
      lines.push(`${label}: quantity on hand changed from ${vBefore.quantityOnHand ?? 0} to ${vAfter.quantityOnHand ?? 0}`);
    if ((vBefore.status || "") !== (vAfter.status || ""))
      lines.push(`${label}: status changed from ${vBefore.status || "—"} to ${vAfter.status || "—"}`);
    if ((vBefore.barcode || "") !== (vAfter.barcode || ""))
      lines.push(`${label}: barcode changed`);
  }
  return lines;
}

function describeRawItemsChange(beforeVariants, afterVariants) {
  const lines = [];
  const b = byKey(beforeVariants, v => v.sku);
  const a = byKey(afterVariants, v => v.sku);
  for (const [sku, vAfter] of a) {
    const vBefore = b.get(sku);
    if (!vBefore) continue;
    const label = variantLabel(vAfter);
    const bItems = byKey(vBefore.rawItems, ri => ri.rawItemId || ri.rawItemName);
    const aItems = byKey(vAfter.rawItems, ri => ri.rawItemId || ri.rawItemName);
    for (const [k, ri] of aItems) if (!bItems.has(k)) lines.push(`Added raw item "${ri.rawItemName || "Unnamed"}" to ${label}`);
    for (const [k, ri] of bItems) if (!aItems.has(k)) lines.push(`Removed raw item "${ri.rawItemName || "Unnamed"}" from ${label}`);
    for (const [k, riAfter] of aItems) {
      if (!bItems.has(k)) continue;
      const riBefore = bItems.get(k);
      const name = riAfter.rawItemName || "Unnamed";
      if (Number(riBefore.quantity) !== Number(riAfter.quantity))
        lines.push(`Raw item "${name}" on ${label}: quantity changed from ${riBefore.quantity ?? 0} to ${riAfter.quantity ?? 0} ${riAfter.unit || ""}`.trim());
      if ((riBefore.unit || "") !== (riAfter.unit || ""))
        lines.push(`Raw item "${name}" on ${label}: unit changed from ${riBefore.unit || "—"} to ${riAfter.unit || "—"}`);
      if (Number(riBefore.allowancePercent) !== Number(riAfter.allowancePercent))
        lines.push(`Raw item "${name}" on ${label}: allowance changed from ${riBefore.allowancePercent ?? 0}% to ${riAfter.allowancePercent ?? 0}%`);
    }
  }
  return lines;
}

function describeOperationsChange(before, after) {
  const lines = [];
  const max = Math.max((before || []).length, (after || []).length);
  for (let i = 0; i < max; i++) {
    const b = (before || [])[i];
    const a = (after || [])[i];
    if (b && !a) { lines.push(`Removed operation "${b.type || `#${i + 1}`}"`); continue; }
    if (!b && a) { lines.push(`Added operation "${a.type || `#${i + 1}`}"`); continue; }
    if (!b || !a) continue;
    const label = `Operation "${a.type || `#${i + 1}`}"`;
    if ((b.machine || "") !== (a.machine || ""))
      lines.push(`${label}: machine changed from ${b.machine || "—"} to ${a.machine || "—"}`);
    if (Number(b.minutes) !== Number(a.minutes) || Number(b.seconds) !== Number(a.seconds))
      lines.push(`${label}: time changed from ${b.minutes || 0}m ${b.seconds || 0}s to ${a.minutes || 0}m ${a.seconds || 0}s`);
    if (Number(b.operatorCost) !== Number(a.operatorCost))
      lines.push(`${label}: cost changed from ₹${b.operatorCost || 0} to ₹${a.operatorCost || 0}`);
    if ((b.salaryDept || "") !== (a.salaryDept || "") || (b.salaryDesig || "") !== (a.salaryDesig || ""))
      lines.push(`${label}: salary basis changed`);
  }
  return lines;
}

function describeAttributesChange(before, after) {
  const lines = [];
  const b = byKey(before, x => x.name);
  const a = byKey(after, x => x.name);
  for (const [name, attr] of a) if (!b.has(name)) lines.push(`Added attribute "${name}" (${(attr.values || []).join(", ")})`);
  for (const [name] of b) if (!a.has(name)) lines.push(`Removed attribute "${name}"`);
  for (const [name, aAfter] of a) {
    if (!b.has(name)) continue;
    const beforeValues = (b.get(name).values || []).join(", ");
    const afterValues = (aAfter.values || []).join(", ");
    if (beforeValues !== afterValues) lines.push(`Attribute "${name}": values changed from [${beforeValues}] to [${afterValues}]`);
  }
  return lines;
}

const GENERAL_FIELD_LABELS = {
  name: "Product name", category: "Category", genderCategory: "Gender",
  hsnCode: "HSN code", baseSalesPrice: "Base sales price", baseCost: "Base cost",
  unit: "Unit", internalNotes: "Internal notes", numberOfPanels: "Number of panels",
  productType: "Product type",
};
function describeGeneralChange(before, after) {
  const lines = [];
  for (const [key, label] of Object.entries(GENERAL_FIELD_LABELS)) {
    if (JSON.stringify(before[key] ?? "") !== JSON.stringify(after[key] ?? "")) {
      lines.push(`${label} changed from "${before[key] ?? "—"}" to "${after[key] ?? "—"}"`);
    }
  }
  const beforeNames = (before.additionalNames || []).join(", ");
  const afterNames = (after.additionalNames || []).join(", ");
  if (beforeNames !== afterNames) lines.push(`Additional names changed to [${afterNames || "—"}]`);
  const beforeImgCount = (before.images || []).length;
  const afterImgCount = (after.images || []).length;
  if (beforeImgCount !== afterImgCount) lines.push(`Images: ${beforeImgCount} → ${afterImgCount}`);
  return lines;
}

function describeMeasurementsChange(before, after) {
  const lines = [];
  const b = (before.measurements || []).join(", ");
  const a = (after.measurements || []).join(", ");
  if (b !== a) lines.push(`Measurement points changed to [${a || "—"}]`);
  if (Number(before.numberOfPanels) !== Number(after.numberOfPanels))
    lines.push(`Number of panels changed from ${before.numberOfPanels ?? 0} to ${after.numberOfPanels ?? 0}`);
  return lines;
}

function describeCostsChange(before, after) {
  const lines = [];
  const b = byKey(before, c => c.name);
  const a = byKey(after, c => c.name);
  for (const [name, c] of a) if (!b.has(name)) lines.push(`Added cost "${name}" (${c.unit === "Percentage" ? `${c.amount}%` : `₹${c.amount}`})`);
  for (const [name] of b) if (!a.has(name)) lines.push(`Removed cost "${name}"`);
  for (const [name, cAfter] of a) {
    if (!b.has(name)) continue;
    const cBefore = b.get(name);
    if (Number(cBefore.amount) !== Number(cAfter.amount) || cBefore.unit !== cAfter.unit) {
      const fmt = (c) => c.unit === "Percentage" ? `${c.amount}%` : `₹${c.amount}`;
      lines.push(`Cost "${name}" changed from ${fmt(cBefore)} to ${fmt(cAfter)}`);
    }
  }
  return lines;
}

/** Keeps a change-lines array well under ChangeLog.sanitise's 500-char
 * truncation threshold even on a bulk edit touching many variants/items. */
function capLines(lines, max = 12) {
  if (lines.length <= max) return lines;
  return [...lines.slice(0, max), `…and ${lines.length - max} more change(s)`];
}

/** One line per attribute/variant, for the create-time log entry. */
function describeProductCreated(stockItem) {
  const lines = [`Created "${stockItem.name}" (${stockItem.reference}) in ${stockItem.category}`];
  for (const attr of stockItem.attributes || []) {
    lines.push(`Attribute "${attr.name}": ${(attr.values || []).join(", ")}`);
  }
  lines.push(`${(stockItem.variants || []).length} variant(s) created`);
  if ((stockItem.operations || []).length > 0) lines.push(`${stockItem.operations.length} operation(s) defined`);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// Operation routes (keep existing — unchanged)
// ─────────────────────────────────────────────────────────────────────────────

router.post("/:id/operations", async (req, res) => {
  try {
    const { id } = req.params;
    const { type, machine, machineType, totalSeconds, minutes, seconds, operatorSalary, operatorCost } = req.body;

    if (!type || !machineType) {
      return res.status(400).json({ success: false, message: "type and machineType are required" });
    }

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const alreadyExists = (stockItem.operations || []).some(
      (op) => op.type === type && op.machineType === machineType
    );
    if (alreadyExists) {
      return res.json({ success: true, message: "Operation already exists on product (no duplicate added)", skipped: true });
    }

    const newOp = { type, machine: machine || machineType, machineType, totalSeconds: totalSeconds || 0, minutes: minutes || 0, seconds: seconds || 0, operatorSalary: operatorSalary || 0, operatorCost: operatorCost || 0 };
    stockItem.operations.push(newOp);
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();

    return res.json({ success: true, message: "Operation added to product successfully", operation: stockItem.operations[stockItem.operations.length - 1] });
  } catch (error) {
    console.error("Error adding operation to stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

router.delete("/:id/operations/by-type", async (req, res) => {
  try {
    const { id } = req.params;
    const { operationType, machineType } = req.body;
    if (!operationType) return res.status(400).json({ success: false, message: "operationType is required" });

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const originalCount = stockItem.operations.length;
    stockItem.operations = stockItem.operations.filter((op) => {
      const typeMatch = op.type === operationType;
      const machineMatch = machineType ? op.machineType === machineType : true;
      return !(typeMatch && machineMatch);
    });

    const removed = originalCount - stockItem.operations.length;
    if (removed === 0) return res.json({ success: true, message: "No matching operation found on product (nothing removed)", removed: 0 });

    stockItem.updatedBy = req.user?.id;
    await stockItem.save();
    return res.json({ success: true, message: `Removed ${removed} operation(s) from product`, removed });
  } catch (error) {
    console.error("Error removing operation from stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

router.delete("/:id/operations/:operationIndex", async (req, res) => {
  try {
    const { id, operationIndex } = req.params;
    const idx = parseInt(operationIndex, 10);
    if (isNaN(idx) || idx < 0) return res.status(400).json({ success: false, message: "operationIndex must be a non-negative integer" });

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    if (idx >= stockItem.operations.length) return res.status(400).json({ success: false, message: `operationIndex ${idx} is out of range` });

    stockItem.operations.splice(idx, 1);
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();
    return res.json({ success: true, message: "Operation removed from product successfully" });
  } catch (error) {
    console.error("Error removing operation from stock item:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Specific /data/* routes MUST be defined BEFORE /:id routes
// ─────────────────────────────────────────────────────────────────────────────

// ✅ GET avg salary by department / designation for operations auto-fill
router.get("/data/salary-lookup", async (req, res) => {
  try {
    const { department, designation } = req.query;

    if (!department && !designation) {
      const [depts, desigs] = await Promise.all([
        Employee.distinct("department", { isActive: true }),
        Employee.distinct("designation", { isActive: true }),
      ]);
      return res.json({
        success: true,
        departments: depts.filter(Boolean).sort(),
        designations: desigs.filter(Boolean).sort(),
      });
    }

    const filter = { isActive: true };
    if (department) filter.department = department;
    if (designation) filter.designation = designation;

    const employees = await Employee.find(filter).select("salary").lean();
    if (!employees.length) return res.json({ success: true, averageSalary: 0, count: 0 });

    const { decryptSalaryFields } = require("../../../../utils/salaryEncryption");
    let totalNet = 0, decryptedCount = 0;
    for (const emp of employees) {
      try {
        const s = decryptSalaryFields(emp.salary || {});
        const net = parseFloat(s.netSalary) || 0;
        if (net > 0) { totalNet += net; decryptedCount++; }
      } catch { /* skip undecryptable records */ }
    }

    return res.json({
      success: true,
      averageSalary: decryptedCount > 0 ? Math.round(totalNet / decryptedCount) : 0,
      count: employees.length,
      decryptedCount,
    });
  } catch (err) {
    console.error("salary-lookup error:", err);
    return res.status(500).json({ success: false, message: err.message });
  }
});

// ✅ GET raw items with their variants + unit conversions for stock item form
router.get("/data/raw-items", async (req, res) => {
  try {
    const { search = "", limit = 50 } = req.query;
    let filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { sku: { $regex: search, $options: "i" } },
        { category: { $regex: search, $options: "i" } }
      ];
    }

    const rawItems = await RawItem.find(filter)
      .select("name sku category unit customUnit variants quantity minStock maxStock sellingPrice stockTransactions")
      .populate("variants.vendorNicknames.vendor", "companyName")
      .limit(parseInt(limit))
      .sort({ name: 1 });

    const unitConversionsMap = await buildUnitConversionsMap();

    const processedRawItems = rawItems.map(item => {
      const baseUnitName = item.customUnit || item.unit || "Unit";
      const baseItem = {
        id: item._id,
        name: item.name,
        sku: item.sku,
        category: item.customCategory || item.category || "Uncategorized",
        baseUnit: baseUnitName,
        baseQuantity: item.quantity || 0,
        baseSellingPrice: item.sellingPrice || 0,
        hasVariants: item.variants && item.variants.length > 0,
        variants: [],
        unitConversions: unitConversionsMap[baseUnitName]?.conversions || []
      };

      if (item.variants && item.variants.length > 0) {
        // Inside GET /data/raw-items, REPLACE the variant cost block inside the map:
        baseItem.variants = item.variants.map(variant => {
          // ── 1. Vendor alias prices (average if multiple) ──────────────────
          let latestCost = 0;
          const aliasPrices = (variant.vendorNicknames || [])
            .map(vn => vn.price || 0)
            .filter(p => p > 0);
          if (aliasPrices.length > 0) {
            latestCost = aliasPrices.reduce((s, p) => s + p, 0) / aliasPrices.length;
          }

          // ── 2. Variant stock transactions ─────────────────────────────────
          if (latestCost === 0 && item.stockTransactions?.length > 0) {
            const variantTransactions = item.stockTransactions
              .filter(tx => tx.variantId?.toString() === variant._id.toString()
                && (tx.type === "ADD" || tx.type === "PURCHASE_ORDER" || tx.type === "VARIANT_ADD"))
              .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
            if (variantTransactions.length > 0) latestCost = variantTransactions[0].unitPrice || 0;
          }

          // ── 3. Selling price haircut ──────────────────────────────────────
          if (latestCost === 0 && item.sellingPrice) latestCost = item.sellingPrice * 0.8;

          return {
            id: variant._id,
            combination: variant.combination || [],
            combinationText: variant.combination?.join(" • ") || "Default",
            quantity: variant.quantity || 0,
            unit: baseUnitName,
            cost: latestCost,
            status: variant.status || "Out of Stock",
            sku: variant.sku || `${baseItem.sku}-var`,
            // variant-level unit conversions (fromUnit/toUnit/quantity format from RawItem schema)
            unitConversions: (variant.unitConversions || []).filter(c => c.fromUnit && c.toUnit && c.quantity),
            vendorAliases: (variant.vendorNicknames || [])
              .filter(vn => vn.price > 0)
              .map(vn => ({
                vendorId: vn.vendor?._id?.toString() || vn.vendor?.toString(),
                vendorName: vn.vendor?.companyName || "—",
                vendorCode: vn.nickname || "",
                price: vn.price || 0
              }))
          };
        });
      } else {
        let latestCost = 0;
        if (item.stockTransactions && item.stockTransactions.length > 0) {
          const purchaseTransactions = item.stockTransactions
            .filter(tx => tx.type === "ADD" || tx.type === "PURCHASE_ORDER")
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
          if (purchaseTransactions.length > 0) latestCost = purchaseTransactions[0].unitPrice || 0;
        }
        if (latestCost === 0 && item.sellingPrice) latestCost = item.sellingPrice * 0.8;
        baseItem.variants = [{ id: item._id, combination: [], combinationText: "Default", quantity: item.quantity || 0, unit: baseUnitName, cost: latestCost, status: item.status || "Out of Stock", sku: baseItem.sku }];
      }

      return baseItem;
    });

    res.json({ success: true, rawItems: processedRawItems });
  } catch (error) {
    console.error("Error fetching raw items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching raw items" });
  }
});

// ✅ GET data for creating stock item
router.get("/data/create", async (req, res) => {
  try {
    const rawItemsResponse = await RawItem.find({})
      .select("name sku category unit variants quantity sellingPrice stockTransactions")
      .limit(20)
      .sort({ name: 1 });

    const unitConversionsMap = await buildUnitConversionsMap();

    const processedRawItems = rawItemsResponse.map(item => {
      const baseUnit = item.unit || "Unit";
      const baseItem = {
        id: item._id, name: item.name, sku: item.sku,
        category: item.category || "Uncategorized", baseUnit,
        hasVariants: item.variants && item.variants.length > 0,
        variants: [],
        unitConversions: unitConversionsMap[baseUnit]?.conversions || []
      };
      if (item.variants && item.variants.length > 0) {
        baseItem.variants = item.variants.map(variant => ({
          id: variant._id, combination: variant.combination || [],
          combinationText: variant.combination?.join(" • ") || "Default",
          quantity: variant.quantity || 0, unit: baseUnit,
          cost: item.sellingPrice ? item.sellingPrice * 0.8 : 0,
          status: variant.status || "Out of Stock"
        }));
      }
      return baseItem;
    });

    const machines = await Machine.find({ status: "Operational" })
      .select("name type model serialNumber").sort({ type: 1, name: 1 });

    const operators = await Employee.find({ department: "Operator", status: "active" }).select("salary");
    const averageSalary = operators.length > 0
      ? operators.reduce((sum, emp) => sum + (emp.salary?.netSalary || 0), 0) / operators.length
      : 0;

    const [registeredOperations, registeredGroups] = await Promise.all([
      Operation.find().sort({ name: 1 }),
      OperationGroup.find().populate("operations", "name operationCode totalSam durationSeconds machineType salaryDept salaryDesig").sort({ name: 1 })
    ]);

    res.json({
      success: true,
      data: {
        categories: STOCK_ITEM_CATEGORIES,
        operationTypes: OPERATION_TYPES,
        rawItems: processedRawItems,
        machines: machines.map(m => ({ id: m._id, name: m.name, type: m.type, model: m.model, serialNumber: m.serialNumber })),
        averageOperatorSalary: Math.round(averageSalary),
        registeredOperations: registeredOperations.map(op => ({ _id: op._id, name: op.name, operationCode: op.operationCode || op.code || "", totalSam: op.totalSam, durationSeconds: op.durationSeconds, machineType: op.machineType, salaryDept: op.salaryDept || "", salaryDesig: op.salaryDesig || "" })),
        registeredGroups: registeredGroups.map(grp => ({ _id: grp._id, name: grp.name, operations: grp.operations })),
        unitConversions: unitConversionsMap
      }
    });
  } catch (error) {
    console.error("Error fetching create data:", error);
    res.status(500).json({ success: false, message: "Server error while fetching create data" });
  }
});

// ✅ Tab-specific data fetch endpoint
router.get("/:id/tab/:tabName", async (req, res) => {
  try {
    const { id, tabName } = req.params;
    let selectFields = "";

    switch (tabName) {
      case "general": selectFields = "name additionalNames productType category unit hsnCode baseSalesPrice baseCost internalNotes numberOfPanels reference images genderCategory"; break;
      case "attributes": selectFields = "attributes"; break;
      case "variants": selectFields = "variants attributes reference baseCost baseSalesPrice"; break;
      case "raw-items": selectFields = "variants.rawItems variants._id variants.attributes variants.sku"; break;
      case "operations": selectFields = "operations"; break;
      case "measurements": selectFields = "measurements numberOfPanels"; break;
      case "costs": selectFields = "miscellaneousCosts"; break;
      default: selectFields = "name category";
    }

    const stockItem = await StockItem.findById(id).select(selectFields);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    const response = { success: true, tab: tabName, data: stockItem };

    // For raw-items tab, build a map of rawItemId|variantId → unitConversions
    // so the frontend can show correct conversion units without extra fetches
    if (tabName === "raw-items") {
      const rawItemIds = [
        ...new Set(
          stockItem.variants.flatMap(v =>
            (v.rawItems || []).map(ri => ri.rawItemId?.toString()).filter(Boolean)
          )
        )
      ];
      if (rawItemIds.length > 0) {
        const rawDocs = await RawItem.find({ _id: { $in: rawItemIds } })
          .select("_id variants._id variants.unitConversions")
          .lean();
        const convMap = {};
        rawDocs.forEach(doc => {
          (doc.variants || []).forEach(v => {
            const key = `${doc._id}|${v._id}`;
            convMap[key] = (v.unitConversions || []).filter(c => c.fromUnit && c.toUnit && c.quantity);
          });
        });
        response.variantUnitConvMap = convMap;
      }
    }

    if (tabName === "operations") {
      const [registeredOperations, registeredGroups] = await Promise.all([
        Operation.find().sort({ name: 1 }),
        OperationGroup.find().populate("operations", "name operationCode totalSam durationSeconds machineType salaryDept salaryDesig").sort({ name: 1 })
      ]);
      response.registeredOperations = registeredOperations.map(op => ({ _id: op._id, name: op.name, operationCode: op.operationCode || op.code || "", totalSam: op.totalSam, durationSeconds: op.durationSeconds, machineType: op.machineType, salaryDept: op.salaryDept || "", salaryDesig: op.salaryDesig || "" }));
      response.registeredGroups = registeredGroups.map(grp => ({ _id: grp._id, name: grp.name, operations: grp.operations }));
    }

    res.json(response);
  } catch (error) {
    console.error(`Error fetching tab data (${req.params.tabName}):`, error);
    res.status(500).json({ success: false, message: "Server error while fetching tab data" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ✅ NEW: Tab-wise PATCH endpoints — each saves ONLY that tab's fields
//    PATCH /api/cms/stock-items/:id/tab/:tabName
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/:id/tab/:tabName", async (req, res) => {
  try {
    const { id, tabName } = req.params;
    const body = req.body;

    const stockItem = await StockItem.findById(id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    // Snapshot BEFORE the switch below mutates it in place — recordChange
    // diffs this against the post-save state itself, so passing the whole
    // document is correct (not noise): see services/changeLog.js.
    const before = stockItem.toObject();

    switch (tabName) {

      // ── General Info ────────────────────────────────────────────────────
      case "general": {
        const { name, additionalNames, productType, category, unit, hsnCode, genderCategory, baseSalesPrice, baseCost, internalNotes, numberOfPanels, images } = body;
        if (name !== undefined) stockItem.name = name.trim();
        if (productType !== undefined) stockItem.productType = productType;
        if (category !== undefined) stockItem.category = category.trim();
        if (unit !== undefined) stockItem.unit = unit;
        if (hsnCode !== undefined) stockItem.hsnCode = hsnCode;
        if (internalNotes !== undefined) stockItem.internalNotes = internalNotes;
        if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice) || 0;
        if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;
        if (genderCategory !== undefined) stockItem.genderCategory = genderCategory;
        if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;
        if (images !== undefined) stockItem.images = images || [];
        if (additionalNames !== undefined) {
          stockItem.additionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
            .map(n => n?.trim()).filter(n => n && n.length > 0);
        }
        break;
      }

      // ── Attributes ──────────────────────────────────────────────────────
      case "attributes": {
        const { attributes } = body;
        if (attributes !== undefined) {
          stockItem.attributes = (attributes || [])
            .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
            .map(attr => ({
              name: attr.name.trim(),
              values: attr.values.filter(v => v?.trim()).map(v => v.trim())
            }));
        }
        break;
      }

      // ── Variants ────────────────────────────────────────────────────────
      case "variants": {
        const { variants } = body;
        if (variants !== undefined) {
          const existingVariantsById = {};
          stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

          const processedVariants = await Promise.all(
            variants.map(async (variant, index) => {
              const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, "0")}`;

              if (variant._id && existingVariantsById[variant._id.toString()]) {
                const existing = existingVariantsById[variant._id.toString()];
                existing.sku = variantSku;
                existing.attributes = variant.attributes || existing.attributes;
                existing.quantityOnHand = parseFloat(variant.quantityOnHand) ?? existing.quantityOnHand;
                existing.minStock = parseFloat(variant.minStock) || existing.minStock || 10;
                existing.maxStock = parseFloat(variant.maxStock) || existing.maxStock || 100;
                existing.cost = parseFloat(variant.cost) || stockItem.baseCost || 0;
                existing.salesPrice = parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0;
                existing.barcode = variant.barcode || existing.barcode || "";
                existing.images = variant.images || existing.images || [];
                // ✅ FIX: NEVER overwrite rawItems from variants tab — raw-items tab owns this field
                // existing.rawItems is intentionally left untouched
                return existing;
              }

              return {
                sku: variantSku,
                attributes: variant.attributes || [],
                quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
                minStock: parseFloat(variant.minStock) || 10,
                maxStock: parseFloat(variant.maxStock) || 100,
                cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
                salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0,
                barcode: variant.barcode || "",
                images: variant.images || [],
                rawItems: [] // new variants have no raw items yet — correct
              };
            })
          );
          stockItem.variants = processedVariants;
          updateStockItemAggregates(stockItem);
        }
        break;
      }

      // ── Raw Items ────────────────────────────────────────────────────────
      // Saves raw items for each variant individually — does NOT touch
      // operations, costs, or any other field.
      case "raw-items": {
        const { variants } = body;
        if (variants !== undefined) {
          const existingVariantsById = {};
          stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

          for (const dv of variants) {
            const match = dv._id && existingVariantsById[dv._id.toString()];
            if (match) {
              match.rawItems = await processVariantRawItems(dv.rawItems || []);
            }
          }
        }
        break;
      }

      // ── Operations ───────────────────────────────────────────────────────
      case "operations": {
        const { operations } = body;
        if (operations !== undefined) {
          stockItem.operations = (Array.isArray(operations) ? operations : []).map(op => {
            const minutes = parseFloat(op.minutes) || 0;
            const seconds = parseFloat(op.seconds) || 0;
            return {
              type: op.type || "",
              operationCode: op.operationCode || "",
              machine: op.machine || "",
              machineType: op.machineType || "",
              minutes,
              seconds,
              totalSeconds: minutes * 60 + seconds,
              operatorSalary: parseFloat(op.operatorSalary) || 0,
              operatorCost: parseFloat(op.operatorCost) || 0,
              salaryDept:  op.salaryDept  || "",
              salaryDesig: op.salaryDesig || "",
            };
          });
        }
        break;
      }

      // ── Measurements ─────────────────────────────────────────────────────
      case "measurements": {
        const { measurements, numberOfPanels } = body;
        if (measurements !== undefined) {
          stockItem.measurements = (Array.isArray(measurements) ? measurements : [])
            .filter(m => m?.trim()).map(m => m.trim());
        }
        if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;
        break;
      }

      // ── Costs ────────────────────────────────────────────────────────────
      case "costs": {
        const { miscellaneousCosts } = body;
        if (miscellaneousCosts !== undefined) {
          stockItem.miscellaneousCosts = (Array.isArray(miscellaneousCosts) ? miscellaneousCosts : [])
            .filter(c => c.name?.trim())
            .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));
        }
        break;
      }

      default:
        return res.status(400).json({ success: false, message: `Unknown tab: ${tabName}` });
    }

    stockItem.updatedBy = req.user.id;
    await stockItem.save();

    // Human-readable per-tab diff (26 Aug 2026) instead of handing the whole
    // document to the generic before/after diff — see the block of
    // describe*Change helpers above for why. `after` doc reads through
    // stockItem's live in-memory arrays, which is correct here since nothing
    // else mutates it between save() and this line.
    const afterDoc = stockItem.toObject();
    let changeLines = [];
    switch (tabName) {
      case "general": changeLines = describeGeneralChange(before, afterDoc); break;
      case "attributes": changeLines = describeAttributesChange(before.attributes, afterDoc.attributes); break;
      case "variants": changeLines = describeVariantsChange(before.variants, afterDoc.variants); break;
      case "raw-items": changeLines = describeRawItemsChange(before.variants, afterDoc.variants); break;
      case "operations": changeLines = describeOperationsChange(before.operations, afterDoc.operations); break;
      case "measurements": changeLines = describeMeasurementsChange(before, afterDoc); break;
      case "costs": changeLines = describeCostsChange(before.miscellaneousCosts, afterDoc.miscellaneousCosts); break;
    }
    changeLines = capLines(changeLines);

    await recordChange(req, {
      departmentSlug: "inventory",
      entity: "stock-item",
      entityId: stockItem._id,
      entityLabel: stockItem.name,
      action: "update",
      summary: changeLines[0]
        ? `${changeLines[0]}${changeLines.length > 1 ? ` (+${changeLines.length - 1} more)` : ""}`
        : `Updated ${tabName} — ${stockItem.name}`,
      before: {},
      after: changeLines.length ? { changes: changeLines } : {},
    });

    res.json({
      success: true,
      message: `${tabName} saved successfully`,
      tab: tabName
    });
  } catch (error) {
    console.error(`Error saving tab (${req.params.tabName}):`, error);
    res.status(500).json({ success: false, message: "Server error while saving tab data" });
  }
});

/**
 * GET /:id/history — who created this product and every change since, newest
 * first. Powers the editor's Logs tab (26 Aug 2026, explicit request).
 * Read-only, so no role restriction beyond the auth this whole router already
 * requires.
 */
router.get("/:id/history", async (req, res) => {
  try {
    const logs = await historyFor("stock-item", req.params.id, 100);
    res.json({ success: true, logs });
  } catch (error) {
    console.error("Error fetching stock item history:", error);
    res.status(500).json({ success: false, message: "Server error while fetching history" });
  }
});

// ✅ GET all stock items with variants (with pagination)
router.get("/", async (req, res) => {
  try {
    const { search = "", status, category, page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    // Soft-deleted products live on their own "Deleted" tab (GET /deleted,
    // below) — everything here, including the stats strip and the
    // missing-raw-items/missing-operations alerts, is scoped to the active
    // catalogue only (1 Sept 2026).
    let filter = { isActive: { $ne: false } };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { "variants.sku": { $regex: search, $options: "i" } },
        { additionalNames: { $regex: search, $options: "i" } }
      ];
    }
    if (category) filter.category = category;
    if (status) filter.status = status;

    // ── ?sampledOnly=1 — only products whose sampling is SETTLED ─────────────
    // Added 27 Aug 2026 on explicit request: at the Enquiry stage, the "pick an
    // existing product" dropdown "only those products need to suggest whose
    // sampling is approved by the sales team". Picking an unapproved product
    // there would waive development on something nobody has actually signed off
    // — the exact thing the pickedFromRegister waiver is meant to be safe for.
    //
    // OPT-IN, not the default: this is a general Inventory endpoint that also
    // feeds stock lists, the product register and reporting, none of which
    // should suddenly hide products. Only the Sales product picker sends it.
    //
    // "Settled" is `approved` OR `notApplicable`, which is exactly what
    // services/sampleReadiness.js's SETTLED_SAMPLE_STATUSES already means —
    // a product legitimately waived from sampling counts as cleared, since
    // there was never a sample for Sales to approve. Kept in step with that
    // constant deliberately; if the vocabulary changes, both must move.
    if (String(req.query.sampledOnly || "") === "1") {
      const { SETTLED_SAMPLE_STATUSES } = require("../../../../services/sampleReadiness");
      const SampleStyle = require("../../../../models/CMS_Models/Sales/SampleStyle");
      const approvedIds = await SampleStyle.distinct("sourceStockItemId", {
        isActive: true,
        "sample.status": { $in: SETTLED_SAMPLE_STATUSES },
      });
      // `sourceStockItemId` is sparse — styles for never-registered products
      // have none — so distinct() can return nulls. Filtered out, or an $in
      // carrying null would match documents by accident.
      filter._id = { $in: approvedIds.filter(Boolean) };
    }

    // ── Merchandiser/Production work-queue alerts (26 Aug 2026) ──────────────
    // "showcase the alerts... for which product or like how many products are
    // there which are not assigned any raw items" / "which product is having
    // missing operations". Computed over the WHOLE collection (not just the
    // current page), same as lowStock/outOfStock above, so the count is
    // accurate regardless of pagination or filters. A product counts as
    // missing raw items only if NONE of its variants have any.
    const missingRawItemsFilter = {
      $expr: {
        $not: [{
          $anyElementTrue: {
            $map: {
              input: { $ifNull: ["$variants", []] },
              as: "v",
              in: { $gt: [{ $size: { $ifNull: ["$$v.rawItems", []] } }, 0] }
            }
          }
        }]
      }
    };
    const missingOperationsFilter = { $expr: { $eq: [{ $size: { $ifNull: ["$operations", []] } }, 0] } };

    const [totalItems, stockItems, statsAgg, missingRawItemsAgg, missingOperationsAgg] = await Promise.all([
      StockItem.countDocuments(filter),
      StockItem.find(filter)
        .select("name additionalNames reference category unit totalQuantityOnHand averageCost averageSalesPrice status images variants hsnCode profitMargin operations genderCategory")
        .sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      StockItem.aggregate([{
        $group: {
          _id: null,
          total: { $sum: 1 },
          lowStock: { $sum: { $cond: [{ $eq: ["$status", "Low Stock"] }, 1, 0] } },
          outOfStock: { $sum: { $cond: [{ $eq: ["$status", "Out of Stock"] }, 1, 0] } },
          totalVariants: { $sum: { $size: { $ifNull: ["$variants", []] } } },
          totalInventoryValue: { $sum: { $multiply: [{ $ifNull: ["$averageCost", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] } },
          totalPotentialRevenue: { $sum: { $multiply: [{ $ifNull: ["$averageSalesPrice", 0] }, { $ifNull: ["$totalQuantityOnHand", 0] }] } },
          averageMargin: { $avg: { $ifNull: ["$profitMargin", 0] } }
        }
      }]),
      StockItem.aggregate([
        { $match: missingRawItemsFilter },
        { $group: { _id: null, count: { $sum: 1 }, samples: { $push: "$name" } } },
        { $project: { count: 1, samples: { $slice: ["$samples", 5] } } }
      ]),
      StockItem.aggregate([
        { $match: missingOperationsFilter },
        { $group: { _id: null, count: { $sum: 1 }, samples: { $push: "$name" } } },
        { $project: { count: 1, samples: { $slice: ["$samples", 5] } } }
      ])
    ]);

    const statsData = statsAgg[0] || { total: 0, lowStock: 0, outOfStock: 0, totalVariants: 0, totalInventoryValue: 0, totalPotentialRevenue: 0, averageMargin: 0 };
    const missingRawItemsData = missingRawItemsAgg[0] || { count: 0, samples: [] };
    const missingOperationsData = missingOperationsAgg[0] || { count: 0, samples: [] };
    const totalPages = Math.ceil(totalItems / limitNum);

    res.json({
      success: true, stockItems,
      stats: {
        total: statsData.total, lowStock: statsData.lowStock, outOfStock: statsData.outOfStock, totalVariants: statsData.totalVariants,
        totalInventoryValue: statsData.totalInventoryValue, totalPotentialRevenue: statsData.totalPotentialRevenue, averageMargin: statsData.averageMargin, totalStockItems: statsData.total,
        missingRawItems: { count: missingRawItemsData.count, samples: missingRawItemsData.samples },
        missingOperations: { count: missingOperationsData.count, samples: missingOperationsData.samples }
      },
      filters: { categories: STOCK_ITEM_CATEGORIES, statuses: ["In Stock", "Low Stock", "Out of Stock"] },
      pagination: { currentPage: pageNum, totalPages, totalItems, itemsPerPage: limitNum, hasNextPage: pageNum < totalPages, hasPrevPage: pageNum > 1 }
    });
  } catch (error) {
    console.error("Error fetching stock items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock items" });
  }
});

// ✅ GET deleted stock items — the "Deleted" tab (1 Sept 2026). Ahead of
// GET /:id on purpose (same reason salesCustomers.js flags for its own
// search route): a static path has to be registered before Express treats
// the literal word "deleted" as an :id.
router.get("/deleted", async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;
    const pageNum = parseInt(page), limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    let filter = { isActive: false };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { reference: { $regex: search, $options: "i" } },
        { additionalNames: { $regex: search, $options: "i" } },
      ];
    }

    const [totalItems, stockItems] = await Promise.all([
      StockItem.countDocuments(filter),
      StockItem.find(filter)
        .select("name additionalNames reference category unit images variants hsnCode genderCategory deletedAt deletedBy")
        .sort({ deletedAt: -1 }).skip(skip).limit(limitNum),
    ]);

    res.json({
      success: true, stockItems,
      pagination: { currentPage: pageNum, totalPages: Math.ceil(totalItems / limitNum), totalItems, itemsPerPage: limitNum, hasNextPage: skip + limitNum < totalItems, hasPrevPage: pageNum > 1 },
    });
  } catch (error) {
    console.error("Error fetching deleted stock items:", error);
    res.status(500).json({ success: false, message: "Server error while fetching deleted stock items" });
  }
});

// ✅ RESTORE a deleted stock item (1 Sept 2026) — the other half of soft
// delete below. Reference uniqueness isn't re-checked: the reference was
// never released while deleted (still present, just inactive), so nothing
// new can have claimed it in the meantime.
router.post("/:id/restore", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    if (stockItem.isActive !== false) {
      return res.status(400).json({ success: false, message: "This product isn't deleted." });
    }

    stockItem.isActive = true;
    stockItem.deletedAt = null;
    stockItem.deletedBy = undefined;
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();

    await recordChange(req, {
      departmentSlug: "inventory",
      entity: "stock-item",
      entityId: stockItem._id,
      entityLabel: stockItem.name,
      action: "other",
      summary: `Restored — ${stockItem.name}`,
      before: {}, after: {},
    });

    res.json({ success: true, message: "Stock item restored successfully", stockItem });
  } catch (error) {
    console.error("Error restoring stock item:", error);
    res.status(500).json({ success: false, message: "Server error while restoring stock item" });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /:id/manufacturing-orders — every order this product appears on.
//
// 1 Sept 2026, explicit request: "it is also needed to showcase like which
// product linked to which mo and all, so that we can also get like which
// product with associated with which order".
//
// The relationship existed in the data all along and had no way to be read
// from the product's side: a CustomerRequest carries `items[].stockItemId`
// and a WorkOrder carries `stockItemId`, but every query over them was
// scoped by request id, never by product. So "what is this product on?" was
// only answerable by opening orders one at a time.
//
// AN MO *IS* A CUSTOMERREQUEST at `status: "quotation_sales_approved"` —
// there is no separate collection (see manufacturingOrderRoutes.js's own
// base filter). Rather than return only those, this returns every live
// request the product is on and flags which ones have actually reached
// production, so the same endpoint answers "which MO" and the broader "which
// order" the request also asked for.
//
// Neither `items.stockItemId` nor `WorkOrder.stockItemId` is indexed, so
// this is a collection scan on both — acceptable for a per-product detail
// view opened one product at a time, and the reason this is NOT called from
// the product LIST (which would run it once per row).
router.get("/:id/manufacturing-orders", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid product id" });
    }
    const stockItemId = new mongoose.Types.ObjectId(req.params.id);

    const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
    const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

    // Cancelled/rejected requests are excluded — a product "belongs to" an
    // order that is still real, not one that was called off.
    const requests = await CustomerRequest.find({
      "items.stockItemId": stockItemId,
      status: { $nin: ["cancelled", "rejected"] },
    })
      .select("requestId customerInfo status priority createdAt items orderOrigin isInternalOrder requestType measurementName")
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();

    // One query for every work order across all those requests, then grouped
    // in memory — N requests would otherwise mean N round trips.
    const requestIds = requests.map((r) => r._id);
    const workOrders = requestIds.length
      ? await WorkOrder.find({ customerRequestId: { $in: requestIds }, stockItemId })
          .select("workOrderNumber customerRequestId status quantity completedQuantity variantAttributes")
          .lean()
      : [];
    const woByRequest = new Map();
    for (const wo of workOrders) {
      const key = String(wo.customerRequestId);
      if (!woByRequest.has(key)) woByRequest.set(key, []);
      woByRequest.get(key).push(wo);
    }

    const orders = requests.map((r) => {
      // A request can list the same product more than once (different
      // variants split across rows), so quantity is summed over every
      // matching line rather than read off the first one found.
      const lines = (r.items || []).filter(
        (i) => String(i.stockItemId || "") === String(stockItemId),
      );
      const quantity = lines.reduce((s, i) => s + (Number(i.totalQuantity) || 0), 0);
      const wos = woByRequest.get(String(r._id)) || [];
      return {
        id: r._id,
        requestId: r.requestId,
        customerName: r.customerInfo?.name || "—",
        deliveryDeadline: r.customerInfo?.deliveryDeadline || null,
        status: r.status,
        // What makes it an MO rather than a request still being priced.
        isManufacturingOrder: r.status === "quotation_sales_approved",
        orderOrigin: r.orderOrigin || null,
        isInternalOrder: Boolean(r.isInternalOrder),
        requestType: r.requestType || null,
        measurementName: r.measurementName || null,
        priority: r.priority || null,
        createdAt: r.createdAt,
        quantity,
        workOrders: wos.map((w) => ({
          id: w._id,
          workOrderNumber: w.workOrderNumber || "",
          status: w.status,
          quantity: w.quantity || 0,
          completedQuantity: w.completedQuantity || 0,
          variantAttributes: w.variantAttributes || [],
        })),
      };
    });

    res.json({
      success: true,
      orders,
      summary: {
        totalOrders: orders.length,
        manufacturingOrders: orders.filter((o) => o.isManufacturingOrder).length,
        totalQuantity: orders.reduce((s, o) => s + o.quantity, 0),
        totalWorkOrders: workOrders.length,
      },
    });
  } catch (error) {
    console.error("Error fetching manufacturing orders for stock item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching orders for this product" });
  }
});

// ✅ GET stock item by ID
router.get("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id)
      .populate("createdBy", "name email").populate("updatedBy", "name email");
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    res.json({ success: true, stockItem });
  } catch (error) {
    console.error("Error fetching stock item:", error);
    res.status(500).json({ success: false, message: "Server error while fetching stock item" });
  }
});

// ✅ GET variant by stockItemId and variantId
router.get("/:stockItemId/variant/:variantId", async (req, res) => {
  try {
    const { stockItemId, variantId } = req.params;
    const stockItem = await StockItem.findById(stockItemId);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });
    const variant = stockItem.variants.find(v => v._id.toString() === variantId.toString());
    if (!variant) return res.status(404).json({ success: false, message: "Variant not found" });
    res.json({ success: true, variant: { _id: variant._id, attributes: variant.attributes || [], salesPrice: variant.salesPrice, quantityOnHand: variant.quantityOnHand } });
  } catch (error) {
    console.error("Error fetching variant:", error);
    res.status(500).json({ success: false, message: "Server error while fetching variant" });
  }
});

// ✅ CREATE new stock item with variants
router.post("/", async (req, res) => {
  try {
    const {
      name, additionalNames, productType, category, unit, hsnCode, genderCategory,
      baseSalesPrice, baseCost, internalNotes,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    if (!name || !name.trim()) return res.status(400).json({ success: false, message: "Product name is required" });
    if (!category) return res.status(400).json({ success: false, message: "Category is required" });
    if (!attributes || !Array.isArray(attributes) || attributes.length === 0) return res.status(400).json({ success: false, message: "At least one attribute is required" });
    if (!variants || !Array.isArray(variants) || variants.length === 0) return res.status(400).json({ success: false, message: "At least one variant is required" });

    const nameWords = name.trim().split(" ");
    const nameCode = nameWords.map(w => w.substring(0, 3).toUpperCase()).join("");
    const categoryCode = category.substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 1000).toString().padStart(3, "0");
    const reference = `PROD-${categoryCode}-${nameCode}-${randomNum}`;

    const existingItem = await StockItem.findOne({ reference });
    if (existingItem) return res.status(400).json({ success: false, message: "A product with similar reference already exists" });

    const barcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

    const processedAttributes = attributes
      .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
      .map(attr => ({ name: attr.name.trim(), values: attr.values.filter(v => v?.trim()).map(v => v.trim()) }));

    const processedVariants = await Promise.all(
      variants.map(async (variant, index) => {
        const variantSku = `${reference}-V${(index + 1).toString().padStart(3, "0")}`;
        const variantBarcode = `${barcode}-${(index + 1).toString().padStart(3, "0")}`;
        const processedRawItems = await processVariantRawItems(variant.rawItems);
        return {
          sku: variantSku, attributes: variant.attributes || [],
          quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
          minStock: parseFloat(variant.minStock) || 10, maxStock: parseFloat(variant.maxStock) || 100,
          cost: parseFloat(variant.cost) || parseFloat(baseCost) || 0,
          salesPrice: parseFloat(variant.salesPrice) || parseFloat(baseSalesPrice) || 0,
          barcode: variantBarcode, images: variant.images || images || [],
          rawItems: processedRawItems
        };
      })
    );

    const processedOperations = (operations || []).map(op => {
      const minutes = parseFloat(op.minutes) || 0, seconds = parseFloat(op.seconds) || 0;
      return { type: op.type || "", operationCode: op.operationCode || "", machine: op.machine || "", machineType: op.machineType || "", minutes, seconds, totalSeconds: minutes * 60 + seconds, operatorSalary: parseFloat(op.operatorSalary) || 0, operatorCost: parseFloat(op.operatorCost) || 0 };
    });

    const processedMiscellaneousCosts = (miscellaneousCosts || [])
      .filter(c => c.name?.trim())
      .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));

    const processedAdditionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
      .map(n => n?.trim()).filter(n => n && n.length > 0);

    const newStockItem = new StockItem({
      name: name.trim(), additionalNames: processedAdditionalNames,
      reference: reference.toUpperCase(), productType: productType || "Goods",
      category: category.trim(), unit: unit || "Units", hsnCode: hsnCode || "",
      genderCategory: genderCategory || "", internalNotes: internalNotes || "",
      baseSalesPrice: parseFloat(baseSalesPrice) || 0, baseCost: parseFloat(baseCost) || 0,
      attributes: processedAttributes, measurements: measurements || [],
      numberOfPanels: parseInt(numberOfPanels) || 0,
      variants: processedVariants, operations: processedOperations,
      miscellaneousCosts: processedMiscellaneousCosts, images: images || [],
      createdBy: req.user.id
    });

    // BOM first, then the aggregates that read off it — a variant's cost is
    // what it is made of (see recomputeVariantCostsFromBom), and
    // updateStockItemAggregates only ever reads `v.cost`, so the order here
    // is load-bearing.
    recomputeVariantCostsFromBom(newStockItem);
    updateStockItemAggregates(newStockItem);
    await newStockItem.save();

    // Who created this product, and with what — the first entry in the Logs
    // tab (26 Aug 2026, explicit request: "proper logs need to keep so that
    // in future if the data changed then we can easily keep the record ki
    // who did the modify/add"). recordChange never throws, so a logging
    // failure can never take the actual creation down with it.
    const createLines = capLines(describeProductCreated(newStockItem));
    await recordChange(req, {
      departmentSlug: "inventory",
      entity: "stock-item",
      entityId: newStockItem._id,
      entityLabel: newStockItem.name,
      action: "create",
      summary: `Created ${newStockItem.name} (${newStockItem.reference})`,
      before: {},
      after: { changes: createLines },
    });

    res.status(201).json({ success: true, message: "Stock item created successfully", stockItem: newStockItem });

    // ── NO EMAIL ON PRODUCT CREATION (28 Aug 2026, explicit request: "don't
    // sent the mail to the IE and the merchantiser at the time of creating an
    // product").
    //
    // Creating a product from an Enquiry/RFQ used to fire two notifications
    // from right here — `stock_item_created_merchandiser` ("fill in the
    // pricing and build the BOM") and `stock_item_created_production` ("add
    // operations, measurement parameters, costing"), added 26 Aug 2026.
    //
    // They were removed because product creation is not the moment either
    // department actually has work to do. The real hand-off happens later, in
    // the journey's Style & Sample stage, where Sales explicitly routes a
    // style: "Send to Merchandiser" now carries the BOM request
    // (`sample_sent_to_merchandiser`), and the Project Manager is asked for
    // BOM sign-off from step 2 (`sample_bom_approval_requested`) — both in
    // routes/CMS_Routes/Sales/sampleStyles.js. Firing here as well meant a
    // merchandiser was told to build a BOM for every product the moment it was
    // registered, whether or not any style had been routed to them.
    //
    // The two event keys stay in departmentNotify.service.js's registry so
    // history and the Sales Settings toggles keep resolving; nothing calls
    // them any more.
  } catch (error) {
    console.error("Error creating stock item:", error);
    if (error.code === 11000) return res.status(400).json({ success: false, message: "Product with this reference already exists" });
    res.status(500).json({ success: false, message: "Server error while creating stock item" });
  }
});

// ✅ UPDATE stock item (full PUT — kept for backward compatibility)
router.put("/:id", async (req, res) => {
  try {
    const {
      name, additionalNames, productType, category, unit, hsnCode, internalNotes,
      baseSalesPrice, baseCost, genderCategory,
      attributes, variants, measurements, numberOfPanels,
      operations, miscellaneousCosts, images
    } = req.body;

    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    if (name !== undefined) stockItem.name = name.trim();
    if (productType !== undefined) stockItem.productType = productType;
    if (category !== undefined) stockItem.category = category.trim();
    if (unit !== undefined) stockItem.unit = unit;
    if (hsnCode !== undefined) stockItem.hsnCode = hsnCode;
    if (internalNotes !== undefined) stockItem.internalNotes = internalNotes;
    if (baseSalesPrice !== undefined) stockItem.baseSalesPrice = parseFloat(baseSalesPrice) || 0;
    if (baseCost !== undefined) stockItem.baseCost = parseFloat(baseCost) || 0;
    if (genderCategory !== undefined) stockItem.genderCategory = genderCategory;

    if (additionalNames !== undefined) {
      stockItem.additionalNames = (Array.isArray(additionalNames) ? additionalNames : [])
        .map(n => n?.trim()).filter(n => n && n.length > 0);
    }

    if (attributes !== undefined) {
      stockItem.attributes = attributes
        .filter(attr => attr.name?.trim() && Array.isArray(attr.values) && attr.values.length > 0)
        .map(attr => ({ name: attr.name.trim(), values: attr.values.filter(v => v?.trim()).map(v => v.trim()) }));
    }

    if (measurements !== undefined) {
      stockItem.measurements = measurements.filter(m => m?.trim()).map(m => m.trim());
    }
    if (numberOfPanels !== undefined) stockItem.numberOfPanels = parseInt(numberOfPanels) || 0;

    if (variants !== undefined) {
      const existingVariantsById = {};
      stockItem.variants.forEach(v => { existingVariantsById[v._id.toString()] = v; });

      const processedVariants = await Promise.all(
        variants.map(async (variant, index) => {
          const variantSku = variant.sku || `${stockItem.reference}-V${(index + 1).toString().padStart(3, "0")}`;

          if (variant._id && existingVariantsById[variant._id.toString()]) {
            const existing = existingVariantsById[variant._id.toString()];
            existing.sku = variantSku;
            existing.attributes = variant.attributes || existing.attributes;
            existing.quantityOnHand = parseFloat(variant.quantityOnHand) ?? existing.quantityOnHand;
            existing.minStock = parseFloat(variant.minStock) || existing.minStock || 10;
            existing.maxStock = parseFloat(variant.maxStock) || existing.maxStock || 100;
            existing.cost = parseFloat(variant.cost) || stockItem.baseCost || 0;
            existing.salesPrice = parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0;
            existing.barcode = variant.barcode || existing.barcode || "";
            existing.images = variant.images || stockItem.images || existing.images || [];
            // NEVER overwrite rawItems unless caller explicitly sent non-empty rawItems
            // raw-items tab is the sole owner of this field
            if (Array.isArray(variant.rawItems) && variant.rawItems.length > 0) {
              existing.rawItems = await processVariantRawItems(variant.rawItems);
            }
            return existing;
          }

          // Genuinely new variant — only process rawItems if provided
          const newRawItems = (Array.isArray(variant.rawItems) && variant.rawItems.length > 0)
            ? await processVariantRawItems(variant.rawItems)
            : [];

          return {
            sku: variantSku, attributes: variant.attributes || [],
            quantityOnHand: parseFloat(variant.quantityOnHand) || 0,
            minStock: parseFloat(variant.minStock) || 10, maxStock: parseFloat(variant.maxStock) || 100,
            cost: parseFloat(variant.cost) || stockItem.baseCost || 0,
            salesPrice: parseFloat(variant.salesPrice) || stockItem.baseSalesPrice || 0,
            barcode: variant.barcode || "", images: variant.images || stockItem.images || [],
            rawItems: newRawItems
          };
        })
      );
      stockItem.variants = processedVariants;
    }

    if (operations !== undefined) {
      stockItem.operations = (Array.isArray(operations) ? operations : []).map(op => {
        const minutes = parseFloat(op.minutes) || 0, seconds = parseFloat(op.seconds) || 0;
        return { type: op.type || "", machine: op.machine || "", machineType: op.machineType || "", minutes, seconds, totalSeconds: minutes * 60 + seconds, operatorSalary: parseFloat(op.operatorSalary) || 0, operatorCost: parseFloat(op.operatorCost) || 0 };
      });
    }

    if (miscellaneousCosts !== undefined) {
      stockItem.miscellaneousCosts = (Array.isArray(miscellaneousCosts) ? miscellaneousCosts : [])
        .filter(c => c.name?.trim())
        .map(c => ({ name: c.name.trim(), amount: parseFloat(c.amount) || 0, unit: c.unit || "Fixed" }));
    }

    if (images !== undefined) stockItem.images = images || [];
    stockItem.updatedBy = req.user.id;
    recomputeVariantCostsFromBom(stockItem);
    updateStockItemAggregates(stockItem);
    await stockItem.save();

    const updatedStockItem = await StockItem.findById(stockItem._id)
      .populate("createdBy", "name email").populate("updatedBy", "name email");

    res.json({ success: true, message: "Stock item updated successfully", stockItem: updatedStockItem });
  } catch (error) {
    console.error("Error updating stock item:", error);
    res.status(500).json({ success: false, message: "Server error while updating stock item" });
  }
});

// ✅ CLONE stock item
router.post("/:id/clone", async (req, res) => {
  try {
    const original = await StockItem.findById(req.params.id);
    if (!original) return res.status(404).json({ success: false, message: "Stock item not found" });

    const clonedName = `${original.name}_Clone`;
    const nameWords = clonedName.split(" ");
    const nameCode = nameWords.map(w => w.substring(0, 3).toUpperCase()).join("");
    const categoryCode = (original.category || "CAT").substring(0, 3).toUpperCase();
    const randomNum = Math.floor(Math.random() * 9000 + 1000).toString();
    const newReference = `PROD-${categoryCode}-${nameCode}-${randomNum}`.toUpperCase();
    const newBarcode = "89" + Math.floor(Math.random() * 10000000000).toString().padStart(10, "0");

    const clonedVariants = original.variants.map((v, index) => ({
      sku: `${newReference}-V${(index + 1).toString().padStart(3, "0")}`,
      attributes: v.attributes, quantityOnHand: v.quantityOnHand,
      minStock: v.minStock, maxStock: v.maxStock, cost: v.cost, salesPrice: v.salesPrice,
      barcode: `${newBarcode}-${(index + 1).toString().padStart(3, "0")}`,
      images: v.images, rawItems: v.rawItems, status: v.status
    }));

    const clonedItem = new StockItem({
      name: clonedName, additionalNames: original.additionalNames || [],
      reference: newReference, productType: original.productType,
      category: original.category, unit: original.unit, hsnCode: original.hsnCode,
      genderCategory: original.genderCategory || "", internalNotes: original.internalNotes,
      baseSalesPrice: original.baseSalesPrice, baseCost: original.baseCost,
      attributes: original.attributes, measurements: original.measurements,
      numberOfPanels: original.numberOfPanels, variants: clonedVariants,
      operations: original.operations, miscellaneousCosts: original.miscellaneousCosts,
      images: original.images, createdBy: req.user.id
    });

    updateStockItemAggregates(clonedItem);
    await clonedItem.save();

    res.status(201).json({ success: true, message: `Cloned successfully as "${clonedName}"`, stockItem: clonedItem });
  } catch (error) {
    console.error("Error cloning stock item:", error);
    if (error.code === 11000) return res.status(400).json({ success: false, message: "Clone reference collision — please try again" });
    res.status(500).json({ success: false, message: "Server error while cloning stock item" });
  }
});

// ✅ DELETE stock item — SOFT delete (1 Sept 2026, explicit request: "the
// deleted products history is not gonna stored hence it is needed to
// track... so that if we want then we can also revert it"). Used to be
// `stockItem.deleteOne()`, no trace and no way back. Now `isActive: false` —
// same flag the rest of this codebase already uses for a recoverable delete
// — with the record surfacing on the "Deleted" tab (GET /deleted) and
// reversible from there (POST /:id/restore).
router.delete("/:id", async (req, res) => {
  try {
    const stockItem = await StockItem.findById(req.params.id);
    if (!stockItem) return res.status(404).json({ success: false, message: "Stock item not found" });

    stockItem.isActive = false;
    stockItem.deletedAt = new Date();
    stockItem.deletedBy = { id: req.user?.id, name: req.user?.name || "" };
    stockItem.updatedBy = req.user?.id;
    await stockItem.save();

    await recordChange(req, {
      departmentSlug: "inventory",
      entity: "stock-item",
      entityId: stockItem._id,
      entityLabel: stockItem.name,
      action: "delete",
      summary: `Deleted — ${stockItem.name}`,
      before: {}, after: {},
    });

    // Drop the product from every customer it was assigned to (26 Aug 2026,
    // bug fix) — kept for soft delete too: a deleted product shouldn't stay
    // orderable off a customer's assignment list while it's off the shelf.
    // Restoring the product does NOT restore these; re-assigning it is a
    // separate, deliberate act, same as assigning any other product.
    //
    // Best-effort: the delete itself already succeeded, so failing the
    // response here would report a delete that actually happened as an
    // error. The read side filters inactive products out regardless, so a
    // missed sweep degrades to a stale (but still resolvable) reference,
    // never to a broken list — unlike the hard-delete era this comment
    // originally described, `populate` still finds the document.
    try {
      const Customer = require("../../../../models/Customer_Models/Customer");
      const { modifiedCount } = await Customer.updateMany(
        { "assignedStockItems.stockItemId": stockItem._id },
        { $pull: { assignedStockItems: { stockItemId: stockItem._id } } },
      );
      if (modifiedCount) {
        console.log(`[stockItems] unassigned deleted product ${stockItem._id} from ${modifiedCount} customer(s).`);
      }
    } catch (cleanupErr) {
      console.error("[stockItems] customer-assignment cleanup failed:", cleanupErr.message);
    }

    res.json({ success: true, message: "Stock item deleted successfully" });
  } catch (error) {
    console.error("Error deleting stock item:", error);
    res.status(500).json({ success: false, message: "Server error while deleting stock item" });
  }
});

module.exports = router;
// Reused by routes/CMS_Routes/Sales/sampleStyles.js — the "production" pipeline
// registers/updates a StockItem's BOM from R&D's sample submission and needs
// the exact same rawItem-cost resolution and aggregate recompute this file
// already does for its own create/update routes, not a second copy of it.
module.exports.processVariantRawItems = processVariantRawItems;
module.exports.updateStockItemAggregates = updateStockItemAggregates;
module.exports.recomputeVariantCostsFromBom = recomputeVariantCostsFromBom;
// Reused by routes/CMS_Routes/Inventory/Configurations/operations.js — the
// "apply operation group to category" bulk action needs the same category
// list the create form offers, and the same cost-recompute pass every other
// operations write here already runs (26 Aug 2026).
module.exports.STOCK_ITEM_CATEGORIES = STOCK_ITEM_CATEGORIES;