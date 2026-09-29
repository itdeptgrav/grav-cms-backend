// services/leadReadiness.js
//
// Submission readiness for a Prospect (Prospect → HOD Review → Active Lead
// workflow) — the exact checklist a salesperson must satisfy before "Submit
// to HOD" is allowed, enforced server-side by routes/CMS_Routes/Sales/
// leads.js's POST /:id/submit (the UI shows the same list, but the backend
// is the gate). From the product spec's "Submission readiness must require":
//   • valid person or organisation identity
//   • Lead source
//   • Customer segment
//   • a short "Why should we pursue this?" justification
//   • estimated annual quantity AND revenue
//   • confidence for BOTH estimates
//   • at least one supporting evidence URL or document reference
//   • a proposed first action AND its due date
// Deliberately does NOT include contact info (phone/email may be exactly what
// the Prospect needs researching), owner (auto-credited to the creator, never
// chosen at capture), duplicate review (informational only), or any CONFIRMED
// requirement field (those are researched-estimate-vs-confirmed-requirement's
// other axis, Active-Lead territory — kept separate, per the spec).
//
// Pure and DB-free on purpose — nothing here needs the database at all, so
// the caller can call this with just the Lead document/object.
//
// Also home to the ACTIVE LEAD's two gates below —
// computeRequirementIdentifiedReadiness ("we know what requirement we are
// investigating") and computeEnquiryReadiness ("enough is confirmed to raise
// the Enquiry") — which gate those moves in services/leadQualification.js and
// are re-run by assertLeadConvertible at Journey creation, because a stored
// `readyToConvert` records that the bar was cleared once, not that it still
// is. Kept in this file rather than a new module because they are the same
// kind of thing (pure, DB-free, lead-shaped checklists) with the same design
// constraints.
"use strict";

// Mirrors lib/leadCapture.js's RESEARCHED_OR_HIGHER on the frontend exactly —
// the confidence enum itself is inlined on the Lead model (Lead-local
// vocabulary, per that file's own comment), not in constants/crm.js, so this
// threshold is inlined here to match rather than importing something that
// doesn't exist server-side.
const RESEARCHED_OR_HIGHER = new Set(["researched", "contact_confirmed", "document_confirmed"]);

// The tier at which a REQUIREMENT (a different axis from the commercial
// estimates above) counts as confirmed. Imported rather than re-declared —
// this is the vocabulary's own definition, and a second copy is a second rule.
const { REQUIREMENT_CERTAINTY_CONFIRMED } = require("../constants/crm");

/**
 * Prospect conversion readiness — what must be true before a Prospect can
 * become a Lead.
 *
 * ── WHAT THIS USED TO ASK, AND WHY IT STOPPED ───────────────────────────────
 * It asked a salesperson to commercially qualify a possible customer:
 * estimated annual quantity, estimated annual revenue, a confidence level for
 * each, a customer segment, a written case for pursuing them, and supporting
 * evidence with a URL or document reference. Nine checks, most of them
 * guesses, on a record whose entire purpose is to find out whether there is
 * anything here at all.
 *
 * The predictable result of asking for numbers nobody can know yet is that
 * they get invented — and once invented they are indistinguishable from
 * researched ones, which is worse than not collecting them.
 *
 * ── WHAT IT ASKS NOW ────────────────────────────────────────────────────────
 * Only what a salesperson genuinely knows by the time a Prospect is worth
 * promoting: who they are, how to reach them, where they came from, that
 * somebody actually made contact, and what the customer did that suggests
 * real interest. Every one of those is an observation, not a forecast.
 *
 * ── THE COMMERCIAL FIELDS ARE NOT DELETED ───────────────────────────────────
 * `estimatedAnnualQuantity`, `estimatedAnnualRevenue`, their confidences,
 * `industry`, `pursuitJustification` and `evidence[]` all remain on the model
 * and keep whatever they already hold. They are simply no longer a gate on a
 * Prospect. Where they belong is on an Active Lead being qualified — see
 * `computeQualificationReadiness` below, which still asks for them and is
 * untouched.
 *
 * Still pure and DB-free. The one fact that needs the database — has anybody
 * actually spoken to this customer — is passed IN rather than queried here, so
 * this stays a function of its arguments and the caller keeps the round trip.
 *
 * @param {object} lead  a Lead document or plain object. Never mutates it.
 * @param {object} [facts]
 * @param {boolean} [facts.hasSuccessfulInteraction]  a completed call, email or
 *        message exists in this Prospect's activity history.
 * @returns {{checks: Array<{key:string,label:string,met:boolean}>, ready: boolean}}
 */
function computeSubmissionReadiness(lead = {}, facts = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  const pending = lead.pendingFirstAction || {};

  /* A Company needs a company name; an Individual needs a first name. Asking
     for both would refuse a real sole trader, and asking for either would let
     a company through with only a contact's name and no organisation.

     ── AND THE LABEL IS NOT TRUSTED OVER THE DATA ──────────────────────────
     `prospectType` defaults to "individual", so every Prospect created before
     anybody chose a type carries that label — including the ones that are
     plainly companies, with a company name and no contact name on file.
     Reading the stored label alone would refuse all of them at conversion,
     which is a migration disguised as a validation rule.

     So a record holding a company name and no first name is treated as the
     company it evidently is, whatever the default said. An explicit choice
     still governs: type "company" with no company name is refused, and that
     is the rule the form enforces at the point somebody actually picks. */
  const isCompany =
    lead.prospectType === "company" || (has(lead.company) && !has(lead.firstName));
  const identityMet = isCompany ? has(lead.company) : has(lead.firstName);

  const checks = [
    {
      key: "identity",
      label: isCompany ? "Company name recorded" : "Contact name recorded",
      met: identityMet,
    },
    {
      key: "contact",
      label: "A phone, WhatsApp or email to reach them on",
      met: hasContactRoute(lead),
    },
    { key: "source", label: "Where this Prospect came from", met: has(lead.source) },
    {
      /* Not "an activity exists" and not "an attempt was made": a PLANNED
         follow-up is an intention, and a call that rang out is an intention
         that was acted on. The bar is that the CUSTOMER engaged — the caller
         resolves it from SUCCESSFUL_CONTACT_OUTCOMES. */
      key: "interaction",
      label: "The customer replied, connected or met with us",
      met: Boolean(facts.hasSuccessfulInteraction),
    },
    {
      key: "interestSignal",
      label: "What the customer did that showed interest",
      met: has(lead.interestSignal),
    },
    {
      key: "interestNote",
      label: "A note on that interest",
      met: has(lead.interestNote),
    },
    { key: "firstAction", label: "The next action", met: has(pending.subject) },
    { key: "firstActionDue", label: "When it is due", met: Boolean(pending.dueDate) },
  ];

  /* ── TWO BARS, BECAUSE THE SECOND IS ANSWERED IN A DIALOG ────────────────
     The interest signal and note are typed into the confirmation dialog, and
     that dialog is opened by the Convert button. Gating that button on the
     FULL checklist deadlocked the screen: the two fields could only be
     supplied through a control that stayed disabled until they were supplied.

     So readiness is reported in two parts.

       readyToConfirm  everything a salesperson can do on the form itself.
                       This is what the button may gate on.
       ready           the same, plus what the dialog collects. This is what
                       the server enforces at conversion, unchanged.

     Splitting the REPORT does not weaken the RULE — `ready` still requires all
     eight and no endpoint accepts less. It only stops the screen asking for
     something down a road it has closed. */
  const CONFIRM_ONLY = new Set(["interestSignal", "interestNote"]);
  const preConfirmChecks = checks.filter((c) => !CONFIRM_ONLY.has(c.key));

  return {
    checks,
    ready: checks.every((c) => c.met),
    readyToConfirm: preConfirmChecks.every((c) => c.met),
    /* So a screen can name what still blocks the BUTTON without listing the
       dialog's own fields as blockers before the dialog can open. */
    preConfirmChecks,
  };
}

/**
 * Does `evidence[]` contain at least one entry supporting `claim` with a real
 * source (URL, doc reference or attached document)? Same rule as the
 * frontend's lib/leadCapture.js hasSupportingEvidence, reimplemented here so
 * it can be enforced server-side at qualification time (not just client-side
 * at Draft-save time, which is all the frontend check ever gated).
 */
function hasSupportingEvidence(evidence, claim) {
  return (evidence || []).some(
    (e) =>
      e.claim === claim &&
      (String(e.sourceUrl || "").trim() || String(e.documentReference || "").trim() || String(e.attachmentUrl || "").trim()),
  );
}

/* ── ONE REQUIREMENT, READ THE SAME WAY BY BOTH GATES ──────────────────────
   The structured breakdown (`requirementItems[]`) is the real answer: a
   product and a quantity per line. `productInterest[]` and `estimatedQuantity`
   are the flat projection kept in sync FROM it.

   Records captured before the structured field existed carry only the flat
   pair. Refusing those would be a migration disguised as a validation rule —
   the Lead would be stuck until somebody retyped a requirement it already
   holds — so the flat pair is accepted as the equivalent it is. New work goes
   through the structured field; old work is not punished for its age. */
function requirementFacts(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  const items = (lead.requirementItems || []).filter((i) => has(i?.product));
  const structuredQty = items.reduce((n, i) => n + (Number(i.quantity) || 0), 0);

  const legacyProduct = (lead.productInterest || []).some((p) => has(p));
  const legacyQty = Number(lead.estimatedQuantity) || 0;

  return {
    hasProduct: items.length > 0 || legacyProduct,
    // Deliberately "> 0", not "!= null": a requirement for zero pieces is not a
    // requirement, and `estimatedQuantity: 0` used to satisfy the old check.
    hasQuantity: structuredQty > 0 || legacyQty > 0,
    structured: items.length > 0,
  };
}

/**
 * REQUIREMENT IDENTIFIED (`qualified`) — "we know what requirement we are
 * investigating", which is not the same as "everything is confirmed".
 *
 * Three things, and deliberately no more: a product, an indicative quantity
 * above zero, and a certainty that is something other than "unknown".
 * `suspected` counts — a suspicion you can name is exactly what this stage is
 * for. Annual revenue, annual quantity, budget and delivery dates are NOT
 * asked here; a Lead that must forecast a year's business before it can say
 * what the customer asked about is a Lead nobody will move.
 *
 * Pure and DB-free, like every other checklist in this file.
 */
function computeRequirementIdentifiedReadiness(lead = {}) {
  const req = requirementFacts(lead);
  const certainty = lead.requirementCertainty || "unknown";

  const checks = [
    {
      key: "requirementProduct",
      label: "What they are asking about — at least one product",
      met: req.hasProduct,
    },
    {
      key: "requirementQuantity",
      label: "An indicative quantity",
      met: req.hasQuantity,
    },
    {
      key: "requirementCertainty",
      label: "How firmly the requirement is known — anything but Unknown",
      met: certainty !== "unknown",
    },
  ];

  return { checks, ready: checks.every((c) => c.met) };
}

/**
 * READY FOR ENQUIRY (`readyToConvert`) — everything Requirement Captured
 * asked, plus what an Enquiry cannot be raised without.
 *
 * The certainty bar rises here and only here: a `suspected` requirement is
 * enough to investigate, not enough to raise an Enquiry against. What is still
 * NOT asked is a final quantity, a final price, a PO or a contract — those are
 * the Journey's job, and demanding them up front then relaxing them at Enquiry
 * would be the funnel running backwards.
 *
 * The commercial estimates are OPTIONAL. Nothing here requires one to exist.
 * The only rule is that an estimate a salesperson has presented as researched
 * or confirmed carries its own source — an unevidenced "researched" figure is
 * indistinguishable from a guess, which is the whole problem.
 */

/* ── WHO COUNTS AS A DECISION-MAKER ────────────────────────────────────────
 * Contacts are the buyer authority. A person satisfies this only if they are
 * ACTUALLY one: flagged as the decision-maker (or carrying the canonical
 * `decision_maker` role), still at the organisation, and reachable. Somebody
 * who has left, is blocked or is marked do-not-contact cannot approve an order
 * — naming them would let a Lead qualify on a person nobody may call.
 *
 * A committee is normal, so this asks for AT LEAST ONE, never exactly one.
 *
 * The legacy Lead-level `decisionMakerName` is a FALLBACK, not an alternative:
 * it applies only to records that have no embedded contacts at all. Accepting
 * both on the same Lead is what made a salesperson maintain the same buyer
 * twice, each copy able to satisfy the gate on its own. Historical values are
 * untouched — they simply stop being a second thing to keep current.
 */
const CONTACTABLE_CONTACT_STATUSES = new Set(["active"]);

function isUsableDecisionMaker(c = {}) {
  const named = Boolean(String(c.name ?? "").trim());
  const flagged = c.isDecisionMaker === true || c.roleCode === "decision_maker";
  const reachable = !c.status || CONTACTABLE_CONTACT_STATUSES.has(c.status);
  return named && flagged && reachable;
}

/** Decision-maker identified, and where the answer came from. */
function decisionMakerFacts(lead = {}) {
  const contacts = Array.isArray(lead.contacts) ? lead.contacts : [];
  if (contacts.length) {
    return { met: contacts.some(isUsableDecisionMaker), source: "contacts" };
  }
  return { met: Boolean(String(lead.decisionMakerName ?? "").trim()), source: "legacy" };
}

/* ── EVIDENCE IS EVIDENCE, WHEREVER IT WAS TYPED ───────────────────────────
 * A researched-or-higher figure still needs support — that rule does not move.
 * What changes is where the support may live: the estimate's own inline source
 * OR an Evidence entry tied to THAT estimate's claim. Requiring the inline box
 * even when the Evidence section already held the tender notice backing the
 * number meant typing the same reference twice to satisfy a check that was
 * already satisfied in substance.
 *
 * Unrelated evidence never counts. A `general` note, or a document supporting
 * the requirement, says nothing about an annual revenue figure — matching on
 * claim is the whole point, and a looser rule would let any attachment clear
 * every estimate.
 */
const ESTIMATE_CLAIM = {
  estimatedAnnualQuantity: "annual_quantity",
  estimatedAnnualRevenue: "annual_revenue",
};

function hasEvidenceForClaim(lead = {}, claim) {
  if (!claim) return false;
  return (Array.isArray(lead.evidence) ? lead.evidence : []).some((e) => {
    if (!e || e.claim !== claim) return false;
    /* A row with no reference of any kind supports nothing — an empty evidence
       entry naming a claim is a placeholder, not proof. The field names are
       the evidence schema's own: sourceUrl / documentReference / attachmentUrl
       / note. */
    return ["sourceUrl", "documentReference", "attachmentUrl", "note"]
      .some((k) => Boolean(String(e[k] ?? "").trim()));
  });
}

function computeEnquiryReadiness(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  const req = requirementFacts(lead);

  // A figure that is "researched" or higher must carry its OWN inline source
  // (a link / document reference / confirmation note attached to the number
  // itself). "Assumed" or empty figures need nothing.
  const ok = (field, value, basis, source) =>
    value == null
    || !RESEARCHED_OR_HIGHER.has(basis)
    || has(source)
    || hasEvidenceForClaim(lead, ESTIMATE_CLAIM[field]);
  const estimatesEvidenced =
    ok("estimatedAnnualQuantity", lead.estimatedAnnualQuantity, lead.estimatedAnnualQuantityConfidence, lead.estimatedAnnualQuantitySource) &&
    ok("estimatedAnnualRevenue", lead.estimatedAnnualRevenue, lead.estimatedAnnualRevenueConfidence, lead.estimatedAnnualRevenueSource) &&
    /* Unit price has no claim code of its own in the evidence vocabulary, so
       its inline source remains the only way to support it. Inventing a code
       here would be a schema change this chunk does not need. */
    ok("estimatedUnitPrice", lead.estimatedUnitPrice, lead.estimatedUnitPriceConfidence, lead.estimatedUnitPriceSource);

  const checks = [
    {
      key: "identity",
      label: "Person or organisation identified",
      met: has(lead.company) || has(lead.firstName),
    },
    {
      key: "contactable",
      label: "At least one contact route confirmed",
      met: hasContactRoute(lead),
    },
    {
      key: "requirement",
      label: "Requirement identified — product and indicative quantity",
      met: req.hasProduct && req.hasQuantity,
    },
    {
      key: "requirementConfirmed",
      label: "Requirement confirmed by the customer or a document",
      met: REQUIREMENT_CERTAINTY_CONFIRMED.has(lead.requirementCertainty),
    },
    {
      key: "decisionMaker",
      /* Named for where the answer is given, because the checklist is also the
         navigation: this item sends a salesperson to the Contacts editor, not
         to a field that no longer exists. */
      label: "Someone in Contacts marked as a decision-maker",
      met: decisionMakerFacts(lead).met,
    },
    {
      key: "estimatesEvidenced",
      label: "Any researched commercial estimate has its source",
      met: estimatesEvidenced,
    },
  ];

  return { checks, ready: checks.every((c) => c.met) };
}

/**
 * The Ready-for-Enquiry checklist under its historical name.
 *
 * Kept because `/readiness` and the Lead workspace both call it, and because
 * "qualification readiness" is still the honest description of the stricter of
 * the two gates. It is now a thin alias rather than a third definition — one
 * rule with two names beats two rules that agree until they do not.
 */
function computeQualificationReadiness(lead = {}) {
  return computeEnquiryReadiness(lead);
}

/**
 * Does this Lead carry a requirement specific enough to raise an Enquiry
 * against — a named product and an indicative quantity above zero?
 *
 * ── A CORRECTED COMMENT ─────────────────────────────────────────────────────
 * This used to describe itself as requiring "a required-by date, and a
 * certainty that is buyer/document-confirmed". It never checked either. The
 * date is not a rule at all — it belongs to the Journey — and the certainty
 * rule is real but lives in computeEnquiryReadiness where it can be reported
 * as a named, fixable check rather than a silent predicate.
 */
function hasSpecificCredibleRequirement(lead = {}) {
  const req = requirementFacts(lead);
  return req.hasProduct && req.hasQuantity;
}

/**
 * Does this Lead carry ANY way to actually reach the buyer — a phone, WhatsApp
 * or email on the Lead itself, or on any of its stakeholder contacts?
 *
 * This used to describe itself as "the floor for the Contacting/Engaged
 * qualification moves". Those two states are legacy-only and nothing targets
 * them, so that is no longer where this is asked. It is the `contactable`
 * check on the READY FOR ENQUIRY bar, and the Prospect's own contact check —
 * an Enquiry cannot be raised against a customer nobody can reach.
 *
 * Pure, DB-free — the same shape as the checks above.
 */
function hasContactRoute(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  if (has(lead.phone) || has(lead.whatsapp) || has(lead.email)) return true;
  return (lead.contacts || []).some((c) => has(c.phone) || has(c.email));
}

module.exports = {
  computeSubmissionReadiness,
  computeRequirementIdentifiedReadiness,
  computeEnquiryReadiness,
  decisionMakerFacts,
  isUsableDecisionMaker,
  hasEvidenceForClaim,
  computeQualificationReadiness,
  hasSpecificCredibleRequirement,
  hasContactRoute,
  requirementFacts,
};
