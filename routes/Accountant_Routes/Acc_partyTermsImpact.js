// routes/Accountant_Routes/Acc_partyTermsImpact.js
//
// CHUNK 1-F — the focused party credit-terms cleanup workflow.
//
//   GET  /                 — parties ranked by how much of the forecast their
//                            blanket-default dates distort. READ ONLY.
//   POST /preview          — what changing one party's terms would do. WRITES
//                            NOTHING, by construction: it never calls a write.
//   POST /apply            — do it, explicitly and confirmably.
//
// ── HOW APPLY IS BUILT, AND WHY THAT SHAPE ──────────────────────────────────
// Apply composes TWO EXISTING SAFE PATHS and adds no new write logic of its
// own:
//
//   1. `creditTerms.buildUpdate` — the same whitelisted credit-terms service
//      the Parties screen writes through. NOT a broad ledger update: the
//      returned `$set` is assembled field by field, so nothing but
//      `creditPeriodDays` and its provenance can reach the document.
//   2. `billTermsBackfillOrchestrator.applyPlan`, narrowed to this one ledger.
//
// (2) is safe because C0-F's planner already handles exactly this case: once
// the party has its own terms, a stored sidecar row derived from the company
// default no longer matches what current terms derive, so the planner
// re-proposes it — while a MANUAL row is protected at the same rung and never
// re-evaluated. Re-implementing sidecar writing here would have duplicated
// that protection, the confirmation-token machinery and rollback-by-runId;
// composing keeps one implementation of each.
//
// ── WHAT NEVER HAPPENS ──────────────────────────────────────────────────────
// No posted voucher is written. No due date is rewritten as a side effect of
// editing terms — the preview shows the change first and apply is a separate,
// confirmed act. Rows with a manual expected date are refused, not quietly
// moved; see the service for why that is a real semantic change.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");
const { accountantAuth } = require("../../Middlewear/AccountantAuthMiddleware");
const { Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const creditTerms = require("../../services/creditTerms.service");
const openItems = require("../../services/openItems.service");
const backfill = require("../../services/billTermsBackfillOrchestrator.service");
const forecastOrch = require("../../services/cashFlowForecastOrchestrator.service");
const impact = require("../../services/partyTermsImpact.service");
// Chunk 1-G extracted the Mongo-touching analysis here so the action center
// can reuse it — one answer to "which rung dated this bill", not two.
const partyOrch = require("../../services/partyTermsImpactOrchestrator.service");

router.use(accountantAuth);

function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/* ------------------------------------------------------------------ */
/* GET /                                       ANALYSIS — READ ONLY    */
/* ------------------------------------------------------------------ */
router.get("/", async (req, res) => {
  try {
    const cid = castId(req.query.companyId);
    if (!cid) {
      return res.status(400).json({ error: "companyId required.", code: "INVALID_COMPANY" });
    }
    // The aggregation itself lives in the shared orchestrator so Chunk 1-G's
    // action center ranks the same parties this screen does.
    const parties = await partyOrch.analyseParties(cid);
    res.json({ ok: true, companyId: String(cid), parties });
  } catch (e) {
    console.error("[party-terms-impact GET]", e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * A fingerprint of exactly what an apply would change, so the apply endpoint
 * can refuse a plan the person did not actually see. Recomputed fresh at
 * apply time — the only way to hold the right token is to have previewed.
 */
function previewToken({ ledgerId, proposedDays, rows }) {
  const canonical = rows
    .filter((r) => r.canRecalculate)
    .map((r) => `${r.billName}|${r.proposedDueDate.toISOString()}`)
    .sort()
    .join("\n");
  return crypto
    .createHash("sha256")
    .update(`${ledgerId}|${proposedDays}\n${canonical}`)
    .digest("hex");
}

/** Resolve + validate a party for preview/apply. Returns `{error}` or `{ledger, bills, days}`. */
async function resolveTarget(body) {
  const cid = castId(body?.companyId);
  const lid = castId(body?.ledgerId);
  if (!cid) return { error: { status: 400, code: "INVALID_COMPANY", message: "companyId required." } };
  if (!lid) return { error: { status: 400, code: "INVALID_LEDGER", message: "ledgerId required." } };

  let proposedDays;
  try {
    proposedDays = impact.parseProposedDays(body.proposedCreditPeriodDays);
  } catch (e) {
    if (e instanceof impact.PartyTermsImpactError) {
      return { error: { status: 400, code: e.code, message: e.message } };
    }
    throw e;
  }

  // Scoped by `{_id, companyId}` together, and further restricted to party
  // ledgers — the same set the backfill and forecast operate on. Another
  // company's ledger, or a non-party ledger, resolves to nothing.
  const [ledger] = await backfill.resolvePartyLedgers(cid, [lid]);
  if (!ledger) {
    return {
      error: { status: 404, code: "PARTY_NOT_FOUND", message: "No such party ledger in this company." },
    };
  }

  const { bills } = await partyOrch.loadEnrichedBills(cid, [lid]);
  return { cid, lid, ledger, bills, proposedDays };
}

/* ------------------------------------------------------------------ */
/* POST /preview                                          WRITES NOTHING */
/* ------------------------------------------------------------------ */
router.post("/preview", async (req, res) => {
  try {
    const t = await resolveTarget(req.body || {});
    if (t.error) return res.status(t.error.status).json({ error: t.error.message, code: t.error.code });

    const { rows, totals } = impact.buildPreview({ bills: t.bills, proposedDays: t.proposedDays });
    const storedDays = t.ledger.creditPeriodDays;

    res.json({
      ok: true,
      ledgerId: String(t.lid),
      ledgerName: t.ledger.name,
      currentCreditPeriodDays: creditTerms.isTermSet(storedDays) ? storedDays : null,
      proposedCreditPeriodDays: t.proposedDays,
      rows,
      totals,
      confirmationToken: previewToken({
        ledgerId: String(t.lid),
        proposedDays: t.proposedDays,
        rows,
      }),
    });
  } catch (e) {
    console.error("[party-terms-impact preview]", e);
    res.status(500).json({ error: e.message });
  }
});

/* ------------------------------------------------------------------ */
/* POST /apply                                                         */
/* ------------------------------------------------------------------ */
router.post("/apply", async (req, res) => {
  try {
    if (!creditTerms.canEditTerms(req.user)) {
      return res.status(403).json({
        error: "Your accounting role is read-only, so this change was not saved.",
      });
    }

    const t = await resolveTarget(req.body || {});
    if (t.error) return res.status(t.error.status).json({ error: t.error.message, code: t.error.code });

    const { confirmationToken } = req.body || {};
    if (!confirmationToken) {
      return res.status(400).json({
        error: "confirmationToken required — call preview first and pass back the token it returns.",
        code: "CONFIRMATION_REQUIRED",
      });
    }

    // The token is checked against a FRESH preview. If anything moved since
    // the person looked — a voucher posted, a manual override added — the
    // apply refuses rather than writing against a stale picture.
    const fresh = impact.buildPreview({ bills: t.bills, proposedDays: t.proposedDays });
    const expected = previewToken({
      ledgerId: String(t.lid),
      proposedDays: t.proposedDays,
      rows: fresh.rows,
    });
    if (expected !== confirmationToken) {
      return res.status(409).json({
        error: "This preview no longer matches the current data. Preview again and retry.",
        code: "STALE_PREVIEW",
      });
    }

    // ── 1. The party's terms, through the whitelisted credit-terms path ────
    // `buildUpdate` assembles its `$set` field by field, so this cannot become
    // a broad ledger update however the body is shaped.
    const update = creditTerms.buildUpdate(
      { creditPeriodDays: t.proposedDays },
      { id: req.user?.id, name: req.user?.name || req.user?.email },
      new Date(),
    );
    const savedLedger = await Acc_Ledger.findOneAndUpdate(
      { _id: t.lid, companyId: t.cid },
      { $set: update },
      {
        new: true,
        runValidators: true,
        fields: "_id name creditPeriodDays creditTermsSource creditTermsUpdatedByName",
      },
    ).lean();
    if (!savedLedger) {
      return res.status(404).json({ error: "Party not found.", code: "PARTY_NOT_FOUND" });
    }

    // ── 2. Recalculate the sidecar, through C0-F's own apply ───────────────
    // Narrowed to this ledger. The planner decides what moves: rows derived
    // from the company default no longer match and are re-proposed, while
    // MANUAL rows are protected at that same rung and never re-evaluated.
    // Its own confirmation token is computed from the freshly recomputed plan.
    const plan = await backfill.buildPlan({ companyId: t.cid, ledgerIds: [t.lid] });
    const applied = await backfill.applyPlan({
      companyId: t.cid,
      ledgerIds: [t.lid],
      confirmationToken: plan.confirmationToken,
      actor: { id: req.user?.id, name: req.user?.name || req.user?.email },
    });

    res.json({
      ok: true,
      ledgerId: String(t.lid),
      ledgerName: savedLedger.name,
      creditPeriodDays: savedLedger.creditPeriodDays,
      recalculated: {
        written: applied.written || 0,
        unchanged: applied.unchanged || 0,
        // A manual row reaching the write loop is already impossible — the
        // planner filters it out first — so this should be 0. Reported anyway,
        // because a non-zero value would mean something is wrong upstream.
        skippedManual: applied.skippedManual || 0,
        blockedCount: applied.blockedCount || 0,
        // The rollback key for exactly this recalculation.
        backfillRunId: applied.backfillRunId || null,
      },
      // What the apply deliberately did NOT touch.
      protected: {
        manualSidecar: fresh.rows.filter((r) => r.blockedReason === impact.BLOCKED.MANUAL_SIDECAR).length,
        manualExpectedDate: fresh.rows.filter(
          (r) => r.blockedReason === impact.BLOCKED.MANUAL_EXPECTED_DATE,
        ).length,
      },
    });
  } catch (e) {
    if (e instanceof creditTerms.CreditTermsError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    console.error("[party-terms-impact apply]", e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
