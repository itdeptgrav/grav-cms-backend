// Middlewear/EmployeeAuthMiddlewear.js
// Middlewear/EmployeeAuthMiddleware.js - UPDATED VERSION

const jwt = require("jsonwebtoken");

const EmployeeAuthMiddleware = (allowedRoles = []) => {
  return (req, res, next) => {
    try {
      // 🔐 Read token from cookie
      const token = req.cookies.auth_token;

      if (!token) {
        return res.status(401).json({
          success: false,
          message: "Authentication required",
        });
      }

      // Verify token
      const decoded = jwt.verify(
        token,
        process.env.JWT_SECRET || "grav_clothing_secret_key",
      );

      // Check if user has required role
      if (allowedRoles.length > 0 && !allowedRoles.includes(decoded.role)) {
        return res.status(403).json({
          success: false,
          message: `Access denied. Required role: ${allowedRoles.join(" or ")}`,
        });
      }

      // Attach user info to request
      req.user = {
        id: decoded.id,
        role: decoded.role,
        employeeId: decoded.employeeId,
        name: decoded.name,
        email: decoded.email,
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
};

// Export specific middleware for different roles
module.exports = EmployeeAuthMiddleware;

// Pre-configured middleware for common roles
module.exports.projectManagerAuth = EmployeeAuthMiddleware([
  "project_manager",
  "admin",
]);
module.exports.hrAuth = EmployeeAuthMiddleware(["hr_manager", "admin"]);
module.exports.accountantAuth = EmployeeAuthMiddleware(["accountant", "admin"]);
module.exports.cuttingMasterAuth = EmployeeAuthMiddleware([
  "cutting_master",
  "admin",
]);
module.exports.employeeAuth = EmployeeAuthMiddleware(["employee", "admin"]);
module.exports.anyEmployeeAuth = EmployeeAuthMiddleware(); // Allow any authenticated employee
