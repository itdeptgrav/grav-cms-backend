// services/maintenance/maintenanceOrderFlow.js
//
// THE MAINTENANCE JOB, AS RULES — its statuses, the one step allowed out of
// each, and the repair-time arithmetic. Pure: no database. Tested by
// maintenanceOrderFlow.test.js; the service and the screens read these tables.
//
// ── TWO KINDS OF JOB, ONE FLOW (owner, 3 Oct 2026) ──────────────────────────
// SERVICE MAINTENANCE  MSO-0001  Maintenance's own repair or service job,
//                                registered with the Store's service form.
// PRODUCT MAINTENANCE  MPO-0001  One exact existing machine or Item Master
//                                item, handed to Maintenance.
//
//   Open ──Start──▶ In progress ──Repair completed──▶ Report pending
//        ──Submit report (MR-0001)──▶ Closed
//     └──────────── Cancel (reason) ─────────▶ Cancelled
//
// ── ONE REPORT PER JOB (owner, 4 Oct 2026) ──────────────────────────────────
// A job is closed ONLY by submitting its Maintenance Report: there is no bare
// "Close" any more. "Repair completed" stops the repair clock at the moment
// the work ended (so writing the report later does not count as repair time)
// and leaves the job "Report pending" (stored DONE). The report is numbered
// MR-0001…, written once onto its own job and never changed; the machine's
// next problem is a new job with a new report.
//
// The owner asked for fewer statuses: the first version had five for a service
// job (Draft, In progress, Repair completed, Closed, Cancelled) and six for a
// product job (Created, In maintenance, Work in progress, Solved, Completed,
// Cancelled), with different words for the same idea. `LEGACY_STATUS` reads
// any of those as its new status, and scripts/migrations/
// maintenance-order-statuses.js rewrites the stored ones.
//
// ── NEVER REOPENED ──────────────────────────────────────────────────────────
// Every status moves forward only. Closed and Cancelled are final; the next
// problem on the same machine is a NEW job, so ten repairs are ten records.
"use strict";

const ORDER_TYPES = Object.freeze({ SERVICE: "service", PRODUCT: "product" });

const PREFIX = Object.freeze({ service: "MSO", product: "MPO" });

const STATUSES = Object.freeze(["OPEN", "IN_PROGRESS", "DONE", "CLOSED", "CANCELLED"]);

const STATUS_LABEL = Object.freeze({
  OPEN: "Open",
  IN_PROGRESS: "In progress",
  DONE: "Report pending",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
});

/* The first version's statuses, and what each one is now. */
const LEGACY_STATUS = Object.freeze({
  DRAFT: "OPEN",
  CREATED: "OPEN",
  IN_MAINTENANCE: "OPEN",
  WORK_IN_PROGRESS: "IN_PROGRESS",
  REPAIR_COMPLETED: "DONE",
  SOLVED: "DONE",
  COMPLETED: "CLOSED",
});

/** The status as it is spoken now — an old stored value read as its new one. */
const normalizeStatus = (s) => LEGACY_STATUS[s] || s;

/** Every stored value that means `status` — itself and its old names — for queries. */
const storedAs = (status) => [status, ...Object.keys(LEGACY_STATUS).filter((k) => LEGACY_STATUS[k] === status)];
const storedAsAny = (list) => list.flatMap(storedAs);

/* The status a job is born in — both kinds. A product job is born handed
   over: registering it IS putting it into maintenance. */
const INITIAL = Object.freeze({ service: "OPEN", product: "OPEN" });

/*
 * The steps — the same for both kinds: where each may start, where it lands,
 * and what it stamps. `clock` marks the step that STARTS the repair clock and
 * the one that STOPS it. `needs` names the body fields the step requires.
 */
const STEPS = Object.freeze({
  start: Object.freeze({ from: Object.freeze(["OPEN"]), to: "IN_PROGRESS", label: "Start", clock: "start" }),
  done: Object.freeze({ from: Object.freeze(["IN_PROGRESS"]), to: "DONE", label: "Repair completed", clock: "stop" }),
  report: Object.freeze({ from: Object.freeze(["DONE"]), to: "CLOSED", label: "Submit report", needs: Object.freeze(["report"]), final: true }),
  cancel: Object.freeze({ from: Object.freeze(["OPEN", "IN_PROGRESS"]), to: "CANCELLED", label: "Cancel", needs: Object.freeze(["reason"]), final: true }),
});
const ACTIONS = Object.freeze({ service: STEPS, product: STEPS });

/* The first version's step names, read as the new ones (an open browser tab
   from before the change still sends them). */
const LEGACY_ACTION = Object.freeze({
  "start-work": "start",
  "complete-repair": "done",
  solve: "done",
  complete: "report",
  close: "report",
});

/* Still being worked — "open". */
const OPEN_STATUSES = Object.freeze(["OPEN", "IN_PROGRESS"]);
const OPEN = Object.freeze({ service: OPEN_STATUSES, product: OPEN_STATUSES });

/* A repair has been DONE (the clock stopped). These are what "number of
   repairs", "last repaired" and the averages count. */
const REPAIRED_STATUSES = Object.freeze(["DONE", "CLOSED"]);
const REPAIRED = Object.freeze({ service: REPAIRED_STATUSES, product: REPAIRED_STATUSES });

const isOrderType = (t) => t === "service" || t === "product";

/** The step `action` on a job of `type` in `status`, or a refusal. */
function stepFor(type, status, action) {
  const table = ACTIONS[type];
  if (!table) return { ok: false, reason: "Unknown order type." };
  const key = LEGACY_ACTION[action] || action;
  const step = table[key];
  if (!step) return { ok: false, reason: `"${action}" is not a step of a maintenance job.` };
  const now = normalizeStatus(status);
  if (!step.from.includes(now)) {
    return { ok: false, reason: `A job that is ${STATUS_LABEL[now] || now} cannot "${step.label.toLowerCase()}".` };
  }
  return { ok: true, step, action: key };
}

/** The steps a person may take now, in screen order. */
function availableActions(type, status) {
  const now = normalizeStatus(status);
  return Object.entries(ACTIONS[type] || {})
    .filter(([, s]) => s.from.includes(now))
    .map(([key, s]) => ({ key, label: s.label, needs: [...(s.needs || [])], danger: key === "cancel" }));
}

/** Whole minutes between two instants, or null when either is missing or out of order. */
function minutesBetween(start, end) {
  if (!start || !end) return null;
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  return Math.round(ms / 60000);
}

/** "1 hr 25 min", "45 min", "2 days 3 hr", "0 min". Null stays null. */
function formatDuration(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(Number(minutes))) return null;
  const m = Math.max(0, Math.round(Number(minutes)));
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const mins = m % 60;
  if (days) return `${days} day${days === 1 ? "" : "s"}${hours ? ` ${hours} hr` : ""}`;
  if (hours) return `${hours} hr${mins ? ` ${mins} min` : ""}`;
  return `${mins} min`;
}

/** "MR-0001": a Maintenance Report's number. One sequence for both kinds. */
const REPORT_PREFIX = "MR";
function formatReportNumber(seq) {
  return `${REPORT_PREFIX}-${String(seq).padStart(4, "0")}`;
}

/* What the machine is left as, said on the report. Recorded, never written
   to the machine register. */
const FINAL_STATUS = Object.freeze({
  operational: "Operational",
  monitor: "Operational — keep under watch",
  limited: "Working with limits",
  "not-repaired": "Not repaired — needs more work",
  "out-of-service": "Out of service",
});

/** "MSO-0001" from a type and a sequence number. */
function formatOrderNumber(type, seq) {
  return `${PREFIX[type]}-${String(seq).padStart(4, "0")}`;
}

/**
 * Repair figures for one machine or item from its jobs (any job, any status —
 * only repaired ones count). `now` is injectable for tests.
 */
function repairStats(orders, now = new Date()) {
  const list = (orders || []).map((o) => ({ ...o, status: normalizeStatus(o.status) }));
  const done = list
    .filter((o) => REPAIRED_STATUSES.includes(o.status) && o.workDoneAt)
    .sort((a, b) => new Date(b.workDoneAt) - new Date(a.workDoneAt));
  const durations = done.map((o) => o.repairMinutes).filter((m) => Number.isFinite(m));
  const last = done[0] || null;
  const previous = done[1] || null;
  const day = 86400000;
  return {
    repairs: done.length,
    lastRepairedAt: last?.workDoneAt || null,
    previousRepairedAt: previous?.workDoneAt || null,
    daysSinceLastRepair: last ? Math.floor((new Date(now) - new Date(last.workDoneAt)) / day) : null,
    daysBetweenLastTwo: last && previous ? Math.floor((new Date(last.workDoneAt) - new Date(previous.workDoneAt)) / day) : null,
    lastRepairMinutes: Number.isFinite(last?.repairMinutes) ? last.repairMinutes : null,
    averageRepairMinutes: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    open: list.filter((o) => OPEN_STATUSES.includes(o.status)).length,
  };
}

module.exports = {
  ORDER_TYPES,
  PREFIX,
  STATUSES,
  STATUS_LABEL,
  LEGACY_STATUS,
  LEGACY_ACTION,
  normalizeStatus,
  storedAs,
  storedAsAny,
  INITIAL,
  ACTIONS,
  OPEN,
  REPAIRED,
  isOrderType,
  stepFor,
  availableActions,
  minutesBetween,
  formatDuration,
  formatOrderNumber,
  formatReportNumber,
  REPORT_PREFIX,
  FINAL_STATUS,
  repairStats,
};
