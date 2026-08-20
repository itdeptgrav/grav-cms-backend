// services/productionView.js
//
// Work orders → the production picture a salesperson can act on.
//
// EVERYTHING HERE IS COUNTED, NOT ESTIMATED. GRAV tracks every garment
// individually: WorkOrder.productionCompletion.operationCompletion[] carries
// `completedUnitNumbers` — the actual unit numbers that have cleared each
// operation — so "168 finished" is the length of a list, not a percentage
// somebody typed. That is what makes the numbers below worth putting in front
// of a customer.
//
// THE SHAPE OF THE DATA DECIDES THE SHAPE OF THE SCREEN:
//
//   one WorkOrder  = one style × one size (variantAttributes) × a quantity
//   operationCompletion[] = how many of that WO's pieces are past each operation
//   timeMetrics[]         = measured avg seconds per unit, per operation
//   invalidScans[]        = the scans that did not make sense, with reasons
//
// So the per-size matrix is not a pivot anyone has to compute — it is one row
// per work order. And the forecast is arithmetic on measured seconds rather
// than a typed "forecast" date.
//
// WHAT IS DELIBERATELY ABSENT: a cumulative-flow / burn-up curve. That needs a
// daily snapshot of how many pieces were past each operation on each past day,
// and nothing stores one — ProductionCompletionScanRecord is keyed by date but
// its scans carry only a barcodeId, with no work-order attribution. Drawing the
// curve would mean inventing history. `trend: null` says so, and a small daily
// rollup would make it real later.
"use strict";

const SECONDS_PER_HOUR = 3600;


// ── Pace and dates ───────────────────────────────────────────────────────────
//
// A DATE NEEDS A CALENDAR, so the calendar is stated rather than hidden: eight
// working hours a day, Sundays off. Change these two constants and every
// projected date on the screen moves with them — no other arithmetic assumes a
// shift length.
const HOURS_PER_DAY = 8;
const WORKS_ON_SUNDAY = false;

/** Add `n` working days to a date, skipping Sundays. */
function addWorkingDays(from, n) {
  const d = new Date(from);
  let left = Math.ceil(n);
  while (left > 0) {
    d.setDate(d.getDate() + 1);
    if (WORKS_ON_SUNDAY || d.getDay() !== 0) left -= 1;
  }
  return d;
}

/** Working days between two dates, excluding the start, including the end. */
function workingDaysBetween(from, to) {
  const a = new Date(from); const b = new Date(to);
  if (b <= a) return 0;
  let n = 0;
  const d = new Date(a);
  while (d < b) {
    d.setDate(d.getDate() + 1);
    if (WORKS_ON_SUNDAY || d.getDay() !== 0) n += 1;
  }
  return n;
}

/**
 * Bottleneck arithmetic: the constraint sets the rate for the whole line, so
 * throughput is one piece per its measured seconds. Summing every operation's
 * remaining seconds would assume nothing runs in parallel and badly overstate;
 * taking only the constraint's own queue understates. This is the standard
 * middle and it is the one a factory would recognise.
 */
function project({ constraintSeconds, remaining, now, deadline }) {
  if (!constraintSeconds || constraintSeconds <= 0 || remaining <= 0) return null;
  const perDay = (HOURS_PER_DAY * SECONDS_PER_HOUR) / constraintSeconds;
  const daysNeeded = remaining / perDay;
  const projectedEnd = addWorkingDays(now, daysNeeded);

  const daysAvailable = deadline ? workingDaysBetween(now, deadline) : null;
  const requiredPerDay = daysAvailable && daysAvailable > 0 ? remaining / daysAvailable : null;

  return {
    perDay: +perDay.toFixed(1),
    daysNeeded: +daysNeeded.toFixed(1),
    projectedEnd,
    requiredPerDay: requiredPerDay != null ? +requiredPerDay.toFixed(1) : null,
    // 1.0 means exactly on pace. Below 1 is late, above 1 is ahead — the one
    // number the dial needs.
    paceRatio: requiredPerDay ? +(perDay / requiredPerDay).toFixed(2) : null,
    workingDaysAvailable: daysAvailable,
    daysLate: deadline ? workingDaysBetween(deadline, projectedEnd) : null,
    hoursPerDay: HOURS_PER_DAY,
    worksSunday: WORKS_ON_SUNDAY,
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** A work order's size, read off its variant attributes. */
function sizeOf(wo) {
  const attrs = wo.variantAttributes || [];
  const size = attrs.find((a) => /size/i.test(a?.name || ""));
  if (size?.value) return String(size.value);
  // No attribute named "size" — show whatever does distinguish this variant
  // rather than an empty column.
  return attrs.map((a) => a?.value).filter(Boolean).join(" / ") || "—";
}

/**
 * The operations this order runs, in order, aggregated across its work orders.
 *
 * Work orders can carry different operation sets (a style with printing has an
 * extra one), so they are unioned by operationNumber and each work order only
 * contributes to the operations it actually has.
 */
function collectOperations(workOrders) {
  const byNumber = new Map();
  for (const wo of workOrders) {
    const comp = wo.productionCompletion || {};
    const metrics = comp.timeMetrics || [];
    for (const op of comp.operationCompletion || []) {
      const n = num(op.operationNumber);
      if (!byNumber.has(n)) {
        byNumber.set(n, {
          number: n,
          type: op.operationType || op.operationCode || `Operation ${n}`,
          code: op.operationCode || "",
          reached: 0,
          total: 0,
          avgSecondsWeighted: 0,
          avgSecondsUnits: 0,
        });
      }
      const acc = byNumber.get(n);
      // completedUnitNumbers is the piece-level truth; completedQuantity is its
      // length. Prefer the list and fall back, so a work order that only ever
      // synced the count is still counted rather than dropped.
      const done = Array.isArray(op.completedUnitNumbers) && op.completedUnitNumbers.length
        ? op.completedUnitNumbers.length
        : num(op.completedQuantity);
      acc.reached += done;
      acc.total += num(op.totalQuantity) || num(wo.quantity);

      const m = metrics.find((x) => num(x.operationNumber) === n);
      if (m && num(m.avgCompletionTimeSeconds) > 0) {
        const units = num(m.totalUnitsAnalyzed) || 1;
        acc.avgSecondsWeighted += num(m.avgCompletionTimeSeconds) * units;
        acc.avgSecondsUnits += units;
      }
    }
  }
  return [...byNumber.values()].sort((a, b) => a.number - b.number);
}

/**
 * Work orders → the whole view model.
 *
 * @param {object[]} workOrders — lean WorkOrder docs for one customer request.
 * @param {Date} [now]
 */
function buildProductionView(workOrders = [], now = new Date()) {
  const orders = workOrders.filter(Boolean);
  const quantity = orders.reduce((s, wo) => s + num(wo.quantity), 0);

  const ops = collectOperations(orders);

  // WIP is the gap between consecutive operations. The first operation's
  // upstream is the order itself — pieces not yet cut have not started.
  let upstream = quantity;
  const operations = ops.map((op) => {
    const waiting = Math.max(0, upstream - op.reached);
    const avgSeconds = op.avgSecondsUnits > 0
      ? op.avgSecondsWeighted / op.avgSecondsUnits
      : null;
    upstream = op.reached;
    return {
      number: op.number,
      type: op.type,
      code: op.code,
      reached: op.reached,
      total: op.total || quantity,
      pct: (op.total || quantity) > 0 ? Math.round((op.reached / (op.total || quantity)) * 100) : 0,
      waiting,
      avgSeconds: avgSeconds != null ? Math.round(avgSeconds) : null,
      // One stream, measured rate. Stated as an assumption on the screen rather
      // than dressed up as a promise — two lines running halves it.
      clearsHours: avgSeconds != null ? +( (waiting * avgSeconds) / SECONDS_PER_HOUR ).toFixed(1) : null,
    };
  });

  const lastOp = operations[operations.length - 1] || null;
  const completed = lastOp ? lastOp.reached : 0;

  // The binding constraint: whichever operation needs the most hours to clear
  // what is queued in front of it. Everything downstream of it is starved, so
  // the order cannot finish sooner than that however fast the rest run.
  const constraint = operations
    .filter((o) => o.clearsHours != null && o.waiting > 0)
    .sort((a, b) => b.clearsHours - a.clearsHours)[0] || null;

  // ── The per-size matrix. One row per work order — no pivot needed. ────────
  const lines = orders.map((wo) => {
    const comp = wo.productionCompletion || {};
    const byNumber = new Map(
      (comp.operationCompletion || []).map((op) => {
        const done = Array.isArray(op.completedUnitNumbers) && op.completedUnitNumbers.length
          ? op.completedUnitNumbers.length
          : num(op.completedQuantity);
        return [num(op.operationNumber), done];
      }),
    );
    const qty = num(wo.quantity);
    const cells = operations.map((op) => byNumber.get(op.number) ?? 0);
    const firstReached = cells.length ? cells[0] : 0;
    return {
      workOrderId: String(wo._id || ""),
      workOrderNumber: wo.workOrderNumber || "",
      style: wo.stockItemName || wo.stockItemReference || "—",
      size: sizeOf(wo),
      quantity: qty,
      status: wo.status || "pending",
      deadline: wo.assignedDeadline || null,
      cells,
      completed: cells.length ? cells[cells.length - 1] : 0,
      // What is queued in front of the FIRST operation of this line — the
      // clearest per-size signal of "this size has not started".
      queue: Math.max(0, qty - firstReached),
      lastSyncedAt: comp.lastSyncedAt || null,
    };
  }).sort((a, b) => a.style.localeCompare(b.style) || a.size.localeCompare(b.size));

  // ── Exceptions, from the scan ledger rather than from anyone's judgement ──
  const reasons = new Map();
  let invalidTotal = 0;
  let latestInvalid = null;
  for (const wo of orders) {
    for (const s of wo.productionCompletion?.invalidScans || []) {
      const key = s.reason || "other";
      reasons.set(key, (reasons.get(key) || 0) + 1);
      invalidTotal += 1;
      const t = s.timestamp ? new Date(s.timestamp) : null;
      if (t && (!latestInvalid || t > latestInvalid)) latestInvalid = t;
    }
  }

  // A line that has been released but has produced nothing is a different
  // problem from a line running slowly, and only the first one needs chasing.
  const notStarted = lines.filter((l) => l.completed === 0 && l.quantity > 0);

  const syncTimes = orders
    .map((wo) => wo.productionCompletion?.lastSyncedAt)
    .filter(Boolean)
    .map((d) => new Date(d));
  const lastSyncedAt = syncTimes.length ? new Date(Math.max(...syncTimes)) : null;

  const deadlines = orders.map((wo) => wo.assignedDeadline).filter(Boolean).map((d) => new Date(d));
  const deadline = deadlines.length ? new Date(Math.min(...deadlines)) : null;

  // ── STYLE IS THE PRIMARY QUESTION for Sales (17 Aug 2026, ray). A customer
  // asks about the Gardener Shirt, not about operation 2, so the per-style
  // rollup is a first-class part of the model rather than something the screen
  // has to pivot. Sizes stay nested underneath it.
  const styleMap = new Map();
  for (const l of lines) {
    if (!styleMap.has(l.style)) {
      styleMap.set(l.style, {
        style: l.style, quantity: 0, cells: operations.map(() => 0),
        queue: 0, sizes: [], deadline: l.deadline || null,
      });
    }
    const st = styleMap.get(l.style);
    st.quantity += l.quantity;
    l.cells.forEach((v, i) => { st.cells[i] += v; });
    st.queue += l.queue;
    st.sizes.push(l);
    if (l.deadline && (!st.deadline || new Date(l.deadline) < new Date(st.deadline))) st.deadline = l.deadline;
  }

  const constraintSeconds = constraint ? (operations.find((o) => o.number === constraint.number)?.avgSeconds || 0) : 0;

  const styles = [...styleMap.values()].map((st) => {
    const done = st.cells.length ? st.cells[st.cells.length - 1] : 0;
    const remaining = Math.max(0, st.quantity - done);
    return {
      ...st,
      completed: done,
      remaining,
      pct: st.quantity > 0 ? Math.round((done / st.quantity) * 100) : 0,
      // Each style projected at the same line rate, since they share the floor.
      projection: project({ constraintSeconds, remaining, now, deadline: st.deadline }),
    };
  }).sort((a, b) => b.quantity - a.quantity);

  const projection = project({
    constraintSeconds,
    remaining: Math.max(0, quantity - completed),
    now,
    deadline,
  });

  return {
    styles,
    projection,
    totals: {
      quantity,
      completed,
      remaining: Math.max(0, quantity - completed),
      pct: quantity > 0 ? Math.round((completed / quantity) * 100) : 0,
      workOrders: orders.length,
      wip: operations.reduce((s, o) => s + o.waiting, 0),
    },
    operations,
    lines,
    constraint: constraint
      ? { number: constraint.number, type: constraint.type, waiting: constraint.waiting, hours: constraint.clearsHours }
      : null,
    // Hours of work left at the binding operation, measured. Not a date: turning
    // hours into a date needs a shift calendar, and guessing one here would be
    // the invented number this whole file exists to avoid.
    forecast: constraint
      ? { hoursToClear: constraint.hours, basis: `measured average at ${constraint.type}` }
      : null,
    exceptions: {
      invalidTotal,
      invalidByReason: [...reasons.entries()].map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
      latestInvalidAt: latestInvalid,
      notStarted: notStarted.map((l) => ({ workOrderNumber: l.workOrderNumber, style: l.style, size: l.size, quantity: l.quantity })),
    },
    // See the file header: no stored daily history to draw one from.
    trend: null,
    deadline,
    lastSyncedAt,
    now,
  };
}

module.exports = { buildProductionView, sizeOf };
