// models/ProductionEvent.js
//
// SOURCE OF TRUTH. Append-only. Never updated,
// never deleted. Every read model in this service is regenerated from these
// documents, so a bug in a rollup costs a re-run, never data.

const mongoose = require("mongoose");

const EVENT_TYPES = [
  "signin",
  "signout",
  "scan",
  "break_start",
  "break_end",
  "ops_change",
];

const productionEventSchema = new mongoose.Schema(
  {
    // Device-generated: deviceId-bootCount-seq. Deterministic across retries,
    // which is what makes at-least-once delivery safe — a resend collides with
    // the unique index instead of double-counting a piece.
    eventId: { type: String, required: true, unique: true, trim: true },

    type: { type: String, required: true, enum: EVENT_TYPES },

    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    deviceId: { type: String, default: "", trim: true },

    operatorId: { type: String, default: "", trim: true },
    // Hint only. The rollup re-resolves the real name from Employee — the
    // device has never known it and must not be trusted as the authority.
    operatorName: { type: String, default: "" },

    barcodeId: { type: String, default: "", trim: true },
    workOrderKey: { type: String, default: null },
    unitNumber: { type: Number, default: null },

    // Operation codes active on the machine AT SCAN TIME. A snapshot, not a
    // live lookup — if the assignment changes mid-shift, historical scans must
    // still reflect what was actually running when they happened.
    activeOps: { type: [String], default: [] },

    scanTime: { type: Date, required: true },
    receivedAt: { type: Date, default: Date.now },
    // True when the device clock was unset at scan time and scanTime was
    // reconstructed from elapsed millis after NTP came back.
    timeRecovered: { type: Boolean, default: false },

    shiftDate: { type: Date, required: true },

    // break_start / break_end payload
    breakReason: { type: String, default: null },
    breakDurationSec: { type: Number, default: null },

    // ops_change payload and anything else the device wants to record
    meta: { type: mongoose.Schema.Types.Mixed, default: null },

    // syncedToAtlas / syncedToHosted are gone. They tracked replication to a
    // second database; the CMS now reads this one, so an event is delivered the
    // moment it is inserted and there is no state in between to record.
    //
    // The fields are left on EXISTING documents rather than stripped out —
    // rewriting history to delete a flag would be a worse trade than carrying a
    // dead boolean on rows written before the change.
  },
  { timestamps: false, minimize: false }
);

productionEventSchema.index({ shiftDate: 1, machineId: 1, scanTime: 1 });
productionEventSchema.index({ shiftDate: 1, operatorId: 1, scanTime: 1 });
productionEventSchema.index({ workOrderKey: 1, unitNumber: 1 });

// Indexes are created explicitly at boot by
// services/barcodeScanner/ensureIndexes.js rather than relied on from
// autoIndex: connectDB() turns autoIndex OFF in production, and the unique
// eventId above is not a nicety — it is the single thing that makes a device's
// at-least-once retry idempotent instead of double-counting a garment.
module.exports = mongoose.model("ProductionEvent", productionEventSchema);
module.exports.schema = productionEventSchema;
module.exports.EVENT_TYPES = EVENT_TYPES;
