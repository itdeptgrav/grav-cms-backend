const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Employee = require("../../models/Employee");

const router = express.Router();

/**
 * EMPLOYEE LOGIN
 */
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const employee = await Employee.findOne({
      email: email.toLowerCase(),
      isActive: true,
    }).select("+password");

    if (!employee) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const isMatch = await bcrypt.compare(password, employee.password);

    if (!isMatch) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      {
        id: employee._id,
        email: employee.email,
        type: "employee",
      },
      process.env.JWT_SECRET,
      { expiresIn: "24h" },
    );

    const isProduction = process.env.NODE_ENV === "production";

    res.cookie("employee_token", token, {
      httpOnly: true,
      secure: isProduction, // ✅ must be true only in https production
      sameSite: isProduction ? "none" : "lax", // ✅ Fix for localhost
      maxAge: 24 * 60 * 60 * 1000,
    });

    res.status(200).json({
      success: true,
      message: "Employee login successful",
      data: {
        employee: {
          id: employee._id,
          firstName: employee.firstName,
          lastName: employee.lastName,
          email: employee.email,
          biometricId: employee.biometricId,
          department: employee.department,
          jobTitle: employee.jobTitle,
          profilePhoto: employee.profilePhoto,
          role: employee.role, // ✅ make sure you send role
        },
      },
    });
  } catch (err) {
    console.error("Employee login error:", err);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

/** VERIFY EMPLOYEE AUTHENTICATION
 */
router.get("/verify", async (req, res) => {
  try {
    const token = req.cookies.employee_token;

    if (!token) {
      return res.status(401).json({
        success: false,
        message: "Not authenticated",
      });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const employee = await Employee.findById(decoded.id).select("-password");

    if (!employee || !employee.isActive) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }

    return res.status(200).json({
      success: true,
      data: employee,
    });
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: "Invalid or expired token",
    });
  }
});

/**
 * EMPLOYEE LOGOUT
 */
router.post("/logout", (req, res) => {
  res.clearCookie("employee_token");
  res.status(200).json({
    success: true,
    message: "Logged out successfully",
  });
});

module.exports = router;
