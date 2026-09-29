// models/CMS_Models/Inventory/Operations/StockReservation.js
//
// STOCK RESERVATION (V1) — the durable operational record that holds usable stock
// against ONE approved material demand (an MRF line) BEFORE it is issued. It is a
// live operational record, NOT an inventory movement: creating or releasing a
// reservation never changes company on-hand or LocationBalance — it only records
// that a quantity at chosen usable locations is spoken for.
//
// One MRF line cannot hold two ACTIVE reservations (the `active` partial-unique
// index below), so a retried reserve on the same line updates the one record
// rather than creating a second. Every quantity is frozen in BOTH the requester's
// business unit AND the catalogue base unit, with the conversion factor — nothing
// is stored unitless and nothing is compared across unlike units.

"use strict";

const mongoose = require("mongoose");

// One chosen usable location this reservation draws from. A demand line may be
// spread across several locations.
const allocationSchema = new mongoose.Schema(
  {
    warehouseId: { type: mongoose.Schema.Types.ObjectId, required: true },
    warehouseName: { type: String, trim: true, default: "" },
    warehouseShortName: { type: String, trim: true, default: "" },
    locationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    locationCode: { type: String, trim: true, default: "" },
    locationName: { type: String, trim: true, default: "" },
    // Business unit and its frozen base-unit conversion.
    reservedQty: { type: Number, required: true, min: 0 },      // business unit
    reservedBaseQty: { type: Number, required: true, min: 0 },  // base unit
    // Consumed / released from THIS allocation (business unit), so the live
    // active reserved at a location = reservedQty − issuedQty − releasedQty.
    issuedQty: { type: Number, min: 0, default: 0 },
    releasedQty: { type: Number, min: 0, default: 0 },
  },
  { _id: true },
);

const historyEntrySchema = new mongoose.Schema(
  {
    action: { type: String, enum: ["RESERVE", "PICK", "ISSUE", "RELEASE", "CANCEL", "SUBSTITUTION_BLOCKED"], required: true },
    qty: { type: Number, default: 0 },            // business unit
    baseQty: { type: Number, default: 0 },        // base unit
    at: { type: Date, default: Date.now },
    byId: { type: mongoose.Schema.Types.ObjectId, default: null },
    byName: { type: String, trim: true, default: "" },
    reason: { type: String, trim: true, default: "" },
    // Which locations the action touched (snapshot, code + qty), for the audit trail.
    allocations: [{ locationCode: String, qty: Number, baseQty: Number }],
  },
  { _id: true },
);

const stockReservationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // ── Which approved demand reserved the stock (stable source identity) ──
    mrfId: { type: mongoose.Schema.Types.ObjectId, ref: "MRF", required: true },
    mrfNumber: { type: String, trim: true, default: "" },
    mrfLineId: { type: mongoose.Schema.Types.ObjectId, required: true },   // the MRF item _id
    requestedForName: { type: String, trim: true, default: "" },
    requestedForDept: { type: String, trim: true, default: "" },
    neededBy: { type: Date, default: null },

    // ── Item / variant identity (physical stock item) ──
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String, trim: true }],
    itemName: { type: String, trim: true, default: "" },
    sku: { type: String, trim: true, default: "" },

    // ── Requested quantity + frozen conversion evidence ──
    unit: { type: String, trim: true, required: true },        // requester's business unit
    requestedQty: { type: Number, required: true, min: 0 },    // business unit
    baseUnit: { type: String, trim: true, default: "" },       // catalogue base unit
    conversionFactor: { type: Number, default: 1 },            // base per business unit
    requestedBaseQty: { type: Number, min: 0, default: 0 },    // base unit

    allocations: { type: [allocationSchema], default: [] },

    // ── Roll-ups (business unit; base kept alongside) ──
    reservedQty: { type: Number, min: 0, default: 0 },
    reservedBaseQty: { type: Number, min: 0, default: 0 },
    pickedQty: { type: Number, min: 0, default: 0 },           // gathered, held — NOT a stock move
    issuedQty: { type: Number, min: 0, default: 0 },
    issuedBaseQty: { type: Number, min: 0, default: 0 },
    releasedQty: { type: Number, min: 0, default: 0 },
    releasedBaseQty: { type: Number, min: 0, default: 0 },
    // The shortfall that could NOT be reserved (requested − reserved), in business unit.
    backorderedQty: { type: Number, min: 0, default: 0 },

    // ── Status ──
    // PARTIALLY_RESERVED / RESERVED (full) / PARTIALLY_ISSUED / ISSUED /
    // PARTIALLY_RELEASED / RELEASED / CANCELLED. `active` drives the one-active-
    // reservation-per-line partial-unique index and flips false on full
    // release/cancel so the line can be reserved afresh.
    status: {
      type: String,
      enum: ["PARTIALLY_RESERVED", "RESERVED", "PARTIALLY_ISSUED", "ISSUED", "PARTIALLY_RELEASED", "RELEASED", "CANCELLED"],
      default: "PARTIALLY_RESERVED",
    },
    active: { type: Boolean, default: true },

    reason: { type: String, trim: true, default: "" },
    reservedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reservedByName: { type: String, trim: true, default: "" },
    reservedAt: { type: Date, default: Date.now },
    releasedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    releasedByName: { type: String, trim: true, default: "" },
    releasedAt: { type: Date, default: null },

    idempotencyKey: { type: String, trim: true, default: "" },
    history: { type: [historyEntrySchema], default: [] },
  },
  { timestamps: true },
);

// The company-scoped queue reads.
stockReservationSchema.index({ companyId: 1, status: 1, updatedAt: -1 });
stockReservationSchema.index({ companyId: 1, mrfId: 1 });
stockReservationSchema.index({ companyId: 1, rawItemId: 1, variantId: 1 });
// ONE active reservation per MRF line — a retry updates it, never duplicates.
stockReservationSchema.index(
  { companyId: 1, mrfLineId: 1 },
  { unique: true, partialFilterExpression: { active: true } },
);

module.exports = mongoose.models.StockReservation
  || mongoose.model("StockReservation", stockReservationSchema);
