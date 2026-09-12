// models/CMS_Models/Manufacturing/Production/ProductionTarget.js
//
// A production target: "this machine / this operator / this operation / this
// group of machines should produce N pieces between these two instants".
//
// THIS CONCEPT DID NOT EXIST BEFORE. machineIntelligenceRoutes.js:976-987 has
// been returning `target: { pieces: null, source: null, note: "No machine or
// shift target is stored anywhere in this system…" }` precisely because nothing
// stored one. This collection is what fills that seam.
//
// TWO RULES THIS SCHEMA EXISTS TO ENFORCE
//
// 1. THE TARGET IS THE ONLY MANUALLY ENTERED NUMBER. `targetPieces` is typed in
//    by a supervisor. The ACTUAL is never typed in — there is deliberately no
//    actualPieces field a person can write. Actuals are counted from
//    ProductionEvent scans by services/production/targetEvaluator.js, using
//    rollupStats.countDistinctPieces. A manually entered actual is forbidden by
//    the brief, and the way to make that stick is to give it nowhere to live.
//
// 2. HISTORY IS A RECORD, NOT A RECOMPUTATION. Once the window closes the
//    result is written into the `final*` block ONCE and never touched again.
//    Without that, a target that was missed in September would silently become
//    achieved the day someone re-ingested a device's backlog, and the history
//    screen would disagree with what the floor was told at the time. The
//    settling itself happens lazily on read — see the evaluator.
//
// SCOPE — and the honest limit on "line"
// There is NO line / section / department entity anywhere in this database.
// Machine carries only `type` and `location`, both free-text strings a person
// types, with no registry for location and no history on either. So a "line"
// target is stored as `scope: "group"` plus an explicit declaration of HOW the
// machine set is decided (`group.kind`), and every read surfaces that
// declaration. A target must be able to say "these 12 machines, because their
// Machine.location reads LINE 1" rather than pretending a line exists.

const mongoose = require("mongoose");

const TARGET_SCOPES = ["machine", "operator", "operation", "group", "shift"];

// The five states the floor speaks in. Kept here, beside the stored
// `finalStatus`, so the enum that validates history and the enum the evaluator
// computes live can never be two different lists.
const TARGET_STATES = [
  "not_started",
  "on_track",
  "behind",
  "achieved",
  "exceeded",
];

const TARGET_STATUS = ["active", "cancelled"];

// How a group target decides which machines it covers.
//   machineList  — an explicit list of machine ids, frozen at creation
//   machineType  — every Machine whose `type` matches, resolved at query time
//   location     — every Machine whose `location` matches, resolved at query time
const GROUP_KINDS = ["machineList", "machineType", "location"];

const GroupScopeSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: GROUP_KINDS, required: true },

    // Only one of these carries meaning, depending on `kind`.
    machineType: { type: String, default: "", trim: true },
    location: { type: String, default: "", trim: true },
    machineIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Machine" }],

    // The set as it stood when the target was created, ALWAYS written whatever
    // the kind. Machine.type and Machine.location are mutable free strings with
    // no history: a machine moved to another line next week would silently
    // change what a machineType/location target ever meant. Storing the
    // resolved set lets a reader see the drift instead of inheriting it.
    resolvedMachineIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "Machine" }],
    resolvedAt: { type: Date, default: null },

    // A sentence naming the grouping, shown on screen verbatim. e.g.
    // "12 machines whose Machine.location reads 'LINE NO: 01'".
    resolvedNote: { type: String, default: "" },
  },
  { _id: false }
);

const ProductionTargetSchema = new mongoose.Schema(
  {
    scope: { type: String, enum: TARGET_SCOPES, required: true },

    // ── The ids the scope applies to ────────────────────────────────────────
    // ProductionEvent.machineId is an ObjectId, so this is one too — a string
    // here matches nothing and the actual would silently read zero.
    machineId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Machine",
      default: null,
    },
    // Denormalised label. 26 of the 78 placed machines already point at
    // machines deleted from the register; a history row must still be able to
    // say which machine it was about.
    machineName: { type: String, default: "" },

    // ProductionEvent.operatorId is a plain STRING badge id, and the badge may
    // physically carry EITHER Employee.identityId or Employee.biometricId —
    // they differ by real characters (GR045 vs GR0045). Both are stored, and
    // the evaluator matches on the set, or an operator target under-counts to
    // zero for no visible reason.
    operatorId: { type: String, default: "", trim: true },
    operatorIds: { type: [String], default: [] },
    operatorName: { type: String, default: "" },

    // Joined to ProductionEvent.activeOps by EXACT string. Operation.operationCode
    // is neither unique nor uppercased and event activeOps are only trimmed at
    // ingest, so the match is case-sensitive in both directions.
    operationCode: { type: String, default: "", trim: true },
    operationName: { type: String, default: "" },

    group: { type: GroupScopeSchema, default: null },

    // ── The target itself ───────────────────────────────────────────────────
    // The one number a human types. Distinct garments, not scan events.
    targetPieces: { type: Number, required: true, min: 1 },

    // Real instants, not HH:MM strings — the route parses a wall-clock time
    // against the IST shift day before it ever reaches here.
    windowStart: { type: Date, required: true },
    windowEnd: { type: Date, required: true },

    // The IST-bucketed shift day, from shiftDateFor(). NEVER setHours(0,0,0,0):
    // the process timezone would move the bucket 5h30m and every actual query
    // would miss its documents. Also the index prefix every scan query needs.
    shiftDate: { type: Date, required: true },

    // ── Who assigned it ─────────────────────────────────────────────────────
    assignedBy: { type: String, default: "" },
    assignedByName: { type: String, default: "" },
    assignedAt: { type: Date, default: Date.now },
    note: { type: String, default: "", trim: true },

    // ── Active / cancelled ──────────────────────────────────────────────────
    // Cancelling never deletes. A target that was on the floor for three hours
    // happened, and the history has to be able to say so.
    status: { type: String, enum: TARGET_STATUS, default: "active" },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: "" },
    cancelReason: { type: String, default: "" },

    // ── The settled result — WRITTEN ONCE, NEVER RECOMPUTED ─────────────────
    // Every one of these is null until the window closes (or the target is
    // cancelled). After that they are frozen: the read path returns these
    // stored values rather than re-running the count, so a late-arriving scan
    // cannot rewrite what the floor was told at the time.
    settledAt: { type: Date, default: null },
    settledReason: {
      type: String,
      enum: ["window_closed", "cancelled", null],
      default: null,
    },
    finalActualPieces: { type: Number, default: null },
    finalAchievementPercent: { type: Number, default: null },
    finalStatus: { type: String, enum: [...TARGET_STATES, null], default: null },

    // The instant the Nth distinct piece was scanned, from the scan stream —
    // not "when we noticed". null means the target was never reached.
    achievedAt: { type: Date, default: null },
    // achievedAt exists AND fell inside the window. Null when never achieved,
    // so the history column can read "—" rather than a misleading false.
    completedOnTime: { type: Boolean, default: null },

    // How the actual was counted, in a sentence — which machines the group
    // resolved to, whether operator attribution was reliable, and so on. Stored
    // with the result because the caveat belongs to the figure, not to a
    // warning list somewhere else on the page.
    settledBasis: { type: String, default: "" },
    // Scan-stream honesty counters, frozen with the rest.
    settledScanEvents: { type: Number, default: null },
    settledTimeRecoveredScans: { type: Number, default: null },
  },
  { timestamps: true }
);

/* Indexes, one per query the routes actually run.

   The list/floor queries all lead with shiftDate because that is how the floor
   thinks and because a target is created for a day. `windowEnd + settledAt` is
   the settling sweep's index: "closed windows that were never written down".   */
ProductionTargetSchema.index({ shiftDate: 1, status: 1 });
ProductionTargetSchema.index({ shiftDate: 1, scope: 1, status: 1 });
ProductionTargetSchema.index({ windowEnd: 1, settledAt: 1 });
ProductionTargetSchema.index({ machineId: 1, shiftDate: 1 });
ProductionTargetSchema.index({ operatorIds: 1, shiftDate: 1 });
ProductionTargetSchema.index({ operationCode: 1, shiftDate: 1 });
// History is read newest-settled-first.
ProductionTargetSchema.index({ settledAt: -1 });

module.exports = mongoose.model("ProductionTarget", ProductionTargetSchema);
module.exports.schema = ProductionTargetSchema;
module.exports.TARGET_SCOPES = TARGET_SCOPES;
module.exports.TARGET_STATES = TARGET_STATES;
module.exports.TARGET_STATUS = TARGET_STATUS;
module.exports.GROUP_KINDS = GROUP_KINDS;
