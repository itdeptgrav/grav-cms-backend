// routes/CMS_Routes/Inventory/Operations/returnRequests.js
//
// Mount as:
//   const returnRoutes = require("./routes/CMS_Routes/Inventory/Operations/returnRequests");
//   app.use("/api/cms/inventory/operations/purchase-orders/:poId/returns", returnRoutes);
//
// Endpoints:
//   GET    /                    → list all return requests for a PO
//   POST   /                    → create a new return request (deducts damaged qty from stock)
//   POST   /:returnId/receive   → record partial/full re-delivery from vendor (credits stock)
//   PATCH  /:returnId/cancel    → cancel a pending return request

const express  = require("express");
const router   = express.Router({ mergeParams: true }); // mergeParams to get :poId
const mongoose = require("mongoose");
const PurchaseOrder = require("../../../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const RawItem       = require("../../../../models/CMS_Models/Inventory/Products/RawItem");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ── Helper: find & update variant qty on a RawItem ────────────────────────
async function adjustVariantStock(rawItemId, variantId, variantCombination, delta, txnData) {
    const rawItem = await RawItem.findById(rawItemId);
    if (!rawItem) throw new Error(`RawItem ${rawItemId} not found`);

    const prevQty = rawItem.quantity || 0;

    // Match variant
    let matchedVariant = null;
    if (variantId && rawItem.variants?.length) {
        matchedVariant = rawItem.variants.id(variantId);
    }
    if (!matchedVariant && variantCombination?.length && rawItem.variants?.length) {
        matchedVariant = rawItem.variants.find(v =>
            v.combination?.length === variantCombination.length &&
            v.combination.every((val, i) => val === variantCombination[i])
        );
    }

    if (matchedVariant) {
        matchedVariant.quantity = Math.max(0, (matchedVariant.quantity || 0) + delta);
        matchedVariant.status =
            matchedVariant.quantity === 0 ? "Out of Stock" :
            matchedVariant.quantity <= (matchedVariant.minStock || rawItem.minStock || 0) ? "Low Stock" : "In Stock";
    }

    // Always adjust top-level qty too
    rawItem.quantity = Math.max(0, prevQty + delta);
    rawItem.status =
        rawItem.quantity === 0 ? "Out of Stock" :
        rawItem.quantity <= (rawItem.minStock || 0) ? "Low Stock" : "In Stock";

    rawItem.stockTransactions.push({
        ...txnData,
        previousQuantity: prevQty,
        newQuantity: rawItem.quantity,
        ...(matchedVariant ? {
            variantPreviousQuantity: (prevQty + delta > 0 ? (matchedVariant.quantity - delta) : 0),
            variantNewQuantity: matchedVariant.quantity,
        } : {})
    });

    await rawItem.save();
    return rawItem;
}


// ═══════════════════════════════════════════════════════════════════════════
// GET / — list return requests for a PO
// ═══════════════════════════════════════════════════════════════════════════
router.get("/", async (req, res) => {
    try {
        const po = await PurchaseOrder.findById(req.params.poId)
            .select("poNumber returnRequests")
            .populate("returnRequests.reportedBy", "name")
            .populate("returnRequests.receipts.receivedBy", "name")
            .lean();

        if (!po) return res.status(404).json({ success: false, message: "PO not found" });

        res.json({ success: true, returnRequests: po.returnRequests || [] });
    } catch (err) {
        console.error("[returns GET /]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST / — create return request
// Body: { poItemId, damagedQuantity, reason }
// Effect: deducts damagedQuantity from RawItem stock immediately
// ═══════════════════════════════════════════════════════════════════════════
router.post("/", async (req, res) => {
    try {
        const { poItemId, damagedQuantity, reason = "" } = req.body;

        if (!poItemId) return res.status(400).json({ success: false, message: "poItemId required" });
        const dmgQty = parseFloat(damagedQuantity);
        if (isNaN(dmgQty) || dmgQty <= 0) return res.status(400).json({ success: false, message: "Valid damagedQuantity required" });

        const po = await PurchaseOrder.findById(req.params.poId);
        if (!po) return res.status(404).json({ success: false, message: "PO not found" });

        const poItem = po.items.id(poItemId);
        if (!poItem) return res.status(404).json({ success: false, message: "PO item not found" });

        if (dmgQty > (poItem.receivedQuantity || 0)) {
            return res.status(400).json({
                success: false,
                message: `Damaged qty (${dmgQty}) cannot exceed received qty (${poItem.receivedQuantity})`
            });
        }

        // ── Deduct from RawItem stock ────────────────────────────────────
        await adjustVariantStock(
            poItem.rawItem,
            poItem.variantId,
            poItem.variantCombination,
            -dmgQty,
            {
                type: poItem.variantId ? "VARIANT_REDUCE" : "REDUCE",
                quantity: dmgQty,
                reason: `Return request — damaged/faulty (PO: ${po.poNumber})`,
                notes: reason || "Damaged goods reported by store",
                variantId: poItem.variantId || undefined,
                variantCombination: poItem.variantCombination?.length ? poItem.variantCombination : undefined,
                purchaseOrder: po.poNumber,
                purchaseOrderId: po._id,
                performedBy: req.user?.id || null,
            }
        );

        // ── Push return request ──────────────────────────────────────────
        po.returnRequests.push({
            poItemId:          poItem._id,
            rawItem:           poItem.rawItem,
            itemName:          poItem.itemName,
            sku:               poItem.sku,
            unit:              poItem.unit,
            variantId:         poItem.variantId || null,
            variantCombination: poItem.variantCombination || [],
            damagedQuantity:   dmgQty,
            returnedQuantity:  0,
            pendingReturnQty:  dmgQty,
            status:            "PENDING",
            reason,
            reportedBy:        req.user?.id || null,
            reportedAt:        new Date(),
            receipts:          [],
        });

        await po.save();

        const newReturn = po.returnRequests[po.returnRequests.length - 1];
        res.status(201).json({
            success: true,
            message: `Return request created. ${dmgQty} ${poItem.unit} deducted from stock.`,
            returnRequest: newReturn,
        });
    } catch (err) {
        console.error("[returns POST /]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
// POST /:returnId/receive — record vendor re-delivery (partial or full)
// Body: { quantityReceived, notes }
// Effect: credits quantityReceived back to RawItem stock
// ═══════════════════════════════════════════════════════════════════════════
router.post("/:returnId/receive", async (req, res) => {
    try {
        const { quantityReceived, notes = "" } = req.body;
        const recvQty = parseFloat(quantityReceived);

        if (isNaN(recvQty) || recvQty <= 0) {
            return res.status(400).json({ success: false, message: "Valid quantityReceived required" });
        }

        const po = await PurchaseOrder.findById(req.params.poId);
        if (!po) return res.status(404).json({ success: false, message: "PO not found" });

        const returnReq = po.returnRequests.id(req.params.returnId);
        if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });

        if (returnReq.status === "COMPLETED") {
            return res.status(400).json({ success: false, message: "Return request already completed" });
        }
        if (returnReq.status === "CANCELLED") {
            return res.status(400).json({ success: false, message: "Return request is cancelled" });
        }

        if (recvQty > returnReq.pendingReturnQty) {
            return res.status(400).json({
                success: false,
                message: `Cannot receive ${recvQty} — only ${returnReq.pendingReturnQty} pending`
            });
        }

        // ── Credit RawItem stock ─────────────────────────────────────────
        await adjustVariantStock(
            returnReq.rawItem,
            returnReq.variantId,
            returnReq.variantCombination,
            recvQty,
            {
                type: returnReq.variantId ? "VARIANT_ADD" : "ADD",
                quantity: recvQty,
                reason: `Return receipt from vendor (PO: ${po.poNumber})`,
                notes: notes || `Vendor replacement received against return request`,
                variantId: returnReq.variantId || undefined,
                variantCombination: returnReq.variantCombination?.length ? returnReq.variantCombination : undefined,
                purchaseOrder: po.poNumber,
                purchaseOrderId: po._id,
                performedBy: req.user?.id || null,
            }
        );

        // ── Update return request ────────────────────────────────────────
        returnReq.receipts.push({
            quantityReceived: recvQty,
            receivedDate:     new Date(),
            notes,
            receivedBy:       req.user?.id || null,
        });

        returnReq.returnedQuantity  = (returnReq.returnedQuantity || 0) + recvQty;
        returnReq.pendingReturnQty  = Math.max(0, returnReq.damagedQuantity - returnReq.returnedQuantity);
        returnReq.status            = returnReq.pendingReturnQty <= 0 ? "COMPLETED" : "PARTIAL";

        await po.save();

        res.json({
            success: true,
            message: `${recvQty} ${returnReq.unit} credited back to stock.`,
            returnRequest: returnReq,
        });
    } catch (err) {
        console.error("[returns POST /:returnId/receive]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});


// ═══════════════════════════════════════════════════════════════════════════
// PATCH /:returnId/cancel — cancel a return request
// Does NOT reverse the stock deduction (goods are still damaged/missing)
// ═══════════════════════════════════════════════════════════════════════════
router.patch("/:returnId/cancel", async (req, res) => {
    try {
        const po = await PurchaseOrder.findById(req.params.poId);
        if (!po) return res.status(404).json({ success: false, message: "PO not found" });

        const returnReq = po.returnRequests.id(req.params.returnId);
        if (!returnReq) return res.status(404).json({ success: false, message: "Return request not found" });

        if (returnReq.status === "COMPLETED") {
            return res.status(400).json({ success: false, message: "Cannot cancel a completed return request" });
        }

        returnReq.status = "CANCELLED";
        await po.save();

        res.json({ success: true, message: "Return request cancelled", returnRequest: returnReq });
    } catch (err) {
        console.error("[returns PATCH cancel]", err);
        res.status(500).json({ success: false, message: err.message });
    }
});

module.exports = router;