// routes/CMS_Routes/Sales/crmLookups.js  →  /api/cms/crm/lookups
//
// Controlled reference values for the CRM (account roles, statuses, tiers,
// relationship types + inverse labels, site/address/contact/activity enums).
// Reads from the persisted CRMLookup collection when it has been seeded, and
// falls back to constants/crm.js so the endpoint works before the seed runs.
// This is what the Step-02 frontend consumes for its dropdowns.
const express = require("express");
const router = express.Router();
const CrmLookup = require("../../../models/CMS_Models/Sales/CrmLookup");
const salesAuth = require("../../../Middlewear/SalesAuthMiddlewear");
const { LOOKUP_CATEGORIES } = require("../../../constants/crm");

// GET /api/cms/crm/lookups?category=account_role  (or all when omitted)
router.get("/", salesAuth, async (req, res) => {
  try {
    const { category } = req.query;

    // Prefer the seeded collection; fall back to constants if empty.
    const dbFilter = { isActive: true };
    if (category) dbFilter.category = category;
    const rows = await CrmLookup.find(dbFilter).sort({ category: 1, sortOrder: 1 }).lean();

    let grouped;
    if (rows.length) {
      grouped = {};
      for (const r of rows) {
        (grouped[r.category] ||= []).push({ code: r.code, label: r.label, ...(r.meta || {}) });
      }
    } else {
      grouped = category
        ? { [category]: LOOKUP_CATEGORIES[category] || [] }
        : { ...LOOKUP_CATEGORIES };
    }

    res.json({ success: true, source: rows.length ? "db" : "constants", lookups: category ? grouped[category] || [] : grouped });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
