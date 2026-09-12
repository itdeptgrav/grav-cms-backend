"use strict";

// services/production/targetEvaluator.js
//
// Compares a stored ProductionTarget against what the floor ACTUALLY made, by
// counting real scans.
//
// THE ONE RULE THIS FILE EXISTS TO KEEP
// The actual is never typed in, never estimated, never derived from an
// efficiency percentage. It is countDistinctPieces() over ProductionEvent rows
// whose scanTime falls inside the target's window and whose scope matches. The
// piece key (barcodeId + sorted activeOps) is IMPORTED from rollupStats, not
// restated here — rollupStats.js:785-789 was written for exactly this caller.
// Two copies of that key would drift the first time one of them changed, and
// the target screen would then disagree with the machine tile beside it.
//
// WHY THE ACTUAL CAN DISAGREE WITH THE ROLLUP, LEGITIMATELY
// · A raw machine-window count INCLUDES scans with no resolvable operator.
//   MachineDayStats.totalPieces excludes them (rollupStats.js:283-288 counts
//   them as orphanScans and drops them). Over a whole shift day this count can
//   therefore be HIGHER than the rollup's for the same machine.
// · For a GROUP, the union is not the sum. One garment that crossed two
//   machines in the set under the same operation set is ONE piece in the union
//   and one piece on EACH machine in the rollup. A line total that is lower
//   than its machines added up is correct, not a bug.
// Both are reported as caveats on the figure rather than left to be discovered.
//
// SETTLING IS LAZY, ON READ — THERE IS NO CRON
// When a window closes, the first read that notices writes the result once,
// guarded by `{ settledAt: null }` so two concurrent readers cannot both write
// it. A cron would be a second moving part to run, monitor and get wrong on a
// machine that was switched off overnight; the floor view polls this code every
// few seconds anyway, and a target nobody ever looks at settles the moment
// somebody does. Once settled, every read returns the STORED numbers — they
// must never move again, whatever arrives in the event stream afterwards.

const mongoose = require("mongoose");

const ProductionEvent = require("../../models/CMS_Models/Manufacturing/Production/Barcode/ProductionEvent");
const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
const ProductionTarget = require("../../models/CMS_Models/Manufacturing/Production/ProductionTarget");

const { shiftDateFor } = require("../barcodeScanner/shift");
// The single authority for "how many garments is this?". Imported, never copied.
const { countDistinctPieces, pieceKeyOf } = require("../barcodeScanner/rollupStats");

const MS_PER_HOUR = 60 * 60 * 1000;

const TARGET_STATES = ProductionTarget.TARGET_STATES;

const round1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);

/* Only the fields the count and the caveats need. The projection matters: a
   busy day is tens of thousands of events and the bulk endpoint pulls the union
   window in one go. */
const SCAN_PROJECTION = {
  barcodeId: 1,
  activeOps: 1,
  scanTime: 1,
  machineId: 1,
  operatorId: 1,
  timeRecovered: 1,
  _id: 0,
};

const asId = (v) => (v == null ? null : String(v));

/* ────────────────────────────────────────────────────────────────────────────
   WINDOWS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The instants a target is measured between.
 *
 * A CANCELLED target stops accruing at the moment it was cancelled, not at its
 * original end — the supervisor called it off, so counting work done afterwards
 * against it would credit the target for production nobody was aiming at.
 */
function windowFor(target) {
  const start = new Date(target.windowStart);
  const end = new Date(target.windowEnd);
  let effectiveEnd = end;
  if (target.status === "cancelled" && target.cancelledAt) {
    const c = new Date(target.cancelledAt);
    if (c.getTime() < end.getTime()) effectiveEnd = c;
  }
  return { start, end, effectiveEnd };
}

/**
 * shiftDate bounds for a scanTime window.
 *
 * Every ProductionEvent index leads with shiftDate; there is NO index on
 * scanTime alone. A window query without a shiftDate bound collection-scans the
 * append-only events collection. shiftDate is derived from scanTime at ingest
 * (scannerIngestRoutes.js:77-84) so the two can never disagree and this bound
 * loses nothing. When the window sits inside one IST day it collapses to an
 * equality, which is an exact index prefix.
 */
function shiftDateBoundFor(from, to) {
  const a = shiftDateFor(from);
  // -1ms: the window is half-open [from, to), so an event exactly at `to` is
  // not ours and neither is its shift day if that is all that reaches into it.
  const b = shiftDateFor(new Date(new Date(to).getTime() - 1));
  if (!a || !b) return null;
  if (a.getTime() === b.getTime()) return a;
  return { $gte: a, $lte: b };
}

/* ────────────────────────────────────────────────────────────────────────────
   SCOPE RESOLUTION
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Turn a target's scope into something a scan can be tested against, and a
 * sentence saying how it was decided.
 *
 * `machines` is the machine register, passed in so the bulk path reads it once
 * for a hundred targets instead of once each. Pass null and a group target
 * resolved by type/location reports that it could not be resolved rather than
 * quietly covering nothing.
 */
function resolveScope(target, machines) {
  const base = {
    scope: target.scope,
    machineIds: null, // null = no machine restriction
    operatorIds: null,
    operationCode: null,
    note: "",
    group: null,
  };

  if (target.scope === "machine") {
    const id = asId(target.machineId);
    return {
      ...base,
      machineIds: id ? [id] : [],
      note: `machine ${target.machineName || id || "(unknown)"}`,
    };
  }

  if (target.scope === "operator") {
    // Both badge forms. The device sends whichever id the badge physically
    // carries and they differ by real characters (GR045 vs GR0045).
    const ids = (target.operatorIds && target.operatorIds.length
      ? target.operatorIds
      : [target.operatorId]
    )
      .map((s) => String(s || "").trim())
      .filter(Boolean);
    return {
      ...base,
      operatorIds: ids,
      note: `operator ${target.operatorName || ids.join(" / ") || "(unknown)"}`,
    };
  }

  if (target.scope === "operation") {
    const code = String(target.operationCode || "").trim();
    return {
      ...base,
      operationCode: code,
      note: `operation ${code}${target.operationName ? ` (${target.operationName})` : ""}`,
    };
  }

  if (target.scope === "shift") {
    return {
      ...base,
      note: "the whole floor — every machine, every operator, every operation",
    };
  }

  // group
  const g = target.group || {};
  const frozen = (g.resolvedMachineIds || []).map(asId).filter(Boolean);

  if (g.kind === "machineList") {
    const ids = (g.machineIds || []).map(asId).filter(Boolean);
    return {
      ...base,
      machineIds: ids,
      note: `${ids.length} machine${ids.length === 1 ? "" : "s"} named explicitly when the target was set`,
      group: { kind: g.kind, resolvedNow: ids, frozen, drift: driftOf(frozen, ids) },
    };
  }

  const field = g.kind === "machineType" ? "type" : "location";
  const wanted = String(g.kind === "machineType" ? g.machineType : g.location || "").trim();

  if (!Array.isArray(machines)) {
    // No register to resolve against. Fall back to the set frozen at creation
    // and SAY SO — silently covering nothing would read as "produced 0".
    return {
      ...base,
      machineIds: frozen,
      note:
        `${frozen.length} machine${frozen.length === 1 ? "" : "s"} whose Machine.${field} read ` +
        `"${wanted}" when the target was set (the register was not re-read)`,
      group: { kind: g.kind, resolvedNow: frozen, frozen, drift: null },
    };
  }

  const now = machines
    .filter((m) => String(m[field] || "").trim() === wanted)
    .map((m) => asId(m._id));

  return {
    ...base,
    machineIds: now,
    // The grouping is NAMED, because there is no line entity in this database
    // and the screen must not imply there is one.
    note:
      `${now.length} machine${now.length === 1 ? "" : "s"} whose Machine.${field} reads "${wanted}" ` +
      `— there is no line/section entity in this system, so this is the grouping used`,
    group: { kind: g.kind, resolvedNow: now, frozen, drift: driftOf(frozen, now) },
  };
}

/** Machines that have joined or left a type/location group since it was set. */
function driftOf(frozen, now) {
  if (!frozen || !frozen.length) return null;
  const f = new Set(frozen);
  const n = new Set(now);
  const added = now.filter((id) => !f.has(id));
  const removed = frozen.filter((id) => !n.has(id));
  if (!added.length && !removed.length) return null;
  return { added, removed };
}

/** Does this scan belong to this target? */
function matchesScope(ev, resolved, machineIdSet) {
  if (resolved.machineIds) {
    if (!machineIdSet || !machineIdSet.has(asId(ev.machineId))) return false;
  }
  if (resolved.operatorIds) {
    const op = String(ev.operatorId || "").trim();
    if (!op || !resolved.operatorIds.includes(op)) return false;
  }
  if (resolved.operationCode) {
    const ops = ev.activeOps || [];
    if (!ops.includes(resolved.operationCode)) return false;
  }
  return true;
}

/* ────────────────────────────────────────────────────────────────────────────
   THE COUNT
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The instant the target was reached, from the scan stream itself.
 *
 * Walks the scans in time order accumulating the SAME piece key
 * countDistinctPieces uses, and returns the scanTime of the scan that took the
 * distinct count to targetPieces. null means it was never reached. This is what
 * makes "completed on time" a measured fact rather than an opinion about when
 * somebody looked at the screen.
 */
function achievedAtOf(scans, targetPieces) {
  if (!targetPieces || targetPieces < 1) return null;
  const seen = new Set();
  const ordered = [...scans].sort(
    (a, b) => new Date(a.scanTime).getTime() - new Date(b.scanTime).getTime()
  );
  for (const s of ordered) {
    if (!s.barcodeId) continue; // matches countDistinctPieces exactly
    seen.add(pieceKeyOf(s));
    if (seen.size >= targetPieces) return new Date(s.scanTime);
  }
  return null;
}

/**
 * The five states, exactly as the floor names them.
 *
 *   achieved  actual >= target
 *   exceeded  actual >  target
 *   behind    the observed rate cannot finish what is left in the time left
 *   on_track  it can
 *   not_started  the window has not opened, or it has and no time has elapsed
 *
 * Note that a window which has CLOSED short is `behind` — with no time left,
 * no rate finishes the remainder. That is the honest reading of "behind", and
 * it is what gets frozen into the history row.
 */
function stateOf({ targetPieces, actualPieces, opened, closed, elapsedMs, currentRate, requiredRate }) {
  if (actualPieces > targetPieces) return "exceeded";
  if (actualPieces >= targetPieces) return "achieved";
  if (!opened) return "not_started";
  if (elapsedMs <= 0) return "not_started";
  if (closed) return "behind";
  // Work outstanding and no time left to do it in.
  if (requiredRate == null) return "behind";
  return currentRate >= requiredRate ? "on_track" : "behind";
}

/**
 * Compare one target against a set of scans ALREADY narrowed to its window and
 * scope. Pure — no database, no clock beyond the `now` handed in — so the bulk
 * path and the single-target path cannot compute different answers.
 */
function evaluateFromScans(
  target,
  scans,
  { now = new Date(), resolved = null, windowScans = null, scansAfterNow = 0 } = {}
) {
  const { start, end, effectiveEnd } = windowFor(target);
  const nowMs = new Date(now).getTime();
  const startMs = start.getTime();
  const endMs = effectiveEnd.getTime();

  const opened = nowMs >= startMs;
  const closed = nowMs >= endMs;

  const windowMs = Math.max(0, endMs - startMs);
  const elapsedMs = Math.max(0, Math.min(nowMs, endMs) - startMs);
  const timeRemainingMs = Math.max(0, endMs - nowMs);

  const targetPieces = Number(target.targetPieces) || 0;
  const actualPieces = countDistinctPieces(scans);
  const remainingPieces = Math.max(0, targetPieces - actualPieces);

  const achievementPercent = targetPieces > 0 ? round1((actualPieces / targetPieces) * 100) : null;

  // Rates are compared UNROUNDED so a target does not flap between on_track and
  // behind on the first decimal place; only the reported values are rounded.
  const currentRateRaw = elapsedMs > 0 ? actualPieces / (elapsedMs / MS_PER_HOUR) : null;
  const requiredRateRaw =
    timeRemainingMs > 0 ? remainingPieces / (timeRemainingMs / MS_PER_HOUR) : remainingPieces === 0 ? 0 : null;

  const state = stateOf({
    targetPieces,
    actualPieces,
    opened,
    closed,
    elapsedMs,
    currentRate: currentRateRaw,
    requiredRate: requiredRateRaw,
  });

  const achievedAt = achievedAtOf(scans, targetPieces);
  const onTime = achievedAt ? achievedAt.getTime() <= end.getTime() : null;

  // Honesty counters over the WHOLE window (not just the matched scans), so a
  // scope that saw nothing can still say whether there was anything to see.
  const pool = windowScans || scans;
  const scansWithNoOperator = pool.filter((s) => !String(s.operatorId || "").trim()).length;
  const scansWithNoBarcode = scans.filter((s) => !s.barcodeId).length;
  const timeRecoveredScans = scans.filter((s) => s.timeRecovered).length;

  return {
    frozen: false,
    state,
    targetPieces,
    actualPieces,
    remainingPieces,
    achievementPercent,
    windowStart: start,
    windowEnd: end,
    effectiveWindowEnd: effectiveEnd,
    windowMs,
    elapsedMs,
    timeRemainingMs,
    opened,
    closed,
    currentRatePerHour: round1(currentRateRaw),
    requiredRatePerHour: round1(requiredRateRaw),
    achievedAt,
    onTime,
    evaluatedAt: new Date(now),

    basis: resolved ? resolved.note : "",
    piecesDefinition:
      "distinct garments (barcode + operation set), counted once however many times they were scanned",
    scanEvents: scans.length,
    scansWithNoBarcode,
    timeRecoveredScans,
    scansWithNoOperator,
    // Scans inside the window but timestamped LATER than `now` — a device whose
    // clock runs ahead. Held back rather than hidden; see the caveat.
    scansAfterNow,
    caveats: caveatsFor(target, resolved, {
      scansWithNoOperator,
      scansWithNoBarcode,
      timeRecoveredScans,
      scansAfterNow,
      machineCount: resolved && resolved.machineIds ? resolved.machineIds.length : null,
    }),
  };
}

/**
 * Caveats travel WITH the figure, not in a warning list elsewhere on the page —
 * the same grammar machineIntelligenceRoutes uses for its flags.
 */
function caveatsFor(target, resolved, counts) {
  const out = [];
  if (!resolved) return out;

  if (resolved.machineIds && resolved.machineIds.length === 0) {
    out.push({
      code: "EMPTY_SCOPE",
      severity: "critical",
      label: "This target covers no machines",
      detail:
        "The scope resolved to an empty machine set, so the actual can only ever read 0. " +
        "Check the machine, type or location this target was created against.",
    });
  }

  if (target.scope === "group") {
    out.push({
      code: "UNION_NOT_SUM",
      severity: "info",
      label: "A group total is not the sum of its machines",
      detail:
        "One garment that crossed two machines in this group under the same operation set counts " +
        "ONCE here and once on each machine's own figure. The two will not reconcile, and that is correct.",
    });
    const drift = resolved.group && resolved.group.drift;
    if (drift) {
      out.push({
        code: "SCOPE_DRIFT",
        severity: "warning",
        label: "The machine set has changed since this target was created",
        detail:
          `${drift.added.length} machine(s) have joined and ${drift.removed.length} have left this ` +
          "grouping since then. Machine.type and Machine.location are free text with no history, " +
          "so the figure above is counted over the set as it reads TODAY.",
      });
    }
  }

  if (target.scope === "machine") {
    out.push({
      code: "INCLUDES_UNATTRIBUTED",
      severity: "info",
      label: "Counted straight from the scans",
      detail:
        "This includes scans with no resolvable operator, which the 60-second rollup drops before " +
        "it writes MachineDayStats. Over a whole shift day this figure can therefore read slightly " +
        "higher than the machine tile.",
    });
  }

  if (target.scope === "operator") {
    out.push({
      code: "OPERATOR_ATTRIBUTION",
      severity: counts.scansWithNoOperator > 0 ? "warning" : "info",
      label: "Operator attribution comes from the scan itself",
      detail:
        `${counts.scansWithNoOperator} scan(s) in this window carry no operator id — v5.4.0 firmware ` +
        "did not put one on the event. Those scans cannot be attributed to a person here and are NOT " +
        "counted towards this target, so an operator target under-counts on legacy-firmware data.",
    });
  }

  if (target.scope === "operation") {
    out.push({
      code: "OPERATION_CREDITED_TO_ALL",
      severity: "info",
      label: "A scan credits every operation active on the machine",
      detail:
        "A garment passing a station running two operations completes both, so it counts towards " +
        "each of their targets. This matches how the rollup attributes work; it is not double counting.",
    });
  }

  if (counts.scansWithNoBarcode > 0) {
    out.push({
      code: "SCANS_WITHOUT_BARCODE",
      severity: "info",
      label: `${counts.scansWithNoBarcode} scan(s) carried no ticket`,
      detail:
        "A scan with an empty barcode cannot identify a garment (employee-badge reads land this way) " +
        "and contributes nothing to the count.",
    });
  }

  if (counts.scansAfterNow > 0) {
    out.push({
      code: "SCANS_AHEAD_OF_NOW",
      severity: "warning",
      label: `${counts.scansAfterNow} scan(s) are timestamped later than now`,
      detail:
        "They fall inside this target's window but after the present moment, which means a device clock is " +
        "running ahead. They are NOT counted yet — counting them while dividing by the time elapsed so far " +
        "would report a rate the floor never worked at. They will count as the window catches up to them.",
    });
  }

  if (counts.timeRecoveredScans > 0) {
    out.push({
      code: "TIME_RECOVERED",
      severity: "warning",
      label: `${counts.timeRecoveredScans} scan(s) have a reconstructed timestamp`,
      detail:
        "The device clock was unset when these were read, so their scanTime was reconstructed. They " +
        "landed in this window on that reconstructed time, not on when the garment was actually made.",
    });
  }

  return out;
}

/* ────────────────────────────────────────────────────────────────────────────
   SETTLED TARGETS — STORED, NEVER RECOMPUTED
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * The evaluation of a settled target, built entirely from what was written down
 * when its window closed. Nothing here touches ProductionEvent: a scan that
 * arrives late — a device syncing a backlog, a corrected ingest — must not
 * change what the floor was told at the time.
 *
 * The two rate figures are arithmetic on stored values (pieces ÷ stored window
 * length), not a recount, so they are as frozen as the rest.
 */
function evaluationFromSettled(target) {
  const { start, end, effectiveEnd } = windowFor(target);
  const windowMs = Math.max(0, effectiveEnd.getTime() - start.getTime());
  const targetPieces = Number(target.targetPieces) || 0;
  const actualPieces = target.finalActualPieces == null ? null : Number(target.finalActualPieces);

  return {
    frozen: true,
    settledAt: target.settledAt,
    settledReason: target.settledReason,
    state: target.finalStatus,
    targetPieces,
    actualPieces,
    remainingPieces: actualPieces == null ? null : Math.max(0, targetPieces - actualPieces),
    achievementPercent: target.finalAchievementPercent,
    windowStart: start,
    windowEnd: end,
    effectiveWindowEnd: effectiveEnd,
    windowMs,
    elapsedMs: windowMs,
    timeRemainingMs: 0,
    opened: true,
    closed: true,
    currentRatePerHour:
      actualPieces != null && windowMs > 0 ? round1(actualPieces / (windowMs / MS_PER_HOUR)) : null,
    // Nothing is required of a window that has closed.
    requiredRatePerHour: null,
    achievedAt: target.achievedAt || null,
    onTime: target.completedOnTime,
    evaluatedAt: target.settledAt,
    basis: target.settledBasis || "",
    piecesDefinition:
      "distinct garments (barcode + operation set), counted once however many times they were scanned",
    scanEvents: target.settledScanEvents,
    scansWithNoBarcode: null,
    timeRecoveredScans: target.settledTimeRecoveredScans,
    scansWithNoOperator: null,
    caveats: [
      {
        code: "SETTLED",
        severity: "info",
        label: "This result is final",
        detail:
          "The window has closed and the result was written down once, at " +
          `${target.settledAt ? new Date(target.settledAt).toISOString() : "settlement"}. ` +
          "It is not recomputed, so scans arriving afterwards cannot change it.",
      },
    ],
  };
}

/**
 * Write the result once. Guarded on `settledAt: null` so two readers racing on
 * the same closed window cannot both write — the loser re-reads the winner's
 * numbers rather than overwriting them with its own.
 */
async function settleTarget(target, evaluation, reason = "window_closed") {
  const update = {
    settledAt: new Date(),
    settledReason: reason,
    finalActualPieces: evaluation.actualPieces,
    finalAchievementPercent: evaluation.achievementPercent,
    finalStatus: evaluation.state,
    achievedAt: evaluation.achievedAt || null,
    // null, not false, when it was never achieved — "—" is the honest column.
    completedOnTime: evaluation.achievedAt ? !!evaluation.onTime : null,
    settledBasis: evaluation.basis || "",
    settledScanEvents: evaluation.scanEvents,
    settledTimeRecoveredScans: evaluation.timeRecoveredScans,
  };

  const res = await ProductionTarget.updateOne(
    { _id: target._id, settledAt: null },
    { $set: update }
  );

  if (res.modifiedCount === 1) {
    Object.assign(target, update);
    return { target, settled: true };
  }

  // Somebody settled it first. Their numbers stand.
  const fresh = await ProductionTarget.findById(target._id).lean();
  return { target: fresh || target, settled: false };
}

/* ────────────────────────────────────────────────────────────────────────────
   THE PUBLIC CALLS
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * Evaluate MANY targets with ONE scan query.
 *
 * The floor view polls this. Running a query per target would be N round trips
 * against the largest collection in the database every few seconds, so instead
 * the union window is read once and partitioned in memory. The machineId $in
 * narrowing is only applied when EVERY live target is machine-or-group scoped —
 * an operator, operation or shift target needs the whole floor, and quietly
 * narrowing the query for it would under-count.
 */
async function evaluateTargets(targets, { now = new Date(), settle = true, machines = null } = {}) {
  const list = Array.isArray(targets) ? targets : [];
  const out = new Map();
  if (!list.length) return { evaluations: out, scanEvents: 0, settledCount: 0, queryWindow: null };

  const settledAlready = list.filter((t) => t.settledAt);
  const live = list.filter((t) => !t.settledAt);

  for (const t of settledAlready) out.set(String(t._id), evaluationFromSettled(t));

  if (!live.length) {
    return { evaluations: out, scanEvents: 0, settledCount: 0, queryWindow: null };
  }

  // Resolve scopes first — the group resolution decides whether the query can
  // be narrowed at all.
  const needsRegister = live.some((t) => t.scope === "group");
  let register = machines;
  if (needsRegister && !Array.isArray(register)) {
    register = await Machine.find({}, { name: 1, type: 1, location: 1 }).lean();
  }

  const resolvedById = new Map();
  for (const t of live) resolvedById.set(String(t._id), resolveScope(t, register));

  // Union window.
  let minStart = Infinity;
  let maxEnd = -Infinity;
  for (const t of live) {
    const { start, effectiveEnd } = windowFor(t);
    minStart = Math.min(minStart, start.getTime());
    maxEnd = Math.max(maxEnd, effectiveEnd.getTime());
  }
  const from = new Date(minStart);
  const to = new Date(maxEnd);

  const shiftBound = shiftDateBoundFor(from, to);
  if (!shiftBound) {
    // An unparseable window cannot be queried. Say nothing rather than scanning
    // the whole collection.
    return { evaluations: out, scanEvents: 0, settledCount: 0, queryWindow: null };
  }

  const filter = {
    type: "scan",
    shiftDate: shiftBound,
    // Half-open. $lte would double-count a scan sitting exactly on the boundary
    // between two adjacent windows.
    scanTime: { $gte: from, $lt: to },
  };

  const allMachineScoped = live.every(
    (t) => (t.scope === "machine" || t.scope === "group") && resolvedById.get(String(t._id)).machineIds
  );
  if (allMachineScoped) {
    const union = new Set();
    for (const t of live) {
      for (const id of resolvedById.get(String(t._id)).machineIds || []) union.add(id);
    }
    if (union.size) {
      filter.machineId = { $in: [...union].map((id) => new mongoose.Types.ObjectId(id)) };
    }
  }

  const scans = await ProductionEvent.find(filter, SCAN_PROJECTION).sort({ scanTime: 1 }).lean();

  const nowMs = new Date(now).getTime();

  let settledCount = 0;
  for (const t of live) {
    const key = String(t._id);
    const resolved = resolvedById.get(key);
    const { start, effectiveEnd } = windowFor(t);
    const s = start.getTime();
    const e = effectiveEnd.getTime();

    /* THE COUNTING WINDOW STOPS AT `now`, NOT AT THE WINDOW END.
       A device whose clock runs ahead writes a scanTime in the future. Counting
       those pieces while dividing by the time elapsed SO FAR reports a rate the
       floor never worked at — and can flip a target to "achieved" minutes
       before the work exists. The count and the elapsed time have to describe
       the same interval, so both stop at `now`. Once the window closes the two
       are identical and nothing is held back. The held-back scans are counted
       and reported rather than dropped silently. */
    const countEnd = Math.min(nowMs, e);

    const machineIdSet = resolved.machineIds ? new Set(resolved.machineIds) : null;

    const windowScans = [];
    const matched = [];
    let scansAfterNow = 0;
    for (const ev of scans) {
      const at = new Date(ev.scanTime).getTime();
      if (at < s || at >= e) continue;
      const inScope = matchesScope(ev, resolved, machineIdSet);
      if (at >= countEnd) {
        if (inScope) scansAfterNow++;
        continue;
      }
      windowScans.push(ev);
      if (inScope) matched.push(ev);
    }

    const evaluation = evaluateFromScans(t, matched, { now, resolved, windowScans, scansAfterNow });
    out.set(key, evaluation);

    if (settle && evaluation.closed) {
      const { target: after, settled } = await settleTarget(t, evaluation, "window_closed");
      if (settled) settledCount++;
      out.set(key, evaluationFromSettled(after));
    }
  }

  return {
    evaluations: out,
    scanEvents: scans.length,
    settledCount,
    queryWindow: { from, to, narrowedToMachines: !!filter.machineId },
  };
}

/** One target. Same code path as the bulk call, so they cannot disagree. */
async function evaluateTarget(target, opts = {}) {
  const { evaluations } = await evaluateTargets([target], opts);
  return evaluations.get(String(target._id)) || null;
}

/**
 * Settle a target that is being cancelled, at the instant of cancellation.
 * The caller has already written status/cancelledAt; windowFor() then clips the
 * window to that moment, so the frozen result records what was actually made
 * while the target stood — not what the machine did for the rest of the day.
 */
async function settleOnCancel(target, { now = new Date(), machines = null } = {}) {
  if (target.settledAt) return evaluationFromSettled(target);
  const { evaluations } = await evaluateTargets([target], { now, settle: false, machines });
  const evaluation = evaluations.get(String(target._id));
  if (!evaluation) return null;
  const { target: after } = await settleTarget(target, evaluation, "cancelled");
  return evaluationFromSettled(after);
}

module.exports = {
  TARGET_STATES,
  evaluateTarget,
  evaluateTargets,
  evaluateFromScans,
  evaluationFromSettled,
  settleTarget,
  settleOnCancel,
  resolveScope,
  matchesScope,
  windowFor,
  shiftDateBoundFor,
  achievedAtOf,
  stateOf,
  SCAN_PROJECTION,
};
