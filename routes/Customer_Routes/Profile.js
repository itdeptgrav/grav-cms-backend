// routes/Customer_Routes/Profile.js

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const verifyCustomerToken = require("../../Middlewear/CustomerAuthMiddleware");

const isValidEmail = (e) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// ─────────────────────────────────────────────────────────────────────────
// GET /api/customer/profile
// ─────────────────────────────────────────────────────────────────────────
router.get("/", verifyCustomerToken, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId).select(
      "-password -__v -cart -orders -favorites"
    );
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }
    const a = customer.profile?.address || {};
    const hasCompleteAddress = !!(a.street && a.city && a.pincode);
    res.status(200).json({ success: true, customer: customer.toObject(), hasCompleteAddress });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile
// Accepts: name, email, gstNumber, alternatePhone, businessInfo,
//          bankDetails, profile.{ address, measurements, preferences }
// ─────────────────────────────────────────────────────────────────────────
router.put("/", verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const updates = req.body || {};

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res.status(404).json({ success: false, message: "Customer not found" });
    }

    // Phone and password never updatable here
    delete updates.phone;
    delete updates.password;

    // ── Name ───────────────────────────────────────────────────────
    if (typeof updates.name === "string") {
      const trimmed = updates.name.trim();
      if (!trimmed) return res.status(400).json({ success: false, message: "Name cannot be empty." });
      customer.name = trimmed;
    }

    // ── Email ──────────────────────────────────────────────────────
    if (typeof updates.email === "string") {
      const newEmail = updates.email.trim().toLowerCase();
      const currentEmail = String(customer.email || "").trim().toLowerCase();
      if (newEmail !== currentEmail) {
        if (!isValidEmail(newEmail)) {
          return res.status(400).json({ success: false, message: "Please enter a valid email address." });
        }
        const taken = await Customer.findOne({ email: newEmail, _id: { $ne: customer._id } }).select("_id");
        if (taken) {
          return res.status(409).json({ success: false, message: "That email is already used by another account." });
        }
        customer.email = newEmail;
        customer.isEmailVerified = false;
      }
    }

    // ── GST number (top-level) ─────────────────────────────────────
    if (typeof updates.gstNumber === "string") {
      customer.gstNumber = updates.gstNumber.trim().toUpperCase();
    }

    // ── Alternate phone ────────────────────────────────────────────
    if (typeof updates.alternatePhone === "string") {
      customer.alternatePhone = updates.alternatePhone.trim();
    }

    // ── Business info ──────────────────────────────────────────────
    if (updates.businessInfo && typeof updates.businessInfo === "object") {
      customer.businessInfo = {
        ...(customer.businessInfo?.toObject?.() || customer.businessInfo || {}),
        ...updates.businessInfo,
      };
      customer.markModified("businessInfo");
    }

    // ── Bank details ───────────────────────────────────────────────
    if (updates.bankDetails && typeof updates.bankDetails === "object") {
      const bd = updates.bankDetails;
      customer.bankDetails = {
        ...(customer.bankDetails?.toObject?.() || customer.bankDetails || {}),
        ...bd,
        ifscCode: bd.ifscCode ? String(bd.ifscCode).toUpperCase() : (customer.bankDetails?.ifscCode || ""),
      };
      customer.markModified("bankDetails");
    }

    // ── Nested profile fields ──────────────────────────────────────
    if (updates.profile && typeof updates.profile === "object") {
      if (updates.profile.address) {
        customer.profile.address = { ...(customer.profile?.address || {}), ...updates.profile.address };
      }
      if (updates.profile.measurements) {
        customer.profile.measurements = { ...(customer.profile?.measurements || {}), ...updates.profile.measurements };
      }
      if (updates.profile.preferences) {
        customer.profile.preferences = { ...(customer.profile?.preferences || {}), ...updates.profile.preferences };
      }
      customer.markModified("profile");
    }

    await customer.save();

    const updated = await Customer.findById(customerId).select("-password -__v -cart -orders -favorites");
    res.status(200).json({ success: true, message: "Profile updated successfully", customer: updated });
  } catch (error) {
    console.error("Update profile error:", error);
    if (error.name === "ValidationError") {
      return res.status(400).json({ success: false, message: Object.values(error.errors).map(e => e.message).join(", ") });
    }
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: "That email is already taken by another account." });
    }
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/address
// ─────────────────────────────────────────────────────────────────────────
router.put("/address", verifyCustomerToken, async (req, res) => {
  try {
    const addressData = req.body || {};
    if (!addressData.street || !addressData.city || !addressData.pincode) {
      return res.status(400).json({ success: false, message: "Street, city, and pincode are required" });
    }
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    customer.profile.address = { ...(customer.profile?.address || {}), ...addressData, country: addressData.country || "India" };
    customer.markModified("profile");
    await customer.save();
    res.status(200).json({ success: true, message: "Address updated successfully", address: customer.profile.address });
  } catch (error) {
    console.error("Update address error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/preferences
// ─────────────────────────────────────────────────────────────────────────
router.put("/preferences", verifyCustomerToken, async (req, res) => {
  try {
    const preferences = req.body || {};
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    customer.profile.preferences = { ...(customer.profile?.preferences || {}), ...preferences };
    customer.markModified("profile");
    await customer.save();
    res.status(200).json({ success: true, message: "Preferences updated", preferences: customer.profile.preferences });
  } catch (error) {
    console.error("Update preferences error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/measurements
// ─────────────────────────────────────────────────────────────────────────
router.put("/measurements", verifyCustomerToken, async (req, res) => {
  try {
    const measurements = req.body || {};
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    customer.profile.measurements = { ...(customer.profile?.measurements || {}), ...measurements };
    customer.markModified("profile");
    await customer.save();
    res.status(200).json({ success: true, message: "Measurements updated", measurements: customer.profile.measurements });
  } catch (error) {
    console.error("Update measurements error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/email (legacy)
// ─────────────────────────────────────────────────────────────────────────
router.put("/email", verifyCustomerToken, async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email || !isValidEmail(email)) {
      return res.status(400).json({ success: false, message: "Please enter a valid email address." });
    }
    const normalized = email.trim().toLowerCase();
    const existing = await Customer.findOne({ email: normalized, _id: { $ne: req.customerId } }).select("_id");
    if (existing) return res.status(400).json({ success: false, message: "Email already in use" });
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    customer.email = normalized;
    customer.isEmailVerified = false;
    await customer.save();
    res.status(200).json({ success: true, message: "Email updated successfully.", email: customer.email });
  } catch (error) {
    console.error("Update email error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/password
// ─────────────────────────────────────────────────────────────────────────
router.put("/password", verifyCustomerToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ success: false, message: "Current password and new password are required" });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ success: false, message: "New password must be at least 8 characters long" });
    }
    const customer = await Customer.findById(req.customerId);
    if (!customer) return res.status(404).json({ success: false, message: "Customer not found" });
    const isValid = await customer.comparePassword(currentPassword);
    if (!isValid) return res.status(400).json({ success: false, message: "Current password is incorrect" });
    customer.password = newPassword;
    await customer.save();
    res.status(200).json({ success: true, message: "Password updated successfully" });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

module.exports = router;