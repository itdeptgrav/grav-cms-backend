"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const { Payroll, PayrollItem } = require("../../models/HR_Models/Payroll");
const PayrollSettings = require("../../models/HR_Models/Payrollsettings");
const Employee = require("../../models/Employee");
const SalaryConfig = require("../../models/Salaryconfig");
const DailyAttendance = require("../../models/HR_Models/Dailyattendance");
// Push notifications — single fan-out to mobile (Expo) + web (FCM).
// Fire-and-forget: never awaited, never able to fail the payroll request.
const { notifyPayslipPublished } = require("../../utils/notifyEmployee");
const {
  CompanyHoliday,
  LeaveBalance,
  LeaveConfig,
} = require("../../models/HR_Models/LeaveManagement");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const {
  decryptSalaryFields,
  decryptEmployeeDoc,
} = require("../../utils/salaryEncryption");

const MONTH_NAMES = [
  "",
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const PAID_CODES = new Set([
  "P",
  "P*",
  "P~",
  "MP",
  "WO",
  "FH",
  "NH",
  "OH",
  "RH",
  "PH",
  "L-CL",
  "L-SL",
  "L-EL",
  "WFH",
  "CO",
]);
const LEAVE_CODES_PAID = new Set(["L-CL", "L-SL", "L-EL"]);
const HOLIDAY_CODES = new Set(["FH", "NH", "OH", "RH", "PH"]);

const HOLIDAY_TYPE_TO_CODE = {
  national: "NH",
  company: "FH",
  optional: "OH",
  restricted: "RH",
};

// ─── DOJ HELPERS ─────────────────────────────────────────────────────────────

function parseDOJ(val) {
  if (!val) return null;
  const d = val instanceof Date ? val : new Date(val);
  if (isNaN(d.getTime())) return null;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function firstActiveDayOfMonth(dateOfJoining, month, year, daysInMonth) {
  const doj = parseDOJ(dateOfJoining);
  if (!doj) return 1;

  const dojYear = doj.getFullYear();
  const dojMonth = doj.getMonth() + 1;
  const dojDay = doj.getDate();

  if (dojYear < year || (dojYear === year && dojMonth < month)) return 1;
  if (dojYear > year || (dojYear === year && dojMonth > month))
    return daysInMonth + 1;
  return dojDay;
}

function calendarDaysSinceDOJ(dateOfJoining, month, year) {
  const doj = parseDOJ(dateOfJoining);
  if (!doj) return Infinity;
  const endOfMonth = new Date(year, month, 0);
  if (doj > endOfMonth) return 0;
  const msPerDay = 86400000;
  return Math.floor((endOfMonth - doj) / msPerDay) + 1;
}

// ── ESI eligibility ──────────────────────────────────────────────────────────
//  Eligibility is a property of the EMPLOYEE'S WAGE RATE, not of how much they
//  happened to earn in one month. It must therefore be tested against the FULL
//  monthly basic (employee.salary.basic), exactly like the Employee form's own
//  pre-save calculation in models/Employee.js does.
//
//  Testing it against the prorated `basicEarned` was a real bug: an employee on
//  a ₹25,000 basic (well over the ₹21,000 ceiling, correctly shown as "Not
//  applicable" in the Employee form) who was paid for only 12 of 31 days earned
//  a basic of ₹9,678 — under the ceiling — and so silently became ESI-liable
//  for that one month. Mid-month joiners and anyone with LOP were affected;
//  full-month employees on the same salary were not, which is why it looked
//  arbitrary across the list.
//
//  The contribution AMOUNT stays on the earned basic — contributions are on
//  wages actually paid — but whether there is a contribution at all is decided
//  by the full basic. Both figures are returned so callers never re-derive one
//  without the other.
function computeEsi(fullBasic, basicEarned, salaryCfg) {
  const esiLimit = salaryCfg?.esiWageLimit ?? 21000;
  const eeEsicPct = (salaryCfg?.eeEsicPct ?? 0.75) / 100;
  const erEsicPct = (salaryCfg?.erEsicPct ?? 3.25) / 100;

  const rateBasic = Number(fullBasic) || 0;
  const earned = Number(basicEarned) || 0;
  const applicable = rateBasic > 0 && rateBasic <= esiLimit && earned > 0;

  return {
    applicable,
    esic: applicable ? Math.ceil(earned * eeEsicPct) : 0,
    erEsic: applicable ? Math.ceil(earned * erEsicPct) : 0,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
//  ENGINE
// ═════════════════════════════════════════════════════════════════════════════

function computeEmployeePayroll(employee, ctx) {
  const {
    month,
    year,
    settings,
    salaryCfg,
    holidayMap,
    attendanceByDate,
    leaveBalance,
    leaveConfig,
  } = ctx;
  const daysInMonth = new Date(year, month, 0).getDate();

  const firstActiveDay = firstActiveDayOfMonth(
    employee.dateOfJoining,
    month,
    year,
    daysInMonth,
  );
  const preJoiningDays = Math.max(0, firstActiveDay - 1);
  const activeDaysInMonth = daysInMonth - preJoiningDays;

  const daysSinceDOJ = calendarDaysSinceDOJ(
    employee.dateOfJoining,
    month,
    year,
  );

  // An intern is paid a stipend, and that is the whole of their arrangement.
  // Two things follow, and both are enforced below rather than trusted to the
  // caller: they accrue no leave, and their pay has no statutory components.
  const isIntern = employee.employmentType === "intern";

  // Employees become eligible for casual leave 24 days after joining. Interns
  // never do — no CL, no SL, no PL, and so nothing for the auto-adjustment
  // below to spend. An absence is simply an unpaid day.
  //
  // This kills the automatic machinery only. A day HR has explicitly marked
  // L-CL on an intern's attendance is still honoured as paid, because that is
  // a decision somebody made and recorded, not an entitlement being accrued.
  const clEligible = !isIntern && daysSinceDOJ >= 24;

  const CL_ENT_DEFAULT = leaveConfig?.clPerYear ?? 12;
  const SL_ENT_DEFAULT = leaveConfig?.slPerYear ?? 12;
  const PL_ENT_DEFAULT = leaveConfig?.plPerYear ?? 15;

  const stats = {
    daysInMonth,
    presentDays: 0,
    halfDays: 0,
    missPunchDays: 0,
    absentDays: 0,
    lwpDays: 0,
    weekOffDays: 0,
    workingSundayDays: 0,
    holidayDays: 0,
    holidayWorkedDays: 0,
    paidLeaveDays: 0,
    clUsedDays: 0,
    slUsedDays: 0,
    plUsedDays: 0,
    autoAdjustedCL: 0,
    sundayOffsetApplied: 0,
    unsyncedDays: 0,
  };

  const dayBreakdown = [];
  let payableDays = 0;
  let lopDays = 0;

  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const dt = new Date(dateStr + "T00:00:00");
    const dow = dt.getDay();

    if (d < firstActiveDay) {
      dayBreakdown.push({
        dateStr,
        dayOfWeek: dow,
        category: "PRE-JOINING",
        paid: false,
        lopWeight: 0,
        note: "Before date of joining — excluded",
        isDeclaredHoliday: false,
        isSundayOff: false,
        isWorkingSunday: false,
        rawStatus: null,
        netWorkMins: 0,
        otMins: 0,
        lateMins: 0,
        inTime: null,
        finalOut: null,
        preJoining: true,
      });
      continue;
    }

    const hol = holidayMap.get(dateStr);
    const isWorkingSunday = hol && hol.type === "working_sunday";
    const isDeclaredHoliday = hol && hol.type !== "working_sunday";
    const isSundayOff = dow === 0 && !isWorkingSunday;
    const entry = attendanceByDate.get(dateStr);

    let category = null;
    let paid = false;
    let lopWeight = 0;
    let note = "";

    if (entry) {
      const rawStatus = entry.hrFinalStatus || entry.systemPrediction || "AB";
      switch (rawStatus) {
        case "P":
        case "P*":
        case "P~":
          category = rawStatus;
          paid = true;
          if (isSundayOff) stats.workingSundayDays++;
          if (isDeclaredHoliday) stats.holidayWorkedDays++;
          break;
        case "HD":
          category = "HD";
          paid = true;
          lopWeight = 0.5;
          break;
        case "MP":
          if (settings.mpTreatment === "absent") {
            category = "AB";
            lopWeight = 1;
            note = "MP treated as absent";
          } else if (settings.mpTreatment === "half_day") {
            category = "HD";
            paid = true;
            lopWeight = 0.5;
            note = "MP treated as HD";
          } else {
            category = "MP";
            paid = true;
          }
          break;
        case "WO":
          category = "WO";
          paid = true;
          break;
        case "FH":
        case "NH":
        case "OH":
        case "RH":
        case "PH":
          category = rawStatus;
          paid = true;
          break;
        case "L-CL":
          category = "L-CL";
          paid = true;
          stats.clUsedDays++;
          break;
        case "L-SL":
          category = "L-SL";
          paid = true;
          stats.slUsedDays++;
          break;
        case "L-EL":
          category = "L-EL";
          paid = true;
          stats.plUsedDays++;
          break;
        // ── Half-day Present + Half-day Leave variants ─────────────────
        // P/CL, P/SL, P/PL: employee is paid for the FULL day (the leave
        // covers the missing half). 0.5 is consumed from the relevant
        // leave bucket — that's already deducted from LeaveBalance at the
        // /day-override step, so here we only record the usage for the
        // payslip / salary register breakdown.
        case "P/CL":
          category = "P/CL";
          paid = true;
          lopWeight = 0;
          stats.clUsedDays += 0.5;
          break;
        case "P/SL":
          category = "P/SL";
          paid = true;
          lopWeight = 0;
          stats.slUsedDays += 0.5;
          break;
        case "P/PL":
          category = "P/PL";
          paid = true;
          lopWeight = 0;
          stats.plUsedDays += 0.5;
          break;
        // P/LWP: employee present for half the day, the other half is
        // unpaid (LOP). lopWeight=0.5 means payableDays gets +0.5 and
        // lopDays gets +0.5 — gross is reduced by half a day's pay.
        case "P/LWP":
          category = "P/LWP";
          paid = true;
          lopWeight = 0.5;
          stats.lwpDays += 0.5;
          break;
        case "WFH":
        case "CO":
          category = rawStatus;
          paid = true;
          break;
        case "LWP":
          category = "LWP";
          lopWeight = 1;
          break;
        case "AB":
        default:
          category = "AB";
          lopWeight = 1;
          break;
      }
    } else {
      if (isDeclaredHoliday) {
        category = HOLIDAY_TYPE_TO_CODE[hol.type] || "PH";
        paid = true;
      } else if (isSundayOff) {
        category = "WO";
        paid = true;
      } else if (dt > new Date()) {
        category = "—";
        note = "future";
      } else {
        category = "AB";
        lopWeight = 1;
        note = "no attendance data";
        stats.unsyncedDays++;
      }
    }

    if (["P", "P*", "P~", "MP"].includes(category)) stats.presentDays++;
    // Half-day variants count as Present (employee was there for half the day).
    else if (
      category === "P/CL" ||
      category === "P/SL" ||
      category === "P/PL" ||
      category === "P/LWP"
    )
      stats.presentDays++;
    else if (category === "HD") stats.halfDays++;
    else if (category === "AB") stats.absentDays++;
    else if (category === "WO") stats.weekOffDays++;
    else if (category === "LWP") stats.lwpDays++;
    else if (HOLIDAY_CODES.has(category)) stats.holidayDays++;
    else if (
      LEAVE_CODES_PAID.has(category) ||
      ["WFH", "CO"].includes(category)
    ) {
      stats.paidLeaveDays++;
    }
    // Half-CL/SL/PL count under paidLeaveDays as 0.5 each — the day is also
    // counted as Present (above), and these together describe the split.
    if (category === "P/CL" || category === "P/SL" || category === "P/PL") {
      stats.paidLeaveDays += 0.5;
    }

    if (category && category !== "—") {
      if (paid) payableDays += 1 - lopWeight;
      if (lopWeight > 0) lopDays += lopWeight;
    }

    dayBreakdown.push({
      dateStr,
      dayOfWeek: dow,
      category,
      paid,
      lopWeight,
      note,
      isDeclaredHoliday,
      isSundayOff,
      isWorkingSunday,
      rawStatus: entry?.hrFinalStatus || entry?.systemPrediction || null,
      netWorkMins: entry?.netWorkMins || 0,
      otMins: entry?.otMins || 0,
      lateMins: entry?.lateMins || 0,
      inTime: entry?.inTime || null,
      finalOut: entry?.finalOut || null,
    });
  }

  // ── Sunday Offsets ────────────────────────────────────────────────────────
  if (
    settings.sundayOffsetsAbsence &&
    stats.workingSundayDays > 0 &&
    stats.absentDays > 0
  ) {
    const offsetCount = Math.min(stats.workingSundayDays, stats.absentDays);
    stats.sundayOffsetApplied = offsetCount;
    stats.absentDays -= offsetCount;
    payableDays += offsetCount;
    lopDays -= offsetCount;

    let remaining = offsetCount;
    for (const day of dayBreakdown) {
      if (remaining <= 0) break;
      if (day.category === "AB" && !day.preJoining) {
        day.category = "AB-OFFSET";
        day.paid = true;
        day.lopWeight = 0;
        day.note = "Offset by Sunday worked (comp off)";
        day.sundayOffsetApplied = true;
        remaining--;
      }
    }
  }

  // ── CL Auto-Adjustment ────────────────────────────────────────────────────
  if (clEligible && settings.clAutoAdjust?.enabled && stats.absentDays > 0) {
    const consumeFromBalance =
      settings.clAutoAdjust.consumeFromBalance !== false;
    const maxCLPerMonth = settings.clAutoAdjust.maxABForAdjustment ?? 2;

    let clAvailable;
    if (!consumeFromBalance) {
      clAvailable = Infinity;
    } else {
      const clEntitlement = leaveBalance
        ? (leaveBalance.entitlement?.CL ?? 0)
        : CL_ENT_DEFAULT;
      const clConsumed = leaveBalance?.consumed?.CL ?? 0;
      clAvailable = Math.max(0, clEntitlement - clConsumed);
    }

    const daysToAdjust = Math.min(stats.absentDays, maxCLPerMonth, clAvailable);

    if (daysToAdjust > 0) {
      stats.autoAdjustedCL = daysToAdjust;
      stats.paidLeaveDays += daysToAdjust;
      stats.clUsedDays += daysToAdjust;
      stats.absentDays -= daysToAdjust;
      payableDays += daysToAdjust;
      lopDays -= daysToAdjust;

      let remaining = daysToAdjust;
      for (const day of dayBreakdown) {
        if (remaining <= 0) break;
        if (day.category === "AB" && !day.preJoining) {
          day.category = "L-CL";
          day.paid = true;
          day.lopWeight = 0;
          day.note = "Auto-adjusted from AB (monthly CL cap)";
          day.autoAdjusted = true;
          remaining--;
        }
      }
    }
  }

  const divisor = daysInMonth;

  // For an intern the stipend IS the gross: one figure, prorated the same way
  // as a salary so a month with absences pays less, and no basic/HRA split
  // because there is nothing to split. An unpaid or self-paid internship has
  // no stipend, so every figure below falls out as zero on its own — they
  // still get a row, with their attendance on it, and a payout of nothing.
  const fullGross = isIntern
    ? Number(employee.salary?.stipend || 0)
    : Number(employee.salary?.gross || 0);
  const fullBasic = isIntern ? 0 : Number(employee.salary?.basic || 0);
  const fullHra = isIntern ? 0 : Number(employee.salary?.hra || 0);

  const perDayRate = fullGross / Math.max(1, divisor);

  let sundayExtraPayDays = 0;
  if (settings.sundayWorkExtraPay && stats.workingSundayDays > 0) {
    sundayExtraPayDays = stats.workingSundayDays;
  }

  const effectivePayableDays = payableDays + sundayExtraPayDays;

  const grossEarned = roundMoney(
    perDayRate * effectivePayableDays,
    settings.roundingMode,
  );

  const basicRatio = fullGross > 0 ? fullBasic / fullGross : 0.5;
  const hraRatio = fullGross > 0 ? fullHra / fullGross : 0.5;

  // The 0.5 fallbacks above are for an employee with no gross on file. An
  // intern always has fullBasic 0, and must not inherit that fallback: it
  // would split their stipend into a basic and an HRA that do not exist, and
  // the basic is what every deduction below is computed from.
  const basicEarned = isIntern
    ? 0
    : roundMoney(grossEarned * basicRatio, settings.roundingMode);
  const hraEarned = isIntern ? 0 : grossEarned - basicEarned;
  const specialEarned = 0;

  const epfCap = salaryCfg?.epfCapAmount ?? 1800;
  const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;

  // EPF — respect the HR per-employee override stored on the employee's
  // salary. When epfOverride is set, the HR-entered monthly EPF is treated as
  // the full-month figure and prorated by the same ratio the earned gross
  // bears to the full gross (so LOP days reduce it proportionally, like every
  // other earned figure). When not overridden, it's the usual statutory
  // ROUND(MIN(earned basic * 12%, cap)).
  const epfOverridden = !isIntern && !!employee.salary?.epfOverride;
  const overrideEpfFull = Number(employee.salary?.epf || 0);
  const earnedRatio = fullGross > 0 ? grossEarned / fullGross : 1;

  // Nothing is deducted from a stipend. An intern is not enrolled in the
  // provident fund or in ESI, so a deduction here would not be a smaller
  // payout — it would be money withheld and remitted to a scheme that has no
  // record of them.
  //
  // Note computeEsi would return zero for an intern anyway, since it tests
  // the full basic and theirs is zero. It is short-circuited regardless: the
  // reason it must not apply is the enrolment, not the arithmetic, and a
  // future change to that function should not be able to start deducting.
  const epf = isIntern
    ? 0
    : epfOverridden
      ? Math.round(overrideEpfFull * earnedRatio)
      : Math.round(Math.min(basicEarned * eepfPct, epfCap));
  // Eligibility on the FULL basic, amount on the earned basic — see computeEsi.
  const { esic, erEsic } = isIntern
    ? { esic: 0, erEsic: 0 }
    : computeEsi(fullBasic, basicEarned, salaryCfg);
  const pt =
    !isIntern && settings.ptEnabled && settings.ptForBasic
      ? settings.ptForBasic(basicEarned)
      : 0;

  // ── Other deduction ───────────────────────────────────────────────────────
  // A standing monthly recovery — canteen, transport, whatever the company
  // takes back. Charged for the days they were THERE, so a week of leave is a
  // week not charged: nobody eats the canteen food they are on leave from.
  //
  // Approved leave only. CL, SL, PL and LWP are days somebody arranged to be
  // away, and the arrangement is what makes the charge unfair. An unexplained
  // absence is not an arrangement, so it is still charged — which also means
  // the deduction cannot be dodged by simply not turning up.
  //
  // The divisor is the real length of the month, the same one the gross uses
  // above, so a February deduction and a February salary are prorated
  // identically. Sundays, week-offs and holidays are charged: the month is
  // the month.
  const otherDeductionFull = Number(employee.salary?.otherDeduction || 0);
  const approvedLeaveDays =
    stats.clUsedDays + stats.slUsedDays + stats.plUsedDays + stats.lwpDays;
  const chargeableDays = Math.max(0, daysInMonth - approvedLeaveDays);
  const otherDeduction =
    otherDeductionFull > 0
      ? roundMoney(
          (otherDeductionFull * chargeableDays) / Math.max(1, daysInMonth),
          settings.roundingMode,
        )
      : 0;

  const totalDeductions = epf + esic + pt + otherDeduction;
  const netPay = grossEarned - totalDeductions;
  const roundedNetPay = settings.roundNetPay ? Math.round(netPay) : netPay;

  const leaveBalanceSnapshot = (() => {
    // Interns have no leave to report. Returning the usual shape with zeros —
    // rather than the default 12/12/15 entitlements — is what stops the
    // payslip and the salary register showing an intern a CL balance they can
    // never take.
    if (isIntern) {
      return {
        hasRecord: false,
        clEligible: false,
        daysSinceDOJ: daysSinceDOJ === Infinity ? null : daysSinceDOJ,
        entitlement: { CL: 0, SL: 0, PL: 0 },
        consumed: { CL: 0, SL: 0, PL: 0 },
        available: { CL: 0, SL: 0, PL: 0 },
      };
    }
    const clEnt = clEligible
      ? (leaveBalance?.entitlement?.CL ?? CL_ENT_DEFAULT)
      : 0;
    const slEnt = leaveBalance?.entitlement?.SL ?? SL_ENT_DEFAULT;
    const plEnt =
      leaveBalance?.entitlement?.PL ??
      leaveBalance?.entitlement?.EL ??
      PL_ENT_DEFAULT;
    const clCon = leaveBalance?.consumed?.CL ?? 0;
    const slCon = leaveBalance?.consumed?.SL ?? 0;
    const plCon = leaveBalance?.consumed?.PL ?? leaveBalance?.consumed?.EL ?? 0;
    return {
      hasRecord: !!leaveBalance,
      clEligible,
      daysSinceDOJ: daysSinceDOJ === Infinity ? null : daysSinceDOJ,
      entitlement: { CL: clEnt, SL: slEnt, PL: plEnt },
      consumed: { CL: clCon, SL: slCon, PL: plCon },
      available: {
        CL: Math.max(0, clEnt - clCon),
        SL: Math.max(0, slEnt - slCon),
        PL: Math.max(0, plEnt - plCon),
      },
    };
  })();

  return {
    employeeId: employee._id,
    employeeName: [employee.firstName, employee.middleName, employee.lastName]
      .filter(Boolean)
      .join(" "),
    biometricId: (employee.biometricId || "").toUpperCase(),
    department: employee.department || "",
    designation: employee.designation || employee.jobTitle || "",
    jobTitle: employee.jobTitle || "",
    employmentType: employee.employmentType || "",
    // Carried on the item, not re-derived from employmentType at read time.
    // A payroll run is a record of what was paid and why, and the employee's
    // type can change after it — an intern promoted in April must not make
    // their March payslip re-render as a salaried one.
    isIntern,
    internshipType: isIntern
      ? employee.internship?.stipendType || "paid"
      : undefined,
    dateOfJoining: employee.dateOfJoining || null,

    month,
    year,
    payPeriod: `${MONTH_NAMES[month]} ${year}`,

    rateBasic: fullBasic,
    rateHra: fullHra,
    rateGross: fullGross,

    preJoiningDays,
    firstActiveDayInMonth: firstActiveDay,
    activeDaysInMonth,
    clEligible,
    daysSinceDOJ: daysSinceDOJ === Infinity ? null : daysSinceDOJ,

    leaveBalanceSnapshot,

    workingDays: divisor,
    daysInMonth,
    presentDays: stats.presentDays,
    absentDays: stats.absentDays,
    halfDays: stats.halfDays,
    missPunchDays: stats.missPunchDays,
    lopDays,
    paidLeaveDays: stats.paidLeaveDays,
    weekOffDays: stats.weekOffDays,
    holidayDays: stats.holidayDays,
    holidayWorkedDays: stats.holidayWorkedDays,
    sundayWorkedDays: stats.workingSundayDays,
    lwpDays: stats.lwpDays,
    autoAdjustedCL: stats.autoAdjustedCL,
    sundayOffsetApplied: stats.sundayOffsetApplied,
    unsyncedDays: stats.unsyncedDays,
    clUsedDays: stats.clUsedDays,
    slUsedDays: stats.slUsedDays,
    plUsedDays: stats.plUsedDays,

    // The working behind otherDeductions, so the payroll drawer can show why
    // the figure is what it is rather than presenting a bare number.
    otherDeductionFull,
    otherDeductionRecurring: otherDeduction,
    otherDeductionLeaveDays: +approvedLeaveDays.toFixed(2),
    otherDeductionChargeableDays: +chargeableDays.toFixed(2),

    payableDays: +payableDays.toFixed(2),
    effectivePayableDays: +effectivePayableDays.toFixed(2),
    sundayExtraPayDays,
    perDayRate: +perDayRate.toFixed(2),
    divisorBasis: settings.payableDaysBasis,

    earnings: {
      // Exactly one of stipend and basicSalary is ever non-zero. Keeping them
      // as separate fields rather than reusing basicSalary is what lets the
      // payslip print "Stipend" instead of "Basic Salary" — an intern's
      // payslip claiming a basic would misdescribe their arrangement.
      stipend: isIntern ? grossEarned : 0,
      basicSalary: basicEarned,
      houseRentAllowance: hraEarned,
      travelAllowance: 0,
      medicalAllowance: 0,
      specialAllowance: specialEarned,
      overtime: 0,
      bonus: 0,
      incentives: 0,
      otherEarnings: 0,
      grossEarnings: grossEarned,
    },
    deductions: {
      providentFund: epf,
      employerPF: epf,
      esic: esic,
      employerESIC: erEsic,
      professionalTax: pt,
      incomeTax: 0,
      loanDeduction: 0,
      advanceDeduction: 0,
      lateDeduction: 0,
      otherDeductions: otherDeduction,
      totalDeductions,
    },
    netPay,
    roundedNetPay,

    bankDetails: {
      bankName: employee.bankDetails?.bankName || "",
      accountNumber: employee.bankDetails?.accountNumber || "",
      ifscCode: employee.bankDetails?.ifscCode || "",
    },

    dayBreakdown,
  };
}

function roundMoney(n, mode = "round") {
  if (!isFinite(n)) return 0;
  if (mode === "ceil") return Math.ceil(n);
  if (mode === "floor") return Math.floor(n);
  return Math.round(n);
}

// ═════════════════════════════════════════════════════════════════════════════
//  DATA LOADERS
// ═════════════════════════════════════════════════════════════════════════════

async function loadMonthContext(month, year) {
  const yearMonth = `${year}-${String(month).padStart(2, "0")}`;
  const leaveConfigP =
    LeaveConfig && typeof LeaveConfig.getConfig === "function"
      ? LeaveConfig.getConfig().catch(() => null)
      : Promise.resolve(null);

  const [settings, salaryCfg, dayDocs, holidays, leaveConfig] =
    await Promise.all([
      PayrollSettings.getConfig(),
      SalaryConfig.getSingleton(),
      DailyAttendance.find({ yearMonth }).lean(),
      CompanyHoliday.find({
        date: {
          $gte: `${yearMonth}-01`,
          $lte: `${yearMonth}-${new Date(year, month, 0).getDate()}`,
        },
      }).lean(),
      leaveConfigP,
    ]);

  const holidayMap = new Map(holidays.map((h) => [h.date, h]));
  const attendanceByEmp = new Map();
  for (const doc of dayDocs) {
    for (const emp of doc.employees || []) {
      const bid = String(emp.biometricId || "").toUpperCase();
      if (!bid) continue;
      if (!attendanceByEmp.has(bid)) attendanceByEmp.set(bid, new Map());
      attendanceByEmp.get(bid).set(doc.dateStr, emp);
    }
  }

  return { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig };
}

// ═══════════════════════════════════════════════════════════════════════════
//  NOTE: `sendPayrollPushNotifications` used to live here (~285 lines).
//  It was a hand-rolled duplicate of utils/sendExpoPush.js — same Expo
//  chunking, same FCM send, same stale-token cleanup. Payroll notifications
//  now go through utils/notifyEmployee.js like every other domain, so there is
//  one fan-out to maintain instead of two. Its `type: "generated"` branch was
//  dead code: the only caller (PATCH /mark-paid) always passed "paid".
// ═══════════════════════════════════════════════════════════════════════════

// ═════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// ── GET /preview ──────────────────────────────────────────────────────────────
router.get("/preview", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    if (month < 1 || month > 12) {
      return res.status(400).json({ success: false, message: "Invalid month" });
    }

    const { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig } =
      await loadMonthContext(month, year);

    const employees = await Employee.find({
      $or: [{ status: "active" }, { isActive: true }],
    })
      .select("-password -temporaryPassword -__v")
      .lean();

    const decryptedEmployees = employees.map(decryptEmployeeDoc);

    const leaveBalances = await LeaveBalance.find({
      employeeId: { $in: employees.map((e) => e._id) },
      year,
    }).lean();
    const balanceByEmpId = new Map(
      leaveBalances.map((b) => [String(b.employeeId), b]),
    );

    const items = decryptedEmployees.map((emp) => {
      const bid = (emp.biometricId || "").toUpperCase();
      const ctx = {
        month,
        year,
        settings,
        salaryCfg,
        holidayMap,
        leaveConfig,
        attendanceByDate: attendanceByEmp.get(bid) || new Map(),
        leaveBalance: balanceByEmpId.get(String(emp._id)) || null,
      };
      return computeEmployeePayroll(emp, ctx);
    });

    const summary = items.reduce(
      (acc, i) => ({
        totalEmployees: acc.totalEmployees + 1,
        totalGross: acc.totalGross + i.earnings.grossEarnings,
        totalDeductions: acc.totalDeductions + i.deductions.totalDeductions,
        totalNetPay: acc.totalNetPay + i.roundedNetPay,
        totalPF: acc.totalPF + i.deductions.providentFund,
        totalESIC: acc.totalESIC + i.deductions.esic,
        totalLOPDays: acc.totalLOPDays + i.lopDays,
        autoAdjustedCount:
          acc.autoAdjustedCount + (i.autoAdjustedCL > 0 ? 1 : 0),
        unsyncedCount: acc.unsyncedCount + (i.unsyncedDays > 0 ? 1 : 0),
      }),
      {
        totalEmployees: 0,
        totalGross: 0,
        totalDeductions: 0,
        totalNetPay: 0,
        totalPF: 0,
        totalESIC: 0,
        totalLOPDays: 0,
        autoAdjustedCount: 0,
        unsyncedCount: 0,
      },
    );

    const existingRun = await Payroll.findOne({ month, year }).lean();

    res.json({
      success: true,
      data: {
        month,
        year,
        payPeriod: `${MONTH_NAMES[month]} ${year}`,
        settings: {
          payableDaysBasis: settings.payableDaysBasis,
          clAutoAdjust: settings.clAutoAdjust,
          mpTreatment: settings.mpTreatment,
          sundayWorkExtraPay: settings.sundayWorkExtraPay,
        },
        summary,
        items,
        existingRun: existingRun
          ? {
              id: existingRun._id,
              status: existingRun.status,
              processedAt: existingRun.processedAt,
            }
          : null,
      },
    });
  } catch (err) {
    console.error("[PAYROLL-PREVIEW]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── POST /run ─────────────────────────────────────────────────────────────────
router.post("/run", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Only HR managers can run payroll" });
    }

    const month = parseInt(req.body.month) || new Date().getMonth() + 1;
    const year = parseInt(req.body.year) || new Date().getFullYear();

    const existing = await Payroll.findOne({ month, year });
    if (existing && ["paid", "approved"].includes(existing.status)) {
      return res.status(400).json({
        success: false,
        message: `Payroll for ${MONTH_NAMES[month]} ${year} is already ${existing.status} and cannot be re-run`,
      });
    }

    // ── DRAFT PROMOTION ────────────────────────────────────────────────────
    // If HR saved a draft and then clicks Process Payroll, we MUST NOT
    // recompute from scratch — that would wipe every edit, removal, and
    // balance adjustment they made in draft mode.
    //
    // Instead: promote the existing draft items as-is, consume any pending
    // CL balance adjustments that were deferred at save-draft time, update
    // the run header to "processed", and return immediately.
    //
    // The full recompute below only runs when there is NO draft at all
    // (e.g. HR skipped straight from Preview → Process without saving draft).
    if (existing && existing.status === "draft") {
      const draftItems = await PayrollItem.find({ month, year }).lean();

      // Consume CL leave balances — deferred from save-draft so edits in
      // draft don't double-consume before HR finalises.
      const settings = await PayrollSettings.getConfig();
      if (
        settings.clAutoAdjust?.enabled &&
        settings.clAutoAdjust?.consumeFromBalance
      ) {
        for (const it of draftItems) {
          if ((it.autoAdjustedCL || 0) > 0) {
            await LeaveBalance.updateOne(
              { employeeId: it.employeeId, year },
              { $inc: { "consumed.CL": it.autoAdjustedCL } },
            );
          }
        }
      }

      // Promote all pending items to processed.
      // Items HR removed from the draft are already deleted from DB —
      // this only touches the surviving items.
      await PayrollItem.updateMany(
        { month, year, status: "pending" },
        { $set: { status: "processed" } },
      );

      // Recompute run-level totals from the surviving (possibly edited) items.
      // We do this from the items themselves — not from the draft header —
      // because HR may have edited individual items since the draft was saved.
      const totals = draftItems.reduce(
        (acc, i) => ({
          g: acc.g + (i.earnings?.grossEarnings || 0),
          d: acc.d + (i.deductions?.totalDeductions || 0),
          n: acc.n + (i.roundedNetPay || 0),
          pf: acc.pf + (i.deductions?.providentFund || 0),
          esi: acc.esi + (i.deductions?.esic || 0),
          b: acc.b + (i.earnings?.bonus || 0),
        }),
        { g: 0, d: 0, n: 0, pf: 0, esi: 0, b: 0 },
      );

      existing.status = "processed";
      existing.totalEmployees = draftItems.length;
      existing.totalGross = totals.g;
      existing.totalDeductions = totals.d;
      existing.totalNetPay = totals.n;
      existing.totalPF = totals.pf;
      existing.totalESIC = totals.esi;
      existing.totalBonus = totals.b;
      existing.processedAt = new Date();
      await existing.save();

      return res.json({
        success: true,
        message: `Payroll processed for ${draftItems.length} employees`,
        data: {
          runId: existing._id,
          summary: {
            totalEmployees: draftItems.length,
            totalGross: totals.g,
            totalDeductions: totals.d,
            totalNetPay: totals.n,
            totalPF: totals.pf,
            totalESIC: totals.esi,
            clAdjustmentsApplied: 0,
          },
        },
      });
    }
    // ── END DRAFT PROMOTION ────────────────────────────────────────────────
    // No draft exists → fall through to full recompute (first-time processing
    // straight from Preview without going through Save Draft).

    const { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig } =
      await loadMonthContext(month, year);

    const employees = await Employee.find({
      $or: [{ status: "active" }, { isActive: true }],
    })
      .select("-password -temporaryPassword -__v")
      .lean();

    const decryptedEmployees = employees.map(decryptEmployeeDoc);

    const leaveBalances = await LeaveBalance.find({
      employeeId: { $in: employees.map((e) => e._id) },
      year,
    });
    const balanceByEmpId = new Map(
      leaveBalances.map((b) => [String(b.employeeId), b]),
    );

    let payrollRun = existing;
    if (!payrollRun) {
      payrollRun = await Payroll.create({
        month,
        year,
        payPeriod: `${MONTH_NAMES[month]} ${year}`,
        status: "processing",
        createdBy: user.id,
      });
    } else {
      payrollRun.status = "processing";
      await payrollRun.save();
    }

    let totalGross = 0,
      totalDed = 0,
      totalNet = 0,
      totalPF = 0,
      totalESIC = 0,
      totalBonus = 0;
    const clBalanceUpdates = [];

    for (const emp of decryptedEmployees) {
      const bid = (emp.biometricId || "").toUpperCase();
      const balance = balanceByEmpId.get(String(emp._id)) || null;
      const ctx = {
        month,
        year,
        settings,
        salaryCfg,
        holidayMap,
        leaveConfig,
        attendanceByDate: attendanceByEmp.get(bid) || new Map(),
        leaveBalance: balance,
      };
      const computed = computeEmployeePayroll(emp, ctx);

      await PayrollItem.findOneAndUpdate(
        { employeeId: emp._id, month, year },
        {
          employeeId: emp._id,
          employeeName: computed.employeeName,
          biometricId: computed.biometricId,
          department: computed.department,
          designation: computed.designation,
          jobTitle: computed.jobTitle,
          employmentType: computed.employmentType,
          isIntern: computed.isIntern,
          internshipType: computed.internshipType || null,
          dateOfJoining: computed.dateOfJoining,
          payrollId: payrollRun._id,
          month,
          year,
          payPeriod: computed.payPeriod,

          rateBasic: computed.rateBasic,
          rateHra: computed.rateHra,
          rateGross: computed.rateGross,

          preJoiningDays: computed.preJoiningDays,
          firstActiveDayInMonth: computed.firstActiveDayInMonth,
          activeDaysInMonth: computed.activeDaysInMonth,
          clEligible: computed.clEligible,
          daysSinceDOJ: computed.daysSinceDOJ,

          workingDays: computed.workingDays,
          daysInMonth: computed.daysInMonth,
          presentDays: computed.presentDays,
          absentDays: computed.absentDays,
          halfDays: computed.halfDays,
          missPunchDays: computed.missPunchDays,
          lopDays: computed.lopDays,
          paidLeaveDays: computed.paidLeaveDays,
          weekOffDays: computed.weekOffDays,
          holidayDays: computed.holidayDays,
          holidayWorkedDays: computed.holidayWorkedDays,
          sundayWorkedDays: computed.sundayWorkedDays,
          lwpDays: computed.lwpDays,
          clUsedDays: computed.clUsedDays,
          slUsedDays: computed.slUsedDays,
          plUsedDays: computed.plUsedDays,

          payableDays: computed.payableDays,
          effectivePayableDays: computed.effectivePayableDays,
          perDayRate: computed.perDayRate,
          divisorBasis: computed.divisorBasis,
          sundayExtraPayDays: computed.sundayExtraPayDays,

          autoAdjustedCL: computed.autoAdjustedCL,
          sundayOffsetApplied: computed.sundayOffsetApplied,
          unsyncedDays: computed.unsyncedDays,

          leaveBalanceSnapshot: computed.leaveBalanceSnapshot,

          otherDeductionFull: computed.otherDeductionFull,
          otherDeductionRecurring: computed.otherDeductionRecurring,
          otherDeductionLeaveDays: computed.otherDeductionLeaveDays,
          otherDeductionChargeableDays: computed.otherDeductionChargeableDays,
          earnings: computed.earnings,
          deductions: computed.deductions,
          netPay: computed.netPay,
          roundedNetPay: computed.roundedNetPay,
          bankDetails: computed.bankDetails,
          dayBreakdown: computed.dayBreakdown,

          status: "processed",
          processedBy: user.id,
          processedAt: new Date(),
          isManuallyOverridden: false,
          overriddenPayableDays: null,
          remarks:
            computed.autoAdjustedCL > 0
              ? `Auto-adjusted ${computed.autoAdjustedCL} day(s) from AB to CL`
              : computed.sundayOffsetApplied > 0
                ? `${computed.sundayOffsetApplied} AB offset by Sunday worked`
                : computed.preJoiningDays > 0
                  ? `Mid-month joiner — ${computed.preJoiningDays} pre-joining day(s) excluded`
                  : null,
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      if (
        settings.clAutoAdjust?.enabled &&
        settings.clAutoAdjust?.consumeFromBalance &&
        computed.autoAdjustedCL > 0 &&
        balance
      ) {
        clBalanceUpdates.push({
          balanceId: balance._id,
          days: computed.autoAdjustedCL,
        });
      }

      totalGross += computed.earnings.grossEarnings;
      totalDed += computed.deductions.totalDeductions;
      totalNet += computed.roundedNetPay;
      totalPF += computed.deductions.providentFund;
      totalESIC += computed.deductions.esic;
      totalBonus += computed.earnings.bonus || 0;
    }

    for (const u of clBalanceUpdates) {
      await LeaveBalance.updateOne(
        { _id: u.balanceId },
        { $inc: { "consumed.CL": u.days } },
      );
    }

    payrollRun.totalEmployees = employees.length;
    payrollRun.totalGross = totalGross;
    payrollRun.totalDeductions = totalDed;
    payrollRun.totalNetPay = totalNet;
    payrollRun.totalPF = totalPF;
    payrollRun.totalESIC = totalESIC;
    payrollRun.totalBonus = totalBonus;
    payrollRun.status = "processed";
    payrollRun.processedAt = new Date();
    await payrollRun.save();

    res.json({
      success: true,
      message: `Payroll processed for ${employees.length} employees`,
      data: {
        runId: payrollRun._id,
        summary: {
          totalEmployees: employees.length,
          totalGross,
          totalDeductions: totalDed,
          totalNetPay: totalNet,
          totalPF,
          totalESIC,
          clAdjustmentsApplied: clBalanceUpdates.length,
        },
      },
    });
  } catch (err) {
    console.error("[PAYROLL-RUN]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /items ────────────────────────────────────────────────────────────────
router.get("/items", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const { department, status, search } = req.query;

    const filter = { month, year };
    if (department && department !== "all") filter.department = department;
    if (status && status !== "all") filter.status = status;
    if (search) {
      filter.$or = [
        { employeeName: { $regex: search, $options: "i" } },
        { biometricId: { $regex: search, $options: "i" } },
      ];
    }

    const items = await PayrollItem.find(filter)
      .sort({ employeeName: 1 })
      .lean();

    const empIds = items.map((i) => i.employeeId);
    const [balances, leaveCfg] = await Promise.all([
      LeaveBalance.find({ employeeId: { $in: empIds }, year }).lean(),
      LeaveConfig && LeaveConfig.getConfig
        ? LeaveConfig.getConfig().catch(() => null)
        : Promise.resolve(null),
    ]);
    const byEmp = new Map(balances.map((b) => [String(b.employeeId), b]));
    const clDef = leaveCfg?.clPerYear ?? 12;
    const slDef = leaveCfg?.slPerYear ?? 12;
    const plDef = leaveCfg?.plPerYear ?? 15;

    items.forEach((it) => {
      // Interns accrue nothing. Without this they would pick up the config
      // defaults below — clEligible gates CL, but SL and PL fall straight
      // through to 12 and 15, and the saved Interns tab would show a leave
      // balance the payroll engine has already established they do not have.
      if (it.isIntern) {
        it.leaveBalanceSnapshot = {
          hasRecord: false,
          clEligible: false,
          daysSinceDOJ: it.daysSinceDOJ ?? null,
          entitlement: { CL: 0, SL: 0, PL: 0 },
          consumed: { CL: 0, SL: 0, PL: 0 },
          available: { CL: 0, SL: 0, PL: 0 },
        };
        return;
      }
      const b = byEmp.get(String(it.employeeId));
      const clEligible = it.clEligible !== false;
      const clEnt = clEligible ? (b?.entitlement?.CL ?? clDef) : 0;
      const slEnt = b?.entitlement?.SL ?? slDef;
      const plEnt = b?.entitlement?.PL ?? b?.entitlement?.EL ?? plDef;
      const clCon = b?.consumed?.CL ?? 0;
      const slCon = b?.consumed?.SL ?? 0;
      const plCon = b?.consumed?.PL ?? b?.consumed?.EL ?? 0;
      it.leaveBalanceSnapshot = {
        hasRecord: !!b,
        clEligible,
        daysSinceDOJ: it.daysSinceDOJ ?? null,
        entitlement: { CL: clEnt, SL: slEnt, PL: plEnt },
        consumed: { CL: clCon, SL: slCon, PL: plCon },
        available: {
          CL: Math.max(0, clEnt - clCon),
          SL: Math.max(0, slEnt - slCon),
          PL: Math.max(0, plEnt - plCon),
        },
      };
    });

    const run = await Payroll.findOne({ month, year }).lean();

    res.json({ success: true, data: { items, run, count: items.length } });
  } catch (err) {
    console.error("[PAYROLL-ITEMS]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /item/:id ─────────────────────────────────────────────────────────────
router.get("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const item = await PayrollItem.findById(req.params.id)
      .populate(
        "employeeId",
        "firstName lastName profilePhoto email phone dateOfJoining",
      )
      .lean();
    if (!item)
      return res
        .status(404)
        .json({ success: false, message: "Payroll item not found" });
    res.json({ success: true, data: item });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /item/:id ─────────────────────────────────────────────────────────────
router.put("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Only HR managers can edit" });
    }

    const item = await PayrollItem.findById(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, message: "Not found" });
    if (item.status === "paid") {
      return res
        .status(400)
        .json({ success: false, message: "Paid payroll cannot be edited" });
    }

    const allowed = ["earnings", "deductions", "remarks"];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) item[k] = req.body[k];
    });
    await item.save();
    res.json({ success: true, data: item.toObject() });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /item/:id/override ──────────────────────────────────────────────────
router.patch("/item/:id/override", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Only HR managers can edit" });
    }

    const item = await PayrollItem.findById(req.params.id);
    if (!item)
      return res.status(404).json({ success: false, message: "Not found" });

    const settings = await PayrollSettings.getConfig();
    if (item.status === "paid" && settings.lockAfterPaid) {
      return res.status(400).json({
        success: false,
        message: "Paid payroll is locked. Unlock it first.",
      });
    }

    const employee = await Employee.findById(item.employeeId).lean();
    if (!employee)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });
    const empSalary = decryptSalaryFields(employee.salary || {});
    const salaryCfg = await SalaryConfig.getSingleton();

    const {
      payableDays,
      lopDays,
      clUsedDays,
      slUsedDays,
      plUsedDays,
      overtime,
      bonus,
      incentives,
      otherEarnings,
      loanDeduction,
      advanceDeduction,
      otherDeductions,
      remarks,
    } = req.body;

    const divisor =
      item.workingDays || new Date(item.year, item.month, 0).getDate() || 31;
    const activeCap =
      item.preJoiningDays > 0 && item.activeDaysInMonth != null
        ? item.activeDaysInMonth
        : divisor;

    const fullGross = Number(item.rateGross || empSalary.gross || 0);
    const fullBasic = Number(item.rateBasic || empSalary.basic || 0);
    const fullHra = Number(item.rateHra || empSalary.hra || 0);

    if (fullGross <= 0) {
      return res
        .status(400)
        .json({ success: false, message: "Employee has no gross salary set" });
    }

    let newPayableDays;
    let newLopDays;
    if (payableDays !== undefined) {
      newPayableDays = Math.max(0, Math.min(Number(payableDays), activeCap));
    } else {
      newPayableDays =
        item.payableDays ?? (item.presentDays || 0) + (item.paidLeaveDays || 0);
    }
    if (lopDays !== undefined) {
      newLopDays = Math.max(0, Math.min(Number(lopDays), activeCap));
    } else {
      newLopDays = item.lopDays ?? 0;
    }

    const perDay = fullGross / Math.max(1, divisor);
    const basicRatio = fullBasic / Math.max(1, fullGross);

    const grossEarnedBase = Math.round(perDay * newPayableDays);
    const basicEarned = Math.round(grossEarnedBase * basicRatio);
    const hraEarned = grossEarnedBase - basicEarned;
    const specialEarned = 0;

    const ot =
      overtime !== undefined ? Number(overtime) : item.earnings?.overtime || 0;
    const bn = bonus !== undefined ? Number(bonus) : item.earnings?.bonus || 0;
    const inc =
      incentives !== undefined
        ? Number(incentives)
        : item.earnings?.incentives || 0;
    const oth =
      otherEarnings !== undefined
        ? Number(otherEarnings)
        : item.earnings?.otherEarnings || 0;

    const grossTotal = grossEarnedBase + ot + bn + inc + oth;

    const epfCap = salaryCfg?.epfCapAmount ?? 1800;
    const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;

    // EPF — respect the employee's HR override. When set, prorate the stored
    // full-month EPF by the earned-gross ratio; otherwise statutory on basic.
    const epfOverridden = !!empSalary.epfOverride;
    const overrideEpfFull = Number(empSalary.epf || 0);
    const earnedRatio = fullGross > 0 ? grossEarnedBase / fullGross : 1;
    const epf = epfOverridden
      ? Math.round(overrideEpfFull * earnedRatio)
      : Math.round(Math.min(basicEarned * eepfPct, epfCap));
    // Eligibility on the full basic, not the prorated one — see computeEsi.
    const { esic, erEsic } = computeEsi(fullBasic, basicEarned, salaryCfg);
    const pt =
      settings.ptEnabled && settings.ptForBasic
        ? settings.ptForBasic(basicEarned)
        : 0;

    const loan =
      loanDeduction !== undefined
        ? Number(loanDeduction)
        : item.deductions?.loanDeduction || 0;
    const advance =
      advanceDeduction !== undefined
        ? Number(advanceDeduction)
        : item.deductions?.advanceDeduction || 0;
    const otherD =
      otherDeductions !== undefined
        ? Number(otherDeductions)
        : item.deductions?.otherDeductions || 0;

    const totalDeductions = epf + esic + pt + loan + advance + otherD;
    const netPay = grossTotal - totalDeductions;

    item.earnings = {
      ...(item.earnings || {}),
      basicSalary: basicEarned,
      houseRentAllowance: hraEarned,
      specialAllowance: specialEarned,
      overtime: ot,
      bonus: bn,
      incentives: inc,
      otherEarnings: oth,
      grossEarnings: grossTotal,
    };
    item.deductions = {
      ...(item.deductions || {}),
      providentFund: epf,
      employerPF: epf,
      esic: esic,
      employerESIC: erEsic,
      professionalTax: pt,
      loanDeduction: loan,
      advanceDeduction: advance,
      otherDeductions: otherD,
      totalDeductions,
    };
    item.netPay = netPay;
    item.roundedNetPay = settings.roundNetPay ? Math.round(netPay) : netPay;
    if (remarks !== undefined) item.remarks = remarks;

    item.payableDays = newPayableDays;
    item.lopDays = newLopDays;
    if (clUsedDays !== undefined)
      item.clUsedDays = Math.max(0, Number(clUsedDays));
    if (slUsedDays !== undefined)
      item.slUsedDays = Math.max(0, Number(slUsedDays));
    if (plUsedDays !== undefined)
      item.plUsedDays = Math.max(0, Number(plUsedDays));

    const dayEdit =
      payableDays !== undefined ||
      lopDays !== undefined ||
      clUsedDays !== undefined ||
      slUsedDays !== undefined ||
      plUsedDays !== undefined;
    if (dayEdit) {
      item.overriddenPayableDays = newPayableDays;
      item.isManuallyOverridden = true;
    }
    item.lastEditedBy = user.id;
    item.lastEditedAt = new Date();
    item.markModified("earnings");
    item.markModified("deductions");
    await item.save();

    res.json({
      success: true,
      message: "Override applied and net pay recomputed",
      data: item.toObject(),
    });
  } catch (err) {
    console.error("[PAYROLL-OVERRIDE]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /item/:id/recalculate ───────────────────────────────────────────────
//  Re-runs payroll for ONE already-processed employee against their CURRENT
//  salary (re-fetched + decrypted), then persists the result so the stored
//  PayrollItem permanently reflects the new figures — no need to re-click on
//  the next page refresh.
//
//  Why this exists: HR can't edit gross directly inside payroll. If they
//  process the run, then realise an employee's salary was raised in the
//  Employee form AFTER processing, the stored item still carries the old
//  rateGross. This route picks up the new salary for just that employee and
//  rebuilds basic/HRA/EPF/ESIC/PT/gross/net using the SAME computation engine
//  used at process time (computeEmployeePayroll), so the numbers are identical
//  to a fresh run.
//
//  What it preserves: the manual edits HR already made on this item —
//  loanDeduction, advanceDeduction, otherDeductions, overtime, bonus,
//  incentives, remarks, and any manual payable-days override
//  (isManuallyOverridden). Recalculate only refreshes the salary-derived
//  numbers; it does not wipe the other deductions HR entered earlier.
//
//  Guards: hr_manager only; refuses when the item is paid-and-locked; refuses
//  when the employee's current gross is 0.
router.patch(
  "/item/:id/recalculate",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    try {
      const { user } = req;
      if (user.role !== "hr_manager") {
        return res
          .status(403)
          .json({ success: false, message: "Only HR managers can edit" });
      }

      const item = await PayrollItem.findById(req.params.id);
      if (!item)
        return res.status(404).json({ success: false, message: "Not found" });

      const settings = await PayrollSettings.getConfig();
      if (item.status === "paid" && settings.lockAfterPaid) {
        return res.status(400).json({
          success: false,
          message: "Paid payroll is locked. Unlock it first.",
        });
      }

      // Re-fetch + decrypt the employee so we pick up their CURRENT salary.
      const employeeRaw = await Employee.findById(item.employeeId)
        .select("-password -temporaryPassword -__v")
        .lean();
      if (!employeeRaw)
        return res
          .status(404)
          .json({ success: false, message: "Employee not found" });
      const employee = decryptEmployeeDoc(employeeRaw);

      // An intern's pay figure is the stipend, and it is legitimately zero
      // for an unpaid or self-paid internship — so the "no salary set" guard
      // asks a different question for them, and only refuses the case that is
      // actually a mistake: someone marked as a PAID intern with no amount.
      const isInternItem = employee.employmentType === "intern";
      const newGross = isInternItem
        ? Number(employee.salary?.stipend || 0)
        : Number(employee.salary?.gross || 0);
      if (!isInternItem && newGross <= 0) {
        return res.status(400).json({
          success: false,
          message: "Employee has no gross salary set",
        });
      }
      if (
        isInternItem &&
        employee.internship?.stipendType === "paid" &&
        newGross <= 0
      ) {
        return res.status(400).json({
          success: false,
          message: "This intern is marked as paid but has no stipend set",
        });
      }

      // Rebuild the month context exactly like the process route, then keep
      // only this employee's slice (attendance for their biometric id + their
      // leave balance for the year).
      const {
        settings: ctxSettings,
        salaryCfg,
        holidayMap,
        attendanceByEmp,
        leaveConfig,
      } = await loadMonthContext(item.month, item.year);
      const bid = (employee.biometricId || "").toUpperCase();
      const balance = await LeaveBalance.findOne({
        employeeId: employee._id,
        year: item.year,
      });

      const ctx = {
        month: item.month,
        year: item.year,
        settings: ctxSettings,
        salaryCfg,
        holidayMap,
        leaveConfig,
        attendanceByDate: attendanceByEmp.get(bid) || new Map(),
        leaveBalance: balance,
      };

      // Canonical fresh compute against the current salary.
      const computed = computeEmployeePayroll(employee, ctx);

      // ── Preserve the manual edits HR made on this item ──────────────────
      // Manual day override: if HR had manually set payable/LOP days, keep
      // those days and re-derive earnings on the NEW per-day rate. Otherwise
      // use the freshly-computed payable days.
      const divisor =
        computed.workingDays ||
        new Date(item.year, item.month, 0).getDate() ||
        31;
      const usedManualDays = !!item.isManuallyOverridden;
      const payableDays = usedManualDays
        ? Number(item.payableDays ?? computed.payableDays)
        : computed.payableDays;
      const lopDays = usedManualDays
        ? Number(item.lopDays ?? computed.lopDays)
        : computed.lopDays;

      // New rate snapshot (this is the field that was stale before).
      const fullGross = Number(computed.rateGross || newGross);
      const fullBasic = Number(
        computed.rateBasic || employee.salary?.basic || 0,
      );

      // Salary-derived earnings. If HR kept the auto day-count, computed.*
      // already holds the right earned figures. If HR had manually overridden
      // days, re-derive the base earned on the new per-day rate so the manual
      // day-count is honoured against the new salary.
      let basicEarned = computed.earnings.basicSalary;
      let hraEarned = computed.earnings.houseRentAllowance;
      let grossEarnedBase =
        computed.earnings.grossEarnings -
        (item.earnings?.overtime || 0) -
        (item.earnings?.bonus || 0) -
        (item.earnings?.incentives || 0) -
        (item.earnings?.otherEarnings || 0);
      if (usedManualDays) {
        const perDay = fullGross / Math.max(1, divisor);
        const basicRatio = fullGross > 0 ? fullBasic / fullGross : 0.5;
        grossEarnedBase = Math.round(perDay * payableDays);
        // Same reason as in computeEmployeePayroll: an intern's fullBasic is
        // zero, so the 0.5 fallback would invent a basic out of their stipend
        // — and every deduction below is computed from the basic.
        basicEarned = isInternItem ? 0 : Math.round(grossEarnedBase * basicRatio);
        hraEarned = isInternItem ? 0 : grossEarnedBase - basicEarned;
      } else {
        grossEarnedBase = computed.earnings.grossEarnings;
      }

      // Carry over the manual earnings/deductions HR previously entered.
      const ot = item.earnings?.overtime || 0;
      const bn = item.earnings?.bonus || 0;
      const inc = item.earnings?.incentives || 0;
      const oth = item.earnings?.otherEarnings || 0;
      const loan = item.deductions?.loanDeduction || 0;
      const advance = item.deductions?.advanceDeduction || 0;
      const otherD = item.deductions?.otherDeductions || 0;

      const grossTotal = grossEarnedBase + ot + bn + inc + oth;

      // Statutory deductions recomputed on the NEW earned basic.
      const epfCap = salaryCfg?.epfCapAmount ?? 1800;
      const eepfPct = (salaryCfg?.eepfPct ?? 12) / 100;

      // EPF — respect the employee's HR override. When set, prorate the stored
      // full-month EPF by the earned-gross ratio; otherwise statutory on basic.
      const epfOverridden = !isInternItem && !!employee.salary?.epfOverride;
      const overrideEpfFull = Number(employee.salary?.epf || 0);
      const earnedRatio = fullGross > 0 ? grossEarnedBase / fullGross : 1;
      // Interns are enrolled in neither scheme — see computeEmployeePayroll.
      // Recalculating an item is also the path that CLEARS these: someone
      // converted from employee to intern has PF and ESI on their existing
      // draft row, and this is what takes them off.
      const epf = isInternItem
        ? 0
        : epfOverridden
          ? Math.round(overrideEpfFull * earnedRatio)
          : Math.round(Math.min(basicEarned * eepfPct, epfCap));
      // Eligibility is re-tested against the employee's CURRENT full basic, so
      // a recalculate is what clears a stale ESIC that an earlier run wrote on
      // the prorated basic (or that a since-raised salary made inapplicable).
      const { esic, erEsic } = isInternItem
        ? { esic: 0, erEsic: 0 }
        : computeEsi(fullBasic, basicEarned, salaryCfg);
      const pt =
        !isInternItem && ctxSettings.ptEnabled && ctxSettings.ptForBasic
          ? ctxSettings.ptForBasic(basicEarned)
          : 0;

      // Other deduction is RE-DERIVED, not carried over from the item like
      // loan and advance are. Those are one-off figures HR typed for this
      // month; this one is a standing amount on the employee prorated by
      // their leave, and a recalculate exists precisely to pick up a change
      // to either. Carrying the old figure forward would make the button
      // silently not do the thing it is for.
      const otherFromEmployee = Number(employee.salary?.otherDeduction || 0);
      const otherLeaveDays =
        (computed.clUsedDays || 0) +
        (computed.slUsedDays || 0) +
        (computed.plUsedDays || 0) +
        (computed.lwpDays || 0);
      const otherChargeable = Math.max(0, divisor - otherLeaveDays);
      const otherRecurring =
        otherFromEmployee > 0
          ? Math.round((otherFromEmployee * otherChargeable) / Math.max(1, divisor))
          : 0;

      // otherD is what is stored on the item, and on any recalculate after
      // the first that ALREADY contains the recurring part. Subtracting the
      // recurring amount recorded last time leaves the one-off figure HR
      // actually typed, which is the only part worth carrying forward.
      const otherManual = Math.max(
        0,
        otherD - (item.otherDeductionRecurring || 0),
      );

      const totalDeductions =
        epf + esic + pt + loan + advance + otherManual + otherRecurring;
      const netPay = grossTotal - totalDeductions;

      // ── Persist ─────────────────────────────────────────────────────────
      // Refresh the rate snapshot to the new salary (this is what makes the
      // recalc stick across refreshes).
      item.rateBasic = computed.rateBasic;
      item.rateHra = computed.rateHra;
      item.rateGross = computed.rateGross;
      item.perDayRate = computed.perDayRate;

      // The flags come from the fresh compute, so a recalculate is how an
      // item catches up with a change of employment type.
      item.isIntern = computed.isIntern;
      item.internshipType = computed.internshipType || null;

      item.earnings = {
        ...(item.earnings || {}),
        stipend: isInternItem ? grossEarnedBase : 0,
        basicSalary: basicEarned,
        houseRentAllowance: hraEarned,
        specialAllowance: computed.earnings.specialAllowance || 0,
        overtime: ot,
        bonus: bn,
        incentives: inc,
        otherEarnings: oth,
        grossEarnings: grossTotal,
      };
      item.otherDeductionFull = otherFromEmployee;
      item.otherDeductionRecurring = otherRecurring;
      item.otherDeductionLeaveDays = +otherLeaveDays.toFixed(2);
      item.otherDeductionChargeableDays = +otherChargeable.toFixed(2);

      item.deductions = {
        ...(item.deductions || {}),
        providentFund: epf,
        employerPF: epf,
        esic: esic,
        employerESIC: erEsic,
        professionalTax: pt,
        loanDeduction: loan,
        advanceDeduction: advance,
        otherDeductions: otherManual + otherRecurring,
        totalDeductions,
      };
      item.netPay = netPay;
      item.roundedNetPay = ctxSettings.roundNetPay
        ? Math.round(netPay)
        : netPay;

      // If HR had NOT manually overridden days, also refresh the day-derived
      // stats from the fresh compute so the Summary tab stays consistent.
      if (!usedManualDays) {
        item.payableDays = computed.payableDays;
        item.effectivePayableDays = computed.effectivePayableDays;
        item.lopDays = computed.lopDays;
        item.presentDays = computed.presentDays;
        item.absentDays = computed.absentDays;
        item.halfDays = computed.halfDays;
        item.missPunchDays = computed.missPunchDays;
        item.paidLeaveDays = computed.paidLeaveDays;
        item.weekOffDays = computed.weekOffDays;
        item.holidayDays = computed.holidayDays;
        item.clUsedDays = computed.clUsedDays;
        item.slUsedDays = computed.slUsedDays;
        item.plUsedDays = computed.plUsedDays;
      } else {
        item.payableDays = payableDays;
        item.lopDays = lopDays;
      }

      item.lastEditedBy = user.id;
      item.lastEditedAt = new Date();
      item.markModified("earnings");
      item.markModified("deductions");
      await item.save();

      res.json({
        success: true,
        message: `Recalculated against current salary (gross ₹${newGross.toLocaleString("en-IN")}).`,
        data: item.toObject(),
      });
    } catch (err) {
      console.error("[PAYROLL-RECALCULATE]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ── PATCH /mark-paid ──────────────────────────────────────────────────────────
router.patch("/mark-paid", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Only HR managers can mark as paid" });
    }
    const month = parseInt(req.body.month) || new Date().getMonth() + 1;
    const year = parseInt(req.body.year) || new Date().getFullYear();

    const result = await PayrollItem.updateMany(
      { month, year, status: "processed" },
      { $set: { status: "paid", paymentDate: new Date() } },
    );

    await Payroll.updateOne({ month, year }, { $set: { status: "paid" } });

    // P1 — payslip published. Dispatched, not awaited: marking a whole
    // month's payroll paid must not hang (or fail) behind a few hundred
    // push sends. Per-recipient outcomes are logged under [SEND-PUSH].
    let pushResult = { sent: 0, failed: 0, dispatched: false, recipients: 0 };
    if (result.modifiedCount > 0) {
      // Get employee IDs from paid items to target notifications
      const paidItems = await PayrollItem.find({ month, year, status: "paid" })
        .select("employeeId")
        .lean();
      const employeeIds = paidItems.map((i) => i.employeeId);

      notifyPayslipPublished(employeeIds, month, year);
      pushResult = {
        sent: 0,
        failed: 0,
        dispatched: true,
        recipients: employeeIds.length,
      };
    } else {
      console.log(
        `[PAYROLL-MARK-PAID] No items were modified (already paid or no processed items)`,
      );
    }

    res.json({
      success: true,
      message: `${result.modifiedCount} items marked as paid`,
      pushNotifications: pushResult,
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /runs ─────────────────────────────────────────────────────────────────
router.get("/runs", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const runs = await Payroll.find()
      .sort({ year: -1, month: -1 })
      .limit(24)
      .lean();
    res.json({ success: true, data: runs });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── GET /settings ─────────────────────────────────────────────────────────────
router.get("/settings", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const cfg = await PayrollSettings.getConfig();
    res.json({ success: true, data: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PUT /settings ─────────────────────────────────────────────────────────────
router.put("/settings", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    const allowed = [
      "payableDaysBasis",
      "clAutoAdjust",
      "mpTreatment",
      "foodAllowanceInGross",
      "sundayWorkExtraPay",
      "sundayOffsetsAbsence",
      "roundingMode",
      "roundNetPay",
      "ptEnabled",
      "ptSlabs",
      "lockAfterPaid",
    ];
    const update = { updatedBy: user.id, updatedAt: new Date() };
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) update[k] = req.body[k];
    });

    const before = await PayrollSettings.findById("singleton").lean();

    const cfg = await PayrollSettings.findByIdAndUpdate(
      "singleton",
      { $set: update },
      { new: true, upsert: true, runValidators: true },
    );

    try {
      const changes = diffPayrollSettings(before, cfg, req.body);
      if (changes.length > 0) {
        let EmailService;
        try {
          EmailService = require("../../service/emailService");
        } catch (e) {
          console.warn(
            "[PAYROLL-SETTINGS] emailService not found, skipping CEO notification",
          );
        }
        if (EmailService?.sendPayrollSettingsChangeEmail) {
          const changedBy =
            req.user?.name || req.user?.email || req.user?.id || "HR";
          EmailService.sendPayrollSettingsChangeEmail({
            changedBy,
            changes,
          }).catch((e) =>
            console.warn("[PAYROLL-SETTINGS] CEO email failed:", e.message),
          );
        }
      }
    } catch (e) {
      console.warn("[PAYROLL-SETTINGS] diff/email step failed:", e.message);
    }

    res.json({ success: true, data: cfg });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

function diffPayrollSettings(oldCfg, newCfg, requestBody) {
  if (!oldCfg) oldCfg = {};
  const changes = [];
  const same = (a, b) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

  const scalars = [
    { key: "payableDaysBasis", label: "Payable Days Basis" },
    { key: "mpTreatment", label: "Miss-Punch Treatment" },
    { key: "foodAllowanceInGross", label: "Food Allowance In Gross" },
    { key: "sundayOffsetsAbsence", label: "Sunday Offsets Absence" },
    { key: "sundayWorkExtraPay", label: "Sunday Work Extra Pay" },
    { key: "roundingMode", label: "Rounding Mode" },
    { key: "roundNetPay", label: "Round Net Pay" },
    { key: "ptEnabled", label: "Professional Tax Enabled" },
    { key: "lockAfterPaid", label: "Lock After Paid" },
  ];
  for (const { key, label } of scalars) {
    if (requestBody[key] === undefined) continue;
    if (!same(oldCfg[key], newCfg[key])) {
      changes.push({
        label,
        before: formatVal(oldCfg[key]),
        after: formatVal(newCfg[key]),
      });
    }
  }

  if (requestBody.clAutoAdjust !== undefined) {
    const o = oldCfg.clAutoAdjust || {};
    const n = newCfg.clAutoAdjust || {};
    if (!same(o.enabled, n.enabled)) {
      changes.push({
        label: "CL Auto-Adjust — Enabled",
        before: formatVal(o.enabled),
        after: formatVal(n.enabled),
      });
    }
    if (!same(o.maxABForAdjustment, n.maxABForAdjustment)) {
      changes.push({
        label: "CL Auto-Adjust — Max Per Month",
        before: formatVal(o.maxABForAdjustment),
        after: formatVal(n.maxABForAdjustment),
      });
    }
    if (!same(o.consumeFromBalance, n.consumeFromBalance)) {
      changes.push({
        label: "CL Auto-Adjust — Consume Balance",
        before: formatVal(o.consumeFromBalance),
        after: formatVal(n.consumeFromBalance),
      });
    }
  }

  if (
    requestBody.ptSlabs !== undefined &&
    !same(oldCfg.ptSlabs, newCfg.ptSlabs)
  ) {
    const summarise = (slabs) =>
      (slabs || [])
        .map((s) => `${s.minBasic}–${s.maxBasic}: ₹${s.amount}`)
        .join(" · ") || "—";
    changes.push({
      label: "PT Slabs",
      before: summarise(oldCfg.ptSlabs),
      after: summarise(newCfg.ptSlabs),
    });
  }

  return changes;
}

function formatVal(v) {
  if (v === true) return "Yes";
  if (v === false) return "No";
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

/**
 * The interns' stipend sheet.
 *
 * A separate worksheet rather than the staff layout with the statutory
 * columns left at zero. That sheet has twenty-two columns — Rate of Basic,
 * Rate of HRA, ESIC employee, ESIC employer, PF employee, PF employer — and
 * every one of them would read 0.00 against a net of 15,500. An accountant
 * opening that does not see "interns have no PF"; they see a broken export
 * and come asking which figure to trust.
 *
 * So: the columns an internship actually has. Stipend, days, earned, paid.
 *
 * @param {import("exceljs").Workbook} wb
 * @param {Array} items   payroll items, already filtered to interns
 */
function buildInternStipendSheet(wb, items, { month, year }) {
  const ws = wb.addWorksheet("StipendSheet", {
    views: [{ state: "frozen", ySplit: 3 }],
    pageSetup: { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1 },
  });

  const COLS = [
    { header: "#", width: 5, key: "sl" },
    { header: "Emp No", width: 12, key: "bid" },
    { header: "Name", width: 30, key: "name" },
    { header: "Department", width: 20, key: "dept" },
    { header: "Designation", width: 22, key: "desig" },
    { header: "Arrangement", width: 13, key: "kind" },
    { header: "Monthly Stipend", width: 16, key: "rate", money: true },
    { header: "Days", width: 8, key: "days", days: true },
    { header: "Payable", width: 10, key: "payable", days: true },
    { header: "LOP", width: 9, key: "lop", days: true },
    { header: "Stipend Earned", width: 16, key: "earned", money: true },
    { header: "Paid", width: 15, key: "net", money: true },
  ];
  COLS.forEach((c, i) => (ws.getColumn(i + 1).width = c.width));

  const solid = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const money = "#,##0.00";
  const daysFmt = "0.##";
  const LABEL = { paid: "Paid", unpaid: "Unpaid", self_paid: "Self-paid" };

  ws.mergeCells(1, 1, 1, COLS.length);
  const title = ws.getCell(1, 1);
  title.value = `GRAV CLOTHING  ·  Intern Stipends  ·  ${MONTH_NAMES[month]} ${year}`;
  title.font = { name: "Arial", size: 13, bold: true, color: { argb: "FFFFFFFF" } };
  title.fill = solid("FF92400E");
  title.alignment = { horizontal: "center", vertical: "middle" };
  ws.getRow(1).height = 30;

  ws.mergeCells(2, 1, 2, COLS.length);
  const note = ws.getCell(2, 1);
  note.value =
    "Stipends carry no basic, HRA, provident fund or ESI — interns are not enrolled in either scheme.";
  note.font = { name: "Arial", size: 9, italic: true, color: { argb: "FF78350F" } };
  note.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
  note.fill = solid("FFFEF3C7");

  const head = ws.getRow(3);
  COLS.forEach((c, i) => {
    const cell = head.getCell(i + 1);
    cell.value = c.header;
    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = solid("FF1E293B");
    cell.alignment = {
      horizontal: c.money || c.days ? "right" : "left",
      vertical: "middle",
      wrapText: true,
      indent: 1,
    };
  });
  head.height = 26;

  items.forEach((it, idx) => {
    const row = ws.getRow(4 + idx);
    const earned = it.earnings?.stipend || it.earnings?.grossEarnings || 0;
    const values = {
      sl: idx + 1,
      bid: it.biometricId || "",
      name: it.employeeName || "",
      dept: it.department || "",
      desig: it.designation || "",
      kind: LABEL[it.internshipType] || "Paid",
      rate: it.rateGross || 0,
      days: it.daysInMonth || 0,
      payable: it.payableDays || 0,
      lop: it.lopDays || 0,
      earned,
      net: it.roundedNetPay ?? it.netPay ?? 0,
    };
    COLS.forEach((c, i) => {
      const cell = row.getCell(i + 1);
      cell.value = values[c.key];
      cell.font = { name: "Arial", size: 9 };
      cell.fill = solid(idx % 2 ? "FFF8FAFC" : "FFFFFFFF");
      cell.alignment = {
        horizontal: c.money || c.days ? "right" : "left",
        vertical: "middle",
        indent: 1,
      };
      if (c.money) cell.numFmt = money;
      if (c.days) cell.numFmt = daysFmt;
    });
  });

  const sum = ws.getRow(4 + items.length);
  const total = (f) => items.reduce((a, i) => a + (f(i) || 0), 0);
  sum.getCell(3).value = `${items.length} intern${items.length === 1 ? "" : "s"}`;
  sum.getCell(7).value = total((i) => i.rateGross);
  sum.getCell(9).value = total((i) => i.payableDays);
  sum.getCell(10).value = total((i) => i.lopDays);
  sum.getCell(11).value = total((i) => i.earnings?.stipend || i.earnings?.grossEarnings);
  sum.getCell(12).value = total((i) => i.roundedNetPay ?? i.netPay);
  COLS.forEach((c, i) => {
    const cell = sum.getCell(i + 1);
    cell.font = { name: "Arial", size: 9, bold: true, color: { argb: "FF065F46" } };
    cell.fill = solid("FFD1FAE5");
    cell.alignment = {
      horizontal: c.money || c.days ? "right" : "left",
      vertical: "middle",
      indent: 1,
    };
    if (c.money) cell.numFmt = money;
    if (c.days) cell.numFmt = daysFmt;
    cell.border = {
      top: { style: "medium", color: { argb: "FF000000" } },
      bottom: { style: "medium", color: { argb: "FF000000" } },
    };
  });

  return ws;
}

// ═════════════════════════════════════════════════════════════════════════════
//  GET /export
// ═════════════════════════════════════════════════════════════════════════════
router.get("/export", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const ExcelJS = require("exceljs");
    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    // Which tab the HR page is on. Defaults to "all" so every existing caller
    // — and anyone with the URL bookmarked — keeps getting the whole month.
    const segment = ["staff", "interns"].includes(req.query.segment)
      ? req.query.segment
      : "all";
    const segmentFilter =
      segment === "interns"
        ? { isIntern: true }
        : segment === "staff"
          ? { isIntern: { $ne: true } }
          : {};

    const items = await PayrollItem.find({ month, year, ...segmentFilter })
      .sort({ department: 1, employeeName: 1 })
      .lean();

    if (items.length === 0) {
      return res.status(404).json({
        success: false,
        message:
          segment === "interns"
            ? `No interns in the ${MONTH_NAMES[month]} ${year} payroll.`
            : `No payroll items for ${MONTH_NAMES[month]} ${year}. Process payroll first.`,
      });
    }

    // Interns get their own sheet — see buildInternStipendSheet for why the
    // staff layout is not reused.
    if (segment === "interns") {
      const internWb = new (require("exceljs").Workbook)();
      internWb.creator = "Grav Clothing HRMS";
      buildInternStipendSheet(internWb, items, { month, year });
      const internBuf = await internWb.xlsx.writeBuffer();
      const internName = `intern_stipends_${year}-${String(month).padStart(2, "0")}.xlsx`;
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader("Content-Disposition", `attachment; filename="${internName}"`);
      return res.send(Buffer.from(internBuf));
    }

    const employees = await Employee.find({
      _id: { $in: items.map((i) => i.employeeId) },
    })
      .select(
        "firstName middleName lastName biometricId designation jobTitle department salary bankDetails dateOfJoining",
      )
      .lean();

    const empById = new Map(
      employees.map((e) => [String(e._id), decryptEmployeeDoc(e)]),
    );

    const wb = new ExcelJS.Workbook();
    wb.creator = "Grav Clothing HRMS";

    const ws = wb.addWorksheet("SalarySheetTab", {
      views: [{ state: "frozen", ySplit: 4 }],
      pageSetup: {
        paperSize: 9,
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
      },
    });

    const COL_WIDTHS = [
      3, 12, 30, 20, 22, 13, 11, 11, 14, 10, 10, 13, 11, 11, 13, 11, 11, 11, 11,
      11, 14, 13,
    ];
    COL_WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    const HDR = {
      identity: "FF1E293B",
      rate: "FF1D4ED8",
      days: "FF0E7490",
      earned: "FF166534",
      ded: "FF9F1239",
      net: "FF065F46",
    };
    const TINT = {
      identity: "FFFFFFFF",
      rate: "FFEFF6FF",
      days: "FFF0FDFA",
      earned: "FFF0FDF4",
      ded: "FFFFF1F2",
      net: "FFD1FAE5",
    };
    const STRIPE = "FFF1F5F9";

    function hdrFill(colNum) {
      if (colNum >= 2 && colNum <= 5) return HDR.identity;
      if (colNum >= 6 && colNum <= 9) return HDR.rate;
      if (colNum >= 10 && colNum <= 11) return HDR.days;
      if (colNum >= 12 && colNum <= 15) return HDR.earned;
      if (colNum >= 16 && colNum <= 21) return HDR.ded;
      if (colNum === 22) return HDR.net;
      return HDR.identity;
    }

    function cellFill(colNum, isEvenRow) {
      if (colNum === 22) return TINT.net;
      const base =
        colNum >= 2 && colNum <= 5
          ? TINT.identity
          : colNum >= 6 && colNum <= 9
            ? TINT.rate
            : colNum >= 10 && colNum <= 11
              ? TINT.days
              : colNum >= 12 && colNum <= 15
                ? TINT.earned
                : colNum >= 16 && colNum <= 21
                  ? TINT.ded
                  : "FFFFFFFF";
      if (isEvenRow && colNum !== 22 && !(colNum >= 6 && colNum <= 9)) {
        return STRIPE;
      }
      return base;
    }

    const solid = (argb) => ({
      type: "pattern",
      pattern: "solid",
      fgColor: { argb },
    });
    const border = (t = "thin", argb = "FFD1D5DB") => ({
      top: { style: t, color: { argb } },
      bottom: { style: t, color: { argb } },
      left: { style: t, color: { argb } },
      right: { style: t, color: { argb } },
    });

    ws.mergeCells(1, 1, 1, 22);
    const r1 = ws.getCell(1, 1);
    r1.value = `GRAV CLOTHING  ·  Salary Sheet  ·  ${MONTH_NAMES[month]} ${year}`;
    r1.font = {
      name: "Arial",
      size: 13,
      bold: true,
      color: { argb: "FFFFFFFF" },
    };
    r1.fill = solid("FF5B21B6");
    r1.alignment = { horizontal: "center", vertical: "middle" };
    ws.getRow(1).height = 30;

    ws.mergeCells(2, 1, 2, 22);
    const r2 = ws.getCell(2, 1);
    r2.value = `Selection :- ${MONTH_NAMES[month].slice(0, 3).toUpperCase()}-${year}`;
    r2.font = {
      name: "Arial",
      size: 10,
      bold: true,
      color: { argb: "FF4C1D95" },
    };
    r2.fill = solid("FFEDE9FE");
    r2.alignment = { horizontal: "left", vertical: "middle", indent: 1 };
    ws.getRow(2).height = 18;

    const SECTIONS = [
      { start: 2, end: 5, label: "Employee Details", bg: "FF1E293B" },
      { start: 6, end: 9, label: "Monthly CTC", bg: "FF1D4ED8" },
      { start: 10, end: 11, label: "Attendance", bg: "FF0E7490" },
      { start: 12, end: 15, label: "Earned This Month", bg: "FF166534" },
      { start: 16, end: 21, label: "Deductions", bg: "FF9F1239" },
      { start: 22, end: 22, label: "Net Salary", bg: "FF065F46" },
    ];
    SECTIONS.forEach(({ start, end, label, bg }) => {
      if (start !== end) ws.mergeCells(3, start, 3, end);
      const cell = ws.getCell(3, start);
      cell.value = label;
      cell.font = {
        name: "Arial",
        size: 7.5,
        bold: true,
        color: { argb: "FFFFFFFF" },
        italic: true,
      };
      cell.fill = solid(bg);
      cell.alignment = { horizontal: "center", vertical: "middle" };
      cell.border = border("thin", "FF000000");
    });
    ws.getRow(3).height = 13;

    const HEADERS = [
      "",
      "Emp Code",
      "Name",
      "Department",
      "Designation",
      "Gross Salary",
      "Basic",
      "HRA",
      "Food\nAllowance",
      "No. of Days\nof the Month",
      "Actual Days\nWork Done",
      "Gross Salary",
      "BAS",
      "HRA",
      "Tot Earnings",
      "ESIEMPLYE",
      "ESIEMPR",
      "LN/ADV",
      "PFEMPCONT",
      "PFEMPR",
      "Tot Deductions",
      "Net Salary",
    ];

    const hRow = ws.getRow(4);
    HEADERS.forEach((label, i) => {
      const colNum = i + 1;
      const cell = hRow.getCell(colNum);
      cell.value = label;
      if (!label) return;
      cell.font = {
        name: "Arial",
        size: 9,
        bold: true,
        color: { argb: "FFFFFFFF" },
      };
      cell.fill = solid(hdrFill(colNum));
      cell.alignment = {
        horizontal: "center",
        vertical: "middle",
        wrapText: true,
      };
      cell.border = border("thin", "FF00000033");
    });
    hRow.height = 38;

    const DATA_START = 5;
    const daysInMonth = new Date(year, month, 0).getDate();
    const moneyFmt = "#,##0";
    const daysFmt = "0.##";

    items.forEach((it, idx) => {
      const emp = empById.get(String(it.employeeId)) || {};
      const e = it.earnings || {};
      const d = it.deductions || {};
      const foodAllow = Number(emp.salary?.foodAllowance || 0);
      const lnAdv = (d.loanDeduction || 0) + (d.advanceDeduction || 0);
      const grossEarned = e.grossEarnings || 0;
      const isEvenRow = idx % 2 === 1;

      const values = [
        "",
        it.biometricId || "",
        it.employeeName || "",
        it.department || "",
        it.designation || "",
        it.rateGross || 0,
        it.rateBasic || 0,
        it.rateHra || 0,
        foodAllow,
        daysInMonth,
        it.payableDays ?? 0,
        grossEarned,
        e.basicSalary || 0,
        e.houseRentAllowance || 0,
        grossEarned,
        d.esic || 0,
        d.employerESIC || 0,
        lnAdv,
        d.providentFund || 0,
        d.employerPF || d.providentFund || 0,
        d.totalDeductions || 0,
        it.roundedNetPay ?? it.netPay ?? 0,
      ];

      const row = ws.getRow(DATA_START + idx);
      values.forEach((v, i) => {
        row.getCell(i + 1).value = v;
      });

      row.eachCell({ includeEmpty: true }, (cell, colNum) => {
        if (colNum === 1) return;
        cell.font = { name: "Arial", size: 9 };
        cell.fill = solid(cellFill(colNum, isEvenRow));
        cell.alignment = {
          vertical: "middle",
          horizontal: colNum <= 5 ? "left" : "right",
          indent: colNum >= 2 && colNum <= 5 ? 1 : 0,
        };
        if (colNum >= 6 && colNum !== 10) {
          cell.numFmt = colNum === 11 ? daysFmt : moneyFmt;
        }
        cell.border = border("thin");
        if (colNum === 22) {
          cell.font = {
            name: "Arial",
            size: 9,
            bold: true,
            color: { argb: "FF065F46" },
          };
        }
        if (colNum === 21) {
          cell.font = {
            name: "Arial",
            size: 9,
            bold: true,
            color: { argb: "FF9F1239" },
          };
        }
      });
      row.height = 19;
    });

    const sumRow = ws.getRow(DATA_START + items.length);
    sumRow.getCell(2).value = "Summary";
    sumRow.getCell(3).value = `Count - ${items.length}`;

    const totals = {
      6: items.reduce((a, i) => a + (i.rateGross || 0), 0),
      7: items.reduce((a, i) => a + (i.rateBasic || 0), 0),
      8: items.reduce((a, i) => a + (i.rateHra || 0), 0),
      9: items.reduce(
        (a, i) =>
          a +
          Number(empById.get(String(i.employeeId))?.salary?.foodAllowance || 0),
        0,
      ),
      10: daysInMonth,
      11: items.reduce((a, i) => a + (i.payableDays || 0), 0),
      12: items.reduce((a, i) => a + (i.earnings?.grossEarnings || 0), 0),
      13: items.reduce((a, i) => a + (i.earnings?.basicSalary || 0), 0),
      14: items.reduce((a, i) => a + (i.earnings?.houseRentAllowance || 0), 0),
      15: items.reduce((a, i) => a + (i.earnings?.grossEarnings || 0), 0),
      16: items.reduce((a, i) => a + (i.deductions?.esic || 0), 0),
      17: items.reduce((a, i) => a + (i.deductions?.employerESIC || 0), 0),
      18: items.reduce(
        (a, i) =>
          a +
          ((i.deductions?.loanDeduction || 0) +
            (i.deductions?.advanceDeduction || 0)),
        0,
      ),
      19: items.reduce((a, i) => a + (i.deductions?.providentFund || 0), 0),
      20: items.reduce(
        (a, i) =>
          a + (i.deductions?.employerPF || i.deductions?.providentFund || 0),
        0,
      ),
      21: items.reduce((a, i) => a + (i.deductions?.totalDeductions || 0), 0),
      22: items.reduce((a, i) => a + (i.roundedNetPay ?? i.netPay ?? 0), 0),
    };

    Object.entries(totals).forEach(([col, val]) => {
      sumRow.getCell(parseInt(col)).value = val;
    });

    sumRow.eachCell({ includeEmpty: false }, (cell, colNum) => {
      if (colNum === 1) return;
      const sumFill =
        colNum >= 2 && colNum <= 5
          ? "FFFBFAFF"
          : colNum >= 6 && colNum <= 9
            ? "FFDBEAFE"
            : colNum >= 10 && colNum <= 11
              ? "FFCFFAFE"
              : colNum >= 12 && colNum <= 15
                ? "FFDCFCE7"
                : colNum >= 16 && colNum <= 21
                  ? "FFFFE4E6"
                  : colNum === 22
                    ? "FFA7F3D0"
                    : "FFFEFCE8";

      cell.font = {
        name: "Arial",
        size: 9,
        bold: true,
        color: {
          argb:
            colNum === 22
              ? "FF065F46"
              : colNum === 21
                ? "FF9F1239"
                : "FF111827",
        },
      };
      cell.fill = solid(sumFill);
      cell.alignment = {
        vertical: "middle",
        horizontal: colNum <= 5 ? "left" : "right",
        indent: colNum >= 2 && colNum <= 5 ? 1 : 0,
      };
      if (colNum >= 6 && colNum !== 10) {
        cell.numFmt = colNum === 11 ? daysFmt : moneyFmt;
      }
      cell.border = {
        top: { style: "medium", color: { argb: "FF000000" } },
        bottom: { style: "medium", color: { argb: "FF000000" } },
        left: { style: "thin", color: { argb: "FFD1D5DB" } },
        right: { style: "thin", color: { argb: "FFD1D5DB" } },
      };
    });
    sumRow.height = 22;

    const buffer = await wb.xlsx.writeBuffer();
    const filename = `salary_sheet_${year}-${String(month).padStart(2, "0")}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (err) {
    console.error("[PAYROLL-EXPORT]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── DELETE /run ───────────────────────────────────────────────────────────────
router.delete("/run", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can delete a payroll run",
      });
    }

    const month = parseInt(req.query.month) || new Date().getMonth() + 1;
    const year = parseInt(req.query.year) || new Date().getFullYear();

    const run = await Payroll.findOne({ month, year });
    if (!run) {
      return res.status(404).json({
        success: false,
        message: "No payroll run found for this period",
      });
    }
    if (["paid", "approved"].includes(run.status)) {
      return res.status(400).json({
        success: false,
        message: `Cannot delete a payroll run that is already ${run.status}`,
      });
    }

    await PayrollItem.deleteMany({ month, year });
    await Payroll.deleteOne({ _id: run._id });

    res.json({
      success: true,
      message: `Payroll run for ${MONTH_NAMES[month]} ${year} deleted`,
    });
  } catch (err) {
    console.error("[PAYROLL-DELETE-RUN]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post("/run/save-draft", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res
        .status(403)
        .json({ success: false, message: "Only HR managers can save payroll" });
    }

    const month = parseInt(req.body.month) || new Date().getMonth() + 1;
    const year = parseInt(req.body.year) || new Date().getFullYear();

    const existing = await Payroll.findOne({ month, year });
    if (
      existing &&
      ["processed", "paid", "approved"].includes(existing.status)
    ) {
      return res.status(400).json({
        success: false,
        message: `Payroll for ${MONTH_NAMES[month]} ${year} is already ${existing.status}. Remove it first if you need to re-draft.`,
      });
    }

    const { settings, salaryCfg, holidayMap, attendanceByEmp, leaveConfig } =
      await loadMonthContext(month, year);

    const employees = await Employee.find({
      $or: [{ status: "active" }, { isActive: true }],
    })
      .select("-password -temporaryPassword -__v")
      .lean();

    const decryptedEmployees = employees.map(decryptEmployeeDoc);

    const leaveBalances = await LeaveBalance.find({
      employeeId: { $in: employees.map((e) => e._id) },
      year,
    });
    const balanceByEmpId = new Map(
      leaveBalances.map((b) => [String(b.employeeId), b]),
    );

    // Create or reuse the Payroll run header at "draft" status
    let payrollRun = existing;
    if (!payrollRun) {
      payrollRun = new Payroll({
        month,
        year,
        payPeriod: `${MONTH_NAMES[month]} ${year}`,
        status: "draft",
        createdBy: user.id,
      });
      await payrollRun.save();
    } else {
      // Already a draft — keep it as draft, items will be upserted below
      if (payrollRun.status !== "draft") payrollRun.status = "draft";
      await payrollRun.save();
    }

    let totalGross = 0,
      totalDed = 0,
      totalNet = 0,
      totalPF = 0,
      totalESIC = 0,
      totalBonus = 0;

    for (const employee of decryptedEmployees) {
      const bid = (employee.biometricId || "").toUpperCase();
      const balance = balanceByEmpId.get(String(employee._id)) || null;
      const ctx = {
        month,
        year,
        settings,
        salaryCfg,
        holidayMap,
        leaveConfig,
        attendanceByDate: attendanceByEmp.get(bid) || new Map(),
        leaveBalance: balance,
      };
      const computed = computeEmployeePayroll(employee, ctx);

      // $setOnInsert: only on first creation — don't clobber existing manual edits
      // $set: always refresh computed attendance/salary numbers
      await PayrollItem.findOneAndUpdate(
        { employeeId: employee._id, month, year },
        {
          $setOnInsert: {
            payrollId: payrollRun._id,
            employeeName:
              `${employee.firstName || ""} ${employee.lastName || ""}`.trim(),
            biometricId: employee.biometricId,
            department: employee.department,
            designation: employee.designation || employee.jobTitle,
            jobTitle: employee.jobTitle,
            employmentType: employee.employmentType,
            month,
            year,
            payPeriod: `${MONTH_NAMES[month]} ${year}`,
          },
          $set: {
            rateBasic: computed.rateBasic ?? 0,
            rateHra: computed.rateHra ?? 0,
            rateGross: computed.rateGross ?? 0,
            workingDays: computed.workingDays,
            daysInMonth: computed.daysInMonth,
            presentDays: computed.presentDays,
            absentDays: computed.absentDays,
            halfDays: computed.halfDays,
            missPunchDays: computed.missPunchDays,
            lopDays: computed.lopDays,
            paidLeaveDays: computed.paidLeaveDays,
            weekOffDays: computed.weekOffDays,
            holidayDays: computed.holidayDays,
            holidayWorkedDays: computed.holidayWorkedDays,
            sundayWorkedDays: computed.sundayWorkedDays,
            lwpDays: computed.lwpDays,
            clUsedDays: computed.clUsedDays,
            slUsedDays: computed.slUsedDays,
            plUsedDays: computed.plUsedDays,
            autoAdjustedCL: computed.autoAdjustedCL,
            sundayOffsetApplied: computed.sundayOffsetApplied,
            unsyncedDays: computed.unsyncedDays,
            payableDays: computed.payableDays,
            effectivePayableDays: computed.effectivePayableDays,
            perDayRate: computed.perDayRate,
            preJoiningDays: computed.preJoiningDays,
            activeDaysInMonth: computed.activeDaysInMonth,
            firstActiveDayInMonth: computed.firstActiveDayInMonth,
            dateOfJoining: computed.dateOfJoining,
            daysSinceDOJ: computed.daysSinceDOJ,
            clEligible: computed.clEligible,
            // In $set, not $setOnInsert: a draft re-saved after HR corrects
            // somebody's employment type has to pick the change up, and this
            // is the flag the Interns tab and the payslip both read.
            isIntern: computed.isIntern,
            internshipType: computed.internshipType || null,
            otherDeductionFull: computed.otherDeductionFull,
            otherDeductionRecurring: computed.otherDeductionRecurring,
            otherDeductionLeaveDays: computed.otherDeductionLeaveDays,
            otherDeductionChargeableDays: computed.otherDeductionChargeableDays,
            earnings: computed.earnings,
            deductions: computed.deductions,
            netPay: computed.netPay,
            roundedNetPay: computed.roundedNetPay,
            status: "pending",
            bankDetails: computed.bankDetails,
            dayBreakdown: computed.dayBreakdown,
            processedBy: user.id,
            processedAt: new Date(),
            flagNote:
              computed.autoAdjustedCL > 0
                ? `Auto-adjusted ${computed.autoAdjustedCL} day(s) from AB to CL`
                : computed.sundayOffsetApplied > 0
                  ? `${computed.sundayOffsetApplied} AB offset by Sunday worked`
                  : computed.preJoiningDays > 0
                    ? `Mid-month joiner — ${computed.preJoiningDays} pre-joining day(s) excluded`
                    : null,
          },
        },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      );

      totalGross += computed.earnings.grossEarnings;
      totalDed += computed.deductions.totalDeductions;
      totalNet += computed.roundedNetPay;
      totalPF += computed.deductions.providentFund;
      totalESIC += computed.deductions.esic;
      totalBonus += computed.earnings.bonus || 0;
    }

    payrollRun.totalEmployees = employees.length;
    payrollRun.totalGross = totalGross;
    payrollRun.totalDeductions = totalDed;
    payrollRun.totalNetPay = totalNet;
    payrollRun.totalPF = totalPF;
    payrollRun.totalESIC = totalESIC;
    payrollRun.totalBonus = totalBonus;
    await payrollRun.save();

    res.json({
      success: true,
      message: `Draft saved for ${employees.length} employees — review and edit before processing`,
      data: {
        runId: payrollRun._id,
        status: "draft",
        summary: {
          totalEmployees: employees.length,
          totalGross,
          totalDeductions: totalDed,
          totalNetPay: totalNet,
          totalPF,
          totalESIC,
        },
      },
    });
  } catch (err) {
    console.error("[PAYROLL-SAVE-DRAFT]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ── PATCH /items/bulk-override ────────────────────────────────────────────────
// Apply earnings/deduction patch to multiple PayrollItems at once.
// Body: { itemIds: string[], patch: { overtime?, bonus?, incentives?,
//   otherEarnings?, loanDeduction?, advanceDeduction?, otherDeductions?,
//   remarks? } }
// Only touches fields present in patch. Paid items are skipped.
// The PayrollItem pre-save hook recalculates grossEarnings, totalDeductions,
// netPay, roundedNetPay automatically.
router.patch(
  "/items/bulk-override",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    try {
      const { user } = req;
      if (user.role !== "hr_manager") {
        return res.status(403).json({
          success: false,
          message: "Only HR managers can edit payroll",
        });
      }

      const { itemIds, patch } = req.body;
      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        return res
          .status(400)
          .json({ success: false, message: "itemIds array is required" });
      }
      if (!patch || typeof patch !== "object") {
        return res
          .status(400)
          .json({ success: false, message: "patch object is required" });
      }

      const settings = await PayrollSettings.getConfig();
      const results = { updated: [], skipped: [], errors: [] };

      const items = await PayrollItem.find({ _id: { $in: itemIds } });

      for (const item of items) {
        try {
          if (item.status === "paid" && settings.lockAfterPaid) {
            results.skipped.push({
              id: String(item._id),
              name: item.employeeName,
              reason: "paid and locked",
            });
            continue;
          }

          if (patch.overtime !== undefined)
            item.earnings.overtime = Math.max(0, Number(patch.overtime));
          if (patch.bonus !== undefined)
            item.earnings.bonus = Math.max(0, Number(patch.bonus));
          if (patch.incentives !== undefined)
            item.earnings.incentives = Math.max(0, Number(patch.incentives));
          if (patch.otherEarnings !== undefined)
            item.earnings.otherEarnings = Math.max(
              0,
              Number(patch.otherEarnings),
            );
          if (patch.loanDeduction !== undefined)
            item.deductions.loanDeduction = Math.max(
              0,
              Number(patch.loanDeduction),
            );
          if (patch.advanceDeduction !== undefined)
            item.deductions.advanceDeduction = Math.max(
              0,
              Number(patch.advanceDeduction),
            );
          if (patch.otherDeductions !== undefined)
            item.deductions.otherDeductions = Math.max(
              0,
              Number(patch.otherDeductions),
            );

          // Append remarks, don't replace
          if (patch.remarks !== undefined) {
            const existing = item.remarks ? item.remarks.trim() : "";
            const incoming = String(patch.remarks).trim();
            item.remarks = incoming
              ? existing
                ? `${existing}; ${incoming}`
                : incoming
              : existing;
          }

          item.isManuallyOverridden = true;
          item.lastEditedBy = user.id;
          item.lastEditedAt = new Date();
          item.markModified("earnings");
          item.markModified("deductions");
          await item.save();

          results.updated.push({
            id: String(item._id),
            name: item.employeeName,
            roundedNetPay: item.roundedNetPay,
          });
        } catch (itemErr) {
          results.errors.push({
            id: String(item._id),
            name: item.employeeName,
            error: itemErr.message,
          });
        }
      }

      res.json({
        success: true,
        message: `Bulk override: ${results.updated.length} updated, ${results.skipped.length} skipped, ${results.errors.length} errors`,
        data: results,
      });
    } catch (err) {
      console.error("[PAYROLL-BULK-OVERRIDE]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

router.patch(
  "/run/revert-to-draft",
  EmployeeAuthMiddlewear,
  async (req, res) => {
    try {
      const { user } = req;
      if (user.role !== "hr_manager") {
        return res.status(403).json({
          success: false,
          message: "Only HR managers can revert payroll",
        });
      }

      const month = parseInt(req.body.month) || new Date().getMonth() + 1;
      const year = parseInt(req.body.year) || new Date().getFullYear();

      const run = await Payroll.findOne({ month, year });
      if (!run) {
        return res.status(404).json({
          success: false,
          message: "No payroll run found for this period",
        });
      }

      if (["paid", "approved"].includes(run.status)) {
        return res.status(400).json({
          success: false,
          message: `Cannot revert a ${run.status} payroll run. Only processed runs can be reverted.`,
        });
      }

      if (run.status === "draft") {
        return res.status(400).json({
          success: false,
          message: "Payroll is already in draft status.",
        });
      }

      // Revert items: processed → pending (paid items stay paid — shouldn't exist
      // in a processed run that hasn't been mark-paid yet, but guard anyway)
      await PayrollItem.updateMany(
        { month, year, status: "processed" },
        { $set: { status: "pending" } },
      );

      run.status = "draft";
      await run.save();

      res.json({
        success: true,
        message: `Payroll for ${MONTH_NAMES[month]} ${year} reverted to draft. You can now edit individual items.`,
        data: { runId: run._id, status: "draft" },
      });
    } catch (err) {
      console.error("[PAYROLL-REVERT-DRAFT]", err);
      res.status(500).json({ success: false, message: err.message });
    }
  },
);

// ── DELETE /item/:id ──────────────────────────────────────────────────────────
// Remove ONE employee's payroll entry from a draft or processed run.
// Blocked for paid items. After deletion, updates the run-level totals.
// Use case: a contractor, resigned employee, or data-entry mistake that
// shouldn't be in this month's payroll.
router.delete("/item/:id", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { user } = req;
    if (user.role !== "hr_manager") {
      return res.status(403).json({
        success: false,
        message: "Only HR managers can remove payroll items",
      });
    }

    const item = await PayrollItem.findById(req.params.id);
    if (!item) {
      return res
        .status(404)
        .json({ success: false, message: "Payroll item not found" });
    }

    const settings = await PayrollSettings.getConfig();
    if (item.status === "paid" && settings.lockAfterPaid) {
      return res.status(400).json({
        success: false,
        message:
          "Paid payroll items cannot be removed. Contact admin to unlock.",
      });
    }

    const { month, year, payrollId } = item;
    const employeeName = item.employeeName;

    await PayrollItem.deleteOne({ _id: item._id });

    // Recompute run-level totals from remaining items
    const remaining = await PayrollItem.find({ payrollId }).lean();
    const totals = remaining.reduce(
      (acc, i) => ({
        g: acc.g + (i.earnings?.grossEarnings || 0),
        d: acc.d + (i.deductions?.totalDeductions || 0),
        n: acc.n + (i.roundedNetPay || 0),
        pf: acc.pf + (i.deductions?.providentFund || 0),
        esi: acc.esi + (i.deductions?.esic || 0),
        b: acc.b + (i.earnings?.bonus || 0),
      }),
      { g: 0, d: 0, n: 0, pf: 0, esi: 0, b: 0 },
    );

    await Payroll.updateOne(
      { _id: payrollId },
      {
        $set: {
          totalEmployees: remaining.length,
          totalGross: totals.g,
          totalDeductions: totals.d,
          totalNetPay: totals.n,
          totalPF: totals.pf,
          totalESIC: totals.esi,
          totalBonus: totals.b,
        },
      },
    );

    res.json({
      success: true,
      message: `${employeeName} removed from ${MONTH_NAMES[month]} ${year} payroll`,
      data: { remaining: remaining.length },
    });
  } catch (err) {
    console.error("[PAYROLL-REMOVE-ITEM]", err);
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.computeEmployeePayroll = computeEmployeePayroll;
module.exports.loadMonthContext = loadMonthContext;
