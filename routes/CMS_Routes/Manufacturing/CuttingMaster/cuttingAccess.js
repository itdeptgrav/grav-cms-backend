// routes/CMS_Routes/Manufacturing/CuttingMaster/cuttingAccess.js
//
// WHO MAY USE CUTTING'S QUEUE, AND WHICH WORK THEY MAY SEE OR RECORD.
//
// Cutting's routes used to require only a signed-in employee: any department
// could read every company's cutting queue and record cuts against any work
// order, and the "who cut these units?" record trusted a name typed into the
// request body. This module is the one place those routes now ask three
// questions, each answered by a rule that already exists elsewhere:
//
//   1. IS THIS PERSON CUTTING?  (`cuttingDepartment`)
//      An administrator, as everywhere. Otherwise, once any `cutting-master`
//      grant exists, a live grant in that department (services/departmentRoles
//      — viewer to read, editor to record). Before any grant exists — the
//      migration state `requireDepartmentRole` fails OPEN for — only a session
//      of the Cutting department itself (`deptSlug: "cutting-master"`, legacy
//      role `cutting_master`) is admitted, so an unconfigured department is not
//      an open door to every other department. No new permission, and no PPC
//      access: a PPC grant is not a Cutting grant.
//
//   2. WHICH COMPANY?  (`cuttingCompany`)
//      The actor's own membership, resolved server-side by the shared company
//      middleware (a header only selects among memberships they hold; the
//      single-company deployment fallback keeps the live system working).
//
//   3. IS THIS WORK THAT COMPANY'S?  (`workOrderScope`, `proofOf`)
//      A WorkOrder's company is its Sales-line link (`salesLineLink.companyId`,
//      stamped at creation by the Sales-line ↔ WorkOrder bridge). That link is
//      the only authoritative source there is, so it is the whole rule:
//      linked to this company, and nothing else, is in scope.
//
//      A historical WorkOrder carrying no link is NOT in scope for anybody.
//      Its company cannot be proved, and the alternatives are both wrong:
//      showing it to every company is the cross-company read this exists to
//      close, and deriving a company from its style, customer name or number
//      would be exactly the inference the Sales-line bridge refuses to make.
//      So it stays unlinked and out of every company-scoped Cutting path
//      until something authoritative links it — which is a migration, not a
//      guess. Work already on the floor against such an order needs that
//      decision; see the handoff note.
"use strict";

const mongoose = require("mongoose");

const departmentRoles = require("../../../../services/departmentRoles");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const SLUG = "cutting-master";
const LEGACY_ROLE = "cutting_master";

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));

const isCuttingSession = (user) => str(user?.deptSlug).toLowerCase() === SLUG
  || str(user?.role).toLowerCase() === LEGACY_ROLE;

/** Guard: this person works in Cutting (`required` applies once grants exist). */
function cuttingDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      const assigned = await departmentRoles.listRoles(SLUG);
      if (assigned.length === 0) {
        if (isCuttingSession(req.user)) return next();
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "Cutting's work queue is for the Cutting department." });
      }
      const role = await departmentRoles.getEffectiveRole(SLUG, req);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "You have not been given a role in Cutting." });
      }
      if (!departmentRoles.roleAtLeast(role, required)) {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", role, requires: required,
          message: `This action needs ${required} access in Cutting. You are ${role}.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[cutting-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/* The acting company, from the actor's own membership — the shared rule. */
const companyMiddleware = merchandisingCompanyMiddleware({ domainLabel: "Cutting" });
function cuttingCompany(req, res, next) {
  return companyMiddleware(req, res, () => {
    req.cutting = { companyId: req.merchandising.companyId };
    next();
  });
}

/** The WorkOrders this company's Cutting may see: its own linked ones, and historical unlinked ones. */
function workOrderScope(companyId) {
  return { "salesLineLink.companyId": new mongoose.Types.ObjectId(str(companyId)) };
}

/** "linked" (this company's), "unlinked" (no proof of any company), or "foreign". */
function proofOf(workOrder, companyId) {
  const linked = workOrder?.salesLineLink?.companyId;
  if (!linked) return "unlinked";
  return str(linked) === str(companyId) ? "linked" : "foreign";
}

const notFound = (res, what = "Work order") => res.status(404).json({ success: false, message: `${what} not found` });

/**
 * Load one WorkOrder for Cutting, or answer 404 for a malformed id, an
 * unknown one and another company's alike. `build` receives the query so the
 * caller keeps its own select/populate/lean.
 */
async function loadScopedWorkOrder(req, res, woId, build = (q) => q) {
  if (!isId(woId)) { notFound(res); return null; }
  const wo = await build(WorkOrder.findOne({ _id: woId, ...workOrderScope(req.cutting.companyId) }));
  if (!wo) { notFound(res); return null; }
  req.cutting.proof = proofOf(wo, req.cutting.companyId);
  return wo;
}

/**
 * May this company's Cutting act on this manufacturing order? Yes when at
 * least one of its WorkOrders is this company's or unlinked; not when every
 * one is linked to another company (or it has none Cutting could see).
 */
async function orderInScope(companyId, customerRequestId) {
  if (!isId(customerRequestId)) return false;
  return Boolean(await WorkOrder.exists({ customerRequestId, ...workOrderScope(companyId) }));
}

module.exports = {
  SLUG, LEGACY_ROLE, isCuttingSession,
  cuttingDepartment, cuttingCompany, workOrderScope, proofOf, loadScopedWorkOrder, orderInScope, notFound, isId,
};
