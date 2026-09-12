"use strict";

// routes/CMS_Routes/Production/Targets/productionTargetRoutes.js
//
// Mounted at /api/cms/production/targets.
//
//   POST   /                     set a target
//   GET    /                     list, filtered by date / scope / status
//   GET    /live                 evaluate every active target for a day — ONE
//                                scan query, whatever the number of targets.
//                                This is the one the floor view polls.
//   GET    /history              settled targets: what was asked, what was made
//   GET    /:targetId            one target with its live evaluation
//   PATCH  /:targetId            edit pieces / window / note
//   POST   /:targetId/cancel     call it off (never deletes)
//
// A NARROW PREFIX, ON PURPOSE. Not `/api/cms/production` — a router carrying
// its own EmployeeAuthMiddleware on a prefix that broad sits in front of every
// later /api/cms/production/** route in server.js. `/targets` is a distinct
// segment mounted after the scanner routers, so it can neither shadow one of
// their paths nor be shadowed.
//
// WHAT IS TYPED IN AND WHAT IS NOT.
// The only number a person may set here is `targetPieces`. There is no endpoint
// that accepts an actual, because the actual is counted from real scans by
// services/production/targetEvaluator.js. A manually entered actual is
// forbidden by the brief and there is deliberately nowhere to put one.
//
// THERE IS NO LINE OR SECTION IN THIS DATABASE. Machine carries only `type` and
// `location`, both free text with no registry and no history. A "line" target is
// created as scope `group` and MUST declare how its machines are chosen; every
// response repeats that declaration in words, so no screen can imply a line
// entity exists.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const ProductionTarget = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionTarget");
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");
const Operation = require("../../../../models/CMS_Models/Inventory/Configurations/Operation");
const Employee = require("../../../../models/Employee");

const { shiftDateFor, currentShiftDate, SHIFT_TZ_OFFSET_MIN } = require("../../../../services/barcodeScanner/shift");
const evaluator = require("../../../../services/production/targetEvaluator");

// Authentication, not a department gate — the same reasoning the sibling
// production routers state: the supervisor and the project manager both work
// these floor endpoints and hold different roles.
router.use(EmployeeAuthMiddleware);

const { TARGET_SCOPES, TARGET_STATES, GROUP_KINDS } = ProductionTarget;

const MINUTE = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE;

// A typo in a piece target is planned against, so it is bounded. Not a business
// rule — a guard against "1000" becoming "10000" with a stuck key.
const MAX_TARGET_PIECES = Number(process.env.MAX_TARGET_PIECES || 100000);
// A window longer than this is almost certainly a wrong date rather than an
// intention. A target is a shift-shaped thing.
const MAX_WINDOW_MS = Number(process.env.MAX_TARGET_WINDOW_HOURS || 48) * 60 * MINUTE;

const LIST_LIMIT_DEFAULT = 200;
const LIST_LIMIT_MAX = 500;

/* ── small helpers, in the house style ─────────────────────────────────────── */

const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

// Who did this. The same fallback ladder canvasLayoutRoutes uses for its audit
// identity — EmployeeAuthMiddleware sets req.user, other chains set req.employee.
const actorOf = (req) =>
  req.user?.name || req.user?.email || req.employee?.identityId || req.employee?._id?.toString() || "unknown";

const actorIdOf = (req) =>
  req.user?.employeeId || req.user?.id || req.user?.email || req.employee?._id?.toString() || "";

/**
 * ?date=YYYY-MM-DD into an IST shift bucket.
 * shiftDateFor, never setHours(0,0,0,0) — the process timezone would move the
 * bucket 5h30m and every query below would miss its documents.
 */
const resolveShiftDate = (raw) => {
  if (!raw) return currentShiftDate();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return shiftDateFor(parsed);
};

/**
 * A window bound. Accepts a full ISO instant, or "HH:MM" read as IST wall clock
 * against the shift day — the idiom scannerDashboardRoutes.js:178-186 already
 * uses. getHours()/setHours() are never involved: they read the process
 * timezone, which is exactly the bug this offset arithmetic avoids.
 */
function parseBound(raw, shiftDate) {
  if (raw == null || raw === "") return null;
  const s = String(raw).trim();

  const hhmm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h > 23 || m > 59) return null;
    if (!shiftDate) return null;
    return new Date(shiftDate.getTime() + (h * 60 + m) * MINUTE);
  }

  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/* ── shaping a target for the wire ─────────────────────────────────────────── */

/** Who or what this target is about, in one place, for every response. */
function subjectOf(t) {
  if (t.scope === "machine") {
    return {
      kind: "machine",
      label: t.machineName || String(t.machineId || ""),
      machineId: t.machineId ? String(t.machineId) : null,
      machineName: t.machineName || null,
    };
  }
  if (t.scope === "operator") {
    return {
      kind: "operator",
      label: t.operatorName || t.operatorId || "",
      operatorId: t.operatorId || null,
      operatorIds: t.operatorIds || [],
      operatorName: t.operatorName || null,
    };
  }
  if (t.scope === "operation") {
    return {
      kind: "operation",
      label: t.operationName ? `${t.operationCode} — ${t.operationName}` : t.operationCode || "",
      operationCode: t.operationCode || null,
      operationName: t.operationName || null,
    };
  }
  if (t.scope === "shift") {
    return { kind: "shift", label: "Whole floor" };
  }

  const g = t.group || {};
  const label =
    g.kind === "machineType"
      ? `Machines of type "${g.machineType}"`
      : g.kind === "location"
      ? `Machines at "${g.location}"`
      : `${(g.machineIds || []).length} selected machines`;
  return {
    kind: "group",
    label,
    groupKind: g.kind || null,
    machineType: g.machineType || null,
    location: g.location || null,
    machineIds: (g.machineIds || []).map(String),
    // Repeated on every read: this is the sentence that stops a "line" being
    // implied where the database has none.
    groupedBy:
      g.kind === "machineType"
        ? "Machine.type on the machine register"
        : g.kind === "location"
        ? "Machine.location text on the machine register"
        : "an explicit machine list chosen when the target was set",
    resolvedNote: g.resolvedNote || "",
  };
}

function targetRow(t, evaluation) {
  return {
    targetId: String(t._id),
    scope: t.scope,
    subject: subjectOf(t),

    targetPieces: t.targetPieces,
    windowStart: t.windowStart,
    windowEnd: t.windowEnd,
    shiftDate: t.shiftDate,

    assignedBy: t.assignedBy || null,
    assignedByName: t.assignedByName || null,
    assignedAt: t.assignedAt || null,
    note: t.note || "",

    status: t.status,
    cancelledAt: t.cancelledAt || null,
    cancelledBy: t.cancelledBy || null,
    cancelReason: t.cancelReason || null,

    settled: !!t.settledAt,
    settledAt: t.settledAt || null,
    settledReason: t.settledReason || null,

    evaluation: evaluation || null,
  };
}

/** The history row, with exactly the columns the floor asked to see. */
function historyRow(t) {
  const e = evaluator.evaluationFromSettled(t);
  return {
    targetId: String(t._id),
    scope: t.scope,
    subject: subjectOf(t),

    // "which operation" is a column in its own right even for a machine target,
    // because a machine target run against a station carrying one operation is
    // in practice a target for that operation and the floor reads it that way.
    operationCode: t.operationCode || null,
    operationName: t.operationName || null,

    targetPieces: t.targetPieces,
    windowStart: t.windowStart,
    windowEnd: t.windowEnd,
    shiftDate: t.shiftDate,

    assignedBy: t.assignedBy || null,
    assignedByName: t.assignedByName || null,
    assignedAt: t.assignedAt || null,
    note: t.note || "",

    status: t.status,
    finalStatus: t.finalStatus,
    actualPieces: t.finalActualPieces,
    achievementPercent: t.finalAchievementPercent,
    achievedAt: t.achievedAt || null,
    // null when it was never achieved — an em-dash, not a misleading false.
    completedOnTime: t.completedOnTime,
    settledAt: t.settledAt,
    settledReason: t.settledReason,
    basis: t.settledBasis || "",
    scanEvents: t.settledScanEvents,
    timeRecoveredScans: t.settledTimeRecoveredScans,
    caveats: e.caveats,
  };
}

function summariseStates(evaluations) {
  const counts = Object.fromEntries(TARGET_STATES.map((s) => [s, 0]));
  for (const e of evaluations) {
    if (e && counts[e.state] != null) counts[e.state]++;
  }
  return counts;
}

/* ── scope validation: the whole of the create/edit contract ───────────────── */

/**
 * Turn a request body into the scope fields of a target, or an error sentence.
 * Every id is resolved against the register HERE so the stored target carries
 * real names, and so a typo fails at creation rather than reading zero forever.
 */
async function buildScope(body) {
  const scope = String(body.scope || "").trim();
  if (!TARGET_SCOPES.includes(scope)) {
    return { error: `scope must be one of: ${TARGET_SCOPES.join(", ")}.` };
  }

  const warnings = [];

  if (scope === "shift") {
    return { fields: { scope }, warnings };
  }

  if (scope === "machine") {
    const machineObjId = toObjectId(body.machineId);
    if (!machineObjId) return { error: "A valid machineId is required for a machine target." };
    const machine = await Machine.findById(machineObjId, { name: 1 }).lean();
    if (!machine) return { error: "That machine is not in the machine register." };
    return { fields: { scope, machineId: machineObjId, machineName: machine.name || "" }, warnings };
  }

  if (scope === "operator") {
    // ProductionEvent.operatorId is a badge STRING, and the badge may carry
    // either Employee.identityId or Employee.biometricId. There is no reverse
    // resolver anywhere in this codebase, so one is built here: store BOTH ids
    // or the actual silently reads zero for half the workforce.
    let employee = null;
    if (body.employeeId && toObjectId(body.employeeId)) {
      employee = await Employee.findById(toObjectId(body.employeeId), {
        identityId: 1,
        biometricId: 1,
        firstName: 1,
        lastName: 1,
      }).lean();
    }
    const badge = String(body.operatorId || "").trim();
    if (!employee && badge) {
      employee = await Employee.findOne(
        { $or: [{ identityId: badge }, { biometricId: badge }] },
        { identityId: 1, biometricId: 1, firstName: 1, lastName: 1 }
      ).lean();
    }
    if (!employee && !badge) {
      return { error: "An operator target needs an employeeId or an operatorId (badge id)." };
    }

    const ids = employee
      ? [employee.identityId, employee.biometricId].map((s) => String(s || "").trim()).filter(Boolean)
      : [badge];
    if (!ids.length) {
      return { error: "That employee has neither an identityId nor a biometricId, so no scan can be attributed to them." };
    }
    if (!employee) {
      warnings.push(
        `Badge "${badge}" is not in the employee register. The target will still count scans carrying that id, ` +
          "but no name can be shown against it."
      );
    }

    return {
      fields: {
        scope,
        operatorId: ids[0],
        operatorIds: ids,
        operatorName: employee ? `${employee.firstName || ""} ${employee.lastName || ""}`.trim() : "",
      },
      warnings,
    };
  }

  if (scope === "operation") {
    const code = String(body.operationCode || "").trim();
    if (!code) return { error: "An operation target needs an operationCode." };
    // The join to ProductionEvent.activeOps is an EXACT, case-sensitive string
    // match — Operation.operationCode is neither unique nor uppercased and the
    // device's codes are only trimmed at ingest. A lookup that misses is worth
    // saying out loud; it is not worth refusing, because a code can legitimately
    // be running on a machine before it reaches the registry.
    const op = await Operation.findOne({ operationCode: code }, { name: 1, operationCode: 1 }).lean();
    if (!op) {
      warnings.push(
        `Operation code "${code}" is not in the operation registry. Scans are matched on the exact, ` +
          "case-sensitive code, so check the spelling if the actual stays at zero."
      );
    }
    return { fields: { scope, operationCode: code, operationName: op?.name || "" }, warnings };
  }

  // group
  const g = body.group || {};
  const kind = String(g.kind || "").trim();
  if (!GROUP_KINDS.includes(kind)) {
    return { error: `group.kind must be one of: ${GROUP_KINDS.join(", ")}.` };
  }

  if (kind === "machineList") {
    const raw = Array.isArray(g.machineIds) ? g.machineIds : [];
    const ids = raw.map(toObjectId).filter(Boolean);
    if (!ids.length) return { error: "A machine-list target needs at least one machineId." };
    if (ids.length !== raw.length) return { error: "One or more machineIds are not valid ids." };
    const found = await Machine.find({ _id: { $in: ids } }, { name: 1 }).lean();
    if (found.length !== ids.length) {
      return { error: "One or more of those machines are not in the machine register." };
    }
    return {
      fields: {
        scope: "group",
        group: {
          kind,
          machineIds: ids,
          resolvedMachineIds: ids,
          resolvedAt: new Date(),
          resolvedNote: `${ids.length} machine${ids.length === 1 ? "" : "s"} named explicitly when the target was set`,
        },
      },
      warnings,
    };
  }

  const field = kind === "machineType" ? "type" : "location";
  const wanted = String((kind === "machineType" ? g.machineType : g.location) || "").trim();
  if (!wanted) return { error: `group.${kind === "machineType" ? "machineType" : "location"} is required.` };

  const matches = await Machine.find({ [field]: wanted }, { _id: 1 }).lean();
  if (!matches.length) {
    // Refused rather than warned: a group covering nothing can only ever report
    // zero produced, which reads as a failing line instead of a bad scope.
    return {
      error:
        `No machine in the register has ${field} "${wanted}". ` +
        `There is no line or section entity in this system — a group is built on Machine.type, ` +
        `Machine.location or an explicit machine list, so the text must match the register exactly.`,
    };
  }
  const ids = matches.map((m) => m._id);

  return {
    fields: {
      scope: "group",
      group: {
        kind,
        machineType: kind === "machineType" ? wanted : "",
        location: kind === "location" ? wanted : "",
        machineIds: [],
        resolvedMachineIds: ids,
        resolvedAt: new Date(),
        resolvedNote:
          `${ids.length} machine${ids.length === 1 ? "" : "s"} whose Machine.${field} reads "${wanted}"`,
      },
    },
    warnings,
  };
}

/** Window + pieces validation, shared by create and edit. */
function buildWindow(body, existing) {
  const dateRaw = body.date || (existing ? existing.shiftDate : null);
  const anchorShiftDate = resolveShiftDate(dateRaw);
  if (!anchorShiftDate) return { error: "Invalid date." };

  const startRaw = body.start ?? body.windowStart;
  const endRaw = body.end ?? body.windowEnd;

  const windowStart =
    startRaw != null && startRaw !== ""
      ? parseBound(startRaw, anchorShiftDate)
      : existing
      ? new Date(existing.windowStart)
      : null;
  const windowEnd =
    endRaw != null && endRaw !== ""
      ? parseBound(endRaw, anchorShiftDate)
      : existing
      ? new Date(existing.windowEnd)
      : null;

  if (!windowStart) return { error: "A window start is required — an ISO instant or HH:MM on the shift day." };
  if (!windowEnd) return { error: "A window end is required — an ISO instant or HH:MM on the shift day." };
  if (windowEnd.getTime() <= windowStart.getTime()) {
    return { error: "The window end must be after its start." };
  }
  if (windowEnd.getTime() - windowStart.getTime() > MAX_WINDOW_MS) {
    return { error: `A target window cannot be longer than ${Math.round(MAX_WINDOW_MS / (60 * MINUTE))} hours.` };
  }

  // The shift day the window OPENS in. A window that runs past IST midnight
  // still belongs to the day it started; the evaluator bounds its scan query
  // across both buckets, so nothing is lost.
  const shiftDate = shiftDateFor(windowStart);
  if (!shiftDate) return { error: "Could not bucket that window into a shift day." };

  let targetPieces = existing ? existing.targetPieces : null;
  if (body.targetPieces != null && body.targetPieces !== "") {
    targetPieces = Number(body.targetPieces);
  }
  if (!Number.isFinite(targetPieces) || !Number.isInteger(targetPieces) || targetPieces < 1) {
    return { error: "targetPieces must be a whole number of garments, at least 1." };
  }
  if (targetPieces > MAX_TARGET_PIECES) {
    return { error: `targetPieces cannot be more than ${MAX_TARGET_PIECES}.` };
  }

  return { windowStart, windowEnd, shiftDate, targetPieces };
}

/* ═══ POST / — set a target ════════════════════════════════════════════════ */
router.post("/", async (req, res) => {
  try {
    const body = req.body || {};

    const scoped = await buildScope(body);
    if (scoped.error) return res.status(400).json({ success: false, message: scoped.error });

    const win = buildWindow(body, null);
    if (win.error) return res.status(400).json({ success: false, message: win.error });

    const note = String(body.note || "").trim();
    if (note.length > 500) {
      return res.status(400).json({ success: false, message: "Keep the note under 500 characters." });
    }

    const doc = await ProductionTarget.create({
      ...scoped.fields,
      targetPieces: win.targetPieces,
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      shiftDate: win.shiftDate,
      assignedBy: actorIdOf(req),
      assignedByName: actorOf(req),
      assignedAt: new Date(),
      note,
      status: "active",
    });

    const target = doc.toObject();
    const evaluation = await evaluator.evaluateTarget(target);

    return res.status(201).json({
      success: true,
      generatedAt: new Date(),
      message: "Target set",
      warnings: scoped.warnings,
      target: targetRow(target, evaluation),
    });
  } catch (error) {
    console.error("[ProductionTarget/create] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ GET /live — every active target for a day, one scan query ════════════ */
//
// The endpoint the floor view polls. Whatever the number of open targets, the
// evaluator reads the union window ONCE and partitions it in memory; a query
// per target would hammer the largest collection in the database every few
// seconds. Closed-but-unsettled targets in the result are settled on the way
// past — that is the whole of the settling mechanism, no cron anywhere.
router.get("/live", async (req, res) => {
  try {
    const shiftDate = resolveShiftDate(req.query.date);
    if (!shiftDate) return res.status(400).json({ success: false, message: "Invalid date." });

    const targets = await ProductionTarget.find({ shiftDate, status: "active" })
      .sort({ windowStart: 1 })
      .lean();

    const { evaluations, scanEvents, settledCount, queryWindow } = await evaluator.evaluateTargets(targets);

    const rows = targets.map((t) => targetRow(t, evaluations.get(String(t._id)) || null));

    return res.json({
      success: true,
      generatedAt: new Date(),
      shiftDate,
      count: rows.length,
      summary: {
        byState: summariseStates(rows.map((r) => r.evaluation)),
        targetPieces: rows.reduce((n, r) => n + (r.targetPieces || 0), 0),
        // Deliberately NOT called "floor production". These are per-target
        // actuals and several targets can cover the same garment; adding them
        // up is a total of target attainment, not of garments made.
        actualPiecesAcrossTargets: rows.reduce((n, r) => n + (r.evaluation?.actualPieces || 0), 0),
        actualsNote:
          "actualPiecesAcrossTargets sums each target's own actual. Targets can overlap, so this is not " +
          "a count of garments made on the floor.",
      },
      query: {
        scanEventsRead: scanEvents,
        settledThisCall: settledCount,
        window: queryWindow,
        shiftTimezoneOffsetMinutes: SHIFT_TZ_OFFSET_MIN,
      },
      targets: rows,
    });
  } catch (error) {
    console.error("[ProductionTarget/live] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ GET /history — settled targets, as a record ══════════════════════════ */
router.get("/history", async (req, res) => {
  try {
    const filter = {};

    if (req.query.date) {
      const shiftDate = resolveShiftDate(req.query.date);
      if (!shiftDate) return res.status(400).json({ success: false, message: "Invalid date." });
      filter.shiftDate = shiftDate;
    } else if (req.query.from || req.query.to) {
      const from = req.query.from ? resolveShiftDate(req.query.from) : null;
      const to = req.query.to ? resolveShiftDate(req.query.to) : null;
      if ((req.query.from && !from) || (req.query.to && !to)) {
        return res.status(400).json({ success: false, message: "Invalid date range." });
      }
      filter.shiftDate = {};
      if (from) filter.shiftDate.$gte = from;
      if (to) filter.shiftDate.$lte = to;
    }

    if (req.query.scope) {
      if (!TARGET_SCOPES.includes(String(req.query.scope))) {
        return res.status(400).json({ success: false, message: `scope must be one of: ${TARGET_SCOPES.join(", ")}.` });
      }
      filter.scope = String(req.query.scope);
    }
    if (req.query.machineId) {
      const id = toObjectId(req.query.machineId);
      if (!id) return res.status(400).json({ success: false, message: "Invalid machineId." });
      filter.machineId = id;
    }
    if (req.query.operatorId) filter.operatorIds = String(req.query.operatorId).trim();
    if (req.query.operationCode) filter.operationCode = String(req.query.operationCode).trim();
    /* The sweep below has to run BEFORE finalStatus is added to the filter: an
       unsettled target has finalStatus null by definition, so a history request
       narrowed to "achieved" would match none of them and they would never get
       settled at all. */
    const sweepFilter = { ...filter };

    if (req.query.finalStatus) {
      if (!TARGET_STATES.includes(String(req.query.finalStatus))) {
        return res.status(400).json({ success: false, message: `finalStatus must be one of: ${TARGET_STATES.join(", ")}.` });
      }
      filter.finalStatus = String(req.query.finalStatus);
    }

    const limit = Math.min(Number(req.query.limit) || LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);

    /* Settle anything whose window closed and was never written down, before
       reading the history — otherwise a target nobody had open at 6pm would be
       missing from its own day's record. This is the lazy settle: one extra
       query on the rare day it finds work, and none at all once caught up. */
    const stale = await ProductionTarget.find({
      ...sweepFilter,
      settledAt: null,
      status: "active",
      windowEnd: { $lte: new Date() },
    })
      .limit(LIST_LIMIT_MAX)
      .lean();
    let settledThisCall = 0;
    if (stale.length) {
      const { settledCount } = await evaluator.evaluateTargets(stale);
      settledThisCall = settledCount;
    }

    const rows = await ProductionTarget.find({ ...filter, settledAt: { $ne: null } })
      .sort({ settledAt: -1 })
      .limit(limit)
      .lean();

    const history = rows.map(historyRow);
    const achieved = history.filter((r) => r.finalStatus === "achieved" || r.finalStatus === "exceeded");
    const onTime = history.filter((r) => r.completedOnTime === true);

    return res.json({
      success: true,
      generatedAt: new Date(),
      count: history.length,
      limit,
      truncated: history.length === limit,
      settledThisCall,
      summary: {
        settled: history.length,
        achievedOrExceeded: achieved.length,
        completedOnTime: onTime.length,
        byFinalStatus: summariseStates(history.map((r) => ({ state: r.finalStatus }))),
      },
      notes: {
        settled:
          "Every figure here was written once when the target's window closed and is never recomputed, " +
          "so a scan arriving late cannot change what the floor was told at the time.",
        completedOnTime:
          "null means the target was never reached, so there is no completion to time. It is not a false.",
      },
      history,
    });
  } catch (error) {
    console.error("[ProductionTarget/history] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ GET / — list ════════════════════════════════════════════════════════ */
router.get("/", async (req, res) => {
  try {
    const filter = {};

    // No date at all means "every day" — a supervisor looking for a target they
    // set yesterday should not have to guess which day it was on.
    if (req.query.date) {
      const shiftDate = resolveShiftDate(req.query.date);
      if (!shiftDate) return res.status(400).json({ success: false, message: "Invalid date." });
      filter.shiftDate = shiftDate;
    }

    if (req.query.scope) {
      if (!TARGET_SCOPES.includes(String(req.query.scope))) {
        return res.status(400).json({ success: false, message: `scope must be one of: ${TARGET_SCOPES.join(", ")}.` });
      }
      filter.scope = String(req.query.scope);
    }

    const status = String(req.query.status || "all");
    if (!["all", "active", "cancelled", "settled", "open"].includes(status)) {
      return res
        .status(400)
        .json({ success: false, message: "status must be one of: all, active, cancelled, settled, open." });
    }
    if (status === "active") filter.status = "active";
    if (status === "cancelled") filter.status = "cancelled";
    if (status === "settled") filter.settledAt = { $ne: null };
    if (status === "open") {
      filter.status = "active";
      filter.settledAt = null;
    }

    if (req.query.machineId) {
      const id = toObjectId(req.query.machineId);
      if (!id) return res.status(400).json({ success: false, message: "Invalid machineId." });
      filter.machineId = id;
    }
    if (req.query.operatorId) filter.operatorIds = String(req.query.operatorId).trim();
    if (req.query.operationCode) filter.operationCode = String(req.query.operationCode).trim();

    const limit = Math.min(Number(req.query.limit) || LIST_LIMIT_DEFAULT, LIST_LIMIT_MAX);

    const targets = await ProductionTarget.find(filter)
      .sort({ shiftDate: -1, windowStart: 1 })
      .limit(limit)
      .lean();

    // Evaluation is OPT-IN. The list is often a management screen that wants
    // the terms of the target, not a scan read; /live is the polling endpoint.
    const wantEval = String(req.query.evaluate || "") === "1" || req.query.evaluate === "true";
    let evaluations = new Map();
    if (wantEval && targets.length) {
      ({ evaluations } = await evaluator.evaluateTargets(targets));
    }

    let rows = targets.map((t) => targetRow(t, evaluations.get(String(t._id)) || null));

    // A state filter only means anything once there are evaluations to filter.
    if (req.query.state) {
      if (!TARGET_STATES.includes(String(req.query.state))) {
        return res.status(400).json({ success: false, message: `state must be one of: ${TARGET_STATES.join(", ")}.` });
      }
      if (!wantEval) {
        return res
          .status(400)
          .json({ success: false, message: "Filtering by state needs evaluate=1 — the state is computed, not stored." });
      }
      rows = rows.filter((r) => r.evaluation && r.evaluation.state === String(req.query.state));
    }

    return res.json({
      success: true,
      generatedAt: new Date(),
      count: rows.length,
      limit,
      truncated: targets.length === limit,
      evaluated: wantEval,
      targets: rows,
    });
  } catch (error) {
    console.error("[ProductionTarget/list] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ GET /:targetId — one target, live ═══════════════════════════════════ */
router.get("/:targetId", async (req, res) => {
  try {
    const id = toObjectId(req.params.targetId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid targetId." });

    const target = await ProductionTarget.findById(id).lean();
    if (!target) return res.status(404).json({ success: false, message: "Target not found" });

    // Settles here if the window has closed — see the /live header.
    const evaluation = await evaluator.evaluateTarget(target);
    const fresh = evaluation && evaluation.frozen ? await ProductionTarget.findById(id).lean() : target;

    return res.json({
      success: true,
      generatedAt: new Date(),
      shiftDate: target.shiftDate,
      target: targetRow(fresh || target, evaluation),
      definitions: {
        states: {
          not_started: "the window has not opened, or it has and no time has elapsed yet",
          on_track: "the observed rate finishes what is left in the time left",
          behind: "the observed rate cannot finish what is left in the time left",
          achieved: "actual pieces reached the target",
          exceeded: "actual pieces went past the target",
        },
        actual:
          "distinct garments (barcode + sorted operation set) counted from ProductionEvent scans inside the " +
          "window — the same key the 60-second rollup uses. Never entered by hand.",
      },
    });
  } catch (error) {
    console.error("[ProductionTarget/get] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ PATCH /:targetId — edit ═════════════════════════════════════════════ */
//
// Pieces, window and note only. The SCOPE is not editable: changing who a
// target is about turns it into a different target, and the history row would
// then describe work that was never aimed at that machine or person. Cancel it
// and set another.
router.patch("/:targetId", async (req, res) => {
  try {
    const id = toObjectId(req.params.targetId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid targetId." });

    const target = await ProductionTarget.findById(id).lean();
    if (!target) return res.status(404).json({ success: false, message: "Target not found" });

    if (target.settledAt) {
      return res.status(409).json({
        success: false,
        message: "This target has settled. Its result is a record of what the floor was told and cannot be edited.",
      });
    }
    if (target.status === "cancelled") {
      return res.status(409).json({ success: false, message: "This target was cancelled and cannot be edited." });
    }

    const body = req.body || {};
    if (body.scope || body.machineId || body.operatorId || body.employeeId || body.operationCode || body.group) {
      return res.status(400).json({
        success: false,
        message: "A target's scope cannot be changed. Cancel this one and set a new target instead.",
      });
    }

    const win = buildWindow(body, target);
    if (win.error) return res.status(400).json({ success: false, message: win.error });

    const update = {
      targetPieces: win.targetPieces,
      windowStart: win.windowStart,
      windowEnd: win.windowEnd,
      shiftDate: win.shiftDate,
    };
    if (body.note != null) {
      const note = String(body.note).trim();
      if (note.length > 500) {
        return res.status(400).json({ success: false, message: "Keep the note under 500 characters." });
      }
      update.note = note;
    }

    // Guarded on settledAt so an edit cannot land on a target that settled
    // between the read above and this write.
    const result = await ProductionTarget.findOneAndUpdate(
      { _id: id, settledAt: null, status: "active" },
      { $set: update },
      { new: true }
    ).lean();

    if (!result) {
      return res
        .status(409)
        .json({ success: false, message: "That target settled or was cancelled while this edit was in flight." });
    }

    const evaluation = await evaluator.evaluateTarget(result);

    return res.json({
      success: true,
      generatedAt: new Date(),
      message: "Target updated",
      target: targetRow(result, evaluation),
    });
  } catch (error) {
    console.error("[ProductionTarget/edit] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

/* ═══ POST /:targetId/cancel ══════════════════════════════════════════════ */
//
// Never a delete. A target that stood on the floor for three hours happened,
// and the history has to be able to say so — including what was actually made
// while it stood, which is why cancelling settles it at the moment of cancel
// rather than leaving an open row nobody will ever close.
router.post("/:targetId/cancel", async (req, res) => {
  try {
    const id = toObjectId(req.params.targetId);
    if (!id) return res.status(400).json({ success: false, message: "Invalid targetId." });

    const reason = String(req.body?.reason || "").trim();
    if (reason.length > 300) {
      return res.status(400).json({ success: false, message: "Keep the cancellation reason under 300 characters." });
    }

    const cancelledAt = new Date();
    const target = await ProductionTarget.findOneAndUpdate(
      { _id: id, status: "active" },
      { $set: { status: "cancelled", cancelledAt, cancelledBy: actorOf(req), cancelReason: reason } },
      { new: true }
    ).lean();

    if (!target) {
      const exists = await ProductionTarget.findById(id).lean();
      if (!exists) return res.status(404).json({ success: false, message: "Target not found" });
      return res.status(409).json({ success: false, message: "That target was already cancelled." });
    }

    // Freeze what was made while it stood. windowFor() clips the window to
    // cancelledAt, so nothing produced afterwards is credited to it.
    const evaluation = await evaluator.settleOnCancel(target, { now: cancelledAt });
    const fresh = await ProductionTarget.findById(id).lean();

    return res.json({
      success: true,
      generatedAt: new Date(),
      message: "Target cancelled",
      target: targetRow(fresh || target, evaluation),
    });
  } catch (error) {
    console.error("[ProductionTarget/cancel] error:", error);
    return res.status(500).json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
