// routes/Accountant_Routes/Acc_forecastCashLedgerConfig.js
//
// CHUNK 1-D — which ledgers count as operating cash for the forecast.
//
//   GET   /   ?companyId=…  — candidates, their suggested/selected roles, and
//                             the opening cash the current selection produces
//   PATCH /                 — save the selection
//
// ── WHAT THIS NEVER DOES ────────────────────────────────────────────────────
// It writes exactly one collection: `Acc_ForecastCashLedgerConfig`. It never
// writes a voucher, a ledger, a bill term or a recurring item — it records a
// CHOICE about which existing ledgers to read, and changes none of them.
//
// Balances are recomputed from posted vouchers on every read. Nothing here
// caches a cash figure; a stale one is precisely the failure the rest of this
// module refuses to keep.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const Acc_ForecastCashLedgerConfig = require("../../models/Accountant_model/Acc_ForecastCashLedgerConfig");
const configService = require("../../services/forecastCashLedgerConfig.service");
const forecast = require("../../services/cashFlowForecastOrchestrator.service");

router.use(accountantAuth);

function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/* ------------------------------------------------------------------ */
/* GET /                                                    READ ONLY  */
/* ------------------------------------------------------------------ */
router.get("/", async (req, res) => {
  try {
    const cid = castId(req.query.companyId);
    if (!cid) {
      return res.status(400).json({ error: "companyId required.", code: "INVALID_COMPANY" });
    }

    const [config, ledgers] = await Promise.all([
      Acc_ForecastCashLedgerConfig.findOne({ companyId: cid }).lean(),
      forecast.resolveCashLedgers(cid),
    ]);

    // Balances come from posted vouchers, per ledger, at read time.
    const balances = await forecast.balancesByCashLedger(cid, ledgers);
    const withBalances = ledgers.map((l) => ({
      _id: l._id,
      name: l.name,
      groupName: l.groupName,
      balance: balances.get(String(l._id)) ?? 0,
    }));

    const candidates = configService.buildCandidates(withBalances, config);

    // The opening cash the CURRENT selection produces — suggestion or saved,
    // whichever is in force — so a person sees the consequence of the choice
    // in front of them rather than having to go and look at the forecast.
    const includedIds = candidates
      .filter((c) => c.selectedRole === configService.ROLE.INCLUDED)
      .map((c) => c.ledgerId);
    const odIds = candidates
      .filter((c) => c.selectedRole === configService.ROLE.OD)
      .map((c) => c.ledgerId);

    const sumOf = (ids) =>
      ids.reduce((s, id) => s + (balances.get(String(id)) || 0), 0);

    res.json({
      ok: true,
      status: config ? "saved" : "suggested_default",
      config: config
        ? {
            includedLedgerIds: (config.includedLedgerIds || []).map(String),
            excludedLedgerIds: (config.excludedLedgerIds || []).map(String),
            odLedgerIds: (config.odLedgerIds || []).map(String),
            notes: config.notes || "",
            updatedByName: config.updatedByName || null,
            updatedAt: config.updatedAt || null,
          }
        : null,
      candidates,
      openingCash: Math.round(sumOf(includedIds) * 100) / 100,
      // Reported separately and NEVER added to cash: an OD balance is money
      // owed, and netting it into "cash on hand" misstates both.
      odBalance: odIds.length > 0 ? Math.round(sumOf(odIds) * 100) / 100 : null,
    });
  } catch (e) {
    console.error("[forecast-cash-ledger-config GET]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* PATCH /                                                             */
/* ------------------------------------------------------------------ */
router.patch("/", async (req, res) => {
  try {
    if (!configService.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    let built;
    try {
      built = configService.buildUpdate(req.body, {
        id: req.user?.id,
        name: req.user?.name || req.user?.email,
      });
    } catch (e) {
      if (e instanceof configService.ForecastCashLedgerConfigError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    const cid = castId(built.scope.companyId);
    if (!cid) {
      return res.status(400).json({ error: "Invalid companyId.", code: "INVALID_COMPANY" });
    }

    // ── Every named ledger must be a cash/bank/OD ledger OF THIS COMPANY ────
    // Two failures this closes at once: naming another company's ledger (a
    // cross-tenant read of its balances through the back door), and naming a
    // perfectly ordinary ledger of this company — a debtor, an expense head —
    // which would quietly add a non-cash balance to "cash on hand".
    const named = [
      ...built.$set.includedLedgerIds,
      ...built.$set.excludedLedgerIds,
      ...built.$set.odLedgerIds,
    ];

    if (named.length > 0) {
      const allowed = await forecast.resolveCashLedgers(cid);
      const allowedIds = new Set(allowed.map((l) => String(l._id)));
      const rejected = named.filter((id) => !allowedIds.has(String(id)));
      if (rejected.length > 0) {
        return res.status(400).json({
          error:
            "Every ledger must be a cash, bank or OD ledger belonging to this company. " +
            `Refused: ${rejected.join(", ")}.`,
          code: "LEDGER_NOT_ELIGIBLE",
        });
      }
    }

    // Unique per company, so this is an upsert on `companyId` — one company,
    // one answer to "what counts as our cash".
    const saved = await Acc_ForecastCashLedgerConfig.findOneAndUpdate(
      { companyId: cid },
      { $set: built.$set, $setOnInsert: { companyId: cid } },
      { new: true, upsert: true, runValidators: true },
    ).lean();

    res.json({
      ok: true,
      status: "saved",
      config: {
        includedLedgerIds: (saved.includedLedgerIds || []).map(String),
        excludedLedgerIds: (saved.excludedLedgerIds || []).map(String),
        odLedgerIds: (saved.odLedgerIds || []).map(String),
        notes: saved.notes || "",
        updatedByName: saved.updatedByName || null,
        updatedAt: saved.updatedAt || null,
      },
    });
  } catch (e) {
    console.error("[forecast-cash-ledger-config PATCH]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
