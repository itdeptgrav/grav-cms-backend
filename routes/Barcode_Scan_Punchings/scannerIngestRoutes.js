// routes/Barcode_Scan_Punchings/scannerIngestRoutes.js
//
// What the ESP32 scanners on the production floor post to.
// Mounted at /api/cms/production/barcode_punchings — the path the firmware
// builds from the server address in its NVS, so it cannot be renamed without
// walking the floor with a barcode sheet.
//
// MOUNTED EARLY IN server.js, ON PURPOSE. `app.use("/api/cms", productOperations)`
// carries a router-level EmployeeAuthMiddleware, so ANY /api/cms/** route
// registered after it answers 401 without a session. A scanner has no session
// and never will — it is a device on the factory LAN, not a logged-in user — so
// this router has to win on registration order. Moving this mount below that
// line takes the whole floor offline with a 401 the devices render as a red
// cross.
//
// Ingest is write-only and computation-free: an event arrives, it is inserted,
// the response goes back. No reads, no state machine, no read-modify-write.
// Everything that used to be computed here is derived by
// services/barcodeScanner/rollupStats.js from the events themselves.
//
// This replaces the older ./trackingRoutes.js, which is the stateful version
// that mutated ProductionTracking on every scan. That file is left in place,
// unmounted, as the record of what this used to do.

const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const crypto = require("crypto");

const B = "../../models/CMS_Models/Manufacturing/Production/Barcode";
const ProductionEvent = require(`${B}/ProductionEvent`);
const MachineDayStats = require(`${B}/MachineDayStats`);
const OperatorDayStats = require(`${B}/OperatorDayStats`);
const DeviceHeartbeat = require(`${B}/DeviceHeartbeat`);
const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
const Employee = require("../../models/Employee");

const {
  shiftDateFor,
  currentShiftDate,
  parseBarcode,
  normaliseActiveOps,
} = require("../../services/barcodeScanner/shift");
const realtime = require("../../services/barcodeScanner/realtime");

// ─── Helpers ──────────────────────────────────────────────────────────────────

const isBarcodeId = (id) => typeof id === "string" && id.startsWith("WO-");
const isEmployeeId = (id) => typeof id === "string" && id.startsWith("GR");

const extractEmployeeIdFromUrl = (value) => {
  try {
    if (!value || typeof value !== "string") return value;
    const trimmed = value.trim();
    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const parts = new URL(trimmed).pathname.split("/").filter(Boolean);
      return parts[parts.length - 1] || value;
    }
    return value;
  } catch {
    return value;
  }
};

const toObjectId = (id) => {
  try {
    return new mongoose.Types.ObjectId(String(id));
  } catch {
    return null;
  }
};

// A device clock that never synced produces 1970. The device now reconstructs
// the real time from elapsed millis and sets timeRecovered, so this should be
// rare — but a genuinely unusable timestamp still must not poison the shift
// bucket, so it falls back to server time and is flagged.
const resolveScanTime = (raw) => {
  if (!raw) return { scanTime: new Date(), recovered: true };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2024) {
    return { scanTime: new Date(), recovered: true };
  }
  return { scanTime: d, recovered: false };
};

// ─── Legacy payload compatibility ─────────────────────────────────────────────
// v5.4.0 firmware posts {scans:[{scanId,timeStamp,isEmployeeScan,action,...}]}
// with no eventId. Rather than force a flag day across 50 devices, those are
// translated here and given a deterministic eventId so a resend still dedupes.
// DELETE THIS BLOCK once every device reports firmware >= 5.5.0.
const synthesizeLegacyEventId = (deviceId, scanId, timeStamp) =>
  "legacy-" +
  crypto
    .createHash("sha1")
    .update(`${deviceId}|${scanId}|${timeStamp}`)
    .digest("hex")
    .slice(0, 24);

const legacyScanToEvent = (scan) => {
  const rawId = extractEmployeeIdFromUrl(scan.scanId);
  let type = "scan";
  if (scan.isEmployeeScan) {
    type = scan.action === "signout" ? "signout" : "signin";
  }
  return {
    eventId:
      scan.eventId ||
      synthesizeLegacyEventId(scan.deviceId, scan.scanId, scan.timeStamp),
    type,
    machineId: scan.machineId,
    deviceId: scan.deviceId,
    operatorId: scan.employeeId || (isEmployeeId(rawId) ? rawId : ""),
    operatorName: scan.employeeName || "",
    barcodeId: isBarcodeId(rawId) ? rawId : "",
    activeOps: scan.activeOps,
    scanTime: scan.timeStamp,
    timeRecovered: false,
  };
};

// ─── Event normalisation ──────────────────────────────────────────────────────
// Returns { doc } or { error }. Never throws — one bad event in a batch must
// not reject the other nineteen.
const buildEventDoc = (raw) => {
  if (!raw || typeof raw !== "object") return { error: "not an object" };

  const eventId = String(raw.eventId || "").trim();
  if (!eventId) return { error: "eventId is required" };

  const type = String(raw.type || "").trim();
  if (!ProductionEvent.EVENT_TYPES.includes(type)) {
    return { error: `unknown event type "${type}"` };
  }

  const machineObjId = toObjectId(raw.machineId);
  if (!machineObjId) return { error: "machineId is not a valid ObjectId" };

  const { scanTime, recovered } = resolveScanTime(raw.scanTime || raw.timeStamp);
  const shiftDate = shiftDateFor(scanTime);
  if (!shiftDate) return { error: "could not derive shiftDate" };

  const barcodeId = String(raw.barcodeId || "").trim();
  const { workOrderKey, unitNumber } = parseBarcode(barcodeId);

  return {
    doc: {
      eventId,
      type,
      machineId: machineObjId,
      deviceId: String(raw.deviceId || "").trim(),
      operatorId: String(raw.operatorId || "").trim(),
      operatorName: String(raw.operatorName || "").trim(),
      barcodeId,
      workOrderKey,
      unitNumber,
      activeOps: normaliseActiveOps(raw.activeOps),
      scanTime,
      receivedAt: new Date(),
      timeRecovered: recovered || raw.timeRecovered === true,
      shiftDate,
      breakReason: raw.breakReason || null,
      breakDurationSec:
        raw.breakDurationSec == null ? null : Number(raw.breakDurationSec),
      meta: raw.meta || null,
    },
  };
};

// ─── POST /events ─────────────────────────────────────────────────────────────
// The hot path. One scan per call on a healthy LAN; N when a device is
// draining a backlog. Same code either way.
//
// Duplicate eventIds are a SUCCESS, not an error: the device cannot tell "the
// server never got it" from "the server got it and the reply was lost", so it
// must retry, and the unique index is what makes that retry harmless.
const ingestHandler = async (req, res) => {
  try {
    const incoming = Array.isArray(req.body?.events)
      ? req.body.events
      : Array.isArray(req.body?.scans)
      ? req.body.scans.map(legacyScanToEvent) // v5.4.0 compatibility
      : null;

    if (!incoming || incoming.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "events array is required" });
    }

    const docs = [];
    const rejected = [];
    for (const raw of incoming) {
      const { doc, error } = buildEventDoc(raw);
      if (error) rejected.push({ eventId: raw?.eventId ?? null, error });
      else docs.push(doc);
    }

    let inserted = 0;
    let duplicates = 0;

    if (docs.length > 0) {
      try {
        const result = await ProductionEvent.insertMany(docs, {
          ordered: false,
          rawResult: true,
        });
        inserted = result.insertedCount ?? docs.length;
      } catch (err) {
        // ordered:false means the good documents are already committed.
        // Everything that failed on the unique index is an expected retry.
        const writeErrors = err?.writeErrors || err?.result?.result?.writeErrors || [];
        for (const we of writeErrors) {
          const code = we?.err?.code ?? we?.code;
          if (code === 11000) duplicates++;
          else
            rejected.push({
              eventId: we?.err?.op?.eventId ?? null,
              error: we?.errmsg || "write error",
            });
        }
        inserted = docs.length - writeErrors.length;
        if (writeErrors.length === 0) throw err; // not a bulk-write failure
      }
    }

    // Push to any connected dashboard. Deliberately AFTER the write and
    // wrapped so a socket problem can never fail an ingest — the device would
    // then retry events that are already durable.
    if (inserted > 0) {
      try {
        realtime.emitScans(docs);
      } catch (err) {
        console.error("[Ingest] socket emit failed (ignored):", err.message);
      }
    }

    // 2xx tells the device it is safe to clear these from its queue. Duplicates
    // count as accepted — they are already durable.
    return res.status(200).json({
      success: true,
      accepted: inserted + duplicates,
      inserted,
      duplicates,
      rejected: rejected.length,
      errors: rejected.slice(0, 10),
    });
  } catch (error) {
    console.error("[Ingest] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};

router.post("/events", ingestHandler);
// Same handler. Keeps v5.4.0 devices working during the rollout.
router.post("/bulk-scans", ingestHandler);

// ─── POST /heartbeat ──────────────────────────────────────────────────────────
// Liveness. Without this, "operator on break" and "device died an hour ago"
// are the same observation: no scans.
router.post("/heartbeat", async (req, res) => {
  try {
    const { deviceId } = req.body || {};
    if (!deviceId) {
      return res
        .status(400)
        .json({ success: false, message: "deviceId is required" });
    }

    const machineObjId = toObjectId(req.body.machineId);

    await DeviceHeartbeat.updateOne(
      { deviceId: String(deviceId).trim() },
      {
        $set: {
          machineId: machineObjId,
          machineName: req.body.machineName || "",
          firmwareVersion: req.body.firmwareVersion || "",
          ipAddress: req.body.ipAddress || "",
          wifiSSID: req.body.wifiSSID || "",
          rssi: req.body.rssi ?? null,
          wifiChannel: req.body.wifiChannel ?? null,
          queueDepth: Number(req.body.queueDepth || 0),
          queueHighWater: Number(req.body.queueHighWater || 0),
          currentOperatorId: req.body.currentOperatorId || null,
          activeOps: normaliseActiveOps(req.body.activeOps),
          onBreak: req.body.onBreak === true,
          bootCount: req.body.bootCount ?? null,
          uptimeSec: req.body.uptimeSec ?? null,
          resetReason: req.body.resetReason || "",
          lastHeartbeatAt: new Date(),
        },
      },
      { upsert: true }
    );

    // The device cannot test the database for itself, and it is the one failure
    // that would let a scan be accepted and then lost — Express keeps answering
    // long after Mongo has gone. The REFRESH_SYSTEM barcode shows this as its
    // own line so "server up, database down" is visible at the machine instead
    // of looking like a healthy device.
    const dbOk = require("mongoose").connection.readyState === 1;

    return res.json({
      success: true,
      serverTime: new Date().toISOString(),
      // There is no second hop any more: a scan is in the CMS's database as
      // soon as it is written here, so the cloud can never be "behind".
      // Reported as always-true because firmware 5.5.3+ turns the tick yellow
      // on false, and those devices are not being reflashed.
      cloudSyncOk: true,
      dbOk,
    });
  } catch (error) {
    console.error("[Heartbeat] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /stats/machines[/:date] ──────────────────────────────────────────────
// Express 5 removed the `:param?` syntax, so the optional segment is two
// registrations rather than one pattern.
const machineStatsHandler = async (req, res) => {
  try {
    const shiftDate = req.params.date
      ? shiftDateFor(new Date(req.params.date))
      : currentShiftDate();
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }
    const machines = await MachineDayStats.find({ shiftDate })
      .sort({ machineName: 1 })
      .lean();
    return res.json({
      success: true,
      shiftDate,
      count: machines.length,
      totalPieces: machines.reduce((sum, m) => sum + (m.totalPieces || 0), 0),
      machines,
    });
  } catch (error) {
    console.error("[Stats/machines] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};
router.get("/stats/machines", machineStatsHandler);
router.get("/stats/machines/:date", machineStatsHandler);

// ─── GET /stats/operators[/:date] ─────────────────────────────────────────────
const operatorStatsHandler = async (req, res) => {
  try {
    const shiftDate = req.params.date
      ? shiftDateFor(new Date(req.params.date))
      : currentShiftDate();
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
      totalPieces: operators.reduce((sum, o) => sum + (o.totalPieces || 0), 0),
      operators,
    });
  } catch (error) {
    console.error("[Stats/operators] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};
router.get("/stats/operators", operatorStatsHandler);
router.get("/stats/operators/:date", operatorStatsHandler);

// ─── GET /events[/:date] ──────────────────────────────────────────────────────
// Raw event access, for auditing a number a dashboard disagrees with.
const eventsHandler = async (req, res) => {
  try {
    const shiftDate = req.params.date
      ? shiftDateFor(new Date(req.params.date))
      : currentShiftDate();
    if (!shiftDate) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }

    const filter = { shiftDate };
    if (req.query.machineId) {
      const oid = toObjectId(req.query.machineId);
      if (oid) filter.machineId = oid;
    }
    if (req.query.operatorId) filter.operatorId = req.query.operatorId;
    if (req.query.type) filter.type = req.query.type;

    const limit = Math.min(Number(req.query.limit) || 500, 5000);
    const events = await ProductionEvent.find(filter)
      .sort({ scanTime: 1 })
      .limit(limit)
      .lean();

    return res.json({ success: true, shiftDate, count: events.length, events });
  } catch (error) {
    console.error("[Events] error:", error);
    return res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
};
router.get("/events", eventsHandler);
router.get("/events/:date", eventsHandler);

// ─── Legacy status endpoints ──────────────────────────────────────────────────
// Unchanged response shapes. They now read the ProductionTracking document the
// rollup generates instead of one the ingest path mutated, so every existing
// consumer keeps working without a change on their end.

const buildStatusResponse = async (queryDate) => {
  const trackingDoc = await ProductionTracking.findOne({ date: queryDate })
    .populate("machines.machineId", "name serialNumber type")
    .lean();

  if (!trackingDoc) return null;

  const identityIds = new Set();
  for (const machine of trackingDoc.machines) {
    if (machine.currentOperatorIdentityId)
      identityIds.add(machine.currentOperatorIdentityId);
    for (const op of machine.operators) identityIds.add(op.operatorIdentityId);
  }

  // Resolves both badge forms — see services/barcodeScanner/operators.js.
  const { buildOperatorNameResolver } = require("../../services/barcodeScanner/operators");
  const resolveName = await buildOperatorNameResolver(Employee);
  const empMap = Object.fromEntries(
    [...identityIds].map((id) => {
      const name = resolveName(id);
      return [id, name === id ? "" : name];
    })
  );

  let totalScans = 0;
  const machinesStatus = [];

  for (const machine of trackingDoc.machines) {
    let machineScans = 0;
    const operatorsWithDetails = [];

    for (const operator of machine.operators) {
      machineScans += operator.barcodeScans.length;
      totalScans += operator.barcodeScans.length;

      operatorsWithDetails.push({
        identityId: operator.operatorIdentityId,
        name:
          empMap[operator.operatorIdentityId] ||
          operator.operatorName ||
          "Unknown Operator",
        signInTime: operator.signInTime,
        signOutTime: operator.signOutTime,
        barcodeScans: operator.barcodeScans.map((s) => ({
          barcodeId: s.barcodeId,
          timeStamp: s.timeStamp,
          activeOps: s.activeOps || [],
        })),
        scanCount: operator.barcodeScans.length,
        isActive: !operator.signOutTime,
      });
    }

    machinesStatus.push({
      machineId: machine.machineId?._id,
      machineName: machine.machineId?.name || "Unknown Machine",
      machineSerial: machine.machineId?.serialNumber || "Unknown",
      currentOperator: machine.currentOperatorIdentityId
        ? {
            identityId: machine.currentOperatorIdentityId,
            name:
              empMap[machine.currentOperatorIdentityId] || "Unknown Operator",
          }
        : null,
      operators: operatorsWithDetails,
      machineScans,
    });
  }

  return {
    date: trackingDoc.date,
    totalMachines: trackingDoc.machines.length,
    totalScans,
    machines: machinesStatus,
  };
};

router.get("/status/today", async (req, res) => {
  try {
    const data = await buildStatusResponse(currentShiftDate());
    if (!data) {
      return res.json({
        success: true,
        message: "No tracking data for today",
        date: currentShiftDate(),
        machines: [],
        totalScans: 0,
        totalMachines: 0,
      });
    }
    res.json({ success: true, ...data });
  } catch (error) {
    console.error("Error getting today's status:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

router.get("/status/:date", async (req, res) => {
  try {
    const parsed = new Date(req.params.date);
    if (Number.isNaN(parsed.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid date format" });
    }
    const queryDate = shiftDateFor(parsed);
    const data = await buildStatusResponse(queryDate);
    if (!data) {
      return res.json({
        success: true,
        message: `No tracking data for ${req.params.date}`,
        date: queryDate,
        machines: [],
        totalScans: 0,
        totalMachines: 0,
      });
    }
    res.json({ success: true, ...data });
  } catch (error) {
    console.error("Error getting date status:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// ─── GET /machine/:machineId/operations ───────────────────────────────────────
// Same response shape as before, now served straight from events.
router.get("/machine/:machineId/operations", async (req, res) => {
  try {
    const machineObjId = toObjectId(req.params.machineId);
    if (!machineObjId) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid machineId" });
    }
    const shiftDate = currentShiftDate();

    const [stats, events] = await Promise.all([
      MachineDayStats.findOne({ shiftDate, machineId: machineObjId }).lean(),
      ProductionEvent.find(
        { shiftDate, machineId: machineObjId, type: "scan" },
        { workOrderKey: 1, operatorId: 1 }
      ).lean(),
    ]);

    const operationMap = {};
    for (const ev of events) {
      if (!ev.workOrderKey) continue;
      if (!operationMap[ev.workOrderKey]) {
        operationMap[ev.workOrderKey] = {
          shortId: ev.workOrderKey,
          scans: 0,
          operators: new Set(),
        };
      }
      operationMap[ev.workOrderKey].scans++;
      if (ev.operatorId) operationMap[ev.workOrderKey].operators.add(ev.operatorId);
    }

    const isActive = !!stats?.currentOperatorId;

    return res.json({
      success: true,
      machineId: req.params.machineId,
      machineName: stats?.machineName,
      totalScans: events.length,
      isActive,
      currentOperator: stats?.currentOperatorId || null,
      operations: Object.values(operationMap).map((wo) => ({
        workOrderShortId: wo.shortId,
        scansCount: wo.scans,
        operatorCount: wo.operators.size,
        isActive,
      })),
    });
  } catch (error) {
    console.error("Error getting machine operations:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

module.exports = router;
