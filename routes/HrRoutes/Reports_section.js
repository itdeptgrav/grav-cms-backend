"use strict";
const express = require("express");
const router = express.Router();
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");

const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
const AttendanceSettings = require("../../models/HR_Models/Attendancesettings");
const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const { CompanyHoliday } = require("../../models/HR_Models/LeaveManagement");

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED HELPERS (mirrored from Attendance_section — kept local for isolation)
// ═══════════════════════════════════════════════════════════════════════════

const dateStrOf = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const hhmmMins = (s) => {
    const [h, m] = String(s || "00:00").split(":").map(Number);
    return (h || 0) * 60 + (m || 0);
};

const minsOf = (d) => (d ? d.getHours() * 60 + d.getMinutes() : null);

const fmtTime = (d) => {
    if (!d) return "--:--";
    const dt = new Date(d);
    return `${String(dt.getHours()).padStart(2, "0")}:${String(dt.getMinutes()).padStart(2, "0")}`;
};

const fmtHM = (m) => {
    if (!m || m <= 0) return "00:00";
    const h = Math.floor(m / 60), mm = m % 60;
    return `${String(h).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
};

const extractName = (e) => {
    const candidates = [
        e?.fullName, e?.name,
        e?.basicInfo?.fullName, e?.basicInfo?.name,
        e?.personalInfo?.fullName, e?.personalInfo?.name,
        [e?.firstName, e?.middleName, e?.lastName].filter(Boolean).join(" ").trim(),
        [e?.basicInfo?.firstName, e?.basicInfo?.middleName, e?.basicInfo?.lastName].filter(Boolean).join(" ").trim(),
    ];
    for (const c of candidates) if (c && String(c).trim()) return String(c).trim();
    return "";
};
const extractIdentity = (e) => e?.empCode || e?.employeeCode || e?.basicInfo?.empCode || e?.workInfo?.empCode || e?.code || "";
const extractDepartment = (e) => e?.department || e?.workInfo?.department || e?.basicInfo?.department || "—";
const extractDesignation = (e) => e?.designation || e?.workInfo?.designation || e?.basicInfo?.designation || "—";
const extractBiometricId = (e) => e?.biometricId || e?.basicInfo?.biometricId || e?.workInfo?.biometricId || "";

function holidayTypeToStatus(type) {
    switch (type) {
        case "national": return "NH";
        case "optional": return "OH";
        case "company": return "FH";
        case "restricted": return "RH";
        case "working_sunday": return null;
        default: return "FH";
    }
}

async function loadHolidayMap(fromStr, toStr) {
    const hols = await CompanyHoliday.find({ date: { $gte: fromStr, $lte: toStr } }).lean();
    const map = new Map();
    for (const h of hols) map.set(h.date, h);
    return map;
}

function designationMatches(designation, list) {
    if (!designation || !list?.length) return false;
    const d = String(designation).toUpperCase().trim();
    return list.some((entry) => {
        const e = String(entry).toUpperCase().trim();
        return e && (d === e || d.includes(e));
    });
}

function resolveEmployeeType(emp, settings) {
    if (!settings) return "executive";
    if (emp?.employeeType) {
        const t = String(emp.employeeType).toLowerCase();
        if (t === "operator" || t === "executive") return t;
    }
    const designation = extractDesignation(emp);
    const department = extractDepartment(emp).toUpperCase().trim();
    const opDesigs = settings.operatorDesignations || [];
    const execDesigs = settings.executiveDesignations || [];
    const coreDepts = new Set((settings.departmentCategories?.core || settings.operatorDepartments || []).map((d) => d.toUpperCase()));
    const genDepts = new Set((settings.departmentCategories?.general || []).map((d) => d.toUpperCase()));
    if (designationMatches(designation, opDesigs)) return "operator";
    if (designationMatches(designation, execDesigs)) return "executive";
    if (coreDepts.has(department)) return "operator";
    if (genDepts.has(department)) return "executive";
    return "executive";
}

/**
 * Build complete month data for a selected set of employees.
 * Returns [{ employee, days: {dateStr: {status, inTime, outTime, work, break, ot}}, totals }]
 */
async function buildMonthData({ yearMonth, empFilter }) {
    const [yr, mo] = yearMonth.split("-").map(Number);
    const lastDay = new Date(yr, mo, 0).getDate();
    const from = `${yearMonth}-01`;
    const to = `${yearMonth}-${String(lastDay).padStart(2, "0")}`;

    const settings = await AttendanceSettings.getConfig();
    const thresholds = settings.lateHalfDayPolicy?.cumulativeLateMinsThreshold || { operator: 30, executive: 40 };
    const labels = settings.displayLabels || {};
    const L = (s) => labels[s] || s;

    const holidayMap = await loadHolidayMap(from, to);

    const today = new Date(); today.setHours(0, 0, 0, 0);
    const allDays = [];
    for (let d = 1; d <= lastDay; d++) {
        const dateStr = `${yearMonth}-${String(d).padStart(2, "0")}`;
        const dt = new Date(dateStr + "T00:00:00");
        const dow = dt.getDay();
        const hol = holidayMap.get(dateStr);
        const isDeclaredHoliday = !!hol && hol.type !== "working_sunday";
        const isWorkingSunday = !!hol && hol.type === "working_sunday";
        allDays.push({
            day: d, dateStr,
            dayName: dt.toLocaleDateString("en-IN", { weekday: "short" }),
            isSunday: dow === 0,
            isFuture: dt > today,
            isDeclaredHoliday, isWorkingSunday,
            holiday: isDeclaredHoliday ? hol : null,
            holidayStatus: isDeclaredHoliday ? holidayTypeToStatus(hol.type) : null,
        });
    }

    // Build employees list based on filter
    const allActive = await Employee.find({
        $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
    }).lean();

    let selected = allActive;
    if (empFilter?.departments?.length && !empFilter.allDepartments) {
        const deptSet = new Set(empFilter.departments.map(d => String(d).toUpperCase()));
        selected = selected.filter(e => deptSet.has(extractDepartment(e).toUpperCase()));
    }
    if (empFilter?.employeeIds?.length && !empFilter.allEmployees) {
        const bioSet = new Set(empFilter.employeeIds.map(b => String(b).toUpperCase()));
        selected = selected.filter(e => {
            const bid = extractBiometricId(e);
            return bid && bioSet.has(String(bid).toUpperCase());
        });
    }

    const dayDocs = await DailyAttendance.find({ yearMonth }).sort({ dateStr: 1 }).lean();
    const byDate = new Map(dayDocs.map((d) => [d.dateStr, d]));

    const PAID_CODES = ["P", "P*", "P~", "HD", "MP", "WO", "FH", "NH", "OH", "RH", "PH", "L-CL", "L-SL", "L-EL", "WFH", "CO"];

    const employees = [];
    for (const emp of selected) {
        const bid = extractBiometricId(emp);
        if (!bid) continue;
        const key = String(bid).toUpperCase();
        const empType = resolveEmployeeType(emp, settings);
        const running = 0;
        let cum = 0;

        const row = {
            biometricId: key,
            empCode: extractIdentity(emp) || key.replace(/^GR/, ""),
            employeeName: extractName(emp),
            department: extractDepartment(emp),
            designation: extractDesignation(emp),
            employeeType: empType,
            days: {},
            totals: {
                P: 0, "P*": 0, "P~": 0, HD: 0, AB: 0, MP: 0, WO: 0, PH: 0,
                FH: 0, NH: 0, OH: 0, RH: 0, leaves: 0,
                totalLateMins: 0, totalOtMins: 0, totalNetWorkMins: 0, totalBreakMins: 0,
                totalAttendance: 0, sundayWorked: 0, holidayWorked: 0,
            },
        };

        for (const cal of allDays) {
            if (cal.isFuture) {
                row.days[cal.dateStr] = { status: "—", isFuture: true };
                continue;
            }
            const dayDoc = byDate.get(cal.dateStr);
            const entry = dayDoc ? (dayDoc.employees || []).find((e) => e.biometricId === key) : null;

            if (cal.isDeclaredHoliday) {
                const hs = cal.holidayStatus;
                const didPunch = !!entry && (entry.punchCount || 0) > 0;
                row.days[cal.dateStr] = {
                    status: hs, displayLabel: L(hs),
                    inTime: entry?.inTime || null,
                    outTime: entry?.finalOut || null,
                    netWorkMins: entry?.netWorkMins || 0,
                    totalBreakMins: entry?.totalBreakMins || 0,
                    otMins: entry?.otMins || 0,
                    lateMins: entry?.lateMins || 0,
                    punchedOnHoliday: didPunch,
                    isHoliday: true,
                };
                row.totals[hs] = (row.totals[hs] || 0) + 1;
                row.totals.totalAttendance++;
                if (didPunch) {
                    row.totals.holidayWorked++;
                    row.totals.totalOtMins += entry.otMins || 0;
                    row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    row.totals.totalBreakMins += entry.totalBreakMins || 0;
                }
                continue;
            }

            if (cal.isSunday && !cal.isWorkingSunday) {
                const didPunch = !!entry && (entry.punchCount || 0) > 0;
                if (didPunch) {
                    let status = entry.systemPrediction;
                    if (entry.isLate && (entry.lateMins || 0) > 0) {
                        cum += entry.lateMins;
                        const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                        if (cum >= thr) { status = "HD"; cum = 0; }
                    }
                    const finalStatus = entry.hrFinalStatus || status;
                    row.days[cal.dateStr] = {
                        status: finalStatus, displayLabel: L(finalStatus),
                        inTime: entry.inTime, outTime: entry.finalOut,
                        netWorkMins: entry.netWorkMins || 0, totalBreakMins: entry.totalBreakMins || 0,
                        otMins: entry.otMins || 0, lateMins: entry.lateMins || 0,
                        isSundayWorked: true,
                    };
                    if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
                    row.totals.sundayWorked++;
                    row.totals.totalAttendance++;
                    row.totals.totalOtMins += entry.otMins || 0;
                    row.totals.totalNetWorkMins += entry.netWorkMins || 0;
                    row.totals.totalBreakMins += entry.totalBreakMins || 0;
                    row.totals.totalLateMins += entry.lateMins || 0;
                } else {
                    row.days[cal.dateStr] = { status: "WO", displayLabel: L("WO") };
                    row.totals.WO++;
                    row.totals.totalAttendance++;
                }
                continue;
            }

            if (!dayDoc) { row.days[cal.dateStr] = { status: "—", unsynced: true }; continue; }
            if (!entry) {
                row.days[cal.dateStr] = { status: "AB", displayLabel: L("AB") };
                row.totals.AB++;
                continue;
            }

            let status = entry.systemPrediction;
            let promoted = false;
            if (entry.isLate && (entry.lateMins || 0) > 0) {
                cum += entry.lateMins;
                const thr = thresholds[entry.employeeType] ?? thresholds.operator ?? 30;
                if (cum >= thr) { status = "HD"; promoted = true; cum = 0; }
            }
            const finalStatus = entry.hrFinalStatus || status;
            row.days[cal.dateStr] = {
                status: finalStatus, displayLabel: L(finalStatus),
                inTime: entry.inTime, outTime: entry.finalOut,
                netWorkMins: entry.netWorkMins || 0, totalBreakMins: entry.totalBreakMins || 0,
                otMins: entry.otMins || 0, lateMins: entry.lateMins || 0,
                earlyDepartureMins: entry.earlyDepartureMins || 0,
                hasMissPunch: entry.hasMissPunch, isLate: entry.isLate,
                isEarlyDeparture: entry.isEarlyDeparture,
                punchCount: entry.punchCount || 0,
                hrOverride: !!entry.hrFinalStatus,
                wasPromoted: promoted,
            };
            if (row.totals[finalStatus] !== undefined) row.totals[finalStatus]++;
            if (["L-CL", "L-SL", "L-EL", "LWP", "WFH", "CO"].includes(finalStatus)) row.totals.leaves++;
            if (PAID_CODES.includes(finalStatus)) row.totals.totalAttendance++;
            row.totals.totalLateMins += entry.lateMins || 0;
            row.totals.totalOtMins += entry.otMins || 0;
            row.totals.totalNetWorkMins += entry.netWorkMins || 0;
            row.totals.totalBreakMins += entry.totalBreakMins || 0;
        }

        employees.push(row);
    }

    // Sort
    const sortBy = empFilter?.sortBy || "department";
    if (sortBy === "department") {
        employees.sort((a, b) => {
            if (a.department !== b.department) return (a.department || "").localeCompare(b.department || "");
            return (a.employeeName || "").localeCompare(b.employeeName || "");
        });
    } else if (sortBy === "name") {
        employees.sort((a, b) => (a.employeeName || "").localeCompare(b.employeeName || ""));
    } else if (sortBy === "empcode") {
        employees.sort((a, b) => (a.empCode || "").localeCompare(b.empCode || ""));
    }

    return { yearMonth, from, to, monthLabel: new Date(from + "T00:00:00").toLocaleDateString("en-IN", { month: "long", year: "numeric" }), lastDay, allDays, employees, displayLabels: labels, holidays: [...holidayMap.values()].filter(h => h.type !== "working_sunday") };
}

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS: EMPLOYEES & DEPARTMENTS for filter dropdowns on the Reports page
// ═══════════════════════════════════════════════════════════════════════════

router.get("/filters", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const emps = await Employee.find({
            $or: [{ status: "active" }, { status: { $exists: false } }, { isActive: true }],
        }).lean();
        const settings = await AttendanceSettings.getConfig();

        const deptSet = new Set();
        const employees = [];
        for (const e of emps) {
            const bid = extractBiometricId(e);
            if (!bid) continue;
            const dept = extractDepartment(e);
            if (dept && dept !== "—") deptSet.add(dept);
            employees.push({
                biometricId: String(bid).toUpperCase(),
                empCode: extractIdentity(e),
                name: extractName(e),
                department: dept,
                designation: extractDesignation(e),
                employeeType: resolveEmployeeType(e, settings),
            });
        }
        employees.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        res.json({
            success: true,
            company: { id: 1, name: "GRAV Clothing" },   // placeholder — expand when multi-company
            departments: [...deptSet].sort().map((d, i) => ({ id: i + 1, name: d })),
            employees,
        });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ═══════════════════════════════════════════════════════════════════════════
//  1. MONTH PERFORMANCE  (the big eTimeOffice-style block — per employee)
// ═══════════════════════════════════════════════════════════════════════════
//
//  Layout (mirrors screenshot):
//    ┌──────────────────────────────────────────────────────────────┐
//    │ Dept.Name | <dept>      │ CompName | GRAV │ Report Month    │
//    │ Empcode  | <code>       │ Name | <name>                      │
//    │ Present | WO | HL | LV | Absent | Tot.Work+OT | Total OT    │
//    ├──────────────────────────────────────────────────────────────┤
//    │      │ 1   2   3   ...  31                                   │
//    │      │ Mon Tue Wed ...                                       │
//    │ IN   │                                                       │
//    │ OUT  │                                                       │
//    │ WORK │                                                       │
//    │ Break│                                                       │
//    │ OT   │                                                       │
//    │ Status│ P P A P WO P P ...                                  │
//    └──────────────────────────────────────────────────────────────┘
// ═══════════════════════════════════════════════════════════════════════════

router.post("/month-performance", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { yearMonth, format = "pdf", sortBy, allCompany, allDepartments, allEmployees, departments, employeeIds } = req.body;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const data = await buildMonthData({
            yearMonth,
            empFilter: { sortBy, allCompany, allDepartments, allEmployees, departments, employeeIds },
        });

        if (format === "excel") {
            await streamMonthPerformanceExcel(res, data);
        } else {
            streamMonthPerformancePDF(res, data);
        }
    } catch (err) {
        console.error("[REPORTS/month-performance]", err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

function streamMonthPerformancePDF(res, data) {
    const { yearMonth, monthLabel, lastDay, allDays, employees } = data;
    const filename = `MonthPerformance_${yearMonth}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({
        size: "A4", layout: "landscape",
        margins: { top: 24, left: 20, right: 20, bottom: 24 },
    });
    doc.pipe(res);

    const L = (s) => data.displayLabels?.[s] || s;

    // Measure how tall one employee block is so we can fit multiple per page
    const BLOCK_HEIGHT = calcBlockHeight(allDays.length);
    const SPACING = 16;
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    employees.forEach((emp, idx) => {
        // Fit 2 blocks per page on A4 landscape (~595pt usable height → 2 blocks at ~280pt each)
        // If the next block won't fit, start a new page.
        if (idx === 0) {
            // first block starts at top margin
        } else {
            const nextBottom = doc.y + SPACING + BLOCK_HEIGHT;
            if (nextBottom > pageBottom) {
                doc.addPage();
            } else {
                doc.y += SPACING;
            }
        }
        renderMonthPerformanceBlock(doc, emp, allDays, monthLabel, L);
    });

    if (!employees.length) {
        doc.fontSize(14).fillColor("#64748b").text("No employees matched the selected filters.", { align: "center" });
    }

    doc.end();
}

// Compute total block height so we know when to page-break
function calcBlockHeight(numDays) {
    const headerRows = 2 * 22;       // dept + empcode rows
    const statsRow = 24;
    const dayHeader = 18 * 2;        // day num + day name
    const dataRows = 18 * 6;         // IN / OUT / WORK / Break / OT / Status
    const footer = 16;               // "* indicates worked..." line
    return headerRows + statsRow + dayHeader + dataRows + footer;
}


// PDF drawing helpers
function drawCell(doc, x, y, w, h, text, opts = {}) {
    const { align = "left", bold = false, size = 9, color = "#111827", fill = null, border = "#9CA3AF" } = opts;
    if (fill) {
        doc.rect(x, y, w, h).fill(fill);
    }
    if (border) {
        doc.lineWidth(0.5).strokeColor(border).rect(x, y, w, h).stroke();
    }
    if (text !== null && text !== undefined && String(text) !== "") {
        doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(size).fillColor(color);
        const padding = align === "center" ? 0 : 4;
        const textY = y + (h - size) / 2 - 1;
        doc.text(String(text), x + padding, textY, {
            width: w - padding * 2,
            align,
            lineBreak: false,
        });
    }
}

// Add this missing helper function after drawCell
function drawSplitCell(doc, x, y, w, h, label, value, valueColor) {
    // Upper 40% = label on gray bg; lower 60% = value on white
    const labelH = Math.round(h * 0.42);
    const valueH = h - labelH;
    doc.rect(x, y, w, labelH).fill("#F3F4F6");
    doc.lineWidth(0.5).strokeColor("#9CA3AF").rect(x, y, w, labelH).stroke();
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#374151")
        .text(label, x, y + 2, { width: w, align: "center", lineBreak: false });

    doc.rect(x, y + labelH, w, valueH).fill("#FFFFFF");
    doc.lineWidth(0.5).strokeColor("#9CA3AF").rect(x, y + labelH, w, valueH).stroke();
    doc.font("Helvetica-Bold").fontSize(11).fillColor(valueColor || "#111827")
        .text(String(value), x, y + labelH + 2, { width: w, align: "center", lineBreak: false });
}

function renderMonthPerformanceBlock(doc, emp, allDays, monthLabel, L) {
    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const startX = doc.page.margins.left;
    let y = doc.y;   // ← use doc.y instead of top margin, so we can stack blocks
    const lastDay = allDays.length;

    // ── HEADER TABLE (3 rows) ────────────────────────────────────────────
    const headerH = 22;
    const col1W = 75;
    const col2W = 160;
    const col3W = 75;
    const col4W = 120;
    const col5W = 85;
    const col6W = pageW - col1W - col2W - col3W - col4W - col5W;

    // Labels now have colored text
    const labelOpts = (color) => ({
        align: "left", bold: true, size: 9,
        color, fill: "#F9FAFB", border: "#9CA3AF",
    });

    // Row 1: Dept. Name | <dept> | CompName | GRAV | Report Month | <month>
    drawCell(doc, startX, y, col1W, headerH, "Dept. Name", labelOpts("#4F46E5"));
    drawCell(doc, startX + col1W, y, col2W, headerH, emp.department || "—", { align: "left", size: 10, bold: true, color: "#111827" });
    drawCell(doc, startX + col1W + col2W, y, col3W, headerH, "CompName", labelOpts("#0891B2"));
    drawCell(doc, startX + col1W + col2W + col3W, y, col4W, headerH, "GRAV", { align: "left", size: 10, bold: true, color: "#7C3AED" });
    drawCell(doc, startX + col1W + col2W + col3W + col4W, y, col5W, headerH, "Report Month", labelOpts("#DB2777"));
    drawCell(doc, startX + col1W + col2W + col3W + col4W + col5W, y, col6W, headerH, monthLabel, { align: "left", size: 10, bold: true, color: "#111827" });
    y += headerH;

    // Row 2: Empcode | <code> | Name | <name spanning rest>
    drawCell(doc, startX, y, col1W, headerH, "Empcode", labelOpts("#2563EB"));
    drawCell(doc, startX + col1W, y, col2W, headerH, emp.empCode || "—", { align: "left", size: 10, bold: true, color: "#16A34A" });
    drawCell(doc, startX + col1W + col2W, y, col3W, headerH, "Name", labelOpts("#EA580C"));
    drawCell(doc, startX + col1W + col2W + col3W, y, col4W + col5W + col6W, headerH, emp.employeeName || "—", { align: "left", size: 10, bold: true, color: "#111827" });
    y += headerH;

    // ── Stats row (unchanged from previous patch — no fill, colored text) ──
    const presentTotal = emp.totals.P + emp.totals["P*"] + emp.totals["P~"] + emp.totals.MP;
    const holidayTotal = emp.totals.FH + emp.totals.NH + emp.totals.OH + emp.totals.RH + emp.totals.PH;
    const statsRow = [
        { label: "Present", value: presentTotal, color: "#16A34A", w: 90 },
        { label: "WO", value: emp.totals.WO, color: "#2563EB", w: 60 },
        { label: "HL", value: holidayTotal, color: "#4F46E5", w: 60 },
        { label: "LV", value: emp.totals.leaves, color: "#7C3AED", w: 60 },
        { label: "Absent", value: emp.totals.AB, color: "#DC2626", w: 80 },
        { label: "Tot. Work+OT", value: fmtHM(emp.totals.totalNetWorkMins + emp.totals.totalOtMins), color: "#111827", w: 110 },
        { label: "Total OT", value: fmtHM(emp.totals.totalOtMins), color: "#4338CA", w: null },
    ];
    let xx = startX;
    const statsH = 24;
    statsRow.forEach((s, i) => {
        const w = s.w != null ? s.w : (pageW - statsRow.slice(0, i).reduce((a, x) => a + (x.w || 0), 0));
        drawStatCellNoFill(doc, xx, y, w, statsH, s.label, String(s.value), s.color);
        xx += w;
    });
    y += statsH;

    // ── DATA TABLE (unchanged from previous patch) ────────────────────────
    const labelColW = 55;
    const dayColW = (pageW - labelColW) / lastDay;

    const dayHeaderH = 18;
    drawCell(doc, startX, y, labelColW, dayHeaderH * 2, "", { fill: null, border: "#9CA3AF" });

    for (let i = 0; i < lastDay; i++) {
        const cal = allDays[i];
        const cx = startX + labelColW + i * dayColW;
        const fg = cal?.isSunday ? "#DC2626" : cal?.isDeclaredHoliday ? "#4F46E5" : "#111827";
        drawCell(doc, cx, y, dayColW, dayHeaderH, String(cal?.day ?? (i + 1)), {
            align: "center", bold: true, size: 8, color: fg, border: "#D1D5DB"
        });
        drawCell(doc, cx, y + dayHeaderH, dayColW, dayHeaderH, cal?.dayName || "", {
            align: "center", size: 7, color: fg, border: "#D1D5DB"
        });
    }
    y += dayHeaderH * 2;

    const rowH = 18;
    const rowDefs = [
        { label: "IN", get: (d) => fmtTime(d.inTime), labelColor: "#16A34A" },
        { label: "OUT", get: (d) => fmtTime(d.outTime), labelColor: "#DC2626" },
        { label: "WORK", get: (d) => fmtHM(d.netWorkMins), labelColor: "#2563EB" },
        { label: "Break", get: (d) => fmtHM(d.totalBreakMins), labelColor: "#EA580C" },
        { label: "OT", get: (d) => fmtHM(d.otMins), labelColor: "#4338CA" },
        { label: "Status", get: (d) => L(d.status || "—"), isStatus: true, labelColor: "#7C3AED" },
    ];

    rowDefs.forEach((rd) => {
        // Row label with colored text
        drawCell(doc, startX, y, labelColW, rowH, rd.label, {
            align: "right", bold: true, size: 9, color: rd.labelColor, fill: "#F9FAFB", border: "#9CA3AF"
        });
        for (let i = 0; i < lastDay; i++) {
            const cal = allDays[i];
            const d = emp.days[cal.dateStr] || { status: "—" };
            const cx = startX + labelColW + i * dayColW;
            const isFuture = d.isFuture;

            let val = isFuture ? "" : rd.get(d);
            let color = "#111827";
            let bold = false;

            if (rd.isStatus) {
                bold = true;
                const s = d.status;
                if (s === "P") color = "#16A34A";
                else if (s === "P*") color = "#CA8A04";
                else if (s === "P~") color = "#EA580C";
                else if (s === "HD") color = "#D97706";
                else if (s === "AB") color = "#DC2626";
                else if (s === "MP") color = "#DB2777";
                else if (s === "WO") color = "#2563EB";
                else if (["FH", "NH", "OH", "RH", "PH"].includes(s)) color = "#4F46E5";
                else if (["L-CL", "L-SL", "L-EL"].includes(s)) color = "#7C3AED";
                else if (s === "WFH") color = "#0891B2";
                else if (s === "CO") color = "#0D9488";
                if (d.punchedOnHoliday || d.isSundayWorked) val += "*";
            } else {
                if (rd.label === "IN" && d.isLate) { color = "#CA8A04"; bold = true; }
                if (rd.label === "OUT" && d.isEarlyDeparture) { color = "#EA580C"; bold = true; }
                if (rd.label === "OT" && (d.otMins || 0) > 0) { color = "#4338CA"; bold = true; }
                if (rd.label === "WORK" && (d.netWorkMins || 0) >= 480) color = "#16A34A";
            }

            drawCell(doc, cx, y, dayColW, rowH, val, { align: "center", size: 7, bold, color, fill: null, border: "#D1D5DB" });
        }
        y += rowH;
    });

    if (emp.totals.sundayWorked || emp.totals.holidayWorked) {
        y += 6;
        doc.fontSize(7).fillColor("#64748B").text(
            `* indicates worked on Sunday/Holiday   ·   Sundays worked: ${emp.totals.sundayWorked}   ·   Holidays worked: ${emp.totals.holidayWorked}`,
            startX, y, { width: pageW, align: "center" }
        );
        y += 10;
    }

    // Update doc.y so the next block knows where to start
    doc.y = y;
}

// New helper — stat cell with no fill, just label above value
function drawStatCellNoFill(doc, x, y, w, h, label, value, valueColor) {
    // Border only
    doc.lineWidth(0.5).strokeColor("#9CA3AF").rect(x, y, w, h).stroke();

    const labelY = y + 3;
    const valueY = y + h * 0.45;

    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#6B7280")
        .text(label, x, labelY, { width: w, align: "center", lineBreak: false });
    doc.font("Helvetica-Bold").fontSize(11).fillColor(valueColor || "#111827")
        .text(String(value), x, valueY, { width: w, align: "center", lineBreak: false });
}


function drawSplitCell(doc, x, y, w, h, label, value, valueColor) {
    // Upper 40% = label on gray bg; lower 60% = value on white
    const labelH = Math.round(h * 0.42);
    const valueH = h - labelH;
    doc.rect(x, y, w, labelH).fill("#F3F4F6");
    doc.lineWidth(0.5).strokeColor("#9CA3AF").rect(x, y, w, labelH).stroke();
    doc.font("Helvetica-Bold").fontSize(7.5).fillColor("#374151")
        .text(label, x, y + 2, { width: w, align: "center", lineBreak: false });

    doc.rect(x, y + labelH, w, valueH).fill("#FFFFFF");
    doc.lineWidth(0.5).strokeColor("#9CA3AF").rect(x, y + labelH, w, valueH).stroke();
    doc.font("Helvetica-Bold").fontSize(11).fillColor(valueColor || "#111827")
        .text(String(value), x, y + labelH + 2, { width: w, align: "center", lineBreak: false });
}

// ═══════════════════════════════════════════════════════════════════════════
//  MONTH PERFORMANCE — Excel (multi-employee, blocks stacked vertically)
// ═══════════════════════════════════════════════════════════════════════════

async function streamMonthPerformanceExcel(res, data) {
    const { yearMonth, monthLabel, lastDay, allDays, employees } = data;
    const L = (s) => data.displayLabels?.[s] || s;

    const wb = new ExcelJS.Workbook();
    wb.creator = "Grav Clothing HRMS";
    const ws = wb.addWorksheet("Month Performance", {
        views: [{ showGridLines: false }],
        pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    });

    // Columns: label col + 31 day cols
    ws.getColumn(1).width = 10;
    for (let i = 0; i < lastDay; i++) ws.getColumn(2 + i).width = 4.2;

    let row = 1;
    for (const emp of employees) {
        row = renderEmpBlockExcel(ws, row, emp, allDays, monthLabel, L);
        row += 2; // spacing between blocks
    }

    if (employees.length === 0) {
        ws.getCell("A1").value = "No employees matched the selected filters.";
    }

    const filename = `MonthPerformance_${yearMonth}.xlsx`;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
}

function renderEmpBlockExcel(ws, startRow, emp, allDays, monthLabel, L) {
    const totalCols = 1 + allDays.length;

    // Row 1: Dept / CompName / Report Month
    // Row 1: Dept / CompName / Report Month — label cells with colored text
    const r1 = ws.getRow(startRow);
    r1.getCell(1).value = "Dept. Name";
    r1.getCell(1).font = { bold: true, size: 9, color: { argb: "FF4F46E5" } };  // indigo
    r1.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
    const deptSpan = Math.floor(totalCols / 3);
    ws.mergeCells(startRow, 2, startRow, deptSpan);
    r1.getCell(2).value = emp.department || "—";
    r1.getCell(2).font = { bold: true, size: 11, color: { argb: "FF111827" } };

    r1.getCell(deptSpan + 1).value = "CompName";
    r1.getCell(deptSpan + 1).font = { bold: true, size: 9, color: { argb: "FF0891B2" } };  // cyan
    r1.getCell(deptSpan + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
    const compSpan = deptSpan + 1 + Math.floor(totalCols / 3);
    ws.mergeCells(startRow, deptSpan + 2, startRow, compSpan);
    r1.getCell(deptSpan + 2).value = "GRAV";
    r1.getCell(deptSpan + 2).font = { bold: true, size: 11, color: { argb: "FF7C3AED" } };  // purple value

    r1.getCell(compSpan + 1).value = "Report Month";
    r1.getCell(compSpan + 1).font = { bold: true, size: 9, color: { argb: "FFDB2777" } };  // pink
    r1.getCell(compSpan + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
    ws.mergeCells(startRow, compSpan + 2, startRow, totalCols);
    r1.getCell(compSpan + 2).value = monthLabel;
    r1.getCell(compSpan + 2).font = { bold: true, size: 11, color: { argb: "FF111827" } };
    r1.height = 22;
    applyBorders(ws, startRow, 1, startRow, totalCols);

    // Row 2: Empcode / Name
    const r2 = ws.getRow(startRow + 1);
    r2.getCell(1).value = "Empcode";
    r2.getCell(1).font = { bold: true, size: 9, color: { argb: "FF2563EB" } };  // blue
    r2.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
    ws.mergeCells(startRow + 1, 2, startRow + 1, deptSpan);
    r2.getCell(2).value = emp.empCode;
    r2.getCell(2).font = { bold: true, size: 11, color: { argb: "FF16A34A" } };  // green code

    r2.getCell(deptSpan + 1).value = "Name";
    r2.getCell(deptSpan + 1).font = { bold: true, size: 9, color: { argb: "FFEA580C" } };  // orange
    r2.getCell(deptSpan + 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };
    ws.mergeCells(startRow + 1, deptSpan + 2, startRow + 1, totalCols);
    r2.getCell(deptSpan + 2).value = emp.employeeName;
    r2.getCell(deptSpan + 2).font = { bold: true, size: 11, color: { argb: "FF111827" } };
    r2.height = 22;
    applyBorders(ws, startRow + 1, 1, startRow + 1, totalCols);

    // Row 3: Stats — NO FILL, just bordered cells with colored bold text
    const presentTotal = emp.totals.P + emp.totals["P*"] + emp.totals["P~"] + emp.totals.MP;
    const holidayTotal = emp.totals.FH + emp.totals.NH + emp.totals.OH + emp.totals.RH + emp.totals.PH;
    const cells = [
        { label: "Present", value: presentTotal, color: "FF16A34A" },
        { label: "WO", value: emp.totals.WO, color: "FF2563EB" },
        { label: "HL", value: holidayTotal, color: "FF4F46E5" },
        { label: "LV", value: emp.totals.leaves, color: "FF7C3AED" },
        { label: "Absent", value: emp.totals.AB, color: "FFDC2626" },
        { label: "Tot. Work+OT", value: fmtHM(emp.totals.totalNetWorkMins + emp.totals.totalOtMins), color: "FF111827" },
        { label: "Total OT", value: fmtHM(emp.totals.totalOtMins), color: "FF4338CA" },
    ];
    const perCell = Math.floor(totalCols / cells.length);
    const r3 = ws.getRow(startRow + 2);
    cells.forEach((c, i) => {
        const col1 = i * perCell + 1;
        const col2 = i === cells.length - 1 ? totalCols : (i + 1) * perCell;
        ws.mergeCells(startRow + 2, col1, startRow + 2, col2);
        const cell = r3.getCell(col1);
        cell.value = {
            richText: [
                { text: `${c.label}\n`, font: { size: 8, bold: true, color: { argb: "FF6B7280" } } },
                { text: String(c.value), font: { size: 12, bold: true, color: { argb: c.color } } },
            ]
        };
        cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
        // NO FILL — let it be white
    });
    r3.height = 32;
    applyBorders(ws, startRow + 2, 1, startRow + 2, totalCols);

    // Row 4: day numbers — white bg, colored text
    const r4 = ws.getRow(startRow + 3);
    r4.getCell(1).value = "";
    for (let i = 0; i < allDays.length; i++) {
        const cal = allDays[i];
        const cell = r4.getCell(2 + i);
        cell.value = cal.day;
        const fg = cal.isSunday ? "FFDC2626" : cal.isDeclaredHoliday ? "FF4F46E5" : "FF111827";
        cell.font = { bold: true, size: 8, color: { argb: fg } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    }
    r4.height = 16;
    applyBorders(ws, startRow + 3, 1, startRow + 3, totalCols);

    // Row 5: day names
    const r5 = ws.getRow(startRow + 4);
    r5.getCell(1).value = "";
    for (let i = 0; i < allDays.length; i++) {
        const cal = allDays[i];
        const cell = r5.getCell(2 + i);
        cell.value = cal.dayName;
        const fg = cal.isSunday ? "FFDC2626" : cal.isDeclaredHoliday ? "FF4F46E5" : "FF6B7280";
        cell.font = { size: 7, color: { argb: fg } };
        cell.alignment = { vertical: "middle", horizontal: "center" };
    }
    r5.height = 14;
    applyBorders(ws, startRow + 4, 1, startRow + 4, totalCols);

    // Data rows: IN, OUT, WORK, Break, OT, Status — no fills, just colored text
    const rowDefs = [
        { label: "IN", get: (d) => fmtTime(d.inTime), highlight: (d) => d.isLate ? "FFCA8A04" : null, labelColor: "FF16A34A" },
        { label: "OUT", get: (d) => fmtTime(d.outTime), highlight: (d) => d.isEarlyDeparture ? "FFEA580C" : null, labelColor: "FFDC2626" },
        { label: "WORK", get: (d) => fmtHM(d.netWorkMins), highlight: (d) => (d.netWorkMins || 0) >= 480 ? "FF16A34A" : null, labelColor: "FF2563EB" },
        { label: "Break", get: (d) => fmtHM(d.totalBreakMins), labelColor: "FFEA580C" },
        { label: "OT", get: (d) => fmtHM(d.otMins), highlight: (d) => (d.otMins || 0) > 0 ? "FF4338CA" : null, labelColor: "FF4338CA" },
        { label: "Status", get: (d) => L(d.status || "—"), isStatus: true, labelColor: "FF7C3AED" },
    ];

    rowDefs.forEach((rd, rdIdx) => {
        const r = ws.getRow(startRow + 5 + rdIdx);
        r.getCell(1).value = rd.label;
        r.getCell(1).font = { bold: true, size: 9, color: { argb: rd.labelColor || "FF111827" } };
        r.getCell(1).alignment = { vertical: "middle", horizontal: "right", indent: 1 };
        r.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF9FAFB" } };

        for (let i = 0; i < allDays.length; i++) {
            const cal = allDays[i];
            const d = emp.days[cal.dateStr] || { status: "—" };
            const cell = r.getCell(2 + i);
            let val = d.isFuture ? "" : rd.get(d);
            let color = "FF111827";
            let bold = false;

            if (rd.isStatus) {
                bold = true;
                const s = d.status;
                if (s === "P") color = "FF16A34A";
                else if (s === "P*") color = "FFCA8A04";
                else if (s === "P~") color = "FFEA580C";
                else if (s === "HD") color = "FFD97706";
                else if (s === "AB") color = "FFDC2626";
                else if (s === "MP") color = "FFDB2777";
                else if (s === "WO") color = "FF2563EB";
                else if (["FH", "NH", "OH", "RH", "PH"].includes(s)) color = "FF4F46E5";
                else if (["L-CL", "L-SL", "L-EL"].includes(s)) color = "FF7C3AED";
                else if (s === "WFH") color = "FF0891B2";
                else if (s === "CO") color = "FF0D9488";
                if (d.punchedOnHoliday || d.isSundayWorked) val += "*";
            } else if (rd.highlight) {
                const hc = rd.highlight(d);
                if (hc) { color = hc; bold = true; }
            }

            cell.value = val;
            cell.font = { size: 7, bold, color: { argb: color } };
            // NO FILL — leave cells white
            cell.alignment = { vertical: "middle", horizontal: "center" };
        }
        r.height = 16;
    });

    applyBorders(ws, startRow + 5, 1, startRow + 5 + rowDefs.length - 1, totalCols);

    return startRow + 5 + rowDefs.length - 1;
}


function applyBorders(ws, r1, c1, r2, c2) {
    for (let r = r1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
            const cell = ws.getCell(r, c);
            cell.border = {
                top: { style: "thin", color: { argb: "FF9CA3AF" } },
                bottom: { style: "thin", color: { argb: "FF9CA3AF" } },
                left: { style: "thin", color: { argb: "FF9CA3AF" } },
                right: { style: "thin", color: { argb: "FF9CA3AF" } },
            };
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
//  SHARED — list-style reports (Absent / Early Out / OT / Miss Punch / etc)
// ═══════════════════════════════════════════════════════════════════════════
//  All these reports share the same "list of rows" structure — each row is
//  one employee-day that matches the report's filter. We build the data once
//  then render it via a generic PDF/Excel renderer.
// ═══════════════════════════════════════════════════════════════════════════

function flattenMonthData(data, predicate) {
    const rows = [];
    for (const emp of data.employees) {
        for (const cal of data.allDays) {
            const d = emp.days[cal.dateStr];
            if (!d || d.isFuture) continue;
            if (predicate(d, cal, emp)) {
                rows.push({
                    empCode: emp.empCode,
                    employeeName: emp.employeeName,
                    department: emp.department,
                    designation: emp.designation,
                    dateStr: cal.dateStr,
                    day: cal.day,
                    dayName: cal.dayName,
                    status: d.status,
                    displayLabel: d.displayLabel || d.status,
                    inTime: d.inTime,
                    outTime: d.outTime,
                    netWorkMins: d.netWorkMins || 0,
                    totalBreakMins: d.totalBreakMins || 0,
                    otMins: d.otMins || 0,
                    lateMins: d.lateMins || 0,
                    earlyDepartureMins: d.earlyDepartureMins || 0,
                    punchCount: d.punchCount || 0,
                    isSunday: cal.isSunday,
                    isHoliday: cal.isDeclaredHoliday,
                    isSundayWorked: !!d.isSundayWorked,
                    punchedOnHoliday: !!d.punchedOnHoliday,
                    hrOverride: !!d.hrOverride,
                });
            }
        }
    }
    return rows;
}

// Summary rows = one per employee (aggregated over month)
function buildSummaryRows(data) {
    return data.employees.map((emp) => {
        const present = emp.totals.P + emp.totals["P*"] + emp.totals["P~"] + emp.totals.MP;
        const holidays = emp.totals.FH + emp.totals.NH + emp.totals.OH + emp.totals.RH + emp.totals.PH;
        return {
            empCode: emp.empCode,
            employeeName: emp.employeeName,
            department: emp.department,
            designation: emp.designation,
            present,
            late: emp.totals["P*"],
            earlyOut: emp.totals["P~"],
            halfDay: emp.totals.HD,
            missPunch: emp.totals.MP,
            absent: emp.totals.AB,
            weeklyOff: emp.totals.WO,
            holidays,
            leaves: emp.totals.leaves,
            sundayWorked: emp.totals.sundayWorked,
            holidayWorked: emp.totals.holidayWorked,
            totalAttendance: emp.totals.totalAttendance,
            netWorkMins: emp.totals.totalNetWorkMins,
            otMins: emp.totals.totalOtMins,
            lateMins: emp.totals.totalLateMins,
        };
    });
}

// ─── REPORT DEFINITIONS ────────────────────────────────────────────────────

const REPORTS = {
    "month-absent": {
        title: "Month Absent Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 150 },
            { key: "department", label: "Department", w: 110 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "displayLabel", label: "Status", w: 55, colorize: true },
        ],
        getRows: (data) => flattenMonthData(data, (d) => d.status === "AB"),
    },

    "month-in-out": {
        title: "Month IN-OUT Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 100 },
            { key: "dateStr", label: "Date", w: 70 },
            { key: "dayName", label: "Day", w: 40 },
            { key: "inTimeFmt", label: "IN", w: 50 },
            { key: "outTimeFmt", label: "OUT", w: 50 },
            { key: "workFmt", label: "Work", w: 55 },
            { key: "breakFmt", label: "Break", w: 55 },
            { key: "displayLabel", label: "Status", w: 50, colorize: true },
        ],
        getRows: (data) => {
            return flattenMonthData(data, (d) => ["P", "P*", "P~", "HD", "MP"].includes(d.status))
                .map((r) => ({
                    ...r,
                    inTimeFmt: fmtTime(r.inTime),
                    outTimeFmt: fmtTime(r.outTime),
                    workFmt: fmtHM(r.netWorkMins),
                    breakFmt: fmtHM(r.totalBreakMins),
                }));
        },
    },

    "month-summary": {
        title: "Month Summary Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 105 },
            { key: "present", label: "P", w: 30, num: true, color: "#16A34A" },
            { key: "late", label: "L", w: 30, num: true, color: "#CA8A04" },
            { key: "halfDay", label: "HD", w: 30, num: true, color: "#D97706" },
            { key: "missPunch", label: "MP", w: 30, num: true, color: "#DB2777" },
            { key: "absent", label: "A", w: 30, num: true, color: "#DC2626" },
            { key: "weeklyOff", label: "WO", w: 32, num: true, color: "#2563EB" },
            { key: "holidays", label: "HL", w: 30, num: true, color: "#4F46E5" },
            { key: "leaves", label: "LV", w: 30, num: true, color: "#7C3AED" },
            { key: "holidayWorked", label: "HW", w: 30, num: true, color: "#4338CA" },
            { key: "sundayWorked", label: "SW", w: 30, num: true, color: "#DC2626" },
            { key: "totalAttendance", label: "Total Att", w: 55, num: true, color: "#166534", bold: true },
            { key: "workFmt", label: "Net Work", w: 60 },
            { key: "otFmt", label: "OT", w: 50, color: "#4338CA" },
        ],
        getRows: (data) => buildSummaryRows(data).map((r) => ({
            ...r,
            workFmt: fmtHM(r.netWorkMins),
            otFmt: fmtHM(r.otMins),
        })),
    },

    "month-early-out": {
        title: "Month Early Out Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 105 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "outTimeFmt", label: "OUT", w: 55 },
            { key: "earlyByFmt", label: "Early By", w: 65, color: "#EA580C" },
            { key: "displayLabel", label: "Status", w: 55, colorize: true },
        ],
        getRows: (data) => flattenMonthData(data, (d) => (d.earlyDepartureMins || 0) > 0)
            .map((r) => ({ ...r, outTimeFmt: fmtTime(r.outTime), earlyByFmt: `${r.earlyDepartureMins}m` })),
    },

    "month-overtime": {
        title: "Month Overtime Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 105 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "inTimeFmt", label: "IN", w: 55 },
            { key: "outTimeFmt", label: "OUT", w: 55 },
            { key: "otFmt", label: "OT Hours", w: 70, color: "#4338CA", bold: true },
            { key: "displayLabel", label: "Status", w: 50, colorize: true },
        ],
        getRows: (data) => flattenMonthData(data, (d) => (d.otMins || 0) > 0)
            .map((r) => ({
                ...r,
                inTimeFmt: fmtTime(r.inTime),
                outTimeFmt: fmtTime(r.outTime),
                otFmt: fmtHM(r.otMins),
            })),
    },

    "month-miss-punch": {
        title: "Month Miss Punch Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 110 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "inTimeFmt", label: "IN", w: 55 },
            { key: "outTimeFmt", label: "OUT", w: 55 },
            { key: "punchCount", label: "Punches", w: 50, num: true },
            { key: "displayLabel", label: "Status", w: 55, colorize: true },
        ],
        getRows: (data) => flattenMonthData(data, (d) => d.status === "MP" || (d.punchCount > 0 && d.punchCount < 2))
            .map((r) => ({
                ...r,
                inTimeFmt: fmtTime(r.inTime),
                outTimeFmt: fmtTime(r.outTime),
            })),
    },

    "month-half-day": {
        title: "Month Half Day Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 110 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "inTimeFmt", label: "IN", w: 55 },
            { key: "outTimeFmt", label: "OUT", w: 55 },
            { key: "workFmt", label: "Work", w: 60 },
            { key: "reason", label: "Reason", w: 95 },
        ],
        getRows: (data) => flattenMonthData(data, (d) => d.status === "HD")
            .map((r) => ({
                ...r,
                inTimeFmt: fmtTime(r.inTime),
                outTimeFmt: fmtTime(r.outTime),
                workFmt: fmtHM(r.netWorkMins),
                reason: r.hrOverride ? "HR Override" : (r.punchCount < 2 ? "Miss Punch" : "Short Work Hours"),
            })),
    },

    "month-coff": {
        title: "Month Comp-Off Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 60 },
            { key: "employeeName", label: "Name", w: 150 },
            { key: "department", label: "Department", w: 115 },
            { key: "dateStr", label: "Date", w: 80 },
            { key: "dayName", label: "Day", w: 50 },
            { key: "displayLabel", label: "Status", w: 60, colorize: true },
            { key: "reason", label: "Note", w: 120 },
        ],
        getRows: (data) => flattenMonthData(data, (d, cal) => d.status === "CO" || d.isSundayWorked || d.punchedOnHoliday)
            .map((r) => ({
                ...r,
                reason: r.status === "CO" ? "Comp Off granted"
                    : r.isSundayWorked ? "Sunday Worked → eligible for Comp Off"
                        : r.punchedOnHoliday ? "Holiday Worked → eligible for Comp Off" : "",
            })),
    },

    "month-special": {
        title: "Month Special Report",
        columns: [
            { key: "empCode", label: "Emp Code", w: 55 },
            { key: "employeeName", label: "Name", w: 140 },
            { key: "department", label: "Department", w: 105 },
            { key: "dateStr", label: "Date", w: 75 },
            { key: "dayName", label: "Day", w: 45 },
            { key: "displayLabel", label: "Status", w: 55, colorize: true },
            { key: "note", label: "Note", w: 130 },
        ],
        getRows: (data) => flattenMonthData(data, (d) => d.hrOverride || d.punchedOnHoliday || d.isSundayWorked || ["L-CL", "L-SL", "L-EL", "WFH", "CO"].includes(d.status))
            .map((r) => {
                let note = "";
                if (r.hrOverride) note = "HR Override";
                else if (r.punchedOnHoliday) note = "Worked on Holiday";
                else if (r.isSundayWorked) note = "Worked on Sunday";
                else if (["L-CL", "L-SL", "L-EL"].includes(r.status)) note = "On Leave";
                else if (r.status === "WFH") note = "Work From Home";
                else if (r.status === "CO") note = "Comp Off Taken";
                return { ...r, note };
            }),
    },
};

// ─── Generic PDF + Excel renderers for list-style reports ──────────────────

function streamListReportPDF(res, { title, columns, rows, monthLabel, filterSummary }) {
    const filename = `${title.replace(/\s+/g, "_")}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);

    const doc = new PDFDocument({
        size: "A4",
        layout: "landscape",
        margins: { top: 30, left: 24, right: 24, bottom: 32 },
    });
    doc.pipe(res);

    const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    // ── Header banner ──
    const drawHeader = () => {
        const y0 = doc.y;
        doc.rect(doc.page.margins.left, y0, pageW, 32).fill("#0F172A");
        doc.font("Helvetica-Bold").fontSize(13).fillColor("#FFFFFF")
            .text(title, doc.page.margins.left + 12, y0 + 7, { width: pageW - 24, lineBreak: false });
        doc.font("Helvetica").fontSize(9).fillColor("#C4B5FD")
            .text(`${monthLabel}   ${filterSummary || ""}`, doc.page.margins.left + 12, y0 + 19, { width: pageW - 24, lineBreak: false });
        doc.y = y0 + 34;
        doc.x = doc.page.margins.left;
    };
    drawHeader();

    // ── Scale columns to fit page width ──
    const totalW = columns.reduce((a, c) => a + (c.w || 60), 0);
    const scale = pageW / totalW;
    const widths = columns.map((c) => (c.w || 60) * scale);

    // ── Column header ──
    const drawColHeader = () => {
        const y0 = doc.y;
        let x = doc.page.margins.left;
        doc.rect(doc.page.margins.left, y0, pageW, 18).fill("#581C87");
        columns.forEach((c, i) => {
            doc.font("Helvetica-Bold").fontSize(8).fillColor("#FFFFFF")
                .text(c.label, x + 4, y0 + 5, { width: widths[i] - 8, align: c.num ? "right" : "left", lineBreak: false });
            x += widths[i];
        });
        doc.y = y0 + 18;
    };
    drawColHeader();

    const rowH = 14;
    const pageBottom = doc.page.height - doc.page.margins.bottom;

    rows.forEach((r, rowIdx) => {
        if (doc.y + rowH > pageBottom) {
            doc.addPage();
            drawHeader();
            drawColHeader();
        }
        const y0 = doc.y;
        const zebra = rowIdx % 2 === 0 ? "#FFFFFF" : "#F8FAFC";
        doc.rect(doc.page.margins.left, y0, pageW, rowH).fill(zebra);

        let x = doc.page.margins.left;
        columns.forEach((c, i) => {
            let val = r[c.key];
            if (val == null) val = "";
            if (typeof val !== "string") val = String(val);

            let color = c.color || "#111827";
            let bold = !!c.bold;

            if (c.colorize) {
                const statusColorMap = {
                    P: "#16A34A", "P*": "#CA8A04", "P~": "#EA580C", HD: "#D97706",
                    AB: "#DC2626", MP: "#DB2777", WO: "#2563EB",
                    FH: "#4F46E5", NH: "#4F46E5", OH: "#4F46E5", RH: "#4F46E5", PH: "#4F46E5",
                    "L-CL": "#7C3AED", "L-SL": "#7C3AED", "L-EL": "#7C3AED",
                    WFH: "#0891B2", CO: "#0D9488",
                };
                color = statusColorMap[r.status] || "#111827";
                bold = true;
            }

            doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8).fillColor(color)
                .text(val, x + 4, y0 + 3, { width: widths[i] - 8, align: c.num ? "right" : "left", lineBreak: false });
            x += widths[i];
        });
        // Bottom border
        doc.lineWidth(0.3).strokeColor("#E5E7EB")
            .moveTo(doc.page.margins.left, y0 + rowH)
            .lineTo(doc.page.margins.left + pageW, y0 + rowH)
            .stroke();
        doc.y = y0 + rowH;
    });

    if (rows.length === 0) {
        doc.moveDown(1);
        doc.font("Helvetica").fontSize(11).fillColor("#64748B")
            .text("No records match the selected filters.", { align: "center" });
    } else {
        // Footer row count
        doc.moveDown(0.5);
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#64748B")
            .text(`${rows.length} record${rows.length === 1 ? "" : "s"}  ·  Generated ${new Date().toLocaleString("en-IN")}`,
                { align: "right", width: pageW });
    }

    doc.end();
}

async function streamListReportExcel(res, { title, columns, rows, monthLabel, filterSummary }) {
    const wb = new ExcelJS.Workbook();
    wb.creator = "Grav Clothing HRMS";
    const ws = wb.addWorksheet(title.slice(0, 30), {
        views: [{ state: "frozen", ySplit: 4, showGridLines: false }],
        pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
    });

    const totalCols = columns.length;
    columns.forEach((c, i) => {
        ws.getColumn(i + 1).width = Math.max(8, (c.w || 60) / 5);
    });

    // Hero banner
    ws.mergeCells(1, 1, 1, totalCols);
    const hero = ws.getCell(1, 1);
    hero.value = {
        richText: [
            { text: "GRAV CLOTHING\n", font: { size: 9, bold: true, color: { argb: "FFE9D5FF" }, italic: true } },
            { text: title, font: { size: 16, bold: true, color: { argb: "FFFFFFFF" } } },
        ]
    };
    hero.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF581C87" } };
    hero.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    ws.getRow(1).height = 40;

    // Sub-banner
    ws.mergeCells(2, 1, 2, totalCols);
    const sub = ws.getCell(2, 1);
    sub.value = `${monthLabel}   ${filterSummary || ""}   ·   ${rows.length} record${rows.length === 1 ? "" : "s"}`;
    sub.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF0F172A" } };
    sub.font = { size: 9, color: { argb: "FFC4B5FD" } };
    sub.alignment = { vertical: "middle", horizontal: "center" };
    ws.getRow(2).height = 20;
    ws.getRow(3).height = 6;

    // Column header
    const headerRow = ws.getRow(4);
    columns.forEach((c, i) => {
        const cell = headerRow.getCell(i + 1);
        cell.value = c.label;
        cell.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F2937" } };
        cell.alignment = { horizontal: c.num ? "right" : "left", vertical: "middle", indent: c.num ? 0 : 1 };
        cell.border = {
            top: { style: "medium", color: { argb: "FF0F172A" } },
            bottom: { style: "medium", color: { argb: "FF0F172A" } },
            left: { style: "thin", color: { argb: "FF374151" } },
            right: { style: "thin", color: { argb: "FF374151" } },
        };
    });
    headerRow.height = 22;

    // Data rows
    rows.forEach((r, rowIdx) => {
        const row = ws.getRow(5 + rowIdx);
        columns.forEach((c, i) => {
            const cell = row.getCell(i + 1);
            let val = r[c.key];
            if (val == null) val = "";
            cell.value = typeof val === "number" ? val : String(val);

            let color = c.color ? c.color.replace("#", "FF") : "FF111827";
            let bold = !!c.bold;

            if (c.colorize) {
                const statusColorMap = {
                    P: "FF16A34A", "P*": "FFCA8A04", "P~": "FFEA580C", HD: "FFD97706",
                    AB: "FFDC2626", MP: "FFDB2777", WO: "FF2563EB",
                    FH: "FF4F46E5", NH: "FF4F46E5", OH: "FF4F46E5", RH: "FF4F46E5", PH: "FF4F46E5",
                    "L-CL": "FF7C3AED", "L-SL": "FF7C3AED", "L-EL": "FF7C3AED",
                    WFH: "FF0891B2", CO: "FF0D9488",
                };
                color = statusColorMap[r.status] || "FF111827";
                bold = true;
            }

            cell.font = { size: 9, bold, color: { argb: color } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowIdx % 2 === 0 ? "FFFFFFFF" : "FFF8FAFC" } };
            cell.alignment = { horizontal: c.num ? "right" : "left", vertical: "middle", indent: c.num ? 0 : 1 };
            cell.border = {
                top: { style: "thin", color: { argb: "FFE5E7EB" } },
                bottom: { style: "thin", color: { argb: "FFE5E7EB" } },
                left: { style: "thin", color: { argb: "FFE5E7EB" } },
                right: { style: "thin", color: { argb: "FFE5E7EB" } },
            };
        });
        row.height = 18;
    });

    if (rows.length === 0) {
        const r = ws.getRow(5);
        ws.mergeCells(5, 1, 5, totalCols);
        r.getCell(1).value = "No records match the selected filters.";
        r.getCell(1).font = { size: 11, italic: true, color: { argb: "FF64748B" } };
        r.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
        r.height = 40;
    }

    const filename = `${title.replace(/\s+/g, "_")}.xlsx`;
    const buffer = await wb.xlsx.writeBuffer();
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Cache-Control", "no-store");
    res.send(buffer);
}

// ─── Generic endpoint — handles all 9 list-style reports ──────────────────

router.post("/generate/:reportKey", EmployeeAuthMiddlewear, async (req, res) => {
    try {
        const { reportKey } = req.params;
        const def = REPORTS[reportKey];
        if (!def) return res.status(404).json({ success: false, message: `Unknown report: ${reportKey}` });

        const {
            yearMonth, format = "pdf", sortBy,
            allCompany, allDepartments, allEmployees, departments, employeeIds,
        } = req.body;
        if (!yearMonth) return res.status(400).json({ success: false, message: "yearMonth required" });

        const data = await buildMonthData({
            yearMonth,
            empFilter: { sortBy, allCompany, allDepartments, allEmployees, departments, employeeIds },
        });

        const rows = def.getRows(data);
        const filterSummary = buildFilterSummary({ allDepartments, departments, allEmployees, employeeIds, employeesTotal: data.employees.length });

        if (format === "excel") {
            await streamListReportExcel(res, { title: def.title, columns: def.columns, rows, monthLabel: data.monthLabel, filterSummary });
        } else {
            streamListReportPDF(res, { title: def.title, columns: def.columns, rows, monthLabel: data.monthLabel, filterSummary });
        }
    } catch (err) {
        console.error(`[REPORTS/${req.params.reportKey}]`, err.message, err.stack);
        res.status(500).json({ success: false, message: err.message });
    }
});

function buildFilterSummary({ allDepartments, departments, allEmployees, employeeIds, employeesTotal }) {
    const parts = [];
    if (allDepartments || !departments?.length) parts.push("All Departments");
    else parts.push(`${departments.length} Department${departments.length === 1 ? "" : "s"}`);
    if (allEmployees || !employeeIds?.length) parts.push(`All Employees (${employeesTotal})`);
    else parts.push(`${employeeIds.length} Employee${employeeIds.length === 1 ? "" : "s"}`);
    return parts.join("  ·  ");
}

// List of available report types (for frontend to render radio options)
router.get("/types", EmployeeAuthMiddlewear, (req, res) => {
    const types = [
        { key: "month-performance", label: "Month Performance", description: "Per-employee detailed block (IN/OUT/Work/Break/OT/Status for each day)" },
        { key: "month-absent", label: "Month Absent", description: "All absent days across selected employees" },
        { key: "month-in-out", label: "Month IN/OUT", description: "Daily in/out timings with work & break hours" },
        { key: "month-summary", label: "Month Summary", description: "One row per employee — P, L, HD, MP, A, WO, HL, LV totals" },
        { key: "month-early-out", label: "Month Early Out", description: "Days where employee left before shift end" },
        { key: "month-overtime", label: "Month Overtime", description: "Days with OT worked, hours logged" },
        { key: "month-miss-punch", label: "Month Miss Punch", description: "Days with missing or incomplete punch data" },
        { key: "month-half-day", label: "Month Half Day", description: "All half-day entries with reason" },
        { key: "month-coff", label: "Month Comp Off", description: "Comp-off granted and eligible days (Sunday/Holiday worked)" },
        { key: "month-special", label: "Month Special", description: "HR overrides, leaves, WFH, Comp Off — anything needing attention" },
    ];
    res.json({ success: true, types });
});

module.exports = router;
module.exports.buildMonthData = buildMonthData;   // for reuse in part B
module.exports.fmtTime = fmtTime;
module.exports.fmtHM = fmtHM;
module.exports.drawCell = drawCell;
module.exports.drawSplitCell = drawSplitCell;
module.exports.applyBorders = applyBorders;