// Middlewear/SalesAuthMiddlewear.js
//
// Auth middleware for the Sales CRM module (Leads, Contacts, Accounts).
//
// TOKEN SOURCE:
//   All CMS users — including the sales department — log in through the
//   main login route (routes/login.js), which issues a single `auth_token`
//   cookie containing:
//     { id, role, employeeId, userType, name }
//
//   The sales user has role: "sales" and userType: "sales".
//   CEO and admin are also granted access so they can view CRM data.
//
// LOOKUP ORDER (matches existing EmployeeAuthMiddlewear pattern):
//   1. req.cookies.auth_token      — set by cookie-parser (standard path)
//   2. Authorization: Bearer <token> — for mobile / iOS Safari
//   3. Raw cookie header parse      — fallback if cookie-parser not running
//
// ALLOWED ROLES:
//   "sales" | "admin" | "ceo" | "project_manager" | "merchandiser"
//   Add more roles to ALLOWED_ROLES if other departments need CRM read access.
//
// "merchandiser" added 11 Aug 2026: the Merchandiser dashboard
// (app/merchandiser/**) reuses these SAME Sales pages — customers,
// customer-requests (Purchase Orders/PI), stock-items (Products & BOM),
// settings — via AutoDashboardLayout (see components/AutoDashboardLayout.js).
// Browsing into the Merchandiser department adopts its AccessDepartment's
// legacyRole, "merchandiser" (routes/auth/deptAuth.js's buildTokenPayload:
// `role: dept.legacyRole || dept.slug`), which this allowlist did not
// recognise — every one of those pages 403'd for anyone in Merchandiser,
// and since the frontend fetches only check `res.ok`, that surfaced as
// silent empty states ("No customers found") rather than a visible error.

const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

// Roles that are allowed to access the CRM (Leads / Contacts / Accounts)
const ALLOWED_ROLES = ["sales", "admin", "ceo", "project_manager", "merchandiser"];

// R&D role literals. deptAuth's buildTokenPayload mints `role` from
// `dept.legacyRole || dept.slug`, and the R&D department has been seen under
// more than one slug spelling, so all three are accepted rather than betting on
// one. R&D is deliberately NOT added to ALLOWED_ROLES above: that list gates the
// whole CRM — leads, contacts, accounts — and R&D has no business in any of it.
// It is granted per-route via `SalesAuthMiddlewear.withRoles(...)`.
const RND_ROLES = ["rnd", "research_development", "research-development"];

// Factory, so a route group can widen the role list without widening the CRM's.
const makeSalesAuth = (allowed) => (req, res, next) => {
  try {
    // ── 1. Cookie (standard — cookie-parser present) ───────────────────────
    let token = req.cookies?.auth_token;

    // ── 2. Authorization: Bearer header (mobile / iOS Safari) ─────────────
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    // ── 3. Raw cookie-header parse (no cookie-parser fallback) ─────────────
    if (!token && req.headers.cookie) {
      const match = req.headers.cookie.match(/auth_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required. Please log in.",
      });
    }

    // ── Verify JWT ──────────────────────────────────────────────────────────
    const decoded = jwt.verify(token, SECRET);

    // ── Role check ──────────────────────────────────────────────────────────
    if (!allowed.includes(decoded.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Requires role: ${allowed.join(" or ")}. Your role: ${decoded.role}.`,
      });
    }

    // ── Attach user to request (mirrors EmployeeAuthMiddlewear shape) ───────
    // `email` (Draft Lead chunk) — the JWT already carries it (routes/login.js
    // signs `email: user.email || ""` into every token), this middleware just
    // wasn't reading it. Needed so a GET handler can resolve the caller's
    // Sales DEPARTMENT role the same way Middlewear/departmentWriteGuard.js's
    // seedIdentity already does for writes — that guard never runs for reads
    // at all (GET/HEAD/OPTIONS pass instantly), so without this, "is this
    // caller a Sales manager" would be unanswerable on a read. See
    // services/salesAccess.js.
    req.user = {
      id: decoded.id,
      role: decoded.role,
      employeeId: decoded.employeeId,
      userType: decoded.userType,
      name: decoded.name || "",
      email: decoded.email || "",
      // Dropped before, and it matters here specifically: an org-level admin
      // browsing INTO the Sales department gets `role` overwritten to Sales'
      // own legacy literal (deptAuth.js's buildTokenPayload, `adoptDeptRole`)
      // so existing per-department checks keep working — but that means
      // `role` alone can no longer answer "is this an admin" once they are
      // inside a department. `isAdmin` is signed into the token unconditionally
      // (buildTokenPayload's `isAdmin: Boolean(user.isAdmin)`) precisely so
      // callers who need the org-level fact still can. See services/salesAccess.js.
      isAdmin: Boolean(decoded.isAdmin),
    };

    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please log in again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token.",
      });
    }

    console.error("[SalesAuthMiddlewear]", error.message);
    return res.status(401).json({
      success: false,
      message: "Authentication failed.",
    });
  }
};

const SalesAuthMiddlewear = makeSalesAuth(ALLOWED_ROLES);

/**
 * Same guard, with extra roles allowed for this route group only.
 *   router.use(SalesAuthMiddlewear.withRoles(SalesAuthMiddlewear.RND_ROLES))
 */
SalesAuthMiddlewear.withRoles = (...extra) =>
  makeSalesAuth([...ALLOWED_ROLES, ...extra.flat()]);
SalesAuthMiddlewear.ALLOWED_ROLES = ALLOWED_ROLES;
SalesAuthMiddlewear.RND_ROLES = RND_ROLES;
SalesAuthMiddlewear.isRnd = (role) => RND_ROLES.includes(role);

module.exports = SalesAuthMiddlewear;
