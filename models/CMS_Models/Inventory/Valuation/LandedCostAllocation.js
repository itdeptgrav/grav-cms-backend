// models/CMS_Models/Inventory/Valuation/LandedCostAllocation.js
//
// Landed-cost allocation (Inventory Valuation V2).
//
// A dedicated, company-scoped record of how eligible acquisition charges from a
// POSTED supplier Purchase Voucher were allocated onto the goods actually
// received. It NEVER edits the supplier bill, the PO, the stock movement or any
// ledger posting — it is a management-valuation overlay, read by the valuation
// engine and layered onto the exact receipt movements it names.
//
// One ACTIVE allocation exists per source voucher (a partial unique index
// enforces it). Re-allocating supersedes the prior version deliberately rather
// than adding the same freight twice; a cancelled/void source voucher is
// excluded by authoritative status without deleting the history.

const mongoose = require("mongoose");

// One eligible charge line selected from the voucher, or an explicit manual
// entry when the system cannot identify a line reliably.
const chargeRefSchema = new mongoose.Schema(
  {
    // The voucher inventoryEntries[]._id of the charge, when it came from a
    // recognised charge line. Null for an explicitly-entered adjustment.
    chargeLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    description: { type: String, trim: true, default: "" },
    amount: { type: Number, required: true, min: 0 },
    manual: { type: Boolean, default: false }, // explicitly entered, confirmed
  },
  { _id: false },
);

// One receipt movement the charge was allocated onto. The authoritative target
// is `movementId` (a RawItem.stockTransactions[]._id); `poLineId` is a
// best-effort snapshot since a receipt movement is tied to the PO but not to a
// single PO line.
const targetSchema = new mongoose.Schema(
  {
    movementId: { type: mongoose.Schema.Types.ObjectId, required: true },
    poLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    receivedQuantity: { type: Number, required: true },
    unit: { type: String, trim: true, default: "" },
    baseUnitCost: { type: Number, default: 0 },
    baseReceiptValue: { type: Number, default: 0 },
    allocatedAmount: { type: Number, default: 0 },
    allocatedPerUnit: { type: Number, default: 0 },
  },
  { _id: false },
);

// A prior distribution kept for revision/reversal audit.
const distributionSnapshotSchema = new mongoose.Schema(
  { movementId: mongoose.Schema.Types.ObjectId, allocatedAmount: Number },
  { _id: false },
);

const landedCostAllocationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },

    sourceVoucherId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Voucher", required: true, index: true },
    sourceVoucherNumber: { type: String, trim: true, default: "" },

    purchaseOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "PurchaseOrder", default: null, index: true },
    purchaseOrderNumber: { type: String, trim: true, default: "" },

    charges: { type: [chargeRefSchema], default: [] },
    totalChargeAmount: { type: Number, required: true, min: 0 },

    // Only "receipt_base_value" is supported in V2. Weight/volume are declared
    // unavailable elsewhere and never stored here.
    allocationBasis: { type: String, enum: ["receipt_base_value"], default: "receipt_base_value" },

    targets: { type: [targetSchema], default: [] },
    totalAllocated: { type: Number, default: 0 },

    // active — overlaid on valuation; superseded — replaced by a newer version;
    // reversed — withdrawn (e.g. its source voucher was cancelled/void).
    status: { type: String, enum: ["active", "superseded", "reversed"], default: "active", index: true },
    version: { type: Number, default: 1 },

    // Revision / reversal audit.
    supersedesId: { type: mongoose.Schema.Types.ObjectId, ref: "LandedCostAllocation", default: null },
    reason: { type: String, trim: true, default: "" },
    previousTotal: { type: Number, default: null },
    previousDistribution: { type: [distributionSnapshotSchema], default: undefined },

    reversedAt: { type: Date, default: null },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reversedReason: { type: String, trim: true, default: "" },

    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "landed_cost_allocations" },
);

// One ACTIVE allocation per source voucher, per company — the idempotency
// guarantee. A second save for the same voucher supersedes the first rather
// than double-counting; superseded/reversed rows are kept for audit.
landedCostAllocationSchema.index(
  { companyId: 1, sourceVoucherId: 1 },
  { unique: true, partialFilterExpression: { status: "active" } },
);
landedCostAllocationSchema.index({ companyId: 1, "targets.itemId": 1, status: 1 });
landedCostAllocationSchema.index({ purchaseOrderId: 1, status: 1 });

module.exports =
  mongoose.models.LandedCostAllocation ||
  mongoose.model("LandedCostAllocation", landedCostAllocationSchema);
