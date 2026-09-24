// routes/CMS_Routes/Manufacturing/Finishing/finishingAccess.js
//
// WHO MAY USE A FINISHING STAGE'S PORTAL, AND WHICH WORK THEY MAY SEE.
//
// The same three questions Packaging asks (packagingAccess.js has the full
// reasoning), answered the same way, for a stage named by its slug:
//
//   1. WHO IS THIS?  A platform administrator, as everywhere. Otherwise a live
//      DepartmentRole grant in the stage's department — viewer to read, editor
//      to record. Before any grant exists, a session signed into that
//      department itself is admitted, so a freshly created department is
//      usable the day it appears and is not an open door to every other one.
//
//      READING is wider than recording: the Production Supervisor, Project
//      Manager and Executive Office may read a stage's numbers, because those
//      are production numbers. None of them may mark a piece done.
//
//   2. WHICH COMPANY?  The actor's own membership, resolved server-side by the
//      shared company middleware. Never from the client.
//
//   3. IS THIS WORK THAT COMPANY'S?  Exactly Packaging's rule, reused rather
//      than re-implemented — including its legacy-window stand-down for
//      unlinked work orders.
"use strict";

const departmentRoles = require("../../../../services/departmentRoles");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const { stageOf } = require("../../../../services/manufacturing/finishingStages");
const pkg = require("../Packaging/packagingAccess");

/* Departments that may READ a stage's numbers besides the stage itself. */
const READER_DEPARTMENTS = Object.freeze([
  { slug: "production-supervisor", legacy: ["production_supervisor", "production-supervisor"] },
  { slug: "project-manager", legacy: ["project_manager", "project-manager"] },
  { slug: "ceo", legacy: ["ceo"] },
]);

const sessionIs = (user, slug, legacy) => {
  const deptSlug = pkg.str(user?.deptSlug).toLowerCase();
  const role = pkg.str(user?.role).toLowerCase();
  return deptSlug === slug || legacy.includes(role);
};

async function grantsExist(slug) {
  return (await departmentRoles.listRoles(slug)).length > 0;
}

async function effectiveRole(req, slug) {
  try { return (await departmentRoles.getEffectiveRole(slug, req)) || null; }
  catch (err) { console.error("[finishing-access] role lookup failed:", err.message); return null; }
}

/** One department's answer: a live grant, "migration" (no grants yet but this
 *  session IS the department), "insufficient", or null. */
async function roleIn(slug, legacy, req, required) {
  if (!(await grantsExist(slug))) return sessionIs(req.user, slug, legacy) ? "migration" : null;
  const role = await effectiveRole(req, slug);
  if (!role) return null;
  return departmentRoles.roleAtLeast(role, required) ? role : "insufficient";
}

/** `req.stage` is the stage the URL names; refused before any guard runs. */
function resolveStage(req, res, next) {
  const stage = stageOf(req.params.stage);
  if (!stage) return res.status(404).json({ success: false, message: "No such finishing stage." });
  req.stage = stage;
  next();
}

/** Guard: this person is the stage's department (`required` once grants exist). */
function stageDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();
      const { slug, legacyRoles, name } = req.stage;
      const role = await roleIn(slug, legacyRoles, req, required);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: `${name}'s work is for the ${name} department.` });
      }
      if (role === "insufficient") {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", requires: required,
          message: `This action needs ${required} access in ${name}.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[finishing-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/** Guard: may READ the stage's numbers — the stage, or a department that watches production. */
function stageReader() {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();
      const depts = [{ slug: req.stage.slug, legacy: req.stage.legacyRoles }, ...READER_DEPARTMENTS];
      for (const dept of depts) {
        const role = await roleIn(dept.slug, dept.legacy, req, "viewer");
        if (role && role !== "insufficient") {
          req.departmentRole = role;
          req.readerDepartment = dept.slug;
          return next();
        }
      }
      return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
        message: `${req.stage.name}'s numbers are for ${req.stage.name}, the Production Supervisor, Production planning and the executive office.` });
    } catch (err) {
      console.error("[finishing-access] reader guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/* `merchandisingCompanyMiddleware` is a FACTORY: called once with options, it
   returns the middleware. Calling it per request with (req, res, next) — as the
   first version of this file did — hands it the request as its options,
   returns a function nobody runs, and never calls next(): every read on every
   finishing portal hung with no response and no log line (24 Sep 2026). */
const companyMiddleware = merchandisingCompanyMiddleware({ domainLabel: "Finishing" });

/** The acting company, on `req.finishing.companyId`. */
function stageCompany(req, res, next) {
  return companyMiddleware(req, res, () => {
    req.finishing = { companyId: req.merchandising.companyId };
    next();
  });
}

module.exports = {
  resolveStage, stageDepartment, stageReader, stageCompany,
  /* Work-order scoping, shared with Packaging on purpose: one rule. */
  scoped: pkg.scoped, findWorkOrders: pkg.findWorkOrders, findWorkOrder: pkg.findWorkOrder,
  moWorkOrderIds: pkg.moWorkOrderIds, moScope: pkg.moScope, notFound: pkg.notFound,
  isId: pkg.isId, oid: pkg.oid, str: pkg.str,
};
