// models/MachineDayStats.js
//
// GENERATED. Written only by jobs/rollupStats.js, full overwrite each cycle.
// Never written by an API handler. Supervisor dashboard reads this.

const mongoose = require("mongoose");

const byOperationSchema = new mongoose.Schema(
  {
    operationCode: { type: String, required: true },
    pieces: { type: Number, default: 0 },
    avgSecondsPerPiece: { type: Number, default: null },
    minSecondsPerPiece: { type: Number, default: null },
    maxSecondsPerPiece: { type: Number, default: null },
    // Reserved. SMV is not in use yet — these stay null until a standards
    // source is wired in, at which point it is a rollup change with no
    // migration because the fields already exist.
    smvSeconds: { type: Number, default: null },
    efficiencyPercent: { type: Number, default: null },
  },
  { _id: false }
);

const operatorSpanSchema = new mongoose.Schema(
  {
    operatorId: { type: String, required: true },
    operatorName: { type: String, default: "" },
    signInTime: { type: Date, default: null },
    signOutTime: { type: Date, default: null },
    pieces: { type: Number, default: 0 },
  },
  { _id: false }
);

const machineDayStatsSchema = new mongoose.Schema(
  {
    shiftDate: { type: Date, required: true },
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      required: true,
    },
    machineName: { type: String, default: "" },
    deviceId: { type: String, default: "" },

    currentOperatorId: { type: String, default: null },
    currentOperatorName: { type: String, default: null },
    currentOps: { type: [String], default: [] },

    totalPieces: { type: Number, default: 0 },
    piecesThisHour: { type: Number, default: 0 },
    suppressedRescans: { type: Number, default: 0 },
    unparseableBarcodes: { type: Number, default: 0 },

    byOperation: { type: [byOperationSchema], default: [] },

    lastScanAt: { type: Date, default: null },
    lastHeartbeatAt: { type: Date, default: null },

    status: {
      type: String,
      enum: ["producing", "idle", "no_operator", "device_offline", "on_break"],
      default: "no_operator",
    },

    operators: { type: [operatorSpanSchema], default: [] },

    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

machineDayStatsSchema.index({ shiftDate: 1, machineId: 1 }, { unique: true });
machineDayStatsSchema.index({ shiftDate: 1, status: 1 });

module.exports = mongoose.model("MachineDayStats", machineDayStatsSchema);
module.exports.schema = machineDayStatsSchema;
