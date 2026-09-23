// models/CMS_Models/PPC/IeReleaseReceipt.js
//
// PPC'S ANSWER TO ONE ISSUED IE RELEASE VERSION. PPC-OWNED, WRITE-ONCE.
//
// ── WHY THIS LIVES UNDER PPC AND NOT UNDER INDUSTRIAL ENGINEERING ───────────
// It is the receiving department's record of its own decision, exactly as
// `DownstreamHandoverReceipt` is for the Merchandising → PPC direction. IE
// issues a release into `ie_releases`; that document's presence, with the
// acting company's id and `state: "ISSUED"`, IS the delivery. PPC's route
// writes this row and nothing in `services/industrialEngineering/` may import
// this model or write this collection — `ppc-ie-release-receipt.route.test.js`
// scans the directory for it.
//
// ── PENDING IS COMPUTED, NOT STORED ─────────────────────────────────────────
// An ISSUED release with no row here IS pending, and every reader derives it.
// Writing a PENDING row at issue time would mean IE creating a PPC record
// before PPC had done anything — the cross-app write this design exists to
// prevent. So the enum below holds PPC's two decisions and nothing else.
//
// ── AND `SUPERSEDED` / `WITHDRAWN` ARE NOT IN THE ENUM EITHER ───────────────
// Those are things that happen to the RELEASE, not answers PPC gave. Putting
// them here would mean IE reaching in to move a PPC row when it superseded a
// version. `effectiveState` is derived at read time by joining this row to its
// release's current state, and is never persisted. "PPC accepted version 2 on
// the 4th" stays true — and stays stored — after version 3 supersedes it.
//
// ── THERE IS NO `REJECTED` ──────────────────────────────────────────────────
// Following `DownstreamHandoverReceipt`: PPC may ask for clarification, but
// refusing an engineering standard outright is not PPC's call. The state
// cannot be reached by any route, present or future, without this file
// changing.
//
// ── AND THE ROW IS IMMUTABLE ────────────────────────────────────────────────
// Every update, replacement, upsert and deletion path is refused outright
// below. A decision that could be edited afterwards is not evidence of a
// decision. The one write this model accepts is the insert that creates it.
"use strict";

const mongoose = require("mongoose");

const RECEIPT_STATE = Object.freeze({
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
});
const RECEIPT_STATES = Object.freeze(Object.values(RECEIPT_STATE));

/** What a clarification about an engineering release can be about. Closed. */
const CLARIFICATION_CATEGORY = Object.freeze([
  "OPERATION_BULLETIN",
  "LINE_LAYOUT",
  "CAPACITY_STANDARD",
  "RAMP_ASSUMPTION",
  "WORKING_TIME_ASSUMPTION",
  "OTHER",
]);

const MIN_REASON = 15;
const MAX_REASON = 2000;

/**
 * The derived answer, computed at read time from a release state and this row.
 *
 * Every name states BOTH halves, so a reader can always see what PPC said and
 * what has since happened to the thing it said it about.
 */
const EFFECTIVE_STATE = Object.freeze({
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  CLARIFICATION_REQUESTED: "CLARIFICATION_REQUESTED",
  SUPERSEDED_UNDECIDED: "SUPERSEDED_UNDECIDED",
  ACCEPTED_SUPERSEDED: "ACCEPTED_SUPERSEDED",
  CLARIFICATION_REQUESTED_SUPERSEDED: "CLARIFICATION_REQUESTED_SUPERSEDED",
  WITHDRAWN: "WITHDRAWN",
});

const receiptSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId, required: true, index: true, immutable: true,
    },

    /* ── EXACTLY WHICH VERSION WAS DECIDED ON ──────────────────────────────
       All three, and all immutable. `releaseRef` + `releaseVersionNo` is the
       business identity the unique index is built on; `ieReleaseId` is the
       document that identity resolves to. A decision that could be re-pointed
       at another version would be worthless. */
    releaseRef: { type: String, required: true, trim: true, immutable: true },
    releaseVersionNo: { type: Number, required: true, min: 1, immutable: true },
    ieReleaseId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
    /* Carried so PPC can read everything it has answered on one style file
       without joining back through IE. */
    ieStyleFileId: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },

    state: {
      type: String, enum: RECEIPT_STATES, required: true, immutable: true,
    },

    clarification: {
      category: { type: String, enum: CLARIFICATION_CATEGORY, default: undefined },
      /* Long enough for an industrial engineer to act on. A one-word
         clarification sends a release back with nothing anybody can do. */
      reason: { type: String, trim: true, default: "", maxlength: MAX_REASON },
    },

    /* ── PPC'S OWN PERSON, FROM THE SESSION ────────────────────────────────
       Never from a body. A decision attributable to whoever the caller claimed
       to be is not attributable at all. */
    decidedBy: {
      id: { type: mongoose.Schema.Types.ObjectId, required: true, immutable: true },
      name: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, lowercase: true, default: "" },
    },
    decidedAt: { type: Date, required: true, immutable: true },

    /* ── HOW A LOST RACE IS CLASSIFIED ─────────────────────────────────────
       The command ledger is written AFTER the decision, so a concurrent loser
       cannot rely on it being there yet. It can rely on this row, because the
       unique index below is what made it a loser. Carrying the key and the
       request hash here is what lets the loser tell "my own retry" (replay the
       200) from "somebody else's answer" (409) without a transaction, a lock
       or a leaked duplicate-key error. */
    idempotencyKey: { type: String, required: true, trim: true, immutable: true },
    requestHash: { type: String, required: true, trim: true, immutable: true },
  },
  { timestamps: true, collection: "ppc_ie_release_receipts" },
);

/* ── ONE ANSWER PER RELEASE VERSION ────────────────────────────────────────
   The database, not the handler, is what makes a second decision impossible.
   A later version legitimately gets its own row and is independently pending
   until it does. */
receiptSchema.index({ companyId: 1, releaseRef: 1, releaseVersionNo: 1 }, { unique: true });
/* ── AND THE SAME GUARANTEE STATED THE OTHER WAY ───────────────────────────
   The index above is on the BUSINESS identity; this one is on the DOCUMENT it
   resolves to. Both, because a bug that wrote a receipt carrying a mismatched
   `releaseRef` or `releaseVersionNo` would slip past the first index and give
   one release document two answers. It is also the lookup the decision path and
   the queue join take. */
receiptSchema.index({ companyId: 1, ieReleaseId: 1 }, { unique: true });
/* Everything PPC has answered on one style file, newest version first. */
receiptSchema.index({ companyId: 1, ieStyleFileId: 1, releaseVersionNo: -1 });

/* ══ STRUCTURAL VALIDITY ══════════════════════════════════════════════════
   The route normalises and validates before it writes, but the route is not the
   only caller a model ever has — a script, a backfill or a later service can
   reach this collection directly, and a row written by one of those is just as
   permanent as one written by PPC. Because the row can never be corrected
   afterwards, the coherence rules have to hold at the point of writing rather
   than at the point of asking.

   Stated as a rule about the PAIR (state, clarification), not as two
   independent field validators: the thing that must never exist is an
   acceptance carrying a complaint, or a complaint carrying nothing to act on. */
const invalid = (why) => {
  const err = new Error(`A PPC release receipt must record a coherent decision. ${why}`);
  err.name = "PpcIeReleaseReceiptInvalid";
  err.code = "PPC_IE_RELEASE_RECEIPT_INVALID";
  return err;
};

/** The one normal form. The service normalises to exactly this before writing. */
const normalised = (v) => String(v ?? "").trim().replace(/\s+/g, " ");

receiptSchema.pre("validate", function requireCoherentDecision(next) {
  const category = this.clarification?.category;
  const reason = String(this.clarification?.reason ?? "");

  if (this.state === RECEIPT_STATE.ACCEPTED) {
    /* An acceptance is the absence of a qualification. A stored complaint
       beside one would make the row say two things at once, and nothing could
       decide afterwards which was meant. */
    if (category || reason) {
      return next(invalid("An acceptance carries no clarification category and no reason."));
    }
    return next();
  }

  if (this.state === RECEIPT_STATE.CLARIFICATION_REQUESTED) {
    if (!CLARIFICATION_CATEGORY.includes(category)) {
      return next(invalid("A clarification names one of the allowed categories."));
    }
    if (reason !== normalised(reason)) {
      return next(invalid("A clarification reason is stored normalised — no leading, trailing "
        + "or repeated whitespace."));
    }
    if (reason.length < MIN_REASON || reason.length > MAX_REASON) {
      return next(invalid(`A clarification reason is between ${MIN_REASON} and ${MAX_REASON} `
        + "characters, because it goes back to somebody who has to act on it."));
    }
    return next();
  }

  return next();
});

/* ══ IMMUTABILITY ═════════════════════════════════════════════════════════
   Unconditional. There is no protected-field allowlist and no "only while
   PENDING" escape, because there is no state in which editing a recorded
   decision is correct. The insert is the only accepted write.

   Note on `immutable: true` above: Mongoose enforces that on `save()` and on
   update operators, but a `replaceOne` or a raw `deleteOne` goes round it
   entirely — which is why the hooks below refuse those paths by name rather
   than trusting the field flags. */
const refuse = (what) => {
  const err = new Error(
    `A PPC release receipt is a record of a decision that was taken and cannot be ${what}.`,
  );
  err.name = "PpcIeReleaseReceiptImmutable";
  err.code = "PPC_IE_RELEASE_RECEIPT_IMMUTABLE";
  return err;
};

receiptSchema.pre("save", function refuseResave(next) {
  if (!this.isNew) return next(refuse("re-saved"));
  return next();
});

for (const op of ["updateOne", "updateMany", "findOneAndUpdate", "replaceOne", "findOneAndReplace"]) {
  receiptSchema.pre(op, function refuseWrite(next) {
    return next(refuse(op === "replaceOne" || op === "findOneAndReplace" ? "replaced" : "amended"));
  });
}

/* `findByIdAndDelete` and `findOneAndRemove` both run through
   `findOneAndDelete`; the document-level `deleteOne` needs its own
   registration because the query-level one does not cover it. */
for (const op of ["deleteOne", "deleteMany", "findOneAndDelete"]) {
  receiptSchema.pre(op, { query: true, document: false }, function refuseDelete(next) {
    return next(refuse("deleted"));
  });
}
receiptSchema.pre("deleteOne", { document: true, query: false }, function refuseDocDelete(next) {
  return next(refuse("deleted"));
});

module.exports = {
  RECEIPT_STATE, RECEIPT_STATES, CLARIFICATION_CATEGORY, EFFECTIVE_STATE,
  MIN_REASON, MAX_REASON,
  IeReleaseReceipt: mongoose.models.IeReleaseReceipt
    || mongoose.model("IeReleaseReceipt", receiptSchema),
};
