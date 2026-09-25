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
  // Supplier returns: damaged goods leaving a location back to the vendor
  // (OUT), and the vendor's replacement arriving into a location (IN). Kept as
  // their OWN types so the ledger stays semantically distinct from a store
  // issue, an MRF department return, or a PO receipt.
  "supplier_return",
  "replacement_receipt",
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

    // Which printed marking (Barcode sticker) the moved stock belongs to, when
    // the movement was made by scanning one (25 Sep 2026). Optional: stock can
    // still be placed by item. A marking's per-location balance is DERIVED by
    // replaying rows that carry its id; the guarded LocationBalance projection
    // stays at item/variant/location grain, which is the inventory's own grain.
    barcodeId: { type: mongoose.Schema.Types.ObjectId, ref: "Barcode", default: null },
    barcodeLabel: { type: String, trim: true, default: "" }, // e.g. "MK-…" / sticker qty+unit, for display

    // How much, which way. Quantity is always positive and in the base unit;
    // direction carries the sign.
    direction: { type: String, enum: DIRECTIONS, required: true },
    quantity: { type: Number, required: true, min: 0 },
    type: { type: String, enum: MOVEMENT_TYPES, required: true },

    // The source document / operation that caused it, and the transfer tie.
    // `id`/`reference` are the primary document (e.g. the PO); the optional
    // links below tie a supplier-return movement to its return / PO line /
    // replacement receipt so the ledger row is fully traceable without a join.
    source: {
      kind: { type: String, trim: true, default: "" }, // e.g. "issue", "transfer", "receipt", "supplier_return"
      id: { type: mongoose.Schema.Types.ObjectId, default: null },
      reference: { type: String, trim: true, default: "" },
      returnId: { type: mongoose.Schema.Types.ObjectId, default: null },
      poLineId: { type: mongoose.Schema.Types.ObjectId, default: null },
      receiptId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
    transferId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },

    // Who, when, why, and the idempotency identity of THIS movement.
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    note: { type: String, trim: true, default: "" },

    // The per-MOVEMENT idempotency key. For a single-movement operation this is
    // just the operation key. For a multi-line operation (e.g. two PO receipt
    // lines of the same variant into one location) each line derives its OWN
    // line-scoped key from the operation key + stable line identity + a
    // receipt/surplus discriminator — so the movements are distinct on the
    // EXISTING deployed unique index (which keys on idempotencyKey) without any
    // schema/index migration, and a replay derives the same keys and cannot
    // duplicate. See services/storePurchase/locationStock.service.js.
    idempotencyKey: { type: String, trim: true, default: "" },

    // The originating OPERATION key, kept for audit/recovery even when
    // idempotencyKey above has been narrowed to a single line. Not indexed and
    // not part of identity — purely so an operation's legs can be found again.
    operationKey: { type: String, trim: true, default: "" },

    // Applied is the only state a written row has — it is a fact, not a claim.
    // Retained so a later reader can filter on it explicitly.
    applied: { type: Boolean, default: true },
  },
  { timestamps: true, collection: "location_movements" },
);

// Balance derivation reads by item (+ variant) and by location.
locationMovementSchema.index({ companyId: 1, itemId: 1, variantId: 1 });
locationMovementSchema.index({ companyId: 1, warehouseId: 1, locationId: 1 });
// A marking's journey, and the movement history pages (newest first).
locationMovementSchema.index({ companyId: 1, barcodeId: 1 }, { partialFilterExpression: { barcodeId: { $type: "objectId" } } });
locationMovementSchema.index({ companyId: 1, createdAt: -1 });

// Defence-in-depth against a replayed operation writing a duplicate leg: one
// (type, location) per idempotency key. The withIdempotency middleware already
// prevents re-execution; this makes a duplicate physically impossible too.
//
// This is the EXISTING DEPLOYED index shape — {companyId, idempotencyKey, type,
// locationId}, deliberately UNCHANGED (no itemId/variantId column: adding them
// would be a migration a live database has not run). A multi-line operation
// stays safe within it because each line derives its OWN idempotencyKey (see
// the field comment + services/storePurchase/locationStock.service.js
// movementLineKey), so two lines never share the {idempotencyKey, type,
// location} tuple, and a replay reproduces the same keys and cannot duplicate.
locationMovementSchema.index(
  { companyId: 1, idempotencyKey: 1, type: 1, locationId: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string", $gt: "" } } },
);

module.exports =
  mongoose.models.LocationMovement ||
  mongoose.model("LocationMovement", locationMovementSchema);
module.exports.MOVEMENT_TYPES = MOVEMENT_TYPES;
module.exports.DIRECTIONS = DIRECTIONS;
