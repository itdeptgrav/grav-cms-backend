// routes/CMS_Routes/Manufacturing/Embroidery/embroideryAccess.js
//
// WHO MAY USE EMBROIDERY'S QUEUE AND RECORDS, AND WHICH WORK THEY MAY SEE.
//
// The twin of the Cutting rules (../CuttingMaster/cuttingAccess.js), stated
// again here rather than imported: the two departments' doors are edited by
// different people at different times, and a shared guard silently changing
// one of them is the failure this pair is guarding against. If they ever need
// to differ — and Embroidery's operator identity already does — they can.
//
// Embroidery's routes inherited employee authentication from the earlier
// `app.use("/api/cms", productOperations)` mount, and nothing else: any
// signed-in employee of any department could read every company's embroidery
// queue and record a piece against any work order. This module is where the
// three questions are now asked:
//
//   1. IS THIS PERSON EMBROIDERY?  (`embroideryDepartment`)
//      An administrator, as everywhere. Otherwise, once any `embroidery` grant
//      exists, a live grant in that department — viewer to read a queue,
//      records, designs or progress, editor to record a scan. Before any grant
//      exists (the migration state the shared guard fails OPEN for), only a
//      session of the Embroidery department itself. A PPC grant is not an
//      Embroidery grant, and never admits anybody here.
//
//   2. WHICH COMPANY?  (`embroideryCompany`)
//      The actor's own membership, resolved server-side by the shared company
//      middleware.
//
//   3. IS THIS WORK THAT COMPANY'S?  (`workOrderScope`)
//      A WorkOrder's company is its Sales-line link, stamped at creation by
//      the Sales-line ↔ WorkOrder bridge. That link is the only authoritative
//      source, so it is the whole rule: this company's linked WorkOrders, and
//      nothing else. A historical WorkOrder with no link is nobody's — it is
//      not in any company's queue and cannot be scanned — and it is never
//      given a company from its style, buyer, number, barcode prefix or
//      product name. It stays unlinked in its own record.
"use strict";

const mongoose = require("mongoose");

const departmentRoles = require("../../../../services/departmentRoles");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");

const SLUG = "embroidery";
const LEGACY_ROLE = "embroidery";

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));

const isEmbroiderySession = (user) => str(user?.deptSlug).toLowerCase() === SLUG
  || str(user?.role).toLowerCase() === LEGACY_ROLE;

/** Guard: this person works in Embroidery (`required` applies once grants exist). */
function embroideryDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      const assigned = await departmentRoles.listRoles(SLUG);
      if (assigned.length === 0) {
        if (isEmbroiderySession(req.user)) return next();
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "Embroidery's floor is for the Embroidery department." });
      }
      const role = await departmentRoles.getEffectiveRole(SLUG, req);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "You have not been given a role in Embroidery." });
      }
      if (!departmentRoles.roleAtLeast(role, required)) {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", role, requires: required,
          message: `This action needs ${required} access in Embroidery. You are ${role}.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[embroidery-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

const companyMiddleware = merchandisingCompanyMiddleware({ domainLabel: "Embroidery" });
function embroideryCompany(req, res, next) {
  return companyMiddleware(req, res, () => {
    req.embroidery = { companyId: req.merchandising.companyId };
    next();
  });
}

/** The WorkOrders this company's Embroidery may see: its own linked ones. */
function workOrderScope(companyId) {
  return { "salesLineLink.companyId": new mongoose.Types.ObjectId(str(companyId)) };
}

/** "linked" (this company's) or "unlinked" (no proof of any company). */
const proofOf = (workOrder, companyId) => {
  const linked = workOrder?.salesLineLink?.companyId;
  if (!linked) return "unlinked";
  return str(linked) === str(companyId) ? "linked" : "foreign";
};

/**
 * May this person ANSWER a published target — accept or refuse it?
 *
 * The same rule `embroideryDepartment("editor")` enforces, asked without
 * refusing the request, so a read can tell the screen whether to offer the
 * controls at all. It is derived here, from the live grant and the session's
 * own department: never from the floor badge, a department name, an email or
 * anything the browser sent. The guard on the answer routes remains the
 * authority — this only decides whether a button is worth drawing.
 */
async function canAnswerTargets(req) {
  try {
    if (!req.user?.id) return false;
    if (req.user.isAdmin) return true;
    const assigned = await departmentRoles.listRoles(SLUG);
    if (assigned.length === 0) return isEmbroiderySession(req.user);
    const role = await departmentRoles.getEffectiveRole(SLUG, req);
    return Boolean(role) && departmentRoles.roleAtLeast(role, "editor");
  } catch (err) {
    /* An unreadable grant is not a permission. */
    console.error("[embroidery-access] capability check failed:", err.message);
    return false;
  }
}

const notFound = (res, what = "Work order") =>
  res.status(404).json({ success: false, message: `${what} not found` });

/** Load one WorkOrder for Embroidery: unknown, foreign and unlinked are one answer. */
async function loadScopedWorkOrder(req, res, woId, build = (q) => q) {
  if (!isId(woId)) { notFound(res); return null; }
  const wo = await build(WorkOrder.findOne({ _id: woId, ...workOrderScope(req.embroidery.companyId) }));
  if (!wo) { notFound(res); return null; }
  return wo;
}

/** May this company's Embroidery act on this manufacturing order? */
async function orderInScope(companyId, customerRequestId) {
  if (!isId(customerRequestId)) return false;
  return Boolean(await WorkOrder.exists({ customerRequestId, ...workOrderScope(companyId) }));
}

module.exports = {
  SLUG, LEGACY_ROLE, isEmbroiderySession,
  embroideryDepartment, embroideryCompany, canAnswerTargets,
  workOrderScope, proofOf, loadScopedWorkOrder, orderInScope, notFound, isId,
};
