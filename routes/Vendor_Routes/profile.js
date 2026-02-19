const express = require("express");
const router = express.Router();
const Vendor = require("../../models/Vendor_Models/vendor");
const VendorAuthMiddleware = require("../../Middlewear/VendorAuthMiddleware");
const bcrypt = require("bcryptjs");

// Apply vendor authentication middleware to all routes
router.use(VendorAuthMiddleware);

// ✅ GET vendor profile (authenticated vendor's own profile)
router.get("/", async (req, res) => {
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

    res.status(200).json({
      success: true,
      data: vendor,
    });
  } catch (error) {
    console.error("Error fetching vendor profile:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching vendor profile",
    });
  }
});

// ✅ UPDATE vendor profile
router.put("/", async (req, res) => {
  try {
    const vendorId = req.vendor.id;
    const updateData = req.body;

    // Fields that vendors cannot update
    const restrictedFields = [
      "password",
      "username",
      "vendorCode",
      "status",
      "rating",
      "totalOrders",
      "onTimeDelivery",
      "averageOrderValue",
      "isDeleted",
    ];

    // Remove restricted fields from update data
    restrictedFields.forEach((field) => {
      delete updateData[field];
    });

    // Check for duplicates (excluding current vendor)
    if (updateData.email && updateData.email !== req.vendor.email) {
      const duplicateEmail = await Vendor.findOne({
        email: updateData.email.toLowerCase(),
        _id: { $ne: vendorId },
      });
      if (duplicateEmail) {
        return res.status(400).json({
          success: false,
          message: "Another vendor with this email already exists",
        });
      }
    }

    if (
      updateData.gstNumber &&
      updateData.gstNumber !== req.vendor.gstNumber
    ) {
      const duplicateGST = await Vendor.findOne({
        gstNumber: updateData.gstNumber,
        _id: { $ne: vendorId },
      });
      if (duplicateGST) {
        return res.status(400).json({
          success: false,
          message: "Another vendor with this GST number already exists",
        });
      }
    }

    // Update vendor
    const updatedVendor = await Vendor.findByIdAndUpdate(
      vendorId,
      { ...updateData, updatedAt: Date.now() },
      { new: true, runValidators: true }
    ).select("-password -__v");

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      data: updatedVendor,
    });
  } catch (error) {
    console.error("Error updating vendor profile:", error);

    if (error.code === 11000) {
      const field = Object.keys(error.keyPattern)[0];
      return res.status(400).json({
        success: false,
        message: `${field} already exists`,
      });
    }

    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((err) => err.message);
      return res.status(400).json({
        success: false,
        message: "Validation error",
        errors: messages,
      });
    }

    res.status(500).json({
      success: false,
      message: "Server error while updating profile",
    });
  }
});

// ✅ CHANGE PASSWORD
router.post("/change-password", async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 6 characters long",
      });
    }

    const vendor = await Vendor.findById(req.vendor.id);

    // Verify current password
    const isPasswordValid = await vendor.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    // Update password
    vendor.password = newPassword;
    await vendor.save();

    res.status(200).json({
      success: true,
      message: "Password changed successfully",
    });
  } catch (error) {
    console.error("Error changing password:", error);
    res.status(500).json({
      success: false,
      message: "Server error while changing password",
    });
  }
});

module.exports = router;