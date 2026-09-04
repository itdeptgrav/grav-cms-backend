// routes/CMS_Routes/Inventory/valuation/landedCostRoutes.js
//
// Landed-cost allocation (Inventory Valuation V2) — Accounting writes here.
// Mount: app.use("/api/cms/inventory/landed-costs", require("./routes/..."))
//
// Allocates eligible acquisition charges from a POSTED purchase voucher (linked
// to a PO) onto the receipt movements of the goods actually received. It reads
// the supplier bill, the PO and the stock movements; it writes ONLY the
// LandedCostAllocation overlay. It never edits the voucher, the PO, a stock
// movement, a quantity or a ledger posting.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { Acc_Voucher } = require("../../../../models/Accountant_model/Acc_VoucherModels");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const LandedCostAllocation = require("../../../../models/CMS_Models/Inventory/Valuation/LandedCostAllocation");
const { accountantAuth } = require("../../../../Middlewear/AccountantAuthMiddleware");
const {
  allocateByBaseValue,
  classifyChargeHint,
  ALLOCATION_BASES,
} = require("../../../../services/landedCostAllocation.service");

const auth = accountantAuth;
router.use(auth);

const RECEIPT_TYPES = new Set(["ADD", "VARIANT_ADD", "PURCHASE_ORDER"]);
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const isPos = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

// ── Authoritative eligibility + workspace data ───────────────────────────────
// Returns { ok, voucher, po, charges, receivedLines, existing } or a refusal.
// Every rule is enforced here so neither the workspace nor the save trusts the
// client about eligibility.
async function loadWorkspace(voucherId) {
  if (!mongoose.Types.ObjectId.isValid(voucherId)) {
    return { ok: false, status: 404, reason: "NOT_FOUND", message: "Voucher not found." };
  }
  const voucher = await Acc_Voucher.findById(voucherId).lean();
  if (!voucher) return { ok: false, status: 404, reason: "NOT_FOUND", message: "Voucher not found." };

  // Only a POSTED purchase voucher, explicitly linked to a PO, can be a source.
  if (voucher.voucherType !== "purchase") {
    return { ok: false, status: 409, reason: "NOT_PURCHASE", message: "Only a purchase voucher can allocate landed cost." };
  }
  // A service-order supplier bill is an expense — it never creates inventory
  // landed cost.
  if (voucher.serviceOrderId) {
    return { ok: false, status: 409, reason: "SERVICE_BILL", message: "A service order bill cannot create inventory landed cost." };
  }
  if (voucher.status !== "posted") {
    return { ok: false, status: 409, reason: "NOT_POSTED", currentStatus: voucher.status, message: `This voucher is ${voucher.status}. Landed cost can be allocated only from a posted bill.` };
  }
  if (!voucher.purchaseOrderId) {
    return { ok: false, status: 409, reason: "UNLINKED", message: "This voucher is not linked to a purchase order." };
  }

  const po = await PurchaseOrder.findById(voucher.purchaseOrderId).lean();
  if (!po) return { ok: false, status: 409, reason: "PO_NOT_FOUND", message: "The linked purchase order was not found." };
  // Same company — nothing upstream guarantees this, so enforce it here.
  if (String(po.companyId || "") !== String(voucher.companyId || "")) {
    return { ok: false, status: 409, reason: "CROSS_COMPANY", message: "The voucher and its purchase order belong to different companies." };
  }

  // Eligible charge lines: the voucher's charge inventoryEntries. Recoverable
  // tax / payment / penalty lines are HINTED excluded and never pre-selected.
  const charges = (voucher.inventoryEntries || [])
    .filter((e) => e.isCharge === true)
    .map((e) => ({
      chargeLineId: String(e._id),
      description: e.chargeDescription || e.stockItemName || "",
      amount: round2(Number(e.amount) || 0),
      taxAmount: round2(Number(e.taxAmount) || 0),
      hint: classifyChargeHint(e.chargeDescription || ""),
    }));

  // Received target lines: applied receipt movements for THIS PO, priced.
  const items = await RawItem.find({
    companyId: voucher.companyId,
    "stockTransactions.purchaseOrderId": po._id,
  })
    .select("sku name unit customUnit variants stockTransactions")
    .lean();
  const receivedLines = [];
  for (const it of items) {
    // Index this item's variants so a movement's variantId resolves to a real
    // name/SKU — two receipts of the same item must not read identically.
    const variantById = new Map(
      (it.variants || [])
        .filter((v) => v && v._id != null)
        .map((v) => [String(v._id), v]),
    );
    for (const m of it.stockTransactions || []) {
      if (String(m.purchaseOrderId || "") !== String(po._id)) continue;
      if (!RECEIPT_TYPES.has(m.type)) continue;
      const qty = Number(m.quantity);
      const rate = Number(m.unitPrice);
      const priced = Number.isFinite(rate) && rate > 0;
      const variantId = m.variantId != null ? String(m.variantId) : null;
      const variant = variantId ? variantById.get(variantId) : null;
      const variantName = variant
        ? (Array.isArray(variant.combination) && variant.combination.length ? variant.combination.join(" / ") : "")
        : (Array.isArray(m.variantCombination) && m.variantCombination.length ? m.variantCombination.join(" / ") : "");
      receivedLines.push({
        movementId: String(m._id),
        itemId: String(it._id),
        itemName: it.name || "",
        sku: it.sku || "",
        variantId,
        variantName: variantName || "",
        variantSku: variant ? variant.sku || "" : "",
        receivedQuantity: Number.isFinite(qty) ? qty : null,
        unit: it.unit || it.customUnit || "",
        baseUnitCost: Number.isFinite(rate) ? rate : null,
        baseReceiptValue: priced && Number.isFinite(qty) ? round2(qty * rate) : (priced ? null : 0),
        priced,
        receiptDate: m.createdAt || null,
        invoiceNumber: m.invoiceNumber || "",
      });
    }
  }
  // Stable deterministic order (by movement id) so remainder placement is fixed.
  receivedLines.sort((a, b) => a.movementId.localeCompare(b.movementId));

  const existing = await LandedCostAllocation.findOne({
    companyId: voucher.companyId,
    sourceVoucherId: voucher._id,
    status: "active",
  }).lean();

  return {
    ok: true,
    voucher: { id: String(voucher._id), number: voucher.voucherNumber || "", companyId: String(voucher.companyId), status: voucher.status },
    po: { id: String(po._id), number: po.poNumber || "" },
    charges,
    receivedLines,
    bases: ALLOCATION_BASES,
    existing: existing || null,
    goodsReceived: receivedLines.length > 0,
  };
}

// GET /workspace/:voucherId — everything the Accounting workspace needs.
router.get("/workspace/:voucherId", async (req, res) => {
  try {
    const ws = await loadWorkspace(req.params.voucherId);
    if (!ws.ok) return res.status(ws.status).json({ success: false, reason: ws.reason, currentStatus: ws.currentStatus, message: ws.message });
    if (!ws.goodsReceived) {
      return res.json({ success: true, ...ws, message: "No goods have been received against this order yet, so landed cost cannot be allocated." });
    }
    res.json({ success: true, ...ws });
  } catch (e) {
    console.error("[landed-cost] workspace:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /voucher/:voucherId — the active allocation for a voucher, if any.
router.get("/voucher/:voucherId", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.voucherId)) return res.status(404).json({ success: false, message: "Not found." });
    const voucher = await Acc_Voucher.findById(req.params.voucherId).select("companyId").lean();
    if (!voucher) return res.status(404).json({ success: false, message: "Voucher not found." });
    const allocation = await LandedCostAllocation.findOne({
      companyId: voucher.companyId,
      sourceVoucherId: req.params.voucherId,
      status: "active",
    }).lean();
    res.json({ success: true, allocation: allocation || null });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// Build authoritative charge total + allocation from a request, using the
// SERVER's copy of the voucher charges and receipt base values.
function buildAllocation(ws, body) {
  // Every allocated charge MUST reference an actual charge line on the posted
  // supplier bill. Manual / off-bill charges are refused in this version: if a
  // freight or duty amount is missing, it has to be recorded correctly on a
  // purchase voucher first — landed cost never invents a charge or a posting.
  const wantCharges = Array.isArray(body.charges) ? body.charges : [];
  const chargeById = new Map(ws.charges.map((c) => [c.chargeLineId, c]));
  const resolvedCharges = [];
  for (const c of wantCharges) {
    if (c.manual === true || (c.chargeLineId == null && c.amount != null)) {
      return {
        ok: false,
        status: 400,
        reason: "MANUAL_NOT_SUPPORTED",
        message:
          "Manual landed-cost entry is not supported. Every charge must reference a charge line on the posted supplier bill — record the missing charge on a purchase voucher first.",
      };
    }
    const line = chargeById.get(String(c.chargeLineId));
    if (!line) return { ok: false, status: 400, reason: "UNKNOWN_CHARGE_LINE", message: "A selected charge line is not on this voucher." };
    // Recoverable tax / payment / penalty lines are never acquisition costs.
    if (line.hint === "excluded") {
      return { ok: false, status: 400, reason: "INELIGIBLE_CHARGE", message: `"${line.description}" is not an acquisition cost (recoverable tax, payment or penalty) and cannot be allocated to inventory.` };
    }
    resolvedCharges.push({ chargeLineId: line.chargeLineId, description: line.description, amount: line.amount, manual: false });
  }
  const totalCharge = round2(resolvedCharges.reduce((s, c) => s + c.amount, 0));
  if (!isPos(totalCharge)) return { ok: false, status: 400, reason: "INVALID_CHARGE", message: "Select at least one eligible charge with a positive amount." };

  // Selected receipt targets — server reads each target's base value from its
  // own workspace copy, never from the client.
  const wantTargets = Array.isArray(body.targetMovementIds) ? body.targetMovementIds.map(String) : [];
  const rlById = new Map(ws.receivedLines.map((r) => [r.movementId, r]));
  const targets = [];
  for (const mid of wantTargets) {
    const rl = rlById.get(mid);
    if (!rl) return { ok: false, status: 400, reason: "UNKNOWN_TARGET", message: "A selected receipt line is not part of this order." };
    targets.push(rl);
  }
  if (!targets.length) return { ok: false, status: 400, reason: "NO_TARGETS", message: "Select at least one received line." };

  const alloc = allocateByBaseValue({
    totalCharge,
    targets: targets.map((t) => ({ key: t.movementId, baseValue: isPos(t.baseReceiptValue) ? t.baseReceiptValue : 0, receivedQuantity: t.receivedQuantity })),
    basis: body.basis || "receipt_base_value",
  });
  if (!alloc.ok) return { ok: false, status: 400, reason: alloc.reason, message: alloc.message };

  const allocByKey = new Map(alloc.allocations.map((a) => [a.key, a]));
  const storedTargets = targets.map((t) => {
    const a = allocByKey.get(t.movementId);
    return {
      movementId: t.movementId,
      poLineId: null,
      itemId: t.itemId,
      itemName: t.itemName,
      sku: t.sku,
      variantId: t.variantId,
      receivedQuantity: t.receivedQuantity,
      unit: t.unit,
      baseUnitCost: t.baseUnitCost,
      baseReceiptValue: t.baseReceiptValue,
      allocatedAmount: a.allocatedAmount,
      allocatedPerUnit: a.allocatedPerUnit,
    };
  });
  const totalAllocated = round2(storedTargets.reduce((s, t) => s + (t.allocatedAmount || 0), 0));
  return { ok: true, resolvedCharges, totalCharge, storedTargets, totalAllocated };
}

// POST / — create the allocation. Idempotent: an existing active allocation is
// NOT overwritten silently; the caller must revise it explicitly (with reason).
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};
    const ws = await loadWorkspace(body.voucherId);
    if (!ws.ok) return res.status(ws.status).json({ success: false, reason: ws.reason, currentStatus: ws.currentStatus, message: ws.message });
    if (!ws.goodsReceived) return res.status(409).json({ success: false, reason: "NO_GOODS", message: "No goods received yet — landed cost cannot be allocated." });

    const wantsRevise = body.revise === true;
    if (ws.existing && !wantsRevise) {
      return res.status(409).json({
        success: false,
        reason: "ALLOCATION_EXISTS",
        message: "This bill already has a landed-cost allocation. Use Revise allocation to change it.",
        existing: ws.existing,
      });
    }
    if (ws.existing && wantsRevise && !String(body.reason || "").trim()) {
      return res.status(400).json({ success: false, reason: "REASON_REQUIRED", message: "A revision needs a reason." });
    }

    const built = buildAllocation(ws, body);
    if (!built.ok) return res.status(built.status).json({ success: false, reason: built.reason, message: built.message });

    let supersededFrom = null;
    if (ws.existing) {
      // Version the prior allocation — never delete or double-count it.
      await LandedCostAllocation.updateOne(
        { _id: ws.existing._id, status: "active" },
        { $set: { status: "superseded" } },
      );
      supersededFrom = ws.existing;
    }

    const doc = await LandedCostAllocation.create({
      companyId: ws.voucher.companyId,
      sourceVoucherId: ws.voucher.id,
      sourceVoucherNumber: ws.voucher.number,
      purchaseOrderId: ws.po.id,
      purchaseOrderNumber: ws.po.number,
      charges: built.resolvedCharges,
      totalChargeAmount: built.totalCharge,
      allocationBasis: "receipt_base_value",
      targets: built.storedTargets,
      totalAllocated: built.totalAllocated,
      status: "active",
      version: supersededFrom ? (supersededFrom.version || 1) + 1 : 1,
      supersedesId: supersededFrom ? supersededFrom._id : null,
      reason: wantsRevise ? String(body.reason || "").trim() : "",
      previousTotal: supersededFrom ? supersededFrom.totalChargeAmount : null,
      previousDistribution: supersededFrom
        ? (supersededFrom.targets || []).map((t) => ({ movementId: t.movementId, allocatedAmount: t.allocatedAmount }))
        : undefined,
      actorId: req.user && req.user.id ? req.user.id : null,
      actorName: (req.user && req.user.name) || "",
    });

    res.status(201).json({ success: true, allocation: doc.toObject(), revised: !!supersededFrom });
  } catch (e) {
    if (e && e.code === 11000) {
      return res.status(409).json({ success: false, reason: "ALLOCATION_EXISTS", message: "This bill already has a landed-cost allocation." });
    }
    console.error("[landed-cost] create:", e);
    res.status(400).json({ success: false, message: e.message });
  }
});

module.exports = router;
module.exports.loadWorkspace = loadWorkspace;
