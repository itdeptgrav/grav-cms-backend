// models/CMS_Models/Costing/CostingTransition.js
//
// Central Costing — Chunk 6A. WHO MOVED THIS VERSION, WHEN, AND WHY.
//
// ── WHY THE EVIDENCE IS ITS OWN DOCUMENT ────────────────────────────────────
// The version carries the small part a reader needs in front of them — who
// approved it and when. This carries the part an auditor needs a year later:
// the state it moved FROM, the policy revision the decision was taken
// against, the request that carried it, and the note in the words the
// approver used.
//
// It is separate because it is append-only and a version is not. A version has
// one current status; a version that went DRAFT → IN_REVIEW → DRAFT →
// IN_REVIEW → APPROVED has five facts about how it got there, and folding them
// into the version would either lose four of them or make the "immutable"
// document grow.
//
// ── AND WHY IT IS IMMUTABLE TOO ─────────────────────────────────────────────
// An approval record that can be edited is not evidence, it is a note. The
// same guards the version carries apply here, without the lifecycle door:
// there is no legitimate reason to change a transition after it happened, so
// no mechanism exists to.

const mongoose = require("mongoose");

const TRANSITION_KINDS = Object.freeze(["SUBMIT", "APPROVE", "SUPERSEDE", "RETURN"]);

const costingTransitionSchema = new mongoose.Schema(
  {
    /* ── SCOPE ────────────────────────────────────────────────────────────
       The company is stored rather than derived through the costing, because
       an audit read must be answerable with one query and must not depend on
       a parent document still existing. */
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    costingId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    versionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    versionNumber: { type: Number, required: true, min: 1 },

    kind: { type: String, enum: TRANSITION_KINDS, required: true },
    /* Both ends recorded. "It is approved now" does not say whether anybody
       reviewed it, and `fromStatus` is the only thing that does. */
    fromStatus: { type: String, required: true, trim: true },
    toStatus: { type: String, required: true, trim: true },

    /* ── WHO ──────────────────────────────────────────────────────────────
       Id AND name. The id is the identity; the name is what the record reads
       as in five years when the employee row has been renamed or removed, and
       an audit line with an id nobody can resolve is not evidence either. */
    actorId: { type: String, trim: true, required: true },
    actorName: { type: String, trim: true, default: "" },
    actorEmail: { type: String, trim: true, default: "" },

    /* The SERVER's clock. A client timestamp is a claim by the party being
       audited. */
    at: { type: Date, required: true, default: Date.now },

    /* The decision, in the words it was made in. Required for an approval by
       the service; a submission may legitimately have none. */
    note: { type: String, trim: true, default: "" },

    /* ── WHAT IT WAS JUDGED AGAINST ───────────────────────────────────────
       The policy revision in force at the moment of the decision. Without it,
       a later policy change makes every historical approval look as though it
       had been judged against today's minimum margin. */
    policyRevision: { type: Number, default: null },

    /* ── THE DURABLE RECEIPT ──────────────────────────────────────────────
       The temporary idempotency bookkeeping row expires. This does not, and
       after it has gone this record is the ONLY thing that can tell a retry
       from a second action — so it has to carry everything the key is bound
       to, not just the key.

       ── WHAT THE FIRST VERSION GOT WRONG ─────────────────────────────────
       The lookup was `{companyId, versionId, idempotencyKey}`. A key is
       chosen by the client, and nothing stopped one raw key being spent on a
       Submit and then presented for an Approve: the Submit's record matched,
       and the approval "replayed" into a version that had never been
       approved. And with no request fingerprint, a changed approval note
       replayed the old decision under the new words once the temporary row
       had lapsed. */
    idempotencyKey: { type: String, trim: true, default: "" },
    /* The named operation, distinct from `kind`: `kind` describes what
       happened to the version (a SUPERSEDE is a side effect nobody asked
       for), `operation` describes what was ASKED. */
    operation: { type: String, trim: true, default: "" },
    /* What the key was spent on, so a key aimed at another costing or
       version is recognisable long after the bookkeeping row has gone. */
    target: { type: String, trim: true, default: "" },
    /* The canonical body fingerprint. "The same request again" and "this key
       reused for something else" must stay distinguishable forever, not
       merely for the retention window. */
    requestHash: { type: String, trim: true, default: "" },
    requestId: { type: String, trim: true, default: "" },

    /* Set on a SUPERSEDE, naming the version that displaced this one. */
    causedByVersionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    causedByVersionNumber: { type: Number, default: null },
  },
  { timestamps: true },
);

/* The audit read: one costing's history, newest first. */
costingTransitionSchema.index({ companyId: 1, costingId: 1, at: -1 });
/* ── THE IDEMPOTENCY READ, AND THE INDEX THAT DEFENDS IT ───────────────────
 * Keyed on the OPERATION as well as the key, so a Submit receipt can never be
 * returned for an Approve. Unique, so two racing requests carrying one key
 * cannot both insert — the loser gets a duplicate-key error and replays the
 * winner's result, which is what makes concurrency safe rather than merely
 * unlikely.
 *
 * Partial, because a transition with no key (a SUPERSEDE, which nobody
 * requested) must not collide with every other keyless transition. */
costingTransitionSchema.index(
  { companyId: 1, costingId: 1, versionId: 1, operation: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: {
      idempotencyKey: { $type: "string", $gt: "" },
      operation: { $type: "string", $gt: "" },
    },
  },
);

/* ── IMMUTABLE, WITH NO DOOR AT ALL ─────────────────────────────────────────
 * The version has a narrow lifecycle door because a version legitimately
 * moves. A transition never does: it is the record OF a move, and the move
 * already happened. So the guard here is the simpler one — nothing changes
 * after insert, and nothing is deleted.
 *
 * The same two limits stated in A1.5 apply and are not re-argued: these are
 * mongoose middlewares, they do not stop a database shell, and they do not
 * cover `bulkWrite` or `Model.collection.*`. No production costing code
 * writes a transition through a bulk or raw path; the only writer is
 * `services/centralCosting/lifecycle.service.js`, using `Model.create`.
 */
const refuse = (what) => {
  const err = new Error(
    `A costing transition is a record of something that already happened and cannot be ${what}.`,
  );
  err.name = "CostingTransitionImmutableError";
  return err;
};

costingTransitionSchema.pre("save", function (next) {
  if (this.isNew) return next();
  return next(refuse("changed"));
});
const refuseUpdate = function (next) { return next(refuse("changed")); };
costingTransitionSchema.pre("updateOne", refuseUpdate);
costingTransitionSchema.pre("updateMany", refuseUpdate);
costingTransitionSchema.pre("findOneAndUpdate", refuseUpdate);
costingTransitionSchema.pre("replaceOne", refuseUpdate);
costingTransitionSchema.pre("findOneAndReplace", refuseUpdate);

const refuseDelete = function (next) { return next(refuse("deleted")); };
costingTransitionSchema.pre("deleteOne", { document: true, query: true }, refuseDelete);
costingTransitionSchema.pre("deleteMany", refuseDelete);
costingTransitionSchema.pre("findOneAndDelete", refuseDelete);

module.exports =
  mongoose.models.CostingTransition ||
  mongoose.model("CostingTransition", costingTransitionSchema);
module.exports.TRANSITION_KINDS = TRANSITION_KINDS;
