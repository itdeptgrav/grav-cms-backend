// routes/CMS_Routes/Sales/salesPdfSettingsRoutes.js
// Mount: app.use("/api/cms/sales/pdf-settings", salesPdfSettingsRoutes)
//
// The address/contact block that SALES PDFs print — quotations, measurement
// purchase orders, work-order progress sheets.
//
// Shares the schema with the store letterhead but not the record: this router
// only ever touches the `key: "sales"` document, so the two modules cannot
// overwrite each other. `key` is immutable on the model, so a caller cannot
// reach the store's document by posting a different scope either.

const express = require("express");
const router = express.Router();
const ModuleSettings = require("../../../models/CMS_Models/Inventory/Operations/StoreSettings");
const EmployeeAuth = require("../../../Middlewear/EmployeeAuthMiddlewear");

const SCOPE = "sales";

router.use(EmployeeAuth);

// Server-side allowlist. `key`, timestamps and the updated-by stamp are set
// here, never accepted from the client.
const FIELDS = [
  "storeName",
  "addressLine1", "addressLine2", "city", "state", "country", "pincode",
  "phone", "altPhone", "email", "gstin",
  "website", "contactPerson", "extraLine",
];

const actorName = (req) =>
  req.user?.name ||
  [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") ||
  "Sales";

router.get("/", async (req, res) => {
  try {
    const settings = await ModuleSettings.get(SCOPE);
    res.json({ success: true, settings });
  } catch (err) {
    console.error("[sales-pdf-settings] GET failed:", err);
    res.status(500).json({ success: false, message: "Failed to load sales PDF settings" });
  }
});

router.put("/", async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    for (const f of FIELDS) {
      // Only fields actually present are touched, so a partial save cannot
      // silently blank the rest of the letterhead.
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        update[f] = String(body[f] ?? "").trim();
      }
    }

    if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) {
      return res.status(400).json({ success: false, message: "That email address is not valid" });
    }

    update.updatedByRef = req.user?._id || req.user?.id || null;
    update.updatedByName = actorName(req);

    await ModuleSettings.get(SCOPE);   // ensure the document exists
    const settings = await ModuleSettings.findOneAndUpdate(
      { key: SCOPE },
      { $set: update },
      { new: true, runValidators: true }
    );

    res.json({ success: true, settings, message: "Sales PDF details saved" });
  } catch (err) {
    console.error("[sales-pdf-settings] PUT failed:", err);
    res.status(500).json({ success: false, message: "Failed to save sales PDF settings" });
  }
});

module.exports = router;
