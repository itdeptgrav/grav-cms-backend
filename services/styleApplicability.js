// services/styleApplicability.js
//
// "THIS STYLE DOES NOT NEED ONE" — RECORDED BY THE DEPARTMENT THAT WOULD KNOW.
//
// ── THE DEFECT THIS CLOSES ──────────────────────────────────────────────────
// Central Costing used to let whoever was costing a garment mark a whole cost
// family "not applicable" with a reason. It was careful — a reason was
// compulsory, the decision was frozen with its author — and it was still the
// wrong desk. A person costing a garment does not know whether the customer
// supplies the packaging, whether anything goes outside, or whether a screen
// has to be made. Three other departments do, and each of them already has a
// screen where they record the requirement itself.
//
// So the decision moves to the record that holds the requirement. This file is
// the SHAPE all three write, and nothing else: no authority, no ownership
// proof, no route. Each owning service keeps its own guard and calls these to
// avoid three subtly different validators for one three-field answer.
//
// ── AND SILENCE IS NOT AN ANSWER ────────────────────────────────────────────
// `required` has no default. Absent means nobody has been asked, which is the
// state every style starts in and is exactly what Costing must go on reporting
// as outstanding. `true` and `false` are both answers somebody gave; only
// `false` needs a reason, because only `false` removes a cost.
"use strict";

const str = (v) => String(v ?? "").trim();

/** The three states, named so a screen never has to test for `undefined`. */
const DECISION = Object.freeze({
  /* Nobody has been asked. Not "no". */
  UNANSWERED: "UNANSWERED",
  /* Somebody said this style needs it. The rows are then the outstanding work. */
  REQUIRED: "REQUIRED",
  /* Somebody said it does not, and why. The only state that answers a family. */
  NOT_REQUIRED: "NOT_REQUIRED",
});

const MAX_REASON = 500;

/**
 * The stored decision, read.
 *
 * Returns a state every time, so no caller has to decide what a missing
 * sub-document means — which is where "absent reads as no" gets reintroduced.
 */
function decisionView(stored) {
  /* Idempotent: a view fed back in comes out unchanged, so a caller holding
     either the stored sub-document or the published projection reads one
     rule rather than testing which it has. */
  const required = stored?.required;
  if (required !== true && required !== false) {
    return { state: DECISION.UNANSWERED, required: null, reason: "", decidedByName: "", decidedAt: null };
  }
  /* Idempotent in the actor fields too. The stored sub-document nests them
     under `decidedBy`; this view flattens them, and a view fed back in must
     come out with the signature intact — a decision that loses its author on
     a second read is an unattributed decision, which is the thing this whole
     retirement is about. */
  const actorName = str(stored?.decidedBy?.name) || str(stored?.decidedByName);
  const actorId = stored?.decidedBy?.id ?? stored?.decidedByActorId ?? null;
  return {
    state: required ? DECISION.REQUIRED : DECISION.NOT_REQUIRED,
    required,
    reason: str(stored?.reason),
    decidedByName: actorName,
    decidedByActorId: actorId ? String(actorId) : null,
    decidedAt: stored?.decidedAt || null,
  };
}

/**
 * Validate a submitted decision and return what to store.
 *
 * @param {object} body    `{ required, reason }` as the owning route received it
 * @param {object} opts
 * @param {object|null} opts.actor  `{ id, name }` — the server's, never the body's
 * @returns {{ok:true, value:object}|{ok:false, code:string, message:string, field:string}}
 */
function parseDecision(body = {}, { actor = null } = {}) {
  const required = body?.required;
  if (required !== true && required !== false) {
    return {
      ok: false, field: "required", code: "DECISION_REQUIRED",
      message: "Say whether this style needs it. Leaving the question unanswered is not the same as answering no.",
    };
  }
  const reason = str(body?.reason).slice(0, MAX_REASON);
  /* ── A REASON, BECAUSE THIS ONE REMOVES A COST ─────────────────────────
     Without it, six months later nobody can tell a considered "the customer
     supplies all packaging" from a box somebody ticked to clear a warning.
     "Required" needs none: the rows that follow are the reason. */
  if (!required && !reason) {
    return {
      ok: false, field: "reason", code: "DECISION_REASON_REQUIRED",
      message: "Say why this style does not need it before recording that it does not.",
    };
  }
  return {
    ok: true,
    value: {
      required,
      reason: required ? "" : reason,
      /* ── THE SERVER'S ACTOR, NEVER THE BODY'S ────────────────────────
         A decision that removes a cost is signed. A client that could name
         the signer could sign somebody else's name to it. */
      decidedBy: actor?.id ? { id: actor.id, name: str(actor.name) } : undefined,
      decidedAt: new Date(),
    },
  };
}

/** The mongoose shape, so the three owning records declare one thing. */
function decisionSchemaFields(mongoose) {
  return {
    /* ── NO DEFAULT, DELIBERATELY ──────────────────────────────────────
       A default of `true` would make every style in the deployment claim
       somebody had answered; a default of `false` would remove a cost from
       every one of them. Absent is the truth about a question nobody asked. */
    required: { type: Boolean, default: undefined },
    reason: { type: String, trim: true, default: "", maxlength: MAX_REASON },
    decidedBy: {
      id: { type: mongoose.Schema.Types.ObjectId },
      name: { type: String, trim: true },
    },
    decidedAt: { type: Date },
  };
}

module.exports = { DECISION, MAX_REASON, decisionView, parseDecision, decisionSchemaFields };
