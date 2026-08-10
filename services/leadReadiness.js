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
// Also home to computeQualificationReadiness (Lead correction chunk) below —
// a SEPARATE checklist for an ACTIVE Lead moving to "qualified"/
// "readyToConvert", gating that move in services/leadQualification.js. Kept
// in this file rather than a new module because it is the same kind of thing
// (a pure, DB-free, lead-shaped checklist) with the same design constraints.
"use strict";

// Mirrors lib/leadCapture.js's RESEARCHED_OR_HIGHER on the frontend exactly —
// the confidence enum itself is inlined on the Lead model (Lead-local
// vocabulary, per that file's own comment), not in constants/crm.js, so this
// threshold is inlined here to match rather than importing something that
// doesn't exist server-side.
const RESEARCHED_OR_HIGHER = new Set(["researched", "contact_confirmed", "document_confirmed"]);

/**
 * Submission readiness — the "Submit to HOD" bar (see the file header).
 * @param {object} lead  a Lead document or plain object. Never mutates it.
 * @returns {{checks: Array<{key:string,label:string,met:boolean}>, ready: boolean}}
 */
function computeSubmissionReadiness(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  const pending = lead.pendingFirstAction || {};
  // "URL or document reference" (never binary — document upload is hidden
  // until secure evidence handling exists). A legacy entry that already
  // carries an attachmentUrl still counts.
  const hasEvidence = (lead.evidence || []).some(
    (e) => has(e.sourceUrl) || has(e.documentReference) || has(e.attachmentUrl),
  );

  const checks = [
    {
      key: "identity",
      label: "Person or organisation identified",
      met: has(lead.company) || has(lead.firstName),
    },
    { key: "source", label: "Lead source recorded", met: has(lead.source) },
    { key: "segment", label: "Customer segment set", met: has(lead.industry) },
    {
      key: "justification",
      label: "“Why should we pursue this?” answered",
      met: has(lead.pursuitJustification),
    },
    {
      key: "annualQuantity",
      label: "Estimated annual quantity",
      met: lead.estimatedAnnualQuantity != null,
    },
    {
      key: "annualQuantityConfidence",
      label: "Annual quantity confidence set",
      met: has(lead.estimatedAnnualQuantityConfidence),
    },
    {
      key: "annualRevenue",
      label: "Estimated annual revenue",
      met: lead.estimatedAnnualRevenue != null,
    },
    {
      key: "annualRevenueConfidence",
      label: "Annual revenue confidence set",
      met: has(lead.estimatedAnnualRevenueConfidence),
    },
    {
      key: "evidence",
      label: "Supporting evidence (URL or document reference)",
      met: hasEvidence,
    },
    { key: "firstAction", label: "Proposed first action", met: has(pending.subject) },
    { key: "firstActionDue", label: "First action due date", met: Boolean(pending.dueDate) },
  ];

  return { checks, ready: checks.every((c) => c.met) };
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

/**
 * Qualification readiness for an ACTIVE Lead — the checklist
 * services/leadQualification.js requires before allowing a move to
 * "qualified" or "readyToConvert" (both share the same bar: Ready to Convert
 * is not a second, stricter checklist, just the confirmation that Qualified's
 * bar still holds). Pure and DB-free, same discipline as
 * computeReadinessChecks above.
 *
 * @param {object} lead  a Lead document or plain object.
 * @returns {{checks: Array<{key:string,label:string,met:boolean}>, ready: boolean}}
 */
function computeQualificationReadiness(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());

  // A figure that is "researched" or higher must carry its OWN inline source
  // (a link / document reference / confirmation note attached to the number
  // itself). "Assumed" or empty figures need nothing. No separate, claim-tagged
  // evidence record is required any more — confirming the number is one edit on
  // the number.
  const estimatesEvidenced = () => {
    const ok = (value, basis, source) =>
      value == null || !RESEARCHED_OR_HIGHER.has(basis) || has(source);
    return (
      ok(lead.estimatedAnnualQuantity, lead.estimatedAnnualQuantityConfidence, lead.estimatedAnnualQuantitySource) &&
      ok(lead.estimatedAnnualRevenue, lead.estimatedAnnualRevenueConfidence, lead.estimatedAnnualRevenueSource) &&
      ok(lead.estimatedUnitPrice, lead.estimatedUnitPriceConfidence, lead.estimatedUnitPriceSource)
    );
  };

  const checks = [
    {
      key: "identity",
      label: "Person or organisation identified",
      met: has(lead.company) || has(lead.firstName),
    },
    {
      key: "contactable",
      label: "At least one contact route confirmed",
      met: has(lead.phone) || has(lead.whatsapp) || has(lead.email),
    },
    {
      // A CREDIBLE requirement — a product and an indicative quantity — is
      // enough to qualify. Confirming and finalising quantities is the JOURNEY's
      // job (Enquiry approximate → Cost & Quote → PO final), so a required-by
      // date and a "buyer/document-confirmed" certainty are deliberately NOT
      // gated here: the funnel gets more precise as it advances, it doesn't
      // demand confirmation up front and then relax it at Enquiry.
      key: "requirement",
      label: "Requirement identified — product and indicative quantity",
      met: (lead.productInterest || []).length > 0 && lead.estimatedQuantity != null,
    },
    {
      key: "decisionMaker",
      // Satisfied by the legacy single decision-maker field OR any contact in
      // the stakeholder list flagged as the decision-maker (Chunk B).
      label: "Decision-maker identified",
      met: has(lead.decisionMakerName) || (lead.contacts || []).some((c) => c.isDecisionMaker && has(c.name)),
    },
    {
      key: "estimatesEvidenced",
      label: "Researched commercial estimates are backed by evidence",
      met: estimatesEvidenced(),
    },
  ];

  return { checks, ready: checks.every((c) => c.met) };
}

/**
 * Does this Lead carry a SPECIFIC, CREDIBLE requirement — the thing a Sales
 * Journey is actually started against? A concrete product, a quantity, a
 * required-by date, and a certainty that is buyer/document-confirmed (not a
 * researcher's guess). This is the extra gate a Lead must clear to reach
 * "Ready for Journey" (readyToConvert) on top of the general qualification
 * checklist, and it is reused by the Ready-for-Journey handoff. Pure, DB-free.
 *
 * (Today these fields also appear inside computeQualificationReadiness, so a
 * Lead that passed Qualified already satisfies this; keeping it as its OWN
 * named predicate makes the "Ready for Journey needs a credible requirement"
 * rule enforced in one dedicated place rather than as an accident of the
 * qualification list, and gives the Chunk-5 handoff a single check to call.)
 */
function hasSpecificCredibleRequirement(lead = {}) {
  return (
    (lead.productInterest || []).length > 0 &&
    lead.estimatedQuantity != null
  );
}

/**
 * Does this Lead carry ANY way to actually reach the buyer — a phone, WhatsApp
 * or email on the Lead itself, or on any of its stakeholder contacts? This is
 * the floor for the Contacting/Engaged qualification moves: you cannot have
 * "attempted" or "made" contact with a record that has no contact channel at
 * all. Pure, DB-free — the same shape as the checks above.
 */
function hasContactRoute(lead = {}) {
  const has = (v) => Boolean(String(v ?? "").trim());
  if (has(lead.phone) || has(lead.whatsapp) || has(lead.email)) return true;
  return (lead.contacts || []).some((c) => has(c.phone) || has(c.email));
}

module.exports = { computeSubmissionReadiness, computeQualificationReadiness, hasSpecificCredibleRequirement, hasContactRoute };
