// routes/CMS_Routes/Manufacturing/Packaging/packagingAccess.js
//
// WHO MAY USE PACKAGING & DISPATCH, AND WHICH WORK THEY MAY SEE OR CHANGE.
//
// Packaging's execution routes used to require only a signed-in employee: any
// department could read every company's orders, and could record packing or
// dispatch against any work order by naming its id in the request body. This
// module is the one place those routes now ask three questions, each answered
// by a rule that already exists elsewhere.
//
//   1. WHO IS THIS?  (`packagingDepartment`, `packagingReader`)
//      An administrator, as everywhere. Otherwise, once any `packaging-dispatch`
//      grant exists, a live grant in that department — viewer to read, editor to
//      record. Before any grant exists (the migration state
//      `requireDepartmentRole` fails OPEN for) only a session of the Packaging
//      department itself is admitted, so an unconfigured department is not an
//      open door to every other one.
//
//      READING is wider than writing, and deliberately so: the Project Manager's
//      production screens and the CEO's dispatch screen already read these
//      endpoints, and they are the reason `packagingReader` also admits a
//      `project-manager` or `ceo` grant. Neither of those may WRITE: recording
//      packing or dispatch stays `packagingDepartment("editor")`. Being able to
//      watch the floor is not being on it.
//
//   2. WHICH COMPANY?  (`packagingCompany`)
//      The actor's own membership, resolved server-side by the shared company
//      middleware — the same one the Packing target door uses. A header only
//      selects among memberships they hold.
//
//   3. IS THIS WORK THAT COMPANY'S?  (`workOrderScope` and the resolvers)
//      A WorkOrder's company is its Sales-line link (`salesLineLink.companyId`,
//      stamped at creation by the Sales-line ↔ WorkOrder bridge). That link is
//      the only authoritative source there is, so it is the whole rule.
//
//      A historical WorkOrder carrying no link is NOT in scope for anybody. Its
//      company cannot be proved, and every alternative is an inference this
//      system refuses to make: not the Manufacturing Order it sits under, not
//      the buyer, the style, the product, the barcode text, nor the last
//      characters of its id. So it is absent from every list and unaddressable
//      by id — which is a migration to fix, not a guess.
//
//      An order (`CustomerRequest`) is visible when at least ONE WorkOrder of
//      the acting company is linked to it. Its own status says nothing about
//      whose it is.
"use strict";

const mongoose = require("mongoose");

const departmentRoles = require("../../../../services/departmentRoles");
const { merchandisingCompanyMiddleware } = require("../../../../services/companyContext/merchandisingScope.service");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const EmployeeProductionProgress = require("../../../../models/CMS_Models/Manufacturing/Production/Tracking/EmployeeProductionProgress");
/* Only for `legacyWindowOpen()` — the one switch every module uses to stand a
   tenancy rule down while unlinked records are still being migrated. */
const tenantContext = require("../../../../services/storePurchase/tenantContext.service");

const SLUG = "packaging-dispatch";
/* The legacy session shapes that ARE this department, from before grants. */
const LEGACY_ROLES = Object.freeze(["packaging-dispatch", "packaging_dispatch", "packaging"]);

/* Departments whose own screens already read Packaging's numbers. Read only —
   see the header. Each carries its legacy session shapes for the same
   migration reason Packaging's own do. */
const READER_DEPARTMENTS = Object.freeze([
  { slug: SLUG, legacy: LEGACY_ROLES },
  { slug: "project-manager", legacy: ["project_manager", "project-manager"] },
  { slug: "ceo", legacy: ["ceo"] },
]);

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v)) && /^[0-9a-f]{24}$/i.test(str(v));
const oid = (v) => new mongoose.Types.ObjectId(str(v));

const sessionIs = (user, slug, legacy) => {
  const deptSlug = str(user?.deptSlug).toLowerCase();
  const role = str(user?.role).toLowerCase();
  return deptSlug === slug || legacy.includes(role);
};

const isPackagingSession = (user) => sessionIs(user, SLUG, LEGACY_ROLES);

/* ── THE PRIMITIVES, SHARED; THE POLICY, EACH DOOR'S OWN ────────────────────
   `grantsExist` and `effectiveRole` answer "who is this person, and what role
   do they hold" — one implementation, used by this module and by the Packing
   target door (packingTargetAccess.js). What happens when they hold NONE is
   deliberately NOT shared: that door fails closed on a department with no
   grants yet, and these execution routes carry their own rollout rule. One
   answer to the identity question, two explicit answers to the policy one. */

/** Does anybody hold a grant in this department yet? */
async function grantsExist(slug = SLUG) {
  const assigned = await departmentRoles.listRoles(slug);
  return assigned.length > 0;
}

/** This person's role in a department, or null. Never throws. */
async function effectiveRole(req, slug = SLUG) {
  try {
    return (await departmentRoles.getEffectiveRole(slug, req)) || null;
  } catch (err) {
    console.error("[packaging-access] role lookup failed:", err.message);
    return null;
  }
}

/** One department's answer for this person: a live grant, or the migration state. */
async function roleIn(slug, legacy, req, required) {
  if (!(await grantsExist(slug))) return sessionIs(req.user, slug, legacy) ? "migration" : null;
  const role = await effectiveRole(req, slug);
  if (!role) return null;
  return departmentRoles.roleAtLeast(role, required) ? role : "insufficient";
}

/** Guard: this person is Packaging & Dispatch (`required` applies once grants exist). */
function packagingDepartment(required = "viewer") {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      const role = await roleIn(SLUG, LEGACY_ROLES, req, required);
      if (!role) {
        return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
          message: "Packaging & Dispatch's work is for the Packaging & Dispatch department." });
      }
      if (role === "insufficient") {
        return res.status(403).json({ success: false, code: "INSUFFICIENT_DEPARTMENT_ROLE", requires: required,
          message: `This action needs ${required} access in Packaging & Dispatch.` });
      }
      req.departmentRole = role;
      return next();
    } catch (err) {
      console.error("[packaging-access] guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

/**
 * Guard: this person may READ Packaging's numbers — Packaging itself, or one of
 * the departments whose own screens already show them. Never a write.
 */
function packagingReader() {
  return async (req, res, next) => {
    try {
      if (!req.user?.id) return res.status(401).json({ success: false, message: "Authentication required" });
      if (req.user.isAdmin) return next();

      for (const dept of READER_DEPARTMENTS) {
        const role = await roleIn(dept.slug, dept.legacy, req, "viewer");
        if (role && role !== "insufficient") {
          req.departmentRole = role;
          req.readerDepartment = dept.slug;
          return next();
        }
      }
      return res.status(403).json({ success: false, code: "NO_DEPARTMENT_ROLE",
        message: "Packaging & Dispatch's work is for Packaging, Production planning and the executive office." });
    } catch (err) {
      console.error("[packaging-access] reader guard failed:", err.message);
      return res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

const companyMiddleware = merchandisingCompanyMiddleware({ domainLabel: "Packaging & Dispatch" });
function packagingCompany(req, res, next) {
  return companyMiddleware(req, res, () => {
    req.packaging = { companyId: req.merchandising.companyId };
    next();
  });
}

/**
 * May this person RECORD packing or dispatch?
 *
 * The same rule `packagingDepartment("editor")` enforces, asked without
 * refusing the request, so a read can tell the screen whether to offer the
 * controls at all. The guard on the write routes remains the authority — this
 * only decides whether a button is worth drawing.
 */
async function canRecord(req) {
  try {
    if (!req.user?.id) return false;
    if (req.user.isAdmin) return true;
    const role = await roleIn(SLUG, LEGACY_ROLES, req, "editor");
    return Boolean(role) && role !== "insufficient";
  } catch (err) {
    /* An unreadable grant is not a permission. */
    console.error("[packaging-access] capability check failed:", err.message);
    return false;
  }
}

/* ══ COMPANY SCOPE ═══════════════════════════════════════════════════════════
   Everything below answers one question: which WorkOrders are this company's?
   Every read and every write goes through one of them, and an unlinked or
   foreign order simply is not in the answer. */

/** The WorkOrders this company's Packaging may see: its own linked ones —
 *  and, while the legacy migration window is open, the unlinked ones too.
 *
 *  ── WHY UNLINKED WORK IS VISIBLE FOR NOW (24 Sep 2026) ──────────────────
 *  `salesLineLink` was introduced by the Sales-line ↔ WorkOrder bridge and is
 *  written only by creation paths that came after it. On the dev database
 *  EVERY work order that has ever been packed — 48 of them — predates it and
 *  carries no link at all. With the strict scope alone, /fetch-order answered
 *  "Work order 7dc8c1d3 not found" for a real POLO T SHIRT piece that had
 *  already been packed, so the packaging screen could not pack, the Overview
 *  showed nothing, and the hourly report was empty against 54 packing records.
 *
 *  This is the same situation the Store had (records with no companyId), and
 *  the same remedy: the strict rule stands down for the migration window that
 *  services/storePurchase/tenantContext.service.js already defines, and comes
 *  back — for everybody, at once — when STORE_PURCHASE_STRICT_TENANCY=1 is set
 *  after the links are backfilled. A work order linked to ANOTHER company is
 *  still never visible; only ownerless work is let through, and only for now. */
function workOrderScope(companyId) {
  const own = { "salesLineLink.companyId": oid(companyId) };
  if (!tenantContext.legacyWindowOpen()) return own;
  /* `{ field: null }` matches both an absent field and an explicit null. */
  return { $or: [own, { "salesLineLink.companyId": null }] };
}

/** `filter`, narrowed to this company. The scope is applied last, always.
 *  `$and` rather than a spread, so a caller's own `$or` is never overwritten
 *  by the scope's. */
const scoped = (companyId, filter = {}) => ({ $and: [filter, workOrderScope(companyId)] });

/** This company's WorkOrders matching `filter`. */
function findWorkOrders(companyId, filter = {}, select = null) {
  const q = WorkOrder.find(scoped(companyId, filter));
  return select ? q.select(select) : q;
}

/** One WorkOrder of this company, or null — a foreign or unlinked id is null. */
async function findWorkOrder(companyId, workOrderId, select = null) {
  if (!isId(companyId) || !isId(workOrderId)) return null;
  const q = WorkOrder.findOne(scoped(companyId, { _id: oid(workOrderId) }));
  return select ? q.select(select).lean() : q.lean();
}

/** This company's WorkOrder ids under one Manufacturing Order. */
async function moWorkOrderIds(companyId, moId) {
  if (!isId(companyId) || !isId(moId)) return [];
  const rows = await WorkOrder.find(scoped(companyId, { customerRequestId: oid(moId) }))
    .select("_id").lean();
  return rows.map((r) => String(r._id));
}

/**
 * Is this Manufacturing Order this company's, and which of its WorkOrders are?
 *
 * Visibility comes from the work, never from the order's own status: an order
 * with no linked WorkOrder of this company is not visible at all, and reads
 * exactly like one that does not exist.
 */
async function moScope(companyId, moId) {
  const workOrderIds = await moWorkOrderIds(companyId, moId);
  return { visible: workOrderIds.length > 0, workOrderIds, objectIds: workOrderIds.map(oid) };
}

/**
 * Progress documents named by a request, proved to be this company's through
 * the WorkOrder each one belongs to.
 *
 * Returns the documents AND the WorkOrders behind them, plus the ids that could
 * not be proved. A caller checks `unproven` BEFORE writing anything: a batch
 * naming one foreign, unlinked or unknown document is refused whole.
 */
async function resolveProgressDocs(companyId, progressIds = []) {
  const asked = [...new Set((progressIds || []).map(str))];
  const wanted = asked.filter(isId);
  const unproven = asked.filter((id) => !isId(id));
  if (!isId(companyId) || !wanted.length) {
    return { docs: [], byId: new Map(), workOrders: new Map(), unproven: [...unproven, ...wanted] };
  }
  const docs = await EmployeeProductionProgress.find({ _id: { $in: wanted.map(oid) } });
  const workOrderIds = [...new Set(docs.map((d) => str(d.workOrderId)).filter(isId))];
  const owned = workOrderIds.length
    ? await WorkOrder.find(scoped(companyId, { _id: { $in: workOrderIds.map(oid) } })).lean()
    : [];
  const ownedById = new Map(owned.map((w) => [String(w._id), w]));

  const byId = new Map();
  const kept = [];
  for (const doc of docs) {
    if (ownedById.has(str(doc.workOrderId))) {
      byId.set(String(doc._id), doc);
      kept.push(doc);
    }
  }
  for (const id of wanted) if (!byId.has(id)) unproven.push(id);
  return { docs: kept, byId, workOrders: ownedById, unproven };
}

/** The one answer a foreign, unlinked, malformed or unknown record gets. */
const notFound = (res, what = "work") => res.status(404).json({
  success: false, code: "NOT_FOUND",
  message: `No ${what} of your company has that id.`,
});

module.exports = {
  SLUG, LEGACY_ROLES, READER_DEPARTMENTS, isPackagingSession,
  grantsExist, effectiveRole,
  packagingDepartment, packagingReader, packagingCompany, canRecord,
  workOrderScope, scoped, findWorkOrders, findWorkOrder,
  moWorkOrderIds, moScope, resolveProgressDocs, notFound,
  isId, oid, str,
};
