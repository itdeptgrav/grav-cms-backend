// routes/Accountant_Routes/settings.js
const express = require("express");
const router = express.Router();
const AccountantAuthMiddlewaer = require("../../Middlewear/AccountantAuthMiddlewaer");
const { AccountantSettings, ActivityLog } = require("../../models/Accountant_model/AccountantModels");

router.use(AccountantAuthMiddlewaer.accountantAuth);

// GET settings
router.get("/", async (req, res) => {
  try {
    const settings = await AccountantSettings.getSingleton();
    res.json({ success: true, settings });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error fetching settings" });
  }
});

// UPDATE settings
router.put("/", async (req, res) => {
  try {
    const settings = await AccountantSettings.getSingleton();
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
    res.status(500).json({ success: false, message: "Error updating settings" });
  }
});

// ADD bank account
router.post("/bank-accounts", async (req, res) => {
  try {
    const settings = await AccountantSettings.getSingleton();
    const bankAccount = req.body;

    if (bankAccount.isDefault) {
      settings.bankAccounts.forEach((acc) => (acc.isDefault = false));
    }

    settings.bankAccounts.push(bankAccount);
    await settings.save();

    res.json({ success: true, message: "Bank account added", bankAccounts: settings.bankAccounts });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error adding bank account" });
  }
});

// REMOVE bank account
router.delete("/bank-accounts/:index", async (req, res) => {
  try {
    const settings = await AccountantSettings.getSingleton();
    const index = parseInt(req.params.index);

    if (index < 0 || index >= settings.bankAccounts.length) {
      return res.status(400).json({ success: false, message: "Invalid index" });
    }

    settings.bankAccounts.splice(index, 1);
    await settings.save();

    res.json({ success: true, message: "Bank account removed" });
  } catch (error) {
    res.status(500).json({ success: false, message: "Error removing bank account" });
  }
});

module.exports = router;
