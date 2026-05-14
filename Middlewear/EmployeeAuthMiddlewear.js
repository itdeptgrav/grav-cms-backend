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
