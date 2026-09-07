"use strict";
const mongoose = require("mongoose");

/**
 * One "duty" of an employee's field tracking, synced from the Grav Employee
 * Tracker Android app. A session is opened when the salesperson taps "Start
 * duty" and closed when they end it; the individual GPS fixes live in
 * FieldLocationPing, keyed by the same `sessionId` (a device-generated UUID).
 *
 * Additive feature — completely independent of CallEvent / CallRecording.
 */
const fieldTrackingSessionSchema = new mongoose.Schema(
  {
    // Device-generated UUID; the join key to FieldLocationPing.
    sessionId: { type: String, required: true, unique: true, index: true },

    // Who / which device. `employeeId` is the biometric id (e.g. "GR0067")
    // the salesperson set once on their phone; may be blank if unconfigured.
    employeeId: { type: String, default: "", index: true },
    employeeName: { type: String, default: "" },
    deviceId: { type: String, default: "" },

    startTime: { type: Number }, // epoch millis (device)
    endTime: { type: Number, default: null }, // null while the duty is still on
    active: { type: Boolean, default: true, index: true },

    totalDistanceMeters: { type: Number, default: 0 },
    pointCount: { type: Number, default: 0 },

    // Denormalised last-known position, so the "live" map and the session list
    // don't have to read the pings collection.
    lastLat: { type: Number, default: null },
    lastLng: { type: Number, default: null },
    lastPingAt: { type: Date, default: null },
    // The rest of the newest fix, so the CMS's live poll can draw a heading
    // badge and print speed/accuracy on a rep's card without a socket push
    // (6 Sep 2026). Null on rows written before these existed.
    lastSpeed: { type: Number, default: null }, // m/s
    lastBearing: { type: Number, default: null }, // degrees
    lastAccuracy: { type: Number, default: null }, // metres

    // Human place names (free reverse geocoding via OpenStreetMap Nominatim),
    // filled asynchronously so the CMS can show "where" without every row
    // hitting the geocoder itself.
    startPlaceName: { type: String, default: "" },
    lastPlaceName: { type: String, default: "" },

    // A supervisor's remark on the day — "approved", "asked about the 2h gap",
    // "rep says phone died" — written from the CMS, never by the device
    // (6 Sep 2026). Kept on the session so it travels with the route in
    // every report and export.
    notes: { type: String, default: "", trim: true, maxlength: 2000 },
    notesUpdatedAt: { type: Date, default: null },
    notesUpdatedBy: { type: String, default: "", trim: true },

    source: { type: String, default: "gravemployeetracker" },
  },
  { timestamps: true },
);

fieldTrackingSessionSchema.index({ employeeId: 1, startTime: -1 });
fieldTrackingSessionSchema.index({ active: 1, lastPingAt: -1 });

module.exports = mongoose.model("FieldTrackingSession", fieldTrackingSessionSchema);
