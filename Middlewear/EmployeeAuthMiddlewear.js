// Middlewear/EmployeeAuthMiddlewear.js

const jwt = require("jsonwebtoken");

const EmployeeAuthMiddleware = (req, res, next) => {
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

    // Attach user info to request
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
