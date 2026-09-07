"use strict";
const mongoose = require("mongoose");

/**
 * A named place the business cares about on the field-tracking map — the
 * office, a warehouse, a customer's factory, a rep's home — as a circle.
 *
 * Added 6 Sep 2026 (field-tracking rebuild: "it is not representing any
 * strong thing or like any evidence or like proper logs"). A route line
 * says where a rep went; a zone says what that place IS, which is what turns
 * "stopped for 40 minutes at 20.30, 85.82" into "40 minutes at the office"
 * or "40 minutes at Sharma Textiles". Entry/exit and time-inside are derived
 * client-side from the pings (see components/sales/field-tracking/
 * fieldAnalytics.js `zoneEvents`), so this collection holds only the shapes.
 *
 * Circles, not polygons, on purpose: an owner draws one by clicking a spot
 * and typing a radius, which is the whole of what a garment business needs
 * to mark a campus, a market street or a factory gate. Polygons are more
 * precise and nobody would draw them.
 */
const fieldZoneSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // What kind of place — drives the colour and the wording ("at the
    // office" vs "at a customer").
    kind: { type: String, enum: ["office", "warehouse", "customer", "home", "other"], default: "other", index: true },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    radiusM: { type: Number, required: true, min: 20, max: 5000, default: 150 },
    // Free text: "gate 2", "ask for Priya", the account code…
    note: { type: String, default: "", trim: true, maxlength: 500 },
    // Optional link to the CRM account this place belongs to, when it is one.
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", default: null },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

module.exports = mongoose.model("FieldZone", fieldZoneSchema);
