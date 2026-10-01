// models/CMS_Models/Inventory/Operations/LocationReservation.js
//
// LOCATION RESERVATION (V1) — a small per-(company,item,variant,location)
// operational projection used ONLY to make reserving concurrency-safe. It holds
// the BASE-unit quantity currently reserved at that location. A single atomic
// guarded increment refuses a reservation that would push `reserved` past the
// location's on-hand (read from LocationBalance in the same unit of work).
//
// It is NOT a stock authority and it is NOT a movement: reserving never changes
// LocationBalance or company on-hand. It is fully rebuildable from the immutable
// StockReservation allocations (Σ active reserved − issued − released, in base
// units). Because reserve AND issue both contend on THIS one document inside
// their transactions, it is the serialization point that stops two users from
// reserving the same last stock.

"use strict";

const mongoose = require("mongoose");

const locationReservationSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, required: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, required: true },

    // BASE-unit quantity reserved at this location (never the business unit — a
    // reservation projection is never totalled across unlike units).
    reserved: { type: Number, required: true, min: 0, default: 0 },
  },
  { timestamps: true },
);

// One row per (company, item, variant, location) — the atomic guard target.
locationReservationSchema.index(
  { companyId: 1, itemId: 1, variantId: 1, warehouseId: 1, locationId: 1 },
  { unique: true },
);

module.exports = mongoose.models.LocationReservation
  || mongoose.model("LocationReservation", locationReservationSchema);
