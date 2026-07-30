// routes/CMS_Routes/Inventory/Operations/storeSettingsRoutes.js
// Mount: app.use("/api/cms/inventory/store-settings", storeSettingsRoutes)
//
// The address/contact block that Store PDFs print. One singleton document; see
// the model for why.

const express = require("express");
const router = express.Router();
const StoreSettings = require("../../../../models/CMS_Models/Inventory/Operations/StoreSettings");
const EmployeeAuth = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuth);

// Only these are writable. `key`, timestamps and the updated-by stamp are set
// by the server, so a caller cannot spoof who changed the letterhead or create
// a second settings document by posting a different key.
const FIELDS = [
  "storeName",
  "addressLine1", "addressLine2", "city", "state", "country", "pincode",
  "phone", "altPhone", "email", "gstin",
  "website", "contactPerson", "extraLine",
];

const actorName = (req) =>
  req.user?.name ||
  [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") ||
  "Store";

router.get("/", async (req, res) => {
  try {
    const settings = await StoreSettings.get();
    res.json({ success: true, settings });
  } catch (err) {
    console.error("[store-settings] GET failed:", err);
    res.status(500).json({ success: false, message: "Failed to load store settings" });
  }
});

router.put("/", async (req, res) => {
  try {
    const body = req.body || {};
    const update = {};
    for (const f of FIELDS) {
      // Only fields actually present are touched, so a partial save from one
      // section of the form cannot silently blank the rest.
      if (Object.prototype.hasOwnProperty.call(body, f)) {
        update[f] = String(body[f] ?? "").trim();
      }
    }

    if (update.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(update.email)) {
      return res.status(400).json({ success: false, message: "That email address is not valid" });
    }

    update.updatedByRef = req.user?._id || req.user?.id || null;
    update.updatedByName = actorName(req);

    // Ensure the singleton exists before updating it.
    await StoreSettings.get();
    const settings = await StoreSettings.findOneAndUpdate(
      { key: "store" },
      { $set: update },
      { new: true, runValidators: true }
    );

    res.json({ success: true, settings, message: "Store details saved" });
  } catch (err) {
    console.error("[store-settings] PUT failed:", err);
    res.status(500).json({ success: false, message: "Failed to save store settings" });
  }
});

module.exports = router;
