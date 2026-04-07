"use strict";

const axios = require("axios");

const BASE_URL = (process.env.TEAMOFFICE_BASE_URL || "https://api.etimeoffice.com/api").replace(/\/+$/, "");
const CORP_ID = process.env.TEAMOFFICE_CORP_ID || "gravc";
const USERNAME = process.env.TEAMOFFICE_USERNAME || "grav";
const PASSWORD = process.env.TEAMOFFICE_PASSWORD || "grav@2025";

const AUTH_USERNAME = `${CORP_ID}:${USERNAME}`;  // "gravc:grav"
const AUTH_PASSWORD = `${PASSWORD}:true`;         // "grav@2025:true"

let syncStatus = { lastSync: null, status: "idle", message: "" };

function formatDateForAPI(isoDate, isEndOfDay = false) {
    const [year, month, day] = isoDate.split("-");
    const time = isEndOfDay ? "23:59" : "00:00";
    return `${day}/${month}/${year}_${time}`;
}

async function fetchPunchDetailData(fromDate, toDate, empCode = "ALL") {
    const from = formatDateForAPI(fromDate, false);
    const to = formatDateForAPI(toDate, true);
    
    const url = `${BASE_URL}/DownloadPunchData?Empcode=${empCode}&FromDate=${from}&ToDate=${to}`;
    
    console.log(`📡 Fetching: ${url}`);
    
    const response = await axios.get(url, {
        auth: { username: AUTH_USERNAME, password: AUTH_PASSWORD },
        headers: { 'User-Agent': 'PostmanRuntime/7.42.0', 'Accept': '*/*' },
        timeout: 30000,
    });
    
    return response.data;
}

async function syncDateRange(fromDate, toDate, empCode = "ALL", deps) {
    syncStatus = { lastSync: new Date(), status: "running", message: `Syncing ${fromDate} to ${toDate}` };
    
    try {
        const engine = require("./Attendanceengine");
        
        // Fetch punch data from API
        const data = await fetchPunchDetailData(fromDate, toDate, empCode);
        
        if (data.Error === true) {
            throw new Error(data.Msg || "API returned error");
        }
        
        const punchData = data.PunchData || [];
        console.log(`✅ Fetched ${punchData.length} punch records`);
        
        // Parse punch data into map
        const punchMap = engine.parsePunchDataResponse(data);
        console.log(`📊 Parsed into ${Object.keys(punchMap).length} employee-days`);
        
        // Get all unique empcodes from punch data
        const uniqueEmpcodes = [...new Set(punchData.map(p => p.Empcode || p.empcode).filter(Boolean))];
        console.log(`👥 Unique employee codes: ${uniqueEmpcodes.length}`);
        
        // Extract name map for employee matching
        const nameMap = engine.extractNameMap(data);
        
        // Build employee map (matches device codes to employee records)
        const employeeMap = await engine.buildEmployeeMap(deps.Employee, uniqueEmpcodes, nameMap);
        console.log(`🔗 Matched ${Object.keys(employeeMap).length} employees`);
        
        // Get settings
        const settings = await deps.AttendanceSettings.getSingleton();
        const holidays = settings.holidays || [];
        
        // Process each day's punches
        let created = 0, updated = 0;
        
        for (const [key, punchDetail] of Object.entries(punchMap)) {
            const { biometricId, dateStr, name, punches } = punchDetail;
            
            // Skip if no punches
            if (!punches || punches.length === 0) continue;
            
            // Find employee match
            const numericId = engine.normalizeId(biometricId);
            const empDoc = employeeMap[numericId];
            
            if (!empDoc) {
                console.warn(`⚠️ No employee match for biometricId: ${biometricId} (${name})`);
                continue;
            }
            
            // Build inOutRec structure for the record factory
            const inOutRec = {
                biometricId: empDoc.biometricId,
                dateStr,
                name: empDoc.name,
                inTime: null,
                finalOut: null,
                etimeRemark: "",
                etimeStatus: "",
            };
            
            // Build attendance record
            const record = engine.buildAttendanceRecord(inOutRec, punchDetail, empDoc, settings, holidays);
            
            // Check if record already exists
            const existing = await deps.DailyAttendance.findOne({
                biometricId: record.biometricId,
                dateStr: record.dateStr,
            });
            
            if (existing) {
                // Update existing record
                Object.assign(existing, {
                    rawPunches: record.rawPunches,
                    punchCount: record.punchCount,
                    inTime: record.inTime,
                    lunchOut: record.lunchOut,
                    lunchIn: record.lunchIn,
                    teaOut: record.teaOut,
                    teaIn: record.teaIn,
                    finalOut: record.finalOut,
                    totalSpanMins: record.totalSpanMins,
                    lunchBreakMins: record.lunchBreakMins,
                    teaBreakMins: record.teaBreakMins,
                    totalBreakMins: record.totalBreakMins,
                    netWorkMins: record.netWorkMins,
                    otMins: record.otMins,
                    lateMins: record.lateMins,
                    earlyDepartureMins: record.earlyDepartureMins,
                    isLate: record.isLate,
                    isEarlyDeparture: record.isEarlyDeparture,
                    hasOT: record.hasOT,
                    hasMissPunch: record.hasMissPunch,
                    systemPrediction: record.systemPrediction,
                    syncedAt: new Date(),
                    syncSource: "api",
                });
                await existing.save();
                updated++;
            } else {
                // Create new record
                await deps.DailyAttendance.create(record);
                created++;
            }
        }
        
        // Fill missing days for employees who have no punches
        const allDates = getDatesInRange(fromDate, toDate);
        const allBiometricIds = Object.keys(employeeMap);
        
        for (const numericIdStr of allBiometricIds) {
            const numericId = parseInt(numericIdStr, 10);
            const empDoc = employeeMap[numericId];
            
            for (const dateStr of allDates) {
                const existing = await deps.DailyAttendance.findOne({
                    biometricId: empDoc.biometricId,
                    dateStr,
                });
                
                if (!existing) {
                    const placeholder = engine.buildPlaceholderRecord(empDoc.biometricId, empDoc, dateStr, settings, holidays);
                    await deps.DailyAttendance.create(placeholder);
                }
            }
        }
        
        console.log(`✅ Sync complete: ${created} created, ${updated} updated`);
        
        syncStatus = { 
            lastSync: new Date(), 
            status: "success", 
            message: `Synced ${created + updated} records (${created} new, ${updated} updated)` 
        };
        
        return { success: true, created, updated, total: created + updated };
        
    } catch (err) {
        console.error("❌ Sync failed:", err.message);
        syncStatus = { lastSync: new Date(), status: "error", message: err.message };
        throw err;
    }
}

// Helper: Get all dates between fromDate and toDate
function getDatesInRange(fromDate, toDate) {
    const dates = [];
    const start = new Date(fromDate + "T00:00:00Z");
    const end = new Date(toDate + "T00:00:00Z");
    
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().split("T")[0]);
    }
    return dates;
}

function getStatus() {
    return syncStatus;
}

// ============================================================
// NORMALIZATION FUNCTIONS
// ============================================================

function normalizeName(name) {
    if (!name) return "";
    return name.toLowerCase().replace(/[^a-z]/g, "").trim();
}

function nameSimilarity(a, b) {
    if (!a || !b) return 0;
    const na = normalizeName(a);
    const nb = normalizeName(b);
    if (na === nb) return 1.0;
    if (na.includes(nb) || nb.includes(na)) return 0.9;
    let matches = 0;
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    for (let i = 0; i < shorter.length; i++) {
        if (longer.includes(shorter[i])) matches++;
    }
    return matches / longer.length;
}

// ============================================================
// EMPLOYEE LINKING FUNCTIONS
// ============================================================

async function autoLinkEmployees(Employee, apiPunchData) {
    const employees = await Employee.find({ status: "active" }).lean();
    const apiNames = {};
    for (const punch of apiPunchData) {
        const code = punch.Empcode || punch.empcode;
        const name = punch.Name || punch.name;
        if (code && name && !apiNames[code]) {
            apiNames[code] = name;
        }
    }
    const results = { linked: [], unlinked: [], conflicts: [], alreadyLinked: [] };
    const usedEmpcodes = new Set();
    for (const emp of employees) {
        const empName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name || "";
        const currentBioId = emp.workInfo?.biometricId || "";
        if (currentBioId && /^\d{1,6}$/.test(currentBioId.trim())) {
            results.alreadyLinked.push({
                employeeId: emp._id,
                name: empName,
                identityId: emp.workInfo?.identityId || "",
                biometricId: currentBioId,
            });
            usedEmpcodes.add(currentBioId);
            continue;
        }
        let bestMatch = null;
        let bestScore = 0;
        for (const [empcode, apiName] of Object.entries(apiNames)) {
            if (usedEmpcodes.has(empcode)) continue;
            const score = nameSimilarity(empName, apiName);
            if (score > bestScore && score >= 0.7) {
                bestMatch = { empcode, apiName, score };
                bestScore = score;
            }
        }
        if (bestMatch) {
            if (bestScore >= 0.85) {
                results.linked.push({
                    employeeId: emp._id,
                    name: empName,
                    identityId: emp.workInfo?.identityId || currentBioId,
                    matchedEmpcode: bestMatch.empcode,
                    matchedName: bestMatch.apiName,
                    confidence: bestMatch.score,
                });
                usedEmpcodes.add(bestMatch.empcode);
            } else {
                results.conflicts.push({
                    employeeId: emp._id,
                    name: empName,
                    identityId: emp.workInfo?.identityId || currentBioId,
                    suggestedEmpcode: bestMatch.empcode,
                    suggestedName: bestMatch.apiName,
                    confidence: bestMatch.score,
                });
            }
        } else {
            results.unlinked.push({
                employeeId: emp._id,
                name: empName,
                identityId: emp.workInfo?.identityId || currentBioId,
            });
        }
    }
    return results;
}

async function applyLinks(Employee, linkedResults) {
    let updated = 0;
    for (const link of linkedResults) {
        const emp = await Employee.findById(link.employeeId);
        if (!emp) continue;
        const currentBioId = emp.workInfo?.biometricId || "";
        const currentIdentityId = emp.workInfo?.identityId || "";
        if (/[a-zA-Z]/.test(currentBioId) && !currentIdentityId) {
            emp.workInfo = emp.workInfo || {};
            emp.workInfo.identityId = currentBioId;
        }
        emp.workInfo = emp.workInfo || {};
        emp.workInfo.biometricId = link.matchedEmpcode;
        await emp.save();
        updated++;
    }
    return { updated };
}

async function buildEmployeeMap(EmployeeModel, rawCodes = [], punchNameMap = {}) {
    const employees = await EmployeeModel.find({
        $or: [
            { "workInfo.biometricId": { $exists: true, $ne: null, $ne: "" } },
            { biometricId: { $exists: true, $ne: null, $ne: "" } },
        ]
    }).lean();
    
    const map = {};
    const byNumericId = {};
    
    for (const emp of employees) {
        const bioId = (emp.workInfo?.biometricId || emp.biometricId || "").trim();
        if (!bioId) continue;
        
        const numericId = parseInt(bioId.replace(/\D/g, ""), 10);
        if (!isNaN(numericId)) {
            byNumericId[numericId] = emp;
        }
    }
    
    for (const rawCode of rawCodes) {
        const numericId = parseInt(rawCode.replace(/\D/g, ""), 10);
        if (isNaN(numericId)) continue;
        
        const emp = byNumericId[numericId];
        if (emp) {
            const empName = `${emp.firstName || ""} ${emp.lastName || ""}`.trim() || emp.name || "Unknown";
            const dept = (emp.department || emp.workInfo?.department || "").toLowerCase();
            const prodDepts = ["production", "manufacturing", "factory", "cutting", "sewing", "finishing", "packing"];
            const explicitType = (emp.workInfo?.employeeType || emp.employeeType || "").toLowerCase();
            const employeeType = explicitType === "operator" || explicitType === "executive"
                ? explicitType
                : prodDepts.some(d => dept.includes(d)) ? "operator" : "executive";
            
            map[numericId] = {
                _id: emp._id,
                name: empName,
                biometricId: rawCode.padStart(4, "0"),
                numericId,
                identityId: emp.workInfo?.identityId || bioId,
                department: emp.department || emp.workInfo?.department || "—",
                designation: emp.workInfo?.jobTitle || emp.designation || "—",
                employeeType,
                shiftCode: emp.workInfo?.shiftCode || null,
            };
        }
    }
    
    return map;
}

async function cleanupDuplicates(DailyAttendance, Employee) {
    const grRecords = await DailyAttendance.find({ biometricId: /[a-zA-Z]/ }).lean();
    if (!grRecords.length) return { removed: 0, message: "No GR-code ghost records found" };
    const idsToRemove = [];
    for (const rec of grRecords) {
        if (rec.punchCount === 0 && !rec.hrFinalStatus) {
            idsToRemove.push(rec._id);
        }
    }
    if (idsToRemove.length) {
        const result = await DailyAttendance.deleteMany({ _id: { $in: idsToRemove } });
        return { removed: result.deletedCount, totalGrRecords: grRecords.length, message: `Removed ${result.deletedCount} ghost GR-code records` };
    }
    return { removed: 0, totalGrRecords: grRecords.length, message: "No ghost records to remove" };
}

function registerLinkRoutes(router, Employee, DailyAttendance, EmployeeAuthMiddlewear, syncService, deps) {
    router.post("/link-employees", EmployeeAuthMiddlewear, async (req, res) => {
        try {
            const today = new Date().toISOString().split("T")[0];
            const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split("T")[0];
            const punchData = await syncService.fetchPunchDetailData(weekAgo, today, "ALL");
            const rows = punchData?.PunchData || [];
            if (!rows.length) {
                return res.status(400).json({ success: false, message: "No punch data from biometric API." });
            }
            const results = await autoLinkEmployees(Employee, rows);
            if (req.body.autoApply !== false) {
                const applied = await applyLinks(Employee, results.linked);
                results.applied = applied;
            }
            res.json({ success: true, message: `Linked ${results.linked.length} employees`, data: results });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
    
    router.get("/unlinked", EmployeeAuthMiddlewear, async (req, res) => {
        try {
            const employees = await Employee.find({ status: "active" }).lean();
            const unlinked = employees.filter(emp => {
                const bioId = (emp.workInfo?.biometricId || "").trim();
                return !bioId || /[a-zA-Z]/.test(bioId);
            }).map(emp => ({
                _id: emp._id,
                name: `${emp.firstName || ""} ${emp.lastName || ""}`.trim(),
                identityId: emp.workInfo?.identityId || emp.workInfo?.biometricId || "",
                department: emp.department || emp.workInfo?.department || "",
                biometricId: emp.workInfo?.biometricId || "",
            }));
            res.json({ success: true, data: unlinked, count: unlinked.length });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
    
    router.put("/link-employee/:id", EmployeeAuthMiddlewear, async (req, res) => {
        try {
            const { biometricDeviceCode } = req.body;
            if (!biometricDeviceCode) return res.status(400).json({ success: false, message: "biometricDeviceCode required" });
            const emp = await Employee.findById(req.params.id);
            if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });
            const currentBioId = emp.workInfo?.biometricId || "";
            if (/[a-zA-Z]/.test(currentBioId)) {
                emp.workInfo.identityId = emp.workInfo.identityId || currentBioId;
            }
            emp.workInfo.biometricId = biometricDeviceCode.padStart(4, "0");
            await emp.save();
            res.json({ success: true, message: `Linked to biometric code ${emp.workInfo.biometricId}` });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
    
    router.post("/cleanup-duplicates", EmployeeAuthMiddlewear, async (req, res) => {
        try {
            const result = await cleanupDuplicates(DailyAttendance, Employee);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, message: err.message });
        }
    });
}

module.exports = {
    syncDateRange,
    getStatus,
    fetchPunchDetailData,
    normalizeName,
    nameSimilarity,
    autoLinkEmployees,
    applyLinks,
    buildEmployeeMap,
    cleanupDuplicates,
    registerLinkRoutes,
};