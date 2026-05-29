// routes/CMS_Routes/Sales/salesSettings.js
//
// Two endpoints — singleton pattern (one settings document per sales team):
//
//   GET  /api/cms/sales/settings  — fetch settings; auto-creates with defaults if not found
//   PATCH /api/cms/sales/settings — upsert full or partial settings

const express = require("express");
const router  = express.Router();
const SalesSettings = require("../../../models/CMS_Models/Sales/SalesSettings");
const salesAuth     = require("../../../Middlewear/SalesAuthMiddlewear");

// ─── GET /api/cms/sales/settings ─────────────────────────────────────────────
// Returns the current settings document, or creates one with defaults if none exists.
router.get("/", salesAuth, async (req, res) => {
  try {
    let settings = await SalesSettings.findOne().lean();

    if (!settings) {
      // Auto-create defaults on first access
      const doc = new SalesSettings({});
      await doc.save();
      settings = doc.toObject();
    }

    res.json({ success: true, settings });
  } catch (err) {
    console.error("[salesSettings] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── PATCH /api/cms/sales/settings ───────────────────────────────────────────
// Upserts the settings document. Accepts a partial or full body.
// All top-level fields and emailNotifications sub-fields are merged safely.
router.patch("/", salesAuth, async (req, res) => {
  try {
    const body = req.body || {};

    // Strip any attempt to change internal fields
    delete body._id;
    delete body.__v;
    delete body.createdAt;

    // Tag who last saved
    body.updatedBy     = req.user?.id;
    body.updatedByName = req.user?.name || "Sales Team";

    // Upsert — findOneAndUpdate with $set so nested emailNotifications fields
    // are merged rather than replaced entirely.
    const settings = await SalesSettings.findOneAndUpdate(
      {},                                    // match the singleton
      { $set: body },
      { new: true, upsert: true, runValidators: false }
    ).lean();

    // Invalidate the in-memory cache in the email service (if used)
    try {
      const emailSvc = require("../../../utils/salesEmailService");
      if (typeof emailSvc.invalidateCache === "function") emailSvc.invalidateCache();
    } catch (_) {}

    res.json({ success: true, message: "Settings saved successfully", settings });
  } catch (err) {
    console.error("[salesSettings] PATCH /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;