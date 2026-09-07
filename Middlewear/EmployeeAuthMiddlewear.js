// Middlewear/EmployeeAuthMiddlewear.js

const jwt = require("jsonwebtoken");

const EmployeeAuthMiddleware = (req, res, next) => {
  try {
    // 1. Try cookie first (CMS / desktop — works as before)
    let token = req.cookies?.auth_token;

    // 2. If no cookie, try Bearer token from Authorization header (iOS Safari fix)
    if (!token && req.headers.authorization?.startsWith("Bearer ")) {
      token = req.headers.authorization.split(" ")[1];
    }

    // 3. Last fallback: manually parse cookie header
    if (!token && req.headers.cookie) {
      const match = req.headers.cookie.match(/auth_token=([^;]+)/);
      if (match) token = match[1];
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Authentication required",
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );

    req.user = {
      id: decoded.id,
      role: decoded.role,
      employeeId: decoded.employeeId,
      // Carried through for audit logging — the token holds these and dropping
      // them meant every change log recorded an id with no name against it.
      name: decoded.name || "",
      email: decoded.email || "",
      // The department this session was issued for. Same story as the two
      // above: the token has carried them since v2, this middleware did not
      // forward them, and a route that needed to know which department a
      // login belonged to had no way to ask. That is what made the CEO — who
      // signs in as a department and has no `employees` row — invisible to the
      // requests desk. Additive: nothing that ignored these reads them now.
      deptId: decoded.deptId || null,
      deptSlug: decoded.deptSlug || "",
      isAdmin: Boolean(decoded.isAdmin),
      // Set only on the short-lived token services/changeRequests mints when an
      // approver's decision is replayed against this server. Carried through
      // because a ROUTE-level approval guard runs after this middleware has
      // already rebuilt `req.user`, so this is the only copy of the claim it can
      // see. Purely additive: nothing that ignored it reads it now, and it is
      // null for every ordinary session.
      replayOf: decoded.replayOf || null,
    };

    next();
  } catch (error) {
    console.error("Auth middleware error:", error);

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired. Please login again.",
      });
    }

    if (error.name === "JsonWebTokenError") {
      return res.status(401).json({
        success: false,
        message: "Invalid authentication token",
      });
    }

    return res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
};

module.exports = EmployeeAuthMiddleware;
