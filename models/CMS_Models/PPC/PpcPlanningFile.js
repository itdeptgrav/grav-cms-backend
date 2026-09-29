// models/CMS_Models/PPC/PpcPlanningFile.js
//
// THE PPC PLANNING FILE — which planning record owns a confirmed order line.
//
// ── WHAT IT IS, AND WHAT `PLANNED` DOES NOT MEAN ────────────────────────────
// One planning record per permanent order line, holding PPC's own planning
// INTENTIONS: who owns the line, how urgent it is, which site is proposed, the
// window PPC is working towards, and the assumptions it is working under.
//
// `PLANNED` means PPC has finished stating those intentions. It does not mean
// capacity is booked, a sewing line is allocated, a production start date is
// promised, or an order is released to Production. None of those exists yet,
// and this schema has no field that could hold one — no line id, no shift, no
// booked minutes, no daily target, no release number, no work order reference.
// The absence is deliberate and a test asserts it, because the moment a
// `bookedMinutes` appears here somebody will read `PLANNED` as a commitment.
//
// ── IDENTITY IS THE PERMANENT LINE REFERENCE, NEVER A NAME ──────────────────
// (companyId, orderLineRef) for the ACTIVE file, unique in the database. That
// is what makes creation idempotent and concurrent creation produce exactly one
// record: the second writer loses at the index, not at a comment.
//
// `orderLineRef` is the Sales handover line reference — the permanent
// `lineRef`. Not the buyer, not the style name, not the product name, not an
// SKU, and not a position in an array. A style may legitimately appear on two
// commercial lines of one order, and two lines may carry colourways with the
// same NAME; anything joining on a name silently merges them into one plan and
// the error is invisible, because the merged row looks perfectly ordinary.
//
// ── THE FROZEN BASIS IS IMMUTABLE, AND THAT IS THE POINT ────────────────────
// When a file is created it copies the identities and versions of everything
// that authorised it: the confirmed quantity and delivery requirement, the
// Execution Pack version, the IE release version, the PPM version, and PPC's
// own receipts for the pack and the release. Every path in it is `immutable`,
// so mongoose refuses a write rather than relying on a service remembering not
// to make one.
//
// When an upstream source MOVES, the frozen basis is not rewritten. The file
// keeps saying what it was planned against, is shown as source-moved, and is
// barred from later capacity booking. A planner who wants to plan against the
// new basis creates an explicit SUCCESSOR. Silently re-stamping the basis would
// destroy the only record of what the plan was actually made from.
//
// ── AND THE BROWSER CANNOT SUBMIT AN UPSTREAM IDENTITY ──────────────────────
// Every field in `sourceBasis` is server-derived, read from the published
// contracts at creation time. The update surface accepts PPC-owned planning
// fields only. A request carrying `sourceBasis`, a pack version or a release id
// is refused by name rather than ignored, because a client that believed it was
// setting the basis should be told it was not.
"use strict";

const mongoose = require("mongoose");

const { isBusinessDate } = require("../../../services/ppc/businessDate");

const actorRef = () => ({
  id: { type: mongoose.Schema.Types.ObjectId },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
});

/* ══ LIFECYCLE ════════════════════════════════════════════════════════════ */

/**
 * This slice's lifecycle, and no more of one than this slice earns.
 *
 * OPEN → PLANNING → PLANNED is the forward path. ON_HOLD is reachable from any
 * of the three and returns to where it came from. CANCELLED is terminal and
 * SUPERSEDED is what a successor does to its predecessor.
 *
 * There is no RELEASED, no BOOKED and no IN_PRODUCTION: those are later
 * chunks', and a state nobody can reach is a promise a screen will render.
 */
const PLANNING_STATE = Object.freeze({
  OPEN: "OPEN",
  PLANNING: "PLANNING",
  PLANNED: "PLANNED",
  ON_HOLD: "ON_HOLD",
  CANCELLED: "CANCELLED",
  SUPERSEDED: "SUPERSEDED",
});
const PLANNING_STATES = Object.freeze(Object.values(PLANNING_STATE));

/** The states that still own their line — exactly one of these may exist per line. */
const ACTIVE_STATES = Object.freeze([
  PLANNING_STATE.OPEN,
  PLANNING_STATE.PLANNING,
  PLANNING_STATE.PLANNED,
  PLANNING_STATE.ON_HOLD,
]);

/** Where a hold may be placed from, and therefore where it may return to. */
const HOLDABLE_STATES = Object.freeze([
  PLANNING_STATE.OPEN,
  PLANNING_STATE.PLANNING,
  PLANNING_STATE.PLANNED,
]);

/** How urgent PPC considers this line. PPC's own judgement, not Sales'. */
const PRIORITY = Object.freeze({
  CRITICAL: "CRITICAL",
  HIGH: "HIGH",
  NORMAL: "NORMAL",
  LOW: "LOW",
});
const PRIORITIES = Object.freeze(Object.values(PRIORITY));

/** Why a line is held. A closed list, so a hold is always classifiable. */
const HOLD_REASON = Object.freeze([
  "AWAITING_MATERIAL",
  "AWAITING_ENGINEERING",
  "AWAITING_MERCHANDISING",
  "AWAITING_BUYER",
  "CAPACITY_CONSTRAINT",
  "SOURCE_MOVED",
  "OTHER",
]);

/**
 * Why a planning file was cancelled. Closed, so a cancellation is always
 * classifiable — and `OTHER` needs a note long enough to act on.
 *
 * Cancelling is PPC withdrawing ITS plan. It says nothing about the order,
 * writes nothing upstream and creates no successor.
 */
const CANCELLATION_REASON = Object.freeze([
  "ORDER_CANCELLED_UPSTREAM",
  "LINE_NOT_TO_BE_PRODUCED",
  "DUPLICATE_PLANNING_FILE",
  "OPENED_IN_ERROR",
  "OTHER",
]);

const LIMITS = Object.freeze({
  NOTE: 4000,
  REASON: 2000,
  ASSUMPTION: 1000,
  ASSUMPTIONS: 20,
  HISTORY: 200,
});

/* ══ THE FROZEN SOURCE BASIS ══════════════════════════════════════════════ */

/**
 * What this plan was made from, copied once and never again.
 *
 * Versions and references only. No pack contents, no bulletin, no capacity
 * figures, no minutes text — this is the receipt for a decision, not a second
 * copy of the records behind it.
 */
const sourceBasisSchema = new mongoose.Schema(
  {
    capturedAt: { type: Date, required: true, immutable: true },

    /* ── THE CONFIRMED COMMITMENT, AS IT STOOD ─────────────────────────── */
    confirmedQuantity: { type: Number, required: true, min: 0, immutable: true },
    /* A factory calendar day, `YYYY-MM-DD` — never an instant. */
    earliestDeliveryDate: {
      type: String, default: null, immutable: true,
      validate: [(v) => v === null || isBusinessDate(v), "A delivery date is a YYYY-MM-DD day."],
    },
    deliveryRequirement: { type: String, trim: true, default: "", immutable: true },
    deliveryCount: { type: Number, default: 0, immutable: true },

    /* ── MERCHANDISING'S EXECUTION PACK ────────────────────────────────── */
    executionPackId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    executionPackVersionNo: { type: Number, default: null, immutable: true },
    executionPackState: { type: String, trim: true, default: "", immutable: true },

    /* PPC's OWN receipt for that exact pack version — PPC's record, frozen as
       evidence that the acceptance which authorised this plan actually
       happened. Required: a plan whose authorising receipt cannot be named was
       not authorised by one. Provenance, never a label — no screen prints it. */
    packReceiptId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    packReceiptVersionNo: { type: Number, required: true, min: 1, immutable: true },
    packReceiptState: { type: String, trim: true, default: "", immutable: true },

    /* ── INDUSTRIAL ENGINEERING'S RELEASE ──────────────────────────────── */
    ieReleaseId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    ieReleaseRef: { type: String, trim: true, default: "", immutable: true },
    ieReleaseVersionNo: { type: Number, default: null, immutable: true },
    ieReleaseState: { type: String, trim: true, default: "", immutable: true },

    /* And PPC's own receipt for that exact release version. */
    ieReceiptId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    ieReceiptVersionNo: { type: Number, required: true, min: 1, immutable: true },
    ieReceiptState: { type: String, trim: true, default: "", immutable: true },

    /* ── THE ISSUED PRE-PRODUCTION MEETING MINUTES ─────────────────────── */
    ppmMeetingId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    ppmVersionNo: { type: Number, default: null, immutable: true },
    ppmState: { type: String, trim: true, default: "", immutable: true },

    /* ── THE SITE, WHERE ONE WAS EXPLICITLY CHOSEN ─────────────────────── */
    /* Sales' or Merchandising's nomination, copied. Empty when nobody chose
       one — never defaulted to a first option, because a guessed factory reads
       exactly like a decided one. */
    nominatedFactoryRef: { type: String, trim: true, default: "", immutable: true },
  },
  { _id: false },
);

/* ══ PPC'S OWN PLANNING FIELDS ════════════════════════════════════════════ */

/**
 * Everything PPC may record in this slice, and nothing that books anything.
 *
 * A "requested window" is PPC stating what it is working towards. It is not a
 * promised production start, it reserves nothing, and no capacity calculation
 * reads it — which is why it is `requested` in the name rather than `planned`.
 */
const businessDay = [
  (v) => v === null || v === undefined || isBusinessDate(v),
  "A requested date is a YYYY-MM-DD day.",
];

const planningFieldsSchema = new mongoose.Schema(
  {
    owner: actorRef(),
    priority: { type: String, enum: PRIORITIES, default: PRIORITY.NORMAL },

    /* PPC's PROPOSAL, distinct from the frozen nomination it may differ from. */
    proposedFactoryRef: { type: String, trim: true, default: "", maxlength: 120 },

    planningNote: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },
    riskNote: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* Factory calendar days, `YYYY-MM-DD`. Strings from the browser to the
       database and back, so no timezone can move one by a day. */
    requestedProductionStart: { type: String, default: null, validate: businessDay },
    requestedProductionEnd: { type: String, default: null, validate: businessDay },
    requestedCompletionDate: { type: String, default: null, validate: businessDay },

    /* Free-text assumptions, bounded in count and length so the document
       cannot grow without limit through a field nobody validates. */
    assumptions: {
      type: [new mongoose.Schema(
        {
          key: { type: String, trim: true, required: true, maxlength: 80 },
          statement: { type: String, trim: true, required: true, maxlength: LIMITS.ASSUMPTION },
        },
        { _id: false },
      )],
      default: () => [],
      validate: [
        (v) => !Array.isArray(v) || v.length <= LIMITS.ASSUMPTIONS,
        `At most ${LIMITS.ASSUMPTIONS} planning assumptions.`,
      ],
    },
  },
  { _id: false },
);

/* ══ BOUNDED AUDIT HISTORY ════════════════════════════════════════════════ */

const EVENT_TYPES = Object.freeze([
  "PLANNING_FILE_CREATED",
  "PLANNING_FIELDS_UPDATED",
  "PLANNING_STARTED",
  "MARKED_PLANNED",
  "HOLD_PLACED",
  "HOLD_REMOVED",
  "SOURCE_MOVEMENT_OBSERVED",
  "SUCCESSOR_CREATED",
  "SUPERSEDED_BY_SUCCESSOR",
  "PLANNING_FILE_CANCELLED",
]);

const eventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    fromState: { type: String, trim: true, default: "" },
    toState: { type: String, trim: true, default: "" },
    /* Which fields moved — names only. Never the values, so a note containing
       something sensitive is not duplicated into an unbounded trail. */
    changed: [{ type: String, trim: true, maxlength: 60 }],
    reason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    /* ── THE HOLD AN EVENT IS ABOUT ────────────────────────────────────────
       On HOLD_PLACED, what the hold said; on HOLD_REMOVED, the hold being
       resolved — frozen at that moment. The live hold fields are cleared when
       a hold is removed, so without this the trail would say THAT a hold was
       lifted and never WHY it was placed. On HOLD_REMOVED, `reason` above is
       the resolution: what changed. */
    hold: {
      type: new mongoose.Schema({
        reason: { type: String, trim: true, default: "" },
        note: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
        heldAt: { type: Date, default: null },
        heldByName: { type: String, trim: true, default: "" },
        stateBeforeHold: { type: String, trim: true, default: "" },
      }, { _id: false }),
      default: undefined,
    },
    revision: { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

/* ══ THE DOCUMENT ═════════════════════════════════════════════════════════ */

const planningFileSchema = new mongoose.Schema(
  {
    /* PPC's own human reference. Immutable, because it is printed and quoted. */
    planningFileRef: { type: String, required: true, trim: true, immutable: true },

    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },

    /* ── THE PERMANENT ORDER-LINE IDENTITY ───────────────────────────────── */
    orderRef: { type: String, required: true, trim: true, immutable: true },
    /* THE join key. Never a name. */
    orderLineRef: { type: String, required: true, trim: true, immutable: true },
    handoverRef: { type: String, trim: true, default: "", immutable: true },

    /* Merchandising's coordination record for the same line. */
    executionFileId: {
      type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true,
    },
    executionFileRef: { type: String, trim: true, default: "", immutable: true },

    /* ── STYLE IDENTITY ──────────────────────────────────────────────────── */
    /* The record, so a renamed style code cannot break the engineering link. */
    sampleStyleId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    styleRef: { type: String, trim: true, default: "", immutable: true },
    productName: { type: String, trim: true, default: "", immutable: true },
    buyerDisplayLabel: { type: String, trim: true, default: "", immutable: true },

    /* ── LIFECYCLE ───────────────────────────────────────────────────────── */
    state: {
      type: String, enum: PLANNING_STATES,
      required: true, default: PLANNING_STATE.OPEN, index: true,
    },
    /* Where a hold must return to. Written when the hold is placed. */
    stateBeforeHold: { type: String, enum: PLANNING_STATES, default: null },

    holdReason: { type: String, enum: HOLD_REASON, default: undefined },
    holdNote: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },
    heldAt: { type: Date, default: null },
    heldBy: actorRef(),

    plannedAt: { type: Date, default: null },
    plannedBy: actorRef(),

    /* ── CANCELLATION — terminal, reasoned, and never a deletion ─────────── */
    cancelledAt: { type: Date, default: null },
    cancelledBy: actorRef(),
    cancellationReason: { type: String, enum: CANCELLATION_REASON, default: undefined },
    cancellationNote: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },

    /* ── THE FROZEN BASIS, AND THE SUCCESSOR CHAIN ───────────────────────── */
    sourceBasis: { type: sourceBasisSchema, required: true, immutable: true },

    /* Which file this one replaces, and which replaced it. A chain, so the
       whole planning history of a line is walkable from either end. */
    supersedesFileId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    supersedesFileRef: { type: String, trim: true, default: "", immutable: true },
    supersededByFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    supersededByFileRef: { type: String, trim: true, default: "" },
    supersededAt: { type: Date, default: null },
    supersessionReason: { type: String, trim: true, default: "", maxlength: LIMITS.REASON },

    /* A file opened after an earlier one was CANCELLED names it, so the
       line's chain stays walkable across a cancellation too. Not a successor:
       nothing was inherited, and the cancelled file was not superseded. */
    followsCancelledFileId: { type: mongoose.Schema.Types.ObjectId, default: null, immutable: true },
    followsCancelledFileRef: { type: String, trim: true, default: "", immutable: true },

    /* ── THE BOOKING FENCE ───────────────────────────────────────────────
       Not business state. A capacity booking or replan increments this, and
       nothing else, inside its own transaction and matched on the exact
       revision and PLANNED state it was proved against. That makes the
       booking WRITE this document, so a hold, successor or cancellation
       committing in the same window either makes the fence miss or conflicts
       with it — the database serialises the two instead of letting a booking
       land on a plan that stopped being PLANNED. It never moves `revision`,
       never appends history and never touches a timestamp. */
    /* Named as `PpcCapacityLine` and `PpcCapacityCalendar` name theirs. */
    bookingFence: { type: Number, default: 0, min: 0 },

    /* Generation number within the line — 1 for the first plan. */
    generation: { type: Number, required: true, min: 1, default: 1, immutable: true },

    /* ── PPC'S OWN FIELDS ────────────────────────────────────────────────── */
    planning: { type: planningFieldsSchema, default: () => ({}) },

    /* ── CONCURRENCY AND AUDIT ───────────────────────────────────────────── */
    /* Every command sends the revision it read. A mismatch is a conflict, not
       a last-writer-wins overwrite of somebody else's edit. */
    revision: { type: Number, required: true, min: 1, default: 1 },

    history: {
      type: [eventSchema],
      default: () => [],
      validate: [
        (v) => !Array.isArray(v) || v.length <= LIMITS.HISTORY,
        `A planning file keeps at most ${LIMITS.HISTORY} events.`,
      ],
    },

    createdBy: actorRef(),
    updatedBy: actorRef(),
  },
  { timestamps: true, collection: "ppc_planning_files" },
);

/* ── ONE ACTIVE FILE PER LINE ────────────────────────────────────────────────
   A PARTIAL unique index, over the active states only. That is what makes
   "one active planning file per order line" a database fact rather than a
   service convention: two concurrent creates both reach the index and exactly
   one survives, and a superseded or cancelled file does not block the
   successor that replaces it. */
planningFileSchema.index(
  { companyId: 1, orderLineRef: 1 },
  {
    unique: true,
    name: "ppc_planning_one_active_per_line",
    partialFilterExpression: { state: { $in: ACTIVE_STATES } },
  },
);

/** The human reference is unique per company, because it is quoted. */
planningFileSchema.index(
  { companyId: 1, planningFileRef: 1 },
  { unique: true, name: "ppc_planning_ref_unique" },
);

/** The register's own sort: newest first within a company, filtered by state. */
planningFileSchema.index({ companyId: 1, state: 1, _id: -1 });
planningFileSchema.index({ companyId: 1, executionFileId: 1 });
/** The generation chain for one line, oldest first. */
planningFileSchema.index({ companyId: 1, orderLineRef: 1, generation: 1 });

/* ══ THE LIFECYCLE GUARD ══════════════════════════════════════════════════
   `immutable: true` on a path is not enough on its own. Mongoose honours it on
   `save()` and silently STRIPS it from update operators — so a write that
   tried is reported as a success — and a `replaceOne`, an upsert, a
   `$rename`, a delete or a `bulkWrite` goes round it entirely. A PLANNED file
   is permanent evidence of what PPC decided, so every mutation path is closed
   here, at the model, and the service is not trusted to remember.

   What stays open is exactly the set of writes the lifecycle needs, each as a
   SHAPE the guard can recognise without reading the record:

     · a planning-fields edit — only `planning.*`, and only when the filter
       pins an editable state AND `plannedAt: null`, so the database itself
       refuses to edit a file that has ever been PLANNED;
     · a transition — the filter pins the exact from-state, the update names
       one permitted to-state, and only that transition's fields move.

   Every shape must pin `_id`, `companyId` and the exact `revision`, must move
   the revision forward by exactly one, and may append exactly one audit event
   stamped with that revision. Anything else — an unknown field, an unknown
   operator, a second event, a revision that moves backwards — is refused. The
   raw driver collection is the one path a model cannot see; nothing in PPC
   uses it. */

const guardRefusal = (why) => {
  const err = new Error(`A PPC planning file cannot be written that way: ${why}`);
  err.name = "PpcPlanningFileImmutable";
  err.code = "PPC_PLANNING_FILE_IMMUTABLE";
  return err;
};

const PLANNING_FIELD_PATHS = Object.freeze([
  "owner", "priority", "proposedFactoryRef", "planningNote", "riskNote",
  "requestedProductionStart", "requestedProductionEnd", "requestedCompletionDate",
  "assumptions",
].map((k) => `planning.${k}`));

/** Where a planning-fields edit may start. PLANNED is not here, and never will be. */
const EDITABLE_STATES = Object.freeze([
  PLANNING_STATE.OPEN, PLANNING_STATE.PLANNING, PLANNING_STATE.ON_HOLD,
]);

/** Every transition this slice has, and the fields each may move. */
const TRANSITIONS = Object.freeze([
  { from: [PLANNING_STATE.OPEN], to: [PLANNING_STATE.PLANNING], set: [] },
  { from: [PLANNING_STATE.PLANNING], to: [PLANNING_STATE.PLANNED], set: ["plannedAt", "plannedBy"] },
  {
    from: HOLDABLE_STATES, to: [PLANNING_STATE.ON_HOLD],
    set: ["holdReason", "holdNote", "heldAt", "heldBy", "stateBeforeHold"],
  },
  {
    /* Back to EXACTLY where it was held from — the filter must say so. */
    from: [PLANNING_STATE.ON_HOLD], to: HOLDABLE_STATES,
    set: ["holdNote", "heldAt", "stateBeforeHold"], unset: ["holdReason"],
    returnsToHeldState: true,
  },
  {
    from: ACTIVE_STATES, to: [PLANNING_STATE.SUPERSEDED],
    set: ["supersededByFileId", "supersededByFileRef", "supersededAt", "supersessionReason"],
  },
  {
    from: ACTIVE_STATES, to: [PLANNING_STATE.CANCELLED],
    set: ["cancelledAt", "cancelledBy", "cancellationReason", "cancellationNote"],
  },
]);

const ALWAYS_SET = Object.freeze(["revision", "updatedBy", "updatedAt"]);
const PERMITTED_OPERATORS = Object.freeze(["$set", "$push", "$unset", "$setOnInsert"]);

/** The only filter keys a capacity fence may carry — each an exact value. */
const CAPACITY_FENCE_FILTER = Object.freeze(["_id", "companyId", "revision", "state"]);

/**
 * The capacity fence: exactly `{ $inc: { bookingFence: 1 } }`, on one PLANNED
 * file at an exact revision. Timestamps must be off at the call: with them on,
 * mongoose adds `$set.updatedAt` before this hook runs, the update is no longer
 * this shape, and it falls through to the general guard, which refuses `$inc`. Any other operator, field,
 * amount, filter key or option is refused — so this is a lock, and cannot be
 * used to move anything a lifecycle command owns.
 */
function assertCapacityFence(filter, update, options = {}) {
  if (options.upsert || options.overwrite) throw guardRefusal("a capacity fence never creates or replaces");
  const inc = update.$inc;
  if (!inc || typeof inc !== "object" || Object.keys(inc).length !== 1 || inc.bookingFence !== 1) {
    throw guardRefusal("a capacity fence increments `bookingFence` by one and nothing else");
  }
  assertExactFilter(filter);
  const keys = Object.keys(filter);
  if (keys.some((k) => !CAPACITY_FENCE_FILTER.includes(k)) || keys.length !== CAPACITY_FENCE_FILTER.length) {
    throw guardRefusal("a capacity fence pins exactly `_id`, `companyId`, `revision` and `state`");
  }
  if (filter.state !== PLANNING_STATE.PLANNED) {
    throw guardRefusal("capacity is fenced only on a PLANNED file");
  }
}

function assertExactFilter(filter) {
  /* Exact values, never operators: `{ $in: [...] }` names more than one. */
  if (!filter || !mongoose.isValidObjectId(filter._id)) {
    throw guardRefusal("the filter must name one planning file by `_id`");
  }
  if (!mongoose.isValidObjectId(filter.companyId)) {
    throw guardRefusal("the filter must pin `companyId`");
  }
  if (!Number.isInteger(filter.revision)) {
    throw guardRefusal("the filter must pin the exact `revision` that was read");
  }
}

function assertOneEvent(push, { revision, fromState, toState }) {
  const keys = Object.keys(push || {});
  if (keys.length !== 1 || keys[0] !== "history") {
    throw guardRefusal("only the audit trail may be appended to");
  }
  const h = push.history;
  if (!h || !Array.isArray(h.$each) || h.$each.length !== 1) {
    throw guardRefusal("exactly one audit event is appended per write");
  }
  const e = h.$each[0];
  if (e.revision !== revision) {
    throw guardRefusal("the audit event must carry the revision the write produces");
  }
  if (String(e.fromState || "") !== fromState || String(e.toState || "") !== toState) {
    throw guardRefusal("the audit event must describe the move the write makes");
  }
  if (Object.keys(h).some((k) => !["$each", "$slice"].includes(k))) {
    throw guardRefusal("the audit trail is appended, never reordered or rewritten");
  }
}

/** The one question every query mutation is asked. Throws, or returns. */
function assertPermittedUpdate(filter, update, options = {}) {
  if (update && typeof update === "object" && !Array.isArray(update)
    && Object.keys(update).length === 1 && Object.prototype.hasOwnProperty.call(update, "$inc")) {
    return assertCapacityFence(filter, update, options);
  }
  if (options.upsert) throw guardRefusal("a planning file is created, never upserted");
  if (options.overwrite) throw guardRefusal("a planning file is never replaced");
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    throw guardRefusal("an update must use operators");
  }
  for (const op of Object.keys(update)) {
    if (!PERMITTED_OPERATORS.includes(op)) {
      throw guardRefusal(op.startsWith("$") ? `\`${op}\` is not permitted` : "a planning file is never replaced");
    }
  }
  const set = update.$set || {};
  const unset = update.$unset || {};
  const setOnInsert = update.$setOnInsert || {};
  if (Object.keys(setOnInsert).some((k) => k !== "createdAt")) {
    throw guardRefusal("`$setOnInsert` carries nothing but the timestamp");
  }

  assertExactFilter(filter);
  if (set.revision !== filter.revision + 1) {
    throw guardRefusal("the revision moves forward by exactly one from the revision matched");
  }

  let permitted;
  let unsettable = [];
  let fromState;
  let toState;

  if (Object.prototype.hasOwnProperty.call(set, "state")) {
    /* ── A TRANSITION ─────────────────────────────────────────────────── */
    fromState = filter.state;
    toState = set.state;
    if (typeof fromState !== "string") {
      throw guardRefusal("a transition pins the exact state it moves from");
    }
    const rule = TRANSITIONS.find((t) => t.from.includes(fromState) && t.to.includes(toState));
    if (!rule) throw guardRefusal(`${fromState} → ${toState} is not a transition`);
    if (rule.returnsToHeldState && filter.stateBeforeHold !== toState) {
      throw guardRefusal("a hold returns to exactly the state it was placed from");
    }
    permitted = new Set([...ALWAYS_SET, "state", ...rule.set]);
    unsettable = rule.unset || [];
  } else {
    /* ── A PLANNING-FIELDS EDIT ───────────────────────────────────────── */
    fromState = filter.state;
    toState = filter.state;
    if (!EDITABLE_STATES.includes(fromState)) {
      throw guardRefusal("planning fields are edited only in an editable state, pinned exactly");
    }
    if (!Object.prototype.hasOwnProperty.call(filter, "plannedAt") || filter.plannedAt !== null) {
      throw guardRefusal("a planning-fields edit pins `plannedAt: null` — a planned file's fields are permanent");
    }
    if (!Object.keys(set).some((k) => PLANNING_FIELD_PATHS.includes(k))) {
      throw guardRefusal("an edit changes at least one planning field");
    }
    permitted = new Set([...ALWAYS_SET, ...PLANNING_FIELD_PATHS]);
  }

  const stray = Object.keys(set).filter((k) => !permitted.has(k));
  if (stray.length) throw guardRefusal(`these fields are not this write's to move: ${stray.join(", ")}`);
  const strayUnset = Object.keys(unset).filter((k) => !unsettable.includes(k));
  if (strayUnset.length) throw guardRefusal(`these fields cannot be removed: ${strayUnset.join(", ")}`);

  assertOneEvent(update.$push, { revision: set.revision, fromState, toState });
}

planningFileSchema.pre(["updateOne", "findOneAndUpdate"], function guardUpdate(next) {
  try {
    assertPermittedUpdate(this.getFilter(), this.getUpdate(), this.getOptions());
    return next();
  } catch (err) { return next(err); }
});

/* A planning file is one record; there is no command that moves many. */
planningFileSchema.pre("updateMany", function refuseMany(next) {
  return next(guardRefusal("planning files are never updated in bulk"));
});

for (const op of ["replaceOne", "findOneAndReplace"]) {
  planningFileSchema.pre(op, function refuseReplace(next) {
    return next(guardRefusal("a planning file is never replaced"));
  });
}

/* Planning files are never deleted. A cancelled or superseded file is the
   record of what was planned, and history that can be deleted is not history. */
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  planningFileSchema.pre(op, { query: true, document: false }, function refuseDelete(next) {
    return next(guardRefusal("a planning file is never deleted"));
  });
}
planningFileSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(guardRefusal("a planning file is never deleted"));
});

/* Both skip document middleware, so both are closed rather than trusted. */
planningFileSchema.pre("bulkWrite", function refuseBulk(next) {
  return next(guardRefusal("planning files are never written in bulk"));
});
planningFileSchema.pre("insertMany", function refuseInsertMany(next) {
  return next(guardRefusal("a planning file is created one at a time, through `create`"));
});

/* ── DOCUMENT SAVES ──────────────────────────────────────────────────────
   Every service write is a conditional query update. A `save()` of a loaded
   document is therefore never a lifecycle write, and it may change NOTHING:
   the values it would write are compared with the values that were loaded,
   and any difference — in any path, including one added to this schema later
   — is refused. A save that changes nothing stays a harmless no-op. */
const snapshotOf = (doc) => JSON.parse(JSON.stringify(doc.toObject({
  depopulate: true, virtuals: false, getters: false, versionKey: false,
})));

planningFileSchema.post("init", function rememberLoaded() {
  this.$locals.ppcLoaded = snapshotOf(this);
});

const valueAt = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);

planningFileSchema.pre("save", function guardSave(next) {
  if (this.isNew) return next();
  const loaded = this.$locals.ppcLoaded;
  const now = snapshotOf(this);
  const changed = this.modifiedPaths({ includeChildren: true })
    .filter((p) => p !== "updatedAt")
    .filter((p) => !loaded
      || JSON.stringify(valueAt(now, p) ?? null) !== JSON.stringify(valueAt(loaded, p) ?? null));
  if (changed.length) {
    return next(guardRefusal(`a saved document may not change ${changed.slice(0, 5).join(", ")}`));
  }
  /* Nothing moved, so neither does the timestamp. */
  if (loaded && this.isModified("updatedAt")) this.set("updatedAt", loaded.updatedAt);
  return next();
});

/* ── WHAT A NEW FILE MUST ALREADY BE ─────────────────────────────────────
   Created OPEN at revision 1 with one creation event — the only shape
   `create` and `createSuccessor` produce. And its requested window must be a
   window. */
planningFileSchema.pre("validate", function guardNew(next) {
  if (this.isNew) {
    if (this.state !== PLANNING_STATE.OPEN || this.revision !== 1) {
      return next(guardRefusal("a planning file is born OPEN at revision 1"));
    }
    if ((this.history || []).length !== 1) {
      return next(guardRefusal("a planning file is born with exactly one audit event"));
    }
  }
  const p = this.planning || {};
  if (p.requestedProductionStart && p.requestedProductionEnd
    && p.requestedProductionEnd < p.requestedProductionStart) {
    return next(guardRefusal("the requested production window ends before it starts"));
  }
  if (p.requestedProductionStart && p.requestedCompletionDate
    && p.requestedCompletionDate < p.requestedProductionStart) {
    return next(guardRefusal("completion cannot precede the requested production start"));
  }
  return next();
});

const PpcPlanningFile = mongoose.models.PpcPlanningFile
  || mongoose.model("PpcPlanningFile", planningFileSchema);

/**
 * The one write a capacity booking or replan makes to a planning file.
 *
 * Inside the caller's transaction, it increments `bookingFence` on this file
 * only while it is still PLANNED at the revision the booking was proved
 * against. Returns false when the filter misses — the plan moved — and throws
 * a write conflict (retried by the driver) when a lifecycle command is writing
 * the same file concurrently. Kept here, beside the guard shape it relies on,
 * so capacity code has no general way to write a planning file.
 */
async function fencePlannedFileForBooking({ companyId, planningFileId, revision }, session) {
  const held = await PpcPlanningFile.findOneAndUpdate(
    {
      _id: new mongoose.Types.ObjectId(String(planningFileId)),
      companyId: new mongoose.Types.ObjectId(String(companyId)),
      revision,
      state: PLANNING_STATE.PLANNED,
    },
    { $inc: { bookingFence: 1 } },
    { session, timestamps: false, projection: { _id: 1 } },
  );
  return Boolean(held);
}

module.exports = {
  PpcPlanningFile,
  PLANNING_STATE, PLANNING_STATES, ACTIVE_STATES, HOLDABLE_STATES,
  PRIORITY, PRIORITIES, HOLD_REASON, CANCELLATION_REASON, EVENT_TYPES, LIMITS,
  EDITABLE_STATES, PLANNING_FIELD_PATHS, TRANSITIONS,
  assertPermittedUpdate, fencePlannedFileForBooking,
};
