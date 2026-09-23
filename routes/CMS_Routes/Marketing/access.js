// routes/CMS_Routes/Marketing/access.js
//   → mounted at /api/cms/marketing, BEFORE every other Marketing router
//
//   GET /access    what this signed-in person may do in Marketing, and why not
//
// ── THE ONE PLACE A SCREEN LEARNS ITS PERMISSIONS ──────────────────────────
// The Marketing shell reads this once and shows only what the server will
// honour: no write buttons for a Viewer, no Approve for anybody but an
// administrator or the CEO, and a plain sentence — not a blank page or a bare
// 403 — for somebody whose grant or role is missing or was just revoked.
//
// It is computed by the same resolver the guard uses on every other route, so
// the two can never disagree. It changes nothing and reveals nothing beyond the
// caller's own access.
//
// ── WHY IT IS NOT BEHIND THE MARKETING GUARD ───────────────────────────────
// The guard refuses somebody with no Marketing role, which is exactly the
// person who most needs to be told why. So this route answers a refused caller
// with 200 and `allowed: false`, and only an unauthenticated or stale session
// with 401.
"use strict";

const express = require("express");

const router = express.Router();

const guard = require("../../../Middlewear/MarketingAuthMiddlewear");
const access = require("../../../services/marketing/marketingAccess");

router.get("/access", async (req, res) => {
  try {
    const resolved = await guard.accessFor(req);
    res.setHeader("Cache-Control", "private, no-store");
    if (!resolved.ok && resolved.status === 401) {
      return res.status(401).json({ success: false, code: resolved.code, message: resolved.message });
    }
    if (!resolved.ok && resolved.status >= 500) {
      return res.status(resolved.status).json({ success: false, code: resolved.code, message: resolved.message });
    }
    return res.json({ success: true, access: access.view(resolved) });
  } catch (err) {
    console.error("[marketing-access] /access failed:", err?.message);
    return res.status(503).json({ success: false, code: "MARKETING_UNAVAILABLE", message: access.REFUSALS.UNAVAILABLE.message });
  }
});

module.exports = router;
