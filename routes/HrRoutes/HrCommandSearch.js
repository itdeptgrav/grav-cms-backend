// routes/HrRoutes/HrCommandSearch.js
//
// GET /api/hr/command-search?q=…
//
// Cmd/Ctrl K for HR, through the SHARED palette — the same dialog, rows and
// cards every application uses. Answered by
// services/ai/hrCommandSearch.service.js, without a model.
//
// ── THE DOOR ──────────────────────────────────────────────────────────────
// HR's own: mounted under /api/hr, so `hrContract` guards it like every other
// HR route — declared in services/access/hrRouteContract.js as needing
// `hr.access`, the actor resolved from the database (never from the token's
// claims), and `req.hrAuth` set. The service is handed the actor's
// CAPABILITIES and reads only the families they cover; which families a role
// covers is HR's decision (hrCapabilities.js), not this file's.
//
// Read-only, and exactly one route — a test holds it to that. The note the
// palette sends for a search that found nothing has its own door
// (routes/ai/commandSearchMisses.js), because it writes.
"use strict";

const express = require("express");
const commandSearch = require("../../services/ai/hrCommandSearch.service");

const router = express.Router();

router.get("/", async (req, res) => {
  /* No contract decision, no answer: this route is only ever reached through
     hrContract, and a mount that skipped it must fail closed. */
  const capabilities = req.hrAuth?.actor?.capabilities;
  if (!(capabilities instanceof Set)) {
    return res.status(403).json({ success: false, state: "unauthorised", groups: [] });
  }
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.status(400).json({ success: false, message: "A query is required." });
  if (query.length > commandSearch.MAX_QUERY) {
    return res.status(400).json({
      success: false,
      message: `That search is too long. Keep it under ${commandSearch.MAX_QUERY} characters.`,
    });
  }
  try {
    const out = await commandSearch.search({ capabilities, query });
    /* The closed response contract the shared palette validates. */
    return res.json({
      success: true,
      state: out.state,
      note: out.note || null,
      groups: Array.isArray(out.groups) ? out.groups : [],
    });
  } catch (err) {
    console.error("[hr command-search]", err);
    return res.status(500).json({ success: false, message: "That search could not be completed." });
  }
});

module.exports = router;
