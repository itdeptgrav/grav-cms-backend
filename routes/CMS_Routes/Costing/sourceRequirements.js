// routes/CMS_Routes/Costing/sourceRequirements.js
//
// LANE B — "WHAT DOES MY DEPARTMENT STILL OWE COSTING ON THIS STYLE?"
//
// ── WHY THIS IS NOT UNDER /api/costings ─────────────────────────────────────
// The same reason the supplier register is not: a merchandiser must not need a
// costing session to be told their own BOM is unfinished. `/api/costings` is
// gated by a costing capability, and the departments that OWN these facts hold
// none — deliberately, because reading a costing and feeding one are different
// authorities.
//
// So this mounts in its own namespace and gates on the caller's DEPARTMENT
// grant, through `services/departmentRoles.js` — the guard every other
// departmental screen already uses. No second permission vocabulary, and no
// costing capability anywhere in the path.
//
// ── AND IT RETURNS NO MONEY ─────────────────────────────────────────────────
// The projection publishes presence, not value: a quotation EXISTS or does
// not, a policy is IN FORCE or is not. There is no rate, no supplier, no
// policy percentage and no cost in any response this file can produce, for any
// caller, including an administrator. That is the boundary the departmental
// panels are safe to render inside.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  MEMBERSHIP_SOURCES, resolveCompanyForActor,
} = require("../../../services/companyContext/companyMembership.service");
const { getEffectiveRole } = require("../../../services/departmentRoles");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const {
  SOURCE_APP_KEYS, APP_GRANT, SOURCE_APP,
} = require("../../../services/centralCosting/sourceApps");
const projection = require("../../../services/centralCosting/sourceAppRequirements.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/**
 * The company this actor is working in.
 *
 * Resolved from their own proven membership, exactly as Central Costing
 * resolves it — never from a body field, and never defaulted to "all
 * companies" when it cannot be proved. A caller whose company is unknown gets
 * a refusal and no data.
 */
async function requireCompany(req, res, next) {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await resolveCompanyForActor(req.user, {
      requestedCompanyId,
      domainLabel: "Costing inputs",
      fail,
    });
    req.costingInputs = {
      companyId,
      membershipSource,
      membershipProven: membershipSource === MEMBERSHIP_SOURCES.MEMBERSHIP_RECORD,
    };
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * Which source apps this caller may read, from their department grants.
 *
 * Read every time rather than trusted from the token: a grant removed five
 * minutes ago must not survive in a seven-day JWT — the same decision
 * `services/centralCosting/capabilities.js` documents.
 */
async function resolveApps(req) {
  const grants = {};
  for (const app of SOURCE_APP_KEYS) {
    const slug = APP_GRANT[app]?.departmentSlug;
    if (!slug || grants[slug] !== undefined) continue;
    grants[slug] = (await getEffectiveRole(slug, req)) || null;
  }
  const isAdmin = Boolean(req.user?.isAdmin || req.admin);
  return { grants, isAdmin, apps: projection.appsForGrants(grants, { isAdmin }) };
}

/**
 * GET /apps — which requirement lists this person may open.
 *
 * The panel asks this once and renders nothing at all where the answer is
 * empty. An empty list is not an error: plenty of people legitimately own no
 * costing input.
 */
router.get("/apps", requireCompany, handle(async (req, res) => {
  const { apps, isAdmin } = await resolveApps(req);
  return res.json({
    success: true,
    companyId: String(req.costingInputs.companyId),
    apps,
    isAdmin,
  });
}));

/**
 * GET /requirements?sourceApp=&styleId=|enquiryId=
 *
 * One department's outstanding Costing inputs for one style or enquiry.
 */
router.get("/requirements", requireCompany, handle(async (req, res) => {
  const sourceApp = String(req.query.sourceApp || "").toUpperCase().trim();
  if (!APP_GRANT[sourceApp]) {
    throw fail("VALIDATION", "Name which department's requirements to show.", { sourceApp });
  }
  /* ── THE BOARD HAS NO OPERATIONAL LIST ────────────────────────────────
     Its requirements are company policy, reported as named blockers on the
     families they stop. There is nothing for a person to open, and offering
     an empty list would imply there is. */
  if (sourceApp === SOURCE_APP.BOARD) {
    throw fail("FORBIDDEN", "Board policy is not entered through a style or an enquiry.");
  }

  const { apps } = await resolveApps(req);
  if (!apps.includes(sourceApp)) {
    /* Refused, not emptied. An empty list reads as "nothing is outstanding",
       which is a different and untrue statement. */
    throw fail("FORBIDDEN", "You do not hold a role in that department.", { sourceApp });
  }

  const out = await projection.projectFor(req.costingInputs, {
    sourceApp,
    styleId: req.query.styleId || null,
    enquiryId: req.query.enquiryId || null,
  });

  return res.json({ success: true, ...out });
}));

module.exports = router;
