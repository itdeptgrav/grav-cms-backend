// models/CMS_Models/IndustrialEngineering/IeBulletinVersion.js
//
// IE CHUNK 7C1 — A SUBMITTED OPERATION BULLETIN, FROZEN.
//
// The Style File's embedded `bulletin` is and remains the one writable draft,
// and `PATCH /engineering-files/:fileId/bulletin` remains its only writer. This
// collection holds SUBMITTED SNAPSHOTS and nothing else.
//
// ── THERE IS NO `DRAFT` STATE, AND THAT IS STRUCTURAL ───────────────────────
// The enum is `IN_REVIEW`, `APPROVED`, `RETURNED`, `SUPERSEDED`. A draft state
// cannot be reached by any route, present or future, without this file changing
// — the same device `DownstreamHandoverReceipt` uses to make "PPC cannot reject"
// a property of the schema rather than a convention somebody remembers. Two
// writable drafts is the failure this chunk exists to prevent, so the second one
// is made unrepresentable instead of merely unused.
//
// ── FROZEN FROM THE INSTANT IT EXISTS, NOT FROM APPROVAL ────────────────────
// A snapshot is evidence of what was put up for review. If its rows could move
// while `IN_REVIEW`, a reviewer would be approving something other than what
// they read; if they could move once `RETURNED`, the record of what was rejected
// would be editable by whoever was rejected. So content is immutable in EVERY
// state, and the only writes permitted are the closed transition allowlists
// below.
//
// ── WHY A `pre("save")` HOOK ALONE WOULD BE DECORATION ──────────────────────
// Document middleware runs on `save()` and on nothing else. Every IE service
// writes through atomic update queries — `ieStyleFile.service.js` uses
// `findOneAndUpdate`, and so does every mutation in the layout, capacity and
// ramp services. A `save` hook would be bypassed by exactly the code it is
// supposed to constrain. So the guard covers `save`, `replaceOne`, `updateOne`,
// `updateMany` and `findOneAndUpdate`, and the services additionally name the
// legal current `state` in every filter. Two layers, because either alone has a
// hole the other closes.
"use strict";

const mongoose = require("mongoose");

/* ── THE FOUR STATES, AND WHAT THEY MEAN ────────────────────────────────────
   IN_REVIEW   submitted, freezing the draft, awaiting a decision
   APPROVED    the current approved bulletin for its file
   RETURNED    terminal. Evidence of a rejection, never reopened — the draft is
               edited and submitted again as a NEW version
   SUPERSEDED  terminal. Was approved; a later version has been approved since */
const STATE = Object.freeze({
  IN_REVIEW: "IN_REVIEW",
  APPROVED: "APPROVED",
  RETURNED: "RETURNED",
  SUPERSEDED: "SUPERSEDED",
});
const STATES = Object.freeze(Object.values(STATE));

/** Terminal states accept no later mutation at all. */
const TERMINAL = Object.freeze(new Set([STATE.RETURNED, STATE.SUPERSEDED]));

const EVENT_TYPES = Object.freeze([
  "BULLETIN_VERSION_SUBMITTED",
  "BULLETIN_VERSION_RETURNED",
  "BULLETIN_VERSION_APPROVED",
  "BULLETIN_VERSION_SUPERSEDED",
]);

const LIMITS = Object.freeze({
  ROWS: 400,          // the Style File bulletin's own cap; a snapshot cannot exceed its source
  NOTE: 1000,
  SUMMARY: 300,
  RETURN_REASON: 2000,
  HISTORY: 200,
});

/**
 * One frozen bulletin row: the draft row's own shape, plus the approved
 * evidence resolved at submit.
 *
 * The last five fields are resolved by the existing
 * `ieLineLayout.service.approvedTimesFor`, including its `laterApproval`
 * tie-break. A version and any layout later opened from it must bind the same
 * study, and two resolvers would eventually disagree about which approval was
 * current.
 */
const frozenRowSchema = new mongoose.Schema(
  {
    rowId: { type: String, required: true, trim: true },
    sequence: { type: Number, required: true, min: 1 },

    ieOperationId: { type: mongoose.Schema.Types.ObjectId, ref: "IeOperation", required: true },
    ieOperationRevision: { type: Number, required: true, min: 1 },
    operationCode: { type: String, trim: true, default: "" },
    operationName: { type: String, trim: true, default: "" },
    machineType: { type: String, trim: true, default: "" },

    /* IE's proposal, as the draft held it. `null` means nobody proposed a time,
       which is not the same as a proposal of zero. */
    proposedSamMinutes: { type: Number, default: null, min: 0 },
    note: { type: String, trim: true, default: "", maxlength: LIMITS.NOTE },

    /* The Chunk 6B required-machine evidence, exactly as the draft row froze it.
       `null` for a row authored before that freeze existed, and nothing here
       invents one. */
    requirementSnapshot: {
      type: new mongoose.Schema({
        capturedAt: { type: Date, default: null },
        ieOperationRevision: { type: Number, default: null },
        requirementsConfigured: { type: Boolean, default: false },
        machineTypes: {
          type: [new mongoose.Schema({
            machineType: { type: String, required: true, trim: true },
            quantity: { type: Number, required: true, min: 1 },
          }, { _id: false })],
          default: () => [],
        },
      }, { _id: false }),
      default: null,
    },

    /* ── THE APPROVED STANDARD TIME AND ITS EVIDENCE ────────────────────── */
    standardTimeMinutes: { type: Number, required: true, min: 0 },
    standardTimeSource: { type: String, trim: true, default: "" },
    methodStudyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedSubmissionId: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },
  },
  { _id: false },
);

/** A bounded audit line. Never a copy of the rows. */
const versionEventSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true },
    type: { type: String, enum: EVENT_TYPES, required: true },
    at: { type: Date, required: true },
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
    versionNo: { type: Number, required: true, min: 1 },
    summary: { type: String, trim: true, default: "", maxlength: LIMITS.SUMMARY },
  },
  { _id: false },
);

const ieBulletinVersionSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, index: true, immutable: true,
    },
    ieStyleFileId: {
      type: mongoose.Schema.Types.ObjectId, ref: "IeStyleFile", required: true, immutable: true,
    },
    /* Copied from the file, so a reader answers "which style" without a join. */
    sampleStyleId: {
      type: mongoose.Schema.Types.ObjectId, ref: "SampleStyle", required: true, immutable: true,
    },

    /* Allocated at submit as the highest for this file plus one, read inside the
       transaction. The unique index below is the actual arbiter. */
    versionNo: { type: Number, required: true, min: 1, immutable: true },

    state: { type: String, enum: STATES, required: true, default: STATE.IN_REVIEW },

    /* This document's own optimistic counter, distinct from the file's. */
    revision: { type: Number, default: 1, min: 1 },

    /* Which `IeStyleFile.revision` was snapshotted. Part of the evidence: it
       says exactly which edit of the draft this version is. */
    fileRevisionAtSubmit: { type: Number, required: true, min: 1, immutable: true },

    rows: { type: [frozenRowSchema], default: () => [] },

    totals: {
      garmentSamMinutes: { type: Number, default: 0, min: 0 },
      samRowCount: { type: Number, default: 0, min: 0 },
      samDerivation: { type: String, trim: true, default: "" },
    },

    /* The published allowance policy behind the approved times, named so a
       reader can explain a standard time without re-deriving it. Nullable
       because a file may carry no policy at all. */
    allowancePolicyId: { type: mongoose.Schema.Types.ObjectId, default: null },
    allowancePolicyRevision: { type: Number, default: null, min: 1 },

    /* ── SERVER-COMPUTED, NEVER ACCEPTED FROM A CLIENT ────────────────────
       The same three digests Chunk 6A computes over a layout's bound rows, from
       the same helpers. A client that could send these could make one source
       look like another. */
    sourceFingerprint: { type: String, required: true, trim: true },
    sourceApprovalDigest: { type: String, required: true, trim: true },
    sourceRequirementDigest: { type: String, trim: true, default: "" },

    /* ── WHO, AND WHEN ────────────────────────────────────────────────────
       The actor ID is required, not decorative: maker-checker compares ids, and
       a display name is not an identity. */
    submittedBy: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    submittedByName: { type: String, trim: true, default: "" },
    submittedAt: { type: Date, required: true, immutable: true },

    reviewedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    reviewedByName: { type: String, trim: true, default: "" },
    reviewedAt: { type: Date, default: null },
    returnReason: { type: String, trim: true, default: "", maxlength: LIMITS.RETURN_REASON },

    approvedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    approvedByName: { type: String, trim: true, default: "" },
    approvedAt: { type: Date, default: null },

    supersedesVersionNo: { type: Number, default: null, min: 1 },
    supersededByVersionNo: { type: Number, default: null, min: 1 },

    history: { type: [versionEventSchema], default: () => [] },
  },
  { timestamps: true, collection: "ie_bulletin_versions" },
);

/* ═══ INDEXES ══════════════════════════════════════════════════════════════ */

/* The arbiter for version allocation. "Read the highest, add one" is two
   operations and two operations are what a race gets between; this index is
   what makes the loser lose, exactly as `{companyId, fileId, packVersionNo}`
   does for `ExecutionPack`. Never a duplicate number, and never a gap that
   hides one. */
ieBulletinVersionSchema.index(
  { companyId: 1, ieStyleFileId: 1, versionNo: 1 },
  { unique: true, name: "ie_bulletin_version_no_per_file" },
);

/* ONE SUBMISSION IN REVIEW PER FILE. Partial on `IN_REVIEW`, so an approved,
   returned or superseded version releases the slot. This is the second of the
   two independent mechanisms that refuse a double submission — the first is the
   Style File's own `bulletinReviewVersionId: { $exists: false }` filter clause.
   Either alone is sufficient; both exist because the consequence of neither
   holding is two snapshots of one draft.

   There is deliberately NO partial unique index on `DRAFT`: that state does not
   exist in this collection, so there would be nothing for such an index to
   protect. */
ieBulletinVersionSchema.index(
  { companyId: 1, ieStyleFileId: 1 },
  {
    unique: true,
    partialFilterExpression: { state: STATE.IN_REVIEW },
    name: "ie_bulletin_version_one_in_review",
  },
);

/* The list endpoint's own order — newest version first, per file. */
ieBulletinVersionSchema.index({ companyId: 1, ieStyleFileId: 1, versionNo: -1 });

/* The cross-file review queue: "what is waiting for me in this company". */
ieBulletinVersionSchema.index({ companyId: 1, state: 1, updatedAt: -1, _id: -1 });

/* ═══ THE LIFECYCLE GUARD ══════════════════════════════════════════════════
 *
 * Layer two of the two §11.1 requires. The services name the legal `state` in
 * every filter; this stops a write that slips past that, whichever Mongoose
 * method it arrives through.
 *
 * ── A SUBMITTED VERSION CHANGES ONLY BY MAKING A TRANSITION ────────────────
 * Not "by writing permitted fields" — by MAKING ONE OF THE THREE MOVES. Those
 * are the only three things that ever happen to a bulletin version after it is
 * created:
 *
 *     IN_REVIEW → RETURNED        IN_REVIEW → APPROVED        APPROVED → SUPERSEDED
 *
 * Anything else is refused, including a write whose fields all look legitimate.
 * `{ $set: { approvedBy, approvedAt } }` with no state change is not half an
 * approval — it is a record claiming a decision nobody took, and it is exactly
 * the shape an accidental write takes. So a state change is REQUIRED, its pair
 * must be legal, and the fields are then checked against THAT move's own
 * allowlist rather than against any of the three.
 *
 * ── AND THE MOVE MUST BE PART OF A LIVE TRANSACTION ────────────────────────
 * Every legal transition moves this document and the Style File together, so a
 * transition arriving outside a transaction is by definition not one of the
 * three commands — it is something else wearing their clothes, and it would
 * leave the two records disagreeing.
 *
 * A session alone does not prove it. `startSession()` returns a session whose
 * writes commit one by one, and that is indistinguishable from a transactional
 * one by presence. So the test is `session.inTransaction()`, which is the only
 * thing that separates "these two writes land together" from "this one lands
 * now and the other might not land at all".
 */

/* Always permitted beside any transition: the record's own counter and trail. */
const ALWAYS = Object.freeze(["revision", "history", "updatedAt", "__v"]);

/* One closed allowlist per MOVE, keyed by the move itself. Disjoint on purpose:
   an approval cannot write a return reason, a return cannot stamp an approver,
   and a supersession can write neither. */
const MOVE_FIELDS = Object.freeze({
  [`${STATE.IN_REVIEW}>${STATE.RETURNED}`]: Object.freeze([
    ...ALWAYS, "state", "reviewedBy", "reviewedByName", "reviewedAt", "returnReason",
  ]),
  [`${STATE.IN_REVIEW}>${STATE.APPROVED}`]: Object.freeze([
    ...ALWAYS, "state", "approvedBy", "approvedByName", "approvedAt",
  ]),
  /* ── THE ONE PATH THAT MAY TOUCH AN APPROVED VERSION ─────────────────────
     Supersession, permitted by naming this move and its two fields rather than
     by exempting a caller. `RETURNED` and `SUPERSEDED` appear as no source
     state anywhere in this table: they are terminal, and nothing moves out of
     them. */
  [`${STATE.APPROVED}>${STATE.SUPERSEDED}`]: Object.freeze([
    ...ALWAYS, "state", "supersededByVersionNo",
  ]),
});

/* Kept exported under their old names, because the service and its tests read
   them, and because "what may a return write" is a question worth being able to
   ask directly. */
const RETURN_FIELDS = MOVE_FIELDS[`${STATE.IN_REVIEW}>${STATE.RETURNED}`];
const APPROVE_FIELDS = MOVE_FIELDS[`${STATE.IN_REVIEW}>${STATE.APPROVED}`];
const SUPERSEDE_FIELDS = MOVE_FIELDS[`${STATE.APPROVED}>${STATE.SUPERSEDED}`];

/** Every top-level path an update touches, `$set`/`$unset`/`$inc`/`$push` alike. */
function touchedPaths(update = {}) {
  const paths = new Set();
  for (const [key, value] of Object.entries(update)) {
    if (key.startsWith("$")) {
      if (key === "$setOnInsert") continue;      // an insert, not a mutation
      for (const path of Object.keys(value || {})) paths.add(String(path).split(".")[0]);
      continue;
    }
    /* A bare field on a replacement or a top-level `$set`-less update. */
    paths.add(String(key).split(".")[0]);
  }
  return [...paths];
}

const refuse = (message) => {
  const err = new Error(message);
  err.name = "IeBulletinVersionImmutable";
  err.code = "IE_BULLETIN_VERSION_IMMUTABLE";
  return err;
};

const frozen = (touched) => {
  const err = refuse("A submitted bulletin version is frozen. "
    + `${touched.join(", ")} cannot change — submit a new version instead.`);
  err.touched = touched;
  return err;
};

/**
 * Judge one query-layer write.
 *
 * Returns an Error to refuse with, or null to allow. Everything it needs is on
 * the query: reading the document to find out would be a second operation, and
 * two operations are what a race gets between. So the requirement is pushed
 * onto the caller — name the current state in the filter — and the one
 * conditional write then both proves and performs the move.
 */
function judgeUpdate(query, update) {
  if (query.getOptions?.().upsert) {
    /* An upsert would create a version with no snapshot behind it. Submit
       inserts; nothing upserts. */
    return frozen(["upsert"]);
  }

  const touched = touchedPaths(update);
  if (!touched.length) return null;

  /* ── A TRANSITION, OR NOTHING ─────────────────────────────────────────── */
  const to = update?.$set?.state ?? (typeof update?.state === "string" ? update.state : null);
  if (!to) {
    return refuse("A submitted bulletin version changes only by making a lifecycle "
      + `transition. This write changes ${touched.join(", ")} without moving its state.`);
  }

  /* A filter naming several permissible current states (`$in`) is not enough:
     the move would be legal from one of them and not from another, and the
     write could not say which one it believed it was making. */
  const from = query.getFilter?.()?.state;
  if (typeof from !== "string") {
    return refuse(`A write that changes state to ${to} has to name the one state it is `
      + "moving from, so two callers cannot both believe they made the move.");
  }

  const move = `${from}>${to}`;
  const allowed = MOVE_FIELDS[move];
  if (!allowed) return refuse(`A bulletin version cannot move from ${from} to ${to}.`);

  /* ── AND EVERY FIELD MUST BELONG TO THIS MOVE ─────────────────────────── */
  const stray = touched.filter((p) => !allowed.includes(p));
  if (stray.length) {
    return refuse(`A ${from} to ${to} transition cannot write ${stray.join(", ")}.`);
  }

  /* ── INSIDE THE TRANSACTION THAT MOVES THE STYLE FILE WITH IT ───────────
     A session is not a transaction. `startSession()` hands back a perfectly
     usable session that commits every write immediately, and a standalone
     `mongod` will even accept `startTransaction()` on one and then ignore it —
     which is why this chunk's commands settle support with a real probe before
     they begin. So the presence of a session proves nothing on its own: a
     transition carrying one that is not in a transaction would move this
     version while its Style File stayed exactly where it was, leaving the file
     pointing at a version whose state has changed underneath it.

     `inTransaction()` is what actually distinguishes the two, and it is asked
     LAST so that a caller whose write is malformed for some other reason hears
     about that reason first. */
  const session = query.getOptions?.().session;
  if (!session) {
    return refuse(`A ${from} to ${to} transition moves this version and its engineering `
      + "file together, so it has to run inside a transaction. This write has no session.");
  }
  if (typeof session.inTransaction !== "function" || !session.inTransaction()) {
    return refuse(`A ${from} to ${to} transition moves this version and its engineering `
      + "file together, so it has to run inside a transaction. This write has a session "
      + "that is not in one, so the file would not move with it.");
  }
  return null;
}

/* ── `save()` NEVER MODIFIES ONE ────────────────────────────────────────────
   Creation is a save, and is how every snapshot comes into existence. Every
   later save is refused outright: document middleware cannot see a filter, so
   it cannot prove which state a transition is moving from — and a transition
   that cannot prove that is not one of the three. The three commands all write
   through conditional updates, so nothing legitimate arrives here. */
ieBulletinVersionSchema.pre("save", function freezeOnSave(next) {
  if (this.isNew) return next();
  const touched = [...new Set(this.modifiedPaths().map((p) => String(p).split(".")[0]))];
  return next(frozen(touched.length ? touched : ["this document"]));
});

/* ── THE TWO METHODS A TRANSITION MAY ARRIVE THROUGH ──────────────────────── */
for (const op of ["updateOne", "findOneAndUpdate"]) {
  ieBulletinVersionSchema.pre(op, function judge(next) {
    return next(judgeUpdate(this, this.getUpdate() || {}));
  });
}

/* ── AND THE THREE IT MAY NOT ───────────────────────────────────────────────
   A replacement's paths are the whole document, so it can never be a
   transition; treating it field by field would let a caller "replace" a version
   into a different one. `updateMany` is refused because a lifecycle transition
   happens to ONE version: a write that moves several at once cannot have proved
   the state of each, and the review pointer it must move with belongs to one
   file. */
for (const [op, what] of [
  ["replaceOne", "replaced"], ["findOneAndReplace", "replaced"], ["updateMany", "changed in bulk"],
]) {
  ieBulletinVersionSchema.pre(op, function refuseWholesale(next) {
    return next(refuse(`A submitted bulletin version cannot be ${what}. `
      + "It changes only by one of the three lifecycle transitions, one version at a time."));
  });
}

module.exports = mongoose.models.IeBulletinVersion
  || mongoose.model("IeBulletinVersion", ieBulletinVersionSchema);

module.exports.STATE = STATE;
module.exports.STATES = STATES;
module.exports.TERMINAL = TERMINAL;
module.exports.EVENT_TYPES = EVENT_TYPES;
module.exports.LIMITS = LIMITS;
module.exports.RETURN_FIELDS = RETURN_FIELDS;
module.exports.APPROVE_FIELDS = APPROVE_FIELDS;
module.exports.SUPERSEDE_FIELDS = SUPERSEDE_FIELDS;
module.exports.MOVE_FIELDS = MOVE_FIELDS;
