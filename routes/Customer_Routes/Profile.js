// routes/Customer_Routes/Profile.js
// ─────────────────────────────────────────────────────────────────────────
// Customer profile routes.
//
// ⚠️ v13 — middleware is now imported from the new shared file
//          Middlewear/CustomerAuthMiddleware.js. The inline verifyCustomerToken
//          that used to live at the top of this file is gone — same code,
//          but now also used by PasswordResetOTP.js.
//
// ⚠️ v12 fixes preserved:
//
//   1. PUT /  ACCEPTS email updates. The original route did
//      `delete updates.email` at the top, which silently dropped every
//      email change a customer made on their profile page — the value
//      always reverted on refresh because it was never sent to the
//      database. Now: format-validated, uniqueness-checked, persisted,
//      isEmailVerified flipped to false.
//
//   2. Nested-object edits (profile.preferences/measurements/address)
//      call markModified("profile") so mongoose definitely persists the
//      change. Without it, sub-doc edits sometimes no-op on .save().
//
// Phone and password are still NOT updatable through PUT /:
//   - Phone is the legacy primary identity; changing it would orphan
//     the account.
//   - Password has its own dedicated route (PUT /password) with current-
//     password verification, and the self-service flow lives in
//     /api/customer/password-reset.
// ─────────────────────────────────────────────────────────────────────────

const express = require("express");
const router = express.Router();
const Customer = require("../../models/Customer_Models/Customer");
const verifyCustomerToken = require("../../Middlewear/CustomerAuthMiddleware");

// ── Helpers ─────────────────────────────────────────────────────────────
const isValidEmail = (e) =>
  typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim());

// ─────────────────────────────────────────────────────────────────────────
// GET /api/customer/profile
// ─────────────────────────────────────────────────────────────────────────
router.get("/", verifyCustomerToken, async (req, res) => {
  try {
    const customer = await Customer.findById(req.customerId).select(
      "-password -__v -cart -orders -favorites",
    );
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    // Preserve the "hasCompleteAddress" convenience flag the old route
    // returned, in case any frontend code depends on it.
    const a = customer.profile?.address || {};
    const hasCompleteAddress = !!(a.street && a.city && a.pincode);

    res.status(200).json({
      success: true,
      customer: customer.toObject(),
      hasCompleteAddress,
    });
  } catch (error) {
    console.error("Get profile error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile
// Updates: name, email, profile.address, profile.measurements,
//          profile.preferences
// Phone and password are NOT accepted here.
// ─────────────────────────────────────────────────────────────────────────
router.put("/", verifyCustomerToken, async (req, res) => {
  try {
    const customerId = req.customerId;
    const updates = req.body || {};

    const customer = await Customer.findById(customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    // Phone and password are off-limits via this route.
    delete updates.phone;
    delete updates.password;

    // ── Name ──────────────────────────────────────────────────────
    if (typeof updates.name === "string") {
      const trimmed = updates.name.trim();
      if (trimmed.length === 0) {
        return res.status(400).json({
          success: false,
          message: "Name cannot be empty.",
        });
      }
      customer.name = trimmed;
    }

    // ── Email (NEW — was being silently dropped) ──────────────────
    if (typeof updates.email === "string") {
      const newEmail = updates.email.trim().toLowerCase();
      const currentEmail = String(customer.email || "")
        .trim()
        .toLowerCase();

      // Only do the work if it actually changed.
      if (newEmail !== currentEmail) {
        if (!isValidEmail(newEmail)) {
          return res.status(400).json({
            success: false,
            message: "Please enter a valid email address.",
          });
        }

        // Uniqueness check — case-insensitive.
        const taken = await Customer.findOne({
          email: newEmail,
          _id: { $ne: customer._id },
        }).select("_id");
        if (taken) {
          return res.status(409).json({
            success: false,
            message: "That email address is already used by another account.",
          });
        }

        customer.email = newEmail;
        // New email needs to be (re-)verified at some point. For now
        // we just flip the flag — a future flow can wire actual
        // verification email + click-to-confirm.
        customer.isEmailVerified = false;
      }
    }

    // ── Nested profile fields ─────────────────────────────────────
    if (updates.profile && typeof updates.profile === "object") {
      if (updates.profile.address) {
        customer.profile.address = {
          ...(customer.profile?.address || {}),
          ...updates.profile.address,
        };
      }
      if (updates.profile.measurements) {
        customer.profile.measurements = {
          ...(customer.profile?.measurements || {}),
          ...updates.profile.measurements,
        };
      }
      if (updates.profile.preferences) {
        customer.profile.preferences = {
          ...(customer.profile?.preferences || {}),
          ...updates.profile.preferences,
        };
      }
      // Belt-and-braces: nested sub-doc edits don't always trigger
      // mongoose's change detection. markModified guarantees the save.
      customer.markModified("profile");
    }

    await customer.save();

    const updated = await Customer.findById(customerId).select(
      "-password -__v -cart -orders -favorites",
    );

    res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      customer: updated,
    });
  } catch (error) {
    console.error("Update profile error:", error);
    if (error.name === "ValidationError") {
      const messages = Object.values(error.errors).map((e) => e.message);
      return res
        .status(400)
        .json({ success: false, message: messages.join(", ") });
    }
    if (error.code === 11000) {
      // Unique index collision (e.g. email)
      return res.status(409).json({
        success: false,
        message: "That email is already taken by another account.",
      });
    }
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/address
// ─────────────────────────────────────────────────────────────────────────
router.put("/address", verifyCustomerToken, async (req, res) => {
  try {
    const addressData = req.body || {};
    if (!addressData.street || !addressData.city || !addressData.pincode) {
      return res.status(400).json({
        success: false,
        message: "Street, city, and pincode are required",
      });
    }

    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    customer.profile.address = {
      ...(customer.profile?.address || {}),
      ...addressData,
      country: addressData.country || "India",
    };
    customer.markModified("profile");
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Address updated successfully",
      address: customer.profile.address,
    });
  } catch (error) {
    console.error("Update address error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/preferences
// ─────────────────────────────────────────────────────────────────────────
router.put("/preferences", verifyCustomerToken, async (req, res) => {
  try {
    const preferences = req.body || {};
    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    customer.profile.preferences = {
      ...(customer.profile?.preferences || {}),
      ...preferences,
    };
    customer.markModified("profile");
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Preferences updated successfully",
      preferences: customer.profile.preferences,
    });
  } catch (error) {
    console.error("Update preferences error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/measurements
// ─────────────────────────────────────────────────────────────────────────
router.put("/measurements", verifyCustomerToken, async (req, res) => {
  try {
    const measurements = req.body || {};
    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    customer.profile.measurements = {
      ...(customer.profile?.measurements || {}),
      ...measurements,
    };
    customer.markModified("profile");
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Measurements updated successfully",
      measurements: customer.profile.measurements,
    });
  } catch (error) {
    console.error("Update measurements error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/email
// Legacy dedicated email-update endpoint with uniqueness check + verify
// flag flip. Kept for backwards compatibility; the main PUT / route now
// handles email too, so new code can just use that.
// ─────────────────────────────────────────────────────────────────────────
router.put("/email", verifyCustomerToken, async (req, res) => {
  try {
    const { email } = req.body || {};

    if (!email) {
      return res
        .status(400)
        .json({ success: false, message: "Email is required" });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid email address.",
      });
    }

    const normalized = email.trim().toLowerCase();

    const existingCustomer = await Customer.findOne({
      email: normalized,
      _id: { $ne: req.customerId },
    }).select("_id");
    if (existingCustomer) {
      return res
        .status(400)
        .json({ success: false, message: "Email already in use" });
    }

    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    customer.email = normalized;
    customer.isEmailVerified = false;
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Email updated successfully. Please verify your new email.",
      email: customer.email,
    });
  } catch (error) {
    console.error("Update email error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────
// PUT /api/customer/profile/password
// Change password with current-password verification.
// (The self-service OTP flow lives in /api/customer/password-reset.)
// ─────────────────────────────────────────────────────────────────────────
router.put("/password", verifyCustomerToken, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        success: false,
        message: "Current password and new password are required",
      });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({
        success: false,
        message: "New password must be at least 8 characters long",
      });
    }

    const customer = await Customer.findById(req.customerId);
    if (!customer) {
      return res
        .status(404)
        .json({ success: false, message: "Customer not found" });
    }

    const isPasswordValid = await customer.comparePassword(currentPassword);
    if (!isPasswordValid) {
      return res.status(400).json({
        success: false,
        message: "Current password is incorrect",
      });
    }

    customer.password = newPassword;
    await customer.save();

    res.status(200).json({
      success: true,
      message: "Password updated successfully",
    });
  } catch (error) {
    console.error("Change password error:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

module.exports = router;
