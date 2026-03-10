const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Attendance = require("../../models/HR_Models/Attendance");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");

// ─── Helpers ─────────────────────────────────────────────────────────────────
function toDateString(d) {
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
}

function formatTime(date) {
    if (!date) return null;
    return new Date(date).toLocaleTimeString("en-IN", {
        hour: "2-digit", minute: "2-digit", hour12: true,
    });
}

function minsToHHMM(mins) {
    if (!mins || mins <= 0) return "0h 0m";
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. GET /summary  →  Dashboard stat cards for today
// ─────────────────────────────────────────────────────────────────────────────
router.get("/summary", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { date = toDateString(new Date()) } = req.query;

        const todayRecords = await Attendance.find({ dateString: date }).lean();
        const totalEmployees = await Employee.countDocuments({ isActive: true });

        // Yesterday for comparison
        const yesterday = new Date(date);
        yesterday.setDate(yesterday.getDate() - 1);
        const yesterdayStr = toDateString(yesterday);
        const yesterdayRecs = await Attendance.find({ dateString: yesterdayStr }).lean();

        const count = (arr, statuses) =>
            arr.filter((r) => statuses.includes(r.status)).length;

        const present = count(todayRecords, ["present", "late", "work_from_home", "early_departure"]);
        const absent = totalEmployees - present;
        const late = count(todayRecords, ["late"]);
        const onLeave = count(todayRecords, ["on_leave"]);
        const wfh = count(todayRecords, ["work_from_home"]);
        const halfDay = count(todayRecords, ["half_day"]);
        const overtime = todayRecords.filter((r) => r.hasOvertime).length;
        const avgWorkMin = present > 0
            ? Math.round(todayRecords.filter((r) => r.workingMinutes > 0).reduce((s, r) => s + r.workingMinutes, 0) / present)
            : 0;

        const yPresent = count(yesterdayRecs, ["present", "late", "work_from_home", "early_departure"]);

        res.json({
            success: true,
            data: {
                date,
                totalEmployees,
                present,
                absent,
                late,
                onLeave,
                wfh,
                halfDay,
                overtime,
                avgWorkingTime: minsToHHMM(avgWorkMin),
                attendanceRate: totalEmployees > 0 ? Math.round((present / totalEmployees) * 100) : 0,
                changeVsYesterday: present - yPresent,
            },
        });
    } catch (err) {
        console.error("Attendance summary error:", err);
        res.status(500).json({ success: false, message: "Error fetching summary" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. GET /today  →  Full attendance list for a specific date (main table)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/today", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const {
            date = toDateString(new Date()),
            department,
            status,
            search,
            page = 1,
            limit = 50,
        } = req.query;

        // Build filter
        const filter = { dateString: date };
        if (department && department !== "All") filter.department = department;
        if (status && status !== "All") filter.status = status;
        if (search) {
            filter.$or = [
                { employeeName: { $regex: search, $options: "i" } },
                { biometricId: { $regex: search, $options: "i" } },
                { department: { $regex: search, $options: "i" } },
            ];
        }

        const total = await Attendance.countDocuments(filter);
        const records = await Attendance
            .find(filter)
            .populate("employeeId", "profilePhoto email phone")
            .sort({ employeeName: 1 })
            .skip((+page - 1) * +limit)
            .limit(+limit)
            .lean();

        // Also return employees with NO record today (absent but not yet logged)
        let absentEmployees = [];
        if (!status || status === "All" || status === "absent") {
            const presentIds = records.map((r) => r.employeeId?._id?.toString() || r.employeeId?.toString());
            const empFilter = { isActive: true, status: "active" };
            if (department && department !== "All") empFilter.department = department;
            const allEmployees = await Employee.find(empFilter)
                .select("firstName lastName biometricId department designation profilePhoto")
                .lean();
            absentEmployees = allEmployees
                .filter((e) => !presentIds.includes(e._id.toString()))
                .map((e) => ({
                    _id: null,
                    employeeId: e,
                    employeeName: `${e.firstName} ${e.lastName}`,
                    biometricId: e.biometricId,
                    department: e.department,
                    designation: e.designation,
                    dateString: date,
                    status: "absent",
                    checkInTime: null,
                    checkOutTime: null,
                    workingMinutes: 0,
                    isLate: false,
                    hasOvertime: false,
                }));
        }

        res.json({
            success: true,
            data: [...records, ...absentEmployees],
            pagination: { total: total + absentEmployees.length, page: +page, limit: +limit, totalPages: Math.ceil((total + absentEmployees.length) / +limit) },
        });
    } catch (err) {
        console.error("Attendance today error:", err);
        res.status(500).json({ success: false, message: "Error fetching attendance" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. GET /employee/:employeeId  →  Monthly detail for one employee (timeline view)
// ─────────────────────────────────────────────────────────────────────────────
router.get("/employee/:employeeId", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
        const canAccess = req.user.role === "hr_manager" || req.user.id === req.params.employeeId;
        if (!canAccess) return res.status(403).json({ success: false, message: "Access denied" });

        const startDate = `${year}-${String(+month).padStart(2, "0")}-01`;
        const endDate = `${year}-${String(+month).padStart(2, "0")}-31`;

        const records = await Attendance
            .find({
                employeeId: req.params.employeeId,
                dateString: { $gte: startDate, $lte: endDate },
            })
            .sort({ dateString: -1 })
            .lean();

        const emp = await Employee.findById(req.params.employeeId)
            .select("firstName lastName biometricId department designation profilePhoto salary bankDetails dateOfJoining")
            .lean();

        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        // Monthly stats
        const present = records.filter((r) => ["present", "late", "work_from_home", "early_departure"].includes(r.status)).length;
        const absent = records.filter((r) => r.status === "absent").length;
        const late = records.filter((r) => r.status === "late" || r.isLate).length;
        const onLeave = records.filter((r) => r.status === "on_leave").length;
        const totalOT = records.reduce((s, r) => s + (r.overtimeMinutes || 0), 0);
        const avgWork = present > 0
            ? Math.round(records.filter((r) => r.workingMinutes > 0).reduce((s, r) => s + r.workingMinutes, 0) / present)
            : 0;

        res.json({
            success: true,
            data: {
                employee: emp,
                records,
                stats: { present, absent, late, onLeave, totalOvertimeHours: Math.round(totalOT / 60 * 10) / 10, avgWorkingTime: minsToHHMM(avgWork) },
                month: +month,
                year: +year,
            },
        });
    } catch (err) {
        console.error("Employee attendance error:", err);
        res.status(500).json({ success: false, message: "Error fetching employee attendance" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. POST /check-in  →  Employee or HR marks check-in
// ─────────────────────────────────────────────────────────────────────────────
router.post("/check-in", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { employeeId, date, checkInTime, notes, location, isManualEntry = false } = req.body;
        const targetEmpId = employeeId || req.user.id;
        const dateStr = date ? toDateString(date) : toDateString(new Date());
        const checkInDate = date ? new Date(`${dateStr}T${checkInTime || "09:00"}:00`) : new Date();

        const emp = await Employee.findById(targetEmpId).select("firstName lastName biometricId department designation").lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        // Upsert
        const existing = await Attendance.findOne({ employeeId: targetEmpId, dateString: dateStr });
        if (existing && existing.checkIn) {
            return res.status(400).json({ success: false, message: "Check-in already recorded for today" });
        }

        const record = existing || new Attendance({
            employeeId: targetEmpId,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            biometricId: emp.biometricId,
            department: emp.department,
            designation: emp.designation,
            date: new Date(dateStr),
            dateString: dateStr,
        });

        record.checkIn = checkInDate;
        record.checkInTime = formatTime(checkInDate);
        record.status = "present";
        record.notes = notes;
        record.checkInLocation = location;
        record.isManualEntry = isManualEntry;
        record.markedBy = req.user.id;
        await record.save();

        res.status(201).json({ success: true, message: "Check-in recorded", data: record });
    } catch (err) {
        console.error("Check-in error:", err);
        res.status(500).json({ success: false, message: "Error recording check-in" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. PATCH /check-out  →  Record check-out
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/check-out", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { employeeId, date, checkOutTime, notes, location } = req.body;
        const targetEmpId = employeeId || req.user.id;
        const dateStr = date ? toDateString(date) : toDateString(new Date());
        const checkOutDate = date ? new Date(`${dateStr}T${checkOutTime || "18:00"}:00`) : new Date();

        const record = await Attendance.findOne({ employeeId: targetEmpId, dateString: dateStr });
        if (!record) return res.status(404).json({ success: false, message: "No check-in found for today" });
        if (record.checkOut) return res.status(400).json({ success: false, message: "Check-out already recorded" });

        record.checkOut = checkOutDate;
        record.checkOutTime = formatTime(checkOutDate);
        record.checkOutLocation = location;
        if (notes) record.notes = notes;
        record.updatedBy = req.user.id;
        await record.save();

        res.json({ success: true, message: "Check-out recorded", data: record });
    } catch (err) {
        console.error("Check-out error:", err);
        res.status(500).json({ success: false, message: "Error recording check-out" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. POST /manual  →  HR manually creates/overrides attendance for any employee
// ─────────────────────────────────────────────────────────────────────────────
router.post("/manual", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR managers can create manual attendance" });
        }

        const { employeeId, date, checkInTime, checkOutTime, status, notes, remarks, breakMinutes = 0 } = req.body;
        if (!employeeId || !date) {
            return res.status(400).json({ success: false, message: "employeeId and date are required" });
        }

        const dateStr = toDateString(date);
        const emp = await Employee.findById(employeeId).select("firstName lastName biometricId department designation").lean();
        if (!emp) return res.status(404).json({ success: false, message: "Employee not found" });

        const checkInDate = checkInTime ? new Date(`${dateStr}T${checkInTime}:00`) : null;
        const checkOutDate = checkOutTime ? new Date(`${dateStr}T${checkOutTime}:00`) : null;

        const data = {
            employeeId,
            employeeName: `${emp.firstName} ${emp.lastName}`,
            biometricId: emp.biometricId,
            department: emp.department,
            designation: emp.designation,
            date: new Date(dateStr),
            dateString: dateStr,
            checkIn: checkInDate,
            checkInTime: checkInDate ? formatTime(checkInDate) : null,
            checkOut: checkOutDate,
            checkOutTime: checkOutDate ? formatTime(checkOutDate) : null,
            status: status || "present",
            notes,
            remarks,
            breakMinutes,
            isManualEntry: true,
            markedBy: user.id,
            updatedBy: user.id,
        };

        const record = await Attendance.findOneAndUpdate(
            { employeeId, dateString: dateStr },
            data,
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await record.save(); // trigger pre-save for calculations

        res.status(201).json({ success: true, message: "Attendance recorded manually", data: record });
    } catch (err) {
        console.error("Manual attendance error:", err);
        if (err.code === 11000) return res.status(400).json({ success: false, message: "Attendance record already exists for this date" });
        res.status(500).json({ success: false, message: "Error creating manual attendance" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. PUT /:id  →  Edit an attendance record
// ─────────────────────────────────────────────────────────────────────────────
router.put("/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR can edit attendance" });
        }

        const allowed = ["checkIn", "checkOut", "checkInTime", "checkOutTime", "status", "notes", "remarks", "breakMinutes", "isLate", "hasOvertime"];
        const update = { updatedBy: user.id };
        allowed.forEach((f) => { if (req.body[f] !== undefined) update[f] = req.body[f]; });

        // Re-derive checkInTime / checkOutTime from Date objects if provided
        if (update.checkIn) update.checkInTime = formatTime(update.checkIn);
        if (update.checkOut) update.checkOutTime = formatTime(update.checkOut);

        const record = await Attendance.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });
        await record.save(); // trigger pre-save calculations

        res.json({ success: true, message: "Attendance updated", data: record });
    } catch (err) {
        console.error("Edit attendance error:", err);
        res.status(500).json({ success: false, message: "Error editing attendance" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. DELETE /:id  →  Delete an attendance record
// ─────────────────────────────────────────────────────────────────────────────
router.delete("/:id", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        if (req.user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR can delete attendance records" });
        }
        const record = await Attendance.findByIdAndDelete(req.params.id);
        if (!record) return res.status(404).json({ success: false, message: "Record not found" });
        res.json({ success: true, message: "Attendance record deleted" });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error deleting record" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. GET /monthly-report  →  Aggregated stats per dept for a whole month
// ─────────────────────────────────────────────────────────────────────────────
router.get("/monthly-report", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
        const startDate = `${year}-${String(+month).padStart(2, "0")}-01`;
        const endDate = `${year}-${String(+month).padStart(2, "0")}-31`;

        const report = await Attendance.aggregate([
            { $match: { dateString: { $gte: startDate, $lte: endDate } } },
            {
                $group: {
                    _id: "$department",
                    totalPresent: { $sum: { $cond: [{ $in: ["$status", ["present", "late", "work_from_home", "early_departure"]] }, 1, 0] } },
                    totalAbsent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
                    totalLate: { $sum: { $cond: [{ $eq: ["$isLate", true] }, 1, 0] } },
                    totalLeave: { $sum: { $cond: [{ $eq: ["$status", "on_leave"] }, 1, 0] } },
                    totalOvertimeMins: { $sum: "$overtimeMinutes" },
                    avgWorkingMins: { $avg: "$workingMinutes" },
                    recordCount: { $sum: 1 },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        // Weekly trend (count present per day-of-week)
        const weeklyTrend = await Attendance.aggregate([
            { $match: { dateString: { $gte: startDate, $lte: endDate }, status: { $in: ["present", "late", "work_from_home"] } } },
            { $group: { _id: { $dayOfWeek: "$date" }, count: { $sum: 1 } } },
            { $sort: { "_id": 1 } },
        ]);

        res.json({ success: true, data: { departments: report, weeklyTrend, month: +month, year: +year } });
    } catch (err) {
        console.error("Monthly report error:", err);
        res.status(500).json({ success: false, message: "Error generating report" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. GET /trend  →  30-day daily attendance trend for charts
// ─────────────────────────────────────────────────────────────────────────────
router.get("/trend", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const from = new Date();
        from.setDate(from.getDate() - +days);
        const fromStr = toDateString(from);
        const toStr = toDateString(new Date());

        const trend = await Attendance.aggregate([
            { $match: { dateString: { $gte: fromStr, $lte: toStr } } },
            {
                $group: {
                    _id: "$dateString",
                    present: { $sum: { $cond: [{ $in: ["$status", ["present", "late", "work_from_home", "early_departure"]] }, 1, 0] } },
                    absent: { $sum: { $cond: [{ $eq: ["$status", "absent"] }, 1, 0] } },
                    late: { $sum: { $cond: [{ $eq: ["$status", "late"] }, 1, 0] } },
                    leave: { $sum: { $cond: [{ $eq: ["$status", "on_leave"] }, 1, 0] } },
                },
            },
            { $sort: { _id: 1 } },
        ]);

        res.json({ success: true, data: trend });
    } catch (err) {
        res.status(500).json({ success: false, message: "Error fetching trend" });
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// 11. POST /bulk-mark  →  HR marks multiple employees as absent/on_leave/holiday
// ─────────────────────────────────────────────────────────────────────────────
router.post("/bulk-mark", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { user } = req;
        if (user.role !== "hr_manager") {
            return res.status(403).json({ success: false, message: "Only HR can bulk-mark attendance" });
        }

        const { employeeIds, date, status, notes } = req.body;
        if (!employeeIds?.length || !date || !status) {
            return res.status(400).json({ success: false, message: "employeeIds, date and status are required" });
        }

        const dateStr = toDateString(date);
        const employees = await Employee.find({ _id: { $in: employeeIds } })
            .select("firstName lastName biometricId department designation")
            .lean();

        let created = 0;
        for (const emp of employees) {
            await Attendance.findOneAndUpdate(
                { employeeId: emp._id, dateString: dateStr },
                {
                    employeeId: emp._id,
                    employeeName: `${emp.firstName} ${emp.lastName}`,
                    biometricId: emp.biometricId,
                    department: emp.department,
                    designation: emp.designation,
                    date: new Date(dateStr),
                    dateString: dateStr,
                    status,
                    notes,
                    isManualEntry: true,
                    markedBy: user.id,
                },
                { upsert: true, new: true }
            );
            created++;
        }

        res.json({ success: true, message: `${created} records updated`, data: { updated: created } });
    } catch (err) {
        console.error("Bulk mark error:", err);
        res.status(500).json({ success: false, message: "Error bulk marking attendance" });
    }
});

module.exports = router;