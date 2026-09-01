// routes/CMS_Routes/Manufacturing/productionPdfSettingsRoutes.js
// Mount: app.use("/api/cms/production/pdf-settings", productionPdfSettingsRoutes)
//
// The address/contact block that PRODUCTION PDFs print — currently the
// Manufacturing Order summary sheet attached to every department notification.
//
// ── WHY PRODUCTION GETS ITS OWN SCOPE (31 Aug 2026) ─────────────────────
// services/manufacturingOrderPdf.js used to letterhead itself from the STORE
// record, because that was the only scope that existed when it was written.
// That made the Project Manager unable to change the header on their own
// document without editing the Store module's settings — a surprising place
// to find it, and a shared record two teams can silently overwrite.
//
// Same schema, same routes, different `key`. `key` is immutable on the model,
// so a caller cannot reach another module's document by posting a scope.

const express = require("express");
const router = express.Router();
const ModuleSettings = require("../../../models/CMS_Models/Inventory/Operations/StoreSettings");
const EmployeeAuth = require("../../../Middlewear/EmployeeAuthMiddlewear");

const SCOPE = "production";

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
  "Project Manager";
router.get("/", async (req, res) => {
  try {
    const settings = await ModuleSettings.get(SCOPE);
    res.json({ success: true, settings });
  } catch (err) {
    console.error("[production-pdf-settings] GET failed:", err);
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
    console.error("[production-pdf-settings] PUT failed:", err);
    res.status(500).json({ success: false, message: "Failed to save sales PDF settings" });
  }
});

module.exports = router;
