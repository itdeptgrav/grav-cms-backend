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

/**
 * PIECES ARE DISTINCT GARMENTS, NOT SCAN EVENTS.
 *
 * A scan is an event; a piece is a physical garment. An operator re-scanning a
 * ticket — because the beep was missed, because the screen did not update,
 * because they were checking — produces another event and no extra garment.
 *
 * RESCAN_WINDOW_MS only suppressed repeats inside 60 seconds, which matched the
 * device's own woHistory but not reality: barcode WO-359e717d-011 was scanned
 * at 12:43 and again at 13:19 by the same operator on the same operation, and
 * both were counted. Production, efficiency, operator league tables and every
 * dashboard total inherited that inflation.
 *
 * An operator does not perform the same operation on the same garment twice, so
 * the same barcode under the same operation set counts ONCE for that operator
 * for the whole shift, whatever the gap. A piece legitimately passing through
 * several machines or operations still counts at each, because those are
 * genuinely separate units of work.
 *
 * The raw event count is kept alongside as totalScans — useful for diagnosing a
 * device that is double-firing, and never to be shown as production.
 */
/**
 * One heartbeat per machine: the MOST RECENT one.
 *
 * A machine can have more than one DeviceHeartbeat row — a replaced scanner
 * keeps its old row, and a diagnostic tool can pair briefly under its own
 * deviceId. Both call sites used to build `new Map(rows.map(...))`, where a
 * duplicate key means the LAST row Mongo happened to return wins. That is
 * arbitrary, and when it landed on a stale row a live machine was reported
 * offline: machine 70e19dff had its real scanner beating 1 minute ago and two
 * diagnostic rows nearly 5 hours old, and the floor read "Device offline. No
 * heartbeat for 268 min" — which was the age of one of the stubs.
 *
 * A machine is reachable if ANY paired device is beating, so the newest row is
 * the honest answer.
 */
function latestHeartbeatByMachine(heartbeats) {
  const best = new Map();
  for (const h of heartbeats || []) {
    if (!h?.machineId) continue;
    const key = String(h.machineId);
    const prior = best.get(key);
    const at = h.lastHeartbeatAt ? new Date(h.lastHeartbeatAt).getTime() : -Infinity;
    const priorAt = prior?.lastHeartbeatAt ? new Date(prior.lastHeartbeatAt).getTime() : -Infinity;
    if (!prior || at > priorAt) best.set(key, h);
  }
  return best;
}

/** The identity of one garment-at-a-state. The single definition; see exports. */
function pieceKeyOf(scan) {
  return `${scan.barcodeId}|${[...(scan.activeOps || [])].sort().join(",")}`;
}

function countDistinctPieces(scans) {
  const seen = new Set();
  for (const s of scans) {
    if (!s.barcodeId) continue; // a scan with no ticket cannot identify a piece
    seen.add(pieceKeyOf(s));
  }
  return seen.size;
}

/* Counting per session and summing double-counts any piece that appears in
   more than one session — an operator who steps away past the idle gap, or
   moves between machines, splits one piece across two sessions and it is then
   counted twice. That is the "9 pieces when 8 were made" the floor reported.
   These add into a Set that spans the whole shift, so the size is taken once
   at the end and a piece can only be in it once however the sessions fall. */
function addPieceKeys(set, scans) {
  for (const s of scans) {
    if (!s.barcodeId) continue;
    set.add(`${s.barcodeId}|${[...(s.activeOps || [])].sort().join(",")}`);
  }
  return set;
}

function addPieceKeysSince(set, scans, sinceMs) {
  for (const s of scans) {
    if (!s.barcodeId) continue;
    if (s.timeStamp.getTime() < sinceMs) continue;
    set.add(`${s.barcodeId}|${[...(s.activeOps || [])].sort().join(",")}`);
  }
  return set;
}

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
  //
  // availableSeconds is the ON-STANDARD time the person or machine was actually
  // available to work: attended time less recorded breaks. Without it there is
  // no efficiency to state, and the field comes back null rather than guessed.
  //
  // ── WHY EFFICIENCY IS NOT "SAM ÷ observed gap" ANY MORE ────────────────────
  // It used to be `targetSeconds / avgSecondsPerPiece`, and it produced figures
  // like 189% and 989% on the same machine in the same shift. Two faults, both
  // real:
  //
  //   1. `avg` only averages gaps SHORTER than IDLE_GAP_MS (180s); everything
  //      longer is booked to idle and thrown out. On a machine that made 16
  //      garments across 324 minutes, almost every true gap was excluded, so
  //      `avg` came out at 13.3s — the speed of a couple of back-to-back scans.
  //      The real cycle was 1216s per garment, ninety times longer. Comparing a
  //      standard minute value against a burst speed can only inflate.
  //   2. It is not what the industry means by efficiency. A garment factory
  //      measures EARNED MINUTES against ATTENDED MINUTES:
  //
  //          earned    = pieces produced x SAM
  //          efficiency = earned / on-standard attended time x 100
  //
  // So that is what this returns now. On the same real data it gives 12.8%,
  // which is what 16 garments worth 2.60 standard minutes each actually
  // represents across a 324-minute attendance.
  //
  // It is NOT capped. Over 100% is a real and meaningful result — an operator
  // beating the standard time genuinely earns more minutes than they attend,
  // and that is exactly the number a factory wants to see. What it can no
  // longer do is reach 989% because the denominator was measuring the wrong
  // thing.
  //
  // A machine running two operations at once credits each garment to both, so
  // each operation contributes its own earned minutes against the SAME attended
  // time. Their percentages therefore sum to the machine's overall efficiency,
  // which is the honest reading: attended time cannot be split between
  // operations that ran concurrently.
  toJSON(operationCode, targetSeconds = null, availableSeconds = null) {
    const avg =
      this.gapCount > 0 ? this.gapTotalMs / this.gapCount / 1000 : null;

    const earnedSeconds =
      targetSeconds != null && this.pieces > 0 ? targetSeconds * this.pieces : null;

    return {
      operationCode,
      pieces: this.pieces,
      // The pace WHILE WORKING: the mean gap with idle stretches removed. Kept
      // because "how fast do they go when they are going" is a real question —
      // but it is not the cycle time and must never be presented as one.
      avgSecondsPerPiece: avg == null ? null : round1(avg),
      minSecondsPerPiece: this.minMs == null ? null : round1(this.minMs / 1000),
      maxSecondsPerPiece: this.maxMs == null ? null : round1(this.maxMs / 1000),
      // The TRUE cycle: every available second divided by the garments that
      // came out of them, idle included. This is the figure comparable to SAM.
      observedCycleSeconds:
        availableSeconds && this.pieces > 0
          ? round1(availableSeconds / this.pieces)
          : null,
      smvSeconds: targetSeconds,
      earnedMinutes: earnedSeconds == null ? null : round1(earnedSeconds / 60),
      availableMinutes: availableSeconds == null ? null : round1(availableSeconds / 60),
      efficiencyPercent:
        earnedSeconds != null && availableSeconds > 0
          ? round1((earnedSeconds / availableSeconds) * 100)
          : null,
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
  /* One garment counts ONCE per operation, however many times it is scanned.
     This used to call addPiece() per scan, guarded only by the 60s rescan
     window, while totalPieces deduplicated across the whole shift — so the two
     disagreed badly: machine 70e19dff reported 12 distinct pieces against 32
     across its operations, and AP002 came out at 1488% efficiency, because
     earned SAM is pieces x standard minutes. Deduplicating here per operation
     puts pace, SAM and efficiency on the same basis as the piece count.

     A scan is still credited to EVERY operation active on the machine — that is
     deliberate and unchanged. One pass through a two-operation station really
     does complete both operations on that garment. */
  const countedByOp = new Map();

  for (const session of sessions) {
    for (const scan of session.scans) {
      const ops = scan.activeOps.length > 0 ? scan.activeOps : ["__none__"];
      for (const op of ops) {
        if (!target.has(op)) target.set(op, new PaceStats());
        const stats = target.get(op);

        /* A garment with no ticket cannot be identified, so it cannot be
           deduplicated either; count it and move on rather than collapsing
           every unidentifiable scan into one piece. */
        if (scan.barcodeId) {
          if (!countedByOp.has(op)) countedByOp.set(op, new Set());
          const seen = countedByOp.get(op);
          if (seen.has(scan.barcodeId)) continue; // same garment, same operation
          seen.add(scan.barcodeId);
        }
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
  const heartbeatByMachine = latestHeartbeatByMachine(heartbeats);

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

    const machinePieceKeys = new Set();
    const machineHourKeys = new Set();
    let totalScans = 0;
    const operatorSpans = [];

    for (const session of walk.sessions) {
      addPieceKeys(machinePieceKeys, session.scans);
      totalScans += session.scans.length;
      addPieceKeysSince(machineHourKeys, session.scans, now - 60 * MINUTE);
      operatorSpans.push({
        operatorId: session.operatorId,
        operatorName: nameFor(session.operatorId) || session.operatorName,
        signInTime: session.signInTime,
        signOutTime: session.signOutTime,
        pieces: countDistinctPieces(session.scans),
        scans: session.scans.length, // diagnostics only — never shown as output
      });
    }

    const totalPieces = machinePieceKeys.size;
    const piecesThisHour = machineHourKeys.size;

    /* The machine's ON-STANDARD time: how long somebody was signed in on it,
       less the breaks they recorded. This is the denominator every efficiency
       figure for this machine is measured against. An unmanned machine has
       none, so its efficiency is null rather than zero — nobody was there to
       be efficient. */
    let mannedMs = 0;
    for (const session of walk.sessions) {
      const endedAt = session.signOutTime
        ? session.signOutTime.getTime()
        : Math.min(now, shiftDate.getTime() + 24 * 60 * MINUTE);
      mannedMs += Math.max(0, endedAt - session.signInTime.getTime());
      mannedMs -= Math.min(session.breakMs || 0, Math.max(0, endedAt - session.signInTime.getTime()));
    }
    const machineAvailableSeconds = mannedMs > 0 ? mannedMs / 1000 : null;

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
      totalScans,
      piecesThisHour,
      suppressedRescans: walk.suppressedRescans,
      unparseableBarcodes: walk.unparseableBarcodes,
      byOperation: [...machinePace.entries()]
        .filter(([op]) => op !== "__none__")
        .map(([op, stats]) =>
          stats.toJSON(op, opTargets.get(op) ?? null, machineAvailableSeconds)
        ),
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
          pieceKeys: new Set(),
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
      addPieceKeys(agg.pieceKeys, session.scans);
      agg.totalScans = (agg.totalScans || 0) + session.scans.length;

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
        pieceKeys: new Set(),
      };
      /* was `prior.pieces += session.scans.length` — a raw scan count, so a
         re-scanned piece inflated the machine's share of the operator's day. */
      addPieceKeys(prior.pieceKeys, session.scans);
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

    /* ON-STANDARD TIME: attended less recorded breaks. This is the denominator
       for every efficiency figure about this person — the minutes they were
       actually available to earn standard minutes in. A break is not time they
       failed to produce in, so charging it against them would be wrong. */
    const operatorAvailableSeconds =
      agg.loggedInMs > 0
        ? Math.max(0, agg.loggedInMs - agg.breakMs) / 1000
        : null;

    const byOperation = [...agg.pace.entries()]
      .filter(([op]) => op !== "__none__")
      .map(([op, stats]) =>
        stats.toJSON(op, opTargets.get(op) ?? null, operatorAvailableSeconds)
      );

    /* Overall efficiency, the way a garment factory states it:
           total earned minutes / on-standard attended minutes x 100
       Summing the per-operation earned minutes gets there directly, because
       every operation was already measured against this same attended time.

       This replaces a piece-weighted MEAN of the old per-operation percentages.
       That mean inherited every distortion of the old formula — it was how an
       operator ended up reading several hundred per cent — and averaging
       percentages that each had a different implicit denominator was not a
       meaningful quantity in the first place.

       Operations with no SAM in the registry contribute no earned minutes. They
       are not counted as zero: an unmeasured operation drags nothing down, it
       simply cannot be credited, and `unratedOperations` says how many there
       were so the figure can be read with that in mind. */
    let earnedMinutes = 0;
    let unratedOperations = 0;
    for (const op of byOperation) {
      if (op.earnedMinutes != null) earnedMinutes += op.earnedMinutes;
      else if (op.pieces > 0) unratedOperations += 1;
    }

    operatorDocs.push({
      shiftDate,
      operatorId: agg.operatorId,
      operatorName: resolvedName || agg.operatorId,
      // Scans still count. A missing Employee record is surfaced, not hidden.
      unknownOperator: !resolvedName,
      totalPieces: agg.pieceKeys.size,
      minutesLoggedIn: round1(agg.loggedInMs / MINUTE),
      productiveMinutes: round1(productiveMs / MINUTE),
      idleMinutes: round1((idleMs + unaccountedMs) / MINUTE),
      breakMinutes: round1(agg.breakMs / MINUTE),
      earnedMinutes: round1(earnedMinutes),
      availableMinutes:
        operatorAvailableSeconds == null ? null : round1(operatorAvailableSeconds / 60),
      unratedOperations,
      overallEfficiencyPercent:
        operatorAvailableSeconds > 0 && earnedMinutes > 0
          ? round1((earnedMinutes * 60 / operatorAvailableSeconds) * 100)
          : null,
      byOperation,
      machinesWorked: [...agg.machines.values()].map(({ pieceKeys, ...m }) => ({
        ...m,
        pieces: pieceKeys.size,
      })),
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
  /* Exported so anything else that has to answer "how many garments is this?"
     asks THIS function rather than restating the key. The target system counts
     actuals over arbitrary time windows and must agree with the rollup exactly;
     two copies of `barcodeId + sorted activeOps` would drift the first time one
     of them changed. */
  countDistinctPieces,
  pieceKeyOf,
  latestHeartbeatByMachine,
};
