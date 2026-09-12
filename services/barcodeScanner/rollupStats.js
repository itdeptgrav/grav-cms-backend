// services/barcodeScanner/rollupStats.js
//
// Full recompute from production_events -> overwrite three read models.
// Runs every 60s. Never reads the read models to patch them: a bug here costs
// one cycle and self-corrects, because the events are untouched.
//
// SAFETY: a shift date with zero events is SKIPPED, never written. Without
// that guard, pointing this job at a historical date would replace a real
// ProductionTracking document with an empty one.

const mongoose = require("mongoose");
const crypto = require("crypto");
const { currentShiftDate, shiftDateFor } = require("./shift");

// A repeat of the same barcode + same operation set by the same operator
// inside this window is an operator rescanning, not a second piece. Matches
// the device-side woHistory behaviour so counts do not jump after migration.
const RESCAN_WINDOW_MS = Number(process.env.RESCAN_WINDOW_SEC || 60) * 1000;

// A gap longer than this is "the machine was stopped", not "worked slowly".
// Keeping them apart is the whole point — they need different responses.
const IDLE_GAP_MS = Number(process.env.IDLE_GAP_SEC || 180) * 1000;

// No scan for this long, with an operator signed in, reads as idle.
const PRODUCING_WINDOW_MS = Number(process.env.PRODUCING_WINDOW_SEC || 300) * 1000;

// No heartbeat for this long means the device is gone, not quiet.
const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_SEC || 180) * 1000;

// ─── Deterministic ids ────────────────────────────────────────────────────────
// The legacy subdocuments carry _id. Regenerating the document every 60s with
// fresh random ids would remount every React list keyed on them, so ids are
// derived from stable inputs instead.
const stableObjectId = (seed) =>
  new mongoose.Types.ObjectId(
    crypto.createHash("sha1").update(String(seed)).digest("hex").slice(0, 24)
  );

const MINUTE = 60 * 1000;
const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);

// Required lazily, inside the function, and not at the top of the file: this
// module is pulled in by server.js at require time, before connectDB() has
// run. Models are registered on the default mongoose connection either way,
// but keeping the list here means a rename shows up as one failing require in
// one place rather than a schema compiled into a half-built process.
function getLocalModels() {
  const P = "../../models/CMS_Models";
  return {
    ProductionEvent: require(`${P}/Manufacturing/Production/Barcode/ProductionEvent`),
    MachineDayStats: require(`${P}/Manufacturing/Production/Barcode/MachineDayStats`),
    OperatorDayStats: require(`${P}/Manufacturing/Production/Barcode/OperatorDayStats`),
    ProductionTracking: require(`${P}/Manufacturing/Production/Tracking/ProductionTracking`),
    DeviceHeartbeat: require(`${P}/Manufacturing/Production/Barcode/DeviceHeartbeat`),
    Employee: require("../../models/Employee"),
    Machine: require(`${P}/Inventory/Configurations/Machine`),
    Operation: require(`${P}/Inventory/Configurations/Operation`),
  };
}

/**
 * operationCode -> target seconds per piece, from the CMS operation registry.
 *
 * durationSeconds is authoritative; totalSam (minutes) is the fallback because
 * the two are maintained separately in the CMS and do occasionally disagree.
 * A code missing from the registry maps to null, never 0 — see toJSON().
 */
async function loadOperationTargets(Operation) {
  if (!Operation) return new Map();
  try {
    const ops = await Operation.find(
      { operationCode: { $nin: [null, ""] } },
      { operationCode: 1, durationSeconds: 1, totalSam: 1 }
    ).lean();

    const map = new Map();
    for (const op of ops) {
      const seconds =
        Number(op.durationSeconds) > 0
          ? Number(op.durationSeconds)
          : Number(op.totalSam) > 0
          ? Number(op.totalSam) * 60
          : null;
      if (seconds) map.set(String(op.operationCode).trim(), seconds);
    }
    return map;
  } catch {
    // Registry not synced yet — efficiency stays null, everything else works.
    return new Map();
  }
}

// ─── Pace accumulator ─────────────────────────────────────────────────────────
// Collects inter-scan gaps for one operation code. Gaps beyond the idle
// threshold are excluded from pace but reported as idle time.
class PaceStats {
  constructor() {
    this.pieces = 0;
    this.gapCount = 0;
    this.gapTotalMs = 0;
    this.minMs = null;
    this.maxMs = null;
    this.idleMs = 0;
  }

  addPiece() {
    this.pieces++;
  }

  addGap(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return;
    if (ms > IDLE_GAP_MS) {
      this.idleMs += ms;
      return;
    }
    this.gapCount++;
    this.gapTotalMs += ms;
    if (this.minMs == null || ms < this.minMs) this.minMs = ms;
    if (this.maxMs == null || ms > this.maxMs) this.maxMs = ms;
  }

  // targetSeconds comes from the Operation registry mirrored from the CMS
  // (durationSeconds, falling back to totalSam minutes). Null when the code is
  // not in the registry — an unknown code must read as "no target", never as
  // zero, or efficiency would silently show 0% for a perfectly good operator.
  toJSON(operationCode, targetSeconds = null) {
    const avg =
      this.gapCount > 0 ? this.gapTotalMs / this.gapCount / 1000 : null;

    return {
      operationCode,
      pieces: this.pieces,
      avgSecondsPerPiece: avg == null ? null : round1(avg),
      minSecondsPerPiece: this.minMs == null ? null : round1(this.minMs / 1000),
      maxSecondsPerPiece: this.maxMs == null ? null : round1(this.maxMs / 1000),
      smvSeconds: targetSeconds,
      // Target ÷ actual. Over 100% means faster than the standard time.
      efficiencyPercent:
        targetSeconds && avg && avg > 0 ? round1((targetSeconds / avg) * 100) : null,
    };
  }
}

// ─── Per-machine walk ─────────────────────────────────────────────────────────
// Sequential, in scanTime order. This is why the event schema has to keep raw
// per-scan timestamps: a counts-only schema cannot produce any of it.
function walkMachine(machineEvents) {
  const sessions = [];
  let current = null;
  let currentOps = [];

  let suppressedRescans = 0;
  let unparseableBarcodes = 0;
  let orphanScans = 0;
  let lastScanAt = null;

  // key -> timestamp of the last accepted scan with that key
  const rescanGuard = new Map();

  const openSession = (operatorId, operatorName, at) => {
    current = {
      operatorId,
      operatorName: operatorName || "",
      signInTime: at,
      signOutTime: null,
      scans: [],
      breakMs: 0,
      openBreakAt: null,
    };
    sessions.push(current);
    return current;
  };

  const closeSession = (at) => {
    if (!current) return;
    if (current.openBreakAt) {
      current.breakMs += Math.max(0, at - current.openBreakAt);
      current.openBreakAt = null;
    }
    current.signOutTime = at;
    current = null;
  };

  for (const ev of machineEvents) {
    const at = new Date(ev.scanTime);

    switch (ev.type) {
      case "signin": {
        if (current) closeSession(at);
        openSession(ev.operatorId, ev.operatorName, at);
        break;
      }

      case "signout": {
        closeSession(at);
        break;
      }

      case "break_start": {
        if (current && !current.openBreakAt) current.openBreakAt = at;
        break;
      }

      case "break_end": {
        if (current && current.openBreakAt) {
          current.breakMs += Math.max(0, at - current.openBreakAt);
          current.openBreakAt = null;
        } else if (current && Number.isFinite(ev.breakDurationSec)) {
          // Device reported a duration but the start event never arrived.
          current.breakMs += ev.breakDurationSec * 1000;
        }
        break;
      }

      case "ops_change": {
        currentOps = Array.isArray(ev.activeOps) ? ev.activeOps : [];
        break;
      }

      case "scan": {
        // v5.5.0 puts operatorId on the scan itself. v5.4.0 did not, so fall
        // back to whoever is signed in — that is exactly the stateful coupling
        // the new firmware removes.
        const operatorId = ev.operatorId || current?.operatorId || "";

        if (!operatorId) {
          orphanScans++;
          break;
        }
        if (!current || current.operatorId !== operatorId) {
          if (current) closeSession(at);
          openSession(operatorId, ev.operatorName, at);
        }

        if (!ev.workOrderKey) unparseableBarcodes++;

        const ops = Array.isArray(ev.activeOps) ? ev.activeOps : [];
        if (ops.length > 0) currentOps = ops;

        const opKey = [...ops].sort().join(",");
        const guardKey = `${operatorId}|${ev.barcodeId}|${opKey}`;
        const previous = rescanGuard.get(guardKey);
        if (previous != null && at - previous <= RESCAN_WINDOW_MS) {
          suppressedRescans++;
          break;
        }
        rescanGuard.set(guardKey, at.getTime());

        current.scans.push({
          eventId: ev.eventId,
          barcodeId: ev.barcodeId,
          timeStamp: at,
          activeOps: ops,
        });

        if (!lastScanAt || at > lastScanAt) lastScanAt = at;
        break;
      }

      default:
        break;
    }
  }

  return {
    sessions,
    currentOps,
    currentSession: current,
    suppressedRescans,
    unparseableBarcodes,
    orphanScans,
    lastScanAt,
  };
}

// Gaps are measured per operation code, per operator, so a machine running two
// operations at once does not average them into nonsense.
function accumulatePace(sessions, target) {
  const lastSeenByOp = new Map();

  for (const session of sessions) {
    for (const scan of session.scans) {
      const ops = scan.activeOps.length > 0 ? scan.activeOps : ["__none__"];
      for (const op of ops) {
        if (!target.has(op)) target.set(op, new PaceStats());
        const stats = target.get(op);
        stats.addPiece();

        const key = `${session.operatorId}|${op}`;
        const previous = lastSeenByOp.get(key);
        if (previous != null) stats.addGap(scan.timeStamp - previous);
        lastSeenByOp.set(key, scan.timeStamp.getTime());
      }
    }
  }
}

function resolveStatus({ heartbeat, currentSession, lastScanAt, now }) {
  if (heartbeat) {
    const age = now - new Date(heartbeat.lastHeartbeatAt).getTime();
    if (age > HEARTBEAT_STALE_MS) return "device_offline";
    if (heartbeat.onBreak) return "on_break";
  }
  if (currentSession?.openBreakAt) return "on_break";
  if (!currentSession) return "no_operator";
  if (lastScanAt && now - lastScanAt.getTime() <= PRODUCING_WINDOW_MS)
    return "producing";
  return "idle";
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function rollupForDate(shiftDate, models) {
  const {
    ProductionEvent,
    MachineDayStats,
    OperatorDayStats,
    ProductionTracking,
    DeviceHeartbeat,
    Employee,
    Machine,
    Operation,
  } = models;

  const events = await ProductionEvent.find({ shiftDate })
    .sort({ machineId: 1, scanTime: 1 })
    .lean();

  // The guard that makes this job safe to run against any date.
  if (events.length === 0) {
    return { shiftDate, skipped: true, reason: "no events" };
  }

  const now = Date.now();
  const opTargets = await loadOperationTargets(Operation);

  const byMachine = new Map();
  const operatorIds = new Set();
  for (const ev of events) {
    const key = String(ev.machineId);
    if (!byMachine.has(key)) byMachine.set(key, []);
    byMachine.get(key).push(ev);
    if (ev.operatorId) operatorIds.add(ev.operatorId);
  }

  // Badges carry either identityId or biometricId, so names are resolved
  // against both. See lib/operators.js for why.
  const { buildOperatorNameResolver } = require("./operators");

  const [machines, resolveName, heartbeats] = await Promise.all([
    Machine.find({ _id: { $in: [...byMachine.keys()] } }, { name: 1 }).lean(),
    buildOperatorNameResolver(Employee),
    DeviceHeartbeat.find({}).lean(),
  ]);

  const machineNames = new Map(machines.map((m) => [String(m._id), m.name]));
  // Resolver returns the raw id when unknown; an empty string here means
  // "unrecognised", which downstream reports as unknownOperator.
  const employeeNames = new Map(
    [...operatorIds].map((id) => {
      const name = resolveName(id);
      return [id, name === id ? "" : name];
    })
  );
  const heartbeatByMachine = new Map(
    heartbeats.filter((h) => h.machineId).map((h) => [String(h.machineId), h])
  );

  const nameFor = (operatorId) => employeeNames.get(operatorId) || "";

  const machineDocs = [];
  const legacyMachines = [];
  // operatorId -> aggregate across every machine they touched
  const operatorAgg = new Map();

  for (const [machineKey, machineEvents] of byMachine) {
    const walk = walkMachine(machineEvents);
    const heartbeat = heartbeatByMachine.get(machineKey);
    const machineName = machineNames.get(machineKey) || "";
    const deviceId =
      heartbeat?.deviceId || machineEvents.find((e) => e.deviceId)?.deviceId || "";

    // ── machine_day_stats ────────────────────────────────────────────────────
    const machinePace = new Map();
    accumulatePace(walk.sessions, machinePace);

    let totalPieces = 0;
    let piecesThisHour = 0;
    const operatorSpans = [];

    for (const session of walk.sessions) {
      totalPieces += session.scans.length;
      for (const scan of session.scans) {
        if (now - scan.timeStamp.getTime() <= 60 * MINUTE) piecesThisHour++;
      }
      operatorSpans.push({
        operatorId: session.operatorId,
        operatorName: nameFor(session.operatorId) || session.operatorName,
        signInTime: session.signInTime,
        signOutTime: session.signOutTime,
        pieces: session.scans.length,
      });
    }

    const currentOperatorId = walk.currentSession?.operatorId || null;

    machineDocs.push({
      shiftDate,
      machineId: new mongoose.Types.ObjectId(machineKey),
      machineName,
      deviceId,
      currentOperatorId,
      currentOperatorName: currentOperatorId ? nameFor(currentOperatorId) : null,
      currentOps: walk.currentOps,
      totalPieces,
      piecesThisHour,
      suppressedRescans: walk.suppressedRescans,
      unparseableBarcodes: walk.unparseableBarcodes,
      byOperation: [...machinePace.entries()]
        .filter(([op]) => op !== "__none__")
        .map(([op, stats]) => stats.toJSON(op, opTargets.get(op) ?? null)),
      lastScanAt: walk.lastScanAt,
      lastHeartbeatAt: heartbeat?.lastHeartbeatAt || null,
      status: resolveStatus({
        heartbeat,
        currentSession: walk.currentSession,
        lastScanAt: walk.lastScanAt,
        now,
      }),
      operators: operatorSpans,
      updatedAt: new Date(),
    });

    // ── operator aggregation ─────────────────────────────────────────────────
    for (const session of walk.sessions) {
      const id = session.operatorId;
      if (!operatorAgg.has(id)) {
        operatorAgg.set(id, {
          operatorId: id,
          pace: new Map(),
          totalPieces: 0,
          loggedInMs: 0,
          breakMs: 0,
          idleMs: 0,
          productiveMs: 0,
          machines: new Map(),
          firstSignIn: null,
          lastSignOut: null,
        });
      }
      const agg = operatorAgg.get(id);

      const endedAt = session.signOutTime
        ? session.signOutTime.getTime()
        : Math.min(now, shiftDate.getTime() + 24 * 60 * MINUTE);
      agg.loggedInMs += Math.max(0, endedAt - session.signInTime.getTime());
      agg.breakMs += session.breakMs;
      agg.totalPieces += session.scans.length;

      if (!agg.firstSignIn || session.signInTime < agg.firstSignIn)
        agg.firstSignIn = session.signInTime;
      if (
        session.signOutTime &&
        (!agg.lastSignOut || session.signOutTime > agg.lastSignOut)
      )
        agg.lastSignOut = session.signOutTime;

      const prior = agg.machines.get(machineKey) || {
        machineId: new mongoose.Types.ObjectId(machineKey),
        machineName,
        pieces: 0,
      };
      prior.pieces += session.scans.length;
      agg.machines.set(machineKey, prior);

      accumulatePace([session], agg.pace);
    }

    // ── legacy ProductionTracking machine entry ──────────────────────────────
    legacyMachines.push({
      _id: stableObjectId(`m|${shiftDate.toISOString()}|${machineKey}`),
      machineId: new mongoose.Types.ObjectId(machineKey),
      currentOperatorIdentityId: currentOperatorId,
      operators: walk.sessions.map((session) => ({
        _id: stableObjectId(
          `o|${machineKey}|${session.operatorId}|${session.signInTime.toISOString()}`
        ),
        operatorIdentityId: session.operatorId,
        operatorName: nameFor(session.operatorId) || session.operatorName,
        signInTime: session.signInTime,
        signOutTime: session.signOutTime,
        barcodeScans: session.scans.map((scan) => ({
          _id: stableObjectId(scan.eventId),
          barcodeId: scan.barcodeId,
          timeStamp: scan.timeStamp,
          activeOps: scan.activeOps,
        })),
      })),
    });
  }

  // ── operator_day_stats ─────────────────────────────────────────────────────
  const operatorDocs = [];
  for (const agg of operatorAgg.values()) {
    let productiveMs = 0;
    let idleMs = 0;
    for (const stats of agg.pace.values()) {
      productiveMs += stats.gapTotalMs;
      idleMs += stats.idleMs;
    }
    // Whatever logged-in time is not accounted for by productive work or a
    // recorded break is idle. Floored so clock skew cannot produce a negative.
    const unaccountedMs = Math.max(
      0,
      agg.loggedInMs - productiveMs - agg.breakMs - idleMs
    );

    const resolvedName = employeeNames.get(agg.operatorId);

    const byOperation = [...agg.pace.entries()]
      .filter(([op]) => op !== "__none__")
      .map(([op, stats]) => stats.toJSON(op, opTargets.get(op) ?? null));

    // Weighted by pieces, not a plain mean: an operator who ran 200 pieces of
    // one operation and 3 of another should be judged mostly on the 200.
    // Operations with no registry target contribute nothing rather than
    // dragging the figure toward zero.
    let effNumerator = 0;
    let effDenominator = 0;
    for (const op of byOperation) {
      if (op.efficiencyPercent != null && op.pieces > 0) {
        effNumerator += op.efficiencyPercent * op.pieces;
        effDenominator += op.pieces;
      }
    }

    operatorDocs.push({
      shiftDate,
      operatorId: agg.operatorId,
      operatorName: resolvedName || agg.operatorId,
      // Scans still count. A missing Employee record is surfaced, not hidden.
      unknownOperator: !resolvedName,
      totalPieces: agg.totalPieces,
      minutesLoggedIn: round1(agg.loggedInMs / MINUTE),
      productiveMinutes: round1(productiveMs / MINUTE),
      idleMinutes: round1((idleMs + unaccountedMs) / MINUTE),
      breakMinutes: round1(agg.breakMs / MINUTE),
      overallEfficiencyPercent:
        effDenominator > 0 ? round1(effNumerator / effDenominator) : null,
      byOperation,
      machinesWorked: [...agg.machines.values()],
      firstSignIn: agg.firstSignIn,
      lastSignOut: agg.lastSignOut,
      updatedAt: new Date(),
    });
  }

  // ── write all three, full overwrite ────────────────────────────────────────
  await Promise.all([
    MachineDayStats.bulkWrite(
      machineDocs.map((doc) => ({
        replaceOne: {
          filter: { shiftDate: doc.shiftDate, machineId: doc.machineId },
          replacement: doc,
          upsert: true,
        },
      })),
      { ordered: false }
    ),
    OperatorDayStats.bulkWrite(
      operatorDocs.map((doc) => ({
        replaceOne: {
          filter: { shiftDate: doc.shiftDate, operatorId: doc.operatorId },
          replacement: doc,
          upsert: true,
        },
      })),
      { ordered: false }
    ),
    ProductionTracking.replaceOne(
      { date: shiftDate },
      { date: shiftDate, machines: legacyMachines },
      { upsert: true }
    ),
  ]);

  return {
    shiftDate,
    skipped: false,
    events: events.length,
    machines: machineDocs.length,
    operators: operatorDocs.length,
    pieces: machineDocs.reduce((sum, m) => sum + m.totalPieces, 0),
    suppressedRescans: machineDocs.reduce(
      (sum, m) => sum + m.suppressedRescans,
      0
    ),
  };
}

// ─── Scheduler ────────────────────────────────────────────────────────────────
let running = false;
let timer = null;
let lastRun = null;
let lastResult = null;
let lastError = null;

async function runOnce(models, shiftDate) {
  if (running) return { skipped: true, reason: "already running" };

  /* Mongo not up yet.
   *
   * server.js opens the port BEFORE connectDB() resolves, and start() fires its
   * first tick immediately, so on every cold boot this raced the connection and
   * lost: the find() sat in mongoose's buffer and threw
   * "productionevents.find() buffering timed out after 10000ms" — which then sat
   * in the health endpoint as lastError until the next cycle overwrote it.
   * Nothing was ever wrong; the tick was just early. Skipping is the honest
   * answer, and the 60s cycle picks it up. */
  if (mongoose.connection.readyState !== 1) {
    return { skipped: true, reason: "database not connected yet" };
  }

  running = true;
  try {
    const target = shiftDate || currentShiftDate();
    const result = await rollupForDate(target, models || getLocalModels());
    lastRun = new Date();
    lastResult = result;
    lastError = null;
    return result;
  } catch (err) {
    lastError = err.message;
    console.error("[Rollup] failed:", err);
    return { error: err.message };
  } finally {
    running = false;
  }
}

function start(intervalMs = Number(process.env.ROLLUP_INTERVAL_MS || 60000)) {
  if (timer) return;
  console.log(`[Rollup] scheduled every ${intervalMs}ms`);
  const tick = async () => {
    const result = await runOnce();
    if (result && !result.skipped && !result.error) {
      console.log(
        `[Rollup] ${result.events} events -> ${result.machines} machines, ` +
          `${result.operators} operators, ${result.pieces} pieces ` +
          `(${result.suppressedRescans} rescans suppressed)`
      );
      // The derived numbers just changed — tell any open dashboard to refetch.
      // Required at all: the per-scan emit makes a tile flash immediately, but
      // the accurate counts only exist once this has run.
      try {
        require("./realtime").emitRollup(result);
      } catch (err) {
        console.error("[Rollup] socket emit failed (ignored):", err.message);
      }
    }
  };
  tick();
  timer = setInterval(tick, intervalMs);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function health() {
  return {
    running,
    lastRun,
    lastError,
    lastResult,
  };
}

module.exports = {
  start,
  stop,
  runOnce,
  health,
  rollupForDate,
  getLocalModels,
  shiftDateFor,
  // Exported so the live canvas endpoint can derive per-machine state straight
  // from events without waiting for the 60s rollup, and without a second
  // implementation of the sign-in/scan/break session walk drifting from this
  // one. See routes/CMS_Routes/Production/Dashboard/productionDashboardRoutes.js.
  walkMachine,
  loadOperationTargets,
};
