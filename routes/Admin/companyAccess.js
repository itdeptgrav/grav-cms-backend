"use strict";

const express = require("express");
const access = require("../../services/companyContext/companyAccess.service");  // list() only

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

/* GAC-2: company-scoped grants are retired. GRAV Clothing is the only
   organisation; application access is granted through PUT /api/admin/app-access
   (person + application + role + reason + idempotency key). The GET above stays
   as a read-only view of legacy companyGrants for the GAC-5 conversion review.
   Nothing is written here any more. */
router.put("/", (_req, res) => {
  res.status(410).json({
    success: false,
    code: "COMPANY_SCOPED_ACCESS_RETIRED",
    message: "Company-scoped access has been retired. Grant the application role in Access Control instead.",
  });
});

module.exports = router;
