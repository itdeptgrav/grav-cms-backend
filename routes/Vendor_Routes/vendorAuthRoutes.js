// routes/Vendor_Routes/vendorAuthRoutes.js
const express = require("express");
const router = express.Router();
const Vendor = require("../../models/Vendor_Models/vendor");
const VendorAuthMiddleware = require("../../Middlewear/VendorAuthMiddleware");

// ✅ Vendor login (NO AUTH REQUIRED)
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Find vendor by email or username
    const vendor = await Vendor.findOne({
      $or: [{ email: email.toLowerCase() }, { username: email.toLowerCase() }],
      isDeleted: false,
    });

    if (!vendor || vendor.status !== "active") {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials or vendor is inactive",
      });
    }

    // Check password
    const isPasswordValid = await vendor.comparePassword(password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Generate JWT token
    const jwt = require("jsonwebtoken");
    const token = jwt.sign(
      {
        id: vendor._id,
        role: "vendor",
        vendorCode: vendor.vendorCode,
        email: vendor.email,
        name: vendor.name,
        contactPerson: vendor.contactPerson,
        category: vendor.category,
      },
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "24h" },
    );

    // Set cookie
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("vendor_token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      message: "Login successful",
      token,
      vendor: {
        id: vendor._id,
        name: vendor.name,
        email: vendor.email,
        vendorCode: vendor.vendorCode,
        contactPerson: vendor.contactPerson,
        category: vendor.category,
        phone: vendor.phone,
      },
    });
  } catch (error) {
    console.error("Vendor login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error during login",
    });
  }
});

// ✅ Vendor logout (NO AUTH REQUIRED)
router.post("/logout", (req, res) => {
  res.clearCookie("vendor_token");
  res.json({
    success: true,
    message: "Logged out successfully",
  });
});

// ✅ Validate vendor token (NO AUTH REQUIRED - validates token itself)
router.get("/validate", async (req, res) => {
  try {
    const token = req.cookies.vendor_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "No authentication token",
      });
    }

    // Verify token
    const jwt = require("jsonwebtoken");
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

    // Get fresh vendor data
    const vendor = await Vendor.findById(decoded.id)
      .select("name vendorCode email status contactPerson category phone")
      .lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    res.status(200).json({
      success: true,
      message: "Token is valid",
      vendor,
    });
  } catch (error) {
    console.error("Token validation error:", error);

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

    res.status(401).json({
      success: false,
      message: "Token validation failed",
    });
  }
});

// ✅ Get vendor dashboard data (AUTH REQUIRED)
router.get("/dashboard", VendorAuthMiddleware, async (req, res) => {
  try {
    const vendor = await Vendor.findById(req.vendor.id)
      .select("-password -__v")
      .lean();

    if (!vendor) {
      return res.status(404).json({
        success: false,
        message: "Vendor not found",
      });
    }

    // Get vendor-specific stats
    const stats = {
      activeOrders: vendor.totalOrders || 0,
      pendingPayments: 0,
      onTimeDelivery: vendor.onTimeDelivery || 0,
      avgRating: vendor.rating || 0,
      totalCompletedOrders: vendor.totalOrders || 0,
    };

    res.status(200).json({
      success: true,
      data: {
        vendor,
        stats,
      },
    });
  } catch (error) {
    console.error("Error fetching vendor dashboard:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching dashboard",
    });
  }
});

module.exports = router;
