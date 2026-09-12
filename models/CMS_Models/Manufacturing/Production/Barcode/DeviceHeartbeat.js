// models/DeviceHeartbeat.js
//
// One document per device, upserted on every heartbeat. This is what lets the
// dashboard tell "operator on break" from "device dead for an hour" — without
// it both look identical, i.e. zero scans.

const mongoose = require("mongoose");

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
  },
  { timestamps: true }
);

deviceHeartbeatSchema.index({ machineId: 1 });
deviceHeartbeatSchema.index({ lastHeartbeatAt: 1 });

module.exports = mongoose.model("DeviceHeartbeat", deviceHeartbeatSchema);
module.exports.schema = deviceHeartbeatSchema;
