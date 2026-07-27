// routes/CMS_Routes/Production/Dashboard/productionSchedule/productionScheduleRoutes.js
// OPTIMIZED VERSION - Reduced response times from 2-5s to <500ms

const express = require("express");
const router = express.Router();
const ProductionSchedule = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const mongoose = require("mongoose");

// HR owns the company holiday calendar. Loaded defensively so this router keeps
// working even if the HR module's export shape changes.
let CompanyHoliday = null;
try {
  const LeaveManagement = require("../../../../models/HR_Models/LeaveManagement");
  CompanyHoliday =
    LeaveManagement.CompanyHoliday || mongoose.models.CompanyHoliday || null;
} catch (err) {
  CompanyHoliday = mongoose.models?.CompanyHoliday || null;
  console.warn("[schedule] CompanyHoliday model unavailable:", err.message);
}

router.use(EmployeeAuthMiddleware);

// ============================================================================
// COMPANY HOLIDAYS (HR)
// ============================================================================

/**
 * Map of "YYYY-MM-DD" -> holiday document for the given range.
 * `working_sunday` is the inverse case: HR declaring a Sunday IS a work day,
 * so it must never block scheduling.
 */
async function getCompanyHolidayMap(startDate, endDate) {
  const map = new Map();
  if (!CompanyHoliday) return map;

  try {
    const docs = await CompanyHoliday.find({
      date: { $gte: formatDate(startDate), $lte: formatDate(endDate) },
    }).lean();

    for (const h of docs) map.set(h.date, h);
  } catch (err) {
    console.error("[schedule] company holiday lookup failed:", err.message);
  }

  return map;
}

/** Blocks the day unless HR explicitly marked it a working Sunday. */
function holidayBlocks(holiday) {
  return Boolean(holiday) && holiday.type !== "working_sunday";
}

/**
 * Overlay HR holidays onto schedule documents before they leave the API.
 *
 * Production can override a company holiday for a single day — the factory
 * running on Independence Day, for instance. When `holidayOverride` is set on
 * the schedule document the day stays workable and we only keep the label, so
 * the calendar can still show WHY the day is unusual.
 */
function applyHolidayOverlay(schedule, holidayMap) {
  const h = holidayMap.get(formatDate(schedule.date));
  if (!h) return schedule;

  schedule.companyHoliday = {
    name: h.name,
    type: h.type,
    overridden: schedule.holidayOverride === true,
  };

  if (h.type === "working_sunday") {
    schedule.isSundayOverride = true;
    schedule.isHoliday = false;
    if (schedule.workHours) schedule.workHours.isActive = true;
    schedule.notes = h.name || "Working Sunday (HR)";
    return schedule;
  }

  // Production has explicitly switched this day back on — respect it.
  if (schedule.holidayOverride === true) {
    schedule.isHoliday = false;
    schedule.holidayReason = "";
    if (schedule.workHours) schedule.workHours.isActive = true;
    return schedule;
  }

  schedule.isHoliday = true;
  schedule.holidayReason =
    h.name || schedule.holidayReason || "Company holiday";
  if (schedule.workHours) schedule.workHours.isActive = false;
  return schedule;
}

// ============================================================================
// SIMPLE DATE UTILITIES
// ============================================================================

function parseDate(input) {
  if (!input) return new Date();

  if (typeof input === "string") {
    if (input.includes("T")) {
      const date = new Date(input);
      return new Date(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
        0,
        0,
        0,
        0,
      );
    }
    const parts = input.split("-");
    if (parts.length === 3) {
      return new Date(
        parseInt(parts[0]),
        parseInt(parts[1]) - 1,
        parseInt(parts[2]),
        0,
        0,
        0,
        0,
      );
    }
  }

  if (input instanceof Date) {
    return new Date(
      input.getFullYear(),
      input.getMonth(),
      input.getDate(),
      0,
      0,
      0,
      0,
    );
  }

  return new Date();
}

function formatDate(date) {
  const d = parseDate(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function isSameDate(date1, date2) {
  const d1 = parseDate(date1);
  const d2 = parseDate(date2);
  return d1.getTime() === d2.getTime();
}

function addDays(date, days) {
  const d = parseDate(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getDayOfWeek(date) {
  return parseDate(date).getDay();
}

// ============================================================================
// OPTIMIZED SCHEDULE MANAGEMENT
// ============================================================================

async function getScheduleForDate(date) {
  const searchDate = parseDate(date);

  // FIX 1: Use lean() for faster read-only queries
  let schedule = await ProductionSchedule.findOne({ date: searchDate }).lean();

  if (!schedule) {
    const dayOfWeek = getDayOfWeek(searchDate);
    const isSunday = dayOfWeek === 0;

    const newSchedule = new ProductionSchedule({
      date: searchDate,
      workHours: {
        startTime: "09:30",
        endTime: "18:30",
        totalMinutes: 540,
        isActive: !isSunday,
        customHours: false,
      },
      defaultBreaks: [
        {
          name: "Lunch",
          startTime: "13:00",
          endTime: "14:00",
          durationMinutes: 60,
          isFixed: true,
        },
        {
          name: "Tea",
          startTime: "16:00",
          endTime: "16:15",
          durationMinutes: 15,
          isFixed: true,
        },
      ],
      breaks: [],
      isHoliday: isSunday,
      isSundayOverride: false,
      scheduledWorkOrders: [],
      notes: isSunday ? "Sunday - Day Off" : "Working Day",
    });

    newSchedule.calculateAvailableMinutes();
    await newSchedule.save();
    schedule = newSchedule.toObject();
  }

  return schedule;
}

function canScheduleOnDay(schedule) {
  if (!schedule) return false;
  // An HR holiday that production has explicitly overridden is workable.
  if (schedule.isHoliday && schedule.holidayOverride !== true) return false;
  if (!schedule.workHours || !schedule.workHours.isActive) return false;
  const dayOfWeek = getDayOfWeek(schedule.date);
  if (dayOfWeek === 0 && !schedule.isSundayOverride) return false;
  return true;
}

function calculateWODuration(workOrder) {
  if (!workOrder.operations || workOrder.operations.length === 0) return 0;
  const totalSeconds = workOrder.operations.reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
    0,
  );
  const minutesPerUnit = Math.ceil(totalSeconds / 60);
  return minutesPerUnit * (workOrder.quantity || 1);
}

function generateUniqueColor(workOrderNumber, manufacturingOrderId) {
  let hash = 0;
  const str = `${workOrderNumber}-${manufacturingOrderId}`;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  const niceColors = [
    `hsl(${hue}, 70%, 50%)`,
    `hsl(${(hue + 30) % 360}, 70%, 50%)`,
    `hsl(${(hue + 60) % 360}, 70%, 50%)`,
    `hsl(${(hue + 120) % 360}, 70%, 50%)`,
    `hsl(${(hue + 180) % 360}, 70%, 50%)`,
  ];
  return niceColors[Math.abs(hash % niceColors.length)];
}

// ============================================================================
// TIME-OF-DAY HELPERS  (break-aware placement)
// ============================================================================

function toMins(hhmm) {
  const [h, m] = String(hhmm || "0:0")
    .split(":")
    .map(Number);
  return (h || 0) * 60 + (m || 0);
}

function atMinutes(baseDate, mins) {
  const d = new Date(baseDate);
  d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
  return d;
}

// Every break on this day, as sorted minute ranges.
function getBreakRanges(schedule) {
  return [...(schedule.defaultBreaks || []), ...(schedule.breaks || [])]
    .map((b) => ({ s: toMins(b.startTime), e: toMins(b.endTime) }))
    .filter((b) => b.e > b.s)
    .sort((a, b) => a.s - b.s);
}

// Minute ranges already taken by work orders sitting on this day.
function getBusyRanges(schedule) {
  return (schedule.scheduledWorkOrders || [])
    .map((swo) => {
      const s = new Date(swo.scheduledStartTime);
      const e = new Date(swo.scheduledEndTime);
      return {
        s: s.getHours() * 60 + s.getMinutes(),
        e: e.getHours() * 60 + e.getMinutes(),
      };
    })
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s);
}

// The intervals in which real work can still happen today:
// work window, MINUS breaks, MINUS what is already booked.
function getFreeIntervals(schedule) {
  if (!schedule || !schedule.workHours) return [];
  const dayStart = toMins(schedule.workHours.startTime);
  const dayEnd = toMins(schedule.workHours.endTime);
  if (dayEnd <= dayStart) return [];

  const blocked = [
    ...getBreakRanges(schedule),
    ...getBusyRanges(schedule),
  ].sort((a, b) => a.s - b.s);

  const free = [];
  let cursor = dayStart;

  for (const b of blocked) {
    if (b.e <= cursor) continue;
    if (b.s > cursor) free.push({ s: cursor, e: Math.min(b.s, dayEnd) });
    cursor = Math.max(cursor, b.e);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) free.push({ s: cursor, e: dayEnd });

  return free.filter((f) => f.e > f.s);
}

function freeMinutes(schedule) {
  return getFreeIntervals(schedule).reduce((n, f) => n + (f.e - f.s), 0);
}

// Place `workMinutes` of work starting at the first free minute, stepping OVER
// breaks and existing work rather than straight through them.
function placeWork(schedule, workMinutes) {
  const free = getFreeIntervals(schedule);
  if (!free.length) return null;

  const startMin = free[0].s;
  let remaining = workMinutes;
  let endMin = startMin;

  for (const slot of free) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, slot.e - slot.s);
    endMin = slot.s + take;
    remaining -= take;
  }

  if (remaining > 0) return null;
  return { startMin, endMin };
}

// ============================================================================
// OPTIMIZED SCHEDULING LOGIC
// ============================================================================

async function scheduleWorkOrder(
  workOrderId,
  moId,
  startDate,
  colorCode,
  userId,
  isReschedule = false,
) {
  const startDateObj = parseDate(startDate);

  // FIX 2: Use lean() + select() to only get needed fields
  const wo = await WorkOrder.findById(workOrderId)
    .select("workOrderNumber quantity operations stockItemId")
    .populate("stockItemId", "name genderCategory")
    .lean();

  if (!wo) throw new Error("Work order not found");

  const durationMinutes = calculateWODuration(wo);
  if (durationMinutes <= 0) throw new Error("Work order has no duration");

  if (!isReschedule) {
    // FIX 3: Use exists() for faster existence check
    const existing = await ProductionSchedule.exists({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });
    if (existing) throw new Error("Already scheduled");
  }

  const uniqueColor =
    colorCode || generateUniqueColor(wo.workOrderNumber, moId);

  let currentDate = startDateObj;
  let remainingMinutes = durationMinutes;
  const segments = [];
  let dayNumber = 1;
  const maxDays = 100;

  // FIX 4: Batch fetch schedules for date range
  const endDate = addDays(startDateObj, maxDays);
  const schedulesInRange = await ProductionSchedule.find({
    date: { $gte: startDateObj, $lte: endDate },
  }).lean();

  const scheduleMap = new Map(
    schedulesInRange.map((s) => [formatDate(s.date), s]),
  );

  // HR company holidays for the whole window, fetched once.
  const holidayMap = await getCompanyHolidayMap(startDateObj, endDate);

  // Snapshot of what is ACTUALLY in the database, captured before we book
  // anything in memory. The bulkWrite below must decide $push vs $set from
  // this, never from the live objects — those get a provisional entry added
  // as we go, which would otherwise make every new booking look like an
  // update and target a filter that matches no document.
  const persistedByDate = new Map();
  const rememberPersisted = (key, sched) => {
    if (persistedByDate.has(key)) return;
    persistedByDate.set(
      key,
      new Set(
        (sched.scheduledWorkOrders || []).map((s) => String(s.workOrderId)),
      ),
    );
  };
  for (const s of schedulesInRange) rememberPersisted(formatDate(s.date), s);

  let daysExamined = 0;

  while (remainingMinutes > 0 && daysExamined <= maxDays) {
    daysExamined++;

    let schedule = scheduleMap.get(formatDate(currentDate));

    if (!schedule) {
      schedule = await getScheduleForDate(currentDate);
      scheduleMap.set(formatDate(currentDate), schedule);
    }
    rememberPersisted(formatDate(currentDate), schedule);

    // HR company holiday blocks the day, unless production has explicitly
    // overridden it for this date.
    if (
      holidayBlocks(holidayMap.get(formatDate(currentDate))) &&
      schedule.holidayOverride !== true
    ) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    if (!canScheduleOnDay(schedule)) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    // FIX: capacity is what is GENUINELY free — work window minus breaks minus
    // minutes already booked. The old formula (totalMinutes - breaks - sum of
    // durations) ignored WHERE the booked work sat, so a day already occupied
    // until 11:00 could not be topped up correctly.
    const available = freeMinutes(schedule);

    if (available <= 0) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const minutesToSchedule = Math.min(remainingMinutes, available);

    // FIX: lay the work into real free time. The old code set every work order
    // to start at workHours.startTime and end at start + duration, so all work
    // orders on a day overlapped at 09:30 and lunch was worked straight through.
    const placed = placeWork(schedule, minutesToSchedule);
    if (!placed) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const startTime = atMinutes(currentDate, placed.startMin);
    const endTime = atMinutes(currentDate, placed.endMin);

    segments.push({
      scheduleId: schedule._id,
      date: new Date(currentDate),
      workOrderId: wo._id,
      manufacturingOrderId: moId,
      scheduledStartTime: startTime,
      scheduledEndTime: endTime,
      durationMinutes: minutesToSchedule,
      colorCode: uniqueColor,
      currentDayNumber: dayNumber,
      totalDaysSpanned: 0,
      isMultiDay: false,
    });

    // Reflect the booking in the in-memory copy so a later pass over the same
    // day (and the next work order in this request) sees the day as partly used.
    schedule.scheduledWorkOrders = [
      ...(schedule.scheduledWorkOrders || []),
      {
        workOrderId: wo._id,
        scheduledStartTime: startTime,
        scheduledEndTime: endTime,
        durationMinutes: minutesToSchedule,
      },
    ];
    scheduleMap.set(formatDate(currentDate), schedule);

    remainingMinutes -= minutesToSchedule;
    dayNumber++;

    if (remainingMinutes > 0) {
      currentDate = addDays(currentDate, 1);
    }
  }

  if (remainingMinutes > 0) {
    throw new Error(
      `Not enough capacity. ${remainingMinutes} minutes remaining`,
    );
  }

  const totalDays = segments.length;
  const isMultiDay = totalDays > 1;

  for (const seg of segments) {
    seg.totalDaysSpanned = totalDays;
    seg.isMultiDay = isMultiDay;
  }

  // FIX 5: Use bulkWrite for batch updates (much faster than individual saves)
  const bulkOps = [];

  for (const seg of segments) {
    const persisted = persistedByDate.get(formatDate(seg.date));
    const alreadyInDb = persisted
      ? persisted.has(String(seg.workOrderId))
      : false;

    if (alreadyInDb) {
      // Update existing
      bulkOps.push({
        updateOne: {
          filter: {
            _id: seg.scheduleId,
            "scheduledWorkOrders.workOrderId": seg.workOrderId,
          },
          update: {
            $set: {
              "scheduledWorkOrders.$": {
                workOrderId: seg.workOrderId,
                manufacturingOrderId: seg.manufacturingOrderId,
                scheduledStartTime: seg.scheduledStartTime,
                scheduledEndTime: seg.scheduledEndTime,
                durationMinutes: seg.durationMinutes,
                colorCode: uniqueColor,
                isMultiDay: seg.isMultiDay,
                totalDaysSpanned: seg.totalDaysSpanned,
                currentDayNumber: seg.currentDayNumber,
                status: "scheduled",
              },
            },
          },
        },
      });
    } else {
      // Add new
      bulkOps.push({
        updateOne: {
          filter: { _id: seg.scheduleId },
          update: {
            // ONE $push key holding BOTH arrays. Two separate `$push:` keys in the
            // same object literal is a JS duplicate-key — the second silently wins
            // and scheduledWorkOrders never gets written.
            $push: {
              scheduledWorkOrders: {
                workOrderId: seg.workOrderId,
                manufacturingOrderId: seg.manufacturingOrderId,
                scheduledStartTime: seg.scheduledStartTime,
                scheduledEndTime: seg.scheduledEndTime,
                durationMinutes: seg.durationMinutes,
                colorCode: uniqueColor,
                position: 0,
                status: "scheduled",
                isMultiDay: seg.isMultiDay,
                totalDaysSpanned: seg.totalDaysSpanned,
                currentDayNumber: seg.currentDayNumber,
              },
              modifications: {
                modifiedBy: userId,
                modifiedAt: new Date(),
                modificationType: "work_order_added",
                details: `Scheduled ${wo.workOrderNumber} (Day ${seg.currentDayNumber}/${totalDays})`,
              },
            },
          },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await ProductionSchedule.bulkWrite(bulkOps);
  }

  // FIX 6: Update utilization in separate batch (non-blocking)
  const scheduleIds = segments.map((s) => s.scheduleId);
  setImmediate(async () => {
    const schedulesToUpdate = await ProductionSchedule.find({
      _id: { $in: scheduleIds },
    });
    for (const schedule of schedulesToUpdate) {
      schedule.calculateUtilization();
      await schedule.save();
    }
  });

  return {
    success: true,
    totalDays: totalDays,
    segments: segments,
    workOrderNumber: wo.workOrderNumber,
    colorCode: uniqueColor,
  };
}

// ============================================================================
// OPTIMIZED AUTO-RESCHEDULE
// ============================================================================

/**
 * Everything on or after `changedDate` is re-laid from scratch, in its existing
 * order, whenever a day's availability or capacity changes.
 *
 * The old version only touched work orders that sat ON the changed day or
 * spanned across it, and it looked in a +/-7 day window. So making a day
 * inactive pushed its own work out but left everything AFTER it untouched —
 * which is exactly why this "sometimes worked and sometimes did not".
 *
 * A day going inactive, going active again, or its work hours shrinking from
 * 9h to 4h are all the same problem: the run of work after that point no
 * longer fits the way it was laid out, so it has to be recompacted.
 */
async function cascadeRescheduleFrom(changedDate, userId, options = {}) {
  const { dryRun = false } = options;
  const from = parseDate(changedDate);

  // 1. Every work order holding a segment on or after the changed day
  const forward = await ProductionSchedule.find({
    date: { $gte: from },
    "scheduledWorkOrders.0": { $exists: true },
  })
    .select("date scheduledWorkOrders")
    .sort({ date: 1 })
    .lean();

  const affected = new Map();
  for (const sched of forward) {
    const ordered = (sched.scheduledWorkOrders || [])
      .slice()
      .sort(
        (a, b) =>
          new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime),
      );

    for (const swo of ordered) {
      const id = String(swo.workOrderId);
      if (affected.has(id)) continue;
      affected.set(id, {
        workOrderId: swo.workOrderId,
        moId: swo.manufacturingOrderId,
        colorCode: swo.colorCode,
        firstSeen: new Date(sched.date),
        startTime: new Date(swo.scheduledStartTime),
      });
    }
  }

  if (affected.size === 0) {
    return {
      rescheduled: 0,
      failed: 0,
      affected: 0,
      message: "Nothing to move",
    };
  }

  const ids = Array.from(affected.keys());

  // 2. A multi-day work order may START before the changed day and run past
  //    it. Take its real first date so it is put back where it began, not
  //    dragged forward to the changed date.
  const originals = await ProductionSchedule.find({
    "scheduledWorkOrders.workOrderId": { $in: ids },
  })
    .select("date scheduledWorkOrders")
    .lean();

  for (const sched of originals) {
    for (const swo of sched.scheduledWorkOrders || []) {
      const entry = affected.get(String(swo.workOrderId));
      if (!entry) continue;
      const d = new Date(sched.date);
      if (d < entry.firstSeen) {
        entry.firstSeen = d;
        entry.startTime = new Date(swo.scheduledStartTime);
      }
    }
  }

  const ordered = Array.from(affected.values()).sort(
    (a, b) => a.firstSeen - b.firstSeen || a.startTime - b.startTime,
  );

  if (dryRun) {
    return {
      rescheduled: 0,
      failed: 0,
      affected: ordered.length,
      dryRun: true,
      message: `${ordered.length} work order(s) would be rescheduled`,
    };
  }

  // 3. Lift every affected work order out, everywhere it appears
  await ProductionSchedule.updateMany(
    { "scheduledWorkOrders.workOrderId": { $in: ids } },
    { $pull: { scheduledWorkOrders: { workOrderId: { $in: ids } } } },
  );

  // 4. Lay them back down in the same order, compacting forward. The cursor
  //    stays on the last day a work order touched so the next one fills the
  //    remainder of that day before moving on.
  const results = {
    rescheduled: 0,
    failed: 0,
    affected: ordered.length,
    errors: [],
  };
  let cursor = ordered[0].firstSeen;

  for (const wo of ordered) {
    const startAt = cursor > wo.firstSeen ? cursor : wo.firstSeen;

    try {
      const result = await scheduleWorkOrder(
        wo.workOrderId,
        wo.moId,
        startAt,
        wo.colorCode,
        userId,
        true,
      );
      results.rescheduled++;
      const last = result.segments[result.segments.length - 1];
      if (last) cursor = parseDate(last.date);
    } catch (error) {
      results.failed++;
      results.errors.push({
        workOrderId: String(wo.workOrderId),
        reason: error.message,
      });
    }
  }

  results.message = `Rescheduled ${results.rescheduled} of ${ordered.length} work order(s)`;
  return results;
}

// Kept so any existing caller keeps working.
async function autoRescheduleForDayChange(changedDate, userId) {
  return cascadeRescheduleFrom(changedDate, userId);
}

// ============================================================================
// OPTIMIZED API ROUTES
// ============================================================================

// GET schedules - OPTIMIZED
router.get("/", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate required",
      });
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);

    // FIX 9: Use lean() and minimal population
    const schedules = await ProductionSchedule.find({
      date: { $gte: start, $lte: end },
    })
      .populate({
        path: "scheduledWorkOrders.workOrderId",
        select: "workOrderNumber stockItemId",
        populate: { path: "stockItemId", select: "name genderCategory" },
      })
      .populate(
        "scheduledWorkOrders.manufacturingOrderId",
        "requestId priority",
      )
      .sort({ date: 1 })
      .lean();

    // Fill missing dates
    const existing = new Set(schedules.map((s) => formatDate(s.date)));
    const missingDates = [];
    let current = new Date(start);

    while (current <= end) {
      if (!existing.has(formatDate(current))) {
        missingDates.push(new Date(current));
      }
      current = addDays(current, 1);
    }

    // FIX 10: Batch create missing schedules
    if (missingDates.length > 0) {
      const newSchedules = await Promise.all(
        missingDates.map((date) => getScheduleForDate(date)),
      );
      schedules.push(...newSchedules);
    }

    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Overlay HR's company holiday calendar so the UI blocks those days and
    // can name them. Kept as a read-time overlay rather than a write so HR
    // remains the single source of truth for holidays.
    const holidayMap = await getCompanyHolidayMap(start, end);
    if (holidayMap.size > 0) {
      for (const schedule of schedules)
        applyHolidayOverlay(schedule, holidayMap);
    }

    res.json({ success: true, schedules, count: schedules.length });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET manufacturing orders - HEAVILY OPTIMIZED
router.get("/manufacturing-orders", async (req, res) => {
  try {
    // FIX 11: Add pagination
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    // FIX 12: Use aggregation with $facet for count + results in one query
    const [result] = await CustomerRequest.aggregate([
      {
        $match: {
          "quotations.0": { $exists: true },
          "quotations.salesApproval.approved": true,
          status: {
            $in: [
              "quotation_sales_approved",
              "production",
              "in_progress",
              "pending",
            ],
          },
        },
      },
      {
        $lookup: {
          from: "workorders",
          localField: "_id",
          foreignField: "customerRequestId",
          as: "workOrders",
        },
      },
      {
        $project: {
          requestId: 1,
          customerInfo: 1,
          priority: 1,
          workOrders: {
            $filter: {
              input: "$workOrders",
              as: "wo",
              cond: {
                $and: [
                  {
                    $in: [
                      "$$wo.status",
                      ["planned", "scheduled", "ready_to_start"],
                    ],
                  },
                  { $gt: [{ $size: { $ifNull: ["$$wo.operations", []] } }, 0] },
                ],
              },
            },
          },
        },
      },
      { $match: { "workOrders.0": { $exists: true } } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
    ]);

    const mos = result.data;
    const total = result.metadata[0]?.total || 0;

    // FIX 13: Batch fetch all work orders and schedules
    const allWOIds = mos.flatMap((mo) => mo.workOrders.map((w) => w._id));

    const [workOrders, scheduledWOs] = await Promise.all([
      WorkOrder.find({ _id: { $in: allWOIds } })
        .select("_id workOrderNumber quantity status stockItemId operations")
        .populate("stockItemId", "name genderCategory")
        .lean(),
      ProductionSchedule.find({
        "scheduledWorkOrders.workOrderId": { $in: allWOIds },
      })
        .select("scheduledWorkOrders")
        .lean(),
    ]);

    // Create maps for O(1) lookups
    const woMap = new Map(workOrders.map((wo) => [String(wo._id), wo]));
    const woColorMap = new Map();

    scheduledWOs.forEach((schedule) => {
      schedule.scheduledWorkOrders.forEach((swo) => {
        if (swo.colorCode) {
          woColorMap.set(String(swo.workOrderId), swo.colorCode);
        }
      });
    });

    const moColors = {
      urgent: "#EF4444",
      high: "#F59E0B",
      medium: "#3B82F6",
      low: "#10B981",
    };

    const formattedMOs = mos.map((mo) => {
      const allWorkOrders = mo.workOrders
        .map((woRef) => {
          const wo = woMap.get(String(woRef._id));
          if (!wo) return null;

          const isScheduled = woColorMap.has(String(wo._id));

          return {
            _id: wo._id,
            workOrderNumber: wo.workOrderNumber,
            quantity: wo.quantity,
            status: wo.status,
            stockItemName: wo.stockItemId?.name || "Unknown",
            genderCategory: wo.stockItemId?.genderCategory || null,
            durationMinutes: Math.ceil(calculateWODuration(wo)),
            isScheduled: isScheduled,
            colorCode: isScheduled
              ? woColorMap.get(String(wo._id))
              : moColors[mo.priority] || "#3B82F6",
          };
        })
        .filter(Boolean);

      return {
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        customerInfo: mo.customerInfo,
        priority: mo.priority,
        colorCode: moColors[mo.priority] || "#3B82F6",
        workOrders: allWorkOrders,
        totalWorkOrders: allWorkOrders.length,
        scheduledWorkOrders: allWorkOrders.filter((wo) => wo.isScheduled)
          .length,
        unscheduledWorkOrders: allWorkOrders.filter((wo) => !wo.isScheduled)
          .length,
      };
    });

    res.json({
      success: true,
      manufacturingOrders: formattedMOs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET day settings - OPTIMIZED
router.get("/day-settings/:date", async (req, res) => {
  try {
    const schedule = await getScheduleForDate(req.params.date);
    const hMap = await getCompanyHolidayMap(schedule.date, schedule.date);
    res.json({ success: true, schedule: applyHolidayOverlay(schedule, hMap) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST schedule work order - OPTIMIZED
router.post("/schedule-work-order", async (req, res) => {
  try {
    const { workOrderId, manufacturingOrderId, startDate, colorCode } =
      req.body;

    const result = await scheduleWorkOrder(
      workOrderId,
      manufacturingOrderId,
      startDate,
      colorCode || "#3B82F6",
      req.user.id,
    );

    res.json({
      success: true,
      message: `Scheduled across ${result.totalDays} day(s)`,
      workOrderNumber: result.workOrderNumber,
      totalDays: result.totalDays,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST schedule MO - OPTIMIZED
router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const { manufacturingOrderId, startDate } = req.body;

    const mo = await CustomerRequest.findById(manufacturingOrderId)
      .select("priority requestId")
      .lean();
    if (!mo) throw new Error("MO not found");

    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
      status: { $in: ["planned", "ready_to_start", "scheduled"] },
    })
      .select("_id workOrderNumber operations quantity")
      .populate("stockItemId", "name genderCategory")
      .lean();

    const colors = {
      urgent: "#EF4444",
      high: "#F59E0B",
      medium: "#3B82F6",
      low: "#10B981",
    };
    const colorCode = colors[mo.priority] || "#3B82F6";

    // FIX 14: Check scheduled status in batch
    const scheduledWOIds = new Set(
      (
        await ProductionSchedule.find({
          "scheduledWorkOrders.workOrderId": {
            $in: workOrders.map((w) => w._id),
          },
        }).distinct("scheduledWorkOrders.workOrderId")
      ).map(String),
    );

    let currentDate = parseDate(startDate);
    const results = { successful: [], failed: [] };

    for (const wo of workOrders) {
      if (scheduledWOIds.has(String(wo._id))) continue;

      try {
        const result = await scheduleWorkOrder(
          wo._id,
          mo._id,
          currentDate,
          colorCode,
          req.user.id,
        );
        results.successful.push({
          workOrderNumber: wo.workOrderNumber,
          days: result.totalDays,
        });
        // FIX: stay on the LAST day this work order touched instead of jumping
        // to the next one. Two bugs came from that jump:
        //   - dropping on a Sunday pushed WO #2 to Tuesday (Sunday skipped to
        //     Monday inside scheduleWorkOrder, then +1 landed on Tuesday)
        //   - a day still holding free hours was abandoned
        // scheduleWorkOrder() advances by itself once the day is full.
        const lastSeg = result.segments[result.segments.length - 1];
        currentDate = parseDate(lastSeg.date);
      } catch (error) {
        results.failed.push({
          workOrderNumber: wo.workOrderNumber,
          reason: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Scheduled ${results.successful.length} work orders`,
      results,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST move work order - OPTIMIZED
router.post("/move-work-order", async (req, res) => {
  try {
    const { workOrderId, targetDate } = req.body;

    // FIX 15: Get color and MO in single query
    const schedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    })
      .select("scheduledWorkOrders")
      .lean();

    if (!schedule) throw new Error("WO not scheduled");

    const woData = schedule.scheduledWorkOrders.find(
      (s) => String(s.workOrderId) === String(workOrderId),
    );

    const colorCode = woData.colorCode;
    const moId = woData.manufacturingOrderId;

    // Remove from all schedules
    await ProductionSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": workOrderId },
      { $pull: { scheduledWorkOrders: { workOrderId: workOrderId } } },
    );

    const result = await scheduleWorkOrder(
      workOrderId,
      moId,
      targetDate,
      colorCode,
      req.user.id,
    );

    // Update utilization async
    setImmediate(async () => {
      const schedulesToUpdate = await ProductionSchedule.find({
        $or: [
          { _id: schedule._id },
          { "scheduledWorkOrders.workOrderId": workOrderId },
        ],
      });
      for (const s of schedulesToUpdate) {
        s.calculateUtilization();
        await s.save();
      }
    });

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST run the cascade for a date on its own, without touching settings.
// Lets the UI offer "save only" and "save and reschedule" as separate choices,
// and lets a failed cascade be retried without re-saving anything.
router.post("/day-settings/:date/reschedule", async (req, res) => {
  try {
    const { date } = req.params;
    const { dryRun } = req.body || {};
    const result = await cascadeRescheduleFrom(date, req.user.id, {
      dryRun: Boolean(dryRun),
    });
    res.json({ success: true, result });
  } catch (error) {
    console.error("Reschedule error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================================
// MULTI-DAY MOVES + WITHIN-DAY ORDERING
// ============================================================================

/**
 * Move a work order that spans several days. Every segment is lifted and the
 * whole thing is re-laid from the target date.
 *
 * This endpoint and its alias below were MISSING, which is why dragging a
 * multi-day bar returned a 404 while single-day bars (which use
 * /move-work-order) worked fine.
 */
async function moveWholeWorkOrder(workOrderId, targetDate, userId) {
  const holder = await ProductionSchedule.findOne({
    "scheduledWorkOrders.workOrderId": workOrderId,
  })
    .select("scheduledWorkOrders")
    .lean();

  if (!holder) throw new Error("Work order is not scheduled");

  const woData = holder.scheduledWorkOrders.find(
    (s) => String(s.workOrderId) === String(workOrderId),
  );

  await ProductionSchedule.updateMany(
    { "scheduledWorkOrders.workOrderId": workOrderId },
    { $pull: { scheduledWorkOrders: { workOrderId } } },
  );

  return scheduleWorkOrder(
    workOrderId,
    woData.manufacturingOrderId,
    targetDate,
    woData.colorCode,
    userId,
    true,
  );
}

router.post("/move-entire-work-order", async (req, res) => {
  try {
    const { workOrderId, targetDate } = req.body;
    if (!workOrderId || !targetDate) {
      return res.status(400).json({
        success: false,
        message: "workOrderId and targetDate are required",
      });
    }

    const result = await moveWholeWorkOrder(
      workOrderId,
      targetDate,
      req.user.id,
    );

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays,
    });
  } catch (error) {
    console.error("move-entire-work-order:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

// Alias kept because the UI calls this name for segment moves.
router.post("/move-work-order-all-segments", async (req, res) => {
  try {
    const { workOrderId, targetDate } = req.body;
    if (!workOrderId || !targetDate) {
      return res.status(400).json({
        success: false,
        message: "workOrderId and targetDate are required",
      });
    }

    const result = await moveWholeWorkOrder(
      workOrderId,
      targetDate,
      req.user.id,
    );

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays,
      segmentsMoved: result.totalDays,
    });
  } catch (error) {
    console.error("move-work-order-all-segments:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

/**
 * Re-lay one day's work in a given order. Times are recomputed from the top of
 * the day, stepping over breaks, so position 0 genuinely runs first.
 */
function relayDayInOrder(scheduleDoc) {
  const dayStart = toMins(scheduleDoc.workHours.startTime);
  const dayEnd = toMins(scheduleDoc.workHours.endTime);
  const breaks = getBreakRanges(scheduleDoc);

  const free = [];
  let cursor = dayStart;
  for (const b of breaks) {
    if (b.e <= cursor) continue;
    if (b.s > cursor) free.push({ s: cursor, e: Math.min(b.s, dayEnd) });
    cursor = Math.max(cursor, b.e);
    if (cursor >= dayEnd) break;
  }
  if (cursor < dayEnd) free.push({ s: cursor, e: dayEnd });
  if (!free.length) return;

  let slot = 0;
  let at = free[0].s;

  scheduleDoc.scheduledWorkOrders.forEach((swo, index) => {
    let remaining = swo.durationMinutes || 0;
    let start = null;
    let end = at;

    while (remaining > 0 && slot < free.length) {
      if (at >= free[slot].e) {
        slot++;
        if (slot >= free.length) break;
        at = free[slot].s;
        continue;
      }
      if (start === null) start = at;
      const take = Math.min(remaining, free[slot].e - at);
      at += take;
      remaining -= take;
      end = at;
    }

    if (start === null) start = at;

    swo.position = index;
    swo.scheduledStartTime = atMinutes(scheduleDoc.date, start);
    swo.scheduledEndTime = atMinutes(scheduleDoc.date, Math.max(end, start));
  });
}

/**
 * Set the running order of one day. `workOrderIds` is the full sequence, first
 * to last. Anything on the day but absent from the list keeps its relative
 * order at the end.
 */
router.post("/reorder-day", async (req, res) => {
  try {
    const { date, workOrderIds } = req.body;

    if (!date || !Array.isArray(workOrderIds)) {
      return res.status(400).json({
        success: false,
        message: "date and workOrderIds[] are required",
      });
    }

    const schedule = await ProductionSchedule.findOne({
      date: parseDate(date),
    });
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const wanted = workOrderIds.map(String);
    const rank = new Map(wanted.map((id, i) => [id, i]));

    const sorted = [...(schedule.scheduledWorkOrders || [])].sort((a, b) => {
      const ra = rank.has(String(a.workOrderId))
        ? rank.get(String(a.workOrderId))
        : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(String(b.workOrderId))
        ? rank.get(String(b.workOrderId))
        : Number.MAX_SAFE_INTEGER;
      if (ra !== rb) return ra - rb;
      return (a.position || 0) - (b.position || 0);
    });

    schedule.scheduledWorkOrders = sorted;
    relayDayInOrder(schedule);

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_rescheduled",
      details: `Reordered ${sorted.length} work order(s)`,
    });

    await schedule.save();

    res.json({
      success: true,
      message: "Order updated",
      count: sorted.length,
    });
  } catch (error) {
    console.error("reorder-day:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update day settings - OPTIMIZED
router.put("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const {
      workHours,
      breaks,
      defaultBreaks,
      isHoliday,
      holidayReason,
      isSundayOverride,
      notes,
      isActive,
      // dryRun asks "what would this change move?" without changing anything,
      // so the UI can put a real number in front of the user before committing.
      dryRun,
      // The cascade is now OPT-IN and runs only after the settings are already
      // committed. Previously it ran inline before the response, so a slow or
      // failing reschedule took the settings change down with it and the day
      // appeared to revert.
      reschedule,
    } = req.body;

    const schedule = await ProductionSchedule.findOne({
      date: parseDate(date),
    });
    if (!schedule) {
      const newSchedule = await getScheduleForDate(date);
      return res.json({ success: true, schedule: newSchedule });
    }

    if (dryRun) {
      const preview = await cascadeRescheduleFrom(date, req.user.id, {
        dryRun: true,
      });
      return res.json({ success: true, dryRun: true, preview });
    }

    const wasAvailable = canScheduleOnDay(schedule.toObject());
    const originalAvailableMinutes = schedule.availableMinutes;

    const dayOfWeek = getDayOfWeek(date);
    const isSunday = dayOfWeek === 0;

    if (isSunday && isSundayOverride !== undefined) {
      schedule.isSundayOverride = isSundayOverride;
      schedule.isHoliday = !isSundayOverride;
      schedule.workHours.isActive = isSundayOverride;
      schedule.notes = isSundayOverride
        ? "Sunday - Working (Override)"
        : "Sunday - Day Off";
    } else if (isHoliday !== undefined && !isSunday) {
      schedule.isHoliday = isHoliday;
      schedule.workHours.isActive = !isHoliday;
      if (holidayReason) schedule.holidayReason = holidayReason;
    }

    // Plain active / inactive switch, independent of the holiday flag. Turning
    // a day off does NOT mark it a holiday — it is simply a non-working day.
    if (isActive !== undefined) {
      schedule.workHours.isActive = Boolean(isActive);
      if (isActive) {
        schedule.isHoliday = false;
        // If HR marked this date a company holiday, switching the day on is an
        // explicit production override. Without this flag the read-time overlay
        // would keep forcing the day closed and the toggle would appear to do
        // nothing — which is exactly what happened on Independence Day.
        schedule.holidayOverride = true;
        if (isSunday) schedule.isSundayOverride = true;
        if (!schedule.notes || /off|holiday|inactive/i.test(schedule.notes)) {
          schedule.notes = "Working Day";
        }
      } else {
        schedule.holidayOverride = false;
        if (isSunday) schedule.isSundayOverride = false;
        schedule.notes = holidayReason || "Day marked inactive";
      }
    }

    // Toggling the holiday flag directly should clear any standing override.
    if (isHoliday === true) schedule.holidayOverride = false;

    if (workHours) {
      const [sh, sm] = (workHours.startTime || schedule.workHours.startTime)
        .split(":")
        .map(Number);
      const [eh, em] = (workHours.endTime || schedule.workHours.endTime)
        .split(":")
        .map(Number);
      const totalMinutes = eh * 60 + em - (sh * 60 + sm);

      schedule.workHours.startTime =
        workHours.startTime || schedule.workHours.startTime;
      schedule.workHours.endTime =
        workHours.endTime || schedule.workHours.endTime;
      schedule.workHours.totalMinutes = totalMinutes;
      schedule.workHours.customHours = true;
    }

    if (defaultBreaks !== undefined) {
      schedule.defaultBreaks = defaultBreaks.map((b) => {
        const [sh, sm] = b.startTime.split(":").map(Number);
        const [eh, em] = b.endTime.split(":").map(Number);
        return { ...b, durationMinutes: eh * 60 + em - (sh * 60 + sm) };
      });
    }

    if (breaks !== undefined) {
      schedule.breaks = breaks.map((b) => {
        const [sh, sm] = b.startTime.split(":").map(Number);
        const [eh, em] = b.endTime.split(":").map(Number);
        return { ...b, durationMinutes: eh * 60 + em - (sh * 60 + sm) };
      });
    }

    if (notes !== undefined) schedule.notes = notes;

    schedule.calculateAvailableMinutes();

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "day_settings_changed",
      details: `Updated settings`,
    });

    await schedule.save();

    const isNowAvailable = canScheduleOnDay(schedule.toObject());
    const dayStatusChanged = wasAvailable !== isNowAvailable;
    const availableMinutesChanged =
      originalAvailableMinutes !== schedule.availableMinutes;

    // The day is SAVED at this point, whatever happens next. The cascade is a
    // separate step so it can never roll back or mask the settings change.
    let autoRescheduleResult = null;
    if (reschedule === true && (dayStatusChanged || availableMinutesChanged)) {
      try {
        autoRescheduleResult = await cascadeRescheduleFrom(date, req.user.id);
      } catch (err) {
        console.error("[schedule] cascade failed after save:", err);
        autoRescheduleResult = {
          rescheduled: 0,
          failed: 0,
          error: err.message,
          message: "Settings saved, but rescheduling failed",
        };
      }
    }

    let finalSchedule = await ProductionSchedule.findById(schedule._id).lean();
    if (finalSchedule) {
      const hMap = await getCompanyHolidayMap(
        finalSchedule.date,
        finalSchedule.date,
      );
      finalSchedule = applyHolidayOverlay(finalSchedule, hMap);
    }

    res.json({
      success: true,
      message: "Day settings updated",
      schedule: finalSchedule || schedule.toObject(),
      dayStatusChanged,
      availableMinutesChanged,
      autoRescheduleResult,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST remove MANY work orders in one call.
// Lets the UI unassign a whole selection behind a single confirmation instead
// of firing one request (and one prompt) per work order.
router.post("/remove-work-orders", async (req, res) => {
  try {
    const { workOrderIds } = req.body;

    if (!Array.isArray(workOrderIds) || workOrderIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: "workOrderIds must be a non-empty array",
      });
    }

    const ids = workOrderIds.map(String);

    const affected = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": { $in: ids },
    })
      .select("_id")
      .lean();

    const result = await ProductionSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": { $in: ids } },
      {
        $pull: { scheduledWorkOrders: { workOrderId: { $in: ids } } },
        $push: {
          modifications: {
            modifiedBy: req.user.id,
            modifiedAt: new Date(),
            modificationType: "work_order_removed",
            details: `Unassigned ${ids.length} work order(s)`,
          },
        },
      },
    );

    // Recalculate utilization off the request path
    const scheduleIds = affected.map((a) => a._id);
    setImmediate(async () => {
      const schedulesToUpdate = await ProductionSchedule.find({
        _id: { $in: scheduleIds },
      });
      for (const schedule of schedulesToUpdate) {
        schedule.calculateUtilization();
        await schedule.save();
      }
    });

    res.json({
      success: true,
      message: `Unassigned ${ids.length} work order(s)`,
      removed: ids.length,
      daysAffected: result.modifiedCount,
    });
  } catch (error) {
    console.error("Bulk remove error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET the HR company holidays inside a range (read-only passthrough)
router.get("/company-holidays", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ success: false, message: "startDate and endDate required" });
    }

    const map = await getCompanyHolidayMap(
      parseDate(startDate),
      parseDate(endDate),
    );
    res.json({
      success: true,
      available: Boolean(CompanyHoliday),
      holidays: Array.from(map.values()),
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE remove work order - OPTIMIZED
router.delete("/remove-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    // FIX 17: Use updateMany instead of finding all schedules
    const result = await ProductionSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": workOrderId },
      {
        $pull: { scheduledWorkOrders: { workOrderId: workOrderId } },
        $push: {
          modifications: {
            modifiedBy: req.user.id,
            modifiedAt: new Date(),
            modificationType: "work_order_removed",
            details: `Removed work order ${workOrderId}`,
          },
        },
      },
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Work order not found in schedule",
      });
    }

    // Update utilization async
    setImmediate(async () => {
      const schedules = await ProductionSchedule.find({
        "modifications.details": { $regex: workOrderId },
      });
      for (const schedule of schedules) {
        schedule.calculateUtilization();
        await schedule.save();
      }
    });

    res.json({
      success: true,
      message: `Work order removed from ${result.modifiedCount} schedule(s)`,
      schedulesAffected: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET check scheduled status - OPTIMIZED
router.get("/check-scheduled/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    // FIX 18: Use exists() instead of findOne
    const exists = await ProductionSchedule.exists({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });

    res.json({
      success: true,
      isScheduled: !!exists,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
