// routes/Accountant_Routes/Acc_settings.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Settings,
  ActivityLog,
} = require("../../models/Accountant_model/Acc_OperationalModels");

router.use(AccountantAuthMiddleware.accountantAuth);

// GET settings
router.get("/", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    res.json({ success: true, settings });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error fetching settings" });
  }
});

// UPDATE settings
router.put("/", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const data = req.body;
    data.updatedBy = req.user.id;

    Object.keys(data).forEach((key) => {
      settings[key] = data[key];
    });

    await settings.save();

    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Updated settings",
      module: "settings",
      details: `Updated accountant settings`,
    });

    res.json({ success: true, message: "Settings updated", settings });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error updating settings" });
  }
});

// ADD bank account
router.post("/bank-accounts", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const bankAccount = req.body;

    if (bankAccount.isDefault) {
      settings.bankAccounts.forEach((acc) => (acc.isDefault = false));
    }

    settings.bankAccounts.push(bankAccount);
    await settings.save();

    res.json({
      success: true,
      message: "Bank account added",
      bankAccounts: settings.bankAccounts,
    });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error adding bank account" });
  }
});

// REMOVE bank account
router.delete("/bank-accounts/:index", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const index = parseInt(req.params.index);

    if (index < 0 || index >= settings.bankAccounts.length) {
      return res.status(400).json({ success: false, message: "Invalid index" });
    }

    settings.bankAccounts.splice(index, 1);
    await settings.save();

    res.json({ success: true, message: "Bank account removed" });
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Error removing bank account" });
  }
});

// UPDATE bank account at index — used for in-place edits
router.put("/bank-accounts/:index", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const index = parseInt(req.params.index, 10);

    if (
      Number.isNaN(index) ||
      index < 0 ||
      index >= settings.bankAccounts.length
    ) {
      return res.status(400).json({ success: false, message: "Invalid index" });
    }

    const updated = req.body || {};
    // Only allow known fields to be updated; ignore stray keys
    const allowed = [
      "bankName",
      "accountNumber",
      "ifscCode",
      "branchName",
      "accountType",
      "isDefault",
    ];
    const next = {
      ...(settings.bankAccounts[index].toObject?.() ??
        settings.bankAccounts[index]),
    };
    for (const key of allowed) {
      if (updated[key] !== undefined) next[key] = updated[key];
    }

    // If being marked default, unset others
    if (next.isDefault) {
      settings.bankAccounts.forEach((acc, i) => {
        if (i !== index) acc.isDefault = false;
      });
    }

    settings.bankAccounts[index] = next;
    settings.markModified("bankAccounts");
    await settings.save();

    res.json({
      success: true,
      message: "Bank account updated",
      bankAccounts: settings.bankAccounts,
    });
  } catch (error) {
    console.error("Error updating bank account:", error);
    res
      .status(500)
      .json({ success: false, message: "Error updating bank account" });
  }
});

module.exports = router;
