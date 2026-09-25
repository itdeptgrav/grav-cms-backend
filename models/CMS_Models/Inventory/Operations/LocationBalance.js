// models/CMS_Models/Inventory/Operations/LocationBalance.js
//
// Warehouse Stock V1 (correction) — a rebuildable location-balance PROJECTION.
//
// LocationMovement stays the immutable audit/source of truth; this projection
// exists only so a balance can be changed under a CONDITIONAL guard, atomically.
// A read-then-insert check let two concurrent issues/assignments spend the same
// balance; a guarded `$inc` (matchedCount 0 ⇒ refused) cannot. It is fully
// rebuildable by replaying LocationMovement, so it is a cache, not a new
// authority.
//
// Two row kinds share the schema:
//   · a LOCATION row  — (warehouseId, locationId) set: on-hand at that location.
//   · an ASSIGNED_TOTAL row — warehouseId/locationId null: the total placed
//     across all locations for one item/variant, guarded against company
//     on-hand so placement can never exceed what the company holds.

const mongoose = require("mongoose");

const locationBalanceSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, default: null },
    locationId: { type: mongoose.Schema.Types.ObjectId, default: null },
    onHand: { type: Number, default: 0 }, // location on-hand, or the assigned total on the sentinel row
  },
  { timestamps: true, collection: "location_balances" },
);

// One row per (item, variant, location); the sentinel assigned-total row has
// null warehouse/location — still one per item/variant.
locationBalanceSchema.index(
  { companyId: 1, itemId: 1, variantId: 1, warehouseId: 1, locationId: 1 },
  { unique: true },
);

module.exports =
  mongoose.models.LocationBalance ||
  mongoose.model("LocationBalance", locationBalanceSchema);
