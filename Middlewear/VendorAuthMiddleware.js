// middleware/VendorAuthMiddleware.js
const jwt = require("jsonwebtoken");

const VendorAuthMiddleware = (req, res, next) => {
  try {
    // 🔐 Read token from cookie
    const token = req.cookies.vendor_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Vendor authentication required",
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );

    // Check if it's a vendor token
    if (decoded.role !== "vendor") {
      return res.status(403).json({
        success: false,
        message: "Access denied. Vendor access only.",
      });
    }

    // Attach vendor info to request
    req.vendor = {
      id: decoded.id,
      vendorCode: decoded.vendorCode,
      email: decoded.email,
      role: decoded.role,
    };

    next();
  } catch (error) {
    console.error("Vendor auth middleware error:", error);

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
      message: "Vendor authentication failed",
    });
  }
};

module.exports = VendorAuthMiddleware;
