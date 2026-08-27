// routes/Accountant_Routes/Acc_billTerms.js
//
// C0-F — the historical due-date backfill's HTTP surface.
//
// Three endpoints, three jobs, one strict boundary:
//   GET  /backfill/preview  — read-only. Never writes anything.
//   POST /backfill/apply    — writes ONLY Acc_BillTerms, and only the rows
//                             the freshest possible plan says can be dated
//                             honestly. Never touches Acc_Voucher or
//                             billAllocations.
//   POST /backfill/rollback — deletes ONLY the Acc_BillTerms rows one named
//                             run created. Never touches vouchers.
//
// All business logic lives in the two services this file calls
// (billTermsBackfillPlanner.service.js — pure; billTermsBackfillOrchestrator
// .service.js — the Mongo-touching half). This file is transport: parse the
// request, check permission, call the service, shape the response.

const express = require("express");
const router = express.Router();
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const creditTerms = require("../../services/creditTerms.service");
const backfill = require("../../services/billTermsBackfillOrchestrator.service");

const auth = accountantAuth;
router.use(auth);

/** `ledgerIds` may arrive as a comma-separated query string or a JSON body array. */
function parseLedgerIds(raw) {
  if (!raw) return undefined;
  if (Array.isArray(raw)) return raw;
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/* ------------------------------------------------------------------ */
/* GET /backfill/preview                                    READ ONLY  */
/* ------------------------------------------------------------------ */
router.get("/backfill/preview", async (req, res) => {
  try {
    const { companyId } = req.query;
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }
    const ledgerIds = parseLedgerIds(req.query.ledgerIds);
    const plan = await backfill.buildPlan({ companyId, ledgerIds });
    res.json({ ok: true, ...plan });
  } catch (e) {
    console.error("[bill-terms/backfill/preview]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /backfill/apply                                                */
/* ------------------------------------------------------------------ */
router.post("/backfill/apply", async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const { companyId, confirmationToken, ledgerIds } = req.body || {};
    if (!companyId) {
      return res.status(400).json({ error: "companyId required." });
    }
    if (!confirmationToken) {
      return res.status(400).json({
        error: "confirmationToken required — call preview first and pass back the token it returns.",
      });
    }

    const result = await backfill.applyPlan({
      companyId,
      ledgerIds: parseLedgerIds(ledgerIds),
      confirmationToken,
      actor: { id: req.user?.id, name: req.user?.name || req.user?.email },
    });

    if (!result.ok) {
      const status = result.code === "STALE_PLAN" ? 409 : 400;
      return res.status(status).json({ error: result.message, code: result.code });
    }

    res.json(result);
  } catch (e) {
    console.error("[bill-terms/backfill/apply]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /backfill/rollback                                             */
/* ------------------------------------------------------------------ */
router.post("/backfill/rollback", async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const { companyId, backfillRunId } = req.body || {};
    if (!companyId || !backfillRunId) {
      return res.status(400).json({ error: "companyId and backfillRunId required." });
    }

    const result = await backfill.rollbackRun({ companyId, backfillRunId });
    if (!result.ok) {
      return res.status(400).json({ error: result.message, code: result.code });
    }
    res.json(result);
  } catch (e) {
    console.error("[bill-terms/backfill/rollback]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* CHUNK 1-C — MANUAL FORECAST EXPECTED DATE                           */
/* ------------------------------------------------------------------ */
//
// PATCH  /forecast-expected-date   — record when an overdue bill is expected
// DELETE /forecast-expected-date   — withdraw that expectation
//
// ── WHAT THESE DO NOT TOUCH ─────────────────────────────────────────────────
// `dueDate` is the contractual/accounting date and is NEVER written by either
// endpoint — the `$set` comes from `forecastExpectedDate.service.js`, whose
// whitelist contains only `forecastExpectedDate*` fields, and a pure test
// pins that. No voucher, no ledger, no other bill-terms field.
//
// ── UPDATE-ONLY, BY DESIGN ──────────────────────────────────────────────────
// Both endpoints update an EXISTING `Acc_BillTerms` row and 404 otherwise.
// They never create one. Creating a row would mean inventing values for its
// required `dueDate`, `source`, `creditDaysUsed` and `basisDate` — i.e.
// fabricating an accounting due date in order to hang a forecast note off it,
// which is precisely backwards. A bill with no sidecar row is one the backfill
// has not covered; the fix for that is to run the backfill, not to let this
// endpoint quietly manufacture accounting data. See the doc for the known
// consequence: bills dated straight from a voucher header have no sidecar row
// and therefore cannot yet take an expected date.

const mongoose = require("mongoose");
const Acc_BillTerms = require("../../models/Accountant_model/Acc_BillTerms");
const forecastExpected = require("../../services/forecastExpectedDate.service");

/** Cast to ObjectId, or null. Never throws. */
function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/** Shared shape for both responses. */
function presentForecastFields(row) {
  return {
    ledgerId: row.ledgerId,
    billName: row.billName,
    dueDate: row.dueDate, // echoed so a caller can SEE it was left alone
    forecastExpectedDate: row.forecastExpectedDate || null,
    forecastExpectedDateSource: row.forecastExpectedDateSource || null,
    forecastExpectedDateNotes: row.forecastExpectedDateNotes || "",
    forecastExpectedDateUpdatedByName: row.forecastExpectedDateUpdatedByName || null,
    forecastExpectedDateUpdatedAt: row.forecastExpectedDateUpdatedAt || null,
  };
}

/** Both endpoints resolve, scope and write identically; only the `$set` differs. */
async function applyForecastUpdate(req, res, built) {
  const companyId = castId(built.scope.companyId);
  const ledgerId = castId(built.scope.ledgerId);
  if (!companyId) return res.status(400).json({ error: "Invalid companyId.", code: "INVALID_COMPANY" });
  if (!ledgerId) return res.status(400).json({ error: "Invalid ledgerId.", code: "INVALID_LEDGER" });

  // `{companyId, ledgerId, billName}` TOGETHER — the row's own unique key, and
  // the whole of the scoping. A bill from another company matches nothing.
  const saved = await Acc_BillTerms.findOneAndUpdate(
    { companyId, ledgerId, billName: built.scope.billName },
    { $set: built.$set },
    { new: true, runValidators: true },
  ).lean();

  if (!saved) {
    return res.status(404).json({
      error: "No bill-terms row for this bill in this company.",
      code: "BILL_TERMS_NOT_FOUND",
    });
  }
  return res.json({ ok: true, billTerm: presentForecastFields(saved) });
}

router.patch("/forecast-expected-date", async (req, res) => {
  try {
    if (!forecastExpected.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    let built;
    try {
      built = forecastExpected.buildSet(
        req.body,
        { id: req.user?.id, name: req.user?.name || req.user?.email },
        new Date(),
      );
    } catch (e) {
      if (e instanceof forecastExpected.ForecastExpectedDateError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    return await applyForecastUpdate(req, res, built);
  } catch (e) {
    console.error("[bill-terms/forecast-expected-date PATCH]", e);
    res.status(500).json({ error: e.message });
  }
});

router.delete("/forecast-expected-date", async (req, res) => {
  try {
    if (!forecastExpected.canEdit(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    // A DELETE may carry its scope in the body or the query, matching the
    // convention the parties and recurring-items routes already use.
    const raw = Object.keys(req.body || {}).length > 0 ? req.body : req.query;

    let built;
    try {
      built = forecastExpected.buildClear(raw);
    } catch (e) {
      if (e instanceof forecastExpected.ForecastExpectedDateError) {
        return res.status(400).json({ error: e.message, code: e.code });
      }
      throw e;
    }

    return await applyForecastUpdate(req, res, built);
  } catch (e) {
    console.error("[bill-terms/forecast-expected-date DELETE]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
