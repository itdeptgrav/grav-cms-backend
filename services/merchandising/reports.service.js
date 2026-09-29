// services/merchandising/reports.service.js
//
// OPERATIONAL FIGURES, EVERY ONE BACKED BY RECORDS THAT EXIST.
//
// ── THE RULE THIS FILE IS BUILT AROUND ──────────────────────────────────────
// **Never calculate a positive state from missing data.**
//
// A company with no Time & Action plans has no on-time percentage. The
// arithmetic would happily produce 100% — zero milestones late out of zero —
// and that figure would be a lie somebody could act on. So every report that
// divides says how many records it divided, and returns `null` with a sentence
// rather than a percentage when the denominator is zero.
//
// The same rule kills the tempting shortcuts: a department that has reported
// nothing is not "0% blocked", an order with no pack is not "0 days to
// submit", and a change nobody has acknowledged is not "0% coverage".
//
// ── AND EVERY FIGURE OPENS ITS RECORDS ──────────────────────────────────────
// Each row carries the filter that produced it, so the screen can link a
// number to the exact list behind it. A count nobody can take apart is a count
// nobody can trust — the rule the Overview has followed since M1.
"use strict";

const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const HandoverReceipt = require("../../models/CMS_Models/Merchandising/HandoverReceipt");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const {
  MaterialTrimRevision, PackagingRevision, DevelopmentRevision,
} = require("../../models/CMS_Models/Merchandising/SelectionRevision");
const { TnaMilestone } = require("../../models/CMS_Models/Merchandising/TnaPlan");
const { ExecutionPack } = require("../../models/CMS_Models/Merchandising/ExecutionPack");
const {
  DownstreamHandoverReceipt,
} = require("../../models/CMS_Models/PPC/DownstreamHandoverReceipt");
const {
  DepartmentStatusProjection,
} = require("../../models/CMS_Models/Merchandising/DepartmentStatusProjection");
const { ChangeImpact } = require("../../models/CMS_Models/Merchandising/ChangeControl");
const { SalesChangeNotice } = require("../../models/CMS_Models/Sales/SalesChangeNotice");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const days = (from, to = Date.now()) => (from
  ? Math.floor((to - new Date(from).getTime()) / 86400000) : null);

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

/**
 * A measure that refuses to invent a positive.
 *
 * `of` zero means nobody has recorded anything, and the answer is a sentence
 * rather than a number — see the header.
 */
const ratio = (part, of, unit = "records") => (of > 0
  ? { value: Math.round((part / of) * 1000) / 10, part, of, available: true }
  : {
    value: null, part: 0, of: 0, available: false,
    sentence: `No ${unit} yet, so there is nothing to measure.`,
  });

/* ═══ THE REPORTS ══════════════════════════════════════════════════════════ */

/** How long handovers have been waiting for a Merchandising decision. */
async function handoverAgeing(ctx) {
  const versions = await SalesHandoverVersion.find({ companyId: ctx.companyId })
    .select("_id handoverRef handoverLineRef createdAt").lean();
  const receipts = await HandoverReceipt.find({
    companyId: ctx.companyId, handoverVersionId: { $in: versions.map((v) => v._id) },
  }).select("handoverVersionId state").lean();
  const decided = new Set(receipts.filter((r) => r.state !== "PENDING").map((r) => str(r.handoverVersionId)));

  const waiting = versions.filter((v) => !decided.has(str(v._id)));
  const buckets = { "0-2": 0, "3-7": 0, "8-14": 0, "15+": 0 };
  for (const v of waiting) {
    const d = days(v.createdAt) ?? 0;
    if (d <= 2) buckets["0-2"] += 1;
    else if (d <= 7) buckets["3-7"] += 1;
    else if (d <= 14) buckets["8-14"] += 1;
    else buckets["15+"] += 1;
  }
  return {
    report: "handover-ageing",
    title: "Handovers awaiting a Merchandising decision",
    rows: Object.entries(buckets).map(([bucket, count]) => ({
      bucket: `${bucket} days`, count,
      /* The filter that opens exactly these records. */
      opens: { register: "execution", view: "new" },
    })),
    total: waiting.length,
  };
}

/** Where the company's execution files are. */
async function filesByLifecycle(ctx, { includeArchived = false } = {}) {
  const match = { companyId: ctx.companyId };
  if (!includeArchived) match.archived = { $ne: true };
  const rows = await ExecutionFile.aggregate([
    { $match: match },
    { $group: { _id: "$lifecycleStatus", n: { $sum: 1 } } },
  ]);
  const VIEW = {
    OPEN: "active", ON_HOLD: "on-hold", CLOSED: "closed",
    CANCELLED: "cancelled", HANDED_OVER: "handed-over",
  };
  return {
    report: "files-by-lifecycle",
    title: "Execution files by lifecycle",
    rows: rows.map((r) => ({
      lifecycleStatus: str(r._id),
      count: r.n,
      opens: { register: "execution", view: VIEW[str(r._id)] || "active" },
    })).sort((a, b) => b.count - a.count),
    total: rows.reduce((t, r) => t + r.n, 0),
    includeArchived,
  };
}

/** How long an approved selection took from first draft to approval. */
async function selectionTurnaround(ctx) {
  const out = [];
  for (const [family, Model] of [
    ["MATERIAL_TRIM", MaterialTrimRevision],
    ["PACKAGING", PackagingRevision],
    ["DEVELOPMENT", DevelopmentRevision],
  ]) {
    const approved = await Model.find({ companyId: ctx.companyId, state: "APPROVED" })
      .select("createdAt approvedAt").lean();
    const spans = approved
      .map((r) => days(r.createdAt, new Date(r.approvedAt).getTime()))
      .filter((d) => Number.isFinite(d) && d >= 0);
    out.push({
      family,
      approvedCount: approved.length,
      /* No approvals means no turnaround — not a zero-day turnaround. */
      medianDays: spans.length
        ? spans.sort((a, b) => a - b)[Math.floor(spans.length / 2)]
        : null,
      available: spans.length > 0,
      sentence: spans.length ? "" : "Nothing approved yet, so there is nothing to measure.",
      opens: { register: "execution", view: "active" },
    });
  }
  return { report: "selection-turnaround", title: "Selection approval turnaround", rows: out };
}

/** T&A adherence: how forecasts sit against what was committed. */
async function tnaAdherence(ctx) {
  const rows = await TnaMilestone.aggregate([
    { $match: { companyId: ctx.companyId } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(rows.map((r) => [str(r._id), r.n]));
  const total = rows.reduce((t, r) => t + r.n, 0);
  const late = (by.OVERDUE || 0) + (by.FORECAST_LATE || 0);

  /* Only milestones that have a commitment can be measured against one. */
  const baselined = await TnaMilestone.countDocuments({
    companyId: ctx.companyId, baselineDate: { $ne: null },
  });

  return {
    report: "tna-adherence",
    title: "Time & Action adherence",
    rows: [
      { measure: "Milestones recorded", count: by.COMPLETED || 0, opens: { register: "tna", view: "completed" } },
      { measure: "Due soon", count: by.DUE_SOON || 0, opens: { register: "tna", view: "due-soon" } },
      { measure: "Overdue", count: by.OVERDUE || 0, opens: { register: "tna", view: "overdue" } },
      { measure: "Forecast past commitment", count: by.FORECAST_LATE || 0, opens: { register: "tna", view: "forecast-late" } },
      { measure: "Blocked", count: by.BLOCKED || 0, opens: { register: "tna", view: "blocked" } },
    ],
    total,
    /* Measured against BASELINED milestones only: a milestone with no
       commitment cannot be adherent or not. */
    onTrack: ratio(baselined - late, baselined, "committed milestones"),
  };
}

/** Where each department's reporting stands, and how much is silence. */
async function departmentReporting(ctx) {
  const contract = require("./departmentStatus.contract");
  const reported = await DepartmentStatusProjection.aggregate([
    { $match: { companyId: ctx.companyId, isCurrent: true } },
    { $group: { _id: "$department", n: { $sum: 1 } } },
  ]);
  const by = Object.fromEntries(reported.map((r) => [str(r._id), r.n]));
  return {
    report: "department-reporting",
    title: "Source department reporting",
    rows: contract.DEPARTMENTS.map((d) => ({
      department: d,
      departmentLabel: contract.DEPARTMENT_WORDS[d],
      currentStatements: by[d] || 0,
      /* Silence is stated, never rendered as a zero that reads like a
         measurement. */
      sentence: (by[d] || 0) === 0
        ? contract.availabilitySentence(d, contract.isIntegrated(d) ? "UNKNOWN" : "UNAVAILABLE")
        : "",
    })),
    note: "A department with no statements has not reported. That is not a measurement of zero.",
  };
}

/** Pack submissions, and what PPC did with them. */
async function downstreamPosition(ctx) {
  const [packs, receipts] = await Promise.all([
    ExecutionPack.aggregate([
      { $match: { companyId: ctx.companyId } },
      { $group: { _id: "$state", n: { $sum: 1 } } },
    ]),
    DownstreamHandoverReceipt.aggregate([
      { $match: { companyId: ctx.companyId } },
      { $group: { _id: "$state", n: { $sum: 1 } } },
    ]),
  ]);
  const byPack = Object.fromEntries(packs.map((r) => [str(r._id), r.n]));
  const byReceipt = Object.fromEntries(receipts.map((r) => [str(r._id), r.n]));

  /* Latency measured only over packs PPC has actually decided on. */
  const decided = await DownstreamHandoverReceipt.find({ companyId: ctx.companyId })
    .select("packId decidedAt").lean();
  const decidedPacks = await ExecutionPack.find({
    _id: { $in: decided.map((r) => r.packId) },
  }).select("submittedAt").lean();
  const byId = new Map(decidedPacks.map((p) => [str(p._id), p]));
  const latencies = decided
    .map((r) => days(byId.get(str(r.packId))?.submittedAt, new Date(r.decidedAt).getTime()))
    .filter((d) => Number.isFinite(d) && d >= 0);

  return {
    report: "downstream-position",
    title: "Execution packs and PPC's decisions",
    rows: [
      { measure: "Awaiting PPC", count: byPack.SUBMITTED || 0, opens: { register: "execution", view: "handed-over" } },
      { measure: "Accepted", count: byReceipt.ACCEPTED || 0, opens: { register: "execution", view: "handed-over" } },
      { measure: "Clarification requested", count: byReceipt.CLARIFICATION_REQUESTED || 0, opens: { register: "execution", view: "active" } },
      { measure: "Superseded", count: byPack.SUPERSEDED || 0, opens: { register: "execution", view: "active" } },
    ],
    medianDecisionDays: latencies.length
      ? latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)] : null,
    available: latencies.length > 0,
    sentence: latencies.length ? "" : "PPC has decided on nothing yet, so there is no latency to measure.",
  };
}

/** Change volume, and how much of it is still open. */
async function changeVolume(ctx, { hours = 24 * 90 } = {}) {
  const since = new Date(Date.now() - Math.min(Number(hours) || 24 * 90, 24 * 365) * 3600000);
  const [notices, impacts] = await Promise.all([
    SalesChangeNotice.aggregate([
      { $match: { companyId: ctx.companyId, createdAt: { $gte: since } } },
      { $group: { _id: "$changeKind", n: { $sum: 1 } } },
    ]),
    ChangeImpact.aggregate([
      { $match: { companyId: ctx.companyId } },
      { $group: { _id: "$state", n: { $sum: 1 } } },
    ]),
  ]);
  const byState = Object.fromEntries(impacts.map((r) => [str(r._id), r.n]));
  const open = (byState.DRAFT || 0) + (byState.ASSESSED || 0) + (byState.COORDINATED || 0);

  return {
    report: "change-volume",
    title: "Sales-authorised changes",
    since,
    byKind: notices.map((r) => ({ changeKind: str(r._id), count: r.n }))
      .sort((a, b) => b.count - a.count),
    rows: [
      { measure: "Awaiting assessment", count: byState.DRAFT || 0, opens: { register: "changes", view: "DRAFT" } },
      { measure: "Assessed, not announced", count: byState.ASSESSED || 0, opens: { register: "changes", view: "ASSESSED" } },
      { measure: "Announced, awaiting acknowledgement", count: byState.COORDINATED || 0, opens: { register: "changes", view: "COORDINATED" } },
      { measure: "Closed", count: byState.CLOSED || 0, opens: { register: "changes", view: "CLOSED" } },
    ],
    open,
    total: notices.reduce((t, r) => t + r.n, 0),
  };
}

/** What is not reaching its destination. */
async function integrationPosition(ctx) {
  const ops = require("./ops.service");
  const [health, stuckRows] = await Promise.all([ops.outboxHealth(ctx), ops.stuck(ctx, { limit: 20 })]);
  return {
    report: "integration-position",
    title: "Integration delivery",
    rows: [
      { measure: "Pending announcements", count: health.totals.pending, opens: { register: "ops", view: "stuck" } },
      { measure: "Stuck beyond threshold", count: stuckRows.rows.length, opens: { register: "ops", view: "stuck" } },
    ],
    oldestPendingMinutes: health.totals.oldestPendingMinutes,
    note: health.note,
  };
}

const REPORTS = Object.freeze({
  "handover-ageing": handoverAgeing,
  "files-by-lifecycle": filesByLifecycle,
  "selection-turnaround": selectionTurnaround,
  "tna-adherence": tnaAdherence,
  "department-reporting": departmentReporting,
  "downstream-position": downstreamPosition,
  "change-volume": changeVolume,
  "integration-position": integrationPosition,
});

const REPORT_KEYS = Object.freeze(Object.keys(REPORTS));

async function run(ctx, { report, options = {} } = {}) {
  assertContext(ctx);
  const fn = REPORTS[str(report)];
  if (!fn) {
    throw fail("REPORT_UNKNOWN", `"${report}" is not a report this app produces.`,
      { allowed: REPORT_KEYS });
  }
  const out = await fn(ctx, options);
  return { ...out, generatedAt: new Date() };
}

module.exports = { REPORTS, REPORT_KEYS, ratio, run };
