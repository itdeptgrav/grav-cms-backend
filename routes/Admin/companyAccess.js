"use strict";

const express = require("express");
const access = require("../../services/companyContext/companyAccess.service");

// Mounted by accessAdmin, which is itself guarded by requirePlatformAdmin.
const router = express.Router();

router.get("/", async (_req, res) => {
  try {
    res.json({ success: true, ...(await access.list()) });
  } catch (err) {
    console.error("[company-access] list failed:", err);
    res.status(503).json({ success: false, code: "ACCESS_UNAVAILABLE", message: "Company access could not be checked just now." });
  }
});

router.put("/", async (req, res) => {
  try {
    const out = await access.change({ ...req.body, actor: req.admin });
    res.json({ success: true, grant: out });
  } catch (err) {
    if (!err.status) console.error("[company-access] change failed:", err);
    res.status(err.status || (err.code === 11000 ? 409 : 503)).json({
      success: false,
      code: err.code === 11000 ? "GRANT_CONFLICT" : (err.code || "ACCESS_UNAVAILABLE"),
      message: err.status ? err.message : "Company access could not be changed just now.",
    });
  }
});

module.exports = router;
