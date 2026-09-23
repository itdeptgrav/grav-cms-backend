// services/storePurchase/productCatalogueBridge.service.js
//
// STORE → FINISHED PRODUCTS & BOM (read-only bridge)
//
// The Store "Materials" catalogue is RawItem — purchased inputs. This bridge
// exposes the SEPARATE legacy StockItem catalogue (finished/semi-finished
// products, their variants, BOM and operations) inside the Store shell, READ
// ONLY. It writes nothing, derives no costing, and never mixes StockItem with
// the accountant's Acc_StockItem.
//
// ── TWO HONEST LIMITATIONS THIS MODULE ENCODES ──────────────────────────────
// 1. StockItem has NO company ownership yet. This bridge is only safe in an
//    unambiguously single-company deployment; `assessDeployment` refuses
//    otherwise rather than listing another tenant's products.
// 2. StockItem has NO stock movement ledger. Its stored quantities are NOT
//    auditable Store balances, so they are surfaced only as "Legacy recorded
//    quantity", never as "stock on hand", never summed across variants, and
//    never fed into a Store stock summary.
"use strict";

// ── 1. Deployment safety (reuses the codebase's single-company premise) ──────
// Mirrors services/companyContext/serviceScope.service.js: the deployment is
// unambiguously single-company when exactly one Acc_Company exists. The caller
// passes the count (from `Acc_Company.find({}).select("_id").limit(2)`), so
// this stays pure and testable.
function assessDeployment(companyCount) {
  if (companyCount === 1) return { available: true, reason: null, code: null };
  if (companyCount === 0) {
    return { available: false, code: "NO_COMPANY", reason: "No company is configured for this deployment, so the shared product catalogue cannot be shown." };
  }
  return {
    available: false, code: "MULTI_COMPANY",
    reason: "This product catalogue is not company-scoped yet, and more than one company is configured. It is withheld here rather than listing every company's products together.",
  };
}

// ── 2. Honest counts, derived from the recorded arrays (no costing) ──────────
const activeVariants = (si) => (Array.isArray(si.variants) ? si.variants : []);

// BOM lives per variant (variants[].rawItems). The honest single figure is the
// count of DISTINCT raw materials used across the product's variants — not a
// sum of per-variant lines, which would multiply shared materials by variants.
function distinctBomMaterialCount(si) {
  const ids = new Set();
  for (const v of activeVariants(si)) {
    for (const r of (v.rawItems || [])) {
      if (r && r.rawItemId != null) ids.add(String(r.rawItemId));
      else if (r && r.rawItemName) ids.add(`name:${r.rawItemName}`); // legacy line w/o id
    }
  }
  return ids.size;
}

/** Classification, from the fields the record actually holds. */
function classification(si) {
  const bits = [];
  if (si.genderCategory) bits.push(si.genderCategory);
  if (si.productType && si.productType !== "Goods") bits.push(si.productType);
  return bits.join(" · ");
}

/** One register row. Counts + identity only — no cost, no stock balance. */
function catalogueRow(si) {
  const variants = activeVariants(si);
  return {
    id: String(si._id),
    name: si.name || "",
    reference: si.reference || "",
    category: si.category || "",
    genderCategory: si.genderCategory || "",
    productType: si.productType || "Goods",
    classification: classification(si),
    variantCount: variants.length,
    bomMaterialCount: distinctBomMaterialCount(si),
    operationCount: Array.isArray(si.operations) ? si.operations.length : 0,
    hasBom: distinctBomMaterialCount(si) > 0,
    hasVariants: variants.length > 0,
    // Lifecycle is isActive (Active / Archived) — the real recoverable-delete
    // flag. The `status` enum ("In Stock"…) is a STOCK label and is NOT used as
    // a lifecycle here.
    lifecycle: si.isActive === false ? "Archived" : "Active",
    updatedAt: si.updatedAt || si.createdAt || null,
  };
}

// ── 3. Read-only detail for the preview drawer (no costing) ──────────────────
function bomLine(r) {
  return {
    rawItemId: r.rawItemId != null ? String(r.rawItemId) : null,
    rawItemName: r.rawItemName || "",
    rawItemSku: r.rawItemSku || "",
    // Quantity consumed per unit produced, in the chosen unit — a BOM fact, not
    // a cost. unitCost/totalCost are deliberately NOT surfaced here.
    quantity: typeof r.quantity === "number" ? r.quantity : null,
    unit: r.unit || "",
    requiredQuantity: typeof r.requiredQuantity === "number" ? r.requiredQuantity : null,
    allowancePercent: typeof r.allowancePercent === "number" ? r.allowancePercent : null,
  };
}

function operationLine(op) {
  return {
    type: op.type || "",
    operationCode: op.operationCode || "",
    machine: op.machine || "",
    machineType: op.machineType || "",
    // SAM / time where recorded — minutes/seconds and the derived total. No
    // operator salary/cost (costing) is exposed.
    minutes: typeof op.minutes === "number" ? op.minutes : null,
    seconds: typeof op.seconds === "number" ? op.seconds : null,
    totalSeconds: typeof op.totalSeconds === "number" ? op.totalSeconds : null,
  };
}

function catalogueDetail(si) {
  const variants = activeVariants(si).map((v) => ({
    sku: v.sku || "",
    attributes: (v.attributes || []).map((a) => ({ name: a.name || "", value: a.value || "" })),
    images: Array.isArray(v.images) ? v.images.filter(Boolean) : [],
    // A STORED figure, NOT a Store stock balance — labelled as such by the UI
    // and never summed with other variants.
    legacyRecordedQuantity: typeof v.quantityOnHand === "number" ? v.quantityOnHand : null,
    bomLines: (v.rawItems || []).map(bomLine),
    bomLineCount: (v.rawItems || []).length,
  }));

  const operations = (si.operations || []).map(operationLine);

  return {
    id: String(si._id),
    name: si.name || "",
    reference: si.reference || "",
    additionalNames: (si.additionalNames || []).filter(Boolean),
    category: si.category || "",
    genderCategory: si.genderCategory || "",
    productType: si.productType || "Goods",
    classification: classification(si),
    hsnCode: si.hsnCode || "",
    unit: si.unit || "",
    lifecycle: si.isActive === false ? "Archived" : "Active",
    images: Array.isArray(si.images) ? si.images.filter(Boolean) : [],
    variants,
    operations,
    // Explicit missing-data states, so an empty section reads as "none recorded"
    // rather than a broken panel.
    missing: {
      images: !(Array.isArray(si.images) && si.images.filter(Boolean).length) && !variants.some((v) => v.images.length),
      variants: variants.length === 0,
      bom: !variants.some((v) => v.bomLines.length > 0),
      operations: operations.length === 0,
    },
    createdAt: si.createdAt || null,
    updatedAt: si.updatedAt || null,
  };
}

// The limitation lines the bridge always states.
const LIMITATIONS = Object.freeze({
  legacyQuantity: "Quantities here are legacy recorded figures, not Store stock balances — this catalogue has no Store stock-movement ledger.",
  sharedCatalogue: "This is the existing shared product catalogue. It is not company-scoped: products are not owned by a company yet.",
});

module.exports = {
  assessDeployment, catalogueRow, catalogueDetail,
  distinctBomMaterialCount, classification, LIMITATIONS,
};
