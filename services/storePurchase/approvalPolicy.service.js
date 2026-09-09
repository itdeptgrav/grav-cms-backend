// services/storePurchase/approvalPolicy.service.js
//
// Store & Purchase — Chunk 1. WHO MAY APPROVE THIS PARTICULAR DOCUMENT.
//
// ── WHAT THIS IS AND IS NOT ─────────────────────────────────────────────────
// It is a foundation the later requisition and sourcing chunks will use. It
// is NOT a new workflow: the only transition it guards today is the one that
// already exists — a purchase order moving DRAFT → ISSUED, which currently
// stamps `approvedBy` from whoever called the endpoint, with no check.
//
// ── NO MATCH IS A REFUSAL ───────────────────────────────────────────────────
// An earlier version of this file returned `allowed: true` when no policy
// matched, on the reasoning that "the route capability still applies". That
// was wrong twice over: it made an UNCONFIGURED company behave exactly like a
// fully-approved one, and it quietly reinterpreted a capability check as
// approval-policy enforcement. They are two separate gates and both must
// pass — a buyer holding `sp.po.issue` has the authority to operate the
// endpoint, not the company's authority to commit that sum of money.
//
// So: no matching active policy REFUSES issuance with POLICY_NOT_CONFIGURED,
// and somebody with `sp.policy.admin` has to configure the company before
// orders can be issued. Failing closed on an unconfigured system is the whole
// point of a policy gate.
"use strict";

const SpApprovalPolicy = require("../../models/CMS_Models/StorePurchase/SpApprovalPolicy");
const { hasAll } = require("./capabilities");
const { fail } = require("./errors");

const OUTCOMES = Object.freeze({
  MATCHED: "MATCHED",
  NONE_MATCHED: "NONE_MATCHED",
  AMBIGUOUS: "AMBIGUOUS",
});

/**
 * Find the one policy governing a document.
 *
 * @returns {Promise<{outcome, policy?, candidates?}>}
 */
async function resolvePolicy({
  companyId, documentType, amount = 0, siteId = null,
  isEmergency = false, at = new Date(),
}) {
  if (!companyId) throw fail("VALIDATION", "Policy resolution needs a company.");

  const now = new Date(at);
  const rows = await SpApprovalPolicy.find({
    companyId,
    documentType,
    isActive: true,
    isEmergencyPolicy: Boolean(isEmergency),
  }).lean();

  const value = Number(amount) || 0;

  const candidates = rows.filter((p) => {
    /* Effective window — an open end is "still in force". */
    if (p.effectiveFrom && now < new Date(p.effectiveFrom)) return false;
    if (p.effectiveTo && now > new Date(p.effectiveTo)) return false;
    /* Site: a policy with no site applies company-wide; one with a site
       applies only there. It never applies to a DIFFERENT site. */
    if (p.siteId && String(p.siteId) !== String(siteId || "")) return false;
    /* Amount band: inclusive lower, exclusive upper, open top. */
    if (value < (p.minAmount || 0)) return false;
    if (p.maxAmount !== null && p.maxAmount !== undefined && value >= p.maxAmount) return false;
    return true;
  });

  const context = { documentType, amount: value, isEmergency: Boolean(isEmergency) };

  if (candidates.length === 0) return { outcome: OUTCOMES.NONE_MATCHED, ...context };

  if (candidates.length > 1) {
    /* A site-specific rule is more specific than a company-wide one, and that
       is a deliberate precedence rather than an accident of ordering. Any
       remaining tie is a configuration error and is refused, not resolved:
       picking one would hide the mistake and approve money by a rule nobody
       meant to write. */
    const sited = candidates.filter((p) => p.siteId);
    const shortlist = sited.length ? sited : candidates;
    if (shortlist.length > 1) {
      return {
        outcome: OUTCOMES.AMBIGUOUS,
        ...context,
        candidates: shortlist.map((p) => ({
          id: String(p._id), minAmount: p.minAmount, maxAmount: p.maxAmount,
        })),
      };
    }
    return { outcome: OUTCOMES.MATCHED, policy: shortlist[0], ...context };
  }

  return { outcome: OUTCOMES.MATCHED, policy: candidates[0], ...context };
}

/**
 * May this actor act at the given level of the resolved policy?
 *
 * Returns a decision object rather than throwing, so the caller can record
 * WHY in history — "no policy matched" and "policy required an authority you
 * do not hold" are different facts about the same refusal.
 */
function evaluate({ resolution, ctx, level = 1 }) {
  if (resolution.outcome === OUTCOMES.AMBIGUOUS) {
    throw fail(
      "POLICY_AMBIGUOUS",
      "More than one approval rule applies to this document. Ask an administrator to correct the approval policy.",
      { candidates: resolution.candidates },
    );
  }

  if (resolution.outcome === OUTCOMES.NONE_MATCHED) {
    /* FAIL CLOSED. An unconfigured company cannot issue orders. */
    throw fail(
      "POLICY_NOT_CONFIGURED",
      resolution.isEmergency
        ? "No emergency approval rule is configured for this company, so an emergency order cannot be issued. Ask an administrator to configure one."
        : "No approval rule is configured for this company, so orders cannot be issued yet. Ask an administrator to configure approval policy.",
      { documentType: resolution.documentType, amount: resolution.amount, isEmergency: Boolean(resolution.isEmergency) },
    );
  }

  const levels = resolution.policy.levels || [];
  const rule = levels.find((l) => l.level === level) || levels[0];
  if (!rule) {
    /* A policy row that names no level authorises nobody. Treating an empty
       level set as "anyone" would make a half-written policy more permissive
       than no policy at all. */
    throw fail(
      "POLICY_NOT_CONFIGURED",
      "The approval rule for this company names no approver. Ask an administrator to correct it.",
      { policy: String(resolution.policy._id) },
    );
  }

  if (rule.requiredCapability && !hasAll(ctx.capabilitySet, rule.requiredCapability)) {
    return {
      allowed: false,
      policy: String(resolution.policy._id),
      level: rule.level,
      requiredCapability: rule.requiredCapability,
    };
  }

  return {
    allowed: true,
    policy: String(resolution.policy._id),
    level: rule.level,
    requiredCapability: rule.requiredCapability || null,
  };
}

module.exports = { OUTCOMES, resolvePolicy, evaluate };
