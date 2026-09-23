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
  /* ── THE LOOKUP BROKE, WHICH IS NOT AN ANSWER ──────────────────────────
     A membership or company query that FAILS is not the same fact as one
     that returns nothing, and the two must never share a response. An
     unreachable database answered as "you are not a member" sends the user
     to an administrator to fix an access problem they do not have — and, far
     worse, it lets a fail-closed rule be reached by breaking the query it
     depends on. 503 says what is true: ask again shortly.

     Additive: no existing caller uses this key. */
  COMPANY_CONTEXT_UNAVAILABLE: { status: 503, code: "COMPANY_CONTEXT_UNAVAILABLE" },
  /* A shape the server understands, models and will support — but not yet.
     Distinct from VALIDATION, which says the caller made a mistake: this says
     the caller did not, and the feature is not finished. Stable, so a client
     can offer the option and label it rather than guessing from prose. */
  CONTEXT_NOT_SUPPORTED_YET: { status: 400, code: "CONTEXT_NOT_SUPPORTED_YET" },
  /* ── THE COMPANY HAS NOT DECIDED YET ───────────────────────────────────
     Not a mistake by the caller and not a permission problem: costing cannot
     recommend a price for a company that has never said what margin it wants.
     Distinct from VALIDATION because the fix is a configuration screen
     somebody else may have to open, not a field on this form. */
  COSTING_POLICY_REQUIRED: { status: 409, code: "COSTING_POLICY_REQUIRED" },
  /* ── SOMEBODY ELSE SAVED FIRST ─────────────────────────────────────────
     An optimistic-concurrency refusal. The caller's input is not wrong; it was
     composed against a policy that has since moved, and applying it would
     silently erase the other change. Re-read and decide again. */
  POLICY_REVISION_CONFLICT: { status: 409, code: "POLICY_REVISION_CONFLICT" },
  /* ── A PERMANENT IDENTITY CANNOT BE WITHDRAWN BY OMISSION ──────────────
     A development charge key is pointed at by requirements on styles and by
     the frozen provenance of versions approved months ago. Dropping it from
     the table would leave the first unpriceable and the second unexplainable.
     409 rather than 400 because nothing about the request is malformed — it
     asks for something the record does not permit, and the fix is to
     deactivate the charge instead. */
  DEVELOPMENT_CHARGE_KEY_REMOVED: { status: 409, code: "DEVELOPMENT_CHARGE_KEY_REMOVED" },
  /* And a customs duty rule, on exactly the same terms: a frozen costing names
     the rule key it was duty-rated under, so a key may be deactivated but
     never removed. 409 rather than 400 — the request is well formed and the
     answer is a state the caller has to resolve. */
  DUTY_RULE_KEY_REMOVED: { status: 409, code: "DUTY_RULE_KEY_REMOVED" },

  /* ── PRODUCTION'S ROUTE AND STANDARD TIME ────────────────────────────────
   * Registered here rather than left to fall through to VALIDATION, which is
   * what an unlisted code does — a client branching on the code would have
   * received "VALIDATION" for a route that is with Sales, a route naming an
   * operation nobody registered, and a body carrying a labour rate alike,
   * and those need three different answers.
   *
   * 409 for the state the caller lost to; 400 for what the request itself
   * says, which retrying unchanged cannot fix.
   *
   * Additive: no existing caller uses these keys, so nothing changes shape. */
  STYLE_ROUTE_NOT_EDITABLE: { status: 409, code: "STYLE_ROUTE_NOT_EDITABLE" },
  OPERATION_NOT_REGISTERED: { status: 400, code: "OPERATION_NOT_REGISTERED" },
  /* The same refusal for the Service Master: a requirement naming a service
     this company does not hold, or one that is no longer active. Distinct from
     VALIDATION — the body is well formed and names something real-looking, and
     the fix is the register rather than the field. */
  SERVICE_NOT_REGISTERED: { status: 400, code: "SERVICE_NOT_REGISTERED" },
  /* A development requirement naming a company charge Finance has not
     published. The fix is the policy table, not the requirement. */
  DEVELOPMENT_CHARGE_NOT_CONFIGURED: { status: 400, code: "DEVELOPMENT_CHARGE_NOT_CONFIGURED" },
  FIELD_NOT_ACCEPTED: { status: 400, code: "FIELD_NOT_ACCEPTED" },

  /* ── BOARD POLICY (Board & Executive — financing methodology) ─────────────
   * A company-wide decision has a lifecycle, and most of the ways it can go
   * wrong are STATES rather than bad fields: editing something already
   * approved, approving a date another approved version already holds, or
   * calculating for a company whose Board has not decided yet.
   *
   * Registered rather than left to fall through to VALIDATION — which is what
   * an unlisted key silently becomes — so a screen can tell "this is
   * immutable" from "somebody beat you to that date" from "your form is
   * incomplete". */
  BOARD_POLICY_NOT_FOUND: { status: 404, code: "BOARD_POLICY_NOT_FOUND" },
  BOARD_POLICY_IMMUTABLE: { status: 409, code: "BOARD_POLICY_IMMUTABLE" },
  BOARD_POLICY_REVISION_CONFLICT: { status: 409, code: "BOARD_POLICY_REVISION_CONFLICT" },
  BOARD_POLICY_EFFECTIVE_DATE_TAKEN: { status: 409, code: "BOARD_POLICY_EFFECTIVE_DATE_TAKEN" },
  BOARD_POLICY_INCOMPLETE: { status: 400, code: "BOARD_POLICY_INCOMPLETE" },
  BOARD_ACCESS_REQUIRED: { status: 403, code: "BOARD_ACCESS_REQUIRED" },
  /* The legacy financing fields on `CostingPolicy`, refused on write. Not
     VALIDATION: the value is fine and the FIELD has moved. */
  FINANCING_POLICY_MOVED: { status: 409, code: "FINANCING_POLICY_MOVED" },
  /* And the legacy overhead fields, on the same terms and for the same
     reason. Distinct from the financing code so a stale client can say which
     rule moved rather than "a policy field moved" — the two are set on
     different screens by different people. */
  OVERHEAD_POLICY_MOVED: { status: 409, code: "OVERHEAD_POLICY_MOVED" },
  /* And the four labour assumptions, on the same terms. Its own code rather
     than a shared "a policy field moved": the three retired families are set
     on different screens by different people, and a client that can say which
     one moved can send them to the right place. */
  LABOUR_POLICY_MOVED: { status: 409, code: "LABOUR_POLICY_MOVED" },
  /* And the input GST treatment, on the same terms. Its own code so a stale
     client can say which rule moved — the four retired families are set on
     different screens by different people. */
  GST_POLICY_MOVED: { status: 409, code: "GST_POLICY_MOVED" },
  /* And the development charge table, on the same terms. Its own code so a
     stale client can say which rule moved — the five retired families are set
     on different screens by different people. */
  DEVELOPMENT_POLICY_MOVED: { status: 409, code: "DEVELOPMENT_POLICY_MOVED" },
  /* And the contingency rule, on the same terms. Its own code so a stale
     client can say which rule moved — the six retired families are set on
     different screens by different people. */
  CONTINGENCY_POLICY_MOVED: { status: 409, code: "CONTINGENCY_POLICY_MOVED" },
  /* And the margin band with its two profit assumptions, on the same terms.
     The seventh and last of the retired families. */
  MARGIN_POLICY_MOVED: { status: 409, code: "MARGIN_POLICY_MOVED" },
  /* ── AND THE ONE ABSENCE THAT STOPS A COSTING ───────────────────────────
     Every other Board policy leaves a named gap in a costing that still
     calculates. Without an approved margin band there is no price to solve
     for, so this is a refusal — 409 rather than 400, because the request is
     well formed and the answer is a state the company has to fix. */
  MARGIN_POLICY_REQUIRED: { status: 409, code: "MARGIN_POLICY_REQUIRED" },

  /* ── CENTRAL COSTING LIFECYCLE (Chunk 6A) ────────────────────────────────
   * Registered here rather than left to fall through to VALIDATION, which is
   * what an unlisted code does — and a client branching on the code would
   * have received "VALIDATION" for every one of them, with no way to tell a
   * missing approval note from a version somebody else had already approved.
   *
   * 409 for the three that describe a STATE the caller lost a race with or
   * asked to skip; 400 for the three that describe the REQUEST or the
   * version's own content, which retrying unchanged cannot fix. */
  COSTING_INVALID_TRANSITION: { status: 409, code: "COSTING_INVALID_TRANSITION" },
  COSTING_VERSION_STATE_CONFLICT: { status: 409, code: "COSTING_VERSION_STATE_CONFLICT" },
  COSTING_APPROVAL_CONFLICT: { status: 409, code: "COSTING_APPROVAL_CONFLICT" },
  COSTING_APPROVAL_NOTE_REQUIRED: { status: 400, code: "COSTING_APPROVAL_NOTE_REQUIRED" },
  COSTING_VERSION_NOT_CALCULATED: { status: 400, code: "COSTING_VERSION_NOT_CALCULATED" },
  COSTING_FROZEN_FACTS_INCOMPLETE: { status: 400, code: "COSTING_FROZEN_FACTS_INCOMPLETE" },
  /* 503, and retryable: nothing is wrong with the request. The DEPLOYMENT
     cannot give the operation atomicity, and a costing that cannot be
     approved is a visible problem somebody fixes — where a half-approved one
     is not. */
  SUPPLIER_OFFER_SUBJECT_MISMATCH: { status: 409, code: "SUPPLIER_OFFER_SUBJECT_MISMATCH" },

  /* ── COSTING FROM A SUPPLIER QUOTATION (Chunk 3.2) ───────────────────────
   * Each names why a chosen offer cannot price a line, so the screen can say
   * it beside the offer the person picked rather than sending them back to
   * guess. 409 where the offer or the request is wrong; 422 where the data
   * needed to price it honestly does not exist. */
  SUPPLIER_OFFER_IMMUTABLE: { status: 409, code: "SUPPLIER_OFFER_IMMUTABLE" },
  COSTING_OFFER_NOT_USABLE: { status: 409, code: "COSTING_OFFER_NOT_USABLE" },
  COSTING_OFFER_SUBJECT_MISMATCH: { status: 409, code: "COSTING_OFFER_SUBJECT_MISMATCH" },
  COSTING_OFFER_CONVERSION_NOT_CONFIGURED: { status: 422, code: "COSTING_OFFER_CONVERSION_NOT_CONFIGURED" },
  COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED: { status: 422, code: "COSTING_OFFER_CURRENCY_CONVERSION_REQUIRED" },
  COSTING_OFFER_GST_NOT_RECORDED: { status: 422, code: "COSTING_OFFER_GST_NOT_RECORDED" },
  /* The engine carries one rate per line across every scenario. */
  COSTING_OFFER_TIER_VARIES_BY_SCENARIO: { status: 422, code: "COSTING_OFFER_TIER_VARIES_BY_SCENARIO" },
  /* Tiers were quoted and none of them reaches the supplier quantity. */
  COSTING_OFFER_NO_QUANTITY_TIER: { status: 422, code: "COSTING_OFFER_NO_QUANTITY_TIER" },
  /* Chunk 4A — importing an approved style's materials and operations. */
  /* A calculation carrying a Costing-side "this family does not apply". The
     decision belongs to the department that owns the fact, and Costing reads
     it — so a payload holding one is a stale screen, and is told where the
     answer is now recorded rather than having its value dropped. */
  /* ── THE SALES COSTING BRIEF ────────────────────────────────────────
     What to cost is a commercial question. Sales confirms a brief against an
     approved style; Costing reads it and cannot be sent one. */
  /* Preparing an estimate is a Sales action now. The costing app's own
     Calculate route refuses a browser client and names the destination; the
     orchestration service behind Sales calls the same engine unchanged. */
  COSTING_PREPARATION_MOVED_TO_SALES: { status: 409, code: "COSTING_PREPARATION_MOVED_TO_SALES" },
  COSTING_BRIEF_REQUIRED: { status: 409, code: "COSTING_BRIEF_REQUIRED" },
  /* ── ASKED FOR AN ESTIMATE WITHOUT THE GRANT TO ASK ──────────────────
     403, not 404: the caller has already proved they may reach this enquiry,
     so pretending it does not exist would be a lie they can disprove by
     reloading the page they are looking at. What is refused is the ACTION,
     and saying so is what lets a screen stop offering it. A caller who may
     not reach the enquiry never gets this far — that is a 404 from the scope
     resolution, and the two must not be confused. */
  COSTING_PREPARE_FORBIDDEN: { status: 403, code: "COSTING_PREPARE_FORBIDDEN" },
  /* ── THE COMMERCIAL REVIEW ────────────────────────────────────────────
     Deciding whether a price may be quoted. Each refusal is its own code so
     a screen can tell "you may not" from "not this way" from "not this
     version" — three different things a person does three different things
     about. */
  COSTING_REVIEW_FORBIDDEN: { status: 403, code: "COSTING_REVIEW_FORBIDDEN" },
  COSTING_REVIEW_NOT_REVIEWABLE: { status: 409, code: "COSTING_REVIEW_NOT_REVIEWABLE" },
  COSTING_REVIEW_REASON_REQUIRED: { status: 400, code: "COSTING_REVIEW_REASON_REQUIRED" },
  /* Below the floor, and the ordinary approver cannot clear it. 403 rather
     than 409: it is an authority answer, and it names the one that applies. */
  COSTING_REVIEW_EXCEPTION_REQUIRED: { status: 403, code: "COSTING_REVIEW_EXCEPTION_REQUIRED" },
  COSTING_REVIEW_NOT_AN_EXCEPTION: { status: 409, code: "COSTING_REVIEW_NOT_AN_EXCEPTION" },
  COSTING_REVIEW_STALE_VERSION: { status: 409, code: "COSTING_REVIEW_STALE_VERSION" },
  COSTING_REVIEW_WRONG_STATE: { status: 409, code: "COSTING_REVIEW_WRONG_STATE" },
  /* The sources behind THIS version moved — distinct from a newer version
     existing, because the fix is different: refresh, do not go and read
     another one. */
  COSTING_REVIEW_STALE_INPUTS: { status: 409, code: "COSTING_REVIEW_STALE_INPUTS" },
  /* Freshness could not be established. 503 and retryable: the caller did
     nothing wrong and the same request may well succeed shortly. */
  COSTING_REVIEW_FRESHNESS_UNAVAILABLE: { status: 503, code: "COSTING_REVIEW_FRESHNESS_UNAVAILABLE" },

  /* ── RELEASING APPROVED DEMAND FOR A CONFIRMED ORDER ──────────────────
     An approved costing says a price may be QUOTED. Committing the company
     to buy against it needs a confirmed order, and these are the ways that
     can fail. Each is its own code because each has a different fix. */
  DEMAND_RELEASE_FORBIDDEN: { status: 403, code: "DEMAND_RELEASE_FORBIDDEN" },
  /* A precondition is missing — not confirmed, not approved, not frozen. */
  DEMAND_RELEASE_NOT_ELIGIBLE: { status: 409, code: "DEMAND_RELEASE_NOT_ELIGIBLE" },
  /* The ordered quantity is not one this costing was approved for. Its own
     code because the fix is specific and nothing else will do: recost. */
  DEMAND_RELEASE_RECOST_REQUIRED: { status: 409, code: "DEMAND_RELEASE_RECOST_REQUIRED" },
  DEMAND_RELEASE_IDENTITY_REQUIRED: { status: 400, code: "DEMAND_RELEASE_IDENTITY_REQUIRED" },
  /* Demand released earlier for this line is still operational. A successor
     now would let Store buy the same order line twice, so it is refused until
     the earlier requests are closed through their OWN workflow. */
  DEMAND_RELEASE_RECONCILIATION_REQUIRED: { status: 409, code: "DEMAND_RELEASE_RECONCILIATION_REQUIRED" },
  /* ── THE FILE-SCOPED DOOR ────────────────────────────────────────────────
     A file that cannot be turned into a release command, and a file that now
     resolves to a different approved costing than the one the caller read. */
  /* ── SALES' OWN QUANTITY COMMAND ─────────────────────────────────────────
     The commercial line: which product line is being quoted, and for how
     many. A line the enquiry does not carry is its own refusal, so a screen
     can tell "you named a line that is not here" from "that number is not a
     quantity". */
  COMMERCIAL_LINE_VALIDATION: { status: 400, code: "COMMERCIAL_LINE_VALIDATION" },
  COMMERCIAL_LINE_NOT_FOUND: { status: 404, code: "COMMERCIAL_LINE_NOT_FOUND" },
  DEMAND_RELEASE_FILE_NOT_RESOLVABLE: { status: 409, code: "DEMAND_RELEASE_FILE_NOT_RESOLVABLE" },
  DEMAND_RELEASE_EXPECTED_VERSION_REQUIRED: { status: 400, code: "DEMAND_RELEASE_EXPECTED_VERSION_REQUIRED" },
  DEMAND_RELEASE_VERSION_CHANGED: { status: 409, code: "DEMAND_RELEASE_VERSION_CHANGED" },
  /* Both are the caller failing to say what they are deciding about, and
     both must be refused rather than guessed at. */
  COSTING_REVIEW_VERSION_REQUIRED: { status: 400, code: "COSTING_REVIEW_VERSION_REQUIRED" },
  COSTING_REVIEW_KEY_REQUIRED: { status: 400, code: "COSTING_REVIEW_KEY_REQUIRED" },
  COSTING_BRIEF_MOVED: { status: 400, code: "COSTING_BRIEF_MOVED" },
  COSTING_BRIEF_STYLE_NOT_APPROVED: { status: 409, code: "COSTING_BRIEF_STYLE_NOT_APPROVED" },
  COSTING_BRIEF_NOT_CONFIRMABLE: { status: 409, code: "COSTING_BRIEF_NOT_CONFIRMABLE" },
  COSTING_BRIEF_SUPERSEDED: { status: 409, code: "COSTING_BRIEF_SUPERSEDED" },
  COSTING_BRIEF_REVISION_CONFLICT: { status: 409, code: "COSTING_BRIEF_REVISION_CONFLICT" },
  COSTING_APPLICABILITY_DECISION_MOVED: { status: 400, code: "COSTING_APPLICABILITY_DECISION_MOVED" },
  COSTING_TECHNICAL_CONTEXT_NOT_SUPPORTED: { status: 422, code: "COSTING_TECHNICAL_CONTEXT_NOT_SUPPORTED" },
  /* Several sibling variant styles: a choice, never resolved by ordering. */
  COSTING_TECHNICAL_SEVERAL_STYLES: { status: 409, code: "COSTING_TECHNICAL_SEVERAL_STYLES" },
  COSTING_TECHNICAL_READ_CONTEXT_REQUIRED: { status: 500, code: "COSTING_TECHNICAL_READ_CONTEXT_REQUIRED" },
  COSTING_TECHNICAL_BASIS_UNCONFIRMED: { status: 422, code: "COSTING_TECHNICAL_BASIS_UNCONFIRMED" },
  /* A style that is not one of THIS costing's enquiry-product candidates. */
  COSTING_TECHNICAL_STYLE_MISMATCH: { status: 409, code: "COSTING_TECHNICAL_STYLE_MISMATCH" },
  /* The record moved between the preview and the calculation, so the person
     is costing something they have not seen. Actionable: refresh and re-import. */
  COSTING_TECHNICAL_SOURCE_CHANGED: { status: 409, code: "COSTING_TECHNICAL_SOURCE_CHANGED" },
  COSTING_TECHNICAL_STYLE_REQUIRED: { status: 400, code: "COSTING_TECHNICAL_STYLE_REQUIRED" },
  /* Chunk 4C — a cost family nobody has answered blocks review and approval.
     409: the request is well formed; the costing is not ready for it. */
  COSTING_COST_INCOMPLETE: { status: 409, code: "COSTING_COST_INCOMPLETE" },
  /* ── A QUANTITY THE SUPPLIER CANNOT SUPPLY ────────────────────────────────
     422, not 400: the request is well formed and the quotation is real. What
     fails is the commercial fit between them, which is the buyer's to resolve
     with the supplier — not a field to correct on the form. */
  /* 422 as well: the request is well formed and the quotation is real — what
     changed is the supplier relationship, which is somebody's to resolve. */
  /* ── A SOURCE-BACKED COSTING WITH NO SOURCE ───────────────────────────────
     409, because the request is well formed and the refusal is about the state
     of the company's records: R&D has not submitted the technical record, or
     there are two and nobody has chosen. Both are resolved elsewhere and then
     the same request succeeds. */
  COSTING_AWAITING_SOURCE: { status: 409, code: "COSTING_AWAITING_SOURCE" },
  /* 400: the request itself is wrong — a figure was sent as a cost line by a
     caller that may not state one. The fix is not here: the fact belongs in
     the application that owns it, and the refusal names which. */
  COSTING_MANUAL_LINE_REFUSED: { status: 400, code: "COSTING_MANUAL_LINE_REFUSED" },
  /* ── A FIGURE TYPED INTO COSTING, WHICH NOTHING ACCEPTS ANY MORE ─────────
     400, because the request is malformed against the current contract rather
     than blocked by the state of the company's records — a caller that
     retries unchanged gets the same answer, and the person has to go
     somewhere else.

     A provisional override was once the only answer to a cost family no
     record in this repository could supply. Every family has an owning
     application now, so the payload is refused BY NAME and told which one,
     rather than stripped and calculated anyway: silently dropping it leaves
     somebody believing a figure they entered is in the costing.

     Frozen versions that already carry legacy overrides are untouched —
     nothing here runs on a read. */
  COSTING_MANUAL_INPUT_RETIRED: { status: 400, code: "COSTING_MANUAL_INPUT_RETIRED" },
  /* ── WHICH SUPPLIER PRICES A COSTING IS STORE'S TO SAY ───────────────────
     400: the request is malformed against the current contract. A costing
     used to carry the choice in its calculation payload; the decision now
     lives in the Store app, and a payload still carrying one is a stale or
     tampered client naming the supplier a costing is priced from. Refused by
     name and pointed at Store — never stripped, which would leave somebody
     believing their choice was applied. */
  COSTING_QUOTATION_CHOICE_MOVED: { status: 400, code: "COSTING_QUOTATION_CHOICE_MOVED" },
  /* 409: the request is well formed and the refusal is about the state of the
     records — the requirement is not waiting for a decision, because it was
     answered already or the costing moved under it. Retrying unchanged gets
     the same answer; re-reading the queue does not. */
  SOURCING_DECISION_NOT_OPEN: { status: 409, code: "SOURCING_DECISION_NOT_OPEN" },
  /* 422: the quotation and the requirement are each real and do not meet at
     these quantities, on this date, in this unit — a correction to one of the
     two records rather than a malformed request. */
  SOURCING_DECISION_OFFER_NOT_APPLICABLE: { status: 422, code: "SOURCING_DECISION_OFFER_NOT_APPLICABLE" },
  /* 404 for both missing and foreign: a company may not learn which costing
     ids are real by asking about them. */
  SOURCING_DECISION_COSTING_NOT_FOUND: { status: 404, code: "SOURCING_DECISION_COSTING_NOT_FOUND" },
  SOURCING_DECISION_NOT_FOUND: { status: 404, code: "SOURCING_DECISION_NOT_FOUND" },
  /* 400: the request asked for something the domain no longer offers, and the
     caller can fix it by naming the enquiry product. */
  COSTING_ADHOC_CREATION_CLOSED: { status: 400, code: "COSTING_ADHOC_CREATION_CLOSED" },
  /* 409: the record is real and readable; what is refused is moving it. */
  COSTING_ADHOC_READ_ONLY: { status: 409, code: "COSTING_ADHOC_READ_ONLY" },
  /* 409: the sources are readable and the costing is real — what is missing
     is an input somebody outside this request has to supply. Raised when the
     blocking gap has no single quotation reason to name; where one quotation
     was excluded for one reason, that reason's own code is raised instead. */
  COSTING_ASSEMBLY_BLOCKED: { status: 409, code: "COSTING_ASSEMBLY_BLOCKED" },
  /* Outside services. The quantity refusals reuse the material codes above —
     below a minimum, off a multiple and past every quoted band are the same
     commercial facts — and these are the ones a service has that a material
     has not. */
  COSTING_SERVICE_OFFER_NOT_USABLE: { status: 409, code: "COSTING_SERVICE_OFFER_NOT_USABLE" },
  COSTING_SERVICE_OFFER_SUBJECT_MISMATCH: { status: 409, code: "COSTING_SERVICE_OFFER_SUBJECT_MISMATCH" },
  /* 422: the requirement and the quotation are each fine and do not meet. A
     service billing unit has no conversion factor to configure, so this is a
     correction to one of the two records rather than a missing setting. */
  COSTING_SERVICE_UNIT_MISMATCH: { status: 422, code: "COSTING_SERVICE_UNIT_MISMATCH" },
  COSTING_SERVICE_QUANTITY_REQUIRED: { status: 400, code: "COSTING_SERVICE_QUANTITY_REQUIRED" },
  COSTING_SERVICE_INACTIVE: { status: 422, code: "COSTING_SERVICE_INACTIVE" },
  /* 503, and retryable: one of the records a costing is assembled from could
     not be read. Distinct from a gap — nothing has been established about
     what the register holds, and answering as though it held nothing would
     turn a database blip into a commercial statement. */
  COSTING_SOURCE_UNAVAILABLE: { status: 503, code: "COSTING_SOURCE_UNAVAILABLE" },
  COSTING_OFFER_INACTIVE_SUPPLIER: { status: 422, code: "COSTING_OFFER_INACTIVE_SUPPLIER" },
  COSTING_OFFER_BELOW_MOQ: { status: 422, code: "COSTING_OFFER_BELOW_MOQ" },
  COSTING_OFFER_NOT_AN_ORDER_MULTIPLE: { status: 422, code: "COSTING_OFFER_NOT_AN_ORDER_MULTIPLE" },
  /* 400: this one IS a field on the form — nobody said whether the GST is
     recoverable, and the person can answer it where they are. */
  COSTING_OFFER_TAX_TREATMENT_REQUIRED: { status: 400, code: "COSTING_OFFER_TAX_TREATMENT_REQUIRED" },
  COSTING_OFFER_TAX_TREATMENT_NOT_ALLOWED: { status: 400, code: "COSTING_OFFER_TAX_TREATMENT_NOT_ALLOWED" },
  COSTING_OFFER_LINE_NOT_ELIGIBLE: { status: 400, code: "COSTING_OFFER_LINE_NOT_ELIGIBLE" },
  COSTING_OFFER_CONSUMPTION_REQUIRED: { status: 400, code: "COSTING_OFFER_CONSUMPTION_REQUIRED" },
  COSTING_OFFER_SCENARIO_QUANTITY_REQUIRED: { status: 400, code: "COSTING_OFFER_SCENARIO_QUANTITY_REQUIRED" },
  SUPPLIER_OFFER_NOT_ACTIVE: { status: 409, code: "SUPPLIER_OFFER_NOT_ACTIVE" },
  SUPPLIER_OFFER_ALREADY_SUPERSEDED: { status: 409, code: "SUPPLIER_OFFER_ALREADY_SUPERSEDED" },
  SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED: { status: 400, code: "SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED" },
  /* Retryable: nothing is wrong with the request. */
  SUPPLIER_OFFER_TRANSACTION_REQUIRED: { status: 503, code: "SUPPLIER_OFFER_TRANSACTION_REQUIRED" },
  COSTING_APPROVAL_TRANSACTION_REQUIRED: {
    status: 503, code: "COSTING_APPROVAL_TRANSACTION_REQUIRED",
  },

  /* ── SUPPLIER OFFER REGISTER (Chunk 3.1) ─────────────────────────────────
   * Registered rather than left to fall through to VALIDATION, which is what
   * an unlisted code does — a client branching on the code would have got
   * "VALIDATION" for a missing withdrawal reason and for an offer somebody
   * else had already revised, with no way to tell them apart. */
  SUPPLIER_OFFER_NOT_ACTIVE: { status: 409, code: "SUPPLIER_OFFER_NOT_ACTIVE" },
  SUPPLIER_OFFER_ALREADY_SUPERSEDED: { status: 409, code: "SUPPLIER_OFFER_ALREADY_SUPERSEDED" },
  SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED: {
    status: 400, code: "SUPPLIER_OFFER_WITHDRAWAL_REASON_REQUIRED",
  },
  /* ── A GUARANTEE THAT COULD NOT BE MADE DURABLE ────────────────────────
     The bookkeeping that permanently binds an idempotency key could not be
     written. The domain work may well have succeeded — but reporting success
     would leave the key unbound, which is precisely the failure that
     bookkeeping exists to prevent. So the caller is told to retry, and the
     retry finishes the record rather than repeating the work. Retryable, and
     an infrastructure fault rather than the caller's mistake: 503. */
  COSTING_CLAIM_PERSISTENCE_FAILED: { status: 503, code: "COSTING_CLAIM_PERSISTENCE_FAILED" },
  /* ── WAREHOUSE STOCK COUNT (V1) ────────────────────────────────────────────
     Posting a count is one atomic, multi-authority correction — the company
     on-hand, the location ledger and the valuation input move together or not
     at all. A deployment without transactions cannot make that promise, so the
     post is refused BEFORE the first write rather than attempted in pieces.
     Retryable: the same post against a replica set succeeds unchanged. */
  STOCK_COUNT_TRANSACTION_REQUIRED: { status: 503, code: "STOCK_COUNT_TRANSACTION_REQUIRED" },
  /* ── MERCHANDISING HANDOVER AND EXECUTION FILE (M1/M2) ───────────────────
   * Registered rather than left to fall through to VALIDATION — a client
   * branching on the code needs to tell "somebody issued a newer version
   * while you were reading" (re-read and decide again) from "your form is
   * wrong" (fix it here), and 503 for the one case where the deployment
   * cannot give acceptance its atomicity. Additive: no existing caller uses
   * these keys. */
  HANDOVER_NOT_ELIGIBLE: { status: 409, code: "HANDOVER_NOT_ELIGIBLE" },
  HANDOVER_VERSION_CONFLICT: { status: 409, code: "HANDOVER_VERSION_CONFLICT" },
  HANDOVER_STATE_CONFLICT: { status: 409, code: "HANDOVER_STATE_CONFLICT" },
  FILE_REVISION_CONFLICT: { status: 409, code: "FILE_REVISION_CONFLICT" },
  MERCHANDISING_TRANSACTION_REQUIRED: { status: 503, code: "MERCHANDISING_TRANSACTION_REQUIRED" },

  /* ── MERCHANDISING SELECTIONS — MATERIALS, TRIMS AND PACKAGING (M3) ──────
     One vocabulary for both revision families: they share a lifecycle, so a
     client that learns these codes for the Trim Card already knows them for
     the Packaging specification. */
  SELECTION_REVISION_NOT_FOUND: { status: 404, code: "SELECTION_REVISION_NOT_FOUND" },
  /* The revision is not in a state where this command means anything —
     editing an approved revision, submitting an empty one, approving one
     nobody submitted. */
  SELECTION_STATE_CONFLICT: { status: 409, code: "SELECTION_STATE_CONFLICT" },
  /* A draft (or a submitted revision) already exists for this file and
     family. Two people cannot edit two "current" drafts of one truth. */
  SELECTION_DRAFT_EXISTS: { status: 409, code: "SELECTION_DRAFT_EXISTS" },
  /* Somebody changed the revision between the read and the write. */
  SELECTION_REVISION_CONFLICT: { status: 409, code: "SELECTION_REVISION_CONFLICT" },
  /* The approver authored or submitted this revision. Maker and checker are
     different people, and an owner is not an exception. */
  SELECTION_APPROVAL_SEPARATION: { status: 409, code: "SELECTION_APPROVAL_SEPARATION" },
  SELECTION_ROW_NOT_FOUND: { status: 404, code: "SELECTION_ROW_NOT_FOUND" },
  /* An applicability reference that is not an execution unit of THIS file. */
  SELECTION_UNIT_UNKNOWN: { status: 400, code: "SELECTION_UNIT_UNKNOWN" },
  /* Transitional packaging data that cannot be adopted truthfully. */
  SELECTION_ADOPTION_NOT_ELIGIBLE: { status: 409, code: "SELECTION_ADOPTION_NOT_ELIGIBLE" },

  /* ── MERCHANDISING TIME & ACTION (M5) ────────────────────────────────────
     One vocabulary for the plan, its template, its calendar and its moves. */
  TNA_PLAN_NOT_FOUND: { status: 404, code: "TNA_PLAN_NOT_FOUND" },
  TNA_PLAN_EXISTS: { status: 409, code: "TNA_PLAN_EXISTS" },
  TNA_TEMPLATE_NOT_FOUND: { status: 404, code: "TNA_TEMPLATE_NOT_FOUND" },
  /* Two template versions fit this file equally well. Refused rather than
     resolved by whichever was configured first — the process must not depend
     on the order somebody happened to set it up. */
  TNA_TEMPLATE_AMBIGUOUS: { status: 409, code: "TNA_TEMPLATE_AMBIGUOUS" },
  TNA_TEMPLATE_IMMUTABLE: { status: 409, code: "TNA_TEMPLATE_IMMUTABLE" },
  TNA_DEPENDENCY_CYCLE: { status: 400, code: "TNA_DEPENDENCY_CYCLE" },
  TNA_DEPENDENCY_UNKNOWN_CODE: { status: 400, code: "TNA_DEPENDENCY_UNKNOWN_CODE" },
  /* The calendar cannot answer that far ahead. A real operational signal,
     not a shrug: somebody must extend it. */
  TNA_CALENDAR_HORIZON: { status: 409, code: "TNA_CALENDAR_HORIZON" },
  TNA_BASELINE_EXISTS: { status: 409, code: "TNA_BASELINE_EXISTS" },
  TNA_BASELINE_REQUIRED: { status: 409, code: "TNA_BASELINE_REQUIRED" },
  TNA_BASELINE_IMMUTABLE: { status: 409, code: "TNA_BASELINE_IMMUTABLE" },
  TNA_MILESTONE_NOT_FOUND: { status: 404, code: "TNA_MILESTONE_NOT_FOUND" },
  /* The department that owns the fact has to be the one that reports it. */
  TNA_SOURCE_OWNED: { status: 409, code: "TNA_SOURCE_OWNED" },
  /* The plan moved between the preview and the approval, so the impact the
     approver was shown is no longer the impact they would be approving. */
  TNA_IMPACT_STALE: { status: 409, code: "TNA_IMPACT_STALE" },
  /* ── THE PRE-PRODUCTION MEETING ─────────────────────────────────────── */
  PPM_NOT_FOUND: { status: 404, code: "PPM_NOT_FOUND" },
  /* A draft already exists on this file, or an issued version already does. */
  PPM_STATE_CONFLICT: { status: 409, code: "PPM_STATE_CONFLICT" },
  PPM_REVISION_CONFLICT: { status: 409, code: "PPM_REVISION_CONFLICT" },
  PPM_IDENTITY_REQUIRED: { status: 403, code: "PPM_IDENTITY_REQUIRED" },
  /* An issued minute is permanent evidence and takes no edit. */
  PPM_IMMUTABLE: { status: 409, code: "PPM_IMMUTABLE" },
  /* Something Merchandising owns is missing, and issuing would record a
     meeting that did not have it. Never raised for another department's
     silence — that is preserved in the snapshot instead. */
  PPM_INCOMPLETE: { status: 409, code: "PPM_INCOMPLETE" },
  /* The person issuing wrote or conducted it. Minutes are checked by somebody
     other than the person who took them. */
  PPM_SELF_ISSUE: { status: 409, code: "PPM_SELF_ISSUE" },
  PPM_REVIEW_REQUIRED: { status: 409, code: "PPM_REVIEW_REQUIRED" },
  TNA_STATE_CONFLICT: { status: 409, code: "TNA_STATE_CONFLICT" },
  TNA_SELF_APPROVAL: { status: 409, code: "TNA_SELF_APPROVAL" },
  TNA_REASON_REQUIRED: { status: 400, code: "TNA_REASON_REQUIRED" },

  /* ── M6 — THE EXECUTION PACK AND THE DOWNSTREAM HANDOVER ────────────────
     Registered for exactly the reason the block below states: an unlisted
     code silently becomes VALIDATION, and a caller told "VALIDATION" cannot
     tell "a draft already exists" from "the gates have not passed" from "that
     pack is finished and cannot be edited". Each is a different screen and a
     different next step.

     `PACK_GATE_FAILED` carries EVERY failed gate in its details, not just the
     first — somebody assembling a handover needs the whole list, or they fix
     one thing, resubmit, and are refused again.

     `PACK_IMMUTABLE` is a 409 rather than a 403: the caller is permitted, the
     record is simply finished. And `DEPT_STATUS_NOT_ALLOWLISTED` exists so an
     unrecognised department status is refused at the boundary rather than
     stored as free text and rendered inside Merchandising's chrome. */
  PACK_NOT_FOUND: { status: 404, code: "PACK_NOT_FOUND" },
  PACK_EXISTS: { status: 409, code: "PACK_EXISTS" },
  PACK_IMMUTABLE: { status: 409, code: "PACK_IMMUTABLE" },
  PACK_GATE_FAILED: { status: 409, code: "PACK_GATE_FAILED" },
  PACK_DECLARATION_REQUIRED: { status: 400, code: "PACK_DECLARATION_REQUIRED" },
  PACK_STATE_CONFLICT: { status: 409, code: "PACK_STATE_CONFLICT" },
  PACK_ALREADY_DECIDED: { status: 409, code: "PACK_ALREADY_DECIDED" },
  DEPT_STATUS_NOT_ALLOWLISTED: { status: 422, code: "DEPT_STATUS_NOT_ALLOWLISTED" },
  DEPT_STATUS_STALE: { status: 409, code: "DEPT_STATUS_STALE" },

  /* ── M7 — CHANGE CONTROL AND THE ENTERPRISE OPERATIONS ──────────────────
     `CHANGE_FIELD_NOT_ALLOWED` is the one that matters most: it names the
     field AND whose record it belongs to, so a Sales developer who tries to
     put a buyer message or a price into a change notice is told why it is
     Sales' to keep rather than watching it silently disappear.

     `BULK_PREVIEW_STALE` and `BULK_LIMIT_EXCEEDED` exist so a bulk refusal is
     never mistaken for a partial success. And `EXPORT_TOO_LARGE` is a
     refusal with a number in it rather than a request that quietly returns
     the first thousand rows. */
  CHANGE_NOT_FOUND: { status: 404, code: "CHANGE_NOT_FOUND" },
  CHANGE_FIELD_NOT_ALLOWED: { status: 422, code: "CHANGE_FIELD_NOT_ALLOWED" },
  CHANGE_STATE_CONFLICT: { status: 409, code: "CHANGE_STATE_CONFLICT" },
  CHANGE_ALREADY_DECIDED: { status: 409, code: "CHANGE_ALREADY_DECIDED" },
  CHANGE_VERSION_STALE: { status: 409, code: "CHANGE_VERSION_STALE" },
  IMPACT_NOT_FOUND: { status: 404, code: "IMPACT_NOT_FOUND" },
  IMPACT_STATE_CONFLICT: { status: 409, code: "IMPACT_STATE_CONFLICT" },
  BULK_PREVIEW_NOT_FOUND: { status: 404, code: "BULK_PREVIEW_NOT_FOUND" },
  BULK_PREVIEW_STALE: { status: 409, code: "BULK_PREVIEW_STALE" },
  BULK_PREVIEW_EXPIRED: { status: 409, code: "BULK_PREVIEW_EXPIRED" },
  BULK_PREVIEW_ALREADY_APPLIED: { status: 409, code: "BULK_PREVIEW_ALREADY_APPLIED" },
  BULK_LIMIT_EXCEEDED: { status: 422, code: "BULK_LIMIT_EXCEEDED" },
  BULK_COMMAND_UNKNOWN: { status: 404, code: "BULK_COMMAND_UNKNOWN" },
  EXPORT_TOO_LARGE: { status: 413, code: "EXPORT_TOO_LARGE" },
  REPORT_UNKNOWN: { status: 404, code: "REPORT_UNKNOWN" },

  /* ── PRE-ORDER DEVELOPMENT ──────────────────────────────────────────────
     Registered rather than left to fall through to VALIDATION, for the reason
     the IE block below states: an operator told "VALIDATION" cannot tell "a
     request already exists for this product line" from "that BOM is approved
     and frozen" from "you cannot approve your own selection". Each is a
     different screen and a different next step.

     `DEVELOPMENT_FIELD_NOT_ALLOWED` names the field and says why it stays in
     Sales, so a developer sending an opportunity value or a buyer message
     learns the boundary rather than watching it vanish. */
  DEVELOPMENT_REQUEST_NOT_FOUND: { status: 404, code: "DEVELOPMENT_REQUEST_NOT_FOUND" },
  DEVELOPMENT_REQUEST_EXISTS: { status: 409, code: "DEVELOPMENT_REQUEST_EXISTS" },
  DEVELOPMENT_FIELD_NOT_ALLOWED: { status: 422, code: "DEVELOPMENT_FIELD_NOT_ALLOWED" },
  DEVELOPMENT_FILE_NOT_FOUND: { status: 404, code: "DEVELOPMENT_FILE_NOT_FOUND" },
  DEVELOPMENT_STATE_CONFLICT: { status: 409, code: "DEVELOPMENT_STATE_CONFLICT" },
  DEVELOPMENT_ALREADY_DECIDED: { status: 409, code: "DEVELOPMENT_ALREADY_DECIDED" },
  DEVELOPMENT_BOM_NOT_FOUND: { status: 404, code: "DEVELOPMENT_BOM_NOT_FOUND" },
  DEVELOPMENT_BOM_EXISTS: { status: 409, code: "DEVELOPMENT_BOM_EXISTS" },
  DEVELOPMENT_BOM_IMMUTABLE: { status: 409, code: "DEVELOPMENT_BOM_IMMUTABLE" },
  DEVELOPMENT_BOM_EMPTY: { status: 422, code: "DEVELOPMENT_BOM_EMPTY" },
  DEVELOPMENT_SELF_APPROVAL: { status: 409, code: "DEVELOPMENT_SELF_APPROVAL" },
  DEVELOPMENT_NOT_APPROVED: { status: 409, code: "DEVELOPMENT_NOT_APPROVED" },
  DEVELOPMENT_RELEASE_IS_SALES: { status: 403, code: "DEVELOPMENT_RELEASE_IS_SALES" },
  PRODUCT_LINE_NOT_FOUND: { status: 404, code: "PRODUCT_LINE_NOT_FOUND" },
  /* ── IE CHUNK 1D — A WORK ORDER MUST KNOW ITS STYLE ─────────────────────
   * Registered rather than left to fall through to VALIDATION, which is what
   * an unlisted code silently becomes: an operator told "VALIDATION" cannot
   * tell a request line that names no style from one that names two, from a
   * style belonging to another company. Each of those is corrected on a
   * different screen by a different person.
   *
   * 400 for what the records say and retrying unchanged cannot fix; 409 for a
   * state somebody must reconcile; 403 for the tenant refusal. */
  WORK_ORDER_STYLE_LINK_REQUIRED: { status: 400, code: "WORK_ORDER_STYLE_LINK_REQUIRED" },
  WORK_ORDER_STYLE_LINK_AMBIGUOUS: { status: 409, code: "WORK_ORDER_STYLE_LINK_AMBIGUOUS" },
  WORK_ORDER_STYLE_NOT_FOUND: { status: 400, code: "WORK_ORDER_STYLE_NOT_FOUND" },
  WORK_ORDER_STYLE_OWNERSHIP_UNPROVEN: { status: 409, code: "WORK_ORDER_STYLE_OWNERSHIP_UNPROVEN" },
  WORK_ORDER_STYLE_COMPANY_MISMATCH: { status: 403, code: "WORK_ORDER_STYLE_COMPANY_MISMATCH" },

  VALIDATION: { status: 400, code: "VALIDATION" },

  /* ── COSTING PROJECTION → DRAFT REQUEST HANDOFF (Chunk 7B) ──────────────
     Registered here because this table is what decides an HTTP status: an
     unregistered code silently becomes a 400 VALIDATION, so a conflict would
     read to the client as a malformed request. Each status is chosen for what
     the caller must do — 409 for "the world moved, look again", 422 for "this
     selection cannot be turned into a request", 503 for "we could not
     guarantee both drafts together". */
  HANDOFF_PROJECTION_UNAVAILABLE: { status: 422, code: "HANDOFF_PROJECTION_UNAVAILABLE" },
  HANDOFF_VERSION_MISMATCH: { status: 409, code: "HANDOFF_VERSION_MISMATCH" },
  HANDOFF_NOTHING_SELECTED: { status: 400, code: "HANDOFF_NOTHING_SELECTED" },
  HANDOFF_REQUIREMENT_NOT_IN_PROJECTION: { status: 409, code: "HANDOFF_REQUIREMENT_NOT_IN_PROJECTION" },
  HANDOFF_REQUIREMENT_BLOCKED: { status: 422, code: "HANDOFF_REQUIREMENT_BLOCKED" },
  HANDOFF_ALREADY_REQUESTED: { status: 409, code: "HANDOFF_ALREADY_REQUESTED" },
  HANDOFF_NO_STAFF_RECORD: { status: 403, code: "HANDOFF_NO_STAFF_RECORD" },
  HANDOFF_NOT_ATOMIC: { status: 503, code: "HANDOFF_NOT_ATOMIC" },
  HANDOFF_DATE_REASON_REQUIRED: { status: 422, code: "HANDOFF_DATE_REASON_REQUIRED" },

  /* ── INDUSTRIAL ENGINEERING — THE COMPANY OPERATION LIBRARY (Chunk 2A) ────
   * IE's first write surface. Registered here because this table decides the
   * HTTP status: an UNREGISTERED key silently becomes a 400 VALIDATION, which
   * would tell a form to fix a field when what actually happened was that
   * somebody else saved first, or that the operation is retired.
   *
   * The split of statuses is the split of what the caller must DO:
   *   · 403 — you may look at this library but not change it.
   *   · 404 — no such operation IN YOUR COMPANY. Deliberately the same answer
   *     as a foreign company's real operation: see the non-disclosure rule in
   *     ieOperationLibrary.service.js.
   *   · 409 — the library moved. Re-read and decide again; re-sending the same
   *     body cannot fix any of these four.
   *
   * VALIDATION and FIELD_NOT_ACCEPTED are reused rather than duplicated per
   * department — they already carry `details.field`, and this library adds
   * `details.fieldErrors` beside it (the same array, several fields at once)
   * so a form can bind every message to its own input in one pass. */
  IE_WRITE_FORBIDDEN: { status: 403, code: "IE_WRITE_FORBIDDEN" },
  IE_OPERATION_NOT_FOUND: { status: 404, code: "IE_OPERATION_NOT_FOUND" },
  IE_OPERATION_CODE_TAKEN: { status: 409, code: "IE_OPERATION_CODE_TAKEN" },
  IE_OPERATION_REVISION_CONFLICT: { status: 409, code: "IE_OPERATION_REVISION_CONFLICT" },
  IE_OPERATION_ALREADY_RETIRED: { status: 409, code: "IE_OPERATION_ALREADY_RETIRED" },
  IE_OPERATION_ALREADY_ACTIVE: { status: 409, code: "IE_OPERATION_ALREADY_ACTIVE" },
  IE_OPERATION_RESTORE_CODE_CONFLICT: { status: 409, code: "IE_OPERATION_RESTORE_CODE_CONFLICT" },

  /* ── INDUSTRIAL ENGINEERING — THE STYLE ENGINEERING FILE (Chunk 3A) ───────
   * The four ways a file cannot be OPENED are separated from the four ways a
   * bulletin cannot be SAVED, because they are answered by different people:
   * the first four send somebody to R&D or to the order, the last four are
   * fixable on the form in front of the engineer.
   *
   * 404 for both "no such file for you" and "that style is not on that order",
   * and deliberately the same shape as a foreign company's real record — the
   * boundary must not answer "does this exist elsewhere".
   *
   * 409 for the two source problems: nothing about the request is malformed,
   * and the fix is an approval R&D has not made (or has made twice). */
  IE_FILE_NOT_FOUND: { status: 404, code: "IE_FILE_NOT_FOUND" },
  IE_STYLE_NOT_ON_ORDER: { status: 404, code: "IE_STYLE_NOT_ON_ORDER" },
  IE_SOURCE_VERSION_REQUIRED: { status: 409, code: "IE_SOURCE_VERSION_REQUIRED" },
  IE_SOURCE_VERSION_AMBIGUOUS: { status: 409, code: "IE_SOURCE_VERSION_AMBIGUOUS" },
  IE_FILE_REVISION_CONFLICT: { status: 409, code: "IE_FILE_REVISION_CONFLICT" },
  /* A declared process route that cannot be stored: an unknown process, an
     applicability nobody stated, a predecessor that is later, missing or does
     not apply. 400, naming every entry at once. */
  IE_PROCESS_ROUTE_INVALID: { status: 400, code: "IE_PROCESS_ROUTE_INVALID" },
  IE_BULLETIN_ROW_DUPLICATE: { status: 400, code: "IE_BULLETIN_ROW_DUPLICATE" },
  /* An operation this company's library does not hold — unknown, another
     company's, or not an id at all. One answer for all three. */
  IE_BULLETIN_OPERATION_NOT_FOUND: { status: 400, code: "IE_BULLETIN_OPERATION_NOT_FOUND" },

  /* ── INDUSTRIAL ENGINEERING — THE DRAFT METHOD STUDY (Chunk 4A) ───────────
   * Work measurement: timed cycles behind one bulletin row, and the observed
   * and normal times they yield.
   *
   * 404 for a row or a study this company cannot see — and deliberately the
   * same answer for a foreign company's real study, which must not be
   * distinguishable from one that never existed.
   *
   * 409 for the two ways the world moved: somebody else saved first, and the
   * bulletin row this study was timed against no longer names the same
   * operation. The second is not an error the caller can fix by retrying —
   * the study stays readable as evidence and a new one is opened for the new
   * operation, so the code says WHICH of those happened.
   *
   * 400 for the three things a form can fix, each naming its own field or
   * observation through the shared `fieldErrors` shape. */
  IE_BULLETIN_ROW_NOT_FOUND: { status: 404, code: "IE_BULLETIN_ROW_NOT_FOUND" },
  IE_METHOD_STUDY_NOT_FOUND: { status: 404, code: "IE_METHOD_STUDY_NOT_FOUND" },
  IE_METHOD_STUDY_REVISION_CONFLICT: { status: 409, code: "IE_METHOD_STUDY_REVISION_CONFLICT" },
  IE_METHOD_STUDY_SOURCE_CHANGED: { status: 409, code: "IE_METHOD_STUDY_SOURCE_CHANGED" },
  IE_METHOD_STUDY_OBSERVATION_INVALID: { status: 400, code: "IE_METHOD_STUDY_OBSERVATION_INVALID" },
  IE_METHOD_STUDY_EXCLUSION_REASON_REQUIRED: { status: 400, code: "IE_METHOD_STUDY_EXCLUSION_REASON_REQUIRED" },
  IE_METHOD_STUDY_RATING_INVALID: { status: 400, code: "IE_METHOD_STUDY_RATING_INVALID" },

  /* ── INDUSTRIAL ENGINEERING — ALLOWANCES, STANDARD TIME, APPROVAL (4B) ────
   * The allowance policy is a company DECISION with an effective date, and a
   * method study becomes a standard time only by passing a second pair of eyes.
   * So the refusals split three ways, by who has to act:
   *
   *   404 — no such policy or submission FOR YOU. Same answer as a foreign
   *         company's real record; the boundary must not confirm it exists.
   *   409 — the world's state, not the request: no policy is effective for the
   *         date, somebody published first, this policy is already published,
   *         the study is not in a state that permits the action, or the
   *         revision moved. Retrying the same body cannot fix any of them.
   *   403 — MAKER-CHECKER. Not "you lack a role": the actor holds it and is
   *         the wrong PERSON, because they wrote what they are trying to
   *         approve. Its own code so a screen can say that plainly, and
   *         deliberately not something an owner or platform admin can pass.
   *   400 — what the form can fix: a category, a duplicate code, a total over
   *         100%, an override with no reason.
   *
   * `IE_METHOD_STUDY_NOT_READY` carries the full list of what is missing in
   * `details.gaps`, so a submit screen can name every requirement at once
   * rather than sending somebody round the loop one field at a time. */
  IE_ALLOWANCE_POLICY_NOT_FOUND: { status: 404, code: "IE_ALLOWANCE_POLICY_NOT_FOUND" },
  IE_ALLOWANCE_POLICY_NOT_EFFECTIVE: { status: 409, code: "IE_ALLOWANCE_POLICY_NOT_EFFECTIVE" },
  IE_ALLOWANCE_POLICY_REVISION_CONFLICT: { status: 409, code: "IE_ALLOWANCE_POLICY_REVISION_CONFLICT" },
  IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED: { status: 409, code: "IE_ALLOWANCE_POLICY_ALREADY_PUBLISHED" },
  IE_ALLOWANCE_POLICY_DRAFT_EXISTS: { status: 409, code: "IE_ALLOWANCE_POLICY_DRAFT_EXISTS" },
  IE_ALLOWANCE_POLICY_EFFECTIVE_DATE_TAKEN: { status: 409, code: "IE_ALLOWANCE_POLICY_EFFECTIVE_DATE_TAKEN" },
  IE_ALLOWANCE_CATEGORY_INVALID: { status: 400, code: "IE_ALLOWANCE_CATEGORY_INVALID" },
  IE_ALLOWANCE_CATEGORY_CODE_DUPLICATE: { status: 400, code: "IE_ALLOWANCE_CATEGORY_CODE_DUPLICATE" },
  IE_ALLOWANCE_TOTAL_OUT_OF_RANGE: { status: 400, code: "IE_ALLOWANCE_TOTAL_OUT_OF_RANGE" },
  IE_ALLOWANCE_POLICY_MAKER_CHECKER: { status: 403, code: "IE_ALLOWANCE_POLICY_MAKER_CHECKER" },

  IE_METHOD_STUDY_NOT_READY: { status: 409, code: "IE_METHOD_STUDY_NOT_READY" },
  IE_METHOD_STUDY_TRANSITION_INVALID: { status: 409, code: "IE_METHOD_STUDY_TRANSITION_INVALID" },
  IE_METHOD_STUDY_SUBMISSION_NOT_FOUND: { status: 404, code: "IE_METHOD_STUDY_SUBMISSION_NOT_FOUND" },
  IE_METHOD_STUDY_MAKER_CHECKER: { status: 403, code: "IE_METHOD_STUDY_MAKER_CHECKER" },
  IE_METHOD_STUDY_OVERRIDE_INVALID: { status: 400, code: "IE_METHOD_STUDY_OVERRIDE_INVALID" },
  IE_METHOD_STUDY_OVERRIDE_REASON_REQUIRED: { status: 400, code: "IE_METHOD_STUDY_OVERRIDE_REASON_REQUIRED" },
  IE_METHOD_STUDY_REVIEW_REASON_REQUIRED: { status: 400, code: "IE_METHOD_STUDY_REVIEW_REASON_REQUIRED" },

  /* ── INDUSTRIAL ENGINEERING — OPERATION RESOURCE REQUIREMENTS (Chunk 5A) ──
   * What an operation NEEDS to be run: machine types, attachments, and
   * operators or helpers at a skill and grade. Requirements, never
   * allocations — no named person, no serial-numbered machine, no availability.
   *
   * Every code here is 400 and fixable on the form, each naming the exact
   * requirement row through the shared `fieldErrors` shape (`requirementId`
   * where the row already has one, otherwise the submitted index) so a screen
   * can mark the offending line rather than the whole profile. The three
   * duplicate codes are separate from the general validation code because a
   * duplicate is a decision to reconcile — which of the two rows did you mean —
   * and not a typo in a field.
   *
   * A retired operation, a stale revision, a missing role and an unresolved
   * company reuse the codes those situations already have elsewhere in IE;
   * inventing requirement-specific twins would give a client two codes for one
   * fact. */
  IE_OPERATION_REQUIREMENTS_INVALID: { status: 400, code: "IE_OPERATION_REQUIREMENTS_INVALID" },
  IE_OPERATION_REQUIREMENT_QUANTITY_INVALID: { status: 400, code: "IE_OPERATION_REQUIREMENT_QUANTITY_INVALID" },
  IE_OPERATION_REQUIREMENT_MACHINE_DUPLICATE: { status: 400, code: "IE_OPERATION_REQUIREMENT_MACHINE_DUPLICATE" },
  IE_OPERATION_REQUIREMENT_ATTACHMENT_DUPLICATE: { status: 400, code: "IE_OPERATION_REQUIREMENT_ATTACHMENT_DUPLICATE" },
  IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE: { status: 400, code: "IE_OPERATION_REQUIREMENT_LABOUR_DUPLICATE" },
  IE_OPERATION_REQUIREMENT_NOT_FOUND: { status: 400, code: "IE_OPERATION_REQUIREMENT_NOT_FOUND" },
  IE_OPERATION_REQUIREMENTS_NO_CHANGE_REQUESTED: { status: 400, code: "IE_OPERATION_REQUIREMENTS_NO_CHANGE_REQUESTED" },

  /* ── INDUSTRIAL ENGINEERING — LINE LAYOUT AND BALANCE (Chunk 6A) ──────────
   * Bulletin operations arranged into stations, and what that division costs
   * in balance. An engineering standard — no assignment, no capacity, no
   * approval.
   *
   * 404 for a layout this company cannot see. 409 for the two ways the world
   * moved: the bulletin this layout was balanced against has changed, or
   * somebody else saved first — neither fixable by re-sending. 409 as well for
   * a layout that cannot be OPENED because rows have no approved standard time,
   * with every affected row named in `details.gaps`: the fix is an approval in
   * Chunk 4B, not a field on this form. 400 for what a station editor can fix. */
  IE_LINE_LAYOUT_NOT_FOUND: { status: 404, code: "IE_LINE_LAYOUT_NOT_FOUND" },
  IE_LINE_LAYOUT_NOT_READY: { status: 409, code: "IE_LINE_LAYOUT_NOT_READY" },
  IE_LINE_LAYOUT_SOURCE_CHANGED: { status: 409, code: "IE_LINE_LAYOUT_SOURCE_CHANGED" },
  IE_LINE_LAYOUT_REVISION_CONFLICT: { status: 409, code: "IE_LINE_LAYOUT_REVISION_CONFLICT" },
  IE_LINE_LAYOUT_STATION_INVALID: { status: 400, code: "IE_LINE_LAYOUT_STATION_INVALID" },
  IE_LINE_LAYOUT_ROW_NOT_IN_SOURCE: { status: 400, code: "IE_LINE_LAYOUT_ROW_NOT_IN_SOURCE" },
  IE_LINE_LAYOUT_ROW_DUPLICATE: { status: 400, code: "IE_LINE_LAYOUT_ROW_DUPLICATE" },
  /* ── IE — 2D PLANNED GEOMETRY (ie-line-layout-2d/v1) ──────────────────────
   * A position outside the plan, a slot the layout does not hold, and the same
   * slot twice. All 400: each names the exact entry a canvas sent. */
  IE_LINE_LAYOUT_POSITION_INVALID: { status: 400, code: "IE_LINE_LAYOUT_POSITION_INVALID" },
  IE_LINE_LAYOUT_SLOT_INVALID: { status: 400, code: "IE_LINE_LAYOUT_SLOT_INVALID" },
  IE_LINE_LAYOUT_SLOT_DUPLICATE: { status: 400, code: "IE_LINE_LAYOUT_SLOT_DUPLICATE" },
  /* ── IE — PLANNED STATION MACHINE TYPES (Chunk 6B) ────────────────────────
   * A station plans machine TYPES and counts. Both codes are 400 and name the
   * exact entry: the type list is a form somebody fills in, and a duplicate
   * type is a decision to reconcile rather than a malformed field.
   *
   * Compatibility itself is never an error — an incompatible or unprovable
   * placement is a readiness gap on the layout, because it is a state of the
   * plan and not a rejected request. */
  IE_LAYOUT_STATION_MACHINE_TYPE_INVALID: { status: 400, code: "IE_LAYOUT_STATION_MACHINE_TYPE_INVALID" },
  IE_LAYOUT_STATION_MACHINE_TYPE_DUPLICATE: { status: 400, code: "IE_LAYOUT_STATION_MACHINE_TYPE_DUPLICATE" },

  /* ── IE — REUSABLE LINE TEMPLATES (Chunk 6C) ─────────────────────────────
   * A template is an engineering pattern reused across styles, so the split is
   * between what the REQUEST got wrong and what the RECORD's state decides.
   *
   * 404 for a template this caller may not see: a foreign company's and a
   * missing one are the same answer, because saying which would confirm a
   * record exists somewhere the caller cannot look.
   *
   * 409 for the state somebody lost to — a taken name, a revision that moved,
   * a retired or already-active template. None of those is a malformed
   * request, and telling somebody to check the form would be unfixable advice.
   *
   * 400 for the pattern itself: a station, a slot or a planned machine type a
   * person fills in and can correct.
   *
   * `IE_LINE_TEMPLATE_SLOT_NOT_IN_SOURCE` is 409 and not 400: the request is
   * perfectly well formed, and what does not fit is the TARGET bulletin. The
   * fix is choosing another template or another layout, never editing a field,
   * and every unresolved slot is named in `details.missingSlots`. */
  IE_LINE_TEMPLATE_NOT_FOUND: { status: 404, code: "IE_LINE_TEMPLATE_NOT_FOUND" },
  IE_LINE_TEMPLATE_NAME_TAKEN: { status: 409, code: "IE_LINE_TEMPLATE_NAME_TAKEN" },
  IE_LINE_TEMPLATE_REVISION_CONFLICT: { status: 409, code: "IE_LINE_TEMPLATE_REVISION_CONFLICT" },
  IE_LINE_TEMPLATE_RETIRED: { status: 409, code: "IE_LINE_TEMPLATE_RETIRED" },
  IE_LINE_TEMPLATE_ALREADY_RETIRED: { status: 409, code: "IE_LINE_TEMPLATE_ALREADY_RETIRED" },
  IE_LINE_TEMPLATE_ALREADY_ACTIVE: { status: 409, code: "IE_LINE_TEMPLATE_ALREADY_ACTIVE" },
  IE_LINE_TEMPLATE_SLOT_NOT_IN_SOURCE: { status: 409, code: "IE_LINE_TEMPLATE_SLOT_NOT_IN_SOURCE" },
  IE_LINE_TEMPLATE_STATION_INVALID: { status: 400, code: "IE_LINE_TEMPLATE_STATION_INVALID" },
  IE_LINE_TEMPLATE_SLOT_INVALID: { status: 400, code: "IE_LINE_TEMPLATE_SLOT_INVALID" },
  IE_LINE_TEMPLATE_SLOT_DUPLICATE: { status: 400, code: "IE_LINE_TEMPLATE_SLOT_DUPLICATE" },
  IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID: { status: 400, code: "IE_LINE_TEMPLATE_MACHINE_TYPE_INVALID" },
  IE_LINE_TEMPLATE_MACHINE_TYPE_DUPLICATE: { status: 400, code: "IE_LINE_TEMPLATE_MACHINE_TYPE_DUPLICATE" },
  /* An edited slot naming an operation this company's library does not hold —
     unknown, another company's, or not an operation at all. One answer for all
     three, because "does that id exist elsewhere" is not a question a tenant
     boundary answers. 400 and field-level: the fix is the slot in front of the
     person. */
  IE_LINE_TEMPLATE_SLOT_OPERATION_NOT_FOUND: { status: 400, code: "IE_LINE_TEMPLATE_SLOT_OPERATION_NOT_FOUND" },

  /* ── IE CAPACITY STANDARDS (Chunk 7A) ────────────────────────────────────
   * A capacity standard is a CALCULATION tied to one exact line layout, so its
   * three failure modes are the three ways a calculation stops being one.
   *
   * 404 for a standard this company does not own — absent, foreign and
   * malformed alike, because "does that id exist elsewhere" is not a question
   * a tenant boundary answers.
   *
   * 409 for SOURCE_CHANGED, and it is the important one. The layout behind the
   * standard is no longer a balance of the current bulletin or approved
   * standard time, so the record is frozen as evidence of what was planned. It
   * is NOT rebased and NOT recalculated: silently recomputing it would move a
   * target somebody had already planned a shipment against, with nothing on
   * the record to say it had moved. The fix is a new standard from the current
   * source, named in `details.resolution`, never editing a field.
   *
   * 409 for REVISION_CONFLICT — the state somebody lost to, not a malformed
   * request. A stale request conflicts even when its outcome would have been a
   * no-op, because the caller decided from a state that no longer exists.
   *
   * 400 and field-level for INPUT_INVALID: shift minutes, breaks, operator
   * counts, efficiency and effective dates are all fields in front of a person,
   * and every refusal carries `details.fieldErrors` naming which. Contradictory
   * combinations — breaks that consume the whole shift, an effective period
   * that ends before it starts — arrive through the same code, because they are
   * fixed in the same form. */
  IE_CAPACITY_STANDARD_NOT_FOUND: { status: 404, code: "IE_CAPACITY_STANDARD_NOT_FOUND" },
  IE_CAPACITY_STANDARD_SOURCE_CHANGED: { status: 409, code: "IE_CAPACITY_STANDARD_SOURCE_CHANGED" },
  IE_CAPACITY_STANDARD_REVISION_CONFLICT: { status: 409, code: "IE_CAPACITY_STANDARD_REVISION_CONFLICT" },
  IE_CAPACITY_STANDARD_INPUT_INVALID: { status: 400, code: "IE_CAPACITY_STANDARD_INPUT_INVALID" },

  /* ── IE RAMP PROFILES (Chunk 7B) ─────────────────────────────────────────
   * A ramp profile is a stated ASSUMPTION about how a line reaches its
   * steady-state efficiency, so its failures split the same way every other IE
   * register's do.
   *
   * 404 for a profile this company does not own — absent, foreign and
   * malformed alike.
   *
   * 409 for the state somebody lost to: a taken active name, a revision that
   * moved, a profile already retired or already active. None is a malformed
   * request, and telling somebody to check the form would be unfixable advice.
   * `IE_RAMP_PROFILE_RETIRED` is 409 for the same reason: applying a retired
   * profile to a new capacity standard is a well-formed request about a record
   * that has been withdrawn, and the fix is choosing another profile.
   *
   * 400 and field-level for the stages themselves — a day range or a percentage
   * a person fills in and can correct. Overlaps and gaps arrive through
   * `IE_RAMP_STAGE_INVALID` with `details.fieldErrors` naming the stage index,
   * because they are fixed in the same form as a malformed one.
   *
   * `IE_RAMP_STAGE_NOT_IN_PROFILE` is 400 and not 404: the profile was found,
   * and what did not resolve is a field in the request. */
  IE_RAMP_PROFILE_NOT_FOUND: { status: 404, code: "IE_RAMP_PROFILE_NOT_FOUND" },
  IE_RAMP_PROFILE_NAME_TAKEN: { status: 409, code: "IE_RAMP_PROFILE_NAME_TAKEN" },
  IE_RAMP_PROFILE_REVISION_CONFLICT: { status: 409, code: "IE_RAMP_PROFILE_REVISION_CONFLICT" },
  IE_RAMP_PROFILE_RETIRED: { status: 409, code: "IE_RAMP_PROFILE_RETIRED" },
  IE_RAMP_PROFILE_ALREADY_RETIRED: { status: 409, code: "IE_RAMP_PROFILE_ALREADY_RETIRED" },
  IE_RAMP_PROFILE_ALREADY_ACTIVE: { status: 409, code: "IE_RAMP_PROFILE_ALREADY_ACTIVE" },
  IE_RAMP_STAGE_INVALID: { status: 400, code: "IE_RAMP_STAGE_INVALID" },
  IE_RAMP_STAGE_NOT_IN_PROFILE: { status: 400, code: "IE_RAMP_STAGE_NOT_IN_PROFILE" },

  /* ── IE BULLETIN VERSIONS (Chunk 7C1) ────────────────────────────────────
   * A Bulletin Version is a SUBMITTED SNAPSHOT, frozen from the instant it is
   * created. Its refusals split along the same lines every IE register's do.
   *
   * 404 for a version this company does not own — absent, foreign and malformed
   * answer identically, so the code cannot be used to probe another company.
   *
   * 409 for a state somebody lost to, or a state that forbids what was asked:
   * a revision that moved, a snapshot that is immutable, a draft frozen under
   * review, a second submission, a retired operation, an unmet readiness gate,
   * an illegal transition. None is a malformed request, and telling the caller
   * to check the form would be unfixable advice.
   *
   * 403 for maker-checker: not a missing role, the wrong PERSON. An owner and a
   * platform administrator are refused on identical terms.
   *
   * 400 for the one thing a form genuinely fixes — a return with no reason.
   *
   * 503 for `..._ATOMICITY_UNAVAILABLE`, and it is the whole reason this code
   * exists. Submit, return and approve each write two documents, so on a
   * deployment without transactions they FAIL CLOSED rather than writing one.
   * 503 says "this deployment cannot do this safely", which is a truthful and
   * retryable answer; a 409 or a 500 would both misdescribe it. */
  IE_BULLETIN_VERSION_NOT_FOUND: { status: 404, code: "IE_BULLETIN_VERSION_NOT_FOUND" },
  IE_BULLETIN_VERSION_REVISION_CONFLICT: { status: 409, code: "IE_BULLETIN_VERSION_REVISION_CONFLICT" },
  IE_BULLETIN_VERSION_IMMUTABLE: { status: 409, code: "IE_BULLETIN_VERSION_IMMUTABLE" },
  IE_BULLETIN_VERSION_IN_REVIEW: { status: 409, code: "IE_BULLETIN_VERSION_IN_REVIEW" },
  IE_BULLETIN_VERSION_SUBMISSION_EXISTS: { status: 409, code: "IE_BULLETIN_VERSION_SUBMISSION_EXISTS" },
  IE_BULLETIN_VERSION_OPERATION_RETIRED: { status: 409, code: "IE_BULLETIN_VERSION_OPERATION_RETIRED" },
  IE_BULLETIN_VERSION_NOT_READY: { status: 409, code: "IE_BULLETIN_VERSION_NOT_READY" },
  IE_BULLETIN_VERSION_TRANSITION_INVALID: { status: 409, code: "IE_BULLETIN_VERSION_TRANSITION_INVALID" },
  IE_BULLETIN_VERSION_MAKER_CHECKER: { status: 403, code: "IE_BULLETIN_VERSION_MAKER_CHECKER" },
  IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE: { status: 503, code: "IE_BULLETIN_VERSION_ATOMICITY_UNAVAILABLE" },
  IE_BULLETIN_VERSION_REVIEW_REASON_REQUIRED: { status: 400, code: "IE_BULLETIN_VERSION_REVIEW_REASON_REQUIRED" },

  /* Chunk 7C2 will own layout approval. This one code is registered now because
     §11.12 test 25 asserts a pre-7C1 layout is refused for approval by NAME, and
     a test cannot assert a code the registry does not hold. Nothing in 7C1
     throws the other layout-approval codes, and none of them is registered. */
  /* ── IE LINE LAYOUT APPROVAL (Chunk 7C2) ─────────────────────────────────
   * 409 for every state that forbids what was asked — a layout that is not
   * ready, one whose bulletin version is not approved, one already approved,
   * and one from before 7C1 that can prove no version at all. None is a
   * malformed request; each names a fact about the record.
   *
   * `IE_LAYOUT_BULLETIN_VERSION_UNPROVEN` is separate from
   * `IE_LAYOUT_BULLETIN_NOT_APPROVED` on purpose. The first says "nothing
   * stored says which approved bulletin this was balanced against", which no
   * approval can ever fix — the fix is a new layout. The second says "the
   * version it names is not approved", which an approval elsewhere can fix.
   * Collapsing them would send somebody to wait for something that is not
   * coming.
   *
   * 403 for maker-checker: not a missing role, the wrong PERSON. */
  IE_LAYOUT_BULLETIN_VERSION_UNPROVEN: { status: 409, code: "IE_LAYOUT_BULLETIN_VERSION_UNPROVEN" },
  IE_LAYOUT_NOT_APPROVABLE: { status: 409, code: "IE_LAYOUT_NOT_APPROVABLE" },
  IE_LAYOUT_BULLETIN_NOT_APPROVED: { status: 409, code: "IE_LAYOUT_BULLETIN_NOT_APPROVED" },
  IE_LAYOUT_IMMUTABLE: { status: 409, code: "IE_LAYOUT_IMMUTABLE" },
  IE_LAYOUT_MAKER_CHECKER: { status: 403, code: "IE_LAYOUT_MAKER_CHECKER" },

  /* ── IE CAPACITY STANDARD APPROVAL (Chunk 7C3) ───────────────────────────
   * 409 for a state that forbids what was asked: a standard whose gates are
   * unmet, one bound to a layout nobody has approved, one already approved.
   * 403 for maker-checker — not a missing role, the wrong PERSON.
   *
   * `..._LAYOUT_NOT_APPROVED` is separate from `..._NOT_APPROVABLE` because the
   * two have different fixes and different owners: the first waits on somebody
   * approving a layout, the second on somebody completing this record. */
  IE_CAPACITY_STANDARD_NOT_APPROVABLE: { status: 409, code: "IE_CAPACITY_STANDARD_NOT_APPROVABLE" },
  IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED: { status: 409, code: "IE_CAPACITY_STANDARD_LAYOUT_NOT_APPROVED" },
  IE_CAPACITY_STANDARD_IMMUTABLE: { status: 409, code: "IE_CAPACITY_STANDARD_IMMUTABLE" },
  IE_CAPACITY_STANDARD_MAKER_CHECKER: { status: 403, code: "IE_CAPACITY_STANDARD_MAKER_CHECKER" },

  /* ── IE RELEASE (Chunk 8A-i) ─────────────────────────────────────────────
   * A release is the moment Industrial Engineering hands a complete, approved
   * aggregate to Planning. Its refusals split the same way every IE command's
   * do, and the catalogue is the one §8 of the release-readiness audit accepted.
   *
   * 409 for a state that forbids what was asked — a member nobody approved, a
   * source that has moved, an expected revision that no longer holds, a layout
   * that is not ready, a capacity standard bound to something else, a retired
   * operation nobody covered, and any write to an issued release.
   *
   * 403 for the override maker-checker: not a missing role, the wrong PERSON.
   * The person who retired an operation may not be the person who overrides its
   * retirement.
   *
   * 400 for the two things a caller genuinely fixes — a missing override reason
   * and an override that does not apply.
   *
   * 503 for `..._ATOMICITY_UNAVAILABLE`. Issuing a release writes three
   * documents plus its ledger entry, and a crash between them would leave a
   * version chain with two heads. On a deployment that cannot commit them
   * together the command fails closed, which is truthful and retryable.
   *
   * There is deliberately NO `IE_RELEASE_ALREADY_ISSUED`. Re-issuing an
   * identical aggregate is a no-op that returns the release that already exists,
   * not an error: the caller asked for a state of the world that is already
   * true. */
  IE_RELEASE_NOT_FOUND: { status: 404, code: "IE_RELEASE_NOT_FOUND" },
  IE_RELEASE_NOT_APPROVED: { status: 409, code: "IE_RELEASE_NOT_APPROVED" },
  IE_RELEASE_SOURCE_CHANGED: { status: 409, code: "IE_RELEASE_SOURCE_CHANGED" },
  IE_RELEASE_REVISION_CONFLICT: { status: 409, code: "IE_RELEASE_REVISION_CONFLICT" },
  IE_RELEASE_LAYOUT_NOT_READY: { status: 409, code: "IE_RELEASE_LAYOUT_NOT_READY" },
  IE_RELEASE_CAPACITY_NOT_BOUND: { status: 409, code: "IE_RELEASE_CAPACITY_NOT_BOUND" },
  IE_RELEASE_OPERATION_RETIRED: { status: 409, code: "IE_RELEASE_OPERATION_RETIRED" },
  IE_RELEASE_OVERRIDE_REASON_REQUIRED: { status: 400, code: "IE_RELEASE_OVERRIDE_REASON_REQUIRED" },
  IE_RELEASE_OVERRIDE_MAKER_CHECKER: { status: 403, code: "IE_RELEASE_OVERRIDE_MAKER_CHECKER" },
  IE_RELEASE_OVERRIDE_NOT_APPLICABLE: { status: 400, code: "IE_RELEASE_OVERRIDE_NOT_APPLICABLE" },
  IE_RELEASE_IMMUTABLE: { status: 409, code: "IE_RELEASE_IMMUTABLE" },
  IE_RELEASE_ATOMICITY_UNAVAILABLE: { status: 503, code: "IE_RELEASE_ATOMICITY_UNAVAILABLE" },

  /* ── CHUNK 8A-ii — PPC'S ANSWER TO AN ISSUED RELEASE ───────────────────
     These four are refusals of an ACKNOWLEDGEMENT, not of an issue. They are
     raised by `services/ppc/ieReleaseAck.service.js` and by nothing in
     `services/industrialEngineering/`, because acknowledging is PPC's act.

     There is deliberately no `IE_RELEASE_REJECTED` and no code that could
     carry one: PPC may ask for clarification, and refusing an engineering
     standard outright is not PPC's call. */
  IE_RELEASE_WITHDRAWN: { status: 409, code: "IE_RELEASE_WITHDRAWN" },
  /* Carries `{ versionNo, currentVersionNo }` — a refusal that did not name the
     version PPC should be looking at would leave the reader nowhere to go. */
  IE_RELEASE_VERSION_SUPERSEDED: { status: 409, code: "IE_RELEASE_VERSION_SUPERSEDED" },
  /* A SECOND, CONFLICTING answer to one version. An identical repeat is not
     this — it replays the first answer with a 200. */
  IE_RELEASE_ALREADY_ACKNOWLEDGED: { status: 409, code: "IE_RELEASE_ALREADY_ACKNOWLEDGED" },
  /* Distinct from the generic `FORBIDDEN` the inbound-pack routes raise, so a
     test can prove that an IE grant — of any level — reaches none of this. */
  IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN: { status: 403, code: "IE_RELEASE_ACKNOWLEDGEMENT_FORBIDDEN" },

  /* ── MARKETING ↔ MAUTIC (Marketing Chunk 0) ──────────────────────────────
   * Four ways the marketing-automation engine can fail GRAV, and they need
   * four different people to fix them. Registered rather than left to fall
   * through to VALIDATION — which is what an unlisted key silently becomes —
   * because "your form is wrong" is unfixable advice for every one of them.
   *
   * 503 for UNAVAILABLE, and this is the important one: a Mautic that could
   * not be reached has told us NOTHING, and the whole integration contract
   * turns on that never being rendered as an empty list or a zero. A screen
   * branching on this code shows "unavailable"; a screen that got a 200 with
   * `[]` would show "no campaigns" and be believed.
   *
   * 502 for AUTH_FAILED: the request was well formed and GRAV's own
   * credential was refused, so it is an upstream problem and not the caller's.
   * 409 for NOT_CONFIGURED — the fix is a deployment secret somebody else may
   * have to set, not a field on this form. 422 for a write Mautic itself
   * rejected, carrying Mautic's own field errors in `details`.
   *
   * Additive: no existing caller uses these keys, so nothing changes shape. */
  MAUTIC_UNAVAILABLE: { status: 503, code: "MAUTIC_UNAVAILABLE" },
  MAUTIC_AUTH_FAILED: { status: 502, code: "MAUTIC_AUTH_FAILED" },
  MAUTIC_NOT_CONFIGURED: { status: 409, code: "MAUTIC_NOT_CONFIGURED" },
  MAUTIC_REJECTED_WRITE: { status: 422, code: "MAUTIC_REJECTED_WRITE" },
  /* ── A REQUEST MAUTIC UNDERSTOOD AND REFUSED ──────────────────────────────
   * Separate from UNAVAILABLE, and the distinction is a retry policy rather
   * than a nicety. The read helpers in mauticClient.js originally mapped EVERY
   * non-200 to MAUTIC_UNAVAILABLE, so a malformed query — a filter Mautic
   * rejects, a field that does not exist — was classified as an outage and
   * retried with backoff for six hours. It will never succeed, and while it is
   * being retried it is invisible among the genuine outages.
   *
   * 400, because that is what it is: the request was wrong and re-sending it
   * unchanged cannot help. Classified TERMINAL by
   * services/marketing/marketingDelivery.service.js. */
  MAUTIC_BAD_REQUEST: { status: 400, code: "MAUTIC_BAD_REQUEST" },

  /* ── MARKETING CONSENT (Marketing Chunk 1, slice 1) ───────────────────────
   * Permission is a GRAV business record, and these are the three ways a
   * marketing write can be refused because of one.
   *
   * 403 for INELIGIBLE — the request is well formed and the person has not
   * agreed. It carries `details.reasonCode` from
   * constants/marketing.js CONSENT_INELIGIBLE_REASONS, which is the stable
   * vocabulary a Data Health screen groups by; one code with named sub-reasons
   * beats four codes, because a client that wants to say "not consented" can
   * branch once and a client that wants to say WHY can read the detail.
   *
   * 400 for INVALID — a channel, purpose or state this application does not
   * model. The fix is the request.
   *
   * 400 for CALLER_SUPPLIED — a caller passed a `consent` object. Refused
   * LOUDLY rather than ignored: an ignored parameter lets a caller believe
   * they granted something, and that belief is the whole vulnerability this
   * slice closes. Distinct from INVALID so the message can say where consent
   * actually comes from.
   *
   * Additive: no existing caller uses these keys. */
  MARKETING_CONSENT_INELIGIBLE: { status: 403, code: "MARKETING_CONSENT_INELIGIBLE" },
  MARKETING_CONSENT_INVALID: { status: 400, code: "MARKETING_CONSENT_INVALID" },
  MARKETING_CONSENT_CALLER_SUPPLIED: { status: 400, code: "MARKETING_CONSENT_CALLER_SUPPLIED" },

  /* ── THE ACQUISITION-SCOPE REFUSALS ──────────────────────────────────────
   * GRAV stops acquisition marketing for one accepted Prospect by removing
   * that person from the registered acquisition segments and campaigns. It
   * must never guess which those are: transactional, service, post-sale and
   * approved Sales-assisted nurture automation run in the same instance, and
   * an acceptance that tore a person out of all of it would be a far worse
   * error than one that stopped and asked.
   *
   * 424 rather than 500: the request is well formed and GRAV is healthy; a
   * dependency — a registration, or the permission to read it — is missing.
   *
   * Additive: no existing caller uses these keys. */
  ACQUISITION_SCOPE_MISSING: { status: 424, code: "ACQUISITION_SCOPE_MISSING" },
  ACQUISITION_SCOPE_UNVERIFIABLE: { status: 424, code: "ACQUISITION_SCOPE_UNVERIFIABLE" },

  /* ── A DECISION RECORDED, ITS APPLICATION UNCONFIRMED ────────────────────
   * Website tracking configuration writes an append-only history row and then
   * the current record, and this deployment cannot assume a transaction across
   * the two. When the second write fails and the automatic repair cannot finish
   * either, the honest answer is neither success nor "nothing was changed": the
   * decision IS durably recorded and a later read will apply it.
   *
   * 503 rather than 409 or 500: the request was valid, GRAV is not broken, and
   * trying again after reloading is the correct response — which is what a
   * retryable status tells a client and its infrastructure.
   *
   * Additive: no existing caller uses this key. */
  TRACKING_CONFIG_REPAIR_PENDING: { status: 503, code: "TRACKING_CONFIG_REPAIR_PENDING" },

  /* ── A PROVIDER ANSWERED, AND GRAV COULD NOT READ THE ANSWER ─────────────
   * Distinct from MAUTIC_UNAVAILABLE on purpose. Unreachable means nothing
   * could be checked; malformed means something replied and its shape was not
   * the contract — a collection key missing, a list that was a string. Both
   * must be distinguishable from an empty result, and from each other: one is
   * an outage to wait out, the other is a provider upgrade to investigate.
   *
   * 502: GRAV is a gateway here and the upstream answer was invalid.
   *
   * Additive: no existing caller uses this key. */
  MAUTIC_MALFORMED_RESPONSE: { status: 502, code: "MAUTIC_MALFORMED_RESPONSE" },

  /* ── THE PUBLIC FACE OF A MARKETING-ENGINE FAILURE ───────────────────────
   * GRAV-owned codes. The provider-shaped codes above are INTERNAL: they are
   * how this codebase reasons about a failure, and
   * `services/marketing/providerPrivacy.js` maps each of them onto one of these
   * before anything leaves a Marketing route.
   *
   * The mapping is deliberately lossy. "Unreachable", "refused our credentials"
   * and "sent something unparseable" are three different things to an operator
   * and one thing to a marketer — the engine is not answering — and publishing
   * the difference would leak the provider's failure taxonomy while telling the
   * reader nothing they can act on. The distinctions survive in the server log.
   *
   * Statuses match the internal ones they replace, so a client's retry
   * behaviour is unchanged even though the vocabulary is not. */
  MARKETING_ENGINE_UNAVAILABLE: { status: 503, code: "MARKETING_ENGINE_UNAVAILABLE" },
  MARKETING_ENGINE_NOT_CONFIGURED: { status: 409, code: "MARKETING_ENGINE_NOT_CONFIGURED" },
  MARKETING_ENGINE_REJECTED_REQUEST: { status: 422, code: "MARKETING_ENGINE_REJECTED_REQUEST" },

  /* The company asking is not the company this Mautic instance serves. One
   * instance serves one GRAV organisation (ADR-004), so this is a boundary, not
   * a failure: 403 rather than 404, because the content exists and this caller
   * simply has no claim on it. */
  MARKETING_COMPANY_NOT_CONFIGURED: { status: 403, code: "MARKETING_COMPANY_NOT_CONFIGURED" },

  /* ── ADVERTISING CHANNELS ────────────────────────────────────────────────
   * Google Ads and Meta Ads are NAMED in these messages, unlike the marketing
   * engine. A marketer holds those accounts, pays those invoices and reconciles
   * GRAV's figures against those dashboards, so naming the channel is the only
   * way the message is actionable. The engine behind `email` is still never
   * named; see `constants/marketingChannels.js` for why the rule is not uniform.
   *
   * These are GRAV-owned and public. The provider's own status, body and error
   * taxonomy stay in the server log.
   *
   * Additive: no existing caller uses these keys. */

  /* No credentials in this deployment. 409 rather than 503: nothing is broken
   * and retrying changes nothing — somebody must connect the channel. */
  CHANNEL_NOT_CONFIGURED: { status: 409, code: "CHANNEL_NOT_CONFIGURED" },

  /* ── MARKETING LEAD SOURCES (IndiaMART pull) ─────────────────────────────
   * Registered rather than left to fall through to VALIDATION: none of these
   * is a caller mistake.
   *   NOT_CONFIGURED  no key for this company. 409: somebody must add one.
   *   IN_PROGRESS     a check is running. 409: wait for its result.
   *   TOO_SOON        IndiaMART allows one call in 5 minutes. 429, with
   *                   `details.nextAllowedAt`. */
  LEAD_SOURCE_NOT_CONFIGURED: { status: 409, code: "LEAD_SOURCE_NOT_CONFIGURED" },
  LEAD_SOURCE_CHECK_IN_PROGRESS: { status: 409, code: "LEAD_SOURCE_CHECK_IN_PROGRESS" },
  LEAD_SOURCE_CHECK_TOO_SOON: { status: 429, code: "LEAD_SOURCE_CHECK_TOO_SOON" },


  /* Credentials present, channel declined them. Deliberately NOT 503: a retry
   * cannot fix a revoked token or a missing permission, and reporting it as
   * temporary is how an expired refresh token goes unnoticed for a month. */
  CHANNEL_ACCESS_REFUSED: { status: 409, code: "CHANNEL_ACCESS_REFUSED" },

  /* The channel did not answer, or answered with a server fault. Retryable, and
   * says NOTHING about whether campaigns are running — a caller must not render
   * this as stopped, paused or zero. */
  CHANNEL_UNAVAILABLE: { status: 503, code: "CHANNEL_UNAVAILABLE" },

  /* ── WHICH ACCESS PROBLEM, FOR THE ONE CHANNEL WHERE IT MATTERS ─────────
   * Google Ads access has four independent parts, and each is fixed by a
   * different person in a different console. One "access refused" for all four
   * sends an administrator to the wrong place. All 409: none is fixed by
   * retrying. */
  /* The OAuth credential is missing, expired, revoked or refused. */
  CHANNEL_OAUTH_UNAVAILABLE: { status: 409, code: "CHANNEL_OAUTH_UNAVAILABLE" },
  /* The Google Cloud project that owns the OAuth client has no API access —
   * disabled, not approved for production accounts, or missing sign-up. */
  CHANNEL_API_ACCESS_UNAVAILABLE: { status: 409, code: "CHANNEL_API_ACCESS_UNAVAILABLE" },
  /* The bound account, or the manager it is reached through, is wrong, closed
   * or not reachable from that manager. */
  CHANNEL_ACCOUNT_BINDING_UNAVAILABLE: { status: 409, code: "CHANNEL_ACCOUNT_BINDING_UNAVAILABLE" },
  /* The provider refused the API version GRAV spoke, or GRAV is configured for
   * one it does not support. A release is needed; retrying changes nothing. */
  CHANNEL_API_VERSION_REJECTED: { status: 409, code: "CHANNEL_API_VERSION_REJECTED" },

  /* The channel answered and GRAV could not read the answer. 502, and distinct
   * from unavailable on purpose: one is an outage to wait out, the other is a
   * provider API change to investigate. Never an empty list. */
  CHANNEL_MALFORMED_RESPONSE: { status: 502, code: "CHANNEL_MALFORMED_RESPONSE" },

  /* The channel asked GRAV to slow down. 429 so a client's own backoff applies
   * rather than GRAV inventing one on the client's behalf. */
  CHANNEL_RATE_LIMITED: { status: 429, code: "CHANNEL_RATE_LIMITED" },

  /* A real channel asked for something it genuinely does not offer — a campaign
   * list from a measurement source, for instance. 422: the request was
   * understood and is not answerable, which is not the same as a 404. */
  CHANNEL_UNSUPPORTED_OPERATION: { status: 422, code: "CHANNEL_UNSUPPORTED_OPERATION" },

  /* Campaign identifiers are signed (`campaignIdentity.js`) and the signing key
   * is a deployment secret. Without it GRAV can neither issue nor resolve one,
   * and the honest answer is that the channel feature is not connected. */
  CHANNEL_IDENTITY_NOT_CONFIGURED: { status: 409, code: "CHANNEL_IDENTITY_NOT_CONFIGURED" },

  /* Malformed, forged, or signed for another company — ONE code for all three.
   * Separating them would confirm to a caller probing identifiers that a given
   * company and channel pair exists, which is the enumeration the opaque
   * identifier exists to prevent. 404 because, to this caller, it does not
   * exist. */
  CAMPAIGN_NOT_FOUND: { status: 404, code: "CAMPAIGN_NOT_FOUND" },

  /* ── GRAV CAMPAIGN PLANS ─────────────────────────────────────────────────
   * A campaign plan is a GRAV document. None of these says anything about an
   * advertising account, because nothing in that chunk touches one.
   *
   * Additive: no existing caller uses these keys. */

  /* Malformed, forged, or signed for another company — ONE code for all three,
   * for the same reason CAMPAIGN_NOT_FOUND collapses its causes: separating them
   * confirms that a given company's plan exists. */
  CAMPAIGN_DRAFT_NOT_FOUND: { status: 404, code: "CAMPAIGN_DRAFT_NOT_FOUND" },

  /* The plan is in a state this action is not available from — editing a
   * submitted plan, approving a draft, resubmitting a rejected one. 409: the
   * request was valid and the plan's state is the obstacle, so the answer names
   * the state and what is available from it. */
  CAMPAIGN_DRAFT_STATE_CONFLICT: { status: 409, code: "CAMPAIGN_DRAFT_STATE_CONFLICT" },

  /* Somebody else changed the plan since this caller read it. 409, and the
   * response carries the current revision so a client can re-read rather than
   * guess. Never resolved by overwriting: a lost budget edit is silent. */
  CAMPAIGN_DRAFT_REVISION_CONFLICT: { status: 409, code: "CAMPAIGN_DRAFT_REVISION_CONFLICT" },

  /* The actor's role does not carry this decision. Distinct from FORBIDDEN so
   * the message can say which role does — and Sales is never one of them: a
   * handover decision is Sales' and a campaign approval is not. */
  CAMPAIGN_DRAFT_DECISION_FORBIDDEN: { status: 403, code: "CAMPAIGN_DRAFT_DECISION_FORBIDDEN" },

  /* The UTM campaign identity is already held by another live plan in this
   * company. 409 rather than a silent suffix: two campaigns sharing one identity
   * become one indistinguishable row in every analytics report, and renaming
   * somebody's campaign identity for them is not GRAV's decision. */
  CAMPAIGN_DRAFT_UTM_TAKEN: { status: 409, code: "CAMPAIGN_DRAFT_UTM_TAKEN" },

  /* ── A DECISION RECORDED, ITS PROJECTION UNCONFIRMED ─────────────────────
   * A campaign plan's history row is written before the plan itself, so an
   * interruption between the two leaves the decision durably recorded and the
   * current record behind. Reconciliation finishes it on the next read or write.
   *
   * This is the answer when reconciliation itself could not be confirmed: the
   * honest state is neither success nor "nothing happened", because the decision
   * IS recorded and a later read will apply it. 503 rather than 500 — the request
   * was valid, GRAV is not broken, and retrying after a reload is correct, which
   * is what a retryable status tells a client and its infrastructure.
   *
   * Carries only GRAV-owned stage and revision detail. No driver message, no
   * collection name, no index name. */
  CAMPAIGN_DRAFT_REPAIR_PENDING: { status: 503, code: "CAMPAIGN_DRAFT_REPAIR_PENDING" },

  /* A mutation arrived with no stable authenticated actor. Refused before
   * anything is written: an audit row whose actor is a display name is not an
   * audit row, and the second-person approval rule cannot be enforced against an
   * identity that does not exist. 403, because the caller is authenticated enough
   * to reach the route and not identified enough to change a record. */
  CAMPAIGN_DRAFT_ACTOR_UNVERIFIED: { status: 403, code: "CAMPAIGN_DRAFT_ACTOR_UNVERIFIED" },

  /* ── A RECORDED COMMAND THAT CAN NEVER BE APPLIED ────────────────────────
   * Distinct from CAMPAIGN_DRAFT_REPAIR_PENDING, and the distinction matters more
   * than it looks. "Pending" promises a later read will finish the job and that
   * nothing has been lost. If a history row claims a reference or a campaign
   * identity another plan owns, no later read can ever apply it, and saying
   * "pending" would tell somebody to keep waiting for something that will not
   * happen.
   *
   * Reaching this should be impossible by construction — every shared identity is
   * claimed atomically before any history is written — so it is the answer for
   * data that predates that ordering or was corrupted outside it. 409, because the
   * obstacle is an ownership conflict a human must resolve, not a fault to retry. */
  CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE: { status: 409, code: "CAMPAIGN_DRAFT_HISTORY_UNPROJECTABLE" },

  /* A create arrived with no usable idempotency key, or a malformed one. 400: the
   * request is incomplete, and accepting it would mean a retry after an
   * interruption creates a second plan with a second reference and a second
   * identity claim. */
  CAMPAIGN_DRAFT_KEY_REQUIRED: { status: 400, code: "CAMPAIGN_DRAFT_KEY_REQUIRED" },

  /* The same creation key was used for a different payload. NOT answered with the
   * first plan: a client reusing a key for a new plan has a bug, and returning
   * somebody else's plan would hide it behind an apparent success. */
  CAMPAIGN_DRAFT_KEY_REUSED: { status: 409, code: "CAMPAIGN_DRAFT_KEY_REUSED" },

  /* ── A PLAN THE READINESS EVALUATOR WOULD NOT PASS ───────────────────────
   * Readiness used to say `approvalReady: false` while `submit()` happily moved the
   * same plan to awaiting_approval and `decide()` approved it. Two parts of one
   * product told a marketer two different things about one plan, and the one that
   * mattered — the one that actually moved the record — was the one that checked
   * nothing.
   *
   * Now submission and approval consult the same pure evaluator. Only LOCAL
   * blockers count: the external preflight checks belong to deployment and can
   * never clear inside GRAV, so blocking a submission on them would make an
   * approvable plan permanently unapprovable.
   *
   * 422 rather than 409: the request is understood, the plan's own content is the
   * obstacle, and the answer carries the findings a marketer can act on. */
  CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE: { status: 422, code: "CAMPAIGN_DRAFT_ADVERTISING_INCOMPLETE" },

  /* ── THE MARKETING CONTENT PLANNER ─────────────────────────────────────────
     A planning record. None of these means anything was created, scheduled,
     sent or published anywhere. Another company's item and a missing one share
     NOT_FOUND. A stale edit is a conflict, never a silent overwrite. A link the
     server could not confirm is refused rather than stored as though it were. */
  CONTENT_PLAN_ITEM_NOT_FOUND: { status: 404, code: "CONTENT_PLAN_ITEM_NOT_FOUND" },
  CONTENT_PLAN_REVISION_CONFLICT: { status: 409, code: "CONTENT_PLAN_REVISION_CONFLICT" },
  CONTENT_PLAN_STATE_CONFLICT: { status: 409, code: "CONTENT_PLAN_STATE_CONFLICT" },
  CONTENT_PLAN_DECISION_FORBIDDEN: { status: 403, code: "CONTENT_PLAN_DECISION_FORBIDDEN" },
  CONTENT_PLAN_ACTOR_UNVERIFIED: { status: 403, code: "CONTENT_PLAN_ACTOR_UNVERIFIED" },
  CONTENT_PLAN_KEY_REUSED: { status: 409, code: "CONTENT_PLAN_KEY_REUSED" },
  /* The linked campaign plan, owner or content asset does not exist for this
     company. 422: the request is understood and names something that is not
     there. */
  CONTENT_PLAN_LINK_NOT_FOUND: { status: 422, code: "CONTENT_PLAN_LINK_NOT_FOUND" },
  /* The content library could not be read, so the asset link could not be
     confirmed. Nothing was saved; saving without the link still works. */
  CONTENT_PLAN_LINK_UNCONFIRMED: { status: 503, code: "CONTENT_PLAN_LINK_UNCONFIRMED" },

  /* ── THE CREATIVE MEDIA LIBRARY ────────────────────────────────────────────
     Files for planned social content. Nothing here publishes anything, and its
     states say nothing about advertising approval. Another company's media and
     a forged reference both answer NOT_FOUND. */
  CREATIVE_MEDIA_NOT_FOUND: { status: 404, code: "CREATIVE_MEDIA_NOT_FOUND" },
  /* Withdrawn: kept for the record, never shown. */
  CREATIVE_MEDIA_WITHDRAWN: { status: 409, code: "CREATIVE_MEDIA_WITHDRAWN" },
  /* The stored bytes no longer hash to the recorded version. Not shown. */
  CREATIVE_MEDIA_INTEGRITY_FAILED: { status: 409, code: "CREATIVE_MEDIA_INTEGRITY_FAILED" },
  /* The upload did not arrive whole. Nothing was stored. */
  CREATIVE_MEDIA_UPLOAD_INCOMPLETE: { status: 400, code: "CREATIVE_MEDIA_UPLOAD_INCOMPLETE" },
  CREATIVE_MEDIA_TOO_LARGE: { status: 413, code: "CREATIVE_MEDIA_TOO_LARGE" },
  CREATIVE_MEDIA_UNSUPPORTED: { status: 415, code: "CREATIVE_MEDIA_UNSUPPORTED" },
  /* Storage could not take or return the file. Nothing was recorded. */
  CREATIVE_MEDIA_STORAGE_UNAVAILABLE: { status: 503, code: "CREATIVE_MEDIA_STORAGE_UNAVAILABLE" },
  CREATIVE_MEDIA_FORBIDDEN: { status: 403, code: "CREATIVE_MEDIA_FORBIDDEN" },

  /* ── DEPLOYING AN APPROVED PLAN INTO AN ADVERTISING ACCOUNT ────────────────
     Nothing has been created when any of these is returned.

     No account is bound to this company, or the bound one is withdrawn or could
     not be read. 409 rather than 400: the request is fine and the deployment's
     configuration is not, and the fix is somebody choosing an account rather
     than the caller sending different fields. */
  ADVERTISING_ACCOUNT_NOT_BOUND: { status: 409, code: "ADVERTISING_ACCOUNT_NOT_BOUND" },

  /* The plan's own content, or the account's own facts, mean this cannot be
     created — a headline Google will not accept, a currency the account does not
     bill in, a name already taken. 422 for the same reason readiness uses it: the
     request is understood, the obstacle is the content, and the answer carries the
     findings somebody can act on. */
  CAMPAIGN_DEPLOYMENT_NOT_READY: { status: 422, code: "CAMPAIGN_DEPLOYMENT_NOT_READY" },

  /* GRAV does not build this yet — Meta writes, activation, a campaign type with
     no mapper. Deliberately distinct from a validation error: the caller asked for
     something coherent that does not exist, and telling them their input was wrong
     would send them editing a correct request. */
  CAMPAIGN_DEPLOYMENT_NOT_BUILT: { status: 501, code: "CAMPAIGN_DEPLOYMENT_NOT_BUILT" },

  /* An earlier attempt was recorded as started and GRAV never learned how it
     ended, or this plan revision is already deployed. Objects may exist in the
     advertising account with no confirmed record, and creating now would make a
     duplicate. A person has to reconcile before anything else is attempted. */
  CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED: { status: 409, code: "CAMPAIGN_DEPLOYMENT_RECONCILIATION_REQUIRED" },

  /* ── PPC PLANNING (PPC Lane A — the order book and the planning file) ─────
   * Registered rather than left to fall through to VALIDATION, for the reason
   * the Mautic block above states: "your form is wrong" is unfixable advice
   * for most of what can go wrong here, and several of these are not the
   * caller's fault at all.
   *
   * The one worth reading twice is `PPC_ORDER_BOOK_UNAVAILABLE` at 503. A
   * register whose confirmed order lines could not be read must NOT answer 200
   * with an empty list: an empty order book reads as "no confirmed orders",
   * which is the single most misleading thing this screen could say. Same
   * reasoning as `MAUTIC_UNAVAILABLE` — silence and emptiness are different
   * facts, and only one of them is safe to render.
   *
   * `PPC_PLANNING_READINESS_UNDETERMINED` is 503 for the same reason: the
   * planner did nothing wrong, an upstream source could not be read, and
   * telling them their request was invalid would send them editing a correct
   * one. It is deliberately NOT the same code as PPC_PLANNING_NOT_READY, which
   * is a proved absence the planner can act on by chasing somebody. */
  PPC_ORDER_BOOK_UNAVAILABLE: { status: 503, code: "PPC_ORDER_BOOK_UNAVAILABLE" },
  PPC_ORDER_BOOK_VIEW_UNKNOWN: { status: 400, code: "PPC_ORDER_BOOK_VIEW_UNKNOWN" },
  PPC_ORDER_BOOK_LIMIT_INVALID: { status: 400, code: "PPC_ORDER_BOOK_LIMIT_INVALID" },
  PPC_ORDER_BOOK_CURSOR_INVALID: { status: 400, code: "PPC_ORDER_BOOK_CURSOR_INVALID" },

  PPC_ORDER_LINE_NOT_FOUND: { status: 404, code: "PPC_ORDER_LINE_NOT_FOUND" },
  PPC_ORDER_LINE_REQUIRED: { status: 400, code: "PPC_ORDER_LINE_REQUIRED" },

  PPC_PLANNING_FILE_NOT_FOUND: { status: 404, code: "PPC_PLANNING_FILE_NOT_FOUND" },
  /* Superseded or cancelled: it no longer owns its line, so it is not editable
     — and the refusal carries the successor's reference so a reader can follow. */
  PPC_PLANNING_FILE_CLOSED: { status: 400, code: "PPC_PLANNING_FILE_CLOSED" },

  /* 409, not 400: the line is a perfectly valid line and the request was well
     formed. What is missing is somebody else's document. */
  PPC_PLANNING_NOT_READY: { status: 409, code: "PPC_PLANNING_NOT_READY" },
  PPC_PLANNING_READINESS_UNDETERMINED: { status: 503, code: "PPC_PLANNING_READINESS_UNDETERMINED" },

  /* A body carrying an upstream identity, a frozen basis, a state or a later
     chunk's field. Named individually in `details.fields`, each with why. */
  PPC_PLANNING_FIELD_REFUSED: { status: 400, code: "PPC_PLANNING_FIELD_REFUSED" },
  PPC_PLANNING_FIELD_UNKNOWN: { status: 400, code: "PPC_PLANNING_FIELD_UNKNOWN" },

  /* Optimistic concurrency. Carries the revision to re-read. */
  PPC_PLANNING_REVISION_STALE: { status: 409, code: "PPC_PLANNING_REVISION_STALE" },
  PPC_EXPECTED_REVISION_REQUIRED: { status: 400, code: "PPC_EXPECTED_REVISION_REQUIRED" },
  PPC_PLANNING_STATE_INVALID: { status: 400, code: "PPC_PLANNING_STATE_INVALID" },

  PPC_PLANNING_OWNER_INVALID: { status: 400, code: "PPC_PLANNING_OWNER_INVALID" },
  PPC_PLANNING_PRIORITY_INVALID: { status: 400, code: "PPC_PLANNING_PRIORITY_INVALID" },
  PPC_PLANNING_TEXT_TOO_LONG: { status: 400, code: "PPC_PLANNING_TEXT_TOO_LONG" },
  PPC_PLANNING_DATE_INVALID: { status: 400, code: "PPC_PLANNING_DATE_INVALID" },
  PPC_PLANNING_WINDOW_INVALID: { status: 400, code: "PPC_PLANNING_WINDOW_INVALID" },
  PPC_PLANNING_ASSUMPTIONS_INVALID: { status: 400, code: "PPC_PLANNING_ASSUMPTIONS_INVALID" },
  PPC_HOLD_REASON_INVALID: { status: 400, code: "PPC_HOLD_REASON_INVALID" },
  /* Resuming planning must say what changed — enforced by the server so no
     client can lift a hold without an explanation. */
  PPC_HOLD_RESOLUTION_REQUIRED: { status: 400, code: "PPC_HOLD_RESOLUTION_REQUIRED" },
  /* PPC's multi-stage schedule. Stages come only from the IE process route
     frozen in the plan's release; an unproven route is a blocker, never a guess. */
  PPC_ROUTE_UNREADABLE: { status: 503, code: "PPC_ROUTE_UNREADABLE" },
  PPC_ROUTE_STAGE_UNKNOWN: { status: 409, code: "PPC_ROUTE_STAGE_UNKNOWN" },
  PPC_STAGE_NOT_IN_ROUTE: { status: 400, code: "PPC_STAGE_NOT_IN_ROUTE" },
  PPC_STAGE_DATES_INVALID: { status: 400, code: "PPC_STAGE_DATES_INVALID" },
  PPC_STAGE_PREDECESSOR_CONFLICT: { status: 400, code: "PPC_STAGE_PREDECESSOR_CONFLICT" },
  PPC_STAGE_SCHEDULE_UNCHANGED: { status: 400, code: "PPC_STAGE_SCHEDULE_UNCHANGED" },
  PPC_STAGE_REPLAN_REASON_REQUIRED: { status: 400, code: "PPC_STAGE_REPLAN_REASON_REQUIRED" },
  PPC_STAGE_SCHEDULE_CLOSED: { status: 409, code: "PPC_STAGE_SCHEDULE_CLOSED" },
  PPC_STAGE_SCHEDULE_STALE: { status: 409, code: "PPC_STAGE_SCHEDULE_STALE" },
  PPC_LINE_ROUTE_UNPROVEN: { status: 409, code: "PPC_LINE_ROUTE_UNPROVEN" },
  PPC_LINE_ROUTE_UNREADABLE: { status: 503, code: "PPC_LINE_ROUTE_UNREADABLE" },
  PROCESS_REQUIREMENT_EVIDENCE_REQUIRED: { status: 400, code: "PROCESS_REQUIREMENT_EVIDENCE_REQUIRED" },
  PROCESS_REQUIREMENT_RESTATE_REQUIRED: { status: 409, code: "PROCESS_REQUIREMENT_RESTATE_REQUIRED" },
  PPC_PUBLISH_STAGE_NOT_PUBLISHABLE: { status: 409, code: "PPC_PUBLISH_STAGE_NOT_PUBLISHABLE" },
  PPC_PUBLISH_SCHEDULE_STALE: { status: 409, code: "PPC_PUBLISH_SCHEDULE_STALE" },
  PPC_PUBLISH_SOURCE_MOVED: { status: 409, code: "PPC_PUBLISH_SOURCE_MOVED" },
  PPC_PUBLISH_NO_WORKORDER: { status: 409, code: "PPC_PUBLISH_NO_WORKORDER" },
  PPC_PUBLISH_WORKORDER_INELIGIBLE: { status: 409, code: "PPC_PUBLISH_WORKORDER_INELIGIBLE" },
  PPC_PUBLISH_CONTENT_CONFLICT: { status: 409, code: "PPC_PUBLISH_CONTENT_CONFLICT" },
  PPC_PUBLISH_LINE_ALREADY_TARGETED: { status: 409, code: "PPC_PUBLISH_LINE_ALREADY_TARGETED" },
  PPC_PUBLISH_REPLAN_REASON_REQUIRED: { status: 400, code: "PPC_PUBLISH_REPLAN_REASON_REQUIRED" },
  CUTTING_TARGET_NOT_FOUND: { status: 404, code: "CUTTING_TARGET_NOT_FOUND" },
  CUTTING_TARGET_ALREADY_ANSWERED: { status: 409, code: "CUTTING_TARGET_ALREADY_ANSWERED" },
  CUTTING_TARGET_PLAN_RETIRED: { status: 409, code: "CUTTING_TARGET_PLAN_RETIRED" },
  CUTTING_TARGET_REFUSAL_REASON_REQUIRED: { status: 400, code: "CUTTING_TARGET_REFUSAL_REASON_REQUIRED" },
  EMBROIDERY_TARGET_NOT_FOUND: { status: 404, code: "EMBROIDERY_TARGET_NOT_FOUND" },
  EMBROIDERY_TARGET_ALREADY_ANSWERED: { status: 409, code: "EMBROIDERY_TARGET_ALREADY_ANSWERED" },
  EMBROIDERY_TARGET_PLAN_RETIRED: { status: 409, code: "EMBROIDERY_TARGET_PLAN_RETIRED" },
  EMBROIDERY_TARGET_REFUSAL_REASON_REQUIRED: { status: 400, code: "EMBROIDERY_TARGET_REFUSAL_REASON_REQUIRED" },
  /* Sewing's target stands on a capacity booking PPC made separately. All
     three are 409: the request is well formed, and the reservation behind it
     is simply not one these dates may be published against. Telling a planner
     to check the form would be unfixable advice — the remedy is a booking or
     a schedule they decide on in their own screens. */
  PPC_PUBLISH_NO_CAPACITY_BOOKING: { status: 409, code: "PPC_PUBLISH_NO_CAPACITY_BOOKING" },
  PPC_PUBLISH_BOOKING_MISMATCH: { status: 409, code: "PPC_PUBLISH_BOOKING_MISMATCH" },
  PPC_PUBLISH_BOOKING_UNHEALTHY: { status: 409, code: "PPC_PUBLISH_BOOKING_UNHEALTHY" },
  SEWING_TARGET_NOT_FOUND: { status: 404, code: "SEWING_TARGET_NOT_FOUND" },
  SEWING_TARGET_ALREADY_ANSWERED: { status: 409, code: "SEWING_TARGET_ALREADY_ANSWERED" },
  SEWING_TARGET_PLAN_RETIRED: { status: 409, code: "SEWING_TARGET_PLAN_RETIRED" },
  SEWING_TARGET_REFUSAL_REASON_REQUIRED: { status: 400, code: "SEWING_TARGET_REFUSAL_REASON_REQUIRED" },
  SEWING_TARGET_BOOKING_INACTIVE: { status: 409, code: "SEWING_TARGET_BOOKING_INACTIVE" },
  /* Packing's target door. Packing reserves no capacity, so it has no
     booking code — the four below are the same four every receiver has. */
  PACKING_TARGET_NOT_FOUND: { status: 404, code: "PACKING_TARGET_NOT_FOUND" },
  PACKING_TARGET_ALREADY_ANSWERED: { status: 409, code: "PACKING_TARGET_ALREADY_ANSWERED" },
  PACKING_TARGET_PLAN_RETIRED: { status: 409, code: "PACKING_TARGET_PLAN_RETIRED" },
  PACKING_TARGET_REFUSAL_REASON_REQUIRED: { status: 400, code: "PACKING_TARGET_REFUSAL_REASON_REQUIRED" },
  /* Cutting's technical standard is IE's to publish. 409 on both: the request
     is well formed, and the engineering it needs simply is not there yet —
     telling a planner to check the form would be unfixable advice. */
  PPC_CUTTING_STANDARD_MISSING: { status: 409, code: "PPC_CUTTING_STANDARD_MISSING" },
  PPC_CUTTING_STANDARD_UNREADABLE: { status: 409, code: "PPC_CUTTING_STANDARD_UNREADABLE" },
  PPC_CUTTING_QUANTITY_UNKNOWN: { status: 409, code: "PPC_CUTTING_QUANTITY_UNKNOWN" },
  /* Cutting's own resources, and PPC's read-only preview against them. All
     409: the request is well formed and the cutting room simply cannot do the
     work yet — advice to check the form would be unfixable. */
  CUTTING_RESOURCE_INVALID: { status: 400, code: "CUTTING_RESOURCE_INVALID" },
  CUTTING_RESOURCE_NOT_FOUND: { status: 404, code: "CUTTING_RESOURCE_NOT_FOUND" },
  CUTTING_RESOURCE_REASON_REQUIRED: { status: 400, code: "CUTTING_RESOURCE_REASON_REQUIRED" },
  CUTTING_RESOURCE_IMMUTABLE: { status: 409, code: "CUTTING_RESOURCE_IMMUTABLE" },
  PPC_CUTTING_NO_PUBLISHED_RESOURCES: { status: 409, code: "PPC_CUTTING_NO_PUBLISHED_RESOURCES" },
  PPC_CUTTING_NO_ELIGIBLE_RESOURCE: { status: 409, code: "PPC_CUTTING_NO_ELIGIBLE_RESOURCE" },
  PPC_CUTTING_CAPACITY_INSUFFICIENT: { status: 409, code: "PPC_CUTTING_CAPACITY_INSUFFICIENT" },
  /* ── CUTTING CAPACITY BOOKING ────────────────────────────────────────────
     A cutting window is reserved on a Cutting-owned resource, never typed.
     Every code below is 409: each request is well formed, and what refuses it
     is the state of the world — a plan, a roster, a standard or somebody
     else's reservation. Telling a planner to check the form would be
     unfixable advice; the remedy is a fresh preview. */
  PPC_CUTTING_DATES_NOT_TYPED: { status: 409, code: "PPC_CUTTING_DATES_NOT_TYPED" },
  PPC_CUTTING_BOOKING_PROOF_REQUIRED: { status: 400, code: "PPC_CUTTING_BOOKING_PROOF_REQUIRED" },
  PPC_CUTTING_BOOKING_STALE: { status: 409, code: "PPC_CUTTING_BOOKING_STALE" },
  PPC_CUTTING_BOOKING_NOT_BOOKABLE: { status: 409, code: "PPC_CUTTING_BOOKING_NOT_BOOKABLE" },
  PPC_CUTTING_BOOKING_NOT_FOUND: { status: 404, code: "PPC_CUTTING_BOOKING_NOT_FOUND" },
  /* A resource id that is not in this company's PUBLISHED projection. Not
     found rather than forbidden: another company's table is not a table this
     one may be told exists. */
  PPC_CUTTING_RESOURCE_NOT_FOUND: { status: 404, code: "PPC_CUTTING_RESOURCE_NOT_FOUND" },
  PPC_CUTTING_BOOKING_CLOSED: { status: 409, code: "PPC_CUTTING_BOOKING_CLOSED" },
  PPC_CUTTING_BOOKING_PLAN_CLOSED: { status: 409, code: "PPC_CUTTING_BOOKING_PLAN_CLOSED" },
  PPC_CUTTING_BOOKING_NO_STAGE: { status: 409, code: "PPC_CUTTING_BOOKING_NO_STAGE" },
  PPC_CUTTING_BOOKING_REASON_INVALID: { status: 400, code: "PPC_CUTTING_BOOKING_REASON_INVALID" },
  PPC_CUTTING_BOOKING_IMMUTABLE: { status: 409, code: "PPC_CUTTING_BOOKING_IMMUTABLE" },
  PPC_CUTTING_CAPACITY_OVERBOOKED: { status: 409, code: "PPC_CUTTING_CAPACITY_OVERBOOKED" },
  /* Publishing a cutting target needs the exact reservation its dates came
     from — the same shape sewing's own booking gate already has. */
  PPC_PUBLISH_NO_CUTTING_BOOKING: { status: 409, code: "PPC_PUBLISH_NO_CUTTING_BOOKING" },
  PPC_PUBLISH_CUTTING_BOOKING_MISMATCH: { status: 409, code: "PPC_PUBLISH_CUTTING_BOOKING_MISMATCH" },
  PPC_SUCCESSOR_REASON_REQUIRED: { status: 400, code: "PPC_SUCCESSOR_REASON_REQUIRED" },
  PPC_CANCELLATION_REASON_INVALID: { status: 400, code: "PPC_CANCELLATION_REASON_INVALID" },
  /* A PLANNED file's planning fields are evidence of an approved plan. 409,
     because the request was well formed — the plan is simply no longer
     editable, and the way forward is a successor. */
  PPC_PLANNING_FILE_FROZEN: { status: 409, code: "PPC_PLANNING_FILE_FROZEN" },
  /* The line's last plan was cancelled; a new one must name it. */
  PPC_PLANNING_PRIOR_CANCELLED: { status: 409, code: "PPC_PLANNING_PRIOR_CANCELLED" },

  /* A planning decision has to be attributable to a person. 401, because the
     session is what is missing. */
  PPC_ACTOR_UNRESOLVED: { status: 401, code: "PPC_ACTOR_UNRESOLVED" },
  /* Retiring a plan and creating its successor are one fact. Without
     transactions neither happens, and the refusal says `wrote: NOTHING`. */
  PPC_PLANNING_TRANSACTION_REQUIRED: { status: 409, code: "PPC_PLANNING_TRANSACTION_REQUIRED" },

  /* ── PPC CAPACITY PLANNING (Lane A — capacity, first slice) ────────────────
   * A preview is not a booking, and these codes keep the difference audible.
   *
   * `PPC_CAPACITY_UNDETERMINED` is 503: an input could not be READ, the planner
   * did nothing wrong, and "your request was invalid" would send them editing a
   * correct one. `PPC_CAPACITY_NOT_BOOKABLE` is 409: every input was read and at
   * least one PROVES the booking cannot be made — a draft-only calendar, a gap
   * in it, a shortage, a moved source. `PPC_CAPACITY_OVERBOOKED` is 409 and is
   * what the database-level guard produces when a day filled between preview and
   * commit. `PPC_CAPACITY_STALE` names what moved since the preview. */
  PPC_CAPACITY_UNDETERMINED: { status: 503, code: "PPC_CAPACITY_UNDETERMINED" },
  PPC_CAPACITY_NOT_BOOKABLE: { status: 409, code: "PPC_CAPACITY_NOT_BOOKABLE" },
  PPC_CAPACITY_OVERBOOKED: { status: 409, code: "PPC_CAPACITY_OVERBOOKED" },
  PPC_CAPACITY_STALE: { status: 409, code: "PPC_CAPACITY_STALE" },
  PPC_CAPACITY_PROOF_REQUIRED: { status: 400, code: "PPC_CAPACITY_PROOF_REQUIRED" },
  PPC_CAPACITY_ALREADY_BOOKED: { status: 409, code: "PPC_CAPACITY_ALREADY_BOOKED" },
  PPC_CAPACITY_BOOKING_NOT_FOUND: { status: 404, code: "PPC_CAPACITY_BOOKING_NOT_FOUND" },
  PPC_CAPACITY_BOOKING_CLOSED: { status: 409, code: "PPC_CAPACITY_BOOKING_CLOSED" },
  PPC_CAPACITY_REVISION_STALE: { status: 409, code: "PPC_CAPACITY_REVISION_STALE" },
  PPC_CAPACITY_REASON_INVALID: { status: 400, code: "PPC_CAPACITY_REASON_INVALID" },
  PPC_CAPACITY_INPUT_INVALID: { status: 400, code: "PPC_CAPACITY_INPUT_INVALID" },
  PPC_CAPACITY_FIELD_UNKNOWN: { status: 400, code: "PPC_CAPACITY_FIELD_UNKNOWN" },
  PPC_CAPACITY_REF_TAKEN: { status: 409, code: "PPC_CAPACITY_REF_TAKEN" },
  /* The counter and the booking disagree. Never papered over: 409, nothing moved. */
  PPC_CAPACITY_LEDGER_MISMATCH: { status: 409, code: "PPC_CAPACITY_LEDGER_MISMATCH" },
  PPC_CALENDAR_NOT_FOUND: { status: 404, code: "PPC_CALENDAR_NOT_FOUND" },
  PPC_CALENDAR_CONTENT_INVALID: { status: 400, code: "PPC_CALENDAR_CONTENT_INVALID" },
  PPC_CALENDAR_VERSION_PUBLISHED: { status: 409, code: "PPC_CALENDAR_VERSION_PUBLISHED" },
  PPC_CALENDAR_REVISION_STALE: { status: 409, code: "PPC_CALENDAR_REVISION_STALE" },
  PPC_LINE_NOT_FOUND: { status: 404, code: "PPC_LINE_NOT_FOUND" },
  PPC_LINE_REVISION_STALE: { status: 409, code: "PPC_LINE_REVISION_STALE" },
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
