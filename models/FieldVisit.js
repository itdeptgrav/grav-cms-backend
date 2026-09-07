"use strict";
const mongoose = require("mongoose");

/**
 * A STOP on a field route that somebody has confirmed as a visit — who was
 * visited, what came of it, and any remark.
 *
 * Added 6 Sep 2026 (field-tracking rebuild). The map derives stops from the
 * GPS fixes: "stayed 38 minutes within 60 m of this spot". That is evidence
 * that the rep was THERE; it is not evidence of WHY. This row is the why —
 * an owner or the rep tags the stop with the customer and the outcome, and
 * from then on the route reads as a day's work rather than a day's driving:
 *
 *     11:05–11:43  Sharma Textiles — met, order taken, "wants 400 pcs by Oct"
 *
 * Keyed on (sessionId, stopFrom): a stop is identified by the session it
 * belongs to and the timestamp of the fix that opened it, which is stable
 * for as long as the pings are. Re-tagging the same stop updates the row
 * rather than adding a second.
 *
 * `lat`/`lng`/`customerName` are snapshotted here so the visit still reads
 * correctly if the CRM account is later renamed or removed, and so past
 * visits can be matched against new stops by distance ("you have tagged this
 * spot as Sharma Textiles before") without a CRM lookup — the CRM's own
 * address records carry no coordinates today (0 of 0 in the live database),
 * so this collection IS the business's map of where its customers are, built
 * one confirmed visit at a time.
 */
const fieldVisitSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    employeeId: { type: String, default: "", index: true },
    stopFrom: { type: Number, required: true }, // epoch ms of the fix that opened the stop
    stopTo: { type: Number, default: null },
    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    placeName: { type: String, default: "", trim: true },

    customerName: { type: String, default: "", trim: true, maxlength: 200 },
    accountId: { type: mongoose.Schema.Types.ObjectId, ref: "CRMAccount", default: null },
    leadId: { type: mongoose.Schema.Types.ObjectId, ref: "Lead", default: null },

    // What came of it. `not_visit` is the honest option for a stop that was
    // lunch, fuel or traffic — recorded so it stops being asked about.
    outcome: {
      type: String,
      enum: ["met", "not_met", "order", "follow_up", "delivery", "collection", "not_visit", "other"],
      default: "met",
    },
    note: { type: String, default: "", trim: true, maxlength: 1000 },

    taggedBy: { type: String, default: "", trim: true },
  },
  { timestamps: true },
);

fieldVisitSchema.index({ sessionId: 1, stopFrom: 1 }, { unique: true });
fieldVisitSchema.index({ employeeId: 1, stopFrom: -1 });

module.exports = mongoose.model("FieldVisit", fieldVisitSchema);
