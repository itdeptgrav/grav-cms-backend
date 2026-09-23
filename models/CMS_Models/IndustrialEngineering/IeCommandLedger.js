// models/CMS_Models/IndustrialEngineering/IeCommandLedger.js
//
// IE CHUNK 8A-i — THE COMMAND LEDGER.
//
// One row per accepted idempotency key, so a command that writes several
// documents can be replayed without repeating any of them.
//
// ── WHY IE OWNS ONE RATHER THAN REUSING STORE & PURCHASE'S ──────────────────
// `SpIdempotencyRecord` is a good record and the wrong shape here, for two
// reasons that both matter.
//
// Its uniqueness is `{companyId, actorId, operation, key}`. The actor belongs in
// that key for a Store & Purchase action, where two buyers pressing the same
// button are two intentions. A release is not: the aggregate it issues is the
// company's, and the same key presented by a second approver for a DIFFERENT
// request has to be refused loudly rather than quietly succeeding as a separate
// row. So this ledger's identity is `{companyId, scope, idempotencyKey}` — no
// actor — which is what the accepted contract specifies.
//
// And its `begin()` flow marks a row IN_PROGRESS before the work, renews a
// heartbeat during it and completes it afterwards, because it is built for
// `unitOfWork.run` and for a deployment that may have no transactions. The
// release command refuses that deployment outright, so it has no use for the
// half-states: it writes its ledger row INSIDE the same transaction as the
// release itself. Either both exist or neither does, and there is no window in
// which a row claims a release that was rolled back.
"use strict";

const mongoose = require("mongoose");

const ieCommandLedgerSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, ref: "Acc_Company",
      required: true, immutable: true,
    },
    /* WHICH command. Two commands sharing a key are two different things, and
       collapsing them would replay one command's answer for another. */
    scope: { type: String, required: true, trim: true, immutable: true },
    idempotencyKey: { type: String, required: true, trim: true, immutable: true },

    /* ── THE CANONICAL HASH OF THE REQUEST ────────────────────────────────
       Same key with a DIFFERENT request is a client bug worth refusing loudly,
       not a replay: replaying the first answer would tell somebody their second,
       different intention had succeeded. */
    requestHash: { type: String, required: true, trim: true, immutable: true },

    /* What the command produced, kept so a replay is traceable to its document
       even if the stored response is later trimmed. */
    resultType: { type: String, trim: true, default: "" },
    resultId: { type: mongoose.Schema.Types.ObjectId, default: null },
    releaseRef: { type: String, trim: true, default: "" },
    releaseVersionNo: { type: Number, default: null, min: 1 },
    aggregateFingerprint: { type: String, trim: true, default: "" },

    /* The answer to replay, verbatim. `Mixed` deliberately: a frozen response is
       evidence of what was said, and re-validating it against a schema that has
       since moved would change the reply. */
    responseStatus: { type: Number, required: true },
    responseBody: { type: mongoose.Schema.Types.Mixed, default: null },

    actorId: { type: mongoose.Schema.Types.ObjectId, default: null },
    actorName: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ie_command_ledger" },
);

/* ── THE UNIQUENESS THAT MAKES CONCURRENT DUPLICATES IMPOSSIBLE ────────────
 * The second insert loses on this index inside its own transaction, the whole
 * attempt rolls back, and the caller is handed the winner's result rather than
 * a second release. */
ieCommandLedgerSchema.index(
  { companyId: 1, scope: 1, idempotencyKey: 1 },
  { unique: true, name: "ie_command_ledger_one_per_key" },
);

/* Documented retention: 30 days, the same window Store & Purchase settled on.
   Long enough for any realistic retry, short enough that this is not an
   indefinite record of who did what — which is the release's own history. */
ieCommandLedgerSchema.index({ createdAt: 1 }, { expireAfterSeconds: 30 * 24 * 60 * 60 });

/* ── A LEDGER ROW IS EVIDENCE OF AN ANSWER ALREADY GIVEN ───────────────────
 * Rewriting one would make a replay return something other than what the
 * caller was told the first time. Rows expire; they are never edited. */
const ledgerImmutable = () => {
  const err = new Error(
    "A command ledger row records an answer already given. It is never changed — "
    + "a different request needs a different idempotency key.",
  );
  err.name = "IeCommandLedgerImmutable";
  err.code = "IE_RELEASE_IMMUTABLE";
  return err;
};

ieCommandLedgerSchema.pre("save", function freezeLedger(next) {
  if (this.isNew) return next();
  return next(this.modifiedPaths().length ? ledgerImmutable() : undefined);
});
for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  ieCommandLedgerSchema.pre(op, function freezeLedgerQuery(next) {
    return next(ledgerImmutable());
  });
}

/* ── AND NO APPLICATION CODE DELETES ONE EITHER ─────────────────────────────
 * A ledger row is what makes a retry safe: while it exists, the same key
 * replays the answer it was given, and a second key for a request that already
 * happened is told so. Deleting one would make an accepted command replayable as
 * a NEW command — the same release issued twice, or a key freed to be reused for
 * something else entirely.
 *
 * ── THE TTL STILL EXPIRES ROWS, AND THAT IS DELIBERATE ─────────────────────
 * The 30-day `expireAfterSeconds` index below is enforced by MongoDB's own
 * background TTL monitor, INSIDE the server. It issues no Mongoose query, so
 * none of these hooks runs and none of them can interfere with it. Normal expiry
 * is therefore untouched: what is refused here is an application deciding to
 * remove a row early, which is the only way this evidence could be lost while it
 * still matters.
 */
const noLedgerDeletion = () => {
  const err = new Error(
    "A command ledger row is never deleted by the application. It is what makes a retry safe, "
    + "and it expires on its own 30-day TTL inside MongoDB.",
  );
  err.name = "IeCommandLedgerImmutable";
  err.code = "IE_RELEASE_IMMUTABLE";
  return err;
};

/* The query paths. `findByIdAndDelete` and `findOneAndRemove` are not hooks of
   their own — both run through `findOneAndDelete`, which is. */
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  ieCommandLedgerSchema.pre(op, { query: true, document: false }, function refuseQueryDelete(next) {
    return next(noLedgerDeletion());
  });
}

/* And the document method, which is a different hook of the same name. */
ieCommandLedgerSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(noLedgerDeletion());
});

module.exports = mongoose.models.IeCommandLedger
  || mongoose.model("IeCommandLedger", ieCommandLedgerSchema);
