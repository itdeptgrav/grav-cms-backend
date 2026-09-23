// services/merchandising/ops.service.js
//
// IS THE INTEGRATION ACTUALLY WORKING?
//
// Four questions, answered by four queries: what has not been delivered, how
// old the oldest of it is, what has been retried and failed, and what came
// back from each receiver.
//
// ── STUCK DETECTION IS A QUERY, NOT A DAEMON ────────────────────────────────
// This is the single most important thing about this file. Nothing here runs
// on a timer. There is no worker, no scheduler, no broker, and no background
// process watching for stuck rows. "Stuck" is `status: PENDING` and
// `createdAt` older than a threshold, evaluated when somebody asks — and the
// somebody is a person looking at the integration-health panel, or an existing
// operational scheduler calling the endpoint.
//
// The alternative would have been to claim a monitor this repository does not
// have. A dashboard that says "monitoring" while nothing monitors is worse
// than no dashboard, because it stops people looking.
//
// ── AND A FAILURE IS NEVER TERMINAL ─────────────────────────────────────────
// No outbox in this module has a `FAILED` state. A row that could not be
// carried keeps its attempt count and its last error and stays PENDING, which
// means the next retry — by a person here, or by the next call after the next
// commit — picks it up. A terminal state would be a row that stopped trying
// and that nobody would notice had stopped.
"use strict";

const {
  MerchandisingOutboxEvent, MerchandisingIntakeLedger,
} = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const {
  SalesHandoverOutboxEvent,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();

/** How old a pending row has to be before it is worth somebody's attention. */
const STUCK_AFTER_MINUTES = 15;
/** Or how many failed attempts. Either is enough to surface it. */
const STUCK_AFTER_ATTEMPTS = 3;

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

const ageMinutes = (from, now) => (from ? Math.floor((now - new Date(from).getTime()) / 60000) : null);

/**
 * Every outbox, by kind and status, with the oldest pending age.
 *
 * Both outboxes: Merchandising's own, and the Sales one that carries handovers
 * and changes INTO Merchandising. A health panel that showed only one would be
 * blind to half the boundary.
 */
async function outboxHealth(ctx) {
  assertContext(ctx);
  const now = Date.now();

  const [mine, sales] = await Promise.all([
    MerchandisingOutboxEvent.aggregate([
      { $match: { companyId: ctx.companyId } },
      {
        $group: {
          _id: { kind: "$kind", status: "$status" },
          n: { $sum: 1 },
          oldest: { $min: "$createdAt" },
          maxAttempts: { $max: "$attempts" },
        },
      },
    ]),
    SalesHandoverOutboxEvent.aggregate([
      { $match: { companyId: ctx.companyId } },
      {
        $group: {
          _id: { kind: "$kind", status: "$status" },
          n: { $sum: 1 },
          oldest: { $min: "$occurredAt" },
          maxAttempts: { $max: "$attempts" },
        },
      },
    ]),
  ]);

  const shape = (rows, outbox) => rows.map((r) => ({
    outbox,
    kind: str(r._id.kind),
    status: str(r._id.status),
    count: r.n,
    oldest: r.oldest || null,
    oldestAgeMinutes: r.status === "PENDING" ? ageMinutes(r.oldest, now) : null,
    maxAttempts: r.maxAttempts || 0,
  }));

  const rows = [...shape(mine, "merchandising"), ...shape(sales, "sales")];
  const pending = rows.filter((r) => r.status === "PENDING");

  return {
    rows: rows.sort((a, b) => (a.outbox + a.kind).localeCompare(b.outbox + b.kind)),
    totals: {
      pending: pending.reduce((t, r) => t + r.count, 0),
      delivered: rows.filter((r) => r.status === "DELIVERED").reduce((t, r) => t + r.count, 0),
      oldestPendingMinutes: pending.length
        ? Math.max(...pending.map((r) => r.oldestAgeMinutes ?? 0)) : null,
    },
    /* Said in the payload, so no client can render this as live monitoring. */
    note: "These figures are read when you ask for them. Nothing polls, and no daemon or broker "
      + "watches this — a stuck row is drained by a person or by an existing scheduler.",
    generatedAt: new Date(),
  };
}

/**
 * What is actually stuck, and why.
 *
 * Pending beyond the age threshold, OR retried past the attempt threshold.
 * Either alone is a real signal: an old row nobody has tried, and a row that
 * has been tried and keeps failing, are different problems with different
 * fixes, and both need to be visible.
 */
async function stuck(ctx, { minutes, attempts, limit = 50 } = {}) {
  assertContext(ctx);
  const now = Date.now();
  const ageCut = new Date(now - (Number(minutes) || STUCK_AFTER_MINUTES) * 60000);
  const attemptCut = Number(attempts) || STUCK_AFTER_ATTEMPTS;
  const size = Math.min(Number(limit) || 50, 200);

  const [mine, sales] = await Promise.all([
    MerchandisingOutboxEvent.find({
      companyId: ctx.companyId,
      status: "PENDING",
      $or: [{ createdAt: { $lt: ageCut } }, { attempts: { $gte: attemptCut } }],
    }).sort({ createdAt: 1 }).limit(size).lean(),
    SalesHandoverOutboxEvent.find({
      companyId: ctx.companyId,
      status: "PENDING",
      $or: [{ occurredAt: { $lt: ageCut } }, { attempts: { $gte: attemptCut } }],
    }).sort({ occurredAt: 1 }).limit(size).lean(),
  ]);

  const shape = (rows, outbox, dateField) => rows.map((r) => ({
    outbox,
    eventId: str(r._id),
    kind: str(r.kind),
    /* The correlation id is how somebody ties this row to the audit event of
       the act that produced it — which is what makes a stuck row diagnosable
       rather than merely visible. */
    correlationId: str(r.correlationId),
    attempts: r.attempts || 0,
    lastAttemptAt: r.lastAttemptAt || null,
    lastError: str(r.lastError),
    occurredAt: r[dateField] || null,
    ageMinutes: ageMinutes(r[dateField], now),
  }));

  const rows = [
    ...shape(mine, "merchandising", "createdAt"),
    ...shape(sales, "sales", "occurredAt"),
  ].sort((a, b) => (b.ageMinutes ?? 0) - (a.ageMinutes ?? 0));

  return {
    rows: rows.slice(0, size),
    thresholds: { minutes: Number(minutes) || STUCK_AFTER_MINUTES, attempts: attemptCut },
    hasMore: rows.length > size,
  };
}

/**
 * What the receivers actually did with what was delivered.
 *
 * Read from the intake ledger, which is the only honest source: it records one
 * row per event a receiver applied, with the outcome. A duplicate delivery and
 * a NOOP both appear here, which is what makes "delivery is working but
 * nothing is being applied" a diagnosable state rather than a mystery.
 */
async function intakeHealth(ctx, { hours = 168 } = {}) {
  assertContext(ctx);
  const since = new Date(Date.now() - Math.min(Number(hours) || 168, 24 * 90) * 3600000);

  const rows = await MerchandisingIntakeLedger.aggregate([
    { $match: { companyId: ctx.companyId, appliedAt: { $gte: since } } },
    { $group: { _id: { kind: "$sourceKind", outcome: "$outcome" }, n: { $sum: 1 } } },
  ]);

  return {
    since,
    rows: rows.map((r) => ({
      kind: str(r._id.kind),
      outcome: str(r._id.outcome),
      count: r.n,
    })).sort((a, b) => a.kind.localeCompare(b.kind)),
    totals: {
      applied: rows.filter((r) => r._id.outcome === "APPLIED").reduce((t, r) => t + r.n, 0),
      noop: rows.filter((r) => r._id.outcome === "NOOP").reduce((t, r) => t + r.n, 0),
    },
    note: "A NOOP is a successful delivery that needed no change — a duplicate, a stale version, "
      + "or an event about a record that no longer applies.",
  };
}

/**
 * Drain everything, by hand.
 *
 * Calls each carrier in turn. Every one of them is idempotent and none throws,
 * so running this twice is harmless and running it while something else drains
 * is harmless too.
 */
async function retryAll(ctx, { limit = 200 } = {}) {
  assertContext(ctx);
  const salesHandover = require("../integration/salesHandoverDelivery.service");
  const salesChange = require("../integration/salesChangeDelivery.service");
  const tnaSource = require("../integration/tnaSourceDelivery.service");
  const packDelivery = require("../integration/executionPackDelivery.service");

  const [handover, change, tna, pack] = await Promise.all([
    salesHandover.deliverPending({ companyId: ctx.companyId, limit }).catch((e) => ({ error: str(e?.message) })),
    salesChange.deliverPending({ companyId: ctx.companyId, limit }).catch((e) => ({ error: str(e?.message) })),
    tnaSource.deliverPending({ companyId: ctx.companyId, limit }).catch((e) => ({ error: str(e?.message) })),
    packDelivery.deliverPending({ companyId: ctx.companyId, limit }).catch((e) => ({ error: str(e?.message) })),
  ]);

  return {
    carriers: { handover, change, tnaSource: tna, executionPack: pack },
    note: "Each carrier is idempotent, so this is safe to run again.",
    generatedAt: new Date(),
  };
}

module.exports = {
  STUCK_AFTER_MINUTES, STUCK_AFTER_ATTEMPTS,
  outboxHealth, stuck, intakeHealth, retryAll,
};
