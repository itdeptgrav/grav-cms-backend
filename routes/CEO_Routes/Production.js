/**
 * routes/CEO_Routes/production.js  (v5 — COMPLETE)
 *
 * Endpoints:
 *   GET /api/ceo/production/overview
 *   GET /api/ceo/production/live?date=
 *   GET /api/ceo/production/machines?date=
 *   GET /api/ceo/production/operators
 *   GET /api/ceo/production/operator-detail/:operatorId?date=&prevDate=
 *   GET /api/ceo/production/compare-operators?op1=&op2=&date=
 *   GET /api/ceo/production/top-performers?date=&limit=
 *   GET /api/ceo/production/operations-master
 *   GET /api/ceo/production/products?startDate=&endDate=
 *   GET /api/ceo/production/work-orders?status=&limit=
 *   GET /api/ceo/production/machine-detail/:machineId?date=
 */

"use strict";

const express = require("express");
const router  = express.Router();
const jwt     = require("jsonwebtoken");

// ── Auth ──────────────────────────────────────────────────────────────────────
function ceoAuth(req, res, next) {
  try {
    const token = req.cookies.auth_token;
    if (!token) return res.status(401).json({ success: false, message: "Authentication required" });
    const d = jwt.verify(token, process.env.JWT_SECRET || "grav_clothing_secret_key");
    if (!["ceo", "admin", "hr_manager", "project_manager"].includes(d.role))
      return res.status(403).json({ success: false, message: "CEO access required" });
    req.ceoUser = d;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "Invalid or expired token" });
  }
}

// ── Lazy model loader ─────────────────────────────────────────────────────────
const getModels = () => ({
  ProductionTracking: require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking"),
  WorkOrder:          require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder"),
  Machine:            require("../../models/CMS_Models/Inventory/Configurations/Machine"),
  Employee:           require("../../models/Employee"),
});

// ── IST today ─────────────────────────────────────────────────────────────────
const getTodayIST = () => {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

// UTC range query helper (avoids timezone bucket mismatch)
function utcRange(dateStr) {
  const start = new Date(dateStr + "T00:00:00.000Z");
  const end   = new Date(dateStr + "T00:00:00.000Z");
  end.setUTCDate(end.getUTCDate() + 1);
  return { $gte: start, $lt: end };
}

// ═════════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * 3-step employee ID resolution:
 *   Step 1 → biometricId exact match
 *   Step 2 → identityId exact match
 *   Step 3 → insert '0' after 'GR' prefix  (GR065 → GR0065)
 */
async function resolveEmployeeThreeStep(opId, Employee) {
  if (!opId) return null;

  let emp = await Employee.findOne({ biometricId: opId })
    .select("firstName lastName identityId biometricId profilePhoto department designation").lean();
  if (emp) return emp;

  emp = await Employee.findOne({ identityId: opId })
    .select("firstName lastName identityId biometricId profilePhoto department designation").lean();
  if (emp) return emp;

  if (/^GR\d+$/i.test(opId)) {
    const t = "GR0" + opId.slice(2);
    emp = await Employee.findOne({ $or: [{ biometricId: t }, { identityId: t }] })
      .select("firstName lastName identityId biometricId profilePhoto department designation").lean();
    if (emp) return emp;
  }
  return null;
}

/** Build dual-key lookup map (biometricId + identityId) */
function buildEmpMap(employees) {
  const m = new Map();
  for (const e of employees) {
    const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
    const data = { name, profilePhoto: e.profilePhoto, department: e.department, designation: e.designation, identityId: e.identityId, biometricId: e.biometricId };
    if (e.biometricId) m.set(e.biometricId, data);
    if (e.identityId && e.identityId !== e.biometricId) m.set(e.identityId, data);
  }
  return m;
}

/** Count unique barcode units: WO-{shortId}-{unitNum} */
function countUniquePieces(scans) {
  const s = new Set();
  for (const scan of scans) {
    const p = scan.barcodeId?.split("-");
    if (p && p[0] === "WO" && p.length >= 3) s.add(`${p[1]}-${p[2]}`);
  }
  return s.size;
}

/** Average scan interval (ignores gaps > 2 hours) */
const avgInterval = (scans = []) => {
  if (scans.length < 2) return null;
  const s = [...scans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
  const g = [];
  for (let i = 1; i < s.length; i++) {
    const d = (new Date(s[i].timeStamp) - new Date(s[i - 1].timeStamp)) / 1000;
    if (d > 0 && d < 7200) g.push(d);
  }
  return g.length ? Math.round(g.reduce((a, b) => a + b) / g.length) : null;
};

/** Parse barcode: WO-{shortId}-{unitNum} */
const parseBarcode = id => {
  if (!id) return null;
  const p = id.split("-");
  if (p[0] !== "WO" || p.length < 3) return null;
  return { shortId: p[1], unit: parseInt(p[2], 10) };
};

/** Group scans by hour for the productivity graph */
function buildHourlyProductivity(scans) {
  const b = {};
  for (let h = 0; h < 24; h++) b[h] = { hour: h, scans: 0, pieces: new Set() };
  for (const scan of scans) {
    if (!scan.timeStamp) continue;
    const h = new Date(scan.timeStamp).getHours();
    b[h].scans++;
    const p = scan.barcodeId?.split("-");
    if (p && p[0] === "WO" && p.length >= 3) b[h].pieces.add(`${p[1]}-${p[2]}`);
  }
  return Object.values(b).map(x => ({
    hour:   x.hour,
    label:  `${x.hour === 0 ? 12 : x.hour > 12 ? x.hour - 12 : x.hour}${x.hour < 12 ? "AM" : "PM"}`,
    scans:  x.scans,
    pieces: x.pieces.size,
  })).filter(x => x.scans > 0);
}

/** Idle periods: consecutive scan gaps > thresholdMins */
function findIdlePeriods(scans, thresholdMins = 10) {
  if (scans.length < 2) return [];
  const sorted = [...scans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
  const idle = [];
  for (let i = 1; i < sorted.length; i++) {
    const gapMs   = new Date(sorted[i].timeStamp) - new Date(sorted[i - 1].timeStamp);
    const gapMins = gapMs / 60000;
    if (gapMins < thresholdMins) continue;
    const fromH = new Date(sorted[i - 1].timeStamp).getHours();
    let likely = "unscheduled";
    if (fromH >= 12 && fromH <= 14 && gapMins >= 20 && gapMins <= 90) likely = "lunch";
    else if ((fromH >= 10 && fromH <= 11) || (fromH >= 15 && fromH <= 16)) {
      if (gapMins >= 5 && gapMins <= 25) likely = "tea break";
    }
    idle.push({ from: sorted[i - 1].timeStamp, to: sorted[i].timeStamp, durationMins: Math.round(gapMins), likely });
  }
  return idle;
}

/**
 * Per-operation efficiency vs SAM.
 * opMasterMap: operationCode → { operationName, samValue (mins), plannedTimeSeconds }
 */
function buildOperationsBreakdown(scans, opMasterMap) {
  const buckets = {};
  for (const scan of scans) {
    const ops = Array.isArray(scan.activeOps)
      ? scan.activeOps
      : typeof scan.activeOps === "string"
      ? scan.activeOps.split(",").map(s => s.trim()).filter(Boolean)
      : [];
    for (const code of ops) {
      if (!buckets[code]) buckets[code] = [];
      buckets[code].push(new Date(scan.timeStamp));
    }
  }
  return Object.entries(buckets).map(([code, timestamps]) => {
    const master    = opMasterMap.get(code);
    const sorted    = timestamps.sort((a, b) => a - b);
    let avgI = null;
    if (sorted.length >= 2) {
      const gaps = [];
      for (let i = 1; i < sorted.length; i++) {
        const d = (sorted[i] - sorted[i - 1]) / 1000;
        if (d >= 5 && d <= 1800) gaps.push(d);
      }
      if (gaps.length) avgI = Math.round(gaps.reduce((a, b) => a + b) / gaps.length);
    }
    // durationSeconds = SAM × 60, totalSam = SAM in minutes
    const samSecs = master?.durationSeconds || (master?.totalSam ? Math.round(master.totalSam * 60) : null);
    const effPct  = samSecs && avgI && avgI > 0 ? Math.round((samSecs / avgI) * 100) : null;
    return {
      opCode:          code,
      opName:          master?.name || code,
      machineType:     master?.machineType || null,
      samSecs,
      samMins:         samSecs ? +(samSecs / 60).toFixed(1) : null,
      scanCount:       timestamps.length,
      avgIntervalSecs: avgI,
      efficiencyPct:   effPct,
    };
  }).sort((a, b) => b.scanCount - a.scanCount);
}

/** Composite performance score 0–100 */
function calcPerformanceScore({ uniquePieces, sessionMins, avgIntervalSecs, operationsBreakdown }) {
  let score = 0;
  const pph = sessionMins > 0 ? (uniquePieces / (sessionMins / 60)) : 0;
  score += Math.min(50, (pph / 10) * 50);
  const effs = (operationsBreakdown || []).filter(o => o.efficiencyPct !== null).map(o => o.efficiencyPct);
  score += effs.length ? Math.min(30, (effs.reduce((a, b) => a + b) / effs.length / 100) * 30) : 15;
  if (avgIntervalSecs) score += Math.max(0, (1 - (avgIntervalSecs - 120) / 480)) * 20;
  else score += 10;
  return Math.round(Math.min(100, Math.max(0, score)));
}

/** Load operation master map */
async function loadOpMaster() {
  const map = new Map();
  try {
    const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
    const ops = await Operation.find({}).select("operationCode name totalSam durationSeconds machineType").lean();
    ops.forEach(op => { const c = op.operationCode || ""; if (c) map.set(c, op); });
  } catch (_) {}
  return map;
}

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/overview
// ═════════════════════════════════════════════════════════════════════════════
router.get("/overview", ceoAuth, async (req, res) => {
  try {
    const { WorkOrder, ProductionTracking, Employee } = getModels();
    const som = new Date(); som.setDate(1); som.setHours(0, 0, 0, 0);

    const [tWO, oWO, cWO, pWO, cmWO, tOps] = await Promise.all([
      WorkOrder.countDocuments({}),
      WorkOrder.countDocuments({ status: "in_progress" }),
      WorkOrder.countDocuments({ status: "completed" }),
      WorkOrder.countDocuments({ status: { $in: ["pending", "planned", "scheduled", "ready_to_start"] } }),
      WorkOrder.countDocuments({ status: "completed", updatedAt: { $gte: som } }),
      Employee.countDocuments({ needsToOperate: true, isActive: true }),
    ]);

    const doc = await ProductionTracking.findOne({ date: utcRange(getTodayIST()) }).lean();
    let activeNow = 0, signedOut = 0, totalScans = 0;
    const actMach = new Set();
    if (doc) {
      for (const m of doc.machines || []) {
        let had = false;
        for (const op of m.operators || []) {
          if (!op.signOutTime) activeNow++; else signedOut++;
          totalScans += op.barcodeScans?.length || 0;
          if ((op.barcodeScans?.length || 0) > 0) had = true;
        }
        if (had || m.currentOperatorIdentityId) actMach.add(m.machineId?.toString());
      }
    }

    res.json({
      success: true, data: {
        workOrders: { total: tWO, ongoing: oWO, completed: cWO, pending: pWO, completedThisMonth: cmWO },
        operators:  { total: tOps, activeNow, signedOutToday: signedOut, totalScansToday: totalScans },
        machines:   { activeToday: actMach.size },
      },
    });
  } catch (err) {
    console.error("[CEO] /overview:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/live?date=YYYY-MM-DD
//  Includes: attendance signout fallback, operatorSummaries per machine
// ═════════════════════════════════════════════════════════════════════════════
router.get("/live", ceoAuth, async (req, res) => {
  try {
    const { ProductionTracking, Machine, Employee, WorkOrder } = getModels();
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
    const dateStr = req.query.date || getTodayIST();

    const [doc, allMachines, attendanceDoc] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) })
        .populate("machines.machineId", "name serialNumber type location").lean(),
      Machine.find({}).select("name serialNumber type location status").lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
    ]);

    // WO map for scan enrichment
    const wos = await WorkOrder.find({ status: { $in: ["in_progress", "scheduled", "ready_to_start", "planned", "pending"] } })
      .select("workOrderNumber stockItemName _id").lean();
    const woMap = {};
    wos.forEach(w => { woMap[w._id.toString().slice(-8)] = w; });

    const machMap = {};
    allMachines.forEach(m => { machMap[m._id.toString()] = m; });

    // Attendance map for signout fallback
    const attMap = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const entry = { finalOut: e.finalOut, inTime: e.inTime };
      if (e.biometricId) attMap.set(e.biometricId, entry);
      if (e.identityId && e.identityId !== e.biometricId) attMap.set(e.identityId, entry);
    }

    // Employee lookup map (batch — avoids N+1)
    const allEmps = await Employee.find({ isActive: true })
      .select("firstName lastName identityId biometricId profilePhoto needsToOperate").lean();
    const empByAnyId = buildEmpMap(allEmps);

    if (!doc) {
      return res.json({
        success: true, date: dateStr,
        machines: allMachines.map(m => ({
          machineId: m._id.toString(), machineName: m.name || "Unknown",
          machineSerial: m.serialNumber, machineType: m.type,
          status: m.status === "Under Maintenance" ? "maintenance" : "free",
          currentOperator: null, operators: [], operatorSummaries: [], totalScans: 0,
        })),
        summary: { totalOperators: 0, activeNow: 0, totalScans: 0, activeMachines: 0, totalMachines: allMachines.length },
      });
    }

    let globalActive = 0, globalScans = 0, globalActiveMach = 0;
    const machinesData = [];
    const trackedIds   = new Set();

    for (const machine of doc.machines || []) {
      const mInfo = machine.machineId || {};
      const mId   = mInfo._id?.toString() || machine.machineId?.toString();
      trackedIds.add(mId);

      const opsData = [];
      let   machScans = 0;

      for (const op of machine.operators || []) {
        const opId    = op.operatorIdentityId;
        const empData = empByAnyId.get(opId);

        const name = (op.operatorName?.trim() && op.operatorName !== "Unknown Operator")
          ? op.operatorName.trim()
          : (empData?.name?.trim() || opId || "Unknown");

        const scans        = op.barcodeScans || [];
        const signInDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
        const isStale      = signInDateStr && signInDateStr !== dateStr;

        // ── Attendance signout fallback ────────────────────────────────────
        const attEntry = attMap.get(opId);
        let effectiveSignOut         = op.signOutTime || null;
        let didNotSignOutFromMachine = false;
        let attendanceResolvedSignOut = false;

        if (!op.signOutTime && !isStale && attEntry?.finalOut) {
          effectiveSignOut          = attEntry.finalOut;
          didNotSignOutFromMachine  = true;
          attendanceResolvedSignOut = true;
        }

        const isActive = !op.signOutTime && !isStale;

        // Unique pieces
        const uniqueUnits = new Set();
        for (const s of scans) {
          const p = s.barcodeId?.split("-");
          if (p && p[0] === "WO" && p.length >= 3) uniqueUnits.add(`${p[1]}-${p[2]}`);
        }

        if (isActive) globalActive++;
        machScans += scans.length;

        const sorted  = [...scans].sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
        const lastScan = sorted[0]?.timeStamp || null;
        const lastOps  = Array.isArray(sorted[0]?.activeOps)
          ? sorted[0].activeOps
          : (typeof sorted[0]?.activeOps === "string" ? sorted[0].activeOps.split(",").filter(Boolean) : []);

        // WO buckets
        const woBuckets = {};
        scans.forEach(s => {
          const parsed = parseBarcode(s.barcodeId);
          if (!parsed) return;
          const wo = woMap[parsed.shortId];
          if (!woBuckets[parsed.shortId])
            woBuckets[parsed.shortId] = { shortId: parsed.shortId, woNumber: wo?.workOrderNumber, woName: wo?.stockItemName, units: new Set(), scans: 0 };
          woBuckets[parsed.shortId].units.add(s.barcodeId);
          woBuckets[parsed.shortId].scans++;
        });

        const sessMs = isStale ? 0
          : isActive
          ? Date.now() - new Date(op.signInTime).getTime()
          : effectiveSignOut
          ? Math.min(new Date(effectiveSignOut) - new Date(op.signInTime), 14 * 3600 * 1000)
          : 0;

        opsData.push({
          identityId:               opId,
          name,
          profilePhoto:             empData?.profilePhoto || null,
          signInTime:               op.signInTime,
          signOutTime:              op.signOutTime || null,
          effectiveSignOut,
          didNotSignOutFromMachine,
          attendanceResolvedSignOut,
          isActive,
          isStale,
          totalScans:               scans.length,
          uniquePieces:             uniqueUnits.size,
          avgScanIntervalSecs:      avgInterval(scans),
          lastScanTime:             lastScan,
          lastActiveOps:            lastOps,
          sessionDurationMs:        Math.max(0, sessMs),
          workOrders:               Object.values(woBuckets).map(b => ({
            shortId: b.shortId, woNumber: b.woNumber, woName: b.woName,
            unitsDone: b.units.size, scans: b.scans,
          })),
          recentScans: sorted.slice(0, 10).map(s => ({
            barcodeId: s.barcodeId, timeStamp: s.timeStamp,
            activeOps: Array.isArray(s.activeOps) ? s.activeOps : [],
          })),
        });
      }

      // Machine-level unique pieces
      const mUnits = new Set();
      for (const op of machine.operators || [])
        for (const s of op.barcodeScans || []) {
          const p = s.barcodeId?.split("-");
          if (p && p[0] === "WO" && p.length >= 3) mUnits.add(`${p[1]}-${p[2]}`);
        }

      globalScans += machScans;
      if (machScans > 0 || machine.currentOperatorIdentityId) globalActiveMach++;

      // Current operator display
      let curr = null;
      if (machine.currentOperatorIdentityId) {
        const cId  = machine.currentOperatorIdentityId;
        const cSess = opsData.find(o => o.identityId === cId && o.isActive);
        const cEmp  = empByAnyId.get(cId);
        curr = { identityId: cId, name: cSess?.name || cEmp?.name || cId, profilePhoto: cSess?.profilePhoto || cEmp?.profilePhoto || null };
      }

      // Per-operator summary for machine card
      const opSummaryMap = new Map();
      for (const op of opsData) {
        if (!opSummaryMap.has(op.identityId)) {
          opSummaryMap.set(op.identityId, {
            identityId: op.identityId, name: op.name, profilePhoto: op.profilePhoto,
            pieces: 0, earliestSignIn: null, latestSignOut: null, isActiveNow: false,
          });
        }
        const s = opSummaryMap.get(op.identityId);
        s.pieces += op.uniquePieces;
        if (op.signInTime && (!s.earliestSignIn || new Date(op.signInTime) < new Date(s.earliestSignIn))) s.earliestSignIn = op.signInTime;
        if (op.effectiveSignOut && (!s.latestSignOut || new Date(op.effectiveSignOut) > new Date(s.latestSignOut))) s.latestSignOut = op.effectiveSignOut;
        if (op.isActive) s.isActiveNow = true;
      }

      const mRef = machMap[mId] || {};
      machinesData.push({
        machineId:             mId,
        machineName:           mInfo.name || mRef.name || "Unknown",
        machineSerial:         mInfo.serialNumber || mRef.serialNumber,
        machineType:           mInfo.type || mRef.type,
        machineLocation:       mInfo.location || mRef.location,
        status:                machine.currentOperatorIdentityId ? "busy" : machScans > 0 ? "used_today" : "free",
        currentOperator:       curr,
        operators:             opsData.sort((a, b) => (a.isActive ? -1 : 1) - (b.isActive ? -1 : 1)),
        operatorSummaries:     Array.from(opSummaryMap.values()).sort((a, b) => (a.isActiveNow ? -1 : 1) - (b.isActiveNow ? -1 : 1)),
        totalScans:            machScans,
        uniquePiecesCompleted: mUnits.size,
      });
    }

    // Un-tracked machines
    allMachines.forEach(m => {
      const mId = m._id.toString();
      if (trackedIds.has(mId)) return;
      machinesData.push({
        machineId: mId, machineName: m.name || "Unknown", machineSerial: m.serialNumber,
        machineType: m.type, machineLocation: m.location,
        status: m.status === "Under Maintenance" ? "maintenance" : m.status === "Offline" ? "offline" : "free",
        currentOperator: null, operators: [], operatorSummaries: [], totalScans: 0, uniquePiecesCompleted: 0,
      });
    });

    res.json({
      success: true, date: dateStr, machines: machinesData,
      summary: {
        totalOperators: machinesData.reduce((s, m) => s + m.operators.length, 0),
        activeNow:      globalActive,
        totalScans:     globalScans,
        activeMachines: globalActiveMach,
        totalMachines:  allMachines.length,
      },
    });
  } catch (err) {
    console.error("[CEO] /live:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/machines?date=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/machines", ceoAuth, async (req, res) => {
  try {
    const { Machine, ProductionTracking } = getModels();
    const dateStr = req.query.date || getTodayIST();
    const [allM, doc] = await Promise.all([
      Machine.find({}).select("name serialNumber type location status").lean(),
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
    ]);
    const activeMap = new Map();
    if (doc) for (const m of doc.machines || []) {
      const id = m.machineId?.toString();
      if (id) activeMap.set(id, !!m.currentOperatorIdentityId);
    }
    const machines = allM.map(m => {
      const id = m._id.toString(), busy = activeMap.get(id) ?? false;
      let status = "free";
      if (m.status === "Under Maintenance" || m.status === "maintenance") status = "maintenance";
      else if (m.status === "Offline" || m.status === "offline") status = "offline";
      else if (busy) status = "busy";
      return { _id: m._id, name: m.name, serialNumber: m.serialNumber, type: m.type, location: m.location, status, isActiveToday: activeMap.has(id) };
    });
    res.json({ success: true, machines, total: machines.length });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/operators
// ═════════════════════════════════════════════════════════════════════════════
router.get("/operators", ceoAuth, async (req, res) => {
  try {
    const { Employee, ProductionTracking } = getModels();
    const dateStr = getTodayIST();

    const allOps = await Employee.find({ needsToOperate: true, isActive: true })
      .select("firstName lastName identityId biometricId department designation profilePhoto").lean();

    const [doc, allMachines] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      require("../../models/CMS_Models/Inventory/Configurations/Machine").find({}).select("name _id").lean(),
    ]);

    const machNameMap = new Map(allMachines.map(m => [m._id.toString(), m.name]));
    const aMap        = new Map(); // trackingId → activity

    if (doc) {
      for (const m of doc.machines || []) {
        for (const op of m.operators || []) {
          const id = op.operatorIdentityId;
          if (!id) continue;
          if (!aMap.has(id)) aMap.set(id, { isActiveNow: false, signInTime: null, totalScans: 0, avgI: null, lastScan: null, machIds: new Set() });
          const a = aMap.get(id);
          if (!op.signOutTime) a.isActiveNow = true;
          if (!a.signInTime || new Date(op.signInTime) < new Date(a.signInTime)) a.signInTime = op.signInTime;
          a.totalScans += op.barcodeScans?.length || 0;
          if (op.barcodeScans?.length) {
            a.machIds.add(m.machineId?.toString());
            const iv = avgInterval(op.barcodeScans);
            if (iv) a.avgI = iv;
            const sorted = [...op.barcodeScans].sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
            if (sorted[0] && (!a.lastScan || new Date(sorted[0].timeStamp) > new Date(a.lastScan))) a.lastScan = sorted[0].timeStamp;
          }
        }
      }
    }

    const result = allOps.map(e => {
      const name     = `${e.firstName || ""} ${e.lastName || ""}`.trim();
      const activity = aMap.get(e.identityId) || aMap.get(e.biometricId) || null;
      const mIds     = activity?.machIds ? Array.from(activity.machIds) : [];
      return {
        _id:                e._id,
        identityId:         e.identityId || e.biometricId || e._id.toString(),
        biometricId:        e.biometricId,
        name,
        department:         e.department,
        designation:        e.designation,
        profilePhoto:       e.profilePhoto,
        isActiveNow:        activity?.isActiveNow || false,
        hasActivityToday:   (activity?.totalScans || 0) > 0 || activity?.isActiveNow || false,
        signInTime:         activity?.signInTime || null,
        lastScanTime:       activity?.lastScan || null,
        totalScansToday:    activity?.totalScans || 0,
        avgScanIntervalSecs: activity?.avgI || null,
        machinesUsed:       mIds,
        machineName:        mIds.length ? (machNameMap.get(mIds[mIds.length - 1]) || null) : null,
      };
    }).sort((a, b) => {
      if (a.isActiveNow !== b.isActiveNow) return a.isActiveNow ? -1 : 1;
      if (a.hasActivityToday !== b.hasActivityToday) return a.hasActivityToday ? -1 : 1;
      return b.totalScansToday - a.totalScansToday;
    });

    res.json({ success: true, operators: result, total: result.length, date: dateStr });
  } catch (err) {
    console.error("[CEO] /operators:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/operator-detail/:operatorId
//  ?date=YYYY-MM-DD   (required)
//  ?prevDate=YYYY-MM-DD  (optional, defaults to previous calendar day)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/operator-detail/:operatorId", ceoAuth, async (req, res) => {
  try {
    const { operatorId } = req.params;
    const dateStr    = req.query.date || getTodayIST();
    const prevDateStr = req.query.prevDate || (() => {
      const d = new Date(dateStr + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().split("T")[0];
    })();

    const { ProductionTracking, Employee } = getModels();
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
    const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");

    const [opMasterMap, allEmps, allMachines] = await Promise.all([
      loadOpMaster(),
      Employee.find({ isActive: true }).select("firstName lastName identityId biometricId profilePhoto department designation").lean(),
      Machine.find({}).select("name _id").lean(),
    ]);

    const empMap      = buildEmpMap(allEmps);
    const machNameMap = new Map(allMachines.map(m => [m._id.toString(), m.name]));
    let empData       = empMap.get(operatorId);
    if (!empData) {
      const raw = await resolveEmployeeThreeStep(operatorId, Employee);
      if (raw) empData = { name: `${raw.firstName || ""} ${raw.lastName || ""}`.trim(), profilePhoto: raw.profilePhoto, department: raw.department, designation: raw.designation };
    }
    empData = empData || { name: operatorId };

    const [trackingDoc, prevTrackingDoc, attendanceDoc] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      ProductionTracking.findOne({ date: utcRange(prevDateStr) }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
    ]);

    // Attendance data for this operator
    const attEntry = (attendanceDoc?.employees || []).find(e =>
      e.biometricId === operatorId || e.identityId === operatorId
    ) || null;

    // ── Collect sessions ───────────────────────────────────────────────────
    const sessions   = [];
    let   allScansFlat = [];

    for (const machine of (trackingDoc?.machines || [])) {
      const mId   = machine.machineId?.toString();
      const mName = machNameMap.get(mId) || "Unknown Machine";

      for (const op of (machine.operators || [])) {
        if (op.operatorIdentityId !== operatorId) continue;

        const signInDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
        const isStale       = signInDateStr && signInDateStr !== dateStr;

        let effectiveSignOut          = op.signOutTime || null;
        let didNotSignOutFromMachine  = false;
        let attendanceResolvedSignOut = false;

        if (!op.signOutTime && !isStale && attEntry?.finalOut) {
          effectiveSignOut          = attEntry.finalOut;
          didNotSignOutFromMachine  = true;
          attendanceResolvedSignOut = true;
        }

        const scans      = op.barcodeScans || [];
        const sessStartMs = new Date(op.signInTime).getTime();
        const sessEndMs   = effectiveSignOut
          ? new Date(effectiveSignOut).getTime()
          : (!isStale ? Date.now() : sessStartMs);
        const sessMs      = Math.max(0, sessEndMs - sessStartMs);

        allScansFlat = allScansFlat.concat(scans);

        sessions.push({
          machineId: mId, machineName: mName,
          signInTime: op.signInTime,
          signOutTime: op.signOutTime || null,
          effectiveSignOut,
          didNotSignOutFromMachine,
          attendanceResolvedSignOut,
          isStale,
          isActive: !op.signOutTime && !isStale,
          totalScans: scans.length,
          uniquePieces: countUniquePieces(scans),
          sessionDurationMs: sessMs,
        });
      }
    }

    // ── Aggregated ─────────────────────────────────────────────────────────
    const totalScans   = allScansFlat.length;
    const uniquePieces = countUniquePieces(allScansFlat);
    const totalMs      = sessions.reduce((s, x) => s + x.sessionDurationMs, 0);
    const sessionMins  = totalMs / 60000;

    const sortedScans = [...allScansFlat].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
    const firstScan   = sortedScans[0]?.timeStamp || null;
    const lastScan    = sortedScans[sortedScans.length - 1]?.timeStamp || null;

    let avgScanIntervalSecs = null;
    if (sortedScans.length >= 2) {
      const gaps = [];
      for (let i = 1; i < sortedScans.length; i++) {
        const d = (new Date(sortedScans[i].timeStamp) - new Date(sortedScans[i - 1].timeStamp)) / 1000;
        if (d > 0 && d < 3600) gaps.push(d);
      }
      if (gaps.length) avgScanIntervalSecs = Math.round(gaps.reduce((a, b) => a + b) / gaps.length);
    }

    const hourlyProductivity  = buildHourlyProductivity(allScansFlat);
    const operationsBreakdown = buildOperationsBreakdown(allScansFlat, opMasterMap);
    const idlePeriods         = findIdlePeriods(sortedScans, 10);
    const performanceScore    = calcPerformanceScore({ uniquePieces, sessionMins, avgScanIntervalSecs, operationsBreakdown });

    const morningScans   = allScansFlat.filter(s => new Date(s.timeStamp).getHours() < 12).length;
    const afternoonScans = allScansFlat.length - morningScans;

    // WO contribution
    const woAgg = {};
    for (const scan of allScansFlat) {
      const p = scan.barcodeId?.split("-");
      if (p && p[0] === "WO" && p.length >= 3) {
        const k = p[1];
        if (!woAgg[k]) woAgg[k] = { shortId: k, units: new Set(), scans: 0 };
        woAgg[k].units.add(`${p[1]}-${p[2]}`);
        woAgg[k].scans++;
      }
    }
    const workOrders = Object.values(woAgg).map(w => ({ shortId: w.shortId, units: w.units.size, scans: w.scans })).sort((a, b) => b.units - a.units);

    // ── Previous date stats ────────────────────────────────────────────────
    let previousDate = null;
    if (prevTrackingDoc) {
      let prevScans = [], prevMs = 0;
      for (const m of prevTrackingDoc.machines || [])
        for (const op of m.operators || []) {
          if (op.operatorIdentityId !== operatorId) continue;
          prevScans = prevScans.concat(op.barcodeScans || []);
          const ms  = op.signOutTime ? new Date(op.signOutTime) - new Date(op.signInTime) : 0;
          prevMs   += Math.max(0, ms);
        }
      const pPieces = countUniquePieces(prevScans);
      const pSorted = [...prevScans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
      let pAvgI = null;
      if (pSorted.length >= 2) {
        const g = [];
        for (let i = 1; i < pSorted.length; i++) {
          const d = (new Date(pSorted[i].timeStamp) - new Date(pSorted[i - 1].timeStamp)) / 1000;
          if (d > 0 && d < 3600) g.push(d);
        }
        if (g.length) pAvgI = Math.round(g.reduce((a, b) => a + b) / g.length);
      }
      const pOpsBreak = buildOperationsBreakdown(prevScans, opMasterMap);
      const pScore    = calcPerformanceScore({ uniquePieces: pPieces, sessionMins: prevMs / 60000, avgScanIntervalSecs: pAvgI, operationsBreakdown: pOpsBreak });

      previousDate = { date: prevDateStr, totalScans: prevScans.length, uniquePieces: pPieces, avgScanIntervalSecs: pAvgI, performanceScore: pScore, sessionMins: Math.round(prevMs / 60000) };
    }

    // ── Product enrichment: load WOs + StockItems to build productBreakdown ──
    let productBreakdown = [];
    try {
      const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
      const StockItem  = require("../../models/CMS_Models/Inventory/Products/StockItem");
      const allWOs2 = await WorkOrder.find({}).select("_id workOrderNumber stockItemId stockItemName variantAttributes quantity").lean();
      const woByShortId2 = new Map(allWOs2.map(wo => [wo._id.toString().slice(-8), wo]));
      const siIds2 = new Set(workOrders.map(w => woByShortId2.get(w.shortId)?.stockItemId?.toString()).filter(Boolean));
      const stockItems2 = siIds2.size > 0
        ? await StockItem.find({ _id: { $in: [...siIds2] } }).select("name genderCategory category images operations variants").lean()
        : [];
      const siMap2 = new Map(stockItems2.map(si => [si._id.toString(), si]));
 
      productBreakdown = workOrders.map(w => {
        const wo  = woByShortId2.get(w.shortId);
        const si  = wo?.stockItemId ? siMap2.get(wo.stockItemId.toString()) : null;
        let image = null;
        if (si?.images?.length > 0) image = si.images[0];
        else if (si?.variants?.length > 0) { const v = si.variants.find(vv => vv.images?.length > 0); if (v) image = v.images[0]; }
 
        // Per-op breakdown for THIS product's defined operations
        const siOps = (si?.operations || []).filter(op => !!op.operationCode);
        const opsForProduct = siOps.map(siOp => {
          const ob = operationsBreakdown.find(o => o.opCode === siOp.operationCode);
          const samSecs = siOp.totalSeconds || 0;
          const avgActual = ob?.avgIntervalSecs || null;
          const effPct = samSecs && avgActual ? Math.round((samSecs / avgActual) * 100) : null;
          return {
            opCode:          siOp.operationCode,
            opName:          siOp.type || siOp.operationCode,
            machineType:     siOp.machineType || siOp.machine || null,
            samSecs,
            samMins:         samSecs ? +(samSecs / 60).toFixed(1) : null,
            avgIntervalSecs: avgActual,
            efficiencyPct:   effPct,
            scanCount:       ob?.scanCount || 0,
          };
        });
 
        return {
          shortId:          w.shortId,
          workOrderNumber:  wo?.workOrderNumber  || `WO-${w.shortId}`,
          stockItemName:    si?.name || wo?.stockItemName || "Unknown Product",
          genderCategory:   si?.genderCategory   || null,
          category:         si?.category         || null,
          image,
          variantAttributes: wo?.variantAttributes || [],
          pieces:  w.units,
          scans:   w.scans,
          operations: opsForProduct,
        };
      }).sort((a, b) => b.pieces - a.pieces);
    } catch (e2) {
      console.error("[CEO] /operator-detail productBreakdown:", e2.message);
    }
 
    // Enrich operationsBreakdown SAM from StockItem — overrides op master when null
    if (productBreakdown.length > 0) {
      const siSamMap = new Map();
      for (const prod of productBreakdown) {
        for (const op of prod.operations || []) {
          if (op.samSecs > 0 && !siSamMap.has(op.opCode)) {
            siSamMap.set(op.opCode, { samSecs: op.samSecs, samMins: op.samMins, opName: op.opName });
          }
        }
      }
      for (const ob of operationsBreakdown) {
        if ((!ob.samSecs || ob.samSecs === 0) && siSamMap.has(ob.opCode)) {
          const si = siSamMap.get(ob.opCode);
          ob.samSecs = si.samSecs;
          ob.samMins = si.samMins;
          if (!ob.opName || ob.opName === ob.opCode) ob.opName = si.opName;
          if (ob.avgIntervalSecs) ob.efficiencyPct = Math.round((ob.samSecs / ob.avgIntervalSecs) * 100);
        }
      }
    }

    res.json({
      success: true, date: dateStr,
      operator: { identityId: operatorId, name: empData.name, department: empData.department, designation: empData.designation, profilePhoto: empData.profilePhoto },
      sessions,
      aggregated: { totalScans, uniquePieces, totalSessionMs: totalMs, sessionMins: Math.round(sessionMins), avgScanIntervalSecs, firstScan, lastScan, morningScans, afternoonScans, idleCount: idlePeriods.length, totalIdleMins: idlePeriods.reduce((s, i) => s + i.durationMins, 0) },
      performanceScore,
      hourlyProductivity,
      operationsBreakdown,
      idlePeriods,
      workOrders,
      productBreakdown,
      attendance: attEntry ? { inTime: attEntry.inTime, finalOut: attEntry.finalOut, lunchOut: attEntry.lunchOut, lunchIn: attEntry.lunchIn, teaOut: attEntry.teaOut, teaIn: attEntry.teaIn, netWorkMins: attEntry.netWorkMins, status: attEntry.hrFinalStatus || attEntry.systemPrediction || null } : null,
      previousDate,
    });
  } catch (err) {
    console.error("[CEO] /operator-detail:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/compare-operators?op1=&op2=&date=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/compare-operators", ceoAuth, async (req, res) => {
  try {
    const { op1, op2, date } = req.query;
    const dateStr = date || getTodayIST();
    if (!op1 || !op2) return res.status(400).json({ success: false, message: "op1 and op2 required" });

    const { ProductionTracking, Employee } = getModels();
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

    const [opMasterMap, trackingDoc, attendanceDoc, allEmps] = await Promise.all([
      loadOpMaster(),
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true }).select("firstName lastName identityId biometricId profilePhoto department").lean(),
    ]);

    const empMap = buildEmpMap(allEmps);
    const attMap = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const entry = { finalOut: e.finalOut };
      if (e.biometricId) attMap.set(e.biometricId, entry);
      if (e.identityId && e.identityId !== e.biometricId) attMap.set(e.identityId, entry);
    }

    const buildStats = async (opId) => {
      let empData = empMap.get(opId);
      if (!empData) {
        const raw = await resolveEmployeeThreeStep(opId, Employee);
        empData = raw ? { name: `${raw.firstName || ""} ${raw.lastName || ""}`.trim(), profilePhoto: raw.profilePhoto, department: raw.department } : { name: opId };
      }

      let allScans = [], totalMs = 0;
      for (const m of (trackingDoc?.machines || []))
        for (const op of m.operators || []) {
          if (op.operatorIdentityId !== opId) continue;
          const scans = op.barcodeScans || [];
          allScans    = allScans.concat(scans);
          let eff = op.signOutTime;
          if (!eff) { const att = attMap.get(opId); if (att?.finalOut) eff = att.finalOut; }
          const ms = eff ? new Date(eff) - new Date(op.signInTime) : (!op.signOutTime ? Date.now() - new Date(op.signInTime).getTime() : 0);
          totalMs += Math.max(0, ms);
        }

      const pieces    = countUniquePieces(allScans);
      const pSorted   = [...allScans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
      let   avgI = null;
      if (pSorted.length >= 2) {
        const g = [];
        for (let i = 1; i < pSorted.length; i++) { const d = (new Date(pSorted[i].timeStamp) - new Date(pSorted[i - 1].timeStamp)) / 1000; if (d > 0 && d < 3600) g.push(d); }
        if (g.length) avgI = Math.round(g.reduce((a, b) => a + b) / g.length);
      }
      const opsBreak = buildOperationsBreakdown(allScans, opMasterMap);
      const score    = calcPerformanceScore({ uniquePieces: pieces, sessionMins: totalMs / 60000, avgScanIntervalSecs: avgI, operationsBreakdown: opsBreak });
      return { identityId: opId, name: empData.name, department: empData.department, profilePhoto: empData.profilePhoto, totalScans: allScans.length, uniquePieces: pieces, sessionMins: Math.round(totalMs / 60000), avgScanIntervalSecs: avgI, performanceScore: score, operationsBreakdown: opsBreak, hourlyProductivity: buildHourlyProductivity(allScans) };
    };

    const [stats1, stats2] = await Promise.all([buildStats(op1), buildStats(op2)]);
    res.json({ success: true, date: dateStr, operator1: stats1, operator2: stats2 });
  } catch (err) {
    console.error("[CEO] /compare-operators:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/top-performers?date=&limit=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/top-performers", ceoAuth, async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayIST();
    const limit   = parseInt(req.query.limit) || 10;
    const { ProductionTracking, Employee } = getModels();
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

    const [opMasterMap, trackingDoc, attendanceDoc, allEmps, allMachines] = await Promise.all([
      loadOpMaster(),
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true }).select("firstName lastName identityId biometricId profilePhoto department").lean(),
      require("../../models/CMS_Models/Inventory/Configurations/Machine").find({}).select("name _id").lean(),
    ]);

    const empMap      = buildEmpMap(allEmps);
    const machNameMap = new Map(allMachines.map(m => [m._id.toString(), m.name]));
    const attMap      = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const ent = { finalOut: e.finalOut };
      if (e.biometricId) attMap.set(e.biometricId, ent);
      if (e.identityId && e.identityId !== e.biometricId) attMap.set(e.identityId, ent);
    }

    const opAgg = new Map();
    for (const machine of (trackingDoc?.machines || [])) {
      const mId   = machine.machineId?.toString();
      const mName = machNameMap.get(mId) || "Unknown";
      for (const op of machine.operators || []) {
        const id = op.operatorIdentityId;
        if (!id) continue;
        if (!opAgg.has(id)) opAgg.set(id, { scans: [], pieces: new Set(), sessionMs: 0, machines: new Set(), signInTime: null });
        const agg = opAgg.get(id);
        (op.barcodeScans || []).forEach(s => {
          agg.scans.push(s);
          const p = s.barcodeId?.split("-");
          if (p && p[0] === "WO" && p.length >= 3) agg.pieces.add(`${p[1]}-${p[2]}`);
        });
        agg.machines.add(mName);
        if (!agg.signInTime || new Date(op.signInTime) < new Date(agg.signInTime)) agg.signInTime = op.signInTime;
        let eff = op.signOutTime;
        if (!eff) { const att = attMap.get(id); if (att?.finalOut) eff = att.finalOut; }
        const ms = eff ? new Date(eff) - new Date(op.signInTime) : (!op.signOutTime ? Date.now() - new Date(op.signInTime).getTime() : 0);
        agg.sessionMs += Math.max(0, ms);
      }
    }

    const performers = [];
    for (const [id, agg] of opAgg) {
      if (!agg.pieces.size && !agg.scans.length) continue;
      const empData = empMap.get(id) || { name: id };
      const sorted  = [...agg.scans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
      let avgI = null;
      if (sorted.length >= 2) {
        const g = [];
        for (let i = 1; i < sorted.length; i++) { const d = (new Date(sorted[i].timeStamp) - new Date(sorted[i - 1].timeStamp)) / 1000; if (d > 0 && d < 3600) g.push(d); }
        if (g.length) avgI = Math.round(g.reduce((a, b) => a + b) / g.length);
      }
      const opsBreak = buildOperationsBreakdown(agg.scans, opMasterMap);
      const score    = calcPerformanceScore({ uniquePieces: agg.pieces.size, sessionMins: agg.sessionMs / 60000, avgScanIntervalSecs: avgI, operationsBreakdown: opsBreak });
      performers.push({ identityId: id, name: empData.name, department: empData.department, profilePhoto: empData.profilePhoto, uniquePieces: agg.pieces.size, totalScans: agg.scans.length, sessionMins: Math.round(agg.sessionMs / 60000), avgScanIntervalSecs: avgI, performanceScore: score, machines: Array.from(agg.machines), signInTime: agg.signInTime, topOperation: opsBreak[0] || null, operationsBreakdown: opsBreak });
    }

    performers.sort((a, b) => b.performanceScore - a.performanceScore);
    res.json({ success: true, date: dateStr, performers: performers.slice(0, limit), total: performers.length });
  } catch (err) {
    console.error("[CEO] /top-performers:", err.message);
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/operations-master
// ═════════════════════════════════════════════════════════════════════════════
router.get("/operations-master", ceoAuth, async (req, res) => {
  try {
    const map  = await loadOpMaster();
    const data = Array.from(map.entries()).map(([code, op]) => ({
      code,
      name:    op.operationName || op.name || code,
      samMins: op.samValue || null,
      samSecs: op.samValue ? op.samValue * 60 : (op.plannedTimeSeconds || null),
    }));
    res.json({ success: true, operations: data });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/work-orders
// ═════════════════════════════════════════════════════════════════════════════
router.get("/work-orders", ceoAuth, async (req, res) => {
  try {
    const { WorkOrder } = getModels();
    const { status = "active", limit = 100 } = req.query;
    const q = status === "all" ? {}
      : status === "active" ? { status: { $in: ["in_progress", "scheduled", "ready_to_start", "planned"] } }
      : { status };
    const wos = await WorkOrder.find(q)
      .select("workOrderNumber stockItemName status quantity customerName variantAttributes operations productionCompletion timeline createdAt")
      .sort({ updatedAt: -1 }).limit(parseInt(limit)).lean();
    res.json({
      success: true,
      data: wos.map(w => ({
        ...w,
        workOrderShortId: w._id.toString().slice(-8),
        completionPct:    w.quantity > 0 ? Math.round(((w.productionCompletion?.overallCompletedQuantity || 0) / w.quantity) * 100) : 0,
        completedUnits:   w.productionCompletion?.overallCompletedQuantity || 0,
        operationsCount:  w.operations?.length || 0,
      })),
      total: wos.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/products?startDate=&endDate=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/products", ceoAuth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const WorkOrder        = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
    const CustomerRequest  = require("../../models/Customer_Models/CustomerRequest");
    const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
    const StockItem        = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const today = getTodayIST();
    const sd    = startDate || today;
    const ed    = endDate   || today;
    const startUTC = new Date(sd + "T00:00:00.000Z");
    const endUTC   = new Date(ed + "T00:00:00.000Z");
    endUTC.setUTCDate(endUTC.getUTCDate() + 1);

    const trackingDocs = await ProductionTracking.find({ date: { $gte: startUTC, $lt: endUTC } }).lean();
    const floorScanMap = new Map();
    let totalFloorScans = 0;

    for (const doc of trackingDocs)
      for (const machine of doc.machines || [])
        for (const op of machine.operators || [])
          for (const s of op.barcodeScans || []) {
            const p = s.barcodeId?.split("-");
            if (!p || p[0] !== "WO" || p.length < 3) continue;
            const sid = p[1], unit = p[2];
            if (!floorScanMap.has(sid)) floorScanMap.set(sid, { units: new Set(), totalScans: 0 });
            floorScanMap.get(sid).units.add(unit);
            floorScanMap.get(sid).totalScans++;
            totalFloorScans++;
          }

    if (!floorScanMap.size) return res.json({ success: true, totalFloorScans: 0, totalUnitsInProgress: 0, manufacturingOrders: [], dateRange: { start: startUTC, end: endUTC } });

    const allWOs = await WorkOrder.find({}).select("_id workOrderNumber customerRequestId stockItemId stockItemName variantAttributes quantity status productionCompletion").lean();
    const woShortMap = new Map();
    allWOs.forEach(wo => woShortMap.set(wo._id.toString().slice(-8), wo));

    const siIds = new Set(), moIds = new Set();
    const moAgg = new Map();

    for (const [sid, scanData] of floorScanMap) {
      const wo   = woShortMap.get(sid);
      if (!wo) continue;
      if (wo.stockItemId) siIds.add(wo.stockItemId.toString());
      const moId = wo.customerRequestId?.toString() || "__no_mo__";
      if (!moAgg.has(moId)) moAgg.set(moId, { moId, products: new Map(), totalUnitsScanned: 0 });
      const entry = moAgg.get(moId);
      entry.totalUnitsScanned += scanData.units.size;
      const pk = wo._id.toString().slice(-8);
      if (!entry.products.has(pk)) entry.products.set(pk, { woShortId: pk, workOrderNumber: wo.workOrderNumber, workOrderStatus: wo.status, stockItemId: wo.stockItemId?.toString(), productName: wo.stockItemName || "Unknown", variantAttributes: wo.variantAttributes || [], totalQuantity: wo.quantity || 0, unitsScanned: 0, totalScans: 0, unitsCompleted: wo.productionCompletion?.overallCompletedQuantity || 0, completionPct: wo.productionCompletion?.overallCompletionPercentage || 0, image: null, genderCategory: null, category: null });
      const p = entry.products.get(pk);
      p.unitsScanned = scanData.units.size;
      p.totalScans   = scanData.totalScans;
      if (wo.customerRequestId) moIds.add(wo.customerRequestId.toString());
    }

    const [stockItems, mos] = await Promise.all([
      siIds.size > 0 ? StockItem.find({ _id: { $in: [...siIds] } }).select("name genderCategory category images variants").lean() : [],
      moIds.size > 0 ? CustomerRequest.find({ _id: { $in: [...moIds] } }).select("requestId customerInfo requestType status").lean() : [],
    ]);
    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));
    const moMap = new Map(mos.map(m => [m._id.toString(), m]));

    const manufacturingOrders = Array.from(moAgg.entries()).map(([moId, entry]) => {
      const mo       = moId !== "__no_mo__" ? moMap.get(moId) : null;
      const products = Array.from(entry.products.values()).map(p => {
        const si    = p.stockItemId ? siMap.get(p.stockItemId) : null;
        let image = null;
        if (si?.images?.length > 0) image = si.images[0];
        else if (si?.variants?.length > 0) { const v = si.variants.find(vv => vv.images?.length > 0); if (v) image = v.images[0]; }
        return { ...p, productName: si?.name || p.productName, genderCategory: si?.genderCategory || null, category: si?.category || null, image };
      }).sort((a, b) => b.unitsScanned - a.unitsScanned);
      return { moId, moNumber: mo ? `MO-${mo.requestId}` : "Unlinked", customerName: mo?.customerInfo?.name || "—", requestType: mo?.requestType || null, totalUnitsScanned: entry.totalUnitsScanned, products };
    }).filter(m => m.products.length > 0).sort((a, b) => b.totalUnitsScanned - a.totalUnitsScanned);

    res.json({ success: true, totalFloorScans, totalUnitsInProgress: manufacturingOrders.reduce((s, m) => s + m.totalUnitsScanned, 0), manufacturingOrders, dateRange: { start: startUTC, end: endUTC } });
  } catch (err) {
    console.error("[CEO] /products:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/machine-detail/:machineId?date=
// ═════════════════════════════════════════════════════════════════════════════
router.get("/machine-detail/:machineId", ceoAuth, async (req, res) => {
  try {
    const { machineId } = req.params;
    const dateStr       = req.query.date || getTodayIST();
    const { ProductionTracking, Employee } = getModels();
    const Machine          = require("../../models/CMS_Models/Inventory/Configurations/Machine");
    const WorkOrder        = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
    const CustomerRequest  = require("../../models/Customer_Models/CustomerRequest");
    const StockItem        = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const DailyAttendance  = require("../../models/HR_Models/Dailyattendance");

    const machInfo = await Machine.findById(machineId).select("name serialNumber type location status").lean().catch(() => null);

    const [trackingDoc, attendanceDoc, allEmps] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true }).select("firstName lastName identityId biometricId profilePhoto").lean(),
    ]);

    const empByAnyId = buildEmpMap(allEmps);

    const attMap = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const entry = { inTime: e.inTime, lunchOut: e.lunchOut, lunchIn: e.lunchIn, teaOut: e.teaOut, teaIn: e.teaIn, finalOut: e.finalOut };
      if (e.biometricId) attMap.set(e.biometricId, entry);
      if (e.identityId && e.identityId !== e.biometricId) attMap.set(e.identityId, entry);
    }

    const machRef = machInfo
      ? { id: machineId, name: machInfo.name, serial: machInfo.serialNumber, type: machInfo.type, location: machInfo.location }
      : { id: machineId, name: "Unknown" };

    if (!trackingDoc) return res.json({ success: true, date: dateStr, machine: machRef, operators: [], uniquePieces: 0, attendanceLastSynced: attendanceDoc?.syncedAt || null, attendanceNote: !attendanceDoc ? "No attendance data yet" : null });

    const machTracking = (trackingDoc.machines || []).find(m => m.machineId?.toString() === machineId);
    if (!machTracking) return res.json({ success: true, date: dateStr, machine: machRef, operators: [], uniquePieces: 0, attendanceLastSynced: attendanceDoc?.syncedAt || null, attendanceNote: null });

    // Batch load WOs
    const allWoIds = new Set();
    for (const op of machTracking.operators || [])
      for (const s of op.barcodeScans || []) { const p = s.barcodeId?.split("-"); if (p && p[0] === "WO" && p.length >= 3) allWoIds.add(p[1]); }

    const allWOs = allWoIds.size > 0 ? await WorkOrder.find({}).select("_id workOrderNumber stockItemId stockItemName variantAttributes customerRequestId quantity status").lean() : [];
    const woShortMap = new Map();
    allWOs.forEach(wo => woShortMap.set(wo._id.toString().slice(-8), wo));

    const siIds2 = new Set(), moIds2 = new Set();
    for (const sid of allWoIds) {
      const wo = woShortMap.get(sid);
      if (!wo) continue;
      if (wo.stockItemId) siIds2.add(wo.stockItemId.toString());
      if (wo.customerRequestId) moIds2.add(wo.customerRequestId.toString());
    }

    const [stockItems2, mos2] = await Promise.all([
      siIds2.size > 0 ? StockItem.find({ _id: { $in: [...siIds2] } }).select("name genderCategory category images variants").lean() : [],
      moIds2.size > 0 ? CustomerRequest.find({ _id: { $in: [...moIds2] } }).select("requestId customerInfo requestType").lean() : [],
    ]);
    const siMap2 = new Map(stockItems2.map(si => [si._id.toString(), si]));
    const moMap2 = new Map(mos2.map(mo => [mo._id.toString(), mo]));

    const resolveImage = (si, va) => {
      if (!si) return null;
      if (va?.length && si.variants?.length) {
        const match = si.variants.find(v => (v.attributes || []).every(a => va.some(wa => wa.name?.toLowerCase() === a.name?.toLowerCase() && String(wa.value).toLowerCase() === String(a.value).toLowerCase())));
        if (match?.images?.[0]) return match.images[0];
      }
      return si.images?.[0] || null;
    };

    const getAttStatus = opId => {
      const att = attMap.get(opId);
      if (!att) return { status: null, breakInfo: null };
      const now = new Date(), lO = att.lunchOut ? new Date(att.lunchOut) : null, lI = att.lunchIn ? new Date(att.lunchIn) : null, tO = att.teaOut ? new Date(att.teaOut) : null, tI = att.teaIn ? new Date(att.teaIn) : null, fO = att.finalOut ? new Date(att.finalOut) : null;
      if (fO && fO < now) return { status: "checked_out", breakInfo: { label: "Checked out at", time: att.finalOut, icon: "out" } };
      if (lO && (!lI || lI < lO)) return { status: "lunch_break", breakInfo: { label: "On lunch since", time: att.lunchOut, icon: "lunch", mightBeStale: (now - lO) > 45 * 60000 } };
      if (tO && (!tI || tI < tO)) return { status: "tea_break", breakInfo: { label: "On tea break since", time: att.teaOut, icon: "tea", mightBeStale: (now - tO) > 30 * 60000 } };
      return { status: "working", breakInfo: null };
    };

    const machineUnits = new Set();

    const operators = (machTracking.operators || []).map(op => {
      const opId    = op.operatorIdentityId;
      const empData = empByAnyId.get(opId);
      const name    = (op.operatorName?.trim() && op.operatorName !== "Unknown Operator") ? op.operatorName.trim() : (empData?.name || opId || "Unknown");
      const scans   = op.barcodeScans || [];
      const siDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
      const isStale   = siDateStr && siDateStr !== dateStr;

      let effectiveSignOut = op.signOutTime || null, didNotSignOut = false, attResolved = false;
      if (!op.signOutTime && !isStale) {
        const att = attMap.get(opId);
        if (att?.finalOut) { effectiveSignOut = att.finalOut; didNotSignOut = true; attResolved = true; }
      }
      const isSignedIn = !op.signOutTime && !isStale;

      const opUnits = new Set(), woBuckets = {};
      for (const s of scans) {
        const p = s.barcodeId?.split("-");
        if (p && p[0] === "WO" && p.length >= 3) {
          const key = `${p[1]}-${p[2]}`;
          opUnits.add(key); machineUnits.add(key);
          if (!woBuckets[p[1]]) woBuckets[p[1]] = new Set();
          woBuckets[p[1]].add(p[2]);
        }
      }

      const productMap = new Map();
      for (const [sid, units] of Object.entries(woBuckets)) {
        const wo = woShortMap.get(sid);
        if (!wo) { if (!productMap.has(sid)) productMap.set(sid, { name: `WO-${sid}`, image: null, genderCategory: null, variantAttributes: [], moNumber: null, moCustomer: null, unitsDone: units.size }); continue; }
        const si = wo.stockItemId ? siMap2.get(wo.stockItemId.toString()) : null;
        const mo = wo.customerRequestId ? moMap2.get(wo.customerRequestId.toString()) : null;
        const pk = `${wo.stockItemId || sid}_${(wo.variantAttributes || []).map(v => `${v.name}:${v.value}`).join("|")}`;
        if (!productMap.has(pk)) productMap.set(pk, { productKey: pk, name: si?.name || wo.stockItemName || "Unknown", image: resolveImage(si, wo.variantAttributes), genderCategory: si?.genderCategory || null, variantAttributes: wo.variantAttributes || [], moNumber: mo ? `MO-${mo.requestId}` : null, moCustomer: mo?.customerInfo?.name || null, woNumber: wo.workOrderNumber, unitsDone: 0 });
        productMap.get(pk).unitsDone += units.size;
      }

      const sessMs = isStale ? 0 : isSignedIn ? Math.min(Date.now() - new Date(op.signInTime).getTime(), 14 * 3600 * 1000) : effectiveSignOut ? Math.min(new Date(effectiveSignOut) - new Date(op.signInTime), 14 * 3600 * 1000) : 0;
      const { status: attStatus, breakInfo } = getAttStatus(opId);

      return { identityId: opId, name, profilePhoto: empData?.profilePhoto || null, signInTime: op.signInTime, signOutTime: op.signOutTime || null, effectiveSignOut, didNotSignOutFromMachine: didNotSignOut, attendanceResolvedSignOut: attResolved, isSignedIn, isStale, uniquePieces: opUnits.size, sessionDurationMs: Math.max(0, sessMs), products: Array.from(productMap.values()), attendanceStatus: attStatus, breakInfo, attendance: attMap.get(opId) || null };
    });

    // Machine-level operations breakdown
    let machineOperationsBreakdown = [];
    const perOperatorOpsBreakdown = {};
    try {
      const opMM = await loadOpMaster();
      const allMachScans = (machTracking.operators || []).flatMap(op => op.barcodeScans || []);
      machineOperationsBreakdown = buildOperationsBreakdown(allMachScans, opMM);
      for (const op of (machTracking.operators || [])) {
        const opId = op.operatorIdentityId;
        if (!opId || !(op.barcodeScans?.length)) continue;
        perOperatorOpsBreakdown[opId] = buildOperationsBreakdown(op.barcodeScans, opMM);
      }
    } catch (_) {}

    res.json({
      success: true, date: dateStr, machine: machRef, operators,
      uniquePieces: machineUnits.size,
      perOperatorOpsBreakdown,
      attendanceLastSynced: attendanceDoc?.syncedAt || null,
      attendanceNote: !attendanceDoc ? "No attendance data yet — HR sync may be pending" : null,
    });
  } catch (err) {
    console.error("[CEO] /machine-detail:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /api/ceo/production/floor-data?date=
//  Returns canvas layout + live machine data in one call (used by MachinesTab)
// ═════════════════════════════════════════════════════════════════════════════
router.get("/floor-data", ceoAuth, async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayIST();
    const { ProductionTracking, Machine, Employee, WorkOrder } = getModels();
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

    // Load canvas layout
    let canvasLayout = null;
    try {
      const CanvasLayout = require("../../models/CMS_Models/Manufacturing/Production/CanvasLayout");
      const layout = await CanvasLayout.findOne({ organizationId: "default" }).lean();
      if (layout) {
        canvasLayout = {
          machinePositions: layout.machinePositions || [],
          chamberTemplates: layout.chamberTemplates || [],
          separators:       layout.separators       || [],
          canvasState:      layout.canvasState      || { zoom: 1, panX: 0, panY: 0 },
        };
      }
    } catch (_) {}

    // Load tracking data (same logic as /live, but lightweight)
    const [doc, allMachines, attendanceDoc, allEmps] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) })
        .populate("machines.machineId", "name serialNumber type location").lean(),
      Machine.find({}).select("name serialNumber type location status").lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true }).select("firstName lastName identityId biometricId profilePhoto").lean(),
    ]);

    const empMap = buildEmpMap(allEmps);
    const attMap = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const entry = { finalOut: e.finalOut };
      if (e.biometricId) attMap.set(e.biometricId, entry);
      if (e.identityId && e.identityId !== e.biometricId) attMap.set(e.identityId, entry);
    }
    const machMap = new Map(allMachines.map(m => [m._id.toString(), m]));

    // Build lightweight machine summary (no need for full /live detail here)
    const trackedIds = new Set();
    const machinesData = [];

    for (const machine of (doc?.machines || [])) {
      const mInfo = machine.machineId || {};
      const mId   = mInfo._id?.toString() || machine.machineId?.toString();
      trackedIds.add(mId);

      let machScans = 0;
      const opSummaryMap = new Map();

      for (const op of machine.operators || []) {
        const opId    = op.operatorIdentityId;
        const empData = empMap.get(opId);
        const name    = (op.operatorName?.trim() && op.operatorName !== "Unknown Operator")
          ? op.operatorName.trim() : (empData?.name || opId || "Unknown");
        const scans   = op.barcodeScans || [];
        const siDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
        const isStale   = siDateStr && siDateStr !== dateStr;
        const isActive  = !op.signOutTime && !isStale;

        let effectiveSignOut = op.signOutTime || null;
        let didNotSignOut = false;
        if (!op.signOutTime && !isStale && attMap.get(opId)?.finalOut) {
          effectiveSignOut = attMap.get(opId).finalOut;
          didNotSignOut    = true;
        }

        const mUnits = new Set();
        scans.forEach(s => { const p = s.barcodeId?.split("-"); if (p && p[0] === "WO" && p.length >= 3) mUnits.add(`${p[1]}-${p[2]}`); });
        machScans += scans.length;

        if (!opSummaryMap.has(opId)) {
          opSummaryMap.set(opId, { identityId: opId, name, profilePhoto: empData?.profilePhoto || null, pieces: 0, earliestSignIn: null, latestSignOut: null, isActiveNow: false });
        }
        const s = opSummaryMap.get(opId);
        s.pieces += mUnits.size;
        if (op.signInTime && (!s.earliestSignIn || new Date(op.signInTime) < new Date(s.earliestSignIn))) s.earliestSignIn = op.signInTime;
        if (effectiveSignOut && (!s.latestSignOut || new Date(effectiveSignOut) > new Date(s.latestSignOut))) s.latestSignOut = effectiveSignOut;
        if (isActive) s.isActiveNow = true;
      }

      const mRef = machMap.get(mId) || {};
      const uniqueMachPieces = new Set();
      for (const op of machine.operators || [])
        for (const s of op.barcodeScans || []) {
          const p = s.barcodeId?.split("-");
          if (p && p[0] === "WO" && p.length >= 3) uniqueMachPieces.add(`${p[1]}-${p[2]}`);
        }

      const currOpId = machine.currentOperatorIdentityId;
      const currEmp  = currOpId ? empMap.get(currOpId) : null;
      const currActive = Array.from(opSummaryMap.values()).find(o => o.identityId === currOpId && o.isActiveNow);

      machinesData.push({
        machineId:             mId,
        machineName:           mInfo.name || mRef.name || "Unknown",
        machineSerial:         mInfo.serialNumber || mRef.serialNumber,
        machineType:           mInfo.type || mRef.type,
        status:                currOpId ? "busy" : machScans > 0 ? "used_today" : "free",
        currentOperator:       currOpId ? { identityId: currOpId, name: currActive?.name || currEmp?.name || currOpId, profilePhoto: currActive?.profilePhoto || currEmp?.profilePhoto || null } : null,
        operatorSummaries:     Array.from(opSummaryMap.values()).sort((a, b) => (a.isActiveNow ? -1 : 1) - (b.isActiveNow ? -1 : 1)),
        totalScans:            machScans,
        uniquePiecesCompleted: uniqueMachPieces.size,
      });
    }

    // Un-tracked machines
    allMachines.forEach(m => {
      const mId = m._id.toString();
      if (trackedIds.has(mId)) return;
      machinesData.push({
        machineId: mId, machineName: m.name || "Unknown", machineSerial: m.serialNumber,
        machineType: m.type,
        status: m.status === "Under Maintenance" ? "maintenance" : m.status === "Offline" ? "offline" : "free",
        currentOperator: null, operatorSummaries: [], totalScans: 0, uniquePiecesCompleted: 0,
      });
    });

    res.json({
      success: true, date: dateStr, canvasLayout, machines: machinesData,
      summary: {
        total:   allMachines.length,
        active:  machinesData.filter(m => m.status === "busy").length,
        used:    machinesData.filter(m => m.status === "used_today").length,
        idle:    machinesData.filter(m => m.status === "free").length,
      },
    });
  } catch (err) {
    console.error("[CEO] /floor-data:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});


router.get("/daily-summary", ceoAuth, async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayIST();
    const { ProductionTracking, Employee, WorkOrder } = getModels();
    const StockItem       = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const Machine         = require("../../models/CMS_Models/Inventory/Configurations/Machine");
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
 
    // Date range for multi-day tracking (today + 13 prior days)
    const LOOKBACK_DAYS = 13;
    const todayUTC   = new Date(dateStr + "T00:00:00.000Z");
    const startUTC   = new Date(todayUTC); startUTC.setUTCDate(startUTC.getUTCDate() - LOOKBACK_DAYS);
 
    // ── 1.  Parallel load ─────────────────────────────────────────────────
    const [trackingDocs, attendanceDoc, allEmps, allMachinesRaw, allWOs] = await Promise.all([
      ProductionTracking.find({ date: { $gte: startUTC, $lte: todayUTC } }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true })
        .select("firstName lastName identityId biometricId profilePhoto department designation").lean(),
      Machine.find({}).select("name serialNumber type location status").lean(),
      WorkOrder.find({}).select("_id workOrderNumber stockItemId stockItemName variantAttributes quantity status").lean(),
    ]);
 
    const todayDoc = trackingDocs.find(d => {
      const ds = new Date(d.date).toISOString().split("T")[0];
      return ds === dateStr || new Date(d.date).getTime() === todayUTC.getTime();
    }) || null;
 
    // ── 2.  Lookup maps ───────────────────────────────────────────────────
    const empRawMap  = buildEmpMap(allEmps);
    const getEmp = id => {
      if (!id) return null;
      return empRawMap.get(id)
        || (/^GR\d+$/i.test(id) ? empRawMap.get("GR0" + id.slice(2)) : null)
        || null;
    };
 
    const machMap    = new Map(allMachinesRaw.map(m => [m._id.toString(), m]));
    const woByShortId = new Map(allWOs.map(wo => [wo._id.toString().slice(-8), wo]));
 
    // ── 3.  Attendance ─────────────────────────────────────────────────────
    const breakWindowMap = new Map(); // opId → [{ start, end, type }]
    const attDataMap     = new Map(); // opId → att object
    for (const e of attendanceDoc?.employees || []) {
      const windows = [];
      if (e.lunchOut && e.lunchIn && new Date(e.lunchIn) > new Date(e.lunchOut))
        windows.push({ start: new Date(e.lunchOut), end: new Date(e.lunchIn), type: "Lunch" });
      if (e.teaOut && e.teaIn && new Date(e.teaIn) > new Date(e.teaOut))
        windows.push({ start: new Date(e.teaOut), end: new Date(e.teaIn), type: "Tea" });
      const att = { finalOut: e.finalOut||null, inTime: e.inTime||null, lunchOut: e.lunchOut||null, lunchIn: e.lunchIn||null, teaOut: e.teaOut||null, teaIn: e.teaIn||null };
      const put = key => { breakWindowMap.set(key, windows); attDataMap.set(key, att); };
      if (e.biometricId) put(e.biometricId);
      if (e.identityId && e.identityId !== e.biometricId) put(e.identityId);
    }
 
    // ── 4.  Scan validation ───────────────────────────────────────────────
    // preload StockItems for all WOs we'll encounter
    const siIds = new Set(allWOs.map(w => w.stockItemId?.toString()).filter(Boolean));
    const stockItems = siIds.size
      ? await StockItem.find({ _id: { $in: [...siIds] } })
          .select("name genderCategory category images operations variants").lean()
      : [];
    const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));
 
    // siOpsSet[siId] = Set<operationCode>
    const siOpsSet = new Map();
    for (const si of stockItems) {
      siOpsSet.set(si._id.toString(), new Set(
        si.operations?.filter(o => o.operationCode).map(o => o.operationCode) || []
      ));
    }
 
    const validateScan = (barcodeId, activeOps) => {
      const p = barcodeId?.split("-");
      if (!p || p[0] !== "WO" || p.length < 3) return { valid: false, reason: "Bad format — expected WO-{id}-{unit}" };
      const shortId  = p[1];
      const unitNum  = parseInt(p[2], 10);
      if (isNaN(unitNum)) return { valid: false, reason: "Non-numeric unit number" };
      const wo = woByShortId.get(shortId);
      if (!wo) return { valid: false, reason: `Work order not found (ID: ${shortId})` };
      if (unitNum < 1 || unitNum > (wo.quantity || 0)) return { valid: false, reason: `Unit #${unitNum} exceeds WO quantity (${wo.quantity || "?"})` };
      const siId = wo.stockItemId?.toString();
      const knownOps = siId ? (siOpsSet.get(siId) || new Set()) : new Set();
      const unknownOps = (activeOps || []).filter(c => knownOps.size > 0 && !knownOps.has(c));
      if (unknownOps.length > 0) return { valid: true, warning: `Op codes not in product definition: ${unknownOps.join(", ")}` };
      if (!activeOps || activeOps.length === 0) return { valid: true, warning: "No active operation on machine at scan time" };
      return { valid: true };
    };
 
    // ── 5.  Multi-day piece history ───────────────────────────────────────
    // pieceHist[`${shortId}-${unitNum}`] = {
    //   shortId, unitNum, barcodeId,
    //   woRef: WO object,
    //   opsEverDone: Set<opCode>,
    //   firstSeenDate: string,
    //   lastScannedDate: string,
    //   daysActive: number,
    //   todayScans: [],
    //   allDayScans: [],
    //   validationResult,
    // }
    const pieceHist = new Map();
 
    for (const doc of trackingDocs) {
      const docDateStr = (() => {
        const d = new Date(doc.date);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth()+1).padStart(2,"0")}-${String(d.getUTCDate()).padStart(2,"0")}`;
      })();
      const isToday = docDateStr === dateStr;
 
      for (const machine of doc.machines || []) {
        const mId   = machine.machineId?.toString();
        const mName = machMap.get(mId)?.name || "Unknown Machine";
 
        for (const op of machine.operators || []) {
          const opId = op.operatorIdentityId;
          // Skip sessions that signed in on a different date bucket
          const siDate = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
          if (siDate && siDate !== docDateStr) continue;
 
          const empInfo = getEmp(opId);
          const opName  = (op.operatorName?.trim() && op.operatorName !== "Unknown Operator")
            ? op.operatorName.trim() : (empInfo?.name || opId || "Unknown");
 
          for (const scan of op.barcodeScans || []) {
            const p = scan.barcodeId?.split("-");
            if (!p || p[0] !== "WO" || p.length < 3) continue;
            const shortId = p[1], unitNum = parseInt(p[2], 10);
            if (isNaN(unitNum)) continue;
 
            const key  = `${shortId}-${unitNum}`;
            const wo   = woByShortId.get(shortId);
            const vr   = validateScan(scan.barcodeId, scan.activeOps);
            const ops  = Array.isArray(scan.activeOps) ? scan.activeOps : [];
            const tsStr = scan.timeStamp ? new Date(scan.timeStamp).toISOString().split("T")[0] : docDateStr;
 
            if (!pieceHist.has(key)) {
              pieceHist.set(key, {
                shortId, unitNum, barcodeId: scan.barcodeId,
                woRef: wo || null,
                opsEverDone: new Set(),
                firstSeenDate: tsStr,
                lastScannedDate: tsStr,
                datesActive: new Set([tsStr]),
                todayScans: [],
                allDayScans: [],
                validationResult: vr,
              });
            }
            const ph = pieceHist.get(key);
            ops.forEach(c => ph.opsEverDone.add(c));
            if (tsStr < ph.firstSeenDate) ph.firstSeenDate = tsStr;
            if (tsStr > ph.lastScannedDate) ph.lastScannedDate = tsStr;
            ph.datesActive.add(tsStr);
 
            const scanEntry = {
              timeStamp: scan.timeStamp,
              operatorId: opId, operatorName: opName,
              machineId: mId, machineName: mName,
              activeOps: ops, barcodeId: scan.barcodeId,
              isValid: vr.valid, warning: vr.warning || null, invalidReason: vr.valid ? null : vr.reason,
            };
            ph.allDayScans.push(scanEntry);
            if (isToday) ph.todayScans.push(scanEntry);
          }
        }
      }
    }
 
    // ── 6.  Hourly breakdown (today only, first-scan dedup) ───────────────
    const hourlyMap = {};
    for (let h = 0; h <= 23; h++) hourlyMap[h] = { hour: h, pieces: 0, scans: 0, operatorSet: new Set() };
 
    // First scan per piece (today)
    const firstScanTsToday = new Map();
    for (const [key, ph] of pieceHist) {
      if (!ph.todayScans.length) continue;
      const earliest = ph.todayScans.reduce((mn, s) => !mn || new Date(s.timeStamp) < new Date(mn) ? s.timeStamp : mn, null);
      if (earliest) firstScanTsToday.set(key, new Date(earliest));
    }
    for (const [, ts] of firstScanTsToday) {
      const h = ts.getHours();
      if (hourlyMap[h]) hourlyMap[h].pieces++;
    }
    for (const doc of (todayDoc ? [todayDoc] : [])) {
      for (const machine of doc.machines || []) {
        for (const op of machine.operators || []) {
          const siDate = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
          if (siDate && siDate !== dateStr) continue;
          for (const scan of op.barcodeScans || []) {
            const h = new Date(scan.timeStamp).getHours();
            if (hourlyMap[h]) { hourlyMap[h].scans++; hourlyMap[h].operatorSet.add(op.operatorIdentityId); }
          }
        }
      }
    }
    const hourly = Object.values(hourlyMap)
      .map(h => ({ hour: h.hour, label: `${h.hour===0?12:h.hour>12?h.hour-12:h.hour}${h.hour<12?"AM":"PM"}`, pieces: h.pieces, scans: h.scans, operators: h.operatorSet.size }))
      .filter(h => h.pieces > 0 || h.scans > 0);
 
    // ── 7.  Product production summary ────────────────────────────────────
    // Group pieceHist by WO → StockItem
    // Build operation timing from TODAY's scans only
    const opTimingsToday = new Map(); // opCode → Map<operatorId, timestamps[]>
 
    for (const [, ph] of pieceHist) {
      for (const scan of ph.todayScans) {
        if (!scan.isValid) continue;
        for (const code of scan.activeOps) {
          if (!opTimingsToday.has(code)) opTimingsToday.set(code, new Map());
          const byOp = opTimingsToday.get(code);
          if (!byOp.has(scan.operatorId)) byOp.set(scan.operatorId, []);
          byOp.get(scan.operatorId).push(new Date(scan.timeStamp));
        }
      }
    }
 
    // Break-adjusted gaps, capped at 30 min (1800s) to exclude idle periods
    const MAX_GAP_SECS = 1800;
    const safeAvg = arr => arr.length ? Math.round(arr.reduce((a,b)=>a+b)/arr.length) : null;
 
    const computeGapsOp = (timestamps, opId) => {
      if (timestamps.length < 2) return [];
      const sorted = [...timestamps].sort((a,b)=>a-b);
      const windows = breakWindowMap.get(opId) || [];
      return sorted.slice(1).map((ts, i) => {
        let gapMs = ts - sorted[i];
        for (const w of windows) {
          const oS = Math.max(sorted[i].getTime(), w.start.getTime());
          const oE = Math.min(ts.getTime(), w.end.getTime());
          if (oE > oS) gapMs -= (oE - oS);
        }
        const secs = gapMs / 1000;
        return (secs >= 3 && secs <= MAX_GAP_SECS) ? secs : null;
      }).filter(v => v !== null);
    };
 
    // opStats: opCode → { avgSecs, sampleCount, operatorBreakdown[] }
    const opStats = new Map();
    for (const [code, byOp] of opTimingsToday) {
      const breakdown = [], allGaps = [];
      for (const [opId, ts] of byOp) {
        const gaps  = computeGapsOp(ts, opId);
        const opAvg = safeAvg(gaps);
        const emp   = getEmp(opId);
        allGaps.push(...gaps);
        breakdown.push({ operatorId: opId, name: emp?.name || opId, department: emp?.department || null, piecesHandled: ts.length, avgSecs: opAvg, sampleCount: gaps.length });
      }
      opStats.set(code, { avgSecs: safeAvg(allGaps), sampleCount: allGaps.length, operatorBreakdown: breakdown.sort((a,b)=>b.piecesHandled-a.piecesHandled) });
    }
 
    // Group pieces by WO → StockItem
    const woGroups  = new Map(); // woShortId → { pieces[], wo }
    for (const [key, ph] of pieceHist) {
      if (!ph.woRef) continue;
      const sid = ph.shortId;
      if (!woGroups.has(sid)) woGroups.set(sid, { wo: ph.woRef, pieces: [] });
      woGroups.get(sid).pieces.push(ph);
    }
 
    const siGroups = new Map(); // siId → { si, wos: [] }
    for (const [shortId, { wo, pieces }] of woGroups) {
      const siId = wo.stockItemId?.toString() || null;
      const si   = siId ? siMap.get(siId) : null;
      const gKey = siId || `__nosI_${shortId}`;
      if (!siGroups.has(gKey)) {
        siGroups.set(gKey, {
          stockItemId: siId,
          productName: si?.name || wo.stockItemName || `WO-${shortId}`,
          genderCategory: si?.genderCategory || null,
          category: si?.category || null,
          image: (() => { if (!si) return null; let img = si.images?.[0]||null; if (!img) { const v=si.variants?.find(vv=>vv.images?.length>0); if(v) img=v.images[0]; } return img; })(),
          siOps: (si?.operations||[]).filter(o=>!!o.operationCode),
          wos: [],
        });
      }
 
      const pg    = siGroups.get(gKey);
      const expectedOps = pg.siOps.map(op => ({
        opCode:      op.operationCode,
        opName:      op.type || op.operationCode,
        samSeconds:  op.totalSeconds || 0,
        samMins:     op.totalSeconds ? +(op.totalSeconds/60).toFixed(1) : null,
        machineType: op.machineType || op.machine || null,
      }));
      const expectedSet = new Set(expectedOps.map(o => o.opCode));
 
      // Operation efficiency data
      const operationsData = expectedOps.map(({ opCode, opName, samSeconds, samMins, machineType }) => {
        const piecesWithOp = pieces.filter(ph => ph.opsEverDone.has(opCode)).length;
        const stats        = opStats.get(opCode);
        const avgActual    = stats?.avgSecs || null;
        const effPct       = samSeconds && avgActual && avgActual > 0 ? Math.round((samSeconds/avgActual)*100) : null;
        return {
          opCode, opName, samSeconds, samMins, machineType, piecesWithOp,
          todayScansForOp: stats?.operatorBreakdown?.reduce((s,b)=>s+b.piecesHandled,0)||0,
          avgActualSecs: avgActual,
          efficiencyPct: effPct,
          sampleCount: stats?.sampleCount || 0,
          dataQuality: !stats ? "no_data" : stats.sampleCount < 3 ? "low" : stats.sampleCount < 10 ? "medium" : "good",
          operatorBreakdown: (stats?.operatorBreakdown||[]).map(br=>({
            ...br,
            efficiencyPct: samSeconds && br.avgSecs ? Math.round((samSeconds/br.avgSecs)*100) : null,
          })),
        };
      });
 
      // Extra ops scanned but not in StockItem
      const allScannedCodes = new Set();
      for (const ph of pieces) for (const c of ph.opsEverDone) allScannedCodes.add(c);
      const extraOps = [...allScannedCodes].filter(c=>!expectedSet.has(c)).map(code=>{
        const st=opStats.get(code);
        return { opCode:code, opName:code, isExtra:true, samSeconds:null, samMins:null,
          piecesWithOp: pieces.filter(ph=>ph.opsEverDone.has(code)).length,
          avgActualSecs: st?.avgSecs||null, efficiencyPct:null, sampleCount:st?.sampleCount||0, operatorBreakdown:(st?.operatorBreakdown||[]) };
      });
 
      // Piece audit
      const pieceAudit = pieces.map(ph => {
        const doneOps    = [...ph.opsEverDone].filter(c=>expectedSet.has(c));
        const missingOps = [...expectedSet].filter(c=>!ph.opsEverDone.has(c));
        return {
          unitNum:         ph.unitNum,
          barcodeId:       ph.barcodeId,
          isValid:         ph.validationResult.valid,
          validationNote:  ph.validationResult.valid ? (ph.validationResult.warning||null) : ph.validationResult.reason,
          firstSeenDate:   ph.firstSeenDate,
          lastScannedDate: ph.lastScannedDate,
          daysActive:      ph.datesActive.size,
          operationsEverDone:    doneOps,
          operationsStillMissing: missingOps,
          isComplete:      missingOps.length===0,
          completionPct:   expectedSet.size>0 ? Math.round((doneOps.length/expectedSet.size)*100) : 100,
          todayScansCount: ph.todayScans.length,
          todayScans:      ph.todayScans.map(s=>({ timeStamp:s.timeStamp, operatorName:s.operatorName, machineName:s.machineName, activeOps:s.activeOps, isValid:s.isValid, warning:s.warning, invalidReason:s.invalidReason })),
        };
      }).sort((a,b)=>a.unitNum-b.unitNum);
 
      const invalidScans = pieces.flatMap(ph =>
        ph.todayScans.filter(s=>!s.isValid).map(s=>({ barcodeId:s.barcodeId, reason:s.invalidReason, operatorName:s.operatorName, machineName:s.machineName, timeStamp:s.timeStamp }))
      );
 
      const completePcs  = pieceAudit.filter(p=>p.isComplete).length;
      const inProgressPcs = pieceAudit.filter(p=>!p.isComplete && p.operationsEverDone.length>0).length;
      const notStartedPcs = (wo.quantity||0) - pieceAudit.length;
      const todayNewPcs  = pieces.filter(ph=>ph.firstSeenDate===dateStr).length;
      const dateRange    = pieces.reduce((r,ph)=>({ from:ph.firstSeenDate<r.from?ph.firstSeenDate:r.from, to:ph.lastScannedDate>r.to?ph.lastScannedDate:r.to }), { from:dateStr, to:dateStr });
 
      pg.wos.push({
        woShortId:       shortId,
        workOrderNumber: wo.workOrderNumber || `WO-${shortId}`,
        workOrderStatus: wo.status || "unknown",
        variantAttributes: wo.variantAttributes || [],
        totalQuantity:   wo.quantity || 0,
        totalUniquePieces: pieces.length,
        completePieces:  completePcs,
        inProgressPieces: inProgressPcs,
        notStartedPieces: Math.max(0, notStartedPcs),
        todayNewPieces:  todayNewPcs,
        dateRange,
        daysActive:      new Set(pieces.flatMap(ph=>[...ph.datesActive])).size,
        expectedOpsCount: expectedSet.size,
        operations:      operationsData,
        extraOps,
        invalidScansCount: invalidScans.length,
        invalidScans:    invalidScans.slice(0,50),
        pieceAudit:      pieceAudit.slice(0,300),
        pieceAuditTotal: pieceAudit.length,
      });
    }
 
    const productionSummary = Array.from(siGroups.values()).map(pg=>({
      ...pg, siOps: undefined,
      totalPieces: pg.wos.reduce((s,w)=>s+w.totalUniquePieces,0),
      wos: pg.wos.sort((a,b)=>b.totalUniquePieces-a.totalUniquePieces),
    })).sort((a,b)=>b.totalPieces-a.totalPieces);
 
    // ── 8.  Operator productivity (today) ─────────────────────────────────
    const opAgg = new Map();
    for (const machine of (todayDoc?.machines || [])) {
      const mId   = machine.machineId?.toString();
      const mName = machMap.get(mId)?.name || "Unknown";
      for (const op of machine.operators || []) {
        const opId = op.operatorIdentityId; if (!opId) continue;
        const siDate = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
        if (siDate && siDate !== dateStr) continue;
 
        const scans    = op.barcodeScans || [];
        const scanTimes = scans.map(s=>new Date(s.timeStamp)).sort((a,b)=>a-b);
        const firstScan = scanTimes[0]||null, lastScan = scanTimes[scanTimes.length-1]||null;
        const att       = attDataMap.get(opId);
 
        // Sign-in: machine → first scan
        const signIn       = op.signInTime || (firstScan?.toISOString()||null);
        const signInSource = op.signInTime ? "machine" : firstScan ? "first_scan" : null;
        // Sign-out: machine → attendance finalOut → last scan
        const isActive     = !op.signOutTime;
        let   signOut = op.signOutTime||null, signOutSource = op.signOutTime?"machine":null, didNotSignOut = false;
        if (!signOut) {
          if (att?.finalOut) { signOut=att.finalOut; signOutSource="attendance"; didNotSignOut=true; }
          else if (lastScan) { signOut=lastScan.toISOString(); signOutSource="last_scan"; didNotSignOut=!isActive; }
        }
        if (isActive) signOutSource="active";
 
        const startMs = signIn  ? new Date(signIn).getTime()  : 0;
        const endMs   = isActive? Date.now() : (signOut?new Date(signOut).getTime():startMs);
        let netMs = Math.max(0, endMs-startMs);
        for (const w of (breakWindowMap.get(opId)||[])) {
          const oS=Math.max(startMs,w.start.getTime()), oE=Math.min(endMs,w.end.getTime());
          if (oE>oS) netMs-=(oE-oS);
        }
        netMs=Math.max(0,netMs);
 
        const pieces = countUniquePieces(scans);
        if (!opAgg.has(opId)) {
          const emp=getEmp(opId);
          opAgg.set(opId,{ identityId:opId, name:emp?.name||op.operatorName||opId, department:emp?.department||null, designation:emp?.designation||null, profilePhoto:emp?.profilePhoto||null, machines:[], primaryMachine:mName, signIn, signInSource, signOut, signOutSource, isActive, didNotSignOut, netMins:Math.round(netMs/60000), pieces, scans:scans.length, att:att||null });
        } else {
          const agg=opAgg.get(opId);
          agg.pieces+=pieces; agg.scans+=scans.length; agg.netMins+=Math.round(netMs/60000);
          if (isActive) agg.isActive=true;
          if (signIn&&(!agg.signIn||new Date(signIn)<new Date(agg.signIn))) { agg.signIn=signIn; agg.signInSource=signInSource; }
          if (signOut&&(!agg.signOut||new Date(signOut)>new Date(agg.signOut))) { agg.signOut=signOut; agg.signOutSource=signOutSource; }
        }
        const agg=opAgg.get(opId);
        if (!agg.machines.find(m=>m.machineId===mId)) agg.machines.push({ machineId:mId, machineName:mName, pieces, signIn, signOut, isActive });
      }
    }
    const operatorProductivity = Array.from(opAgg.values()).map(op=>({
      ...op,
      piecesPerHour: op.netMins>0 ? Math.round((op.pieces/(op.netMins/60))*10)/10 : null,
    })).sort((a,b)=>b.pieces-a.pieces);
 
    // ── 9.  Machine utilization ────────────────────────────────────────────
    const SHIFT_MINS = 600; // 9 AM – 7 PM
    const trackedSet = new Set();
    const machineUtilization = [];
    for (const machine of (todayDoc?.machines||[])) {
      const mId=machine.machineId?.toString(); if(!mId)continue;
      trackedSet.add(mId);
      const mInfo=machMap.get(mId)||{};
      const opSet=new Set(); let usedMins=0, totalPcs=0;
      for (const op of machine.operators||[]) {
        const siDate=op.signInTime?new Date(op.signInTime).toISOString().split("T")[0]:null;
        if (siDate&&siDate!==dateStr) continue;
        opSet.add(op.operatorIdentityId);
        const att=attDataMap.get(op.operatorIdentityId);
        const scans=op.barcodeScans||[];
        const scanTimes=scans.map(s=>new Date(s.timeStamp)).sort((a,b)=>a-b);
        const firstScan=scanTimes[0]||null, lastScan=scanTimes[scanTimes.length-1]||null;
        const startDt=op.signInTime?new Date(op.signInTime):firstScan;
        const endDt=!op.signOutTime?(att?.finalOut?new Date(att.finalOut):lastScan||new Date()):new Date(op.signOutTime);
        if (startDt&&endDt) {
          const sM=Math.max(540,startDt.getHours()*60+startDt.getMinutes());
          const eM=Math.min(1140,endDt.getHours()*60+endDt.getMinutes());
          usedMins+=Math.max(0,eM-sM);
        }
        totalPcs+=countUniquePieces(scans);
      }
      machineUtilization.push({ machineId:mId, machineName:mInfo.name||"Unknown", machineType:mInfo.type||null, serialNumber:mInfo.serialNumber||null, status:machine.currentOperatorIdentityId?"active":usedMins>0?"used":"free", operatorCount:opSet.size, utilizationPct:Math.min(100,Math.round((usedMins/SHIFT_MINS)*100)), activeMins:Math.min(usedMins,SHIFT_MINS), pieces:totalPcs, isCurrentlyBusy:!!machine.currentOperatorIdentityId });
    }
    for (const m of allMachinesRaw) {
      const mId=m._id.toString(); if(trackedSet.has(mId))continue;
      machineUtilization.push({ machineId:mId, machineName:m.name, machineType:m.type, serialNumber:m.serialNumber, status:m.status==="Under Maintenance"?"maintenance":"free", operatorCount:0, utilizationPct:0, activeMins:0, pieces:0, isCurrentlyBusy:false });
    }
    machineUtilization.sort((a,b)=>b.activeMins-a.activeMins);
 
    // ── 10.  Alerts ───────────────────────────────────────────────────────
    const alerts = [];
    const noSignOps = operatorProductivity.filter(o=>o.didNotSignOut&&!o.isActive);
    if (noSignOps.length) alerts.push({ type:"no_signout", severity:"warning", msg:`${noSignOps.length} operator${noSignOps.length>1?"s":""} did not sign out from machine. Biometric attendance finalOut used as fallback.`, names:noSignOps.map(o=>o.name) });
    const multiMachOps = operatorProductivity.filter(o=>o.machines.length>1);
    if (multiMachOps.length) alerts.push({ type:"multi_machine", severity:"info", msg:`${multiMachOps.length} operator${multiMachOps.length>1?"s":""} worked on multiple machines today — check operator tab for transition analysis.`, names:multiMachOps.map(o=>`${o.name} (${o.machines.length})`) });
    const totalInvalidScans = productionSummary.flatMap(pg=>pg.wos).reduce((s,w)=>s+w.invalidScansCount,0);
    if (totalInvalidScans>0) alerts.push({ type:"invalid_scans", severity:"warning", msg:`${totalInvalidScans} scan${totalInvalidScans>1?"s":""} failed validation today (unit out of range, WO not found, or bad format). Check production tab for details.` });
    const idleMachs = machineUtilization.filter(m=>m.status==="free"&&m.utilizationPct===0);
    if (idleMachs.length>0) alerts.push({ type:"idle_machines", severity:"info", msg:`${idleMachs.length} machine${idleMachs.length>1?"s":""} had no production activity today.`, machines:idleMachs.map(m=>m.machineName) });
 
    // ── 11.  KPIs ─────────────────────────────────────────────────────────
    const totalVerifiedPieces = firstScanTsToday.size;
    const totalScans = (todayDoc?.machines||[]).reduce((s,m)=>s+m.operators.reduce((ss,op)=>ss+(op.barcodeScans?.length||0),0),0);
    res.json({
      success:true, date:dateStr,
      kpis:{
        totalPieces: totalVerifiedPieces,
        totalScans,
        invalidScansToday: totalInvalidScans,
        activeOperators:   operatorProductivity.filter(o=>o.isActive).length,
        doneOperators:     operatorProductivity.filter(o=>!o.isActive).length,
        totalOperators:    operatorProductivity.length,
        activeMachines:    machineUtilization.filter(m=>m.isCurrentlyBusy).length,
        usedMachines:      machineUtilization.filter(m=>m.activeMins>0).length,
        totalMachines:     allMachinesRaw.length,
        peakHour:          hourly.length>0?hourly.reduce((a,b)=>b.pieces>a.pieces?b:a):null,
      },
      hourly,
      productionSummary,
      operatorProductivity,
      machineUtilization,
      alerts,
    });
  } catch(err) {
    console.error("[CEO] /daily-summary:", err.message);
    res.status(500).json({ success:false, message:"Server error: "+err.message });
  }
});


router.get("/product-efficiency", ceoAuth, async (req, res) => {
  try {
    const dateStr = req.query.date || getTodayIST();
    const { ProductionTracking, Employee, WorkOrder } = getModels();
    const StockItem       = require("../../models/CMS_Models/Inventory/Products/StockItem");
    const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
 
    // 1. Parallel load
    const [trackingDoc, attendanceDoc, allEmps] = await Promise.all([
      ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
      DailyAttendance.findOne({ dateStr }).lean(),
      Employee.find({ isActive: true })
        .select("firstName lastName identityId biometricId profilePhoto department").lean(),
    ]);
 
    // Enhanced emp lookup (includes GR0 prefix fix)
    const empRawMap = buildEmpMap(allEmps);
    const getEmp = (id) => {
      if (!id) return null;
      return empRawMap.get(id)
        || (/^GR\d+$/i.test(id) ? empRawMap.get("GR0" + id.slice(2)) : null)
        || null;
    };
 
    // 2. Break-window map: operatorId → [{ start, end }]
    const breakMap = new Map();
    for (const e of attendanceDoc?.employees || []) {
      const windows = [];
      if (e.lunchOut && e.lunchIn && new Date(e.lunchIn) > new Date(e.lunchOut))
        windows.push({ start: new Date(e.lunchOut), end: new Date(e.lunchIn) });
      if (e.teaOut && e.teaIn && new Date(e.teaIn) > new Date(e.teaOut))
        windows.push({ start: new Date(e.teaOut), end: new Date(e.teaIn) });
      const val = { windows };
      if (e.biometricId) breakMap.set(e.biometricId, val);
      if (e.identityId && e.identityId !== e.biometricId) breakMap.set(e.identityId, val);
    }
 
    // 3. Flatten all valid scans
    const allScans = [];
    for (const machine of (trackingDoc?.machines || [])) {
      const mId = machine.machineId?.toString();
      for (const op of machine.operators || []) {
        const opId = op.operatorIdentityId;
        const siDateStr = op.signInTime
          ? new Date(op.signInTime).toISOString().split("T")[0] : null;
        if (siDateStr && siDateStr !== dateStr) continue; // skip stale sessions
 
        for (const scan of op.barcodeScans || []) {
          const p = scan.barcodeId?.split("-");
          if (!p || p[0] !== "WO" || p.length < 3) continue;
          const unitNum = parseInt(p[2], 10);
          if (isNaN(unitNum)) continue;
          allScans.push({
            barcodeId: scan.barcodeId,
            timeStamp: new Date(scan.timeStamp),
            activeOps: Array.isArray(scan.activeOps) ? scan.activeOps : [],
            operatorId: opId, machineId: mId,
            woShortId: p[1], unitNum,
          });
        }
      }
    }
 
    if (!allScans.length) {
      return res.json({
        success: true, date: dateStr, products: [],
        summary: { totalProducts: 0, totalPiecesScanned: 0, totalScans: 0, uniqueOps: 0 },
      });
    }
 
    // 4. Load WOs
    const scannedShortIds = new Set(allScans.map(s => s.woShortId));
    const allWOs = await WorkOrder.find({})
      .select("_id workOrderNumber stockItemId stockItemName variantAttributes quantity status").lean();
    const woByShortId = new Map(allWOs.map(wo => [wo._id.toString().slice(-8), wo]));
 
    // 5. Load StockItems
    const stockItemIds = new Set();
    for (const sid of scannedShortIds) {
      const wo = woByShortId.get(sid);
      if (wo?.stockItemId) stockItemIds.add(wo.stockItemId.toString());
    }
    const stockItems = stockItemIds.size
      ? await StockItem.find({ _id: { $in: [...stockItemIds] } })
          .select("name genderCategory category images operations variants").lean()
      : [];
    const stockItemMap = new Map(stockItems.map(si => [si._id.toString(), si]));
 
    // 6. pieceOps: woShortId → unitNum → Set<opCode>
    const pieceOps = new Map();
    for (const scan of allScans) {
      if (!pieceOps.has(scan.woShortId)) pieceOps.set(scan.woShortId, new Map());
      const pMap = pieceOps.get(scan.woShortId);
      if (!pMap.has(scan.unitNum)) pMap.set(scan.unitNum, new Set());
      for (const code of scan.activeOps) pMap.get(scan.unitNum).add(code);
    }
 
    // 7. opTimings: opCode → operatorId → timestamps[]
    const opTimings = new Map();
    for (const scan of allScans) {
      for (const code of scan.activeOps) {
        if (!opTimings.has(code)) opTimings.set(code, new Map());
        const byOp = opTimings.get(code);
        if (!byOp.has(scan.operatorId)) byOp.set(scan.operatorId, []);
        byOp.get(scan.operatorId).push(scan.timeStamp);
      }
    }
 
    // 8. Break-adjusted gaps helper
    const safeAvg = arr => arr.length
      ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
 
    const computeGaps = (timestamps, operatorId) => {
      if (timestamps.length < 2) return [];
      const sorted = [...timestamps].sort((a, b) => a - b);
      const windows = breakMap.get(operatorId)?.windows || [];
      return sorted.slice(1).reduce((acc, ts, i) => {
        let gapMs = ts - sorted[i];
        for (const w of windows) {
          const oS = Math.max(sorted[i].getTime(), w.start.getTime());
          const oE = Math.min(ts.getTime(), w.end.getTime());
          if (oE > oS) gapMs -= (oE - oS);
        }
        const secs = gapMs / 1000;
        if (secs >= 5 && secs < 7200) acc.push(secs);
        return acc;
      }, []);
    };
 
    // opStats: opCode → { avgSecs, sampleCount, operatorBreakdown[] }
    const opStats = new Map();
    for (const [code, byOp] of opTimings) {
      const breakdown = [], allGaps = [];
      for (const [opId, ts] of byOp) {
        const gaps   = computeGaps(ts, opId);
        const opAvg  = safeAvg(gaps);
        const emp    = getEmp(opId);
        breakdown.push({
          operatorId: opId, name: emp?.name || opId,
          profilePhoto: emp?.profilePhoto || null,
          department: emp?.department || null,
          piecesHandled: ts.length, avgSecs: opAvg, sampleCount: gaps.length,
        });
        allGaps.push(...gaps);
      }
      opStats.set(code, {
        avgSecs: safeAvg(allGaps), sampleCount: allGaps.length,
        operatorBreakdown: breakdown.sort((a, b) => b.piecesHandled - a.piecesHandled),
      });
    }
 
    // 9. Build product groups
    const productGroups = new Map();
    for (const woShortId of scannedShortIds) {
      const wo   = woByShortId.get(woShortId);
      const siId = wo?.stockItemId?.toString() || null;
      const si   = siId ? stockItemMap.get(siId) : null;
 
      let image = si?.images?.[0] || null;
      if (!image) { const v = si?.variants?.find(vv => vv.images?.length > 0); if (v) image = v.images[0]; }
 
      const key = siId || `__nosI__${woShortId}`;
      if (!productGroups.has(key)) {
        productGroups.set(key, {
          stockItemId: siId,
          productName: si?.name || wo?.stockItemName || `WO-${woShortId}`,
          genderCategory: si?.genderCategory || null,
          category: si?.category || null,
          image,
          siOps: (si?.operations || []).filter(op => !!op.operationCode),
          variants: [],
        });
      }
 
      const pg   = productGroups.get(key);
      const pMap = pieceOps.get(woShortId) || new Map();
 
      // Expected ops from StockItem
      // StockItem.operations fields: type(name), operationCode, totalSeconds(SAM secs)
      const expectedOps = pg.siOps.map(op => ({
        opCode: op.operationCode, opName: op.type || op.operationCode,
        samSeconds: op.totalSeconds || 0,
        samMins: op.totalSeconds ? +(op.totalSeconds / 60).toFixed(1) : null,
        machineType: op.machineType || op.machine || null,
      }));
      const expectedSet = new Set(expectedOps.map(o => o.opCode));
 
      // Operations efficiency
      const operationsData = expectedOps.map(({ opCode, opName, samSeconds, samMins, machineType }) => {
        const piecesWithOp = [...pMap.values()].filter(ops => ops.has(opCode)).length;
        const stats        = opStats.get(opCode);
        const avgActual    = stats?.avgSecs || null;
        const effPct       = samSeconds && avgActual && avgActual > 0
          ? Math.round((samSeconds / avgActual) * 100) : null;
        return {
          opCode, opName, samSeconds, samMins, machineType,
          piecesWithOp,
          totalScansForOp: stats?.operatorBreakdown?.reduce((s, b) => s + b.piecesHandled, 0) || 0,
          avgActualSecs: avgActual, efficiencyPct: effPct,
          operatorBreakdown: (stats?.operatorBreakdown || []).map(br => ({
            ...br,
            efficiencyPct: samSeconds && br.avgSecs
              ? Math.round((samSeconds / br.avgSecs) * 100) : null,
          })),
        };
      });
 
      // Extra ops (scanned but not expected by StockItem)
      const allScannedCodes = new Set();
      for (const ops of pMap.values()) for (const c of ops) allScannedCodes.add(c);
      const extraOps = [...allScannedCodes].filter(c => !expectedSet.has(c)).map(code => {
        const st = opStats.get(code);
        return {
          opCode: code, opName: code, samSeconds: null, samMins: null, machineType: null,
          piecesWithOp: [...pMap.values()].filter(ops => ops.has(code)).length,
          avgActualSecs: st?.avgSecs || null, efficiencyPct: null, isExtra: true,
          operatorBreakdown: (st?.operatorBreakdown || []).map(br => ({ ...br, efficiencyPct: null })),
        };
      });
 
      // Piece completion status
      const pieceStatus = [...pMap.entries()].map(([unitNum, scannedOps]) => {
        const doneOps    = [...scannedOps].filter(c => expectedSet.has(c));
        const missingOps = [...expectedSet].filter(c => !scannedOps.has(c));
        return {
          unitNum, scannedOps: [...scannedOps], doneOps, missingOps,
          isComplete: missingOps.length === 0,
          completionPct: expectedSet.size > 0
            ? Math.round((doneOps.length / expectedSet.size) * 100) : 100,
        };
      }).sort((a, b) => a.unitNum - b.unitNum);
 
      pg.variants.push({
        woShortId,
        workOrderNumber:  wo?.workOrderNumber || `WO-${woShortId}`,
        workOrderStatus:  wo?.status || "unknown",
        variantAttributes: wo?.variantAttributes || [],
        totalQuantity:    wo?.quantity || 0,
        piecesScanned:    pMap.size,
        completePieces:   pieceStatus.filter(p => p.isComplete).length,
        incompletePieces: pieceStatus.filter(p => !p.isComplete).length,
        expectedOpsCount: expectedSet.size,
        operations:       operationsData,
        extraOps,
        pieceStatus:      pieceStatus.slice(0, 300),
        pieceStatusTotal: pieceStatus.length,
      });
    }
 
    const products = Array.from(productGroups.values()).map(pg => ({
      stockItemId: pg.stockItemId, productName: pg.productName,
      genderCategory: pg.genderCategory, category: pg.category, image: pg.image,
      variants: pg.variants.sort((a, b) => b.piecesScanned - a.piecesScanned),
      totalPieces: pg.variants.reduce((s, v) => s + v.piecesScanned, 0),
    })).sort((a, b) => b.totalPieces - a.totalPieces);
 
    const uniquePieces = new Set(allScans.map(s => `${s.woShortId}-${s.unitNum}`)).size;
    res.json({
      success: true, date: dateStr, products,
      summary: { totalProducts: products.length, totalPiecesScanned: uniquePieces,
        totalScans: allScans.length, uniqueOps: opTimings.size },
    });
  } catch (err) {
    console.error("[CEO] /product-efficiency:", err.message);
    res.status(500).json({ success: false, message: "Server error: " + err.message });
  }
});


module.exports = router;