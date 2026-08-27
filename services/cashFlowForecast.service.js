/**
 * GRAV-CMS-BACKEND/services/cashFlowForecast.service.js
 *
 * CHUNK 1-A — the Base cash-flow forecast engine. PURE: no Mongo, no clock of
 * its own, no HTTP. Given already-normalised inputs — an opening cash figure,
 * dated open items, and active recurring items — it rolls cash forward one day
 * at a time across the horizon and reports where it lands.
 *
 * The Mongo-touching half (resolving cash/bank ledgers, reading posted
 * vouchers, open items and recurring items, and normalising them into this
 * function's inputs) lives in cashFlowForecastOrchestrator.service.js. Same
 * split, same reason, as creditTerms/voucherDueDateDefault and
 * billTermsBackfillPlanner/Orchestrator before it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Base scenario only. There are no scenario multipliers, no Best/Worst, no
 * confidence bands, no behavioural collection-lag model, no working-day
 * adjustment, no alerts, no what-if overlay and no forecast-vs-actual. Each of
 * those is a deliberate later chunk; none is stubbed here, because a stub that
 * returns a plausible number is indistinguishable from a real one to whoever
 * reads the screen.
 *
 * ── THE ONE JUDGEMENT CALL WORTH READING ────────────────────────────────────
 * An open item whose due date is ALREADY PAST on the as-of date is excluded
 * from the daily rows and reported in `coverage.openItemsOverdue` instead.
 *
 * The alternative — dropping every overdue receivable onto day 1 — assumes
 * money that is already late arrives today, which is the single most
 * optimistic thing a cash forecast can do and the reason forecasts lose
 * people's trust. Placing it anywhere else requires knowing how long this
 * company's overdue debts actually take to collect, which is exactly the
 * behavioural model Chunk 1-A is scoped NOT to build. So it is neither
 * guessed nor silently lost: it is excluded from the projection and counted
 * where a reader can see it, the same "undated is better than invented"
 * discipline the credit-terms and backfill slices already run on.
 */

/**
 * ── CHUNK 1-B — EXPLAINABILITY (additive only) ──────────────────────────────
 * The roll-forward above is untouched. What 1-B adds is the ability to answer
 * "why does cash move on this date, and what was left out": a per-day `items`
 * drilldown, an `inclusion` summary, a `sourceBreakdown`, and descriptive
 * `diagnostics`. None of it feeds back into a single figure the 1-A engine
 * already produced — a fixture that returned certain totals before returns
 * exactly those totals now, which its tests pin.
 *
 * The source buckets are MUTUALLY EXCLUSIVE, so they sum to the included
 * total. That matters more than matching the obvious naming: a sidecar row
 * that was derived from the company default is counted under
 * `companyDefaultDerived`, NOT under `billTermsSidecar`, because the question
 * a finance user is actually asking is "how much of this did we invent from a
 * blanket default" and burying that inside a generic "sidecar" total is
 * exactly the answer they cannot use. `billTermsSidecar` therefore holds only
 * sidecar rows a HUMAN wrote directly (`source: "manual"`). Add the three
 * together to get every sidecar row.
 */

/** Rupees, to the paisa. Float accumulation across 90 days otherwise leaks. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Machine source values, one per mutually-exclusive bucket, and the human
 * label each renders as. Kept together so the two can never drift.
 */
const SOURCE = Object.freeze({
  BILL_ALLOCATION_DUE_DATE: "bill_allocation_due_date",
  VOUCHER_DUE_DATE: "voucher_due_date",
  BILL_TERMS_MANUAL: "bill_terms_manual",
  COMPANY_DEFAULT: "company_default",
  PARTY_TERMS: "party_terms",
  RECURRING_SCHEDULE: "recurring_schedule",
  // Chunk 1-C: an overdue bill a person has said when they expect. The date
  // came from a human, not from the due-date ladder, so it is its own source.
  MANUAL_EXPECTED_DATE: "manual_expected_date",
});

const SOURCE_LABEL = Object.freeze({
  [SOURCE.BILL_ALLOCATION_DUE_DATE]: "Explicit due date",
  [SOURCE.VOUCHER_DUE_DATE]: "Voucher due date",
  [SOURCE.BILL_TERMS_MANUAL]: "Manual bill terms",
  [SOURCE.COMPANY_DEFAULT]: "Backfilled from company default",
  [SOURCE.PARTY_TERMS]: "Backfilled from party terms",
  [SOURCE.RECURRING_SCHEDULE]: "Recurring schedule",
  [SOURCE.MANUAL_EXPECTED_DATE]: "Manual expected date",
});

/** Which sources are a DERIVATION rather than a stated fact. */
const DERIVED_SOURCES = Object.freeze([SOURCE.COMPANY_DEFAULT, SOURCE.PARTY_TERMS]);

/** The `sourceBreakdown` key each source rolls up into. */
const SOURCE_BUCKET = Object.freeze({
  [SOURCE.BILL_ALLOCATION_DUE_DATE]: "explicitBillAllocationDueDate",
  [SOURCE.VOUCHER_DUE_DATE]: "voucherDueDate",
  [SOURCE.BILL_TERMS_MANUAL]: "billTermsSidecar",
  [SOURCE.COMPANY_DEFAULT]: "companyDefaultDerived",
  [SOURCE.PARTY_TERMS]: "partyTermsDerived",
  [SOURCE.RECURRING_SCHEDULE]: "recurringManual",
  [SOURCE.MANUAL_EXPECTED_DATE]: "manualExpectedDate",
});

function emptyBreakdown() {
  return {
    explicitBillAllocationDueDate: { count: 0, amount: 0 },
    voucherDueDate: { count: 0, amount: 0 },
    billTermsSidecar: { count: 0, amount: 0 },
    companyDefaultDerived: { count: 0, amount: 0 },
    partyTermsDerived: { count: 0, amount: 0 },
    recurringManual: { count: 0, amount: 0 },
    manualExpectedDate: { count: 0, amount: 0 },
  };
}

/** Whole days between two UTC midnights; negative when `d` is in the future. */
function ageInDays(d, asOf) {
  return Math.round((startOfDayUTC(asOf) - startOfDayUTC(d)) / 86400000);
}

/** The UTC calendar day of a date, as `YYYY-MM-DD`. */
function dayKey(d) {
  return new Date(d).toISOString().slice(0, 10);
}

/** Midnight UTC on the calendar day `d` falls on. */
function startOfDayUTC(d) {
  const x = new Date(d);
  return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()));
}

function addDaysUTC(d, n) {
  const x = startOfDayUTC(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}

/**
 * ── CHUNK 1-E — WEEKLY GROUPING (presentation only) ─────────────────────────
 * The engine still computes every day. Weekly rows are AGGREGATED FROM the
 * daily rows below — never recomputed from raw inputs — so the two views
 * cannot disagree: a weekly figure is arithmetic over numbers the daily table
 * already published, and a test pins that the totals match.
 */

/** Monday of the week `d` falls in, at UTC midnight. */
function startOfWeekUTC(d) {
  const x = startOfDayUTC(d);
  // getUTCDay: 0=Sun … 6=Sat. Monday-start means Sunday is 6 days into its
  // week, not 0 — the usual off-by-one in week bucketing.
  const offset = (x.getUTCDay() + 6) % 7;
  return addDaysUTC(x, -offset);
}

/** Horizons at or beyond this read better grouped than as a wall of days. */
const WEEKLY_DEFAULT_FROM_DAYS = 60;

const GROUPING = Object.freeze({ DAILY: "daily", WEEKLY: "weekly" });
const GROUPING_MODES = Object.freeze([GROUPING.DAILY, GROUPING.WEEKLY]);

/** The grouping a horizon gets when the caller does not ask for one. */
function defaultGroupingFor(horizonDays) {
  return Number(horizonDays) >= WEEKLY_DEFAULT_FROM_DAYS ? GROUPING.WEEKLY : GROUPING.DAILY;
}

/**
 * Weekly rows, aggregated from already-computed daily rows.
 *
 * `weekStart`/`weekEnd` are the FIRST and LAST day actually present in the
 * group, not the calendar Monday and Sunday. A horizon rarely starts on a
 * Monday, so the first and last weeks are partial; reporting the calendar
 * bounds would claim days the forecast does not cover.
 */
function buildWeeklyRows(rows = []) {
  if (!rows || rows.length === 0) return [];

  // Rows arrive ascending, so a Map keyed by week start comes out ascending.
  const groups = new Map();
  for (const r of rows) {
    const k = dayKey(startOfWeekUTC(r.date));
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  return [...groups.values()].map((days) => {
    const first = days[0];
    const last = days[days.length - 1];

    let inflows = 0;
    let outflows = 0;
    const sources = {
      openReceivables: 0,
      openPayables: 0,
      recurringInflows: 0,
      recurringOutflows: 0,
    };
    let items = [];
    let movingDayCount = 0;
    let minimumCash = null;
    let minimumCashDate = null;

    for (const d of days) {
      inflows += d.inflows;
      outflows += d.outflows;
      sources.openReceivables += d.sources.openReceivables;
      sources.openPayables += d.sources.openPayables;
      sources.recurringInflows += d.sources.recurringInflows;
      sources.recurringOutflows += d.sources.recurringOutflows;
      if (d.inflows > 0 || d.outflows > 0) movingDayCount += 1;
      if (d.items && d.items.length) items = items.concat(d.items);
      // Lowest daily CLOSING inside the week. Ties keep the earliest date,
      // matching how the horizon-wide minimum is chosen.
      if (minimumCash === null || d.closing < minimumCash) {
        minimumCash = d.closing;
        minimumCashDate = d.date;
      }
    }

    return {
      weekStart: first.date,
      weekEnd: last.date,
      // Opening is the week's FIRST day's opening and closing is its LAST
      // day's closing — carried through, never re-derived, so the weekly line
      // rolls forward exactly as the daily one does.
      opening: first.opening,
      closing: last.closing,
      inflows: round2(inflows),
      outflows: round2(outflows),
      netMovement: round2(inflows - outflows),
      minimumCash: round2(minimumCash),
      minimumCashDate,
      sources: {
        openReceivables: round2(sources.openReceivables),
        openPayables: round2(sources.openPayables),
        recurringInflows: round2(sources.recurringInflows),
        recurringOutflows: round2(sources.recurringOutflows),
      },
      items,
      dayCount: days.length,
      movingDayCount,
    };
  });
}

/** How many days that month has, in UTC. */
function daysInMonthUTC(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * `base` plus `months` calendar months, landing on `anchorDay` clamped to the
 * target month's length.
 *
 * ── WHY EVERY OCCURRENCE IS COMPUTED FROM THE ORIGINAL ──────────────────────
 * Callers pass an increasing `months` against a FIXED `base`, never step from
 * the previously-produced date. Stepping would let a clamp become permanent:
 * a 31st-of-the-month rule stepped one month from 31 Jan gives 28 Feb, and
 * stepping again from THAT gives 28 Mar — the classic recurring-date drift
 * bug, which silently shortens every later month in the forecast. Anchoring
 * on the rule instead yields 31 Jan → 28 Feb → 31 Mar, which is what "the
 * last day of the month" actually means.
 *
 * All arithmetic is UTC. Millisecond stepping across a DST boundary lands on
 * the wrong local calendar day; `creditTerms.resolveDueDate` was written this
 * way for the same reason.
 */
function addMonthsClampedUTC(base, months, anchorDay) {
  const b = startOfDayUTC(base);
  const targetMonthStart = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth() + months, 1));
  const y = targetMonthStart.getUTCFullYear();
  const m = targetMonthStart.getUTCMonth();
  const day = Math.min(anchorDay, daysInMonthUTC(y, m));
  return new Date(Date.UTC(y, m, day));
}

/** Parse to a real Date, or null. Guards the `new Date(null)` === epoch trap. */
function toDate(v) {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "boolean") return null;
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Every occurrence of one recurring item that falls within `[from, to]`.
 *
 * `nextDueDate` is the FIRST occurrence — taken as given, never advanced and
 * never written back. The register's stored schedule is an input to this
 * function and an input only; a forecast that mutated the thing it was reading
 * would make two consecutive runs disagree.
 *
 * `startDate` and `endDate` bound the schedule itself: an occurrence before
 * the schedule starts or after it ends is not an occurrence at all.
 *
 * @param {object} item — `{ direction, amount, frequency, dayOfMonth,
 *   nextDueDate, startDate, endDate }`
 * @param {object} window — `{ from, to }`, inclusive, UTC day boundaries
 * @returns {Date[]} occurrence dates, ascending, at UTC midnight
 */
function expandOccurrences(item, { from, to } = {}) {
  const out = [];
  if (!item) return out;

  const first = toDate(item.nextDueDate);
  const windowFrom = toDate(from);
  const windowTo = toDate(to);
  if (!first || !windowFrom || !windowTo) return out;

  const start = toDate(item.startDate);
  const end = toDate(item.endDate);

  const base = startOfDayUTC(first);
  const lo = startOfDayUTC(windowFrom);
  const hi = startOfDayUTC(windowTo);
  if (hi < lo) return out;

  // The month-day rule to anchor on. `dayOfMonth` is the register's stated
  // recurrence rule and wins when present (C0-E requires it for monthly);
  // quarterly/yearly may leave it unset, in which case the first occurrence's
  // own day is the anchor.
  const anchorDay =
    Number.isInteger(item.dayOfMonth) && item.dayOfMonth >= 1 && item.dayOfMonth <= 31
      ? item.dayOfMonth
      : base.getUTCDate();

  const step = (i) => {
    switch (item.frequency) {
      case "weekly":
        return addDaysUTC(base, 7 * i);
      case "monthly":
        return addMonthsClampedUTC(base, i, anchorDay);
      case "quarterly":
        return addMonthsClampedUTC(base, 3 * i, anchorDay);
      case "yearly":
        return addMonthsClampedUTC(base, 12 * i, anchorDay);
      default:
        return null;
    }
  };

  if (!step(0)) return out; // unknown frequency contributes nothing

  // Bounded hard rather than trusted to terminate: 90 days is the largest
  // horizon, so even a weekly schedule cannot exceed ~13 hits. The cap is a
  // runaway guard, not a business rule, and sits far above any real count.
  const MAX_ITERATIONS = 2000;

  for (let i = 0; i < MAX_ITERATIONS; i += 1) {
    const when = step(i);
    if (!when) break;
    if (when > hi) break; // schedules only move forward; nothing later can qualify
    if (when < lo) continue; // before the window — keep walking forward
    if (start && when < startOfDayUTC(start)) continue;
    if (end && when > startOfDayUTC(end)) break; // the schedule is over
    out.push(when);
  }

  return out;
}

/**
 * Build the Base forecast.
 *
 * Pure and non-mutating: nothing in `openItems` or `recurringItems` is
 * written to, and no array passed in is reordered in place.
 *
 * @param {object} input
 * @param {*} input.companyId — echoed back, not used for any lookup
 * @param {Date|string} input.asOfDate — day 1 of the projection
 * @param {number} input.horizonDays — how many daily rows to produce
 * @param {number} input.openingCash — cash on hand at the start of day 1
 * @param {Array} input.openItems — `[{ dueDate, amount, direction }]`, already
 *   filtered to items that HAVE a resolved due date. `amount` is an unsigned
 *   magnitude; `direction` is `"inflow"` (receivable) or `"outflow"` (payable).
 * @param {Array} input.recurringItems — active items from the C0-E register
 * @param {object} [input.counts] — pass-through coverage figures the
 *   orchestrator counted while reading (undated/overdue open items, etc.)
 */
function buildForecast({
  companyId = null,
  asOfDate,
  horizonDays = 30,
  openingCash = 0,
  openItems = [],
  recurringItems = [],
  counts = {},
  groupBy = null,
} = {}) {
  const asOf = startOfDayUTC(toDate(asOfDate) || new Date());
  const days = Math.max(0, Math.floor(Number(horizonDays) || 0));
  const lastDay = days > 0 ? addDaysUTC(asOf, days - 1) : asOf;

  // One bucket per calendar day in the horizon, pre-seeded so a day with no
  // activity still produces a row. A forecast with gaps in its dates is a
  // forecast nobody can read across.
  const buckets = new Map();
  for (let i = 0; i < days; i += 1) {
    const d = addDaysUTC(asOf, i);
    buckets.set(dayKey(d), {
      date: d,
      openReceivables: 0,
      openPayables: 0,
      recurringInflows: 0,
      recurringOutflows: 0,
      items: [], // Chunk 1-B drilldown; contributes to no figure above
    });
  }

  // Every item that actually landed inside the horizon, for the breakdown and
  // the diagnostics. Built alongside the buckets rather than re-derived from
  // them, so the two can never disagree.
  const includedItems = [];

  /* ── Open items ────────────────────────────────────────────────────────── */
  let openItemsIncluded = 0;
  let openItemsOverdue = 0;
  let openItemsOverdueAmount = 0;
  let openItemsBeyondHorizon = 0;
  // Chunk 1-C: the overdue bills still waiting for someone to say when they
  // expect them. Returned so the screen can offer that action against the
  // actual rows, rather than only reporting a count nobody can act on.
  const excludedOverdue = [];

  for (const item of openItems || []) {
    if (!item) continue;
    const due = toDate(item.dueDate);
    if (!due) continue; // undated items never reach here; counted by the caller

    const dueDay = startOfDayUTC(due);
    const amount = Math.abs(Number(item.amount) || 0);
    if (amount === 0) continue;

    // ── CHUNK 1-C — overdue treatment ───────────────────────────────────────
    // A bill already past its due date enters the forecast ONLY when a person
    // has recorded when they expect it. That expectation is placed on its own
    // date, never on the due date and never on day 1.
    const isOverdue = dueDay < asOf;
    const expected = toDate(item.forecastExpectedDate);
    // An expectation is only usable if it is not itself in the past. The
    // write endpoint refuses a past date, so this is a defence against a
    // stored value that has simply been overtaken by time.
    const usableExpected = expected && startOfDayUTC(expected) >= asOf ? startOfDayUTC(expected) : null;
    const day = isOverdue && usableExpected ? usableExpected : dueDay;

    if (day < asOf) {
      // Already late, and nobody has said when it will land. Excluded rather
      // than dropped onto day 1 — see the header. Counted so it stays visible.
      openItemsOverdue += 1;
      openItemsOverdueAmount += amount;
      excludedOverdue.push({
        id: item.id || `${item.ledgerId}||${item.billName}`,
        ledgerId: item.ledgerId ? String(item.ledgerId) : null,
        billName: item.billName || null,
        partyOrLedgerName: item.partyOrLedgerName || null,
        direction: item.direction === "outflow" ? "outflow" : "inflow",
        amount: round2(amount),
        dueDate: dueDay,
        ageDays: ageInDays(dueDay, asOf),
        // Present when an expectation exists but has been overtaken by time —
        // the reason this row is still excluded despite having one.
        forecastExpectedDate: expected ? startOfDayUTC(expected) : null,
        forecastExpectedDateNotes: item.forecastExpectedDateNotes || "",
      });
      continue;
    }
    if (day > lastDay) {
      // Past the horizon. Note that an overdue bill WITH an expectation
      // beyond the horizon lands here, not in the overdue bucket: it is no
      // longer a bill that is missing a date, it is one dated further out
      // than this view reaches.
      openItemsBeyondHorizon += 1;
      continue;
    }

    const bucket = buckets.get(dayKey(day));
    if (!bucket) continue;
    if (item.direction === "outflow") bucket.openPayables += amount;
    else bucket.openReceivables += amount;
    openItemsIncluded += 1;

    // ── Drilldown record. Purely descriptive; nothing below reads it back
    //    into a figure the roll-forward uses.
    // When a manual expectation is what put this bill on the calendar, THAT
    // is its forecast source — not the ladder rung its contractual due date
    // came from. The due date is still reported below, so nothing is lost.
    const placedByExpectation = isOverdue && usableExpected;
    const src = placedByExpectation ? SOURCE.MANUAL_EXPECTED_DATE : item.source || null;
    const rec = {
      id: item.id || `${item.ledgerId}||${item.billName}`,
      kind: "open_item",
      direction: item.direction === "outflow" ? "outflow" : "inflow",
      date: day,
      amount: round2(amount),
      partyOrLedgerName: item.partyOrLedgerName || null,
      billName: item.billName || null,
      voucherNumber: item.voucherNumber || null,
      source: src,
      sourceLabel: src ? SOURCE_LABEL[src] || src : null,
      derived: DERIVED_SOURCES.includes(src),
      overdue: !!isOverdue,
      // ageDays is measured from the CONTRACTUAL due date, always — it is the
      // answer to "how late is this", which an expectation does not change.
      ageDays: ageInDays(dueDay, asOf),
      backfillRunId: item.backfillRunId ? String(item.backfillRunId) : null,
      // Chunk 1-C context, present on every open item so the shape is uniform.
      dueDate: dueDay,
      forecastExpectedDate: placedByExpectation ? usableExpected : null,
      forecastDateSource: placedByExpectation ? "manual_expected_date" : null,
      forecastExpectedDateNotes: placedByExpectation ? item.forecastExpectedDateNotes || "" : "",
      forecastExpectedDateUpdatedByName: placedByExpectation
        ? item.forecastExpectedDateUpdatedByName || null
        : null,
    };
    bucket.items.push(rec);
    includedItems.push(rec);
  }

  /* ── Recurring items ───────────────────────────────────────────────────── */
  let recurringItemsIncluded = 0;
  let recurringOccurrences = 0;

  for (const item of recurringItems || []) {
    if (!item) continue;
    const amount = Math.abs(Number(item.amount) || 0);
    if (amount === 0) continue;

    const when = expandOccurrences(item, { from: asOf, to: lastDay });
    if (when.length === 0) continue;

    for (const d of when) {
      const bucket = buckets.get(dayKey(d));
      if (!bucket) continue;
      if (item.direction === "inflow") bucket.recurringInflows += amount;
      else bucket.recurringOutflows += amount;
      recurringOccurrences += 1;

      const rec = {
        // One recurring schedule can occur several times in a horizon, so the
        // id carries the occurrence date — otherwise a drilldown would show
        // the same id on four different days.
        id: `${item.id || item._id || item.name}@${dayKey(d)}`,
        kind: "recurring_item",
        direction: item.direction === "inflow" ? "inflow" : "outflow",
        date: d,
        amount: round2(amount),
        partyOrLedgerName: item.ledgerName || item.name || null,
        billName: item.name || null,
        voucherNumber: null, // a schedule has not been posted; there is no voucher
        source: SOURCE.RECURRING_SCHEDULE,
        sourceLabel: SOURCE_LABEL[SOURCE.RECURRING_SCHEDULE],
        derived: false, // a person stated this schedule; nothing was inferred
        overdue: false,
        ageDays: ageInDays(d, asOf),
        backfillRunId: null,
        // Chunk 1-C fields, null here so every drilldown row has one shape.
        // A schedule has no contractual due date and no overdue expectation.
        dueDate: null,
        forecastExpectedDate: null,
        forecastDateSource: null,
        forecastExpectedDateNotes: "",
        forecastExpectedDateUpdatedByName: null,
      };
      bucket.items.push(rec);
      includedItems.push(rec);
    }
    recurringItemsIncluded += 1;
  }

  /* ── Roll forward ──────────────────────────────────────────────────────── */
  const rows = [];
  let running = Number(openingCash) || 0;
  let totalIn = 0;
  let totalOut = 0;
  let minimumCash = null;
  let minimumCashDate = null;

  for (let i = 0; i < days; i += 1) {
    const d = addDaysUTC(asOf, i);
    const b = buckets.get(dayKey(d));

    const inflows = b.openReceivables + b.recurringInflows;
    const outflows = b.openPayables + b.recurringOutflows;
    const netMovement = inflows - outflows;

    const opening = running;
    const closing = opening + netMovement;
    running = closing;

    totalIn += inflows;
    totalOut += outflows;

    // The lowest point the projection reaches, read off the CLOSING balances
    // — the end-of-day positions the roll-forward actually produces. Ties keep
    // the EARLIEST date, because "when does cash first get this low" is the
    // question a person is asking when they read it.
    const closingRounded = round2(closing);
    if (minimumCash === null || closingRounded < minimumCash) {
      minimumCash = closingRounded;
      minimumCashDate = d;
    }

    rows.push({
      date: d,
      opening: round2(opening),
      inflows: round2(inflows),
      outflows: round2(outflows),
      netMovement: round2(netMovement),
      closing: closingRounded,
      sources: {
        openReceivables: round2(b.openReceivables),
        openPayables: round2(b.openPayables),
        recurringInflows: round2(b.recurringInflows),
        recurringOutflows: round2(b.recurringOutflows),
      },
      // Largest first, so opening a heavy day leads with what made it heavy.
      items: b.items.slice().sort((x, y) => y.amount - x.amount),
    });
  }

  /* ── Chunk 1-B: breakdown, inclusion, diagnostics ──────────────────────── */

  const sourceBreakdown = emptyBreakdown();
  for (const it of includedItems) {
    const bucketKey = SOURCE_BUCKET[it.source];
    if (!bucketKey) continue; // an unknown source is never invented into a bucket
    sourceBreakdown[bucketKey].count += 1;
    sourceBreakdown[bucketKey].amount += it.amount;
  }
  for (const k of Object.keys(sourceBreakdown)) {
    sourceBreakdown[k].amount = round2(sourceBreakdown[k].amount);
  }

  const includedOpenItemAmount = includedItems
    .filter((i) => i.kind === "open_item")
    .reduce((s, i) => s + i.amount, 0);

  const inclusion = {
    includedOpenItems: openItemsIncluded,
    includedOpenItemAmount: round2(includedOpenItemAmount),
    includedRecurringItems: recurringItemsIncluded,
    excludedUndatedOpenItems: Number(counts.openItemsUndated) || 0,
    excludedUndatedAmount: round2(Number(counts.openItemsUndatedAmount) || 0),
    excludedOverdueOpenItems: openItemsOverdue,
    excludedOverdueAmount: round2(openItemsOverdueAmount),
  };

  // ── Diagnostics: DESCRIPTIVE ONLY ───────────────────────────────────────
  // Nothing here is an alert, a threshold or a judgement. It reports what the
  // shape of the projection already is, so a person can see for themselves
  // whether a single date or a single counterparty is carrying it. Deliberately
  // neutral wording — "concentration", not "risk" or "warning" — because
  // deciding what counts as too concentrated is a later, explicit feature.
  const movementByDate = rows
    .filter((r) => r.inflows > 0 || r.outflows > 0)
    .map((r) => ({
      date: r.date,
      inflows: r.inflows,
      outflows: r.outflows,
      netMovement: r.netMovement,
      itemCount: r.items.length,
      gross: round2(r.inflows + r.outflows),
    }));

  const grossTotal = round2(totalIn + totalOut);
  const topMovementDates = movementByDate
    .slice()
    .sort((a, b) => b.gross - a.gross)
    .slice(0, 10)
    .map(({ gross, ...rest }) => rest); // `gross` was a sort key, not an output field

  const heaviest = movementByDate.slice().sort((a, b) => b.gross - a.gross)[0] || null;

  const byParty = new Map();
  for (const it of includedItems) {
    const key = `${it.partyOrLedgerName || "Unattributed"}||${it.direction}`;
    if (!byParty.has(key)) {
      byParty.set(key, { name: it.partyOrLedgerName || "Unattributed", direction: it.direction, amount: 0, count: 0 });
    }
    const p = byParty.get(key);
    p.amount += it.amount;
    p.count += 1;
  }

  const topParties = [...byParty.values()]
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)
    .map((p) => ({
      name: p.name,
      direction: p.direction,
      amount: round2(p.amount),
      count: p.count,
      shareOfMovement: grossTotal > 0 ? Number(((p.amount / grossTotal) * 100).toFixed(1)) : 0,
    }));

  const diagnostics = {
    topMovementDates,
    concentration: {
      maxDate: heaviest ? heaviest.date : null,
      maxDateAmount: heaviest ? heaviest.gross : 0,
      maxDateShareOfMovement:
        heaviest && grossTotal > 0 ? Number(((heaviest.gross / grossTotal) * 100).toFixed(1)) : 0,
      movingDays: movementByDate.length,
      horizonDays: days,
    },
    topParties,
  };

  return {
    companyId,
    asOfDate: asOf,
    horizonDays: days,
    openingCash: round2(openingCash),
    rows,
    totals: {
      inflows: round2(totalIn),
      outflows: round2(totalOut),
      netMovement: round2(totalIn - totalOut),
      closingCash: round2(running),
      // With no rows there is no projected low point; the opening figure is
      // the honest answer rather than a fabricated zero.
      minimumCash: minimumCash === null ? round2(openingCash) : minimumCash,
      minimumCashDate,
    },
    coverage: {
      openItemsIncluded,
      recurringItemsIncluded,
      // Additive detail — what the projection could NOT place, so a reader can
      // tell a quiet forecast from an empty one.
      recurringOccurrences,
      openItemsOverdue,
      openItemsOverdueAmount: round2(openItemsOverdueAmount),
      openItemsBeyondHorizon,
      openItemsUndated: Number(counts.openItemsUndated) || 0,
      openItemsTotal: Number(counts.openItemsTotal) || 0,
      recurringItemsActive: Number(counts.recurringItemsActive) || 0,
    },
    // ── Chunk 1-E — presentation grouping ──────────────────────────────────
    // `rows` above is untouched and always daily. These are aggregated FROM
    // it, so the two views cannot disagree.
    grouping: {
      mode: GROUPING_MODES.includes(groupBy) ? groupBy : defaultGroupingFor(days),
      available: [...GROUPING_MODES],
      defaultMode: defaultGroupingFor(days),
    },
    weeklyRows: buildWeeklyRows(rows),
    // ── Chunk 1-B / 1-C ────────────────────────────────────────────────────
    inclusion,
    // Oldest first: the most overdue is what someone chases first.
    excludedOverdue: excludedOverdue.slice().sort((a, b) => b.ageDays - a.ageDays),
    sourceBreakdown,
    diagnostics,
    scenario: "base",
  };
}

module.exports = {
  round2,
  dayKey,
  startOfDayUTC,
  addDaysUTC,
  addMonthsClampedUTC,
  ageInDays,
  startOfWeekUTC,
  defaultGroupingFor,
  buildWeeklyRows,
  GROUPING,
  GROUPING_MODES,
  WEEKLY_DEFAULT_FROM_DAYS,
  expandOccurrences,
  buildForecast,
  // Chunk 1-B — exported so the orchestrator tags items with the same values
  // this file buckets them by, rather than keeping a second copy of the list.
  SOURCE,
  SOURCE_LABEL,
  SOURCE_BUCKET,
  DERIVED_SOURCES,
};
