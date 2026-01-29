const express = require("express");
const router = express.Router();
const bcrypt = require("bcryptjs");
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");
const HRDepartment = require("../../models/HRDepartment");

// ✅ GET HR Profile
router.get("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const hr = await HRDepartment.findById(req.user.id).select("-password");

    if (!hr) {
      return res.status(404).json({
        success: false,
        message: "HR profile not found",
      });
    }

    res.status(200).json({
      success: true,
      data: hr,
    });
  } catch (error) {
    console.error("Get HR profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ✅ UPDATE HR Profile
router.put("/profile", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { name, phone, email } = req.body;

    // Validate input
    if (!name || !phone || !email) {
      return res.status(400).json({
        success: false,
        message: "Name, phone and email are required",
      });
    }

    // Check if email is already taken by another HR
    const existingHR = await HRDepartment.findOne({
      email: email.toLowerCase(),
      _id: { $ne: req.user.id },
    });

    if (existingHR) {
      return res.status(400).json({
        success: false,
        message: "Email already in use",
      });
    }

    const updatedHR = await HRDepartment.findByIdAndUpdate(
      req.user.id,
      {
        name,
        phone,
        email: email.toLowerCase(),
      },
      { new: true, runValidators: true },
    ).select("-password");

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedHR,
    });
  } catch (error) {
    console.error("Update HR profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

// ✅ CHANGE PASSWORD
router.put("/change-password", EmployeeAuthMiddleware, async (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;

    // Validate input
    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "All password fields are required",
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).json({
        success: false,
        message: "New passwords do not match",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "Password must be at least 8 characters long",
      });
    }

    // Get HR with password
    const hr = await HRDepartment.findById(req.user.id);

    // Verify current password
    const isPasswordValid = await bcrypt.compare(currentPassword, hr.password);

    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Update password (auto-hashed by pre-save hook)
    hr.password = newPassword;
    await hr.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
    });
  }
});

module.exports = router;
