// services/storePurchase/errors.js
//
// Store & Purchase — Chunk 1. ONE ERROR SHAPE FOR EVERY REFUSAL.
//
// Six different things can stop a Store/Purchase write, and a client — the
// browser especially — has to tell them apart to react correctly: retry,
// re-authenticate, ask for access, fix the payload, or stop. Today they are
// all `{success:false, message:"..."}` and indistinguishable.
//
// Every refusal from here carries a stable machine `code` and a sentence a
// person can act on. The message never names an internal capability key or a
// raw enum — those go in `details` for the client, not in the prose.
"use strict";

const CODES = {
  UNAUTHENTICATED: { status: 401, code: "UNAUTHENTICATED" },
  FORBIDDEN: { status: 403, code: "FORBIDDEN" },
  TENANT_MEMBERSHIP_UNPROVEN: { status: 403, code: "TENANT_MEMBERSHIP_UNPROVEN" },
  TENANT_MISMATCH: { status: 400, code: "TENANT_MISMATCH" },
  SITE_NOT_PERMITTED: { status: 403, code: "SITE_NOT_PERMITTED" },
  /* No site master exists yet. Distinct from SITE_NOT_PERMITTED: the actor is
     not being refused a site they lack — there are no sites to have. */
  SITE_NOT_CONFIGURED: { status: 409, code: "SITE_NOT_CONFIGURED" },
  /* The actor holds memberships in several companies and named none. */
  COMPANY_SELECTION_REQUIRED: { status: 409, code: "COMPANY_SELECTION_REQUIRED" },
  LEGACY_ACCESS_REQUIRED: { status: 403, code: "LEGACY_ACCESS_REQUIRED" },
  NOT_FOUND: { status: 404, code: "NOT_FOUND" },
  INVALID_TRANSITION: { status: 409, code: "INVALID_TRANSITION" },
  LIFECYCLE_BLOCKED: { status: 409, code: "LIFECYCLE_BLOCKED" },
  IDEMPOTENCY_KEY_REUSED: { status: 409, code: "IDEMPOTENCY_KEY_REUSED" },
  IDEMPOTENCY_IN_PROGRESS: { status: 409, code: "IDEMPOTENCY_IN_PROGRESS" },
  IDEMPOTENCY_KEY_REQUIRED: { status: 400, code: "IDEMPOTENCY_KEY_REQUIRED" },
  POLICY_AMBIGUOUS: { status: 409, code: "POLICY_AMBIGUOUS" },
  /* An unconfigured company cannot issue. Distinct from FORBIDDEN: the actor
     may well hold the capability — the COMPANY has no rule authorising the
     commitment, and the fix is configuration, not a different signer. */
  POLICY_NOT_CONFIGURED: { status: 409, code: "POLICY_NOT_CONFIGURED" },
  /* ── A LOST RACE, NOT A BAD REQUEST ────────────────────────────────────
     An edit refused because the record moved underneath it is not the
     caller's mistake and nothing about their input is wrong — re-sending it
     unchanged will fail again. Falling through to VALIDATION returned 400
     and told them to check the form, which is unfixable advice. 409 says
     what happened: re-read and decide again.

     Additive: no existing caller uses this key, so nothing changes shape. */
  CONFLICT: { status: 409, code: "CONFLICT" },
  VALIDATION: { status: 400, code: "VALIDATION" },
};

class StorePurchaseError extends Error {
  constructor(codeKey, message, details = {}) {
    super(message);
    const spec = CODES[codeKey] || CODES.VALIDATION;
    this.name = "StorePurchaseError";
    this.code = spec.code;
    this.status = spec.status;
    this.details = details;
  }

  toResponse() {
    return {
      success: false,
      error: { code: this.code, message: this.message, details: this.details },
      /* `message` at the top level too: every existing Store screen reads
         `body.message`, and breaking those while adding a better shape would
         make this chunk a regression for every screen it did not touch. */
      message: this.message,
    };
  }
}

const fail = (codeKey, message, details) => new StorePurchaseError(codeKey, message, details);

/** Express handler: turn any thrown StorePurchaseError into its response. */
function sendError(res, err) {
  if (err instanceof StorePurchaseError) {
    return res.status(err.status).json(err.toResponse());
  }
  /* Anything else is a bug, not a refusal. Say so without leaking a stack. */
  console.error("[storePurchase] unhandled error:", err);
  return res.status(500).json({
    success: false,
    error: { code: "INTERNAL", message: "Something went wrong. Nothing was changed.", details: {} },
    message: "Something went wrong. Nothing was changed.",
  });
}

/** Wrap an async route so a thrown StorePurchaseError becomes its response. */
const handle = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch((err) => sendError(res, err));

module.exports = { StorePurchaseError, CODES, fail, sendError, handle };
