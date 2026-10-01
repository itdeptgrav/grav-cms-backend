// models/CMS_Models/Inventory/Operations/StockCount.js
//
// Warehouse Stock Count V1 — a cycle-count SESSION and its immutable evidence.
//
// ── WHAT THIS IS, AND WHAT IT IS NOT ────────────────────────────────────────
// A count is a review workflow, not a second stock authority. It FREEZES what
// the location was expected to hold at a server instant, records what a person
// physically found, and — on posting — turns each reviewed non-zero variance
// into ONE ordinary stock correction through the canonical operation every
// other Store writer already uses (RawItem on-hand + its stockTransactions,
// paired with the immutable LocationMovement ledger). Nothing here holds a
// balance of its own: `expectedQty` is a snapshot, `countedQty` is evidence,
// and the only figure that ever becomes real is applied elsewhere.
//
// ── WHY THE EXPECTED QUANTITY IS FROZEN ─────────────────────────────────────
// The whole point of a count is to compare the shelf against a fixed claim. If
// "expected" were re-read at review or post time it would chase the very
// movements the count exists to catch, and a discrepancy could vanish because
// something else moved the stock while the counter was walking the aisle. So
// `expectedQty` is written once, at start, and never recomputed. A balance that
// has moved since is surfaced as a CONFLICT at post time (below), never
// silently absorbed into the correction.
//
// ── WHY A POSTED COUNT IS IMMUTABLE ─────────────────────────────────────────
// Once posted it is the evidence behind real stock movements that can never be
// edited or deleted. Editing the session after the fact would make the evidence
// disagree with the ledger it produced, so the session refuses every change and
// every delete after POSTED — a correction is a NEW count, not an edit.

const mongoose = require("mongoose");

const MODES = Object.freeze(["NORMAL", "BLIND"]);
const STATUSES = Object.freeze(["DRAFT", "IN_PROGRESS", "REVIEWED", "POSTED", "CANCELLED"]);

// The states a NEW movement can still be recorded against — everything that is
// not a terminal outcome.
const OPEN_STATUSES = Object.freeze(["DRAFT", "IN_PROGRESS", "REVIEWED"]);

/* One counted row. It carries the frozen expectation, the physical entry, and
   — kept separate on purpose — whether a number was entered at all. A row that
   was never visited (`counted:false`) is NOT a recorded zero: treating "did not
   count" as "found none" is exactly how a cycle count wipes real stock. */
const stockCountLineSchema = new mongoose.Schema(
  {
    rawItemId: { type: mongoose.Schema.Types.ObjectId, ref: "RawItem", required: true },
    rawItemName: { type: String, trim: true, default: "" },
    rawItemSku: { type: String, trim: true, default: "" },

    /* Null = the whole-item scope. A variant is its OWN row and is counted
       separately — a whole-item count and a variant count are different facts
       and never share a line. */
    variantId: { type: mongoose.Schema.Types.ObjectId, default: null },
    variantCombination: [{ type: String }],
    variantSku: { type: String, trim: true, default: "" },

    /* The item's base unit. A count never mixes units — a review that summed
       kilograms and pieces would be summing nonsense, so quantities stay in
       this unit and totals are grouped by it. */
    baseUnit: { type: String, trim: true, default: "" },

    /* Frozen at start from the location's on-hand for this scope. Never
       recomputed — see the file header. */
    expectedQty: { type: Number, required: true, default: 0 },

    /* TRUE when the line was ADDED during counting (stock found that the
       snapshot did not list), rather than frozen from the opening snapshot. The
       audit record must tell the two apart: an added line's expected 0 is a
       decision a counter made at the shelf, not a company balance. Its
       expectedQty is still frozen at the instant it was added, so conflict
       detection works identically. */
    addedDuringCount: { type: Boolean, default: false },
    addedAt: { type: Date, default: null },

    /* The physical figure, and whether it was entered. `countedQty` stays null
       until `counted` is true; a genuine recorded zero is `counted:true,
       countedQty:0`, which is a real variance against a positive expectation
       and NOT the same as a row nobody reached. */
    counted: { type: Boolean, default: false },
    countedQty: { type: Number, default: null },

    /* Required for a non-zero variance at review. The reason is audit evidence
       — a correction with no stated cause is a number nobody can defend. */
    varianceReason: { type: String, trim: true, default: "" },

    /* Set at posting, per line that actually moved stock. Preserves the before
       and after so the outcome screen reports real figures, not a client
       recomputation. A zero-variance row never gets one. */
    posted: {
      applied: { type: Boolean, default: false },
      direction: { type: String, enum: ["in", "out", null], default: null },
      quantity: { type: Number, default: null },
      companyBefore: { type: Number, default: null },
      companyAfter: { type: Number, default: null },
      locationBefore: { type: Number, default: null },
      locationAfter: { type: Number, default: null },
      movementId: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
  },
  { _id: true },
);

const stockCountSchema = new mongoose.Schema(
  {
    // ── Tenancy — server-owned, never from the body ──────────────────────────
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company", required: true, index: true },
    siteId: { type: mongoose.Schema.Types.ObjectId, default: null },

    // Human-readable, sequential per company. Unique so a race cannot mint two.
    countNumber: { type: String, trim: true, required: true },
    seq: { type: Number, required: true },

    // ── Where ────────────────────────────────────────────────────────────────
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: "Warehouse", required: true },
    locationId: { type: mongoose.Schema.Types.ObjectId, required: true },
    warehouseName: { type: String, trim: true, default: "" },
    warehouseShortName: { type: String, trim: true, default: "" },
    locationCode: { type: String, trim: true, default: "" },
    locationName: { type: String, trim: true, default: "" },

    mode: { type: String, enum: MODES, default: "NORMAL" },
    status: { type: String, enum: STATUSES, default: "DRAFT", index: true },

    // What scoped the snapshot, recorded so a reader knows the count was of a
    // filtered subset and not the whole location.
    filter: {
      search: { type: String, trim: true, default: "" },
      category: { type: String, trim: true, default: "" },
    },

    // The server instant the expected quantities were frozen.
    snapshotAt: { type: Date, required: true, default: Date.now },

    lines: [stockCountLineSchema],

    // ── Who did what ─────────────────────────────────────────────────────────
    startedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    startedByName: { type: String, trim: true, default: "" },

    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedByName: { type: String, trim: true, default: "" },

    postedAt: { type: Date, default: null },
    postedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    postedByName: { type: String, trim: true, default: "" },

    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    cancelReason: { type: String, trim: true, default: "" },

    // ── The durable posting receipt ──────────────────────────────────────────
    // Bound to the operation that posted, so a replay returns the same answer
    // and a changed body under the same key is a conflict — the receipt outlives
    // the temporary idempotency bookkeeping row.
    posting: {
      idempotencyKey: { type: String, trim: true, default: "" },
      requestHash: { type: String, trim: true, default: "" },
      discrepanciesPosted: { type: Number, default: 0 },
      linesCounted: { type: Number, default: 0 },
    },

    // Optimistic-concurrency guard for the save-entries path: a stale save
    // matches nothing rather than clobbering a newer one.
    recordVersion: { type: Number, default: 0 },
  },
  { timestamps: true, collection: "stock_counts" },
);

// One SEQUENCE per company; unique so two concurrent starts cannot both take it.
stockCountSchema.index({ companyId: 1, seq: 1 }, { unique: true });
stockCountSchema.index({ companyId: 1, countNumber: 1 }, { unique: true });

// ── ONE OPEN COUNT PER LOCATION ─────────────────────────────────────────────
// A location may have at most one count that is not a terminal outcome. The
// partial filter keeps POSTED/CANCELLED counts out of the constraint, so the
// history of a location can hold many while only one is ever open. This is the
// database-level twin of the route's check — the route gives a friendly refusal,
// this makes a second open count physically impossible even under a race.
stockCountSchema.index(
  { companyId: 1, warehouseId: 1, locationId: 1, status: 1 },
  {
    unique: true,
    name: "one_open_count_per_location",
    partialFilterExpression: { status: { $in: OPEN_STATUSES } },
  },
);

stockCountSchema.index({ companyId: 1, status: 1, createdAt: -1 });

// ── IMMUTABLE ONCE POSTED ───────────────────────────────────────────────────
// The same limits stated across Store apply: these are mongoose middlewares,
// they do not police a raw shell or bulkWrite, and the only writer is the
// stock-count route. What they guarantee is that no ordinary code path edits or
// deletes a posted count — a correction is a new count, never an edit.
const refusePosted = (what) => {
  const err = new Error(
    `A posted stock count is the evidence behind real stock movements and cannot be ${what}. Start a new count to make a further correction.`,
  );
  err.name = "StockCountImmutableError";
  err.statusCode = 409;
  return err;
};

stockCountSchema.pre("save", function guardPosted(next) {
  if (this.isNew) return next();
  // A document loaded as POSTED/CANCELLED may not be saved again with changes.
  // The post/cancel transitions themselves set these fields and save WHILE the
  // in-memory status is still the prior open status, so they are not blocked.
  if (this.isModified() && (this._wasTerminal === true)) {
    return next(refusePosted("changed"));
  }
  return next();
});

stockCountSchema.post("init", function markTerminal() {
  this._wasTerminal = this.status === "POSTED" || this.status === "CANCELLED";
});

const refuseDelete = function refuseDelete(next) {
  return next(refusePosted("deleted"));
};
stockCountSchema.pre("deleteOne", { document: true, query: false }, function guard(next) {
  if (this.status === "POSTED") return next(refusePosted("deleted"));
  return next();
});

stockCountSchema.statics.MODES = MODES;
stockCountSchema.statics.STATUSES = STATUSES;
stockCountSchema.statics.OPEN_STATUSES = OPEN_STATUSES;

module.exports =
  mongoose.models.StockCount || mongoose.model("StockCount", stockCountSchema);
module.exports.MODES = MODES;
module.exports.STATUSES = STATUSES;
module.exports.OPEN_STATUSES = OPEN_STATUSES;
