// models/DeviceHeartbeat.js
//
// One document per device, upserted on every heartbeat. This is what lets the
// dashboard tell "operator on break" from "device dead for an hour" — without
// it both look identical, i.e. zero scans.

const mongoose = require("mongoose");

/* ── A DEVICE PAIRED TO A FINISHING DASHBOARD (15 Oct 2026) ─────────────────
   The hand scanners are being re-purposed as remote inputs for the Ironing
   and Trimming dashboards (services/manufacturing/finishingStation.js). The
   pairing lives HERE, on the one-document-per-device record that already
   exists, because the cluster is at its collection cap and a pairing is a
   fact about a device. `stage` null means "not paired to any dashboard" —
   the device is (or was) a machine scanner, and nothing below applies. */
const stationOperatorSchema = new mongoose.Schema(
  {
    badge: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    userId: { type: String, trim: true, default: "" },
    known: { type: Boolean, default: false },
    signedInAt: { type: Date, default: null },
  },
  { _id: false },
);

const stationSessionSchema = new mongoose.Schema(
  {
    badge: { type: String, trim: true, default: "" },
    name: { type: String, trim: true, default: "" },
    userId: { type: String, trim: true, default: "" },
    signedInAt: { type: Date, default: null },
    signedOutAt: { type: Date, default: null },
  },
  { _id: false },
);

const stationSchema = new mongoose.Schema(
  {
    stage: { type: String, trim: true, default: null },
    companyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    /* A name the dashboard shows: "Ironing 2". Defaults to the device id. */
    name: { type: String, trim: true, default: "" },
    pairedAt: { type: Date, default: null },
    pairedBy: {
      type: new mongoose.Schema({ userId: String, name: String }, { _id: false }),
      default: null,
    },
    keyExpiresAt: { type: Date, default: null },
    operator: { type: stationOperatorSchema, default: null },
    sessionLog: { type: [stationSessionSchema], default: [] },
    lastScanAt: { type: Date, default: null },
    lastScanBarcode: { type: String, trim: true, default: "" },
    lastEventAt: { type: Date, default: null },
  },
  { _id: false },
);

const deviceHeartbeatSchema = new mongoose.Schema(
  {
    deviceId: { type: String, required: true, unique: true, trim: true },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      default: null,
    },
    machineName: { type: String, default: "" },

    firmwareVersion: { type: String, default: "" },
    ipAddress: { type: String, default: "" },
    wifiSSID: { type: String, default: "" },
    rssi: { type: Number, default: null },
    wifiChannel: { type: Number, default: null },

    // Un-acked events sitting in the device's local queue. A number that only
    // grows is the earliest signal that ingest is broken.
    queueDepth: { type: Number, default: 0 },
    queueHighWater: { type: Number, default: 0 },

    currentOperatorId: { type: String, default: null },
    activeOps: { type: [String], default: [] },
    onBreak: { type: Boolean, default: false },

    bootCount: { type: Number, default: null },
    uptimeSec: { type: Number, default: null },
    // Why the device last restarted: "power" (someone switched it on),
    // "loop-hang" (the watchdog caught a frozen main loop), "crash", etc.
    // Without this a hang and a power cycle are indistinguishable from here.
    resetReason: { type: String, default: "" },

    lastHeartbeatAt: { type: Date, default: Date.now },

    // Server-owned causal counter: the ingest route `$inc`s it on every
    // accepted heartbeat, atomically with the rest of the update. It is never
    // read from the device. Production machine-assignment sync compares it
    // with a baseline captured AFTER an assignment commits: only a strictly
    // greater revision can be evidence of the scanner's post-commit state —
    // timestamps cannot prove that ordering. Historical documents read as 0.
    evidenceRevision: { type: Number, default: 0, min: 0 },

    // The dashboard this device is a remote input for, if any. See above.
    station: { type: stationSchema, default: null },
  },
  { timestamps: true }
);

deviceHeartbeatSchema.index({ machineId: 1 });
deviceHeartbeatSchema.index({ lastHeartbeatAt: 1 });
deviceHeartbeatSchema.index({ "station.stage": 1, "station.companyId": 1 });

module.exports = mongoose.model("DeviceHeartbeat", deviceHeartbeatSchema);
module.exports.schema = deviceHeartbeatSchema;
