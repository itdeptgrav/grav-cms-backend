// routes/CMS_Routes/Manufacturing/Production/productionTargetAccess.js
//
// WHO MAY READ AND ANSWER PRODUCTION'S SEWING TARGETS, AND FOR WHICH WORK.
//
// The third of the receiver access modules, after Cutting's
// (../CuttingMaster/cuttingAccess.js) and Embroidery's
// (../Embroidery/embroideryAccess.js), and stated again here for the same
// reason they are stated separately from each other: these doors are edited by
// different people at different times, and a shared guard silently changing
// one of them is the failure the set is guarding against.
//
// ── WHY THIS FILE EXISTS AT ALL, NEXT TO THE MO ROUTES ──────────────────────
// `/api/cms/manufacturing/**` is deliberately ungated — cutting-master, QC,
// packaging-dispatch and the production supervisor all write through it, and
// manufacturingOrderRoutes.js says so at length. Its reads carry no company
// scope and no department role, which is right for what they are and wrong for
// this: answering a sewing target is a commitment one company's Production
// Manager makes to one company's PPC. So the sewing-target door is its own
// router with its own rules, mounted beside those routes rather than inside
// them, and the MO screen calls it as a second request.
//
// Three questions, the same three Embroidery asks:
//
//   1. IS THIS PERSON PRODUCTION?  (`productionDepartment`)
//      An administrator, as everywhere. Otherwise, once any `project-manager`
//      grant exists, a live grant in it — viewer to read a target, editor to
//      answer one. Before any grant exists, only a session of the Project
//      Manager department itself.
//
//      This fails CLOSED, unlike the `departmentWrites("project-manager")`
//      guard the MO routes use for vendor forwarding, which fails open until
//      the first grant is given. That difference is deliberate and is not a
//      change to those routes: an ungranted deployment should not be able to
//      accept PPC's sewing dates on a whole company's behalf, and "nobody can
//      answer yet" is a state PPC can see and an administrator can fix.
//
//      A PPC grant is not a Production grant, and never admits anybody here:
//      PPC publishes the target and may not answer its own request.
//
//   2. WHICH COMPANY?  (`productionCompany`)
//      The actor's own membership, resolved server-side by the shared company
//      middleware. Never a company id from the client.
//
//   3. IS THIS WORK THAT COMPANY'S?  (`workOrderScope`)
//      A WorkOrder's company is its Sales-line link, stamped at creation by
//      the Sales-line ↔ WorkOrder bridge. That link is the only authoritative
//      source, so it is the whole rule. A historical WorkOrder with no link is
//      nobody's — it is in no company's queue and reveals no target — and it
//      is never given a company from its style, buyer, number or product name.
"use strict";

const mongoose = require("mongoose");

const departmentRoles = require("../../../../services/departmentRoles");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const SLUG = "project-manager";
/* The legacy session shapes that ARE the Project Manager, from before grants. */
const LEGACY_ROLES = Object.freeze(["project_manager", "project-manager"]);

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));

const isProductionSession = (user) => {
  const slug = str(user?.deptSlug).toLowerCase();
  const role = str(user?.role).toLowerCase().replace(/-/g, "_");
  return slug === SLUG || LEGACY_ROLES.includes(role);
};

/** Guard: this person is Production (`required` applies once grants exist). */
function productionDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      const assigned = await departmentRoles.listRoles(SLUG);
      if (assigned.length === 0) {
        if (isProductionSession(req.user)) return next();
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "Sewing targets are the Production Manager's." });
      }
      const role = await departmentRoles.getEffectiveRole(SLUG, req);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "You have not been given a role in Production." });
      }
      if (!departmentRoles.roleAtLeast(role, required)) {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", role, requires: required,
          message: `This action needs ${required} access in Production. You are ${role}.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[production-target-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

const companyMiddleware = merchandisingCompanyMiddleware({ domainLabel: "Production" });
function productionCompany(req, res, next) {
  return companyMiddleware(req, res, () => {
    req.production = { companyId: req.merchandising.companyId };
    next();
  });
}

/**
 * May this person ANSWER a sewing target — accept or refuse it?
 *
 * The same rule `productionDepartment("editor")` enforces, asked without
 * refusing the request, so a read can tell the screen whether to offer the
 * controls at all. Derived here from the live grant and the session's own
 * department: never from a department name, an email or anything the browser
 * sent. The guard on the answer routes remains the authority — this only
 * decides whether a button is worth drawing.
 */
async function canAnswerTargets(req) {
  try {
    if (!req.user?.id) return false;
    if (req.user.isAdmin) return true;
    const assigned = await departmentRoles.listRoles(SLUG);
    if (assigned.length === 0) return isProductionSession(req.user);
    const role = await departmentRoles.getEffectiveRole(SLUG, req);
    return Boolean(role) && departmentRoles.roleAtLeast(role, "editor");
  } catch (err) {
    /* An unreadable grant is not a permission. */
    console.error("[production-target-access] capability check failed:", err.message);
    return false;
  }
}

/** The WorkOrders this company's Production may see: its own linked ones. */
function workOrderScope(companyId) {
  return { "salesLineLink.companyId": new mongoose.Types.ObjectId(str(companyId)) };
}

module.exports = {
  SLUG, LEGACY_ROLES, isProductionSession,
  productionDepartment, productionCompany, canAnswerTargets, workOrderScope, isId,
};
