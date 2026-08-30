// routes/Accountant_Routes/Acc_cashFlowForecast.js
//
// CHUNK 1-A — the Base cash-flow forecast's HTTP surface.
//
// One endpoint, read-only:
//   GET /  ?companyId=…&horizon=30&asOfDate=YYYY-MM-DD
//
// All decisions live in the two services this file calls
// (cashFlowForecast.service.js — pure; cashFlowForecastOrchestrator
// .service.js — the Mongo-touching half). This file is transport: parse,
// authenticate, delegate, shape.
//
// ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────
// It writes nothing at all. There is no POST, PUT, PATCH or DELETE here, and
// no service it calls performs a write. It does not mutate vouchers, bill
// terms, recurring items, ledgers or any accounting master — a forecast is a
// reading of the books, not an entry in them.
//
// Base scenario only. No Best/Worst, no confidence bands, no alerts, no
// what-if overlay, no forecast-vs-actual, no export. Those are later chunks
// and are deliberately absent rather than stubbed.

const express = require("express");
const router = express.Router();
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const forecast = require("../../services/cashFlowForecastOrchestrator.service");
const Acc_RecurringItem = require("../../models/Accountant_model/Acc_RecurringItem");
const partyOrch = require("../../services/partyTermsImpactOrchestrator.service");
const actionCenter = require("../../services/cashFlowForecastActionCenter.service");

router.use(accountantAuth);

/* ------------------------------------------------------------------ */
/* GET /                                                    READ ONLY  */
/* ------------------------------------------------------------------ */
router.get("/", async (req, res) => {
  try {
    const { companyId, horizon, asOfDate, groupBy, layer } = req.query;

    // Fail closed BEFORE any query is built. A missing companyId must never
    // fall through to an unscoped read of every company's cash position.
    if (!companyId) {
      return res.status(400).json({ error: "companyId required.", code: "INVALID_COMPANY" });
    }

    /* `layer` decides how much beyond real accounting documents the forecast
       reaches: confirmed only, plus finance-approved commitments, or plus the
       remaining budget plan. An unrecognised value falls back to the default
       rather than refusing — a forecast that will not draw because of a query
       string is worse than one that draws the usual view. The answer always
       says which layer it is. */
    const result = await forecast.buildForecast({ companyId, horizon, asOfDate, groupBy, layer });

    if (!result.ok) {
      const status = result.code === "COMPANY_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    res.json(result);
  } catch (e) {
    console.error("[cash-flow-forecast]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* GET /action-center                          CHUNK 1-G — READ ONLY   */
/* ------------------------------------------------------------------ */
//
// A guidance layer: what to clean up first, and where to go to do it. It
// composes three existing read-only sources — the forecast itself, the party
// impact analysis, and a recurring-items count — and adds no analysis of its
// own beyond ranking them.
//
// It recommends nowhere to look, never what the answer is: no credit-days
// figure, no expected date, no ledger selection. Every action carries an
// `href` to an existing workflow where a person supplies the value.
router.get("/action-center", async (req, res) => {
  try {
    const { companyId, horizon, asOfDate } = req.query;
    if (!companyId) {
      return res.status(400).json({ error: "companyId required.", code: "INVALID_COMPANY" });
    }

    // Same validation the forecast itself applies — the action center reads
    // the forecast, so an input the forecast would refuse must be refused here
    // too rather than silently answered from a different horizon.
    const result = await forecast.buildForecast({ companyId, horizon, asOfDate });
    if (!result.ok) {
      const status = result.code === "COMPANY_NOT_FOUND" ? 404 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    const cid = forecast.castId(companyId);
    const [parties, recurringRows] = await Promise.all([
      partyOrch.analyseParties(cid),
      Acc_RecurringItem.find({ companyId: cid, status: "active" }).select("type").lean(),
    ]);

    res.json({
      ok: true,
      ...actionCenter.buildActionCenter({
        companyId: String(cid),
        asOfDate: result.asOfDate,
        horizonDays: result.horizonDays,
        forecast: result,
        parties,
        recurring: {
          activeCount: recurringRows.length,
          typesPresent: [...new Set(recurringRows.map((r) => r.type))],
        },
      }),
    });
  } catch (e) {
    console.error("[cash-flow-forecast/action-center]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
