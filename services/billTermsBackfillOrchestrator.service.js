/**
 * GRAV-CMS-BACKEND/services/billTermsBackfillOrchestrator.service.js
 *
 * The Mongo-touching half of C0-F's backfill. Resolves which ledgers/bills
 * are in scope, fetches the terms the pure planner
 * (billTermsBackfillPlanner.service.js) needs, and — for apply/rollback only
 * — writes to `Acc_BillTerms`. This file never touches `Acc_Voucher` for a
 * write, and never touches `ledgerEntries.billAllocations` at all.
 *
 * ── COMPANY SCOPING — FAIL CLOSED ────────────────────────────────────────
 * Every function here requires a valid `companyId`. A missing or malformed
 * one returns an empty result rather than falling through to an unscoped
 * query — the same rule `openItems.service.js#fetchAllocationRows` and
 * `voucherDueDateDefault.service.js` were both hardened to after the same
 * class of gap was found in each. This file is written to that standard
 * from the start rather than needing a second correction pass.
 */

const crypto = require("crypto");
const mongoose = require("mongoose");
const { Acc_Company, Acc_Ledger } = require("../models/Accountant_model/Acc_MasterModels");
const Acc_BillTerms = require("../models/Accountant_model/Acc_BillTerms");
const openItems = require("./openItems.service");
const planner = require("./billTermsBackfillPlanner.service");

/** Cast to ObjectId, or null. Never throws. Mirrors openItems.service.js#castId. */
function castId(v) {
  if (!v) return null;
  if (v instanceof mongoose.Types.ObjectId) return v;
  const s = String(v);
  return mongoose.Types.ObjectId.isValid(s) ? new mongoose.Types.ObjectId(s) : null;
}

/**
 * Party ledgers for a company — Sundry Debtors / Sundry Creditors, by the
 * same `groupName` heuristic the (now-migrated) ledger-detail statement used
 * before C0-D, so "which ledgers are open items even computed for" stays
 * consistent with the rest of C0.
 *
 * Company-scoped, fail-closed: a missing/malformed `companyId` returns [].
 * When `ledgerIds` is supplied, it further NARROWS to that set — but the
 * `companyId` filter is always applied too, so a ledger id belonging to a
 * different company can never sneak into scope by being named explicitly.
 */
async function resolvePartyLedgers(companyId, ledgerIds) {
  const cid = castId(companyId);
  if (!cid) return [];

  const filter = {
    companyId: cid,
    groupName: { $regex: /sundry\s+(debtor|creditor)/i },
  };
  if (Array.isArray(ledgerIds) && ledgerIds.length > 0) {
    const ids = ledgerIds.map(castId).filter(Boolean);
    if (ids.length === 0) return [];
    filter._id = { $in: ids };
  }

  return Acc_Ledger.find(filter).select("_id name groupName creditPeriodDays").lean();
}

/** The company's default credit days, or null if unset/company not found. */
async function fetchCompanyDefaultCreditDays(companyId) {
  const cid = castId(companyId);
  if (!cid) return null;
  const company = await Acc_Company.findById(cid).select("defaultCreditDays").lean();
  return company ? company.defaultCreditDays ?? null : null;
}

/**
 * The full stored `Acc_BillTerms` row for every bill already backfilled in
 * this company, keyed `${ledgerId}||${billName}` — the FULL row, not just a
 * marker that one exists. The planner needs `dueDate`, `source`,
 * `creditDaysUsed` and `isManual` to decide whether a sidecar row still
 * matches what current terms would derive, is a protected manual override,
 * or has gone stale and needs a genuine re-derivation. A bare existence
 * check cannot answer any of those three questions.
 */
async function fetchExistingBillTerms(companyId, ledgerIds) {
  const cid = castId(companyId);
  if (!cid) return new Map();
  const filter = { companyId: cid };
  if (ledgerIds && ledgerIds.length) filter.ledgerId = { $in: ledgerIds };
  const rows = await Acc_BillTerms.find(filter)
    // `backfillRunId` is not used by the planner — it is carried for the
    // Chunk 1-B forecast drilldown, which shows a finance user WHICH backfill
    // run produced a derived due date. Additive: the planner ignores it, and
    // a second query purely to fetch one more field on the same documents
    // would be waste.
    .select(
      "ledgerId billName dueDate source creditDaysUsed basisDate isManual backfillRunId " +
        // Chunk 1-C forecast fields — read-only here, consumed by the
        // cash-flow forecast. The planner ignores them.
        "forecastExpectedDate forecastExpectedDateNotes forecastExpectedDateUpdatedByName",
    )
    .lean();
  return new Map(
    rows.map((r) => [
      `${r.ledgerId}||${r.billName}`,
      {
        dueDate: r.dueDate,
        source: r.source,
        creditDaysUsed: r.creditDaysUsed,
        basisDate: r.basisDate,
        isManual: !!r.isManual,
        backfillRunId: r.backfillRunId || null,
        forecastExpectedDate: r.forecastExpectedDate || null,
        forecastExpectedDateNotes: r.forecastExpectedDateNotes || "",
        forecastExpectedDateUpdatedByName: r.forecastExpectedDateUpdatedByName || null,
      },
    ]),
  );
}

/**
 * Build a fresh backfill plan for a company. Read-only — this function,
 * transitively, never writes anything.
 *
 * @param {object} opts
 * @param {*} opts.companyId — required; a missing/malformed value produces
 *   an empty, zero-coverage plan rather than an unscoped one
 * @param {Array} [opts.ledgerIds] — optional narrowing to specific party
 *   ledgers; omitted means every Sundry Debtor/Creditor ledger in the company
 */
async function buildPlan({ companyId, ledgerIds } = {}) {
  const cid = castId(companyId);
  if (!cid) {
    const empty = planner.planBackfill([]);
    return { ...empty, companyId: null, companyDefaultCreditDays: null, confirmationToken: computeConfirmationToken(empty) };
  }

  const ledgers = await resolvePartyLedgers(cid, ledgerIds);
  const ledgerObjectIds = ledgers.map((l) => l._id);

  const [bills, companyDefaultCreditDays, existingBillTermsByKey] = await Promise.all([
    openItems.billsByLedger(cid, ledgerObjectIds),
    fetchCompanyDefaultCreditDays(cid),
    fetchExistingBillTerms(cid, ledgerObjectIds),
  ]);

  const partyCreditDaysByLedgerId = new Map(
    ledgers.map((l) => [String(l._id), l.creditPeriodDays]),
  );

  const plan = planner.planBackfill([...bills.values()], {
    partyCreditDaysByLedgerId,
    companyDefaultCreditDays,
    existingBillTermsByKey,
  });

  return {
    ...plan,
    companyId: String(cid),
    companyDefaultCreditDays,
    confirmationToken: computeConfirmationToken(plan),
  };
}

/**
 * A deterministic fingerprint of the rows a plan WOULD write. Recomputed
 * fresh at apply time and compared against the token the caller supplies —
 * a mismatch means the underlying data moved since the caller last called
 * preview (a new voucher posted, terms edited), and apply refuses rather
 * than writing against a stale picture. This is the "explicit confirmation"
 * the apply endpoint requires: the only way to produce the right token is
 * to have actually asked for a fresh plan.
 */
function computeConfirmationToken(plan) {
  const canonical = plan.toApply
    .map((r) => `${r.key}|${r.source}|${r.creditDaysUsed}|${r.proposedDueDate.toISOString()}`)
    .sort()
    .join("\n");
  return crypto.createHash("sha256").update(canonical).digest("hex");
}

/**
 * Apply a backfill run: write `Acc_BillTerms` for every `to_apply` row in a
 * FRESHLY recomputed plan, IF the caller's `confirmationToken` matches it.
 *
 * ── WHAT THIS NEVER DOES ──────────────────────────────────────────────────
 *   - Never writes `Acc_Voucher` — this function never even requires that
 *     model.
 *   - Never writes `ledgerEntries.billAllocations` — same reason.
 *   - Never writes a `blocked` row. A bill this cannot honestly date stays
 *     undated; that is the correct outcome, not a partial failure.
 *   - Never overwrites a row where `isManual: true` — a human's own
 *     override always outranks an automated re-run.
 *
 * ── IDEMPOTENT, AND PRECISE ABOUT WHOSE RUN A ROW BELONGS TO ────────────────
 * Every write is an upsert on the model's own unique key
 * `{ companyId, ledgerId, billName }` — re-running the identical apply twice
 * can never create a duplicate document. But "no duplicates" alone is not
 * enough: a row whose stored `dueDate`/`source`/`creditDaysUsed` already
 * matches what this run would produce is left ENTIRELY UNTOUCHED — not
 * re-written with the same values. Blindly re-stamping every row's
 * `backfillRunId` on every apply would make the SAME row silently belong to
 * whichever run happened to run most recently, which corrupts the one thing
 * rollback promises: "deletes only what THAT run created." A truly identical
 * re-run therefore writes nothing at all; see `unchanged` in the return
 * value.
 *
 * @param {object} opts
 * @param {*} opts.companyId
 * @param {Array} [opts.ledgerIds]
 * @param {string} opts.confirmationToken — must match a freshly recomputed
 *   plan's token, or the whole call refuses with `code: "STALE_PLAN"`
 * @param {object} [opts.actor] — `{ id, name }`, for provenance
 */
async function applyPlan({ companyId, ledgerIds, confirmationToken, actor = {} } = {}) {
  const cid = castId(companyId);
  if (!cid) {
    return { ok: false, code: "INVALID_COMPANY", message: "companyId required." };
  }
  if (!confirmationToken) {
    return { ok: false, code: "CONFIRMATION_REQUIRED", message: "confirmationToken required." };
  }

  const fresh = await buildPlan({ companyId: cid, ledgerIds });
  if (fresh.confirmationToken !== confirmationToken) {
    return {
      ok: false,
      code: "STALE_PLAN",
      message: "This plan no longer matches the current data. Refresh preview and try again.",
    };
  }

  if (fresh.toApply.length === 0) {
    return {
      ok: true,
      backfillRunId: null,
      written: 0,
      unchanged: 0,
      skippedManual: 0,
      blockedCount: fresh.totals.blockedCount,
      coverage: fresh.coverage,
    };
  }

  const backfillRunId = new mongoose.Types.ObjectId();
  let written = 0;
  let unchanged = 0;
  let skippedManual = 0;

  for (const row of fresh.toApply) {
    const existing = await Acc_BillTerms.findOne({
      companyId: cid,
      ledgerId: row.ledgerId,
      billName: row.billName,
    })
      .select("isManual dueDate source creditDaysUsed")
      .lean();

    if (existing && existing.isManual) {
      skippedManual += 1;
      continue; // a human's own override is never silently overwritten by a re-run
    }

    // ── SKIP A TRUE NO-OP, DON'T JUST DEDUPE ────────────────────────────
    // A blanket upsert on every row in the plan — even ones whose value
    // hasn't changed since a PRIOR run — would silently reclaim their
    // `backfillRunId` onto THIS run. Idempotent then means only "no
    // duplicate documents", while quietly breaking the guarantee rollback
    // depends on: "deletes only what THAT run created". If a re-run of an
    // unchanged plan touched every row's provenance, rolling back the most
    // RECENT run would delete dates that run never actually produced.
    // So: identical value in, identical value already stored → skip the
    // write entirely. `backfillRunId` and `updatedAt` stay with whichever
    // run's apply last genuinely changed this row.
    if (
      existing &&
      existing.dueDate &&
      new Date(existing.dueDate).getTime() === row.proposedDueDate.getTime() &&
      existing.source === row.source &&
      existing.creditDaysUsed === row.creditDaysUsed
    ) {
      unchanged += 1;
      continue;
    }

    await Acc_BillTerms.findOneAndUpdate(
      { companyId: cid, ledgerId: row.ledgerId, billName: row.billName },
      {
        $set: {
          dueDate: row.proposedDueDate,
          source: row.source,
          creditDaysUsed: row.creditDaysUsed,
          basisDate: row.firstVoucherDate,
          backfillRunId,
          isManual: false,
          updatedBy: actor.id || null,
          updatedByName: actor.name || null,
        },
        $setOnInsert: {
          companyId: cid,
          ledgerId: row.ledgerId,
          billName: row.billName,
          createdBy: actor.id || null,
          createdByName: actor.name || null,
        },
      },
      { upsert: true, runValidators: true },
    );
    written += 1;
  }

  return {
    ok: true,
    // Every row this run's write actually created or changed. Genuinely
    // idempotent re-runs report 0 here (see `unchanged`) — the count is not
    // "how many rows the plan contains", it's "how many this call touched".
    backfillRunId: String(backfillRunId),
    written,
    unchanged, // already correctly dated by an earlier run; not re-stamped
    skippedManual,
    blockedCount: fresh.totals.blockedCount,
    coverage: {
      before: fresh.coverage.before,
      after: fresh.coverage.after, // the coverage the FRESH plan already projects post-apply
    },
  };
}

/**
 * Undo one backfill run. Deletes only the `Acc_BillTerms` rows that run
 * created, identified purely by `backfillRunId` — never touches a row from
 * any other run, never touches a manual override (those never carry a
 * `backfillRunId`), never touches `Acc_Voucher`.
 */
async function rollbackRun({ companyId, backfillRunId } = {}) {
  const cid = castId(companyId);
  const runId = castId(backfillRunId);
  if (!cid || !runId) {
    return { ok: false, code: "INVALID_INPUT", message: "companyId and backfillRunId required.", deletedCount: 0 };
  }
  const result = await Acc_BillTerms.deleteMany({ companyId: cid, backfillRunId: runId });
  return { ok: true, deletedCount: result.deletedCount || 0 };
}

module.exports = {
  castId,
  resolvePartyLedgers,
  fetchCompanyDefaultCreditDays,
  fetchExistingBillTerms,
  buildPlan,
  computeConfirmationToken,
  applyPlan,
  rollbackRun,
};
