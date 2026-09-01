// Middlewear/departmentWriteGuard.js
//
// One line at the mount point turns a whole department's API into
// role-enforced, approval-backed writes:
//
//   app.use("/api/cms/sales", departmentWrites("sales", { entity: "sales record" }), salesRoutes);
//
// It is mount-level rather than per-route on purpose. Sales alone has six
// routers and well over a hundred handlers; annotating each one means the guard
// is missing from whichever handler somebody adds next, and a permission system
// with a hole in it is worse than none, because everybody believes it is
// covered.
//
// WHAT IT DOES, IN ORDER
//   1. Reads are never touched. GET/HEAD/OPTIONS pass instantly — a viewer is
//      supposed to be able to see everything in their department.
//   2. Read-shaped POSTs are exempt (see READ_SHAPED). Search, export, PDF and
//      preview endpoints use POST only because their filters do not fit in a
//      query string; queueing an export for approval would be absurd.
//   3. requireDepartmentRole(slug, "editor") — viewers are refused outright.
//   4. requireApproval(slug) — an approver or owner commits directly; an
//      EDITOR's change is held as a ChangeRequest and answered with 202.
//
// Both underlying guards fail OPEN for a department with no roles assigned yet,
// so mounting this changes nothing until an administrator grants the first
// role. That is what makes it safe to add to a live department.

"use strict";

const jwt = require("jsonwebtoken");

const { requireDepartmentRole } = require("../services/departmentRoles");
const { requireApproval } = require("../services/changeRequests");
const { sectionForPath } = require("../services/auditSections");
const describeChange = require("../services/changeRequestDescribe");
const { SECRET, LEGACY_SECRETS, readToken } = require("../config/jwt");

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Put the caller's identity on the request, if nothing has yet.
 *
 * THIS IS LOAD-BEARING. Being mounted at the app level means this guard runs
 * BEFORE the router's own auth middleware (salesAuth and friends), so `req.user`
 * is still empty when the role and approval checks want an email — and both of
 * them refuse an anonymous caller. Every write in the department would answer
 * 401 with a perfectly valid session.
 *
 * Only ever fills a GAP: if something upstream already resolved the user, that
 * object is left exactly as it is. The router's own middleware runs afterwards
 * and assigns its own richer `req.user` over this one, so nothing downstream
 * sees a difference. A token that will not verify is left alone too — rejecting
 * it here would take the department's own 401 message away and replace it with
 * a less useful one.
 */
function seedIdentity(req) {
  if (req.user?.email || req.admin || req.dept?.email) return;

  const token = readToken(req);
  if (!token) return;

  let decoded = null;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    for (const legacy of LEGACY_SECRETS) {
      try {
        decoded = jwt.verify(token, legacy);
        break;
      } catch {
        /* try the next */
      }
    }
  }
  if (!decoded) return;

  req.user = {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    role: decoded.role,
    isAdmin: Boolean(decoded.isAdmin),
    deptSlug: decoded.deptSlug || "",
  };
}

/**
 * Path fragments that are POSTs but do not change anything the department owns.
 *
 * Matched case-insensitively against the path. Deliberately conservative: a
 * fragment listed here bypasses approval entirely, so anything ambiguous is
 * left OUT and simply goes through the queue.
 */
const READ_SHAPED = [
  "/search",
  "/export",
  "/download",
  "/preview",
  "/report",
  "/pdf",
  "/filter",
  "/lookup",
  "/validate",
  "/check",
  "/calculate",
  "/verify-otp",
  "/send-otp",
  "/login",
  "/logout",
  "/refresh",

  /* Added after these turned up in the change history as edits. Each one is a
     POST only because its input does not fit in a query string:

       /verify    GSTIN and PAN verification — the accountant company form
                  fires it on blur, so typing a GSTIN wrote "changed" to the
                  history twice before anything had been saved
       /probe, /suggest, /resolve, /parse   read-and-return helpers
       /status, /ping                       liveness and connector checks

     `/verify` deliberately sits alongside the older `/verify-otp`: that one is
     a prefix of nothing, and leaving only it meant every plain verification
     endpoint counted as a write. */
  "/verify",
  "/probe",
  "/suggest",
  "/resolve",
  "/parse",
  "/status",
  "/ping",
];

function isReadShaped(path) {
  const p = String(path || "").toLowerCase().split("?")[0];
  return READ_SHAPED.some((frag) => p.includes(frag));
}

/**
 * @param {string} slug   department slug, e.g. "sales"
 * @param {object} [opts]
 * @param {string}   [opts.entity]    label shown in the approval queue
 * @param {string[]} [opts.exempt]    extra path fragments to let through
 * @param {function} [opts.describe]  (req) => { entityId, entityLabel, summary, changes }
 */
function departmentWrites(slug, opts = {}) {
  const { entity = "record", exempt = [], describe } = opts;

  const roleGuard = requireDepartmentRole(slug, "editor");

  // Without a describe() the queue card can only name the entity — "Change ·
  // employee" — which tells an approver nothing about what they are approving.
  // services/changeRequestDescribe works from the path and body alone, so every
  // department gets the field list by default; a mount that knows better still
  // wins by passing its own.
  const describeFor = (action) => describe || describeChange(action);

  // The action is derived from the verb, which is what the queue shows the
  // approver. It is a heuristic and says so — a POST to an /:id/cancel route
  // reads as "create" without it, which would be actively misleading.
  const guards = {
    POST: requireApproval(slug, { entity, action: "create", describe: describeFor("create") }),
    PUT: requireApproval(slug, { entity, action: "update", describe: describeFor("update") }),
    PATCH: requireApproval(slug, { entity, action: "update", describe: describeFor("update") }),
    DELETE: requireApproval(slug, { entity, action: "delete", describe: describeFor("delete") }),
  };

  return function departmentWriteGuard(req, res, next) {
    if (READ_METHODS.has(req.method)) return next();

    const path = req.originalUrl || req.url || "";
    if (isReadShaped(path)) return next();

    // Which page this write belongs to, for a held change's history entry.
    // Set on the request rather than baked into the guard because one mount
    // covers a whole department: HR's writes arrive on twenty different paths
    // and a single section chosen at mount time would file all of them under
    // one page. A route that names its own section when it logs still wins —
    // this is only the fallback for a change that never reaches its route.
    const resolved = sectionForPath(path);
    if (resolved && !req.auditSection) {
      req.auditSection = resolved.section;
      req.auditEntity = resolved.entity;
    }

    // Must happen before either guard reads req.user — see seedIdentity.
    seedIdentity(req);

    // No usable session. Say nothing and let the router's own auth middleware
    // refuse it: that message names the department and the role it wanted,
    // which is far more useful than a generic "not authenticated" from here.
    if (!req.user?.email && !req.admin && !req.dept?.email) return next();
    if (exempt.some((frag) => path.toLowerCase().includes(String(frag).toLowerCase()))) {
      return next();
    }

    // A POST to an /:id/… sub-action is a change TO an existing record, not a
    // new one. Getting this right matters because the queue groups by action.
    const approval =
      req.method === "POST" && /\/[^/]+\/[a-z-]+$/i.test(path.split("?")[0])
        ? guards.PATCH
        : guards[req.method] || guards.POST;

    roleGuard(req, res, (err) => {
      if (err) return next(err);
      // The role guard answers the response itself when it refuses, so reaching
      // here means the caller is at least an editor.
      if (res.headersSent) return;
      approval(req, res, next);
    });
  };
}

module.exports = departmentWrites;
module.exports.READ_SHAPED = READ_SHAPED;
