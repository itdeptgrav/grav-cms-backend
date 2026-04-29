/**
 * routes/CEO_Routes/production.js (v4 — NAME + ACTIVITY FIX)
 *
 * FIXES:
 * 1. TIMEZONE: UTC range query (same as v3)
 * 2. OPERATOR NAMES "Unknown": Tracking stores operatorIdentityId like "GR0060"
 *    which could be stored in Employee.identityId OR Employee.biometricId.
 *    Now we search BOTH fields: { $or: [{identityId: id}, {biometricId: id}] }
 * 3. OPERATORS TAB shows "No activity": The /operators endpoint builds activityMap
 *    keyed by identityId, but the employee key is also built from identityId||biometricId.
 *    Now we key activityMap by BOTH identityId and biometricId to ensure matching.
 * 4. NaN key error: identityId can be undefined — use fallback key.
 */
"use strict";

const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");

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
    } catch { return res.status(401).json({ success: false, message: "Invalid or expired token" }); }
}

// ── Models ────────────────────────────────────────────────────────────────────
const getModels = () => ({
    ProductionTracking: require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking"),
    WorkOrder: require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder"),
    Machine: require("../../models/CMS_Models/Inventory/Configurations/Machine"),
    Employee: require("../../models/Employee"),
});

// ── IST today ────────────────────────────────────────────────────────────────
const getTodayIST = () => {
    const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

// UTC range — THE TIMEZONE FIX
// Data stored as: date = 2026-04-28T00:00:00.000Z (UTC midnight)
// setHours(0,0,0,0) on IST localhost = wrong bucket → use range instead
function utcRange(dateStr) {
    const start = new Date(dateStr + "T00:00:00.000Z");
    const end = new Date(dateStr + "T00:00:00.000Z");
    end.setUTCDate(end.getUTCDate() + 1);
    return { $gte: start, $lt: end };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const avgInterval = (scans = []) => {
    if (scans.length < 2) return null;
    const s = [...scans].sort((a, b) => new Date(a.timeStamp) - new Date(b.timeStamp));
    const g = [];
    for (let i = 1; i < s.length; i++) { const d = (new Date(s[i].timeStamp) - new Date(s[i - 1].timeStamp)) / 1000; if (d > 0 && d < 7200) g.push(d); }
    return g.length ? Math.round(g.reduce((a, b) => a + b) / g.length) : null;
};

const parseBarcode = id => {
    if (!id) return null;
    const p = id.split("-");
    // Barcode format: WO-{shortId}-{unitNum}  (3 parts)
    // e.g. WO-334c14e2-003
    if (p[0] !== "WO" || p.length < 3) return null;
    return { shortId: p[1], unit: parseInt(p[2], 10) };
};

/**
 * FIX: Resolve employee name from tracking operatorIdentityId.
 * The ID (e.g. "GR0060") could be stored in EITHER:
 *   - Employee.identityId  (new style)
 *   - Employee.biometricId (old style)
 * Search both fields with $or.
 */
async function resolveEmployeeName(operatorId, Employee) {
    if (!operatorId) return null;
    const emp = await Employee.findOne({
        $or: [{ identityId: operatorId }, { biometricId: operatorId }]
    }).select("firstName lastName profilePhoto").lean();
    if (!emp) return null;
    return {
        name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
        profilePhoto: emp.profilePhoto,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/overview
// ─────────────────────────────────────────────────────────────────────────────
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
        if (doc) for (const m of doc.machines || []) {
            let had = false;
            for (const op of m.operators || []) {
                if (!op.signOutTime) activeNow++; else signedOut++;
                totalScans += op.barcodeScans?.length || 0;
                if ((op.barcodeScans?.length || 0) > 0) had = true;
            }
            if (had || m.currentOperatorIdentityId) actMach.add(m.machineId?.toString());
        }
        res.json({
            success: true, data: {
                workOrders: { total: tWO, ongoing: oWO, completed: cWO, pending: pWO, completedThisMonth: cmWO },
                operators: { total: tOps, activeNow, signedOutToday: signedOut, totalScansToday: totalScans },
                machines: { activeToday: actMach.size },
            }
        });
    } catch (err) { res.status(500).json({ success: false, message: "Server error: " + err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/live?date=YYYY-MM-DD
// FIXES:
//  - UTC range query (timezone fix)
//  - resolves operator name from Employee by BOTH identityId and biometricId
//  - enriches operator data with profilePhoto
// ─────────────────────────────────────────────────────────────────────────────
router.get("/live", ceoAuth, async (req, res) => {
    try {
        const { ProductionTracking, Machine, Employee, WorkOrder } = getModels();
        const dateStr = req.query.date || getTodayIST();

        const [doc, allMachines] = await Promise.all([
            ProductionTracking.findOne({ date: utcRange(dateStr) })
                .populate("machines.machineId", "name serialNumber type location")
                .lean(),
            Machine.find({}).select("name serialNumber type location status").lean(),
        ]);

        const wos = await WorkOrder.find({ status: { $in: ["in_progress", "scheduled", "ready_to_start", "planned", "pending"] } })
            .select("workOrderNumber stockItemName _id").lean();
        const woMap = {};
        wos.forEach(w => { woMap[w._id.toString().slice(-8)] = w; });

        const machMap = {};
        allMachines.forEach(m => { machMap[m._id.toString()] = m; });

        // PRE-LOAD all employees by identityId and biometricId for fast lookup
        // This avoids N+1 queries in the operator loop
        const allEmps = await Employee.find({ isActive: true })
            .select("firstName lastName identityId biometricId profilePhoto needsToOperate")
            .lean();
        // Build lookup map: both identityId and biometricId → employee
        const empByAnyId = new Map();
        for (const e of allEmps) {
            const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
            const data = { name, profilePhoto: e.profilePhoto };
            if (e.identityId) empByAnyId.set(e.identityId, data);
            if (e.biometricId && e.biometricId !== e.identityId) empByAnyId.set(e.biometricId, data);
        }

        if (!doc) {
            return res.json({
                success: true, date: dateStr,
                machines: allMachines.map(m => ({
                    machineId: m._id.toString(), machineName: m.name || "Unknown",
                    machineSerial: m.serialNumber, machineType: m.type,
                    status: m.status === "Under Maintenance" ? "maintenance" : "free",
                    currentOperator: null, operators: [], totalScans: 0,
                })),
                summary: { totalOperators: 0, activeNow: 0, totalScans: 0, activeMachines: 0, totalMachines: allMachines.length },
            });
        }

        let globalActive = 0, globalScans = 0, globalActiveMach = 0;
        const machinesData = [];
        const trackedIds = new Set();

        for (const machine of doc.machines || []) {
            const mInfo = machine.machineId || {};
            const mId = mInfo._id?.toString() || machine.machineId?.toString();
            trackedIds.add(mId);
            const opsData = [];
            let machScans = 0;

            for (const op of machine.operators || []) {
                const opId = op.operatorIdentityId;

                // FIX: ALWAYS use the name stored in tracking doc first (it's already resolved)
                // Only use Employee DB lookup for profile photo
                const empData = empByAnyId.get(opId);
                const name = (op.operatorName && op.operatorName.trim() !== "" && op.operatorName !== "Unknown Operator")
                    ? op.operatorName.trim()
                    : (empData?.name && empData.name.trim() !== "" ? empData.name.trim() : (opId || "Unknown"));
                const profilePhoto = empData?.profilePhoto || null;

                const scans = op.barcodeScans || [];
                machScans += scans.length;
                // Mark stale sessions as inactive
                const signInDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
                const isStale = signInDateStr && signInDateStr !== dateStr;
                const isActive = !op.signOutTime && !isStale;
                // Count unique pieces: WO-shortId-unitNum — deduplicated per unit number
                const uniqueUnits = new Set();
                for (const s of scans) {
                    const p = s.barcodeId?.split("-");
                    if (p && p[0] === "WO" && p.length >= 3) uniqueUnits.add(`${p[1]}-${p[2]}`);
                }
                if (isActive) globalActive++;
                const sorted = [...scans].sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
                const lastScan = sorted[0]?.timeStamp || null;
                const lastOps = Array.isArray(sorted[0]?.activeOps) ? sorted[0].activeOps
                    : (typeof sorted[0]?.activeOps === "string" ? sorted[0].activeOps.split(",").filter(Boolean) : []);

                const woBuckets = {};
                scans.forEach(s => {
                    const parsed = parseBarcode(s.barcodeId);
                    if (!parsed) return;
                    const wo = woMap[parsed.shortId];
                    if (!woBuckets[parsed.shortId]) woBuckets[parsed.shortId] = { shortId: parsed.shortId, woNumber: wo?.workOrderNumber, woName: wo?.stockItemName, units: new Set(), scans: 0 };
                    woBuckets[parsed.shortId].units.add(s.barcodeId);
                    woBuckets[parsed.shortId].scans++;
                });

                const sessMs = isActive ? Date.now() - new Date(op.signInTime).getTime()
                    : (op.signOutTime ? new Date(op.signOutTime) - new Date(op.signInTime) : 0);

                opsData.push({
                    identityId: opId,
                    name,
                    profilePhoto,
                    signInTime: op.signInTime,
                    signOutTime: op.signOutTime || null,
                    isActive,
                    isStale,
                    totalScans: scans.length,
                    uniquePieces: uniqueUnits.size,
                    avgScanIntervalSecs: avgInterval(scans),
                    lastScanTime: lastScan,
                    lastActiveOps: lastOps,
                    sessionDurationMs: sessMs,
                    workOrders: Object.values(woBuckets).map(b => ({ shortId: b.shortId, woNumber: b.woNumber, woName: b.woName, unitsDone: b.units.size, scans: b.scans })),
                    recentScans: sorted.slice(0, 10).map(s => ({ barcodeId: s.barcodeId, timeStamp: s.timeStamp, activeOps: Array.isArray(s.activeOps) ? s.activeOps : [] })),
                    // Keep raw barcodeScans for drawer fallback (limited to last 50 for performance)
                    barcodeScans: scans.slice(-50).map(s => ({ barcodeId: s.barcodeId, timeStamp: s.timeStamp, activeOps: Array.isArray(s.activeOps) ? s.activeOps : [] })),
                });
            }
            // Machine-level unique pieces (dedup across all operators)
            const machineUniqueUnits = new Set();
            opsData.forEach(op => {
                op.workOrders?.forEach(wo => {
                    // unit ids were tracked in uniqueUnits above per op — recount from barcodeScans
                });
            });
            // Actually recount from raw scans for this machine
            let machUniqPieces = 0;
            {
                const mUnits = new Set();
                for (const op of machine.operators || []) {
                    for (const s of op.barcodeScans || []) {
                        const p = s.barcodeId?.split("-");
                        if (p && p[0] === "WO" && p.length >= 3) mUnits.add(`${p[1]}-${p[2]}`);
                    }
                }
                machUniqPieces = mUnits.size;
            }
            globalScans += machScans;
            if (machScans > 0 || machine.currentOperatorIdentityId) globalActiveMach++;

            let curr = null;
            if (machine.currentOperatorIdentityId) {
                const opId = machine.currentOperatorIdentityId;
                // Only show current operator if their session is actually active (not stale)
                const c = opsData.find(o => o.identityId === opId && o.isActive);
                // Prefer name from active session (already resolved from tracking doc)
                // Fall back to Employee DB lookup, then raw ID
                const empData = empByAnyId.get(opId);
                const currName = c?.name || empData?.name || opId;
                curr = { identityId: opId, name: currName, profilePhoto: c?.profilePhoto || empData?.profilePhoto || null };
            }
            const mRef = machMap[mId] || {};
            // Group sessions by operator for machine card display
            // (same operator can have multiple sign-in/sign-out cycles)
            const opSummaryMap = new Map();
            for (const op of opsData) {
                const key = op.identityId;
                if (!opSummaryMap.has(key)) {
                    opSummaryMap.set(key, {
                        identityId: key,
                        name: op.name,
                        profilePhoto: op.profilePhoto,
                        pieces: 0,
                        earliestSignIn: null,
                        latestSignOut: null,
                        isActiveNow: false,
                    });
                }
                const s = opSummaryMap.get(key);
                s.pieces += op.uniquePieces;
                if (op.signInTime && (!s.earliestSignIn || new Date(op.signInTime) < new Date(s.earliestSignIn))) {
                    s.earliestSignIn = op.signInTime;
                }
                if (op.signOutTime && (!s.latestSignOut || new Date(op.signOutTime) > new Date(s.latestSignOut))) {
                    s.latestSignOut = op.signOutTime;
                }
                if (op.isActive) s.isActiveNow = true;
            }
            const operatorSummaries = Array.from(opSummaryMap.values())
                .sort((a, b) => (a.isActiveNow ? -1 : 1) - (b.isActiveNow ? -1 : 1));

            machinesData.push({
                machineId: mId,
                machineName: mInfo.name || mRef.name || "Unknown",
                machineSerial: mInfo.serialNumber || mRef.serialNumber,
                machineType: mInfo.type || mRef.type,
                machineLocation: mInfo.location || mRef.location,
                status: machine.currentOperatorIdentityId ? "busy" : machScans > 0 ? "used_today" : "free",
                currentOperator: curr,
                operators: opsData.sort((a, b) => (a.isActive ? -1 : 1) - (b.isActive ? -1 : 1)),
                operatorSummaries,  // grouped per unique operator for card display
                totalScans: machScans,
                uniquePiecesCompleted: machUniqPieces,
            });
        }

        // Add un-tracked machines
        allMachines.forEach(m => {
            const mId = m._id.toString();
            if (!trackedIds.has(mId)) {
                machinesData.push({
                    machineId: mId, machineName: m.name || "Unknown", machineSerial: m.serialNumber,
                    machineType: m.type, machineLocation: m.location,
                    status: m.status === "Under Maintenance" ? "maintenance" : m.status === "Offline" ? "offline" : "free",
                    currentOperator: null, operators: [], totalScans: 0,
                });
            }
        });

        res.json({
            success: true, date: dateStr, machines: machinesData,
            summary: {
                totalOperators: machinesData.reduce((s, m) => s + m.operators.length, 0),
                activeNow: globalActive,
                totalScans: globalScans,
                activeMachines: globalActiveMach,
                totalMachines: allMachines.length,
            },
        });
    } catch (err) {
        console.error("[CEO] /live:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/machines?date=YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
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
    } catch (err) { res.status(500).json({ success: false, message: "Server error" }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/operators
// FIX: Activity map now keyed by BOTH identityId and biometricId,
//      so employees whose tracking ID is in biometricId also get matched.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/operators", ceoAuth, async (req, res) => {
    try {
        const { Employee, ProductionTracking } = getModels();

        const allOps = await Employee.find({ needsToOperate: true, isActive: true })
            .select("firstName lastName identityId biometricId department designation profilePhoto")
            .lean();

        const dateStr = getTodayIST();
        const doc = await ProductionTracking.findOne({ date: utcRange(dateStr) }).lean();

        // FIX: build activity map keyed by the raw tracking ID (could be identityId or biometricId)
        // Then when merging with employee list, try both fields
        const aMap = new Map(); // trackingId → activity

        if (doc) {
            for (const m of doc.machines || []) {
                for (const op of m.operators || []) {
                    const id = op.operatorIdentityId;
                    if (!id) continue;

                    if (!aMap.has(id)) {
                        aMap.set(id, {
                            isActiveNow: false, signInTime: null, totalScans: 0,
                            avgI: null, lastScan: null, machIds: new Set(), machineName: null,
                            // Store name from tracking doc as fallback
                            trackingName: op.operatorName || null,
                        });
                    }
                    const a = aMap.get(id);
                    if (!op.signOutTime) {
                        a.isActiveNow = true;
                        // Store the machine name for the active session
                        const machDoc = doc.machines.find(mm => mm.operators.some(o => o.operatorIdentityId === id && !o.signOutTime));
                        // We'll resolve machine name in the response below
                    }
                    if (!a.signInTime || new Date(op.signInTime) < new Date(a.signInTime)) {
                        a.signInTime = op.signInTime;
                    }
                    a.totalScans += op.barcodeScans?.length || 0;
                    if (op.barcodeScans?.length) {
                        a.machIds.add(m.machineId?.toString());
                        const iv = avgInterval(op.barcodeScans);
                        if (iv) a.avgI = iv;
                        const sorted = [...op.barcodeScans].sort((a, b) => new Date(b.timeStamp) - new Date(a.timeStamp));
                        if (sorted[0] && (!a.lastScan || new Date(sorted[0].timeStamp) > new Date(a.lastScan))) {
                            a.lastScan = sorted[0].timeStamp;
                        }
                    }
                }
            }
        }

        // Also pre-load machine names
        const { Machine } = getModels();
        const machines = await Machine.find({}).select("name _id").lean();
        const machNameMap = new Map(machines.map(m => [m._id.toString(), m.name]));

        // FIX: For each employee, try identityId AND biometricId to find activity
        const result = allOps.map(e => {
            const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
            // Try identityId first, then biometricId
            const activity = aMap.get(e.identityId) || aMap.get(e.biometricId) || null;

            const machineIds = activity?.machIds ? Array.from(activity.machIds) : [];
            const machineName = machineIds.length > 0 ? (machNameMap.get(machineIds[machineIds.length - 1]) || null) : null;

            return {
                _id: e._id,
                identityId: e.identityId || e.biometricId || e._id.toString(),
                biometricId: e.biometricId,
                name,
                department: e.department,
                designation: e.designation,
                profilePhoto: e.profilePhoto,
                isActiveNow: activity?.isActiveNow || false,
                hasActivityToday: (activity?.totalScans || 0) > 0 || activity?.isActiveNow || false,
                signInTime: activity?.signInTime || null,
                lastScanTime: activity?.lastScan || null,
                totalScansToday: activity?.totalScans || 0,
                avgScanIntervalSecs: activity?.avgI || null,
                machinesUsed: machineIds,
                machineName,
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

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/products?startDate=&endDate=&mode=floor|completion|all
// 
// Shows product-wise production from ProductionTracking (floor scans).
// Barcode format: WO-{8charShortId}-{unitNum}  (3 parts, not 4)
//
// Logic: unique barcode scans per WO → unique units touched
// Matches WO → gets stockItemName, variantAttributes, images from StockItem
// Groups by Manufacturing Order (CustomerRequest)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/products", ceoAuth, async (req, res) => {
    try {
        const { startDate, endDate } = req.query;
        const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
        const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
        const ProductionTracking = require("../../models/CMS_Models/Manufacturing/Production/Tracking/ProductionTracking");
        const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");

        const today = getTodayIST();
        // Build date range (UTC midnight based — consistent with tracking storage)
        const sd = startDate || today;
        const ed = endDate || today;
        const startUTC = new Date(sd + "T00:00:00.000Z");
        const endUTC = new Date(ed + "T00:00:00.000Z");
        endUTC.setUTCDate(endUTC.getUTCDate() + 1);

        // Pull all tracking docs in range
        const trackingDocs = await ProductionTracking.find({ date: { $gte: startUTC, $lt: endUTC } }).lean();

        // Count unique units scanned per WO short-id
        // Barcode: WO-{shortId}-{unitNum} — 3 parts
        const floorScanMap = new Map(); // shortId → { units: Set, totalScans: number }
        let totalFloorScans = 0;

        for (const doc of trackingDocs) {
            for (const machine of doc.machines || []) {
                for (const op of machine.operators || []) {
                    for (const s of op.barcodeScans || []) {
                        const p = s.barcodeId?.split("-");
                        if (!p || p[0] !== "WO" || p.length < 3) continue;
                        const shortId = p[1];
                        const unit = p[2]; // keep as string for dedup
                        if (!floorScanMap.has(shortId)) floorScanMap.set(shortId, { units: new Set(), totalScans: 0 });
                        floorScanMap.get(shortId).units.add(unit);
                        floorScanMap.get(shortId).totalScans++;
                        totalFloorScans++;
                    }
                }
            }
        }

        if (floorScanMap.size === 0) {
            return res.json({ success: true, totalFloorScans: 0, totalUnitsInProgress: 0, manufacturingOrders: [], dateRange: { start: startUTC, end: endUTC } });
        }

        // Load all WOs matching the short IDs found
        const allWOs = await WorkOrder.find({}).select("_id workOrderNumber customerRequestId stockItemId stockItemName variantAttributes quantity status productionCompletion").lean();
        const woShortMap = new Map();
        allWOs.forEach(wo => { woShortMap.set(wo._id.toString().slice(-8), wo); });

        // Collect stockItem IDs we need for images/gender
        const stockItemIds = new Set();
        const moAgg = new Map(); // moId → { moId, products: Map }

        for (const [shortId, scanData] of floorScanMap) {
            const wo = woShortMap.get(shortId);
            if (!wo) continue;
            if (wo.stockItemId) stockItemIds.add(wo.stockItemId.toString());
            const moId = wo.customerRequestId?.toString() || "__no_mo__";
            if (!moAgg.has(moId)) moAgg.set(moId, { moId, products: new Map(), totalUnitsScanned: 0, moIds: new Set() });
            const entry = moAgg.get(moId);
            entry.totalUnitsScanned += scanData.units.size;

            const pk = wo._id.toString().slice(-8); // one product card per WO
            if (!entry.products.has(pk)) {
                entry.products.set(pk, {
                    woShortId: pk,
                    workOrderNumber: wo.workOrderNumber,
                    workOrderStatus: wo.status,
                    stockItemId: wo.stockItemId?.toString(),
                    productName: wo.stockItemName || "Unknown Product",
                    variantAttributes: wo.variantAttributes || [],
                    totalQuantity: wo.quantity || 0,
                    unitsScanned: 0,
                    totalScans: 0,
                    unitsCompleted: wo.productionCompletion?.overallCompletedQuantity || 0,
                    completionPct: wo.productionCompletion?.overallCompletionPercentage || 0,
                    image: null,
                    genderCategory: null,
                    category: null,
                });
            }
            const p = entry.products.get(pk);
            p.unitsScanned = scanData.units.size;
            p.totalScans = scanData.totalScans;
        }

        // Also include WOs that have completion data even if no floor scans in this period
        for (const wo of allWOs) {
            if (!(wo.productionCompletion?.overallCompletedQuantity > 0)) continue;
            const shortId = wo._id.toString().slice(-8);
            if (floorScanMap.has(shortId)) continue; // already included
            const moId = wo.customerRequestId?.toString() || "__no_mo__";
            if (!moAgg.has(moId)) moAgg.set(moId, { moId, products: new Map(), totalUnitsScanned: 0 });
            const entry = moAgg.get(moId);
            if (wo.stockItemId) stockItemIds.add(wo.stockItemId.toString());
            const pk = shortId;
            if (!entry.products.has(pk)) {
                entry.products.set(pk, {
                    woShortId: pk, workOrderNumber: wo.workOrderNumber, workOrderStatus: wo.status,
                    stockItemId: wo.stockItemId?.toString(), productName: wo.stockItemName || "Unknown Product",
                    variantAttributes: wo.variantAttributes || [], totalQuantity: wo.quantity || 0,
                    unitsScanned: 0, totalScans: 0,
                    unitsCompleted: wo.productionCompletion.overallCompletedQuantity,
                    completionPct: wo.productionCompletion.overallCompletionPercentage || 0,
                    image: null, genderCategory: null, category: null,
                });
            }
        }

        // Load StockItems for images and gender
        const stockItems = await StockItem.find({ _id: { $in: [...stockItemIds] } })
            .select("name genderCategory category reference images variants").lean();
        const stockMap = new Map(stockItems.map(si => [si._id.toString(), si]));

        // Load MO (CustomerRequest) info
        const allMoIds = [...moAgg.keys()].filter(id => id !== "__no_mo__");
        const mos = allMoIds.length > 0
            ? await CustomerRequest.find({ _id: { $in: allMoIds } }).select("requestId customerInfo requestType status").lean()
            : [];
        const moMap = new Map(mos.map(m => [m._id.toString(), m]));

        // Build response
        const manufacturingOrders = Array.from(moAgg.entries()).map(([moId, entry]) => {
            const mo = moId !== "__no_mo__" ? moMap.get(moId) : null;
            const products = Array.from(entry.products.values()).map(p => {
                // Enrich with StockItem image and gender
                const si = p.stockItemId ? stockMap.get(p.stockItemId) : null;
                let image = null;
                if (si?.images?.length > 0) image = si.images[0];
                else if (si?.variants?.length > 0) {
                    const v = si.variants.find(vv => vv.images?.length > 0);
                    if (v) image = v.images[0];
                }
                return {
                    ...p,
                    productName: si?.name || p.productName,
                    genderCategory: si?.genderCategory || null,
                    category: si?.category || null,
                    reference: si?.reference || null,
                    image,
                };
            }).sort((a, b) => b.unitsScanned - a.unitsScanned);

            return {
                moId,
                moNumber: mo ? `MO-${mo.requestId}` : "Unlinked",
                customerName: mo?.customerInfo?.name || "—",
                requestType: mo?.requestType || null,
                moStatus: mo?.status || null,
                totalUnitsScanned: entry.totalUnitsScanned,
                products,
            };
        }).filter(mo => mo.products.length > 0)
            .sort((a, b) => b.totalUnitsScanned - a.totalUnitsScanned);

        res.json({
            success: true,
            totalFloorScans,
            totalUnitsInProgress: manufacturingOrders.reduce((s, m) => s + m.totalUnitsScanned, 0),
            manufacturingOrders,
            dateRange: { start: startUTC, end: endUTC },
        });
    } catch (err) {
        console.error("[CEO] /products:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/work-orders
// ─────────────────────────────────────────────────────────────────────────────
router.get("/work-orders", ceoAuth, async (req, res) => {
    try {
        const { WorkOrder } = getModels();
        const { status = "active", limit = 100 } = req.query;
        const q = status === "all" ? {} : status === "active" ? { status: { $in: ["in_progress", "scheduled", "ready_to_start", "planned"] } } : { status };
        const wos = await WorkOrder.find(q).select("workOrderNumber stockItemName status quantity customerName variantAttributes operations productionCompletion timeline createdAt").sort({ updatedAt: -1 }).limit(parseInt(limit)).lean();
        res.json({ success: true, data: wos.map(w => ({ ...w, workOrderShortId: w._id.toString().slice(-8), completionPct: w.quantity > 0 ? Math.round(((w.productionCompletion?.overallCompletedQuantity || 0) / w.quantity) * 100) : 0, completedUnits: w.productionCompletion?.overallCompletedQuantity || 0, operationsCount: w.operations?.length || 0 })), total: wos.length });
    } catch (err) { res.status(500).json({ success: false, message: "Server error: " + err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/ceo/production/machine-detail/:machineId?date=YYYY-MM-DD
//
// Returns per-operator sessions with:
//   - uniquePieces (deduplicated WO-shortId-unitNum per session)
//   - products per operator: WO → MO → StockItem name + image + variants
//   - attendance break status (lunch/tea/checked-out) from DailyAttendance
//
// NOTE: "scans" count is intentionally NOT shown in the response — not meaningful
//       to CEO. Only "pieces" (unique units worked on) is shown.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/machine-detail/:machineId", ceoAuth, async (req, res) => {
    try {
        const { machineId } = req.params;
        const dateStr = req.query.date || getTodayIST();
        const { ProductionTracking, Employee } = getModels();
        const Machine = require("../../models/CMS_Models/Inventory/Configurations/Machine");
        const WorkOrder = require("../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
        const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
        const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
        const DailyAttendance = require("../../models/HR_Models/Dailyattendance");

        // ── Load machine info ──────────────────────────────────────────────────
        const machInfo = await Machine.findById(machineId)
            .select("name serialNumber type location status").lean().catch(() => null);

        // ── Load tracking + attendance in parallel ─────────────────────────────
        const [trackingDoc, attendanceDoc] = await Promise.all([
            ProductionTracking.findOne({ date: utcRange(dateStr) }).lean(),
            DailyAttendance.findOne({ dateStr }).lean(),
        ]);

        // ── Attendance map: id → punch record ─────────────────────────────────
        const attendanceMap = new Map();
        for (const emp of attendanceDoc?.employees || []) {
            const entry = {
                inTime: emp.inTime || null, lunchOut: emp.lunchOut || null,
                lunchIn: emp.lunchIn || null, teaOut: emp.teaOut || null,
                teaIn: emp.teaIn || null, finalOut: emp.finalOut || null,
            };
            if (emp.biometricId) attendanceMap.set(emp.biometricId, entry);
            if (emp.identityId && emp.identityId !== emp.biometricId) attendanceMap.set(emp.identityId, entry);
        }

        // ── Employee name/photo lookup ─────────────────────────────────────────
        const allEmps = await Employee.find({ isActive: true })
            .select("firstName lastName identityId biometricId profilePhoto").lean();
        const empByAnyId = new Map();
        for (const e of allEmps) {
            const name = `${e.firstName || ""} ${e.lastName || ""}`.trim();
            const d = { name, profilePhoto: e.profilePhoto };
            if (e.identityId) empByAnyId.set(e.identityId, d);
            if (e.biometricId && e.biometricId !== e.identityId) empByAnyId.set(e.biometricId, d);
        }

        const machineRef = machInfo
            ? { id: machineId, name: machInfo.name, serial: machInfo.serialNumber, type: machInfo.type, location: machInfo.location }
            : { id: machineId, name: "Unknown" };

        if (!trackingDoc) {
            return res.json({ success: true, date: dateStr, machine: machineRef, operators: [], uniquePieces: 0, attendanceLastSynced: attendanceDoc?.syncedAt || null, attendanceNote: !attendanceDoc ? "No attendance data yet — HR sync may be pending" : null });
        }

        const machTracking = (trackingDoc.machines || []).find(m => m.machineId?.toString() === machineId);
        if (!machTracking) {
            return res.json({ success: true, date: dateStr, machine: machineRef, operators: [], uniquePieces: 0, attendanceLastSynced: attendanceDoc?.syncedAt || null, attendanceNote: null });
        }

        // ── Collect all WO short-ids used on this machine to batch-load products
        const allWoShortIds = new Set();
        for (const op of machTracking.operators || []) {
            for (const s of op.barcodeScans || []) {
                const p = s.barcodeId?.split("-");
                if (p && p[0] === "WO" && p.length >= 3) allWoShortIds.add(p[1]);
            }
        }

        // ── Batch load WOs → StockItem + MO in one pass ────────────────────────
        const allWOs = allWoShortIds.size > 0
            ? await WorkOrder.find({}).select("_id workOrderNumber stockItemId stockItemName variantAttributes customerRequestId quantity status").lean()
            : [];
        const woShortMap = new Map();
        allWOs.forEach(wo => { woShortMap.set(wo._id.toString().slice(-8), wo); });

        // Collect stockItemIds and moIds to load
        const siIds = new Set(); const moIds = new Set();
        for (const shortId of allWoShortIds) {
            const wo = woShortMap.get(shortId);
            if (!wo) continue;
            if (wo.stockItemId) siIds.add(wo.stockItemId.toString());
            if (wo.customerRequestId) moIds.add(wo.customerRequestId.toString());
        }

        const [stockItems, mos] = await Promise.all([
            siIds.size > 0 ? StockItem.find({ _id: { $in: [...siIds] } }).select("name genderCategory category images variants").lean() : [],
            moIds.size > 0 ? CustomerRequest.find({ _id: { $in: [...moIds] } }).select("requestId customerInfo requestType").lean() : [],
        ]);
        const siMap = new Map(stockItems.map(si => [si._id.toString(), si]));
        const moMap = new Map(mos.map(mo => [mo._id.toString(), mo]));

        // Helper: resolve product image — try variant match first, then main image
        const resolveImage = (si, variantAttributes) => {
            if (!si) return null;
            if (variantAttributes?.length && si.variants?.length) {
                const match = si.variants.find(v =>
                    (v.attributes || []).every(va =>
                        variantAttributes.some(woA =>
                            woA.name?.toLowerCase() === va.name?.toLowerCase() &&
                            String(woA.value).toLowerCase() === String(va.value).toLowerCase()
                        )
                    )
                );
                if (match?.images?.[0]) return match.images[0];
            }
            return si.images?.[0] || null;
        };

        // Helper: determine attendance break status
        const getAttendanceStatus = (opId) => {
            const att = attendanceMap.get(opId);
            if (!att) return { status: null, breakInfo: null };
            const now = new Date();
            const lunchOut = att.lunchOut ? new Date(att.lunchOut) : null;
            const lunchIn = att.lunchIn ? new Date(att.lunchIn) : null;
            const teaOut = att.teaOut ? new Date(att.teaOut) : null;
            const teaIn = att.teaIn ? new Date(att.teaIn) : null;
            const finalOut = att.finalOut ? new Date(att.finalOut) : null;
            if (finalOut && finalOut < now) return { status: "checked_out", breakInfo: { label: "Checked out at", time: att.finalOut, icon: "out" } };
            if (lunchOut && (!lunchIn || lunchIn < lunchOut)) return { status: "lunch_break", breakInfo: { label: "On lunch since", time: att.lunchOut, icon: "lunch", mightBeStale: (now - lunchOut) > 45 * 60000 } };
            if (teaOut && (!teaIn || teaIn < teaOut)) return { status: "tea_break", breakInfo: { label: "On tea break since", time: att.teaOut, icon: "tea", mightBeStale: (now - teaOut) > 30 * 60000 } };
            return { status: "working", breakInfo: null };
        };

        // ── Build per-operator sessions ────────────────────────────────────────
        const machineUnits = new Set();

        const operators = (machTracking.operators || []).map(op => {
            const opId = op.operatorIdentityId;
            const empData = empByAnyId.get(opId);
            const name = (op.operatorName?.trim() && op.operatorName !== "Unknown Operator")
                ? op.operatorName.trim() : (empData?.name || opId || "Unknown");

            const scans = op.barcodeScans || [];
            const signInDateStr = op.signInTime ? new Date(op.signInTime).toISOString().split("T")[0] : null;
            const isStale = signInDateStr && signInDateStr !== dateStr;
            const isSignedIn = !op.signOutTime && !isStale;

            // Deduplicate units per WO
            const opUnits = new Set();
            const woBuckets = {}; // shortId → Set of unit numbers
            for (const s of scans) {
                const p = s.barcodeId?.split("-");
                if (p && p[0] === "WO" && p.length >= 3) {
                    const key = `${p[1]}-${p[2]}`;
                    opUnits.add(key);
                    machineUnits.add(key);
                    if (!woBuckets[p[1]]) woBuckets[p[1]] = new Set();
                    woBuckets[p[1]].add(p[2]);
                }
            }

            // Map each WO to its product info
            const productMap = new Map(); // productKey → { name, image, variants, moNumber, moCustomer, unitsDone }
            for (const [shortId, units] of Object.entries(woBuckets)) {
                const wo = woShortMap.get(shortId);
                if (!wo) {
                    // Unknown WO — show minimal info
                    if (!productMap.has(shortId)) productMap.set(shortId, { name: `WO-${shortId}`, image: null, genderCategory: null, variantAttributes: [], moNumber: null, moCustomer: null, unitsDone: units.size, quantity: 0 });
                    continue;
                }
                const si = wo.stockItemId ? siMap.get(wo.stockItemId.toString()) : null;
                const mo = wo.customerRequestId ? moMap.get(wo.customerRequestId.toString()) : null;
                const image = resolveImage(si, wo.variantAttributes);
                const productKey = `${wo.stockItemId || shortId}_${(wo.variantAttributes || []).map(v => `${v.name}:${v.value}`).join("|")}`;
                if (!productMap.has(productKey)) {
                    productMap.set(productKey, {
                        productKey,
                        name: si?.name || wo.stockItemName || "Unknown Product",
                        image,
                        genderCategory: si?.genderCategory || null,
                        variantAttributes: wo.variantAttributes || [],
                        moNumber: mo ? `MO-${mo.requestId}` : null,
                        moCustomer: mo?.customerInfo?.name || null,
                        woNumber: wo.workOrderNumber,
                        woStatus: wo.status,
                        totalQuantity: wo.quantity || 0,
                        unitsDone: 0,
                    });
                }
                productMap.get(productKey).unitsDone += units.size;
            }

            const sessMs = isSignedIn
                ? Date.now() - new Date(op.signInTime).getTime()
                : (op.signOutTime ? new Date(op.signOutTime) - new Date(op.signInTime) : 0);

            const { status: attendanceStatus, breakInfo } = getAttendanceStatus(opId);

            return {
                identityId: opId,
                name,
                profilePhoto: empData?.profilePhoto || null,
                signInTime: op.signInTime,
                signOutTime: op.signOutTime || null,
                isSignedIn,
                isStale,
                uniquePieces: opUnits.size,
                sessionDurationMs: sessMs,
                products: Array.from(productMap.values()),
                attendanceStatus,
                breakInfo,
                attendance: attendanceMap.get(opId) || null,
            };
        });

        res.json({
            success: true, date: dateStr, machine: machineRef, operators,
            uniquePieces: machineUnits.size,
            attendanceLastSynced: attendanceDoc?.syncedAt || null,
            attendanceNote: !attendanceDoc ? "No attendance data for today yet — HR sync may be pending" : null,
        });
    } catch (err) {
        console.error("[CEO] /machine-detail:", err.message);
        res.status(500).json({ success: false, message: "Server error: " + err.message });
    }
});


module.exports = router;