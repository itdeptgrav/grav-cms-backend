"use strict";
const mongoose = require("mongoose");

/**
 * One GPS fix inside a field-tracking duty (see FieldTrackingSession). The app
 * buffers these on-device and uploads them in batches, so they arrive in bursts
 * and can be re-sent after a signal outage — the unique {sessionId,timestamp}
 * index makes a re-send idempotent instead of duplicating the route.
 */
const fieldLocationPingSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, index: true },
    employeeId: { type: String, default: "", index: true },

    lat: { type: Number, required: true },
    lng: { type: Number, required: true },
    accuracy: { type: Number, default: 0 }, // metres
    speed: { type: Number, default: 0 }, // m/s
    bearing: { type: Number, default: 0 }, // degrees
    timestamp: { type: Number, required: true }, // epoch millis (device)

    // Running distance (metres) for the session up to this point, as computed
    // on the device — trusted so the CMS doesn't have to re-walk the polyline.
    cumulativeDistance: { type: Number, default: 0 },

    source: { type: String, default: "gravemployeetracker" },
  },
  { timestamps: true },
);

// Idempotent re-send: the same fix (same session + device timestamp) is a no-op.
fieldLocationPingSchema.index({ sessionId: 1, timestamp: 1 }, { unique: true });
fieldLocationPingSchema.index({ employeeId: 1, timestamp: -1 });

module.exports = mongoose.model("FieldLocationPing", fieldLocationPingSchema);
