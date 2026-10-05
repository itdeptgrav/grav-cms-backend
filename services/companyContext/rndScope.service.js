// services/companyContext/rndScope.service.js
//
// WHICH COMPANY AN R&D REQUEST IS ACTING FOR, AND WHETHER THIS STYLE IS ITS.
//
// ── TWO SEPARATE QUESTIONS, DELIBERATELY ────────────────────────────────────
// The first is about the ACTOR: which company's books are they a member of,
// and which one did they select. That is `companyMembership.service`'s answer
// and nothing here re-derives it — the `X-Costing-Company` header SELECTS
// among memberships and is never authority on its own.
//
// The second is about the RECORD: a sample style carries no company of its own
// in every deployment, so ownership is proved through its parents — the Sales
// journey, or the enquiry for a house sample that has no journey. That rule
// already exists once, as a query, in `merchandisingScope.service`. It is
// reused rather than restated: two implementations of one tenancy rule is two
// places to fix a hole and one place to forget.
//
// ── AND WHY A FOREIGN STYLE IS "NOT FOUND" ──────────────────────────────────
// Not "forbidden". A refusal that distinguishes "exists but is not yours" from
// "does not exist" is a way to ask whether another company holds a style, one
// id at a time. Missing and foreign are one answer.
"use strict";

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const membership = require("./companyMembership.service");
const { styleOwnershipClause } = require("./merchandisingScope.service");
const { StorePurchaseError, fail } = require("../storePurchase/errors");

/**
 * The company middleware every R&D router shares.
 *
 * Leaves `{ companyId, membershipSource }` on `req.rnd`.
 */
const rndCompanyMiddleware = ({ domainLabel = "R&D" } = {}) => async (req, res, next) => {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await membership.resolveCompanyForActor(req.user, {
      requestedCompanyId, domainLabel, fail,
    });
    req.rnd = { companyId, membershipSource };
    next();
  } catch (err) {
    if (err instanceof StorePurchaseError) return res.status(err.status).json(err.toResponse());
    console.error("[rndScope] company middleware:", err);
    return res.status(500).json({ success: false, message: "Something went wrong. Nothing was changed." });
  }
};

/**
 * One style, as a mongoose DOCUMENT, proved to belong to `companyId`.
 *
 * A document rather than a lean object because every R&D operation that reads
 * a style also writes it, and re-fetching after the proof would be a second
 * read of a record that could have moved in between.
 *
 * @throws NOT_FOUND for a style that is missing OR another company's.
 */
async function styleForCompany(companyId, styleId, { activeOnly = true } = {}) {
  const clause = await styleOwnershipClause(companyId, { activeOnly });
  /* No journey and no enquiry in this company means no style can be proved to
     it — an empty clause must refuse everything rather than match everything. */
  if (!clause) throw fail("NOT_FOUND", "That style is not one of yours.");
  const style = await SampleStyle.findOne({ _id: styleId, ...clause }).catch(() => null);
  if (!style) throw fail("NOT_FOUND", "That style is not one of yours.");
  return style;
}

module.exports = { rndCompanyMiddleware, styleForCompany };
