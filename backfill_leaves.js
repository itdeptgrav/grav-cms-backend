
// Add leave balance according to attendance records automatically. Run this script once after deploying leave management to backfill data

const dns = require("dns").setServers(["8.8.8.8", "8.8.4.4"]);
require("dotenv").config();
const mongoose = require("mongoose");

// ── adjust this path to match where your models are ───────────────────────
const MONGO_URI = process.env.MONGO_URI || process.env.MONGODB_URI || process.env.DATABASE_URL;

if (!MONGO_URI) {
    console.error("❌  No MONGO_URI found. Set it in your .env or edit this script.");
    process.exit(1);
}

// ── model requires (side-effect registers all models) ─────────────────────
// adjust paths relative to THIS script's location
const DailyAttendance = require("./models/HR_Models/Dailyattendance");
const Employee = require("./models/Employee");
require("./models/HR_Models/LeaveManagement");

function getLeaveApplication() { return mongoose.model("LeaveApplication"); }
function getLeaveBalance() { return mongoose.model("LeaveBalance"); }
function getLeaveConfig() { return mongoose.model("LeaveConfig"); }

const LEAVE_STATUS_MAP = { "L-CL": "CL", "L-SL": "SL", "L-EL": "PL" };
const LEAVE_STATUSES = Object.keys(LEAVE_STATUS_MAP);

async function run() {
    console.log("⏳  Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log("✅  Connected.\n");

    let config;
    try { config = await getLeaveConfig().getConfig(); }
    catch (_) { config = { clPerYear: 5, slPerYear: 5, plPerYear: 18 }; }

    // ── load all attendance days that have any leave status ───────────────
    console.log("📂  Loading DailyAttendance records with leave status...");
    const dayDocs = await DailyAttendance.find({
        "employees.hrFinalStatus": { $in: LEAVE_STATUSES },
    }).lean();
    console.log(`   Found ${dayDocs.length} day documents.\n`);

    // ── employee lookup cache ─────────────────────────────────────────────
    const empCache = new Map();
    async function getEmpDoc(bid) {
        if (empCache.has(bid)) return empCache.get(bid);
        const doc = await Employee.findOne({
            $or: [
                { biometricId: bid },
                { "basicInfo.biometricId": bid },
                { "workInfo.biometricId": bid },
            ],
        }).lean();
        empCache.set(bid, doc || null);
        return doc;
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 1 — create missing LeaveApplications
    // ════════════════════════════════════════════════════════════════════════
    console.log("── PHASE 1: Creating missing LeaveApplications ──────────────");
    let appsCreated = 0, appsExisted = 0, appsSkipped = 0, appsErrors = 0;

    for (const dayDoc of dayDocs) {
        for (const emp of dayDoc.employees) {
            const leaveType = LEAVE_STATUS_MAP[emp.hrFinalStatus];
            if (!leaveType) continue;

            const bid = String(emp.biometricId || "").toUpperCase();
            const ds = dayDoc.dateStr;
            if (!bid) continue;

            // check for existing app on this exact date
            const existing = await getLeaveApplication().findOne({
                biometricId: bid,
                fromDate: ds,
                toDate: ds,
                leaveType,
                status: { $nin: ["cancelled", "rejected", "hr_rejected", "manager_rejected"] },
            });
            if (existing) { appsExisted++; continue; }

            const empDoc = await getEmpDoc(bid);
            if (!empDoc) { appsSkipped++; continue; } // ghost employee

            try {
                const empName = [empDoc.firstName, empDoc.middleName, empDoc.lastName]
                    .filter(Boolean).join(" ").trim()
                    || empDoc.fullName || empDoc.name || empDoc.basicInfo?.fullName || "Unknown";

                await getLeaveApplication().create({
                    employeeId: empDoc._id,
                    biometricId: bid,
                    employeeName: empName,
                    designation: empDoc.designation || empDoc.workInfo?.designation || "—",
                    department: empDoc.department || empDoc.workInfo?.department || "—",
                    leaveType,
                    applicationDate: ds,
                    fromDate: ds,
                    toDate: ds,
                    totalDays: 1,
                    reason: emp.hrRemarks || `HR override: ${emp.hrFinalStatus}`,
                    isHalfDay: false,
                    status: "hr_approved",
                    hrApprovedAt: emp.hrReviewedAt || new Date(),
                    hrRemarks: emp.hrRemarks || "Backfilled from attendance record",
                    appliedToAttendance: true,
                    appliedAt: emp.hrReviewedAt || new Date(),
                });
                appsCreated++;
                if (appsCreated % 50 === 0) console.log(`   ... ${appsCreated} apps created so far`);
            } catch (e) {
                appsErrors++;
                console.error(`   ❌  ${bid} ${ds}:`, e.message);
            }
        }
    }

    console.log(`   ✅  Apps created: ${appsCreated}  |  already existed: ${appsExisted}  |  ghost-skipped: ${appsSkipped}  |  errors: ${appsErrors}\n`);

    // ════════════════════════════════════════════════════════════════════════
    //  PHASE 2 — reconcile LeaveBalance.consumed from DailyAttendance
    //
    //  Count leave days directly from attendance records (ground truth).
    //  Do NOT rely on LeaveApplications — the source field may not be saved
    //  by Mongoose strict mode, making source-based queries unreliable.
    // ════════════════════════════════════════════════════════════════════════
    console.log("── PHASE 2: Reconciling LeaveBalance.consumed from attendance ─");

    // Map: `${empDbId}_${year}` → { empId, biometricId, year, CL, SL, PL }
    const attendanceCounts = new Map();

    for (const dayDoc of dayDocs) {
        const year = parseInt(dayDoc.dateStr.split("-")[0], 10);
        for (const emp of dayDoc.employees) {
            const leaveType = LEAVE_STATUS_MAP[emp.hrFinalStatus];
            if (!leaveType) continue;

            let empDbId = emp.employeeDbId ? String(emp.employeeDbId) : null;
            if (!empDbId) {
                const bid = String(emp.biometricId || "").toUpperCase();
                const empDoc = await getEmpDoc(bid);
                if (!empDoc) continue;
                empDbId = String(empDoc._id);
            }

            const bid = String(emp.biometricId || "").toUpperCase();
            const key = `${empDbId}_${year}`;
            if (!attendanceCounts.has(key)) {
                attendanceCounts.set(key, { empId: empDbId, biometricId: bid, year, CL: 0, SL: 0, PL: 0 });
            }
            attendanceCounts.get(key)[leaveType]++;
        }
    }

    console.log(`   Found ${attendanceCounts.size} unique (employee, year) pairs.\n`);

    let balFixed = 0, balCreated = 0, balOk = 0, balErrors = 0;

    for (const [, expected] of attendanceCounts) {
        try {
            let bal = await getLeaveBalance().findOne({
                employeeId: expected.empId,
                year: expected.year,
            });

            if (!bal) {
                await getLeaveBalance().create({
                    employeeId: expected.empId,
                    biometricId: expected.biometricId,
                    year: expected.year,
                    entitlement: {
                        CL: config.clPerYear || 5,
                        SL: config.slPerYear || 5,
                        PL: config.plPerYear || 18,
                    },
                    consumed: { CL: expected.CL, SL: expected.SL, PL: expected.PL },
                });
                balCreated++;
                console.log(`   ✨  Created balance for ${expected.biometricId} ${expected.year}: CL=${expected.CL} SL=${expected.SL} PL=${expected.PL}`);
                continue;
            }

            // set consumed = max(current, attendance-derived) per type
            let changed = false;
            const before = { CL: bal.consumed.CL, SL: bal.consumed.SL, PL: bal.consumed.PL };
            for (const type of ["CL", "SL", "PL"]) {
                const curr = bal.consumed[type] || 0;
                const exp = expected[type] || 0;
                if (curr < exp) { bal.consumed[type] = exp; changed = true; }
            }

            if (changed) {
                bal.markModified("consumed");
                await bal.save();
                balFixed++;
                console.log(`   🔧  Fixed ${expected.biometricId} ${expected.year}: CL ${before.CL}→${bal.consumed.CL}  SL ${before.SL}→${bal.consumed.SL}  PL ${before.PL}→${bal.consumed.PL}`);
            } else {
                balOk++;
            }
        } catch (e) {
            balErrors++;
            console.error(`   ❌  Balance error ${expected.empId} ${expected.year}:`, e.message);
        }
    }

    console.log(`\n   ✅  Balances fixed: ${balFixed}  |  created fresh: ${balCreated}  |  already correct: ${balOk}  |  errors: ${balErrors}`);

    console.log("\n🎉  Backfill complete!");
    await mongoose.disconnect();
}

run().catch(e => {
    console.error("💥  Fatal error:", e);
    process.exit(1);
});
