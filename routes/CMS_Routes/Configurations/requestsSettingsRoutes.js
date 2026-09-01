// routes/CMS_Routes/Configurations/requestsSettingsRoutes.js
//
// GET/PUT the Requests-system-wide switches — currently just
// `mrfBudgetEnabled`. See models/CMS_Models/Configurations/RequestsSettings.js
// for why this exists and what the switch actually changes.
//
// GET is open to any authenticated CMS session: Store's fulfilment screen and
// the CEO settings page both need to read it, and the value itself is not
// sensitive — it is the same fact everyone using MRF is meant to see reflected
// in the screen anyway ("conversation with revenue team shouldn't showcase
// here"). PUT is CEO-only, mirroring the inline `ceoAuth` pattern used by
// routes/CEO_Routes/overview.js — this repo does not centralise that check,
// so route files that need it each declare it the same way.
"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const { readToken } = require("../../../config/jwt");

const RequestsSettings = require("../../../models/CMS_Models/Configurations/RequestsSettings");

function ceoAuth(req, res, next) {
  try {
    const token = readToken(req);
    if (!token) return res.status(401).json({ success: false, message: "Auth required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["ceo", "admin"].includes(d.role)) {
      return res.status(403).json({ success: false, message: "CEO access required" });
    }
    req.ceoUser = d;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired session" });
  }
}

/** GET / — read the current switches. */
router.get("/", async (req, res) => {
  try {
    const doc = await RequestsSettings.get();
    res.json({
      success: true,
      settings: {
        mrfBudgetEnabled: doc.mrfBudgetEnabled !== false,
        updatedByName: doc.updatedByName || "",
        note: doc.note || "",
        updatedAt: doc.updatedAt || null,
      },
    });
  } catch (err) {
    console.error("[requestsSettings] get failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

/** PUT / — flip a switch. CEO only. */
router.put("/", ceoAuth, async (req, res) => {
  try {
    const { mrfBudgetEnabled, note } = req.body || {};
    const doc = await RequestsSettings.get();

    if (mrfBudgetEnabled !== undefined) doc.mrfBudgetEnabled = Boolean(mrfBudgetEnabled);
    if (note !== undefined) doc.note = String(note || "").trim().slice(0, 500);
    doc.updatedByName = req.ceoUser?.name || req.ceoUser?.email || "";
    doc.updatedByRef = req.ceoUser?.id || null;

    await doc.save();

    res.json({
      success: true,
      settings: {
        mrfBudgetEnabled: doc.mrfBudgetEnabled !== false,
        updatedByName: doc.updatedByName || "",
        note: doc.note || "",
        updatedAt: doc.updatedAt || null,
      },
    });
  } catch (err) {
    console.error("[requestsSettings] update failed:", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
