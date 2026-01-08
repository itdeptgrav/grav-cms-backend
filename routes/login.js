// routes/login.js

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const HRDepartment = require("../models/HRDepartment");
const ProjectManager = require("../models/ProjectManager");
const SalesDepartment = require("../models/SalesDepartment"); // Add this

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        message: "Email and password are required"
      });
    }

    let user = null;
    let userModel = null;

    // Check in all departments
    // 1. HR Department
    user = await HRDepartment.findOne({ email: email.toLowerCase() });
    if (user) {
      userModel = "hr";
    } else {
      // 2. Project Manager
      user = await ProjectManager.findOne({ email: email.toLowerCase() });
      if (user) {
        userModel = "project_manager";
      } else {
        // 3. Sales Department
        user = await SalesDepartment.findOne({ email: email.toLowerCase() });
        if (user) {
          userModel = "sales";
        }
      }
    }

    // If user not found in any collection
    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password"
      });
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      return res.status(401).json({
        success: false,
        message: "Invalid email or password trtyrt"
      });
    }

    const token = jwt.sign(
      {
        id: user._id,
        role: user.role,
        employeeId: user.employeeId,
        userType: userModel
      },
      process.env.JWT_SECRET || "grav_clothing_secret_key",
      { expiresIn: "24h" }
    );

    // 🔐 SET COOKIE
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000
    });

    // Determine redirect path based on role
    let redirectPath = "/";
    if (user.role === "hr_manager") redirectPath = "/hr/dashboard";
    if (user.role === "project_manager") redirectPath = "/project-manager/dashboard";
    if (user.role === "sales") redirectPath = "/sales/dashboard";

    res.status(200).json({
      success: true,
      message: "Login successful",
      redirectTo: redirectPath,
      userType: userModel,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        department: user.department,
        employeeId: user.employeeId
      }
    });

  } catch (error) {
    console.error("Login error:", error);
    res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
});

router.post("/verify", async (req, res) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated"
      });
    }

    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET || "grav_clothing_secret_key"
    );

    let user = null;

    // Check userType from token to query correct collection
    switch (decoded.userType) {
      case "project_manager":
        user = await ProjectManager.findById(decoded.id).select("-password");
        break;
      case "sales":
        user = await SalesDepartment.findById(decoded.id).select("-password");
        break;
      default: // "hr" or undefined
        user = await HRDepartment.findById(decoded.id).select("-password");
        break;
    }

    if (!user || !user.isActive) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized"
      });
    }

    res.status(200).json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        employeeId: user.employeeId,
        department: user.department,
        userType: decoded.userType || "hr"
      }
    });

  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token"
    });
  }
});

router.post("/logout", (req, res) => {
  res.clearCookie("auth_token");
  res.json({
    success: true,
    message: "Logged out successfully"
  });
});

module.exports = router;