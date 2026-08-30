/**
 * services/cashFlowLayers.service.js
 *
 * THE TWO LAYERS ABOVE A CONFIRMED FORECAST.
 *
 * ── WHY THEY ARE LAYERS AND NOT LINES ───────────────────────────────────────
 * A cash-flow forecast built only from accounting documents is true and
 * incomplete: it does not know about the ₹4,00,000 finance approved last week
 * that no invoice has arrived for, and it does not know the budget says another
 * ₹6,00,000 of it is planned for next quarter. Both are real information and
 * neither is a document.
 *
 * Folding them in would make the forecast better-informed and unreadable —
 * nobody could tell which part of a number rests on an invoice and which on an
 * intention. So they stack, and each one names its own confidence:
 *
 *   confirmed   an accounting document exists          invoice, bill, voucher
 *   committed   finance approved a request, no document yet
 *   planned     the budget says so, and nothing else does
 *
 * ── THE ORDER OF PRECEDENCE, WHICH IS THE WHOLE OF THE DOUBLE-COUNT RULE ────
 * For one head, one department, one month:
 *
 *   a confirmed document wins over a commitment
 *   a commitment wins over the plan
 *   the plan fills only what is left
 *
 * ₹1,00,000 budgeted for Software in September with a ₹40,000 approved request
 * against it contributes ₹60,000 of plan, not ₹1,00,000 — otherwise the
 * scenario counts the same intention twice and reads as ₹1,40,000 of spending
 * that was only ever ₹1,00,000.
 *
 * Matched on budget line, department and month. Never on vendor, title or
 * amount: two ₹40,000 repairs in one month are an ordinary month, and a fuzzy
 * match would cancel the wrong one.
 */

"use strict";

const Commitment = require("../models/Accountant_model/Acc_BudgetCommitment");
const { Acc_Budget } = require("../models/Accountant_model/Acc_OperationalModels");
const SpendRequest = require("../models/CMS_Models/Requests/SpendRequest");
const actuals = require("./budgetActuals.service");

const LAYERS = ["confirmed", "with_commitments", "budget_scenario"];
const DEFAULT_LAYER = "with_commitments";

/** Which layer was asked for. An unknown one is the default, never an error —
 *  a forecast that refuses to draw because of a query string is worse than one
 *  that draws the usual view. */
function parseLayer(raw) {
  const v = String(raw || "").trim().toLowerCase();
  return LAYERS.includes(v) ? v : DEFAULT_LAYER;
}

const money = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};

/** "2026-09" — the month key everything below joins on. */
const monthKey = (d) => {
  const x = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(x.getTime())) return null;
  return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, "0")}`;
};

const monthStart = (key) => {
  const [y, m] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
};

/** The 15th: a month's plan is not due on its first day, and putting every
 *  planned rupee on the 1st makes twelve cliffs out of a smooth year. */
const monthMidpoint = (key) => {
  const [y, m] = String(key).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 15));
};

/* ── COMMITTED ─────────────────────────────────────────────────────────────
 * Finance-approved requests with no voucher yet.
 *
 * A released commitment is excluded and counted: released means a voucher
 * exists, and that voucher is already in the confirmed layer. Counting both
 * would be the double count this whole file exists to prevent — and it is
 * excluded by STATUS, never by looking for a voucher that resembles it. */
async function resolveCommitments(companyId, { asOf, lastDay } = {}) {
  const cid = actuals.oid(companyId);
  if (!cid) {
    return { items: [], undated: 0, undatedAmount: 0, releasedExcluded: 0, byLineMonth: new Map() };
  }

  const [live, releasedExcluded] = await Promise.all([
    Commitment.find({ companyId: cid, status: { $in: ["committed", "unbudgeted"] } })
      .select("_id spendRequestId spendRequestNumber amount expectedPaymentDate budgetLineId department ledgerId ledgerName status")
      .lean(),
    Commitment.countDocuments({ companyId: cid, status: "released" }),
  ]);

  /* Titles and vendors, for the label. One query, not one per commitment. */
  const requests = live.length
    ? await SpendRequest.find({ _id: { $in: live.map((c) => c.spendRequestId) } })
        .select("_id title vendorName requestNumber")
        .lean()
    : [];
  const byRequest = new Map(requests.map((r) => [String(r._id), r]));

  const items = [];
  /* What the plan has to subtract, keyed on line + month. */
  const byLineMonth = new Map();
  let undated = 0;
  let undatedAmount = 0;

  for (const c of live) {
    const amount = money(c.amount);
    if (amount <= 0) continue;

    const req = byRequest.get(String(c.spendRequestId));
    const when = c.expectedPaymentDate ? new Date(c.expectedPaymentDate) : null;

    if (!when || Number.isNaN(when.getTime())) {
      /* No payment date, so there is no day to place it on. Excluded from the
         forecast and REPORTED — money finance has agreed to that the forecast
         cannot show is exactly the thing a diagnostic is for. */
      undated += 1;
      undatedAmount += amount;
      continue;
    }

    /* It still reduces the plan for its month even though it is dated: the
       commitment and the plan describe the same intention. */
    if (c.budgetLineId) {
      const key = `${c.budgetLineId}||${monthKey(when)}`;
      byLineMonth.set(key, money((byLineMonth.get(key) || 0) + amount));
    }

    items.push({
      id: `commitment:${c._id}`,
      date: when,
      amount,
      direction: "outflow",
      label: `Committed spend · ${req?.title || c.spendRequestNumber || "approved request"}`,
      requestId: c.spendRequestId ? String(c.spendRequestId) : null,
      requestNumber: c.spendRequestNumber || req?.requestNumber || null,
      ledgerId: c.ledgerId ? String(c.ledgerId) : null,
      ledgerName: c.ledgerName || null,
      department: c.department || null,
      vendorName: req?.vendorName || null,
      budgetLineId: c.budgetLineId ? String(c.budgetLineId) : null,
    });
  }

  return { items, undated, undatedAmount, releasedExcluded, byLineMonth };
}

/* ── PLANNED ───────────────────────────────────────────────────────────────
 * What the budget says will move, where nothing stronger has said otherwise.
 *
 * Only FUTURE months. A month already underway has had its chance to produce a
 * document, and adding its remainder now would invent an outflow on a day
 * nothing is expected to move.
 */
async function resolvePlanned(companyId, { asOf, lastDay, committedByLineMonth } = {}) {
  const cid = actuals.oid(companyId);
  if (!cid) return { items: [], estimatedLines: 0, hasPlan: false };

  const budgets = await Acc_Budget.find({
    status: { $in: ["active", "exceeded"] },
    startDate: { $lte: lastDay },
    endDate: { $gte: asOf },
    $or: [{ companyId: cid }, { companyId: { $exists: false } }, { companyId: null }],
  })
    .select("_id name financialYear startDate endDate items")
    .lean();

  const lines = [];
  for (const b of budgets) {
    for (const item of b.items || []) {
      if (!item?.ledgerId) continue;
      if (money(item.allocatedAmount) <= 0) continue;
      lines.push({ budget: b, item });
    }
  }
  if (!lines.length) return { items: [], estimatedLines: 0, hasPlan: false };

  /* What has ALREADY been posted against each head, so a month the company has
     already paid for does not also carry its plan. Read across the whole
     budget period — the same figures the budget screens report. */
  const hydrated = await actuals.hydrateLines({
    companyId: cid,
    lines: lines.map((l) => ({ ledgerId: l.item.ledgerId, costCentreId: l.item.costCentreId || null })),
    from: lines[0].budget.startDate,
    to: lines[0].budget.endDate,
  });

  const natures = await actuals.natureByLedger(lines.map((l) => l.item.ledgerId));

  const items = [];
  let estimatedLines = 0;

  for (const [i, l] of lines.entries()) {
    const { budget, item } = l;
    const natureRaw = natures.get(String(item.ledgerId));
    const nature = (typeof natureRaw === "string" ? natureRaw : natureRaw?.nature) === "revenue"
      ? "revenue"
      : "expense";

    const allocated = money(item.allocatedAmount);
    const actual = money(hydrated[i]?.actual);

    /* ── HOW THE YEAR IS SPREAD ─────────────────────────────────────────────
       The department's own month-wise split when it gave one; an even spread
       when the line is phased evenly on purpose; and an even spread MARKED AS
       ESTIMATED when there is no phasing at all. The third is a guess and the
       screen says so — a spread nobody chose must not read like one somebody
       did. */
    let months;
    let phasingSource;
    const stored = (item.monthlyPhasing || []).filter((m) => money(m.amount) > 0);
    if (stored.length) {
      months = stored.map((m) => ({ month: m.month, amount: money(m.amount) }));
      phasingSource = item.phasingMode === "custom_monthly" ? "custom" : "even";
    } else {
      months = evenSpread(allocated, budget.startDate, budget.endDate);
      phasingSource = item.phasingMode === "even" ? "even" : "estimated_even";
      if (phasingSource === "estimated_even") estimatedLines += 1;
    }

    /* Actuals are known for the period, not per month. Spread across the
       months already gone, oldest first — money posted has to reduce SOME
       month's plan, and attributing it to months that have already happened is
       the only assignment that cannot overstate the future. */
    let actualLeft = actual;

    for (const m of months) {
      const start = monthStart(m.month);
      if (Number.isNaN(start.getTime())) continue;

      const planned = money(m.amount);
      if (planned <= 0) continue;

      const whole = monthMidpoint(m.month);
      const past = whole < asOf;

      /* Months already gone absorb the actuals and contribute nothing. */
      if (past) {
        actualLeft = money(Math.max(0, actualLeft - planned));
        continue;
      }
      if (whole > lastDay) continue;

      /* Precedence: what is posted, then what is committed, then the plan. */
      const coveredByConfirmed = money(Math.min(planned, actualLeft));
      actualLeft = money(actualLeft - coveredByConfirmed);

      const coveredByCommitted =
        nature === "expense"
          ? money(committedByLineMonth?.get(`${item._id}||${m.month}`) || 0)
          : 0;

      const remainder = money(planned - coveredByConfirmed - coveredByCommitted);
      /* Fully covered — the plan adds nothing, which is the point. */
      if (remainder <= 0) continue;

      items.push({
        id: `plan:${item._id}:${m.month}`,
        date: whole,
        amount: remainder,
        direction: nature === "revenue" ? "inflow" : "outflow",
        label: `${nature === "revenue" ? "Revenue plan" : "Budget plan"} · ${item.ledgerName || "Unnamed head"}`,
        budgetId: String(budget._id),
        budgetLineId: String(item._id),
        ledgerId: String(item.ledgerId),
        ledgerName: item.ledgerName || null,
        department: item.department || null,
        month: m.month,
        phasingSource,
        plannedForMonth: planned,
        coveredByConfirmed,
        coveredByCommitted,
      });
    }
  }

  return { items, estimatedLines, hasPlan: true };
}

/** An allocation spread evenly over the months a budget period covers. */
function evenSpread(amount, from, to) {
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [];

  const keys = [];
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    keys.push(monthKey(cursor));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  if (!keys.length) return [];

  const each = Math.floor((money(amount) / keys.length) * 100) / 100;
  return keys.map((month, i) => ({
    month,
    /* The remainder lands on the last month rather than vanishing to rounding. */
    amount: i === keys.length - 1 ? money(money(amount) - each * (keys.length - 1)) : each,
  }));
}

module.exports = {
  LAYERS,
  DEFAULT_LAYER,
  parseLayer,
  monthKey,
  evenSpread,
  resolveCommitments,
  resolvePlanned,
};
