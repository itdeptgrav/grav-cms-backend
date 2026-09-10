// services/merchandising/tnaPortfolio.service.js
//
// EVERY FILE'S MILESTONES AT ONCE — the cross-file register.
//
// A merchandiser controls dates across many simultaneous orders, so the
// question "which milestone threatens a committed delivery date" is only half
// answered inside one file. This is the other half: one row per milestone,
// across the whole company, filtered by what somebody is chasing today.
//
// ── WHY THIS IS AN INDEXED QUERY AND NOT A LOOP OVER FILES ──────────────────
// Five hundred files with forty milestones each is twenty thousand rows. Any
// implementation that read plans and then read their milestones would do five
// hundred round trips to answer one screen, and would get slower exactly as
// the company grew. `status` is stored rather than derived at read time
// precisely so this can be an index scan, and the compound index it uses is
// declared on the milestone model beside the fields it covers.
//
// ── AND WHY THE COUNTS ARE AN AGGREGATION ───────────────────────────────────
// The segmented tabs need six numbers. Fetching twenty thousand documents to
// count them in JavaScript would move the whole collection over the wire to
// produce six integers.
"use strict";

const crypto = require("crypto");
const mongoose = require("mongoose");

const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const {
  TnaPlan, TnaMilestone, PLAN_STATE, MILESTONE_STATUS,
} = require("../../models/CMS_Models/Merchandising/TnaPlan");
const plans = require("./tnaPlan.service");
const cal = require("./tnaCalendar");
const { fail } = require("../storePurchase/errors");

const str = (v) => String(v ?? "").trim();
const isId = (v) => mongoose.Types.ObjectId.isValid(str(v));

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
/** A bulk call is bounded, and going over is refused rather than truncated. */
const MAX_BULK_ROWS = 200;

/** The register's views, and the statuses each one shows. */
const PORTFOLIO_VIEWS = Object.freeze({
  "due-soon": [MILESTONE_STATUS.DUE_SOON],
  overdue: [MILESTONE_STATUS.OVERDUE],
  blocked: [MILESTONE_STATUS.BLOCKED],
  "forecast-late": [MILESTONE_STATUS.FORECAST_LATE],
  completed: [MILESTONE_STATUS.COMPLETED],
  all: null,
});

const isPortfolioView = (key) => Object.keys(PORTFOLIO_VIEWS).includes(str(key));

function assertContext(ctx) {
  if (!ctx?.companyId) throw fail("COMPANY_CONTEXT_UNAVAILABLE", "Your company could not be resolved.");
}

function boundedLimit(limit) {
  const asked = limit === undefined || limit === null || limit === "" ? DEFAULT_LIMIT : Number(limit);
  if (!Number.isInteger(asked) || asked < 1) {
    throw fail("VALIDATION", "Ask for a whole number of rows.", { field: "limit" });
  }
  return Math.min(asked, MAX_LIMIT);
}

/* ── CURSORS ──────────────────────────────────────────────────────────────
   Encodes the sort key AND the filter it was issued under, so a cursor from
   the overdue list cannot silently page through the completed one — which
   would skip rows and look like data loss. */
function encodeCursor(row, filterKey) {
  const raw = `${row.forecastDate || ""}|${str(row._id)}|${filterKey}`;
  return Buffer.from(raw, "utf8").toString("base64url");
}

function decodeCursor(value, filterKey) {
  if (!str(value)) return null;
  let decoded = "";
  try { decoded = Buffer.from(str(value), "base64url").toString("utf8"); } catch { decoded = ""; }
  const [date, id, key] = decoded.split("|");
  if (!isId(id) || key !== filterKey) {
    throw fail("VALIDATION",
      "That page marker was issued for a different filter. Start the list again.",
      { field: "cursor" });
  }
  return { forecastDate: date || null, id: new mongoose.Types.ObjectId(id) };
}

/* ═══ THE REGISTER ═════════════════════════════════════════════════════════ */

/**
 * One page of milestones across every file this company holds.
 *
 * Ordered by forecast date — the thing somebody is chasing — with the row id
 * breaking ties so the page boundary is stable under insertion.
 */
async function portfolio(ctx, {
  view = "due-soon", q = "", owner = "", assignedTo = "", buyer = "", factory = "",
  from = "", to = "", cursor, limit,
} = {}) {
  assertContext(ctx);
  if (!isPortfolioView(view)) {
    throw fail("VALIDATION",
      `"${view}" is not a Time & Action view.`, { field: "view", allowed: Object.keys(PORTFOLIO_VIEWS) });
  }
  const size = boundedLimit(limit);
  const statuses = PORTFOLIO_VIEWS[str(view)];

  const match = { companyId: ctx.companyId };
  if (statuses) match.status = { $in: statuses };
  if (str(owner)) match.ownerDepartment = str(owner).toUpperCase();
  if (str(from)) match.forecastDate = { ...(match.forecastDate || {}), $gte: cal.assertDate(from, "from") };
  if (str(to)) match.forecastDate = { ...(match.forecastDate || {}), $lte: cal.assertDate(to, "to") };

  /* The filter identity a cursor is bound to. */
  const filterKey = crypto.createHash("sha1")
    .update(JSON.stringify({ view, owner, assignedTo, buyer, factory, from, to, q })).digest("hex").slice(0, 8);
  const after = decodeCursor(cursor, filterKey);
  if (after) {
    match.$or = [
      { forecastDate: { $gt: after.forecastDate } },
      { forecastDate: after.forecastDate, _id: { $gt: after.id } },
    ];
  }

  /* ── FILE-LEVEL FILTERS ────────────────────────────────────────────────
     Buyer, factory, the responsible merchandiser and free text are all facts
     of the FILE, not of the milestone. Resolved to a file-id set first, so
     the milestone query stays an index scan. */
  const fileFilter = { companyId: ctx.companyId };
  let restrictFiles = false;
  if (str(assignedTo) === "me" && str(ctx.actorEmail)) {
    fileFilter["responsibleMerchandiser.email"] = str(ctx.actorEmail).toLowerCase();
    restrictFiles = true;
  } else if (str(assignedTo) && str(assignedTo) !== "me") {
    fileFilter["responsibleMerchandiser.email"] = str(assignedTo).toLowerCase();
    restrictFiles = true;
  }
  if (str(buyer)) {
    fileFilter["currentExecutionProjection.buyerDisplayLabel"] = new RegExp(escapeRegex(str(buyer)), "i");
    restrictFiles = true;
  }
  if (str(factory)) {
    fileFilter["currentExecutionProjection.deliveries.nominatedFactoryRef"] = str(factory);
    restrictFiles = true;
  }
  if (str(q)) {
    const rx = new RegExp(escapeRegex(str(q)), "i");
    fileFilter.$or = [
      { fileNumber: rx },
      { handoverRef: rx },
      { "currentExecutionProjection.productName": rx },
      { "currentExecutionProjection.styleRef": rx },
      { "currentExecutionProjection.buyerDisplayLabel": rx },
    ];
    restrictFiles = true;
  }

  let files = null;
  if (restrictFiles) {
    files = await ExecutionFile.find(fileFilter).select("_id").limit(2000).lean();
    if (!files.length) return { rows: [], nextCursor: null, hasMore: false };
    match.fileId = { $in: files.map((f) => f._id) };
  }

  const rows = await TnaMilestone.find(match)
    .sort({ forecastDate: 1, _id: 1 }).limit(size + 1).lean();
  const page = rows.slice(0, size);

  /* One lookup for the page's files, not one per row. */
  const fileIds = [...new Set(page.map((r) => str(r.fileId)))];
  const fileDocs = await ExecutionFile.find({ _id: { $in: fileIds }, companyId: ctx.companyId })
    .select("fileNumber handoverRef responsibleMerchandiser currentExecutionProjection").lean();
  const byFile = new Map(fileDocs.map((f) => [str(f._id), f]));

  return {
    rows: page.map((m) => {
      const f = byFile.get(str(m.fileId));
      const p = f?.currentExecutionProjection || {};
      return {
        milestoneRef: str(m.milestoneRef),
        milestoneCode: str(m.milestoneCode),
        name: str(m.name),
        ownerDepartment: str(m.ownerDepartment),
        awaitingSource: m.completionAuthority === "SOURCE_EVENT" && !m.actualDate,
        fileId: str(m.fileId),
        fileNumber: str(f?.fileNumber),
        orderRef: str(p.orderRef) || str(f?.handoverRef),
        buyerDisplayLabel: str(p.buyerDisplayLabel),
        productName: str(p.productName),
        styleRef: str(p.styleRef),
        responsibleMerchandiser: str(f?.responsibleMerchandiser?.name),
        baselineDate: m.baselineDate || null,
        forecastDate: m.forecastDate || null,
        actualDate: m.actualDate || null,
        status: str(m.status),
        blockedReason: str(m.blocked?.reasonCode),
        blockedNote: str(m.blocked?.note),
      };
    }),
    nextCursor: rows.length > size ? encodeCursor(page[page.length - 1], filterKey) : null,
    hasMore: rows.length > size,
  };
}

const escapeRegex = (v) => String(v).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The six figures the segmented tabs and the Overview both read.
 *
 * One aggregation. Every count has a list behind it, opened by the same view
 * name — a figure nobody can take apart is a figure nobody can trust.
 */
async function portfolioCounts(ctx) {
  assertContext(ctx);
  const rows = await TnaMilestone.aggregate([
    { $match: { companyId: ctx.companyId } },
    { $group: { _id: "$status", n: { $sum: 1 } } },
  ]);
  const byStatus = Object.fromEntries(rows.map((r) => [r._id, r.n]));
  const counts = {
    "due-soon": byStatus[MILESTONE_STATUS.DUE_SOON] || 0,
    overdue: byStatus[MILESTONE_STATUS.OVERDUE] || 0,
    blocked: byStatus[MILESTONE_STATUS.BLOCKED] || 0,
    "forecast-late": byStatus[MILESTONE_STATUS.FORECAST_LATE] || 0,
    completed: byStatus[MILESTONE_STATUS.COMPLETED] || 0,
    all: rows.reduce((t, r) => t + r.n, 0),
  };
  /* What the Overview shows beside its existing four figures. */
  counts.deliveryAtRisk = counts.overdue + counts["forecast-late"];
  return { counts, generatedAt: new Date() };
}

/**
 * The next milestone on each of a set of files — for the Order Execution
 * register's one added column, and the file Summary.
 *
 * Batched deliberately: the register draws twenty-five rows, and twenty-five
 * separate reads to fill one column is how a list page becomes slow.
 */
async function nextMilestoneFor(ctx, fileIds = []) {
  assertContext(ctx);
  const ids = fileIds.filter(isId).map((id) => new mongoose.Types.ObjectId(str(id)));
  if (!ids.length) return {};
  const rows = await TnaMilestone.aggregate([
    {
      $match: {
        companyId: ctx.companyId, fileId: { $in: ids },
        actualDate: null,
        status: { $nin: [MILESTONE_STATUS.NOT_APPLICABLE, MILESTONE_STATUS.COMPLETED] },
      },
    },
    { $sort: { forecastDate: 1, sequenceRank: 1 } },
    {
      $group: {
        _id: "$fileId",
        milestoneRef: { $first: "$milestoneRef" },
        name: { $first: "$name" },
        forecastDate: { $first: "$forecastDate" },
        baselineDate: { $first: "$baselineDate" },
        status: { $first: "$status" },
        ownerDepartment: { $first: "$ownerDepartment" },
        atRisk: {
          $sum: {
            $cond: [{ $in: ["$status", [MILESTONE_STATUS.OVERDUE, MILESTONE_STATUS.FORECAST_LATE]] }, 1, 0],
          },
        },
      },
    },
  ]);
  return Object.fromEntries(rows.map((r) => [str(r._id), {
    milestoneRef: str(r.milestoneRef),
    name: str(r.name),
    forecastDate: r.forecastDate || null,
    baselineDate: r.baselineDate || null,
    status: str(r.status),
    ownerDepartment: str(r.ownerDepartment),
    atRiskCount: r.atRisk || 0,
  }]));
}

/* ═══ BULK ═════════════════════════════════════════════════════════════════ */

/**
 * PREVIEW a bulk reschedule — per row, and writing nothing.
 *
 * Every row comes back with its own outcome. A row that cannot move does not
 * stop the ones that can: one bad reference in a list of forty must not
 * discard the thirty-nine good ones, which is what an all-or-nothing bulk
 * operation does to somebody's afternoon.
 */
async function bulkPreview(ctx, { rows = [], actor = null } = {}) {
  assertContext(ctx);
  if (!Array.isArray(rows) || !rows.length) {
    throw fail("VALIDATION", "Send the rows to preview.", { field: "rows" });
  }
  if (rows.length > MAX_BULK_ROWS) {
    throw fail("VALIDATION",
      `A bulk preview takes at most ${MAX_BULK_ROWS} rows at a time; this one has ${rows.length}. `
      + "Split it rather than having part of it silently ignored.",
      { field: "rows", maximum: MAX_BULK_ROWS, received: rows.length });
  }

  const previewId = `BLK-${crypto.randomBytes(6).toString("hex")}`;
  const outcomes = [];
  for (const row of rows) {
    const fileId = str(row?.fileId);
    const milestoneRef = str(row?.milestoneRef);
    try {
      const proposedDate = cal.assertDate(row?.proposedDate, "proposedDate");
      const { plan } = await plans.loadPlan(ctx, fileId);
      const m = await TnaMilestone.findOne({
        companyId: ctx.companyId, planId: plan._id, milestoneRef,
      }).lean();
      if (!m) {
        outcomes.push({ fileId, milestoneRef, outcome: "REFUSED", reason: "That milestone is not on this plan." });
        continue;
      }
      if (m.actualDate) {
        outcomes.push({
          fileId, milestoneRef, outcome: "SKIPPED",
          reason: `Already completed on ${m.actualDate}.`,
        });
        continue;
      }
      outcomes.push({
        fileId, milestoneRef, outcome: "APPLIED",
        reason: "", beforeForecast: m.forecastDate || null, afterForecast: proposedDate,
      });
    } catch (err) {
      outcomes.push({
        fileId, milestoneRef, outcome: "REFUSED",
        reason: str(err?.message) || "That row could not be read.",
      });
    }
  }

  return {
    previewId,
    /* `APPLIED` in a preview means "would apply". Said in the response so
       nobody reads a preview as a receipt. */
    note: "Nothing has been changed. These are the outcomes an apply would produce.",
    counts: {
      total: outcomes.length,
      applicable: outcomes.filter((o) => o.outcome === "APPLIED").length,
      skipped: outcomes.filter((o) => o.outcome === "SKIPPED").length,
      refused: outcomes.filter((o) => o.outcome === "REFUSED").length,
    },
    rows: outcomes,
  };
}

/**
 * APPLY a previewed bulk reschedule.
 *
 * Each row is its own transaction. A partial failure is REPORTED, not rolled
 * back — the spec's rule and the right one: thirty-nine successful moves are
 * not worth discarding because the fortieth named a milestone that has since
 * been completed.
 */
async function bulkApply(ctx, { previewId, rows = [], actor = null } = {}) {
  assertContext(ctx);
  if (!str(previewId)) {
    throw fail("VALIDATION",
      "Apply needs the previewId of the preview these rows came from.", { field: "previewId" });
  }
  if (!Array.isArray(rows) || !rows.length) {
    throw fail("VALIDATION", "Send the rows to apply.", { field: "rows" });
  }
  if (rows.length > MAX_BULK_ROWS) {
    throw fail("VALIDATION",
      `A bulk apply takes at most ${MAX_BULK_ROWS} rows at a time; this one has ${rows.length}.`,
      { field: "rows", maximum: MAX_BULK_ROWS, received: rows.length });
  }

  const outcomes = [];
  for (const row of rows) {
    const fileId = str(row?.fileId);
    const milestoneRef = str(row?.milestoneRef);
    try {
      const current = await TnaMilestone.findOne({
        companyId: ctx.companyId, milestoneRef,
      }).select("revision fileId").lean();
      const applied = await plans.updateForecast(ctx, {
        fileId,
        milestoneRef,
        body: {
          forecastDate: row?.proposedDate,
          expectedRevision: current?.revision ?? 0,
          note: str(row?.note) || `Bulk reschedule ${previewId}`,
        },
        actor,
      });
      outcomes.push({
        fileId, milestoneRef, outcome: "APPLIED",
        reason: "", afterForecast: applied.forecastDate, cascaded: applied.cascaded.length,
      });
    } catch (err) {
      outcomes.push({
        fileId, milestoneRef,
        outcome: err?.code === "TNA_STATE_CONFLICT" ? "SKIPPED" : "REFUSED",
        reason: str(err?.message) || "That row could not be applied.",
      });
    }
  }

  return {
    previewId: str(previewId),
    counts: {
      total: outcomes.length,
      applied: outcomes.filter((o) => o.outcome === "APPLIED").length,
      skipped: outcomes.filter((o) => o.outcome === "SKIPPED").length,
      refused: outcomes.filter((o) => o.outcome === "REFUSED").length,
    },
    rows: outcomes,
  };
}

module.exports = {
  PORTFOLIO_VIEWS, isPortfolioView, MAX_BULK_ROWS, DEFAULT_LIMIT, MAX_LIMIT,
  encodeCursor, decodeCursor, boundedLimit,
  portfolio, portfolioCounts, nextMilestoneFor, bulkPreview, bulkApply,
};
