// routes/CMS_Routes/Production/Scanner/supervisorFloorRoutes.js
//
// Mounted at /api/cms/production/supervisor.
//
// Read-only endpoints for the Production Supervisor portal's floor pages —
// Floor Summary, Device Health and the wall board. Ported from the standalone
// barcode server (11 Sep 2026); the response shapes are unchanged, so the
// pages that read them needed no rewrite when they moved into the CMS. Everything here comes from the
// read models the rollup generates — nothing is computed per request, so a
// dashboard with 50 machines open on a wall screen costs three indexed finds,
// not a fan-out over every scan of the day.
//
// The page needs machines that have produced NOTHING today just as much as it
// needs busy ones — a machine with no events is exactly what a supervisor is
// looking for. So the machine list is driven by the Machine collection and the
// day stats are left-joined onto it, never the other way round.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

const B = "../../../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);
const Machine = require("../../../../models/CMS_Models/Inventory/Configurations/Machine");

const { shiftDateFor, currentShiftDate } = require("../../../../services/barcodeScanner/shift");

// Authentication for the whole router, stated here rather than left to the
// mount. These reads name who is on the floor right now, which machine they
// are on and what is being made — the standalone server could leave them open
// because it was only reachable from the factory LAN, and that stops being
// true the moment they are served by the CMS backend.
//
// Authentication only, not a department gate: the same reason
// productionDashboardRoutes gives — the supervisor and the project manager both
// read these and hold different roles.
router.use(EmployeeAuthMiddleware);

const HEARTBEAT_STALE_MS =
  Number(process.env.HEARTBEAT_STALE_SEC || 180) * 1000;

const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

// Resolve ?date=YYYY-MM-DD / :date into a shift bucket, defaulting to today.
const resolveShiftDate = (req) => {
  const raw = req.params.date || req.query.date;
  if (!raw) return currentShiftDate();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return null;
  return shiftDateFor(parsed);
};

// ─── GET /overview[/:date] ────────────────────────────────────────────────────
// One call, everything the supervisor page renders. Four indexed queries.
const overviewHandler = async (req, res) => {
  try {
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }

    const recentLimit = Math.min(Number(req.query.recent) || 60, 500);

    const [machines, dayStats, operators, heartbeats, recentEvents] =
      await Promise.all([
        Machine.find(
          {},
          { name: 1, serialNumber: 1, type: 1, location: 1, status: 1 }
        )
          .sort({ name: 1 })
          .lean(),
        MachineDayStats.find({ shiftDate }).lean(),
        OperatorDayStats.find({ shiftDate }).sort({ totalPieces: -1 }).lean(),
        DeviceHeartbeat.find({}).lean(),
        ProductionEvent.find({ shiftDate, type: "scan" })
          .sort({ scanTime: -1 })
          .limit(recentLimit)
          .lean(),
      ]);

    const statsByMachine = new Map(
      dayStats.map((s) => [String(s.machineId), s])
    );
    const hbByMachine = new Map(
      heartbeats.filter((h) => h.machineId).map((h) => [String(h.machineId), h])
    );
    const machineNames = new Map(machines.map((m) => [String(m._id), m.name]));
    const operatorNames = new Map(
      operators.map((o) => [o.operatorId, o.operatorName])
    );

    const now = Date.now();

    const rows = machines.map((machine) => {
      const key = String(machine._id);
      const stats = statsByMachine.get(key);
      const hb = hbByMachine.get(key);

      const heartbeatAge = hb?.lastHeartbeatAt
        ? now - new Date(hb.lastHeartbeatAt).getTime()
        : null;
      // No heartbeat record at all means the device has never reported — that
      // is "unknown", not "offline". Only a device we have heard from and then
      // stopped hearing from is genuinely offline.
      const deviceOnline =
        heartbeatAge == null ? null : heartbeatAge <= HEARTBEAT_STALE_MS;

      return {
        machineId: machine._id,
        machineName: machine.name,
        serialNumber: machine.serialNumber,
        type: machine.type,
        location: machine.location,
        assetStatus: machine.status,

        // Live production state. A machine with no stats today has simply not
        // been used — that is a real answer, not missing data.
        status: stats?.status || (deviceOnline === false ? "device_offline" : "no_operator"),
        currentOperatorId: stats?.currentOperatorId || null,
        currentOperatorName:
          stats?.currentOperatorName ||
          (stats?.currentOperatorId
            ? operatorNames.get(stats.currentOperatorId)
            : null) ||
          null,
        currentOps: stats?.currentOps || [],

        totalPieces: stats?.totalPieces || 0,
        piecesThisHour: stats?.piecesThisHour || 0,
        suppressedRescans: stats?.suppressedRescans || 0,
        unparseableBarcodes: stats?.unparseableBarcodes || 0,
        lastScanAt: stats?.lastScanAt || null,

        byOperation: stats?.byOperation || [],
        operators: stats?.operators || [],

        device: hb
          ? {
              deviceId: hb.deviceId,
              firmwareVersion: hb.firmwareVersion,
              ipAddress: hb.ipAddress,
              wifiSSID: hb.wifiSSID,
              rssi: hb.rssi,
              wifiChannel: hb.wifiChannel,
              // Un-acked events sitting on the device. A number that only grows
              // is the earliest evidence that ingest is broken.
              queueDepth: hb.queueDepth,
              queueHighWater: hb.queueHighWater,
              onBreak: hb.onBreak,
              bootCount: hb.bootCount,
              uptimeSec: hb.uptimeSec,
              lastHeartbeatAt: hb.lastHeartbeatAt,
              heartbeatAgeSec:
                heartbeatAge == null ? null : Math.round(heartbeatAge / 1000),
              online: deviceOnline,
            }
          : null,
      };
    });

    const recentScans = recentEvents.map((ev) => ({
      eventId: ev.eventId,
      machineId: ev.machineId,
      machineName: machineNames.get(String(ev.machineId)) || "Unknown machine",
      operatorId: ev.operatorId,
      operatorName: operatorNames.get(ev.operatorId) || ev.operatorId || "",
      barcodeId: ev.barcodeId,
      workOrderKey: ev.workOrderKey,
      unitNumber: ev.unitNumber,
      activeOps: ev.activeOps,
      scanTime: ev.scanTime,
      receivedAt: ev.receivedAt,
      // Surfaced so nobody silently trusts a reconstructed timestamp.
      timeRecovered: ev.timeRecovered,
    }));

    const summary = {
      totalMachines: rows.length,
      producing: rows.filter((r) => r.status === "producing").length,
      idle: rows.filter((r) => r.status === "idle").length,
      onBreak: rows.filter((r) => r.status === "on_break").length,
      noOperator: rows.filter((r) => r.status === "no_operator").length,
      deviceOffline: rows.filter((r) => r.status === "device_offline").length,
      totalPieces: rows.reduce((sum, r) => sum + r.totalPieces, 0),
      piecesThisHour: rows.reduce((sum, r) => sum + r.piecesThisHour, 0),
      operatorsWorking: operators.length,
      // Total pieces recorded on devices but not yet in this database.
      queuedOnDevices: rows.reduce(
        (sum, r) => sum + (r.device?.queueDepth || 0),
        0
      ),
    };

    return res.json({
      success: true,
      shiftDate,
      generatedAt: new Date(),
      summary,
      machines: rows,
      operators,
      recentScans,
    });
  } catch (error) {
    console.error("[Supervisor/overview] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

router.get("/overview", overviewHandler);
router.get("/overview/:date", overviewHandler);

// ─── GET /machine/:machineId ──────────────────────────────────────────────────
// Drill-down: every event for one machine on one day, newest first.
router.get("/machine/:machineId", async (req, res) => {
  try {
    const machineObjId = toObjectId(req.params.machineId);
    if (!machineObjId) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid machineId" });
    }
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }

    const limit = Math.min(Number(req.query.limit) || 500, 5000);

    const [machine, stats, heartbeat, events] = await Promise.all([
      Machine.findById(machineObjId, {
        name: 1,
        serialNumber: 1,
        type: 1,
        location: 1,
        status: 1,
      }).lean(),
      MachineDayStats.findOne({ shiftDate, machineId: machineObjId }).lean(),
      DeviceHeartbeat.findOne({ machineId: machineObjId }).lean(),
      ProductionEvent.find({ shiftDate, machineId: machineObjId })
        .sort({ scanTime: -1 })
        .limit(limit)
        .lean(),
    ]);

    if (!machine) {
      return res
        .status(404)
        .json({ success: false, message: "Machine not found" });
    }

    return res.json({
      success: true,
      shiftDate,
      machine,
      stats: stats || null,
      device: heartbeat || null,
      eventCount: events.length,
      events,
    });
  } catch (error) {
    console.error("[Supervisor/machine] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /operators[/:date] ───────────────────────────────────────────────────
const operatorsHandler = async (req, res) => {
  try {
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }
    const operators = await OperatorDayStats.find({ shiftDate })
      .sort({ totalPieces: -1 })
      .lean();
    return res.json({
      success: true,
      shiftDate,
      count: operators.length,
      operators,
    });
  } catch (error) {
    console.error("[Supervisor/operators] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

router.get("/operators", operatorsHandler);
router.get("/operators/:date", operatorsHandler);

// ─── GET /machine-status[/:date] ──────────────────────────────────────────────
// Live per-machine state straight off the rollup's read model, including
// efficiency against the operation registry's target time.
//
// This lives here rather than at /dashboard/machine-status, which is where the
// standalone barcode server served it: the CMS already has an endpoint at that
// path answering a completely different question (machine scheduling — free /
// busy / maintenance), and productionDashboardRoutes is mounted first, so a
// second one there would simply never be reached.
const machineStatusHandler = async (req, res) => {
  try {
    const shiftDate = resolveShiftDate(req);
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }
    const stats = await MachineDayStats.find({ shiftDate }).lean();
    res.json({
      success: true,
      date: shiftDate,
      machines: stats.map((s) => ({
        machineId: s.machineId,
        machineName: s.machineName,
        status: s.status,
        currentOperatorId: s.currentOperatorId,
        currentOperatorName: s.currentOperatorName,
        currentOps: s.currentOps,
        totalPieces: s.totalPieces,
        piecesThisHour: s.piecesThisHour,
        byOperation: s.byOperation,
        lastScanAt: s.lastScanAt,
      })),
    });
  } catch (error) {
    console.error("[Supervisor/machine-status] error:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

router.get("/machine-status", machineStatusHandler);
router.get("/machine-status/:date", machineStatusHandler);

module.exports = router;
