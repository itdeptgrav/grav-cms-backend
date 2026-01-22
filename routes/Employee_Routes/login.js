const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Employee = require("../models/Employee");
const HRDepartment = require("../models/HRDepartment");
require("dotenv").config();

// Login route for both Employees and HR
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required",
      });
    }

    // Try to find user in Employee collection
    let user = await Employee.findOne({ email: email.toLowerCase() }).select(
      "+password",
    );

    // If not found in Employee, try HR Department
    if (!user) {
      user = await HRDepartment.findOne({ email: email.toLowerCase() }).select(
        "+password",
      );
    }

    // If user not found in either collection
    if (!user) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Check if user is active
    if (user.isActive === false) {
      return res.status(403).json({
        success: false,
        message: "Account is deactivated. Please contact HR.",
      });
    }

    // Check password
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    // Create JWT token payload
    const tokenPayload = {
      id: user._id,
      email: user.email,
      role: user.role || "employee", // HR users have role, employees may not
      employeeId: user.employeeId || user.biometricId,
      name: `${user.firstName || user.name} ${user.lastName || ""}`,
      department: user.department,
    };

    // Generate JWT token
    const token = jwt.sign(
      tokenPayload,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "24h" },
    );

    // Set cookie with token
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    // Remove password from response
    const userResponse = user.toObject();
    delete userResponse.password;

    res.status(200).json({
      success: true,
      message: "Login successful",
      data: {
        user: {
          id: userResponse._id,
          email: userResponse.email,
          role: userResponse.role || "employee",
          employeeId: userResponse.employeeId || userResponse.biometricId,
          name: `${userResponse.firstName || userResponse.name} ${userResponse.lastName || ""}`,
          department: userResponse.department,
          profilePhoto: userResponse.profilePhoto,
          jobTitle: userResponse.jobTitle,
        },
        token: token,
      },
    });
  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Internal server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// Logout route
router.post("/logout", (req, res) => {
  res.clearCookie("auth_token");
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

// Check authentication status
router.get("/check", async (req, res) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    // Verify token
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key",
    );

    // Find user
    let user = await Employee.findById(decoded.id).select("-password");
    if (!user) {
      user = await HRDepartment.findById(decoded.id).select("-password");
    }

    if (!user) {
      res.clearCookie("auth_token");
      return res.status(401).json({
        success: false,
        message: "User not found",
      });
    }

    res.status(200).json({
      success: true,
      data: {
        user: {
          id: user._id,
          email: user.email,
          role: user.role || "employee",
          employeeId: user.employeeId || user.biometricId,
          name: `${user.firstName || user.name} ${user.lastName || ""}`,
          department: user.department,
          profilePhoto: user.profilePhoto,
          jobTitle: user.jobTitle,
        },
      },
    });
  } catch (error) {
    console.error("Auth check error:", error);
    res.clearCookie("auth_token");

    if (error.name === "TokenExpiredError") {
      return res.status(401).json({
        success: false,
        message: "Session expired",
      });
    }

    res.status(401).json({
      success: false,
      message: "Authentication failed",
    });
  }
});

module.exports = router;
