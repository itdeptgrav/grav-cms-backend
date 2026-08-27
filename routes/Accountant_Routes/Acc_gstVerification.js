"use strict";
/**
 * routes/Accountant_Routes/Acc_gstVerification.js
 * ───────────────────────────────────────────────────────────────────────────
 * GSTIN VERIFICATION FOR THE PARTIES IN THE BOOKS.
 *
 *   GET  /status                    is a provider configured, and what does
 *                                   the chart of accounts look like today
 *   GET  /report                    who is cancelled, missing or mismatched
 *   POST /scope                     how many calls a sweep would spend
 *   POST /ledgers/:id/verify        check one party
 *   POST /sweep                     check many, capped and priced
 *
 * Its own file rather than five more endpoints inside Acc_chartOfAccounts.js,
 * which is already four and a half thousand lines and is where the GSTIN
 * checksum spent its life unreachable by anything else.
 *
 * ── THE READS COST NOTHING; THE WRITES COST MONEY ──────────────────────────
 * `/status` and `/report` only read what has already been stored, so a
 * compliance screen can be opened as often as anybody likes. `/sweep` is the
 * only endpoint that spends, it is capped, and it reports what it actually
 * spent rather than what it looked at.
 */

const express = require("express");
const mongoose = require("mongoose");

const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");

const gstPortal = require("../../services/gstPortal.service");
const party = require("../../services/partyGstVerification.service");

const router = express.Router();

/* ── ONE GATE, APPLIED HERE, NOT ASSUMED ───────────────────────────────────
 * These endpoints read and rewrite ledgers, so they answer to the same
 * middleware the rest of the chart of accounts does — Acc_chartOfAccounts.js
 * opens with exactly this line.
 *
 * Applied explicitly rather than relying on something upstream, because
 * nothing upstream does it: server.js mounts each accountant router directly,
 * with no shared auth layer. A router that reads `req.user` without putting
 * this in front of itself is reading `undefined`. */
router.use(accountantAuth);

const companyOf = (req) => {
  const raw = req.query?.companyId || req.body?.companyId || req.user?.companyId || null;
  return mongoose.Types.ObjectId.isValid(String(raw || "")) ? String(raw) : null;
};

/* ══ GET /status ═══════════════════════════════════════════════════════════ */
router.get("/status", async (req, res) => {
  try {
    const found = await party.scope({ companyId: companyOf(req) });
    return res.json({
      success: true,
      provider: gstPortal.providerName(),
      configured: gstPortal.isConfigured(),
      hint: gstPortal.isConfigured() ? null : gstPortal.configHint(),
      partiesWithGstin: found.total,
      needChecking: found.toCheck,
    });
  } catch (err) {
    console.error("[gst-verify] GET /status:", err?.message);
    return res.status(500).json({ success: false, message: "Could not read verification status." });
  }
});

/* ══ GET /report ═══════════════════════════════════════════════════════════
 * Free to open — it reads stored verdicts and asks nobody anything.
 */
router.get("/report", async (req, res) => {
  try {
    return res.json({ success: true, ...(await party.summary({ companyId: companyOf(req) })) });
  } catch (err) {
    console.error("[gst-verify] GET /report:", err?.message);
    return res.status(500).json({ success: false, message: "Could not build the report." });
  }
});

/* ══ POST /scope ═══════════════════════════════════════════════════════════
 * What a sweep WOULD do. Nothing is checked and nothing is billed.
 *
 * Separate from /sweep on purpose: "this will make 312 calls" is something
 * somebody should be able to read BEFORE agreeing to it, not discover in the
 * result afterwards.
 */
router.post("/scope", async (req, res) => {
  try {
    const { onlyStale = true, staleDays = 90 } = req.body || {};
    const found = await party.scope({ companyId: companyOf(req), onlyStale, staleDays });
    return res.json({
      success: true,
      total: found.total,
      wouldCheck: found.toCheck,
      configured: gstPortal.isConfigured(),
      /* Cached answers inside the provider's 24h window cost nothing, so the
         real spend is at most this — said as a ceiling, not a promise. */
      atMostCalls: found.toCheck,
    });
  } catch (err) {
    console.error("[gst-verify] POST /scope:", err?.message);
    return res.status(500).json({ success: false, message: "Could not size that sweep." });
  }
});

/* ══ POST /ledgers/:id/verify ══════════════════════════════════════════════ */
router.post("/ledgers/:id/verify", async (req, res) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      return res.status(404).json({ success: false, message: "Ledger not found." });
    }
    const r = await party.verifyLedger(req.params.id, { force: !!req.body?.force });

    if (!r.ok && r.reason === "not-found") {
      return res.status(404).json({ success: false, message: "Ledger not found." });
    }
    if (!r.ok && r.reason === "no-gstin") {
      return res
        .status(400)
        .json({ success: false, message: `${r.name} has no GSTIN to check.` });
    }
    return res.json({ success: true, name: r.name, verification: r.verdict, spentCall: r.spentCall });
  } catch (err) {
    console.error("[gst-verify] POST /ledgers/:id/verify:", err?.message);
    return res.status(500).json({ success: false, message: "Could not verify that party." });
  }
});

/* ══ POST /sweep ═══════════════════════════════════════════════════════════
 * The only endpoint here that spends money.
 */
router.post("/sweep", async (req, res) => {
  try {
    if (!gstPortal.isConfigured()) {
      return res.status(409).json({
        success: false,
        message: "No GST lookup provider is configured.",
        hint: gstPortal.configHint(),
      });
    }

    const body = req.body || {};
    /* Capped twice: by whatever the caller asked for, and by a ceiling the
       caller cannot raise. A UI bug that sent limit: 100000 should cost one
       batch, not a subscription. */
    const limit = Math.min(Math.max(1, Number(body.limit) || 50), 200);

    const out = await party.verifyMany({
      companyId: companyOf(req),
      onlyStale: body.onlyStale !== false,
      staleDays: Number(body.staleDays) || 90,
      force: !!body.force,
      limit,
    });

    return res.json({ success: true, limit, ...out });
  } catch (err) {
    console.error("[gst-verify] POST /sweep:", err?.message);
    return res.status(500).json({ success: false, message: "The sweep could not be completed." });
  }
});

module.exports = router;
