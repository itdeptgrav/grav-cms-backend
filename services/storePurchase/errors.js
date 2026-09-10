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

  /* ══ MERCHANDISING ═══════════════════════════════════════════════════
     Every code the Merchandising, Sales-development, integration and PPC
     surfaces raise. They are registered because `fail` falls through to a
     400 VALIDATION for anything it does not know — which turns a 409 stale
     revision into "check the form", advice the caller cannot act on.

     `REVISION_CONFLICT` is the one that had never been registered at all:
     three services raise it and every one of them was answering 400. */
  BULK_COMMAND_UNKNOWN: { status: 404, code: "BULK_COMMAND_UNKNOWN" },
  BULK_LIMIT_EXCEEDED: { status: 422, code: "BULK_LIMIT_EXCEEDED" },
  BULK_PREVIEW_EXPIRED: { status: 409, code: "BULK_PREVIEW_EXPIRED" },
  BULK_PREVIEW_NOT_FOUND: { status: 404, code: "BULK_PREVIEW_NOT_FOUND" },
  BULK_PREVIEW_STALE: { status: 409, code: "BULK_PREVIEW_STALE" },
  CHANGE_ALREADY_DECIDED: { status: 409, code: "CHANGE_ALREADY_DECIDED" },
  CHANGE_FIELD_NOT_ALLOWED: { status: 422, code: "CHANGE_FIELD_NOT_ALLOWED" },
  CHANGE_NOT_FOUND: { status: 404, code: "CHANGE_NOT_FOUND" },
  CHANGE_STATE_CONFLICT: { status: 409, code: "CHANGE_STATE_CONFLICT" },
  CHANGE_VERSION_STALE: { status: 409, code: "CHANGE_VERSION_STALE" },
  COMPANY_CONTEXT_UNAVAILABLE: { status: 503, code: "COMPANY_CONTEXT_UNAVAILABLE" },
  DEVELOPMENT_ALREADY_DECIDED: { status: 409, code: "DEVELOPMENT_ALREADY_DECIDED" },
  DEVELOPMENT_BOM_EMPTY: { status: 422, code: "DEVELOPMENT_BOM_EMPTY" },
  DEVELOPMENT_BOM_EXISTS: { status: 409, code: "DEVELOPMENT_BOM_EXISTS" },
  DEVELOPMENT_BOM_NOT_FOUND: { status: 404, code: "DEVELOPMENT_BOM_NOT_FOUND" },
  DEVELOPMENT_FIELD_NOT_ALLOWED: { status: 422, code: "DEVELOPMENT_FIELD_NOT_ALLOWED" },
  DEVELOPMENT_FILE_NOT_FOUND: { status: 404, code: "DEVELOPMENT_FILE_NOT_FOUND" },
  DEVELOPMENT_NOT_APPROVED: { status: 409, code: "DEVELOPMENT_NOT_APPROVED" },
  DEVELOPMENT_REQUEST_NOT_FOUND: { status: 404, code: "DEVELOPMENT_REQUEST_NOT_FOUND" },
  DEVELOPMENT_SELF_APPROVAL: { status: 409, code: "DEVELOPMENT_SELF_APPROVAL" },
  DEVELOPMENT_STATE_CONFLICT: { status: 409, code: "DEVELOPMENT_STATE_CONFLICT" },
  EXPORT_TOO_LARGE: { status: 413, code: "EXPORT_TOO_LARGE" },
  FIELD_NOT_ACCEPTED: { status: 400, code: "FIELD_NOT_ACCEPTED" },
  FILE_REVISION_CONFLICT: { status: 409, code: "FILE_REVISION_CONFLICT" },
  HANDOVER_NOT_ELIGIBLE: { status: 409, code: "HANDOVER_NOT_ELIGIBLE" },
  HANDOVER_STATE_CONFLICT: { status: 409, code: "HANDOVER_STATE_CONFLICT" },
  HANDOVER_VERSION_CONFLICT: { status: 409, code: "HANDOVER_VERSION_CONFLICT" },
  IMPACT_NOT_FOUND: { status: 404, code: "IMPACT_NOT_FOUND" },
  IMPACT_STATE_CONFLICT: { status: 409, code: "IMPACT_STATE_CONFLICT" },
  MERCHANDISING_TRANSACTION_REQUIRED: { status: 503, code: "MERCHANDISING_TRANSACTION_REQUIRED" },
  PACK_ALREADY_DECIDED: { status: 409, code: "PACK_ALREADY_DECIDED" },
  PACK_DECLARATION_REQUIRED: { status: 400, code: "PACK_DECLARATION_REQUIRED" },
  PACK_EXISTS: { status: 409, code: "PACK_EXISTS" },
  PACK_GATE_FAILED: { status: 409, code: "PACK_GATE_FAILED" },
  PACK_NOT_FOUND: { status: 404, code: "PACK_NOT_FOUND" },
  PACK_STATE_CONFLICT: { status: 409, code: "PACK_STATE_CONFLICT" },
  PRODUCT_LINE_NOT_FOUND: { status: 404, code: "PRODUCT_LINE_NOT_FOUND" },
  REPORT_UNKNOWN: { status: 404, code: "REPORT_UNKNOWN" },
  REVISION_CONFLICT: { status: 409, code: "REVISION_CONFLICT" },
  SELECTION_ADOPTION_NOT_ELIGIBLE: { status: 409, code: "SELECTION_ADOPTION_NOT_ELIGIBLE" },
  SELECTION_APPROVAL_SEPARATION: { status: 409, code: "SELECTION_APPROVAL_SEPARATION" },
  SELECTION_DRAFT_EXISTS: { status: 409, code: "SELECTION_DRAFT_EXISTS" },
  SELECTION_REVISION_CONFLICT: { status: 409, code: "SELECTION_REVISION_CONFLICT" },
  SELECTION_REVISION_NOT_FOUND: { status: 404, code: "SELECTION_REVISION_NOT_FOUND" },
  SELECTION_ROW_NOT_FOUND: { status: 404, code: "SELECTION_ROW_NOT_FOUND" },
  SELECTION_STATE_CONFLICT: { status: 409, code: "SELECTION_STATE_CONFLICT" },
  SELECTION_UNIT_UNKNOWN: { status: 400, code: "SELECTION_UNIT_UNKNOWN" },
  TNA_BASELINE_EXISTS: { status: 409, code: "TNA_BASELINE_EXISTS" },
  TNA_BASELINE_REQUIRED: { status: 409, code: "TNA_BASELINE_REQUIRED" },
  TNA_CALENDAR_HORIZON: { status: 409, code: "TNA_CALENDAR_HORIZON" },
  TNA_DEPENDENCY_CYCLE: { status: 400, code: "TNA_DEPENDENCY_CYCLE" },
  TNA_DEPENDENCY_UNKNOWN_CODE: { status: 400, code: "TNA_DEPENDENCY_UNKNOWN_CODE" },
  TNA_IMPACT_STALE: { status: 409, code: "TNA_IMPACT_STALE" },
  TNA_MILESTONE_NOT_FOUND: { status: 404, code: "TNA_MILESTONE_NOT_FOUND" },
  TNA_PLAN_EXISTS: { status: 409, code: "TNA_PLAN_EXISTS" },
  TNA_PLAN_NOT_FOUND: { status: 404, code: "TNA_PLAN_NOT_FOUND" },
  TNA_REASON_REQUIRED: { status: 400, code: "TNA_REASON_REQUIRED" },
  TNA_SELF_APPROVAL: { status: 409, code: "TNA_SELF_APPROVAL" },
  TNA_SOURCE_OWNED: { status: 409, code: "TNA_SOURCE_OWNED" },
  TNA_STATE_CONFLICT: { status: 409, code: "TNA_STATE_CONFLICT" },
  TNA_TEMPLATE_AMBIGUOUS: { status: 409, code: "TNA_TEMPLATE_AMBIGUOUS" },
  TNA_TEMPLATE_IMMUTABLE: { status: 409, code: "TNA_TEMPLATE_IMMUTABLE" },
  TNA_TEMPLATE_NOT_FOUND: { status: 404, code: "TNA_TEMPLATE_NOT_FOUND" },
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
