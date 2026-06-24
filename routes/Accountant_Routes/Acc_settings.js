// routes/Accountant_Routes/Acc_settings.js
//
// Settings CRUD. The PUT handler does a careful per-section merge instead
// of a naive Object.assign so:
//   • Nested objects (address, numbering, preferences, notifications) are
//     spread-merged into the existing values, not replaced wholesale —
//     so saving just one tab doesn't blow away the others.
//   • Mongoose's strict mode still drops unknown fields, but every field
//     the Settings page sends is now defined on the schema, so nothing
//     is silently lost.
//   • `markModified` is called for each nested path so mongoose actually
//     persists the change (otherwise sub-object mutations sometimes don't
//     trigger a save).
//   • A whitelist guards against random extra keys (security + sanity).

const express = require("express");
const router = express.Router();
const AccountantAuthMiddleware = require("../../Middlewear/AccountantAuthMiddleware");
const {
  Acc_Settings,
  ActivityLog,
} = require("../../models/Accountant_model/Acc_OperationalModels");

router.use(AccountantAuthMiddleware.accountantAuth);

// Whitelisted top-level fields the Settings page is allowed to update via PUT /.
// Any other key in req.body is silently ignored. Bank-account edits go
// through their own dedicated routes (POST/PUT/DELETE /bank-accounts).
const ALLOWED_TOP_LEVEL_FIELDS = new Set([
  // Organization
  "companyName",
  "gstin",
  "pan",
  "phone",
  "email",
  "website",
  // Legacy aliases (in case something else writes them)
  "companyGSTIN",
  "companyPAN",
  "companyPhone",
  "companyEmail",
  "companyAddress",
  "companyLogo",
  // Tax
  "defaultGstRate",
  "defaultTdsRate",
  "tdsApplicable",
  "financialYearStart",
  "defaultGSTRate",
  "defaultTDSRate",
  "financialYearStartMonth",
  "gstRegistered",
  "compositionScheme",
  "currentFinancialYear",
  // Legacy flat invoice fields
  "invoicePrefix",
  "invoiceStartNumber",
  "currentInvoiceNumber",
  "invoiceTerms",
  "invoiceNotes",
  // Currency / locale (legacy flat)
  "baseCurrency",
  "currencySymbol",
]);

// Fields that are sub-objects and need a deep-merge instead of replace.
const NESTED_OBJECT_FIELDS = [
  "address",
  "numbering",
  "preferences",
  "notifications",
];

// GET settings
router.get("/", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    res.json({ success: true, settings });
  } catch (error) {
    console.error("[settings/GET]", error);
    res.status(500).json({
      success: false,
      message: "Error fetching settings",
      detail: error.message,
    });
  }
});

// UPDATE settings — per-section save (frontend sends only the fields it edits)
router.put("/", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const data = req.body || {};

    // ── 1. Apply scalar / known top-level fields ──
    for (const key of Object.keys(data)) {
      if (ALLOWED_TOP_LEVEL_FIELDS.has(key)) {
        settings[key] = data[key];
      }
    }

    // ── 2. Deep-merge nested objects ──
    // Without this step, sending `{ preferences: { currency: "USD" } }`
    // would replace the WHOLE preferences object — wiping the other
    // preferences. With it, we merge the incoming values into the
    // existing nested object and only the fields the user actually
    // changed get updated.
    for (const key of NESTED_OBJECT_FIELDS) {
      if (data[key] && typeof data[key] === "object") {
        const existing =
          settings[key] && settings[key].toObject
            ? settings[key].toObject()
            : settings[key] || {};
        settings[key] = { ...existing, ...data[key] };
        settings.markModified(key); // mongoose needs this for nested updates
      }
    }

    settings.updatedBy = req.user.id;
    await settings.save();

    // Log which sections actually changed for the activity feed.
    const changedSections = [];
    for (const key of Object.keys(data)) {
      if (
        ALLOWED_TOP_LEVEL_FIELDS.has(key) ||
        NESTED_OBJECT_FIELDS.includes(key)
      ) {
        changedSections.push(key);
      }
    }
    await ActivityLog.create({
      accountantId: req.user.id,
      action: "Updated settings",
      module: "settings",
      details: `Updated: ${changedSections.join(", ") || "(no recognized fields)"}`,
    }).catch(() => {}); // never fail the save because of a log write

    res.json({
      success: true,
      message: "Settings updated",
      settings,
      appliedKeys: changedSections,
    });
  } catch (error) {
    console.error("[settings/PUT]", error);
    res.status(500).json({
      success: false,
      message: "Error updating settings",
      detail: error.message,
    });
  }
});

// ADD bank account
router.post("/bank-accounts", async (req, res) => {
  try {
    const settings = await Acc_Settings.getSingleton();
    const bankAccount = req.body || {};

    if (bankAccount.isDefault) {
      settings.bankAccounts.forEach((acc) => (acc.isDefault = false));
    }
    settings.bankAccounts.push(bankAccount);
    settings.markModified("bankAccounts");
    await settings.save();

    res.json({
      success: true,
      message: "Bank account added",
      bankAccounts: settings.bankAccounts,
    });
  } catch (error) {
    console.error("[settings/bank-accounts POST]", error);
    res.status(500).json({
      success: false,
      message: "Error adding bank account",
      detail: error.message,
    });
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
    settings.markModified("bankAccounts");
    await settings.save();

    res.json({ success: true, message: "Bank account removed" });
  } catch (error) {
    console.error("[settings/bank-accounts DELETE]", error);
    res.status(500).json({
      success: false,
      message: "Error removing bank account",
      detail: error.message,
    });
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
    // branchName was being dropped before — schema now has it.
    const allowed = [
      "bankName",
      "accountNumber",
      "ifscCode",
      "branchName",
      "accountType",
      "isDefault",
      "upiId",
    ];
    const next = {
      ...(settings.bankAccounts[index].toObject?.() ??
        settings.bankAccounts[index]),
    };
    for (const key of allowed) {
      if (updated[key] !== undefined) next[key] = updated[key];
    }

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
    console.error("[settings/bank-accounts PUT]", error);
    res.status(500).json({
      success: false,
      message: "Error updating bank account",
      detail: error.message,
    });
  }
});

module.exports = router;
