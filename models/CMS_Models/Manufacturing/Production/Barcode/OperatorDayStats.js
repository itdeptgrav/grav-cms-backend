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
    /* THE WORKING BEHIND efficiencyPercent, and it has to be DECLARED to
       survive. The rollup computes earned and available minutes and writes
       them, but mongoose runs strict by default: a field the schema does not
       know about is silently dropped on save. So the drawer read
       op.earnedMinutes, got undefined, and reported "no standard time set" for
       a machine whose operations both have a SAM on file — the number had been
       computed correctly and thrown away between the rollup and the disk.

       earnedMinutes  = garments at this operation x its standard time
       availableMinutes = the machine's manned time less recorded breaks,
                          identical on every row because attended time cannot be
                          split between operations that ran at once */
    earnedMinutes: { type: Number, default: null },
    availableMinutes: { type: Number, default: null },
    /* The true cycle (attended time / garments), as opposed to
       avgSecondsPerPiece above, which is the pace with idle gaps removed. */
    observedCycleSeconds: { type: Number, default: null },
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
    /* The two numbers overallEfficiencyPercent is made of, kept so a reader can
       see WHY it is what it is — and, as with the byOperation fields above,
       declared because mongoose strict would otherwise drop them on write.
           overall = earnedMinutes / availableMinutes x 100
       unratedOperations counts operations this person ran that have no SAM in
       the registry: they earn nothing, so a high count means the figure covers
       less of their shift than it appears to. */
    earnedMinutes: { type: Number, default: null },
    availableMinutes: { type: Number, default: null },
    unratedOperations: { type: Number, default: 0 },
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
