// services/qcViewer.js
//
// WHO IS ASKING, AND HOW MUCH OF QC THEY ARE ALLOWED TO SEE.
//
// The QC overview used to answer every question with the whole department's
// day: every inspector's pieces, every inspector's defect rate, every
// inspector's name in a filter dropdown. For the person running the line that
// is the point. For one of six inspectors it is noise they have to filter
// themselves out of — and it is other people's performance data, which is not
// theirs to read.
//
// So reads are SCOPED TO THE PERSON unless they are the QC owner (or a platform
// admin, who has to be able to fix a department whose owner has left).
//
// THE TWO-IDENTITY PROBLEM, WHICH IS THE WHOLE REASON THIS FILE EXISTS
// -------------------------------------------------------------------
// The CMS knows a person by EMAIL — that is the join key for department_roles
// and for every other grant. The QC station knows them by BIOMETRIC ID, because
// an inspector badges in with an ID card and that is what gets stamped on the
// defect record. The two never meet on their own.
//
// Every inspection written from today carries both (inspectedByEmail was added
// with the checkpoint work). Every inspection written BEFORE that carries only
// the biometric id. So scoping has to match on either, which means resolving
// the caller's biometric id from their Employee record once per request and
// querying `$or`. Matching on email alone would silently hide an inspector's
// entire history before the upgrade; matching on biometric id alone would hide
// the work of anyone whose employee record has no ID card yet.
//
// FAIL CLOSED. A caller whose identity cannot be resolved at all sees nothing,
// not everything. This is the opposite of the department-role guard's
// deliberate fail-open, and deliberately so: that guard was avoiding locking
// eleven unconfigured departments out of their own dashboards, whereas here the
// failure mode of guessing wrong is showing one person another person's record.

"use strict";

const jwt = require("jsonwebtoken");

const { SECRET, LEGACY_SECRETS, readToken } = require("../config/jwt");
const { getRole } = require("./departmentRoles");
const Employee = require("../models/Employee");

const SLUG = "qc";

/** Decode whoever is on the request, without refusing anybody outright. */
function decodeCaller(req) {
  // Something upstream may already have resolved this — the /api/cms mount runs
  // EmployeeAuthMiddleware ahead of the QC routers, so req.user is usually set
  // by the time we get here. Prefer it; fall back to the token.
  if (req.user?.email) {
    return {
      id: req.user.id,
      email: String(req.user.email).toLowerCase(),
      name: req.user.name || "",
      isAdmin: Boolean(req.user.isAdmin),
    };
  }

  const token = readToken(req);
  if (!token) return null;

  let decoded = null;
  try {
    decoded = jwt.verify(token, SECRET);
  } catch {
    for (const legacy of LEGACY_SECRETS) {
      try { decoded = jwt.verify(token, legacy); break; } catch { /* next */ }
    }
  }
  if (!decoded) return null;

  return {
    id: decoded.id,
    email: String(decoded.email || "").toLowerCase(),
    name: decoded.name || "",
    isAdmin: Boolean(decoded.isAdmin),
  };
}

/**
 * Last resort: get an email from the token's user id.
 *
 * WHY THIS EXISTS. Everything downstream keys off the email — the QC role that
 * decides whether you are the owner, and the scan-ownership match. A caller
 * with no email is "unidentified" and, because this module fails closed, sees
 * NOTHING. For an ordinary inspector that is a mild annoyance; for the OWNER it
 * is the whole department's day vanishing off their dashboard with no error and
 * no clue why.
 *
 * Every login path in `routes/auth/deptAuth.js` and `routes/login.js` puts an
 * email in the payload today, so this should never fire. It exists precisely
 * because "should never fire" is doing a lot of work in that sentence: there
 * are seven signing sites across two files, tokens live for seven days, and the
 * failure mode of the eighth one forgetting is silent and total. One indexed
 * lookup, only when the token gave us nothing, is a cheap insurance premium.
 */
async function emailFromId(id) {
  if (!id) return { email: "", name: "" };
  try {
    const DeptUser = require("../models/Access/DeptUser");
    const u = await DeptUser.findById(id).select("email name").lean();
    if (u?.email) return { email: String(u.email).toLowerCase(), name: u.name || "" };
  } catch { /* not a DeptUser, or the id is not an ObjectId */ }
  try {
    const e = await Employee.findById(id).select("email firstName lastName").lean();
    if (e?.email) {
      return {
        email: String(e.email).toLowerCase(),
        name: [e.firstName, e.lastName].filter(Boolean).join(" ").trim(),
      };
    }
  } catch { /* nor an Employee */ }
  return { email: "", name: "" };
}

/**
 * The caller, their QC role, and the station identity their scans carry.
 *
 * Never throws — a lookup failure downgrades to "unidentified", which sees
 * nothing rather than everything.
 */
/* ── Identity cache ───────────────────────────────────────────────────────────
 *
 * WHY THIS EXISTS (29 Aug 2026, chasing QC dashboard load time). Resolving a
 * viewer costs three round-trips — the department role, the Employee record for
 * the biometric id, and (separately) `departmentConfigured`'s role list. The
 * overview loads three endpoints at once and each one resolved the viewer from
 * scratch, so a single page load spent nine queries answering the same question
 * about the same person nine times.
 *
 * Keyed on email, 60 seconds, in-process. The same shape and lifetime rationale
 * as `getMasterOperations`'s cache in qcRoutes and `coworkAuth`'s employee
 * cache: role changes are rare and administrative, and a minute of staleness on
 * "which QC role does this person hold" is the same exposure the CoWork side
 * already accepts at five. `invalidateViewer()` is exported so the team screen
 * can clear it the moment it grants or revokes a role, which is the one case
 * where waiting a minute would be visibly wrong.
 */
const VIEWER_TTL_MS = 60 * 1000;
const viewerCache = new Map();

function cacheGet(key) {
  const hit = viewerCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > VIEWER_TTL_MS) { viewerCache.delete(key); return null; }
  return hit.value;
}

function cacheSet(key, value) {
  // Bounded so a long-running process cannot accumulate an entry per person
  // seen since boot.
  if (viewerCache.size > 500) viewerCache.clear();
  viewerCache.set(key, { at: Date.now(), value });
}

/** Drop cached identity — all of it, or one person's. */
function invalidateViewer(email) {
  if (email) viewerCache.delete(`v:${String(email).toLowerCase()}`);
  else viewerCache.clear();
  viewerCache.delete("configured");
}

async function resolveViewer(req) {
  const caller = decodeCaller(req);
  if (!caller) {
    return {
      identified: false, email: "", name: "", biometricId: "",
      role: null, isAdmin: false, canSeeEveryone: false,
    };
  }

  // A token that carried an id but no email — see emailFromId.
  if (!caller.email && caller.id) {
    const found = await emailFromId(caller.id);
    if (found.email) {
      caller.email = found.email;
      if (!caller.name) caller.name = found.name;
    }
  }

  if (!caller.email && !caller.isAdmin) {
    return {
      identified: false, email: "", name: "", biometricId: "",
      role: null, isAdmin: false, canSeeEveryone: false,
    };
  }

  // The two lookups below are what the cache is for — see its note above.
  const cacheKey = `v:${String(caller.email || "").toLowerCase()}`;
  const cached = caller.email ? cacheGet(cacheKey) : null;

  let role = cached ? cached.role : null;
  let biometricId = cached ? cached.biometricId : "";

  if (!cached) {
    // Both are independent reads, so they go together rather than in sequence.
    const [roleResult, empResult] = await Promise.allSettled([
      getRole(SLUG, caller.email),
      caller.email
        ? Employee.findOne({ email: caller.email }).select("biometricId").lean()
        : Promise.resolve(null),
    ]);

    if (roleResult.status === "fulfilled") role = roleResult.value;
    else console.warn("[qc viewer] role lookup failed:", roleResult.reason?.message);

    if (empResult.status === "fulfilled") biometricId = empResult.value?.biometricId || "";
    else console.warn("[qc viewer] employee lookup failed:", empResult.reason?.message);

    if (caller.email) cacheSet(cacheKey, { role, biometricId });
  }

  return {
    identified: true,
    email: caller.email,
    name: caller.name,
    biometricId,
    role,
    isAdmin: caller.isAdmin,
    // The owner runs the line: the customer rollup, the rework figures and the
    // per-inspector comparison are the reason that role exists.
    canSeeEveryone: Boolean(caller.isAdmin || role === "owner"),
  };
}

/**
 * The mongo clause that limits a query to what this viewer may read.
 *
 * Returns `null` when no restriction applies (owner/admin, or a department that
 * has not been configured — see below). Returns a `$or` clause otherwise, and
 * an impossible clause for a caller we cannot identify.
 *
 * THE UNCONFIGURED CASE. A QC department with NO roles granted at all has no
 * owner, so scoping strictly would leave every inspector able to see only
 * themselves and nobody able to see the department — including whoever is
 * meant to be setting it up. That matches how the rest of the CMS handles an
 * unconfigured department, and it stops being true the moment the first role
 * is granted, which is exactly when somebody has decided who is who.
 */
function viewerFilter(viewer, { departmentConfigured = true } = {}) {
  if (!viewer.identified) {
    // An impossible match. Explicit rather than "return everything" so a future
    // caller that forgets to check `identified` fails safe.
    return { _id: null };
  }
  if (viewer.canSeeEveryone) return null;
  if (!departmentConfigured) return null;

  const or = [];
  if (viewer.email) or.push({ inspectedByEmail: viewer.email });
  if (viewer.biometricId) or.push({ inspectedByBiometricId: viewer.biometricId });

  // Identified, but nothing to match their scans on: no biometric id on their
  // employee record and no email. They have never been able to record an
  // inspection, so an empty result is the truthful answer.
  if (!or.length) return { _id: null };

  return { $or: or };
}

/** Merge a viewer clause into a filter without clobbering an existing `$or`. */
function applyViewerFilter(filter, clause) {
  if (!clause) return filter;
  if (clause.$or) {
    filter.$and = [...(filter.$and || []), { $or: clause.$or }];
    return filter;
  }
  return Object.assign(filter, clause);
}

/** Has anybody been granted a QC role yet? Decides the unconfigured case above. */
async function departmentConfigured() {
  const cached = cacheGet("configured");
  if (cached !== null) return cached.value;
  try {
    const { listRoles } = require("./departmentRoles");
    const rows = await listRoles(SLUG);
    const value = rows.length > 0;
    cacheSet("configured", { value });
    return value;
  } catch {
    // Unknown — assume configured, which is the more restrictive answer. Not
    // cached: a transient failure should not pin the restrictive answer for a
    // minute.
    return true;
  }
}

module.exports = {
  resolveViewer,
  viewerFilter,
  applyViewerFilter,
  departmentConfigured,
  invalidateViewer,
};
