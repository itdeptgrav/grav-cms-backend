// routes/Accountant_Routes/Acc_commandSearch.js
//
// GET /api/accountant/command-search?q=…&companyId=…
//
// Cmd/Ctrl K for the books, through the SHARED palette — the same dialog,
// rows and cards every application uses. Answered by
// services/ai/accountingCommandSearch.service.js, without a model.
//
// ── THE DOOR ──────────────────────────────────────────────────────────────
// The accounting session, not the CMS one: `accountantAuth` (canView on a
// read) and `requireCompanyScope`, which checks the companyId against the
// person's organisation before anything is read. The service is handed the
// CHECKED company and every query it makes carries it.
//
// Read-only, and exactly one route — a test holds it to that. The note the
// palette sends for a search that found nothing has its own door
// (routes/ai/commandSearchMisses.js), because it writes.
"use strict";

const express = require("express");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const accOrgAuth = require("../../Middlewear/AccountantOrgAuthMiddleware");
const commandSearch = require("../../services/ai/accountingCommandSearch.service");

/* Resolved per request, as Acc_search.js does, so a partial jest.mock of the
   middleware fails loudly rather than silently skipping the company check. */
const companyScope = (req, res, next) => accOrgAuth.requireCompanyScope(req, res, next);

const router = express.Router();

router.get("/", accountantAuth, companyScope, async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.status(400).json({ success: false, message: "A query is required." });
  if (query.length > commandSearch.MAX_QUERY) {
    return res.status(400).json({
      success: false,
      message: `That search is too long. Keep it under ${commandSearch.MAX_QUERY} characters.`,
    });
  }
  try {
    const out = await commandSearch.search({ companyId: req.companyId, query });
    /* The closed response contract the shared palette validates. */
    return res.json({
      success: true,
      state: out.state,
      note: out.note || null,
      groups: Array.isArray(out.groups) ? out.groups : [],
    });
  } catch (err) {
    console.error("[accounting command-search]", err);
    return res.status(500).json({ success: false, message: "That search could not be completed." });
  }
});

module.exports = router;
