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
//   "sales" | "admin" | "ceo"
//   Add more roles to ALLOWED_ROLES if other departments need CRM read access.

const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET || "grav_clothing_secret_key";

// Roles that are allowed to access the CRM (Leads / Contacts / Accounts)
const ALLOWED_ROLES = ["sales", "admin", "ceo", "project_manager"];

const SalesAuthMiddlewear = (req, res, next) => {
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
    if (!ALLOWED_ROLES.includes(decoded.role)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. Sales CRM requires role: ${ALLOWED_ROLES.join(" or ")}. Your role: ${decoded.role}.`,
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

module.exports = SalesAuthMiddlewear;
