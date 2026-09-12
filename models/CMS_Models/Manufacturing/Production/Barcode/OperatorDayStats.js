// models/OperatorDayStats.js
//
// GENERATED. Written only by jobs/rollupStats.js, full overwrite each cycle.
// Payroll / pace reporting reads this.

const mongoose = require("mongoose");

const byOperationSchema = new mongoose.Schema(
  {
    operationCode: { type: String, required: true },
    pieces: { type: Number, default: 0 },
    avgSecondsPerPiece: { type: Number, default: null },
    minSecondsPerPiece: { type: Number, default: null },
    maxSecondsPerPiece: { type: Number, default: null },
    // Reserved — see MachineDayStats. Null until SMV is introduced.
    smvSeconds: { type: Number, default: null },
    efficiencyPercent: { type: Number, default: null },
  },
  { _id: false }
);

const machineWorkedSchema = new mongoose.Schema(
  {
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String, default: "" },
    pieces: { type: Number, default: 0 },
  },
  { _id: false }
);

const operatorDayStatsSchema = new mongoose.Schema(
  {
    shiftDate: { type: Date, required: true },
    operatorId: { type: String, required: true },
    operatorName: { type: String, default: "" },
    // True when no Employee document matched this identityId. The scans still
    // count — the rollup surfaces the mismatch rather than hiding the pieces.
    unknownOperator: { type: Boolean, default: false },

    totalPieces: { type: Number, default: 0 },

    minutesLoggedIn: { type: Number, default: 0 },
    productiveMinutes: { type: Number, default: 0 },
    idleMinutes: { type: Number, default: 0 },
    breakMinutes: { type: Number, default: 0 },

    // Reserved. Meaningless without a target time, so left null while SMV is
    // out of scope. Pace lives in byOperation.avgSecondsPerPiece instead.
    overallEfficiencyPercent: { type: Number, default: null },

    byOperation: { type: [byOperationSchema], default: [] },
    machinesWorked: { type: [machineWorkedSchema], default: [] },

    firstSignIn: { type: Date, default: null },
    lastSignOut: { type: Date, default: null },

    updatedAt: { type: Date, default: Date.now },
  },
  { minimize: false }
);

operatorDayStatsSchema.index({ shiftDate: 1, operatorId: 1 }, { unique: true });

module.exports = mongoose.model("OperatorDayStats", operatorDayStatsSchema);
module.exports.schema = operatorDayStatsSchema;
