// routes/CMS_Routes/Manufacturing/productionStyleRoute.js
//
// PRODUCTION MANAGER — THE STYLE'S ROUTE AND STANDARD TIME.
//
// ── WHY THIS IS NOT ON THE SAMPLE-STYLE ROUTER ──────────────────────────────
// `routes/CMS_Routes/Sales/sampleStyles.js` is behind `salesAuth` and carries
// the whole technical record: materials, requirements, evidence, the sample
// lifecycle. Adding Production's route there would give a route editor the
// same door as a material substitution, and gate Production's own work on a
// Sales session.
//
// This is a narrow door instead. It reaches exactly one array, it is gated on
// the `project-manager` department grant, and it can express nothing else —
// see the allowlist in the service.
//
// ── AND NO JOURNEY IS PUBLISHED ─────────────────────────────────────────────
// Production's work starts at a Product and continues to a Style. Company
// ownership is proved through the style's linked journey or enquiry because
// that is where a SampleStyle's company lives, but no journey id, enquiry id,
// enquiry number or customer name is in any response here.
"use strict";

const express = require("express");

const EmployeeAuthMiddleware = require("../../../Middlewear/EmployeeAuthMiddlewear");
const {
  resolveCompanyForActor,
} = require("../../../services/companyContext/companyMembership.service");
const { getEffectiveRole, roleAtLeast } = require("../../../services/departmentRoles");
const { fail, sendError, handle } = require("../../../services/storePurchase/errors");
const styleRoute = require("../../../services/production/styleRoute.service");

const router = express.Router();
router.use(EmployeeAuthMiddleware);

/** Production's own department slug — the one its shell and nav already use. */
const DEPARTMENT = "project-manager";

/**
 * The company this actor works in, proved from their own membership.
 *
 * Never from a body field, and never defaulted to "every company" when it
 * cannot be proved.
 */
async function requireCompany(req, res, next) {
  try {
    const requestedCompanyId = req.get("X-Costing-Company") || req.query?.actingCompanyId || null;
    const { companyId, membershipSource } = await resolveCompanyForActor(req.user, {
      requestedCompanyId,
      domainLabel: "Production route",
      fail,
    });
    req.production = { companyId, membershipSource };
    next();
  } catch (err) {
    sendError(res, err);
  }
}

/**
 * Reading a route needs a Production seat; changing one needs to be an editor.
 *
 * Re-read on every request rather than trusted from the token: a grant removed
 * five minutes ago must not survive in a seven-day JWT.
 *
 * ── R&D IS NOT LET THROUGH THIS DOOR ────────────────────────────────────────
 * Deliberately. R&D sees the route as read-only technical context on their own
 * screen, served by their own record; what they no longer have is a way to
 * WRITE it, here or on their own route.
 */
const requireProduction = (minimumRole) => async (req, res, next) => {
  try {
    if (req.user?.isAdmin || req.admin) { req.productionRole = "owner"; return next(); }
    const role = await getEffectiveRole(DEPARTMENT, req);
    if (!role || !roleAtLeast(role, minimumRole)) {
      return sendError(res, fail("FORBIDDEN",
        "Recording a style's route and standard time is the Production Manager's.",
        { requires: { department: DEPARTMENT, minimumRole } }));
    }
    req.productionRole = role;
    next();
  } catch (err) {
    sendError(res, err);
  }
};

const canRead = requireProduction("viewer");
const canWrite = requireProduction("editor");

/** GET /styles?stockItemId= — the styles of one product, and their routes' shape. */
router.get("/styles", requireCompany, canRead, handle(async (req, res) => {
  const out = await styleRoute.listStylesForProduct(req.production, {
    stockItemId: req.query.stockItemId || null,
  });
  return res.json({ success: true, ...out });
}));

/** GET /styles/:styleId/route — one style's route, in order. */
router.get("/styles/:styleId/route", requireCompany, canRead, handle(async (req, res) => {
  const out = await styleRoute.readRoute(req.production, { styleId: req.params.styleId });
  return res.json({ success: true, ...out, canEdit: false });
}));

/** GET the outside processes that Production owns for one style. */
router.get("/styles/:styleId/outside-processes", requireCompany, canRead, handle(async (req, res) => {
  const out = await styleRoute.readOutsideProcesses(req.production, { styleId: req.params.styleId });
  return res.json({ success: true, ...out, canEdit: false });
}));

/**
 * PUT /styles/:styleId/route — replace the route, in order.
 *
 * The whole list, because reordering and removing are what this screen is for
 * and both are expressed as "here is the route now". Anything the body carries
 * beyond the route's own fields is refused by name rather than ignored.
 */
router.put("/styles/:styleId/route", requireCompany, canWrite, handle(async (req, res) => {
  const body = req.body || {};
  /* The envelope gets the same treatment as the rows: a top-level `materials`
     or `status` is a request to change something this door does not open. */
  for (const key of Object.keys(body)) {
    if (key === "operations") continue;
    const refused = styleRoute.REFUSED_FIELDS[key];
    throw fail(styleRoute.CODES.FIELD_NOT_ACCEPTED,
      refused
        ? `This records a route. It cannot carry ${refused}.`
        : `"${key}" is not part of a style's route.`,
      { field: key });
  }

  const out = await styleRoute.saveRoute(req.production, {
    styleId: req.params.styleId,
    operations: body.operations,
    /* The same `{id, name}` stamp the sample-style router writes. An ObjectId
       on its own is the wrong shape for `updatedBy` and the document refuses
       it — which is the right refusal, and worth matching rather than
       working around. */
    actor: req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null,
  });
  return res.json({ success: true, ...out, canEdit: true });
}));

/**
 * PUT the whole Production-owned outside-process list. It deliberately has a
 * separate door from the route so a route save cannot erase a job-work need.
 */
router.put("/styles/:styleId/outside-processes", requireCompany, canWrite, handle(async (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(body)) {
    if (key === "outsideProcesses") continue;
    const refused = styleRoute.REFUSED_FIELDS[key];
    throw fail(styleRoute.CODES.FIELD_NOT_ACCEPTED,
      refused
        ? `This records outside processes. It cannot carry ${refused}.`
        : `"${key}" is not part of the outside-process list.`,
      { field: key });
  }
  const out = await styleRoute.saveOutsideProcesses(req.production, {
    styleId: req.params.styleId,
    outsideProcesses: body.outsideProcesses,
    actor: req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null,
  });
  return res.json({ success: true, ...out, canEdit: true });
}));

/**
 * PUT /styles/:styleId/outside-processes/decision — does ANYTHING go outside?
 *
 * ── ITS OWN DOOR, DELIBERATELY ──────────────────────────────────────────────
 * Saving an empty `outsideProcesses` list cannot mean "nothing goes outside":
 * it is also what clearing the section looks like, and what every style looks
 * like before anybody opens it. Central Costing could not tell the two apart,
 * so whoever was costing the garment declared the outside-services family "not
 * applicable" from a screen that had no way to know. Production knows, and
 * this is where they say it.
 *
 * `false` needs a reason. `true` does not — the rows that follow are the
 * reason.
 */
router.put("/styles/:styleId/outside-processes/decision", requireCompany, canWrite, handle(async (req, res) => {
  const body = req.body || {};
  for (const key of Object.keys(body)) {
    if (key === "required" || key === "reason") continue;
    const refused = styleRoute.REFUSED_FIELDS[key];
    throw fail(styleRoute.CODES.FIELD_NOT_ACCEPTED,
      refused
        ? `This records whether outside work is needed. It cannot carry ${refused}.`
        : `"${key}" is not part of an outside-process decision.`,
      { field: key });
  }
  const out = await styleRoute.saveOutsideProcessDecision(req.production, {
    styleId: req.params.styleId,
    required: body.required,
    reason: body.reason,
    actor: req.user?.id ? { id: req.user.id, name: req.user.name || "" } : null,
  });
  return res.json({ success: true, ...out, canEdit: true });
}));

module.exports = router;
