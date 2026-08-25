// routes/CMS_Routes/Sales/crmSettings.js
const express = require("express");
const router = express.Router();
const CRMSettings = require("../../../models/CMS_Models/Sales/CRMSettings");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");

// GET /api/cms/crm/settings
router.get("/", salesAuth, async (req, res) => {
  try {
    const settings = await CRMSettings.getSingleton();
    res.json({ success: true, settings });
  } catch (err) {
    console.error("[crm-settings] GET /", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// PATCH /api/cms/crm/settings
router.patch("/", salesAuth, async (req, res) => {
  try {
    let settings = await CRMSettings.findOne();
    if (!settings) settings = new CRMSettings();

    // Merge top-level fields from req.body
    const allowed = [
      "leadStages",
      "leadSources",
      "industries",
      "callOutcomes",
      "callTypes",
      "priorities",
      "contactTypes",
      "accountTypes",
      "accountRatings",
      "activityTypes",
      "workingHoursStart",
      "workingHoursEnd",
      "workingDays",
      "calendarDefaultView",
      "callReminderMinutes",
      "missedCallThresholdMinutes",
      "tagPool",
      "lostReasons",
      "productInterestOptions",
    ];

    // Nested, so it cannot ride the flat allow-list above. Merged rather than
    // replaced: sending only `marginFloorPct` must not blank a sibling setting
    // added here later.
    if (req.body?.commercial && typeof req.body.commercial === "object") {
      const markup = Number(req.body.commercial.markupPct);
      if (Number.isFinite(markup) && markup >= 0 && markup <= 500) {
        settings.commercial = { ...(settings.commercial?.toObject?.() || settings.commercial || {}), markupPct: markup };
      }
    }

    allowed.forEach((key) => {
      if (req.body[key] !== undefined) settings[key] = req.body[key];
    });

    await settings.save();
    res.json({ success: true, settings });
  } catch (err) {
    console.error("[crm-settings] PATCH /", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

module.exports = router;