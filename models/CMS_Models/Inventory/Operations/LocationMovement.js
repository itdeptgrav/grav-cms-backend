// models/CMS_Models/Inventory/Operations/LocationMovement.js
//
// Warehouse Stock V1 — the immutable, company-scoped LOCATION ledger.
//
// It answers "which warehouse/location holds this item?" WITHOUT becoming a
// second on-hand authority. `RawItem.quantity` stays the company-wide total;
// a location's balance is DERIVED by replaying these applied movements
// (sum of `in` − sum of `out`). There is no editable per-location quantity —
// a correction is another movement, never an edit, so the ledger is an honest
// audit trail.

const mongoose = require("mongoose");

// Directions and the movement types that produce them. `opening_assignment`
// places legacy/unassigned stock into a location; `transfer_in`/`transfer_out`
// are the two equal legs of an internal transfer, tied by `transferId`.
const DIRECTIONS = Object.freeze(["in", "out"]);
const MOVEMENT_TYPES = Object.freeze([
  "receipt",
  "issue",
  "return",
  "adjustment",
  "transfer_in",
  "transfer_out",
  "opening_assignment",
]);

const locationMovementSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // What moved.
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true, index: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    baseUnit: { type: String, trim: true, default: "" }, // the item's base unit — never mix units

    // Where it moved. The location is a subdocument of the warehouse, so a
    // reference is (warehouseId, locationId). Names are snapshots for display.
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true, index: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    warehouseName: { type: String, trim: true, default: "" },
    warehouseShortName: { type: String, trim: true, default: "" },
    locationCode: { type: String, trim: true, default: "" },
    locationName: { type: String, trim: true, default: "" },

    // How much, which way. Quantity is always positive and in the base unit;
    // direction carries the sign.
    direction: { type: String, enum: DIRECTIONS, required: true },
    quantity: { type: Number, required: true, min: 0 },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },

    // The source document / operation that caused it, and the transfer tie.
    source: {
      kind: { type: String, trim: true, default: "" }, // e.g. "issue", "transfer", "receipt", "assignment"
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      reference: { type: String, trim: true, default: "" },
    },
    transferId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Who, when, why, and the idempotency identity of the operation.
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },
    idempotencyKey: { type: String, trim: true, default: "" },

    // Applied is the only state a written row has — it is a fact, not a claim.
    // Retained so a later reader can filter on it explicitly.
    applied: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "location_movements" },
);

// Balance derivation reads by item (+ variant) and by location.
locationMovementSchema.index({ companyId: 1, itemId: 1, variantId: 1 });
locationMovementSchema.index({ companyId: 1, warehouseId: 1, locationId: 1 });

// Defence-in-depth against a replayed operation writing a duplicate leg: one
// (type, location) per idempotency key. The withIdempotency middleware already
// prevents re-execution; this makes a duplicate physically impossible too.
locationMovementSchema.index(
  { companyId: 1, idempotencyKey: 1, type: 1, locationId: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } } },
);

module.exports =
  mongoose.models.LocationMovement ||
  mongoose.model("LocationMovement", locationMovementSchema);
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
module.exports.DIRECTIONS = DIRECTIONS;
