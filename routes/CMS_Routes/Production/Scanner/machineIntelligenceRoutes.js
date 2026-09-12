// routes/CMS_Routes/Production/Scanner/machineIntelligenceRoutes.js
//
// Mounted at /api/cms/production/supervisor, AFTER supervisorFloorRoutes, so it
// can only add paths and can never shadow one of its. Two endpoints:
//
//   GET /machine-intelligence              machine-wise efficiency for the whole
//                                          floor, off the rollup read model only
//   GET /machine-intelligence/:machineId   one machine in full — production,
//                                          efficiency, downtime, last activity
//
// WHY THIS FILE EXISTS AT ALL.
// Everything a supervisor wants about ONE machine already exists somewhere, and
// nowhere together:
//   · distinct pieces, per-operation pace and SAM  →  MachineDayStats
//   · device health and queue depth                →  DeviceHeartbeat
//   · machine identity and maintenance dates       →  Machine (asset register)
//   · what was scanned, and when                   →  ProductionEvent
// and one thing existed NOWHERE: machine downtime. MachineDayStats has no
// idle/productive/break minutes — those are only kept per OPERATOR, on
// OperatorDayStats. A machine that stood still for forty minutes because nobody
// brought it work looked identical to one that was never manned. So the time
// model here is computed per request from the events, and only for the one
// machine being looked at — the floor endpoint deliberately does no such
// fan-out.
//
// WHAT IS NOT COMPUTED HERE, ON PURPOSE.
// · Pieces are NOT recounted. MachineDayStats.totalPieces is the rollup's
//   distinct-garment figure (barcodeId + sorted activeOps, rollupStats.js:42)
//   and re-deriving it here would be a second implementation free to drift.
//   The cost is that it lags by up to one 60s rollup cycle, so the lag is
//   reported (rollupAgeSeconds) rather than hidden.
// · Efficiency is NOT given a new definition. It is earned minutes (garments x
//   SAM) over attended-less-break time — the garment-industry standard, and
//   exactly how rollupStats now computes OperatorDayStats.overallEfficiencyPercent,
//   so a machine and the people on it are judged by the same arithmetic.
// · A machine TARGET is not invented. Nothing in this system stores one, and
//   manufacturing an "available minutes ÷ SAM" number would read as measured
//   when it is a guess about a shift length nobody has declared. It is returned
//   as null with the reason attached.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

const S = "../../../../services/barcodeScanner";
const { shiftDateFor, currentShiftDate } = require(`${S}/shift`);
const masterData = require(`${S}/masterData`);
// The sign-in / scan / break session walk, imported rather than copied. It is
// exported for exactly this (rollupStats.js:752-757); a second copy of it here
// would drift from the one that writes the read models, and then the downtime
// on this screen would disagree with the status badge beside it.
/* latestHeartbeatByMachine: newest-wins. A machine can carry more than one
   DeviceHeartbeat row (a replaced scanner, a diagnostic pairing), and the
   arbitrary last-one-wins Map this used to build reported live machines
   offline off a stale stub. */
const { walkMachine, latestHeartbeatByMachine } = require(`${S}/rollupStats`);

// Authentication, not a department gate — the same reasoning the sibling
// routers state: the supervisor and the project manager both read these floor
// endpoints and hold different roles.
router.use(EmployeeAuthMiddleware);

const MINUTE = 60 * 1000;

// Every threshold below is the one already in use elsewhere, read from the same
// env var, so this screen cannot quietly disagree with the rollup about what
// "stopped" or "offline" means.
const IDLE_GAP_MS = Number(process.env.IDLE_GAP_SEC || 180) * 1000;
const HEARTBEAT_STALE_MS = Number(process.env.HEARTBEAT_STALE_SEC || 180) * 1000;

// How far past the standard time for the piece being made a gap has to run
// before the machine is called stopped rather than slow.
//
// WHY THIS EXISTS. IDLE_GAP_SEC is a flat 180s. Plenty of operations in the
// registry legitimately take longer than that per piece (operationTargets
// converts totalSam minutes to seconds, so any operation over 3 SAM minutes
// does), and judging those against 180s reported a machine that never stopped
// working as 100% down. Efficiency already reports "slower than the standard";
// downtime must only fire when the gap can no longer be explained by the work
// itself. 2x the standard time is that line, and IDLE_GAP_MS stays the floor so
// this screen can never call a machine stopped SOONER than the rollup calls it
// idle.
const STOP_CYCLE_MULTIPLE = Math.max(
  1,
  Number(process.env.MACHINE_STOP_CYCLE_MULTIPLE || 2) || 2
);

// A single gap this long is worth naming on its own line rather than leaving
// buried in a downtime total. Not a rollup constant — this is presentation, so
// it gets its own env var and is reported back with the response.
const LONG_STOP_MS = Number(process.env.MACHINE_LONG_STOP_MIN || 30) * MINUTE;

// The same bands the operator drawer paints: under 50% is the red band, over
// 150% is the "this number is real but what it measures is questionable" band
// that a machine carrying two operations always lands in.
const LOW_EFFICIENCY_PERCENT = Number(process.env.MACHINE_LOW_EFFICIENCY_PERCENT || 50);
const IMPLAUSIBLE_EFFICIENCY_PERCENT = 150;

const round1 = (n) => (n == null ? null : Math.round(n * 10) / 10);
const minutesOf = (ms) => round1(ms / MINUTE);

const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

// ?date=YYYY-MM-DD / :date into a shift bucket. shiftDateFor, never
// setHours(0,0,0,0) — the process timezone would move the bucket 5h30m and the
// query would miss the documents it is looking for.
const resolveShiftDate = (req) => {
  const raw = req.params.date || req.query.date;
  if (!raw) return currentShiftDate();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return shiftDateFor(parsed);
};

/**
 * The machine's efficiency: earned minutes over the time it was available.
 *
 *     earned     = garments made x SAM, summed over every operation
 *     efficiency = earned / attended-less-breaks x 100
 *
 * WHY THIS IS A SUM AND NOT AN AVERAGE. Each row in byOperation is already
 * measured against the SAME attended time — rollupStats hands every operation
 * on a machine the one manned-less-break figure — so the rows are shares of one
 * whole and add up to it. Averaging them instead divides the machine's real
 * efficiency by the number of operations it runs: a machine carrying AP001 at
 * 1.9% and AP002 at 10.2% is working at 12.1%, and the old mean reported 5.9%.
 * That is what made the drawer's headline disagree with its own table.
 *
 * This used to be a piece-weighted mean, copied from rollupStats when its
 * per-operation figure was `SAM / observed gap` — a ratio, where averaging was
 * at least arithmetically sane. That definition is gone (it produced 989%
 * readings); this follows it.
 *
 * Returns null — "not measurable" — when no operation here has a SAM behind it,
 * or when nobody was signed in to be efficient.
 */
function weightedEfficiency(byOperation) {
  let earned = 0;
  let available = null;
  let rated = 0;
  for (const op of byOperation || []) {
    if (op.earnedMinutes == null) continue;
    earned += op.earnedMinutes;
    rated += 1;
    // Identical on every row by construction; take the first one present.
    if (available == null && op.availableMinutes != null) available = op.availableMinutes;
  }
  if (!rated || !available || available <= 0) return null;
  return round1((earned / available) * 100);
}

/** Heartbeat age in ms, or null when the device has never reported at all. */
const heartbeatAgeOf = (hb, now) =>
  hb?.lastHeartbeatAt ? now - new Date(hb.lastHeartbeatAt).getTime() : null;

/**
 * Live production status.
 *
 * The rollup already resolved this (rollupStats.js:352-363) and wrote it to
 * MachineDayStats; it is read back rather than recomputed. A machine with no
 * stats today has simply not been used — which is an answer, not missing data —
 * so it falls back the same way /supervisor/overview does.
 */
function statusOf(stats, deviceOnline) {
  if (stats?.status) return { status: stats.status, statusSource: "rollup" };
  if (deviceOnline === false) return { status: "device_offline", statusSource: "heartbeat" };
  return { status: "no_operator", statusSource: "none" };
}

/**
 * Standard seconds per piece for the operation(s) a scan was credited to, in ms.
 *
 * masterData.operationTargets is durationSeconds falling back to totalSam
 * minutes — the SAME map rollupStats measures efficiency against, so this
 * screen cannot disagree with the efficiency column beside it about how long a
 * piece is supposed to take.
 *
 * A scan is credited to EVERY operation active on the machine, so when a
 * machine carries two the slowest one governs: the gap between two scans has to
 * cover the longer standard time before the machine can be called stopped.
 * Returns null when no active operation on that scan has a standard time — that
 * is "not measurable", never zero.
 */
function expectedCycleMs(codes, opTargets) {
  let slowest = null;
  for (const code of codes || []) {
    const seconds = opTargets.get(String(code).trim());
    if (seconds > 0 && (slowest == null || seconds > slowest)) slowest = seconds;
  }
  return slowest == null ? null : slowest * 1000;
}

/** How long a span may run before the excess is downtime rather than work. */
const stopAllowanceMs = (expectedMs) =>
  Math.max(IDLE_GAP_MS, expectedMs * STOP_CYCLE_MULTIPLE);

/**
 * MACHINE TIME MODEL — the part of this file that is genuinely new.
 *
 * There is no run signal from a sewing machine. The only evidence that one was
 * working is that pieces came off it, so the model is built from the scan
 * stream and says so in `basis`:
 *
 *   manned      time an operator was signed in on it
 *   running     each span that ended in a piece, credited up to the allowance
 *               for THAT piece — the standard time for the operation it was
 *               scanned against, times STOP_CYCLE_MULTIPLE, floored at
 *               IDLE_GAP_MS. Only what is left over is downtime.
 *   break       break_start/break_end the device recorded
 *   downtime    measurable manned time − running − break. Everything the
 *               machine was manned for and did not produce in: waiting for
 *               work, threading, a jam, a chat. It is deliberately manned-only
 *               — an unmanned machine is not "down", it is unmanned, and
 *               rolling the two together would make a machine nobody is
 *               rostered on look like a breakdown.
 *
 * WHY IT IS NOT A FLAT THRESHOLD ANY MORE. It used to credit running time only
 * for gaps under IDLE_GAP_SEC (180s) flat. Every operation whose standard time
 * is longer than that — and the registry is full of them — had every single one
 * of its legitimate gaps thrown out, so running fell to zero and the headline
 * read "Downtime 100% of manned time" for a machine that had not stopped once.
 * Downtime is a headline figure with a warn tone; it is not allowed to be wrong
 * in that direction.
 *
 * WHAT IT REFUSES TO GUESS. A span whose operation has no standard time in the
 * registry cannot be judged at all — there is nothing to call the gap long
 * against. That time is counted as neither running nor downtime, reported as
 * `unmeasuredMinutes`, and taken out of the percentage base. If NOTHING on this
 * machine has a standard time, running and downtime come back null and the UI
 * shows an em-dash: an honest blank beats a wrong headline.
 *
 * The first span of a session runs from SIGN-IN to the first piece, and the
 * last runs from the final piece to sign-out. Both are credited the same
 * allowance — setting up and making a piece is work. The old model charged both
 * of those to downtime in full, which overstated it on every machine on the
 * floor.
 *
 * longStops are the individual between-piece gaps that outran their own
 * allowance AND the presentation threshold. They are EVIDENCE of where the
 * downtime fell, not a fourth number to add up: a stop that happens to contain
 * a recorded break appears in both, which is why the headline is the
 * subtraction and not a sum of these.
 */
function buildTimeModel(sessions, nowMs, shiftDate, opTargets) {
  // A session with no signout is still open. Capping at "now", and at the end
  // of the shift day when replaying an old date, stops yesterday's unclosed
  // session from accruing hours against today's clock.
  const dayEndMs = Math.min(nowMs, shiftDate.getTime() + 24 * 60 * MINUTE);

  let mannedMs = 0;
  let breakMs = 0;
  let runningMs = 0;
  let unmeasuredMs = 0;
  let measuredSpans = 0;
  let unmeasuredSpans = 0;
  let scanCount = 0;
  let firstSignInAt = null;
  let firstScanAt = null;
  const longStops = [];

  // The slowest standard time among the operations this machine actually ran
  // today. Used ONLY for a sign-in that produced nothing at all — there is no
  // scan in that session to read an operation off, so the machine's own slowest
  // work is the most generous yardstick available. Every other span reads the
  // operation off the piece that ended it; none of them borrows another
  // operation's standard time.
  let machineExpectedMs = null;
  for (const session of sessions) {
    for (const scan of session.scans) {
      const expected = expectedCycleMs(scan.activeOps, opTargets);
      if (expected != null && (machineExpectedMs == null || expected > machineExpectedMs)) {
        machineExpectedMs = expected;
      }
    }
  }

  for (const session of sessions) {
    const startMs = session.signInTime.getTime();
    const endMs = session.signOutTime ? session.signOutTime.getTime() : dayEndMs;
    mannedMs += Math.max(0, endMs - startMs);

    // walkMachine folds a closed break into session.breakMs; a break that is
    // still open when the walk ends is left on openBreakAt, so it is still
    // running right now and is counted up to the cap.
    breakMs += session.breakMs;
    if (session.openBreakAt) {
      breakMs += Math.max(0, dayEndMs - session.openBreakAt.getTime());
    }

    if (!firstSignInAt || session.signInTime < firstSignInAt) {
      firstSignInAt = session.signInTime;
    }

    scanCount += session.scans.length;

    // Every span inside the session is judged the same way: the piece that
    // ENDED it says how long it was reasonably allowed to take. For i === 0
    // that span starts at sign-in, so start-up and the first piece are work
    // rather than an unexplained hole in the shift.
    for (let i = 0; i < session.scans.length; i++) {
      const scan = session.scans[i];
      const at = scan.timeStamp;
      if (!firstScanAt || at < firstScanAt) firstScanAt = at;

      const previous = i === 0 ? null : session.scans[i - 1].timeStamp;
      const fromMs = previous ? previous.getTime() : startMs;
      const span = at.getTime() - fromMs;
      if (span <= 0) continue;

      const expected = expectedCycleMs(scan.activeOps, opTargets);
      if (expected == null) {
        // No standard time for what was running, so there is no honest way to
        // say whether this span was work or a stop. It is neither.
        unmeasuredMs += span;
        unmeasuredSpans++;
        continue;
      }

      const allowance = stopAllowanceMs(expected);
      runningMs += Math.min(span, allowance);
      measuredSpans++;

      // A stop worth naming on its own line: past what the work itself can
      // explain AND past the presentation threshold. Only BETWEEN pieces — the
      // span before the first piece is a start-up, not a stop.
      if (previous && span > allowance && span >= LONG_STOP_MS) {
        longStops.push({
          from: previous,
          to: at,
          minutes: minutesOf(span),
          beyondExpectedMinutes: minutesOf(span - allowance),
          operatorId: session.operatorId,
        });
      }
    }

    // Manned after the last piece came off, or a whole sign-in with no piece at
    // all. The operator is plausibly part-way through the next one, so the same
    // allowance applies; the old model charged all of this to downtime.
    const lastScan = session.scans.length
      ? session.scans[session.scans.length - 1]
      : null;
    const tailFromMs = lastScan ? lastScan.timeStamp.getTime() : startMs;
    const tail = endMs - tailFromMs;
    if (tail > 0) {
      const expected = lastScan
        ? expectedCycleMs(lastScan.activeOps, opTargets)
        : machineExpectedMs;
      if (expected == null) {
        unmeasuredMs += tail;
        unmeasuredSpans++;
      } else {
        runningMs += Math.min(tail, stopAllowanceMs(expected));
        measuredSpans++;
      }
    }
  }

  // A recorded break sits INSIDE one of the spans above, so a break shorter
  // than that span's allowance would be counted once as running and again as
  // break. Running can never be more of the shift than the manned time that was
  // not a break.
  runningMs = Math.min(runningMs, Math.max(0, mannedMs - breakMs));

  // The percentage base is only the manned time this model could actually
  // judge. Time spent on operations with no standard time is excluded from it
  // and reported separately rather than quietly landing in downtime.
  const measurableMs = Math.max(0, mannedMs - unmeasuredMs);
  const measurable = measuredSpans > 0;
  const downtimeMs = measurable
    ? Math.max(0, measurableMs - runningMs - breakMs)
    : null;

  longStops.sort((a, b) => b.minutes - a.minutes);

  const measuredNote =
    "No machine reports whether it is running. Manned time comes from sign-in " +
    "to sign-out. The span that ends in a piece counts as running up to " +
    `${STOP_CYCLE_MULTIPLE}x the standard time for the operation that piece was ` +
    `scanned against (never less than ${Math.round(IDLE_GAP_MS / 1000)}s), and ` +
    "only what is left over is downtime — so an operation that genuinely takes " +
    "several minutes a piece is not reported as a stopped machine. Unmanned " +
    "time is not counted as downtime.";

  const unmeasurableNote =
    "Not measurable. No operation this machine ran has a standard time " +
    "(durationSeconds or SAM) in the operation registry, so there is nothing to " +
    "judge the gap between two pieces against. Reported as unknown rather than " +
    "guessed from a flat threshold.";

  return {
    basis: "scan-stream",
    measurable,
    basisNote: measurable ? measuredNote : unmeasurableNote,
    mannedMinutes: minutesOf(mannedMs),
    // Null, not zero: with no standard time behind any operation these are not
    // measurable, and zero would read as "this machine never ran".
    runningMinutes: measurable ? minutesOf(runningMs) : null,
    breakMinutes: minutesOf(breakMs),
    downtimeMinutes: downtimeMs == null ? null : minutesOf(downtimeMs),
    downtimePercent:
      downtimeMs != null && measurableMs > 0
        ? round1((downtimeMs / measurableMs) * 100)
        : null,
    // Manned time on operations with no standard time behind them — neither
    // running nor downtime, and out of the percentage base above.
    unmeasuredMinutes: minutesOf(unmeasuredMs),
    unmeasuredSpans,
    measuredSpans,
    stopCycleMultiple: STOP_CYCLE_MULTIPLE,
    idleGapFloorSeconds: Math.round(IDLE_GAP_MS / 1000),
    longStopThresholdMinutes: Math.round(LONG_STOP_MS / MINUTE),
    longestStopMinutes: longStops.length ? longStops[0].minutes : null,
    longStops: longStops.slice(0, 8),
    sessionCount: sessions.length,
    scanEvents: scanCount,
    firstSignInAt,
    firstScanAt,
  };
}

/**
 * Recorded breaks, with the reason the device sent.
 *
 * breakReason has been on ProductionEvent since the scanner merged in and is
 * surfaced by no endpoint — the one downtime REASON this system actually
 * collects was being thrown away on the way to every screen.
 */
function buildBreaks(events, nowMs) {
  const breaks = [];
  let open = null;
  for (const ev of events) {
    if (ev.type === "break_start") {
      open = {
        from: ev.scanTime,
        to: null,
        minutes: null,
        reason: ev.breakReason || null,
        operatorId: ev.operatorId || null,
      };
      breaks.push(open);
    } else if (ev.type === "break_end") {
      if (open) {
        open.to = ev.scanTime;
        open.minutes = minutesOf(
          new Date(ev.scanTime).getTime() - new Date(open.from).getTime()
        );
        if (!open.reason && ev.breakReason) open.reason = ev.breakReason;
        open = null;
      } else if (Number.isFinite(ev.breakDurationSec)) {
        // The device reported how long it was, but the start event never
        // arrived. Kept, because a break that happened is a fact.
        breaks.push({
          from: null,
          to: ev.scanTime,
          minutes: round1(ev.breakDurationSec / 60),
          reason: ev.breakReason || null,
          operatorId: ev.operatorId || null,
          startMissing: true,
        });
      }
    }
  }
  if (open) {
    open.minutes = minutesOf(nowMs - new Date(open.from).getTime());
    open.stillOpen = true;
  }
  return breaks;
}

/** Attention flags. Every one of them names the field it was raised from. */
function buildFlags({ status, machine, stats, device, efficiency, time, now }) {
  const flags = [];
  const add = (code, severity, label, detail) =>
    flags.push({ code, severity, label, detail });

  if (status === "device_offline") {
    add(
      "device_offline",
      "critical",
      "Device offline",
      device?.heartbeatAgeSec != null
        ? `No heartbeat for ${Math.round(device.heartbeatAgeSec / 60)} min. Scans are queuing on the device.`
        : "No heartbeat inside the stale window."
    );
  }
  if (status === "idle") {
    add("idle", "warning", "Idle", "An operator is signed in but has not scanned recently.");
  }
  if (status === "no_operator") {
    add("no_operator", "warning", "No operator", "Nobody has signed in on this machine today.");
  }
  if (status === "on_break") {
    add("on_break", "info", "On break", "A break is open on this machine.");
  }

  // Asset register — typed by a person, not a live signal, so it is flagged as
  // what it is rather than promoted into the production status vocabulary.
  if (machine.status === "Repair Needed") {
    add("asset_repair", "critical", "Repair needed", "Marked Repair Needed in the machine register.");
  }
  if (machine.status === "Under Maintenance") {
    add("asset_maintenance", "warning", "Under maintenance", "Marked Under Maintenance in the machine register.");
  }
  if (machine.nextMaintenance && new Date(machine.nextMaintenance).getTime() < now) {
    add(
      "maintenance_overdue",
      "warning",
      "Service overdue",
      `Next service was due ${new Date(machine.nextMaintenance).toISOString().slice(0, 10)}.`
    );
  }

  if (efficiency.overallPercent != null) {
    if (efficiency.overallPercent > IMPLAUSIBLE_EFFICIENCY_PERCENT) {
      add(
        "implausible_efficiency",
        "info",
        `Efficiency reads ${efficiency.overallPercent}%`,
        "A scan is credited to every operation active on the machine, so a machine carrying more than one inflates this. Read the per-operation pace instead."
      );
    } else if (efficiency.overallPercent < LOW_EFFICIENCY_PERCENT) {
      add(
        "low_efficiency",
        "warning",
        `Efficiency ${efficiency.overallPercent}%`,
        `Below the ${LOW_EFFICIENCY_PERCENT}% mark against the standard time for the operations it ran.`
      );
    }
  }
  if (efficiency.unmeasuredOperations.length) {
    add(
      "no_standard_time",
      "info",
      "No standard time",
      `Nobody has set a SAM for ${efficiency.unmeasuredOperations.join(", ")}, so those pieces cannot be measured.`
    );
  }

  if (time && time.longestStopMinutes != null) {
    add(
      "long_stop",
      "warning",
      `Stopped ${time.longestStopMinutes} min`,
      `Longest single gap between pieces while manned. Longer than ${time.longStopThresholdMinutes} min AND longer than ${time.stopCycleMultiple}x the standard time for the operation that was running, so the work itself does not explain it.`
    );
  }
  // Downtime could not be judged at all — said out loud rather than left as a
  // silent em-dash on the headline tile.
  if (time && !time.measurable && time.mannedMinutes > 0) {
    add(
      "downtime_unmeasurable",
      "info",
      "Downtime not measurable",
      "No operation this machine ran has a standard time in the registry, so there is no yardstick for how long a gap between pieces should be. Downtime is left blank rather than guessed."
    );
  }
  if (time && time.measurable && time.unmeasuredMinutes > 0) {
    add(
      "downtime_partly_unmeasured",
      "info",
      `${Math.round(time.unmeasuredMinutes)} min not judged`,
      "Manned time spent on operations with no standard time. It counts as neither running nor downtime, and is not in the downtime percentage."
    );
  }

  if (device?.queueDepth > 0) {
    add(
      "device_queue",
      "warning",
      `${device.queueDepth} queued on device`,
      "Pieces recorded on the device that have not reached this database yet."
    );
  }
  if (device && ["crash", "loop-hang"].includes(String(device.resetReason || "").toLowerCase())) {
    add("device_fault", "warning", `Device reset: ${device.resetReason}`, "The scanner restarted itself rather than being power-cycled.");
  }
  if (!device) {
    add("device_never_seen", "info", "No device paired", "This machine has never sent a heartbeat, so device health is unknown — not offline.");
  }
  if (stats?.unparseableBarcodes > 0) {
    add(
      "unparseable_barcodes",
      "info",
      `${stats.unparseableBarcodes} unreadable tickets`,
      "Scanned barcodes that do not parse as WO-<id>-<unit>. They are stored but cannot be attributed to a work order."
    );
  }

  return flags;
}

const SEVERITY_RANK = { critical: 2, warning: 1, info: 0 };
const worstSeverity = (flags) =>
  flags.reduce(
    (worst, f) => (SEVERITY_RANK[f.severity] > SEVERITY_RANK[worst] ? f.severity : worst),
    "info"
  );

/**
 * Machine-wise efficiency for the whole floor, from the read models only.
 *
 * No event fan-out: this is the comparison table, and it has to stay cheap
 * enough to sit inside the per-machine response as well as answer on its own.
 * Machines that produced nothing are kept — a machine with no stats is exactly
 * what a supervisor is scanning the list for.
 */
function buildFloorRows({ machines, statsByMachine, hbByMachine, now }) {
  return machines
    .map((m) => {
      const key = String(m._id);
      const stats = statsByMachine.get(key) || null;
      const hb = hbByMachine.get(key) || null;
      const age = heartbeatAgeOf(hb, now);
      const deviceOnline = age == null ? null : age <= HEARTBEAT_STALE_MS;
      const { status } = statusOf(stats, deviceOnline);
      const efficiencyPercent = weightedEfficiency(stats?.byOperation);

      return {
        machineId: key,
        machineName: m.name,
        type: m.type || "",
        assetStatus: m.status || null,
        status,
        pieces: stats?.totalPieces ?? 0,
        piecesThisHour: stats?.piecesThisHour ?? 0,
        efficiencyPercent,
        lastScanAt: stats?.lastScanAt || null,
        currentOperatorName: stats?.currentOperatorName || null,
        // The two conditions a supervisor is scanning this list for. Both come
        // straight off fields above — nothing is inferred.
        inefficient:
          efficiencyPercent != null &&
          efficiencyPercent < LOW_EFFICIENCY_PERCENT,
        stalled: status === "idle" || status === "no_operator" || status === "device_offline",
      };
    })
    .sort((a, b) => {
      // Measured machines first, worst efficiency at the top — this list is read
      // to find the problem, not to admire the winner. Unmeasured machines fall
      // to the bottom rather than pretending to be 0%.
      if (a.efficiencyPercent == null && b.efficiencyPercent == null) {
        return b.pieces - a.pieces;
      }
      if (a.efficiencyPercent == null) return 1;
      if (b.efficiencyPercent == null) return -1;
      return a.efficiencyPercent - b.efficiencyPercent;
    });
}

// ─── GET /machine-intelligence[/:date via ?date] ──────────────────────────────
// The floor comparison on its own, for a table or a ranking panel.
router.get("/machine-intelligence", async (req, res) => {
  try {
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: "Invalid date format" });
    }

    const now = Date.now();
    const [master, dayStats, heartbeats] = await Promise.all([
      masterData.getMasterData(),
      MachineDayStats.find({ shiftDate }).lean(),
      DeviceHeartbeat.find({}).lean(),
    ]);

    const statsByMachine = new Map(dayStats.map((s) => [String(s.machineId), s]));
    const hbByMachine = latestHeartbeatByMachine(heartbeats);

    const rows = buildFloorRows({
      machines: master.machines || [],
      statsByMachine,
      hbByMachine,
      now,
    });

    const measured = rows.filter((r) => r.efficiencyPercent != null);

    return res.json({
      success: true,
      shiftDate,
      generatedAt: new Date(),
      masterSource: master.source,
      thresholds: {
        lowEfficiencyPercent: LOW_EFFICIENCY_PERCENT,
        implausibleEfficiencyPercent: IMPLAUSIBLE_EFFICIENCY_PERCENT,
      },
      summary: {
        machines: rows.length,
        measured: measured.length,
        inefficient: rows.filter((r) => r.inefficient).length,
        stalled: rows.filter((r) => r.stalled).length,
        // A median, not a mean: one machine reading 698% because it carries two
        // operations would drag a mean somewhere nobody recognises.
        medianEfficiencyPercent: measured.length
          ? measured.map((r) => r.efficiencyPercent).sort((a, b) => a - b)[
              Math.floor(measured.length / 2)
            ]
          : null,
      },
      machines: rows,
    });
  } catch (error) {
    console.error("[MachineIntelligence/floor] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /machine-intelligence/:machineId ─────────────────────────────────────
// One machine, in full.
router.get("/machine-intelligence/:machineId", async (req, res) => {
  try {
    const machineObjId = toObjectId(req.params.machineId);
    if (!machineObjId) {
      return res.status(400).json({ success: false, message: "Invalid machineId" });
    }
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res.status(400).json({ success: false, message: "Invalid date format" });
    }
    const machineKey = String(machineObjId);
    const now = Date.now();

    const [machine, master, dayStats, heartbeats, events] = await Promise.all([
      // The asset register, read directly rather than through master data: this
      // is the only place model / lastMaintenance / nextMaintenance live, and
      // the master-data projection does not carry them.
      Machine.findById(machineObjId).lean(),
      masterData.getMasterData(),
      MachineDayStats.find({ shiftDate }).lean(),
      DeviceHeartbeat.find({}).lean(),
      ProductionEvent.find({ shiftDate, machineId: machineObjId })
        .sort({ scanTime: 1 })
        .lean(),
    ]);

    if (!machine) {
      return res.status(404).json({ success: false, message: "Machine not found" });
    }

    const statsByMachine = new Map(dayStats.map((s) => [String(s.machineId), s]));
    const hbByMachine = latestHeartbeatByMachine(heartbeats);
    const stats = statsByMachine.get(machineKey) || null;
    const hb = hbByMachine.get(machineKey) || null;

    const heartbeatAge = heartbeatAgeOf(hb, now);
    const deviceOnline = heartbeatAge == null ? null : heartbeatAge <= HEARTBEAT_STALE_MS;
    const { status, statusSource } = statusOf(stats, deviceOnline);

    // Names for codes and ids, all off one 10s-cached read.
    const opInfo = new Map(
      (master.operations || []).map((o) => [
        String(o.operationCode).trim(),
        { name: o.name || "", machineType: o.machineType || "" },
      ])
    );
    const woMap = masterData.workOrderMap(master);
    const nameFor = masterData.operatorNameResolver(master);
    // The same target map rollupStats measures efficiency with — the time model
    // judges a gap against the standard time for the operation actually
    // running, so it has to read that standard from the same place.
    const opTargets = masterData.operationTargets(master);

    // ── the session walk, and everything derived from it ────────────────────
    const walk = walkMachine(events);
    const time = buildTimeModel(walk.sessions, now, shiftDate, opTargets);
    const breaks = buildBreaks(events, now);

    // ── per-operation pace, SAM and efficiency, straight off the rollup ──────
    const byOperation = (stats?.byOperation || []).map((op) => {
      const info = opInfo.get(String(op.operationCode).trim()) || {};
      return {
        operationCode: op.operationCode,
        operationName: info.name || null,
        machineType: info.machineType || null,
        // CAUTION for anyone rendering this: `pieces` is the pace tally — one
        // per scan per ACTIVE operation, so a machine carrying two operations
        // counts each piece under both. The machine's real output is
        // production.pieces below, which is distinct garments.
        pieces: op.pieces,
        avgSecondsPerPiece: op.avgSecondsPerPiece,
        minSecondsPerPiece: op.minSecondsPerPiece,
        maxSecondsPerPiece: op.maxSecondsPerPiece,
        samSeconds: op.smvSeconds,
        efficiencyPercent: op.efficiencyPercent,
      };
    });

    const unmeasuredOperations = byOperation
      .filter((op) => op.samSeconds == null)
      .map((op) => op.operationCode);
    const overallPercent = weightedEfficiency(stats?.byOperation);

    const efficiency = {
      overallPercent,
      basis: "piece-weighted mean of per-operation pace (standard time ÷ actual)",
      basisNote:
        "The same arithmetic OperatorDayStats.overallEfficiencyPercent uses, so a " +
        "machine and the people on it are measured identically. Operations with " +
        "no standard time contribute nothing rather than counting as zero.",
      measuredOperations: byOperation.filter((op) => op.samSeconds != null).length,
      unmeasuredOperations,
      multiOperation: (stats?.currentOps || []).length > 1,
      implausible:
        overallPercent != null && overallPercent > IMPLAUSIBLE_EFFICIENCY_PERCENT,
    };

    // ── what it is making ───────────────────────────────────────────────────
    const scans = events.filter((e) => e.type === "scan");
    const lastScanEvent = scans.length ? scans[scans.length - 1] : null;
    const lastEvent = events.length ? events[events.length - 1] : null;

    const woGroups = new Map();
    for (const ev of scans) {
      if (!ev.workOrderKey) continue;
      if (!woGroups.has(ev.workOrderKey)) {
        woGroups.set(ev.workOrderKey, { units: new Set(), lastScanAt: ev.scanTime });
      }
      const g = woGroups.get(ev.workOrderKey);
      // Distinct unit numbers — garments — the same definition
      // /dashboard/work-orders uses for unitsCompleted. Never the scan count.
      if (ev.unitNumber != null) g.units.add(ev.unitNumber);
      if (new Date(ev.scanTime) > new Date(g.lastScanAt)) g.lastScanAt = ev.scanTime;
    }

    const describeWorkOrder = (shortId, g) => {
      const wo = woMap.get(shortId) || null;
      return {
        workOrderShortId: shortId,
        workOrderNumber: wo?.workOrderNumber || null,
        productName: wo?.stockItemName || null,
        productCode: wo?.stockItemReference || null,
        customerName: wo?.customerName || null,
        orderQuantity: wo?.quantity ?? null,
        unitsOnThisMachine: g ? g.units.size : null,
        lastScanAt: g ? g.lastScanAt : null,
      };
    };

    const workOrdersToday = [...woGroups.entries()]
      .map(([shortId, g]) => describeWorkOrder(shortId, g))
      .sort((a, b) => new Date(b.lastScanAt) - new Date(a.lastScanAt));

    const currentWorkOrder = lastScanEvent?.workOrderKey
      ? describeWorkOrder(
          lastScanEvent.workOrderKey,
          woGroups.get(lastScanEvent.workOrderKey)
        )
      : null;

    // ── who is on it ────────────────────────────────────────────────────────
    // One row per SESSION, as stored. They are not summed: an operator who
    // signed out and back in has two spans, and adding their piece counts would
    // double-count any garment that appears in both — the exact inflation the
    // rollup's shift-spanning Sets exist to prevent.
    const operatorSpans = (stats?.operators || []).map((o) => ({
      operatorId: o.operatorId,
      operatorName: o.operatorName || nameFor(o.operatorId),
      signInTime: o.signInTime,
      signOutTime: o.signOutTime,
      pieces: o.pieces,
      active: !o.signOutTime,
    }));

    const currentOperator = stats?.currentOperatorId
      ? {
          operatorId: stats.currentOperatorId,
          operatorName:
            stats.currentOperatorName || nameFor(stats.currentOperatorId) || null,
          signInTime:
            operatorSpans.find(
              (s) => s.operatorId === stats.currentOperatorId && s.active
            )?.signInTime || null,
        }
      : null;

    const currentOperations = (stats?.currentOps || []).map((code) => {
      const info = opInfo.get(String(code).trim()) || {};
      return {
        code,
        name: info.name || null,
        machineType: info.machineType || null,
        samSeconds:
          byOperation.find((op) => op.operationCode === code)?.samSeconds ?? null,
      };
    });

    const device = hb
      ? {
          deviceId: hb.deviceId,
          firmwareVersion: hb.firmwareVersion,
          ipAddress: hb.ipAddress,
          wifiSSID: hb.wifiSSID,
          rssi: hb.rssi,
          queueDepth: hb.queueDepth,
          queueHighWater: hb.queueHighWater,
          onBreak: hb.onBreak,
          bootCount: hb.bootCount,
          uptimeSec: hb.uptimeSec,
          // Stored on every heartbeat and surfaced by no other endpoint. It is
          // the only fault signal this system receives from a machine.
          resetReason: hb.resetReason || null,
          lastHeartbeatAt: hb.lastHeartbeatAt,
          heartbeatAgeSec: heartbeatAge == null ? null : Math.round(heartbeatAge / 1000),
          online: deviceOnline,
        }
      : null;

    const flags = buildFlags({
      status,
      machine,
      stats,
      device,
      efficiency,
      time,
      now,
    });

    const floorRows = buildFloorRows({
      machines: master.machines || [],
      statsByMachine,
      hbByMachine,
      now,
    });
    const measuredFloor = floorRows.filter((r) => r.efficiencyPercent != null);
    const rankIndex = measuredFloor.findIndex((r) => r.machineId === machineKey);

    return res.json({
      success: true,
      shiftDate,
      generatedAt: new Date(),
      masterSource: master.source,

      machine: {
        machineId: machineKey,
        name: machine.name,
        type: machine.type,
        model: machine.model || null,
        serialNumber: machine.serialNumber,
        location: machine.location || null,
        // Raw Machine.status — the ASSET state, kept apart from the production
        // status above on purpose. It is typed into the register by a person;
        // nothing on the floor reports it.
        assetStatus: machine.status,
        lastMaintenance: machine.lastMaintenance || null,
        nextMaintenance: machine.nextMaintenance || null,
        maintenanceSource: "machine register (manually maintained)",
      },

      status,
      statusSource,
      attention: flags.length ? worstSeverity(flags) : "ok",

      // How old the rollup figures are. Pieces and efficiency come from a read
      // model rebuilt every 60s; saying so is cheaper than pretending they are
      // to the second.
      statsUpdatedAt: stats?.updatedAt || null,
      rollupAgeSeconds: stats?.updatedAt
        ? Math.round((now - new Date(stats.updatedAt).getTime()) / 1000)
        : null,

      production: {
        // DISTINCT GARMENTS. MachineDayStats.totalPieces is the rollup's
        // barcodeId + sorted-activeOps key count, not a scan tally.
        pieces: stats?.totalPieces ?? 0,
        piecesThisHour: stats?.piecesThisHour ?? 0,
        piecesDefinition:
          "distinct garments (barcode + operation set), counted once however many times they were scanned",
        // Diagnostics only — a device double-firing shows up as scans far above
        // pieces. Never production.
        scanEvents: scans.length,
        suppressedRescans: stats?.suppressedRescans ?? 0,
        unparseableBarcodes: stats?.unparseableBarcodes ?? 0,
      },

      // NOT COMPUTED. Nothing in this system stores a per-machine or per-shift
      // piece target, and there is no roster or shift-length record to derive
      // one from. Returned explicitly so the UI shows an em-dash rather than a
      // number somebody would plan against.
      target: {
        pieces: null,
        source: null,
        note:
          "No machine or shift target is stored anywhere in this system. The only " +
          "standard available is the per-operation SAM shown against each operation.",
      },

      efficiency,
      byOperation,

      currentOperator,
      operators: operatorSpans,
      currentOperations,

      workOrder: {
        current: currentWorkOrder,
        today: workOrdersToday,
      },

      activity: {
        lastScanAt: stats?.lastScanAt || lastScanEvent?.scanTime || null,
        lastEventAt: lastEvent?.scanTime || null,
        lastEventType: lastEvent?.type || null,
        lastHeartbeatAt: hb?.lastHeartbeatAt || null,
        secondsSinceLastScan: lastScanEvent
          ? Math.round((now - new Date(lastScanEvent.scanTime).getTime()) / 1000)
          : null,
        secondsSinceLastEvent: lastEvent
          ? Math.round((now - new Date(lastEvent.scanTime).getTime()) / 1000)
          : null,
        // A reconstructed timestamp is surfaced, never silently trusted.
        lastScanTimeRecovered: lastScanEvent?.timeRecovered ?? null,
      },

      downtime: { ...time, breaks },

      device,
      flags,

      floor: {
        rank: rankIndex >= 0 ? rankIndex + 1 : null,
        of: measuredFloor.length,
        rankedBy: "lowest efficiency first",
        medianEfficiencyPercent: measuredFloor.length
          ? measuredFloor.map((r) => r.efficiencyPercent).sort((a, b) => a - b)[
              Math.floor(measuredFloor.length / 2)
            ]
          : null,
        machines: floorRows,
      },

      thresholds: {
        lowEfficiencyPercent: LOW_EFFICIENCY_PERCENT,
        implausibleEfficiencyPercent: IMPLAUSIBLE_EFFICIENCY_PERCENT,
        // The floor under the per-operation stop allowance, not the allowance
        // itself — that is derived per piece from the operation's standard time.
        idleGapFloorSeconds: Math.round(IDLE_GAP_MS / 1000),
        stopCycleMultiple: STOP_CYCLE_MULTIPLE,
        heartbeatStaleSeconds: Math.round(HEARTBEAT_STALE_MS / 1000),
        longStopMinutes: Math.round(LONG_STOP_MS / MINUTE),
      },
    });
  } catch (error) {
    console.error("[MachineIntelligence/machine] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
