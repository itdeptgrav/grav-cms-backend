// routes/CMS_Routes/Sales/SalesSchedule/salesScheduleRoutes.js
//
// Sales planning calendar. Same drag-and-drop planning logic as the production
// schedule, but a different audience and therefore a different rule about what
// is visible:
//
//   Production shows only what it can actually run right now — sales-approved
//   orders whose work orders are planned/scheduled/ready and already costed.
//
//   Sales plans the whole book. EVERY customer request and EVERY work order is
//   listed here regardless of request status, work order status, or whether the
//   work order has operation timings yet. Sales needs to promise dates on an
//   order long before production will accept it.
//
// It writes to its own SalesSchedule collection, so nothing here can move,
// unassign, or recapacity anything on the production calendar.

const express = require("express");
const router = express.Router();
const SalesSchedule = require("../../../../models/CMS_Models/Sales/SalesSchedule/SalesSchedule");
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
  console.warn("[sales-schedule] CompanyHoliday model unavailable:", err.message);
}

router.use(EmployeeAuthMiddleware);

// ============================================================================
// COMPANY HOLIDAYS (HR)
// ============================================================================

/**
 * Map of "YYYY-MM-DD" -> holiday document for the given range.
 * `working_sunday` is the inverse case: HR declaring a Sunday IS a work day,
 * so it must never block planning.
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
    console.error("[sales-schedule] company holiday lookup failed:", err.message);
  }

  return map;
}

/** Blocks the day unless HR explicitly marked it a working Sunday. */
function holidayBlocks(holiday) {
  return Boolean(holiday) && holiday.type !== "working_sunday";
}

/**
 * Overlay HR holidays onto schedule documents before they leave the API.
 * Sales can override a company holiday for a single day; when `holidayOverride`
 * is set the day stays workable and we keep only the label so the calendar can
 * still show WHY the day is unusual.
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
// DATE UTILITIES
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

function addDays(date, days) {
  const d = parseDate(date);
  d.setDate(d.getDate() + days);
  return d;
}

function getDayOfWeek(date) {
  return parseDate(date).getDay();
}

// ============================================================================
// SCHEDULE MANAGEMENT
// ============================================================================

async function getScheduleForDate(date) {
  const searchDate = parseDate(date);

  let schedule = await SalesSchedule.findOne({ date: searchDate }).lean();

  if (!schedule) {
    const isSunday = getDayOfWeek(searchDate) === 0;

    const newSchedule = new SalesSchedule({
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
  // An HR holiday that sales has explicitly overridden is workable.
  if (schedule.isHoliday && schedule.holidayOverride !== true) return false;
  if (!schedule.workHours || !schedule.workHours.isActive) return false;
  if (getDayOfWeek(schedule.date) === 0 && !schedule.isSundayOverride)
    return false;
  return true;
}

// ============================================================================
// DURATION
// ============================================================================

// Sales lists work orders that production would never show, including ones with
// no operations attached yet. Those have no computable duration, and refusing
// to place them would make the "show everything" rule useless — the work order
// would appear in the panel and then fail the moment it was dropped. They get a
// nominal block instead, flagged so the UI can mark the bar as an estimate.
const FALLBACK_MINUTES_PER_UNIT = 5;
const FALLBACK_MIN_BLOCK = 60;

function woDuration(workOrder) {
  const totalSeconds = (workOrder.operations || []).reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
    0,
  );

  if (totalSeconds > 0) {
    const minutesPerUnit = Math.ceil(totalSeconds / 60);
    return {
      minutes: minutesPerUnit * (workOrder.quantity || 1),
      estimated: false,
    };
  }

  const qty = Math.max(1, workOrder.quantity || 1);
  return {
    minutes: Math.max(FALLBACK_MIN_BLOCK, qty * FALLBACK_MINUTES_PER_UNIT),
    estimated: true,
  };
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
// TIME-OF-DAY HELPERS (break-aware placement)
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
// PLANNING
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

  const wo = await WorkOrder.findById(workOrderId)
    .select("workOrderNumber quantity operations stockItemId")
    .populate("stockItemId", "name genderCategory")
    .lean();

  if (!wo) throw new Error("Work order not found");

  // Unlike production, a work order with no operation timings is NOT rejected —
  // it gets a fallback block. See woDuration().
  const { minutes: durationMinutes, estimated: isEstimatedDuration } =
    woDuration(wo);

  if (!isReschedule) {
    const existing = await SalesSchedule.exists({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });
    if (existing) throw new Error("Already planned on the sales calendar");
  }

  const uniqueColor =
    colorCode || generateUniqueColor(wo.workOrderNumber, moId);

  let currentDate = startDateObj;
  let remainingMinutes = durationMinutes;
  const segments = [];
  let dayNumber = 1;
  const maxDays = 100;

  const endDate = addDays(startDateObj, maxDays);
  const schedulesInRange = await SalesSchedule.find({
    date: { $gte: startDateObj, $lte: endDate },
  }).lean();

  const scheduleMap = new Map(
    schedulesInRange.map((s) => [formatDate(s.date), s]),
  );

  const holidayMap = await getCompanyHolidayMap(startDateObj, endDate);

  // Snapshot of what is ACTUALLY in the database, captured before anything is
  // booked in memory. The bulkWrite below must decide $push vs $set from this,
  // never from the live objects — those get a provisional entry added as we go,
  // which would otherwise make every new booking look like an update and target
  // a filter that matches no document.
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

    // Capacity is what is GENUINELY free — work window minus breaks minus
    // minutes already booked, accounting for WHERE the booked work sits.
    const available = freeMinutes(schedule);

    if (available <= 0) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const minutesToSchedule = Math.min(remainingMinutes, available);

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
      isEstimatedDuration,
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

  const bulkOps = [];

  for (const seg of segments) {
    const persisted = persistedByDate.get(formatDate(seg.date));
    const alreadyInDb = persisted
      ? persisted.has(String(seg.workOrderId))
      : false;

    if (alreadyInDb) {
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
                isEstimatedDuration: seg.isEstimatedDuration,
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
      bulkOps.push({
        updateOne: {
          filter: { _id: seg.scheduleId },
          update: {
            // ONE $push key holding BOTH arrays. Two separate `$push:` keys in
            // the same object literal is a JS duplicate-key — the second wins
            // silently and scheduledWorkOrders never gets written.
            $push: {
              scheduledWorkOrders: {
                workOrderId: seg.workOrderId,
                manufacturingOrderId: seg.manufacturingOrderId,
                scheduledStartTime: seg.scheduledStartTime,
                scheduledEndTime: seg.scheduledEndTime,
                durationMinutes: seg.durationMinutes,
                isEstimatedDuration: seg.isEstimatedDuration,
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
                details: `Planned ${wo.workOrderNumber} (Day ${seg.currentDayNumber}/${totalDays})`,
              },
            },
          },
        },
      });
    }
  }

  if (bulkOps.length > 0) {
    await SalesSchedule.bulkWrite(bulkOps);
  }

  // Utilization recalculated off the request path.
  const scheduleIds = segments.map((s) => s.scheduleId);
  setImmediate(async () => {
    try {
      const schedulesToUpdate = await SalesSchedule.find({
        _id: { $in: scheduleIds },
      });
      for (const schedule of schedulesToUpdate) {
        schedule.calculateUtilization();
        await schedule.save();
      }
    } catch (err) {
      console.error("[sales-schedule] utilization recalc failed:", err.message);
    }
  });

  return {
    success: true,
    totalDays,
    segments,
    workOrderNumber: wo.workOrderNumber,
    colorCode: uniqueColor,
    isEstimatedDuration,
  };
}

// ============================================================================
// CASCADE RESCHEDULE
// ============================================================================

/**
 * Everything on or after `changedDate` is re-laid from scratch, in its existing
 * order, whenever a day's availability or capacity changes.
 *
 * A day going inactive, going active again, or its work hours shrinking from 9h
 * to 4h are all the same problem: the run of work after that point no longer
 * fits the way it was laid out, so it has to be recompacted.
 */
async function cascadeRescheduleFrom(changedDate, userId, options = {}) {
  const { dryRun = false } = options;
  const from = parseDate(changedDate);

  // 1. Every work order holding a segment on or after the changed day
  const forward = await SalesSchedule.find({
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
    return { rescheduled: 0, failed: 0, affected: 0, message: "Nothing to move" };
  }

  const ids = Array.from(affected.keys());

  // 2. A multi-day work order may START before the changed day and run past it.
  //    Take its real first date so it is put back where it began, not dragged
  //    forward to the changed date.
  const originals = await SalesSchedule.find({
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
  await SalesSchedule.updateMany(
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

// ============================================================================
// API ROUTES
// ============================================================================

// GET schedules for a date range
router.get("/", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ success: false, message: "startDate and endDate required" });
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);

    const schedules = await SalesSchedule.find({
      date: { $gte: start, $lte: end },
    })
      // Wide on purpose. The Overview tab is what non-calendar people read to
      // verify a promise, so it needs the whole picture — product, quantity,
      // deadline, customer — not just enough to draw a bar.
      .populate({
        path: "scheduledWorkOrders.workOrderId",
        select:
          "workOrderNumber status priority quantity originalQuantity assignedDeadline stockItemId stockItemName stockItemReference variantAttributes specialInstructions",
        populate: {
          path: "stockItemId",
          // variants.images is the fallback when the item itself has none.
          select:
            "name genderCategory category productType images variants.images",
        },
      })
      .populate(
        "scheduledWorkOrders.manufacturingOrderId",
        "requestId priority status customerInfo estimatedCompletion",
      )
      .sort({ date: 1 })
      .lean();

    // Fill missing dates so the calendar never has holes
    const existing = new Set(schedules.map((s) => formatDate(s.date)));
    const missingDates = [];
    let current = new Date(start);

    while (current <= end) {
      if (!existing.has(formatDate(current))) {
        missingDates.push(new Date(current));
      }
      current = addDays(current, 1);
    }

    if (missingDates.length > 0) {
      const newSchedules = await Promise.all(
        missingDates.map((date) => getScheduleForDate(date)),
      );
      schedules.push(...newSchedules);
    }

    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

    // HR's company holiday calendar as a read-time overlay, so HR remains the
    // single source of truth for holidays.
    const holidayMap = await getCompanyHolidayMap(start, end);
    if (holidayMap.size > 0) {
      for (const schedule of schedules)
        applyHolidayOverlay(schedule, holidayMap);
    }

    res.json({ success: true, schedules, count: schedules.length });
  } catch (error) {
    console.error("[sales-schedule] list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET every manufacturing order with its work orders.
 *
 * THIS IS THE DELIBERATE DIFFERENCE FROM THE PRODUCTION ROUTE. There is no
 * filter on customer request status, no filter on work order status, and no
 * requirement that the work order has operations. Sales plans the whole book,
 * including cancelled and completed orders, so the calendar can show what was
 * promised as well as what is live.
 *
 * Optional narrowing, all off by default:
 *   ?status=a,b       customer request status
 *   ?priority=urgent
 *   ?search=text      request id / customer name
 *   ?withWorkOrdersOnly=false  include orders that have no work orders at all
 */
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const skip = (page - 1) * limit;

    const match = {};

    if (req.query.status) {
      const wanted = String(req.query.status)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (wanted.length) match.status = { $in: wanted };
    }

    if (req.query.priority && req.query.priority !== "all") {
      match.priority = req.query.priority;
    }

    if (req.query.search) {
      const rx = new RegExp(
        String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i",
      );
      match.$or = [{ requestId: rx }, { "customerInfo.name": rx }];
    }

    // An order with no work orders has nothing draggable on it, so it is hidden
    // unless explicitly asked for.
    const requireWorkOrders = req.query.withWorkOrdersOnly !== "false";

    const pipeline = [
      { $match: match },
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
          status: 1,
          expectedDeliveryDate: 1,
          // NOTE: no $filter here — every work order on the request is kept.
          workOrders: 1,
        },
      },
    ];

    if (requireWorkOrders) {
      pipeline.push({ $match: { "workOrders.0": { $exists: true } } });
    }

    pipeline.push({ $sort: { createdAt: -1, _id: -1 } });
    pipeline.push({
      $facet: {
        metadata: [{ $count: "total" }],
        data: [{ $skip: skip }, { $limit: limit }],
      },
    });

    const [result] = await CustomerRequest.aggregate(pipeline);

    const mos = result?.data || [];
    const total = result?.metadata?.[0]?.total || 0;

    const allWOIds = mos.flatMap((mo) => mo.workOrders.map((w) => w._id));

    const [workOrders, scheduledWOs] = await Promise.all([
      WorkOrder.find({ _id: { $in: allWOIds } })
        .select("_id workOrderNumber quantity status stockItemId operations")
        .populate("stockItemId", "name genderCategory")
        .lean(),
      SalesSchedule.find({
        "scheduledWorkOrders.workOrderId": { $in: allWOIds },
      })
        .select("scheduledWorkOrders")
        .lean(),
    ]);

    const woMap = new Map(workOrders.map((wo) => [String(wo._id), wo]));
    const woColorMap = new Map();

    scheduledWOs.forEach((schedule) => {
      (schedule.scheduledWorkOrders || []).forEach((swo) => {
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
          const { minutes, estimated } = woDuration(wo);

          return {
            _id: wo._id,
            workOrderNumber: wo.workOrderNumber,
            quantity: wo.quantity,
            status: wo.status,
            stockItemName: wo.stockItemId?.name || "Unknown",
            genderCategory: wo.stockItemId?.genderCategory || null,
            durationMinutes: Math.ceil(minutes),
            // Lets the panel mark the time as a guess rather than a costing.
            isEstimatedDuration: estimated,
            hasOperations: (wo.operations || []).length > 0,
            isScheduled,
            colorCode: isScheduled
              ? woColorMap.get(String(wo._id))
              : moColors[mo.priority] || "#3B82F6",
          };
        })
        .filter(Boolean);

      return {
        _id: mo._id,
        moNumber: `MO-${mo.requestId}`,
        requestId: mo.requestId,
        customerInfo: mo.customerInfo,
        priority: mo.priority,
        status: mo.status,
        expectedDeliveryDate: mo.expectedDeliveryDate,
        colorCode: moColors[mo.priority] || "#3B82F6",
        workOrders: allWorkOrders,
        totalWorkOrders: allWorkOrders.length,
        scheduledWorkOrders: allWorkOrders.filter((wo) => wo.isScheduled).length,
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
    console.error("[sales-schedule] MO list error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET day settings
router.get("/day-settings/:date", async (req, res) => {
  try {
    const schedule = await getScheduleForDate(req.params.date);
    const hMap = await getCompanyHolidayMap(schedule.date, schedule.date);
    res.json({ success: true, schedule: applyHolidayOverlay(schedule, hMap) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST plan a single work order
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
      message: `Planned across ${result.totalDays} day(s)`,
      workOrderNumber: result.workOrderNumber,
      totalDays: result.totalDays,
      isEstimatedDuration: result.isEstimatedDuration,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST plan a whole manufacturing order
router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const { manufacturingOrderId, startDate } = req.body;

    const mo = await CustomerRequest.findById(manufacturingOrderId)
      .select("priority requestId")
      .lean();
    if (!mo) throw new Error("Manufacturing order not found");

    // No status filter — sales plans every work order on the order.
    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
    })
      .select("_id workOrderNumber operations quantity")
      .lean();

    const colors = {
      urgent: "#EF4444",
      high: "#F59E0B",
      medium: "#3B82F6",
      low: "#10B981",
    };
    const colorCode = colors[mo.priority] || "#3B82F6";

    const scheduledWOIds = new Set(
      (
        await SalesSchedule.find({
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
        // Stay on the LAST day this work order touched instead of jumping past
        // it — scheduleWorkOrder() advances by itself once a day is full, and
        // skipping ahead both abandons free hours and mis-handles Sundays.
        const lastSeg = result.segments[result.segments.length - 1];
        if (lastSeg) currentDate = parseDate(lastSeg.date);
      } catch (error) {
        results.failed.push({
          workOrderNumber: wo.workOrderNumber,
          reason: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Planned ${results.successful.length} work order(s)`,
      results,
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST move a work order to another day
router.post("/move-work-order", async (req, res) => {
  try {
    const { workOrderId, targetDate } = req.body;

    const schedule = await SalesSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    })
      .select("scheduledWorkOrders")
      .lean();

    if (!schedule) throw new Error("Work order is not planned");

    const woData = schedule.scheduledWorkOrders.find(
      (s) => String(s.workOrderId) === String(workOrderId),
    );

    const colorCode = woData.colorCode;
    const moId = woData.manufacturingOrderId;

    await SalesSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": workOrderId },
      { $pull: { scheduledWorkOrders: { workOrderId } } },
    );

    const result = await scheduleWorkOrder(
      workOrderId,
      moId,
      targetDate,
      colorCode,
      req.user.id,
      true,
    );

    setImmediate(async () => {
      try {
        const schedulesToUpdate = await SalesSchedule.find({
          $or: [
            { _id: schedule._id },
            { "scheduledWorkOrders.workOrderId": workOrderId },
          ],
        });
        for (const s of schedulesToUpdate) {
          s.calculateUtilization();
          await s.save();
        }
      } catch (err) {
        console.error("[sales-schedule] utilization recalc failed:", err.message);
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
router.post("/day-settings/:date/reschedule", async (req, res) => {
  try {
    const { date } = req.params;
    const { dryRun } = req.body || {};
    const result = await cascadeRescheduleFrom(date, req.user.id, {
      dryRun: Boolean(dryRun),
    });
    res.json({ success: true, result });
  } catch (error) {
    console.error("[sales-schedule] reschedule error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================================
// MULTI-DAY MOVES + WITHIN-DAY ORDERING
// ============================================================================

/**
 * Move a work order that spans several days. Every segment is lifted and the
 * whole thing is re-laid from the target date.
 */
async function moveWholeWorkOrder(workOrderId, targetDate, userId) {
  const holder = await SalesSchedule.findOne({
    "scheduledWorkOrders.workOrderId": workOrderId,
  })
    .select("scheduledWorkOrders")
    .lean();

  if (!holder) throw new Error("Work order is not planned");

  const woData = holder.scheduledWorkOrders.find(
    (s) => String(s.workOrderId) === String(workOrderId),
  );

  await SalesSchedule.updateMany(
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

    const result = await moveWholeWorkOrder(workOrderId, targetDate, req.user.id);

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays,
    });
  } catch (error) {
    console.error("[sales-schedule] move-entire-work-order:", error);
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

    const result = await moveWholeWorkOrder(workOrderId, targetDate, req.user.id);

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays,
      segmentsMoved: result.totalDays,
    });
  } catch (error) {
    console.error("[sales-schedule] move-work-order-all-segments:", error);
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
 * Set the running order of one day, first to last. Anything on the day but
 * absent from the list keeps its relative order at the end.
 *
 * Prefer `segmentIds` — a work order can hold more than one bar on a day once
 * it has been split, and workOrderIds cannot tell those two bars apart, so
 * ordering by it would collapse them onto the same rank. `workOrderIds` is
 * still accepted for callers that predate splitting.
 */
router.post("/reorder-day", async (req, res) => {
  try {
    const { date, workOrderIds, segmentIds } = req.body;

    const bySegment = Array.isArray(segmentIds) && segmentIds.length > 0;

    if (!date || (!bySegment && !Array.isArray(workOrderIds))) {
      return res.status(400).json({
        success: false,
        message: "date and segmentIds[] (or workOrderIds[]) are required",
      });
    }

    const schedule = await SalesSchedule.findOne({ date: parseDate(date) });
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const keyOf = (swo) => String(bySegment ? swo._id : swo.workOrderId);
    const rank = new Map(
      (bySegment ? segmentIds : workOrderIds).map(String).map((id, i) => [id, i]),
    );

    const sorted = [...(schedule.scheduledWorkOrders || [])].sort((a, b) => {
      const ra = rank.has(keyOf(a)) ? rank.get(keyOf(a)) : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(keyOf(b)) ? rank.get(keyOf(b)) : Number.MAX_SAFE_INTEGER;
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

    res.json({ success: true, message: "Order updated", count: sorted.length });
  } catch (error) {
    console.error("[sales-schedule] reorder-day:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT update day settings
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
      // "What would this change move?" without changing anything, so the UI can
      // put a real number in front of the user before committing.
      dryRun,
      // The cascade is OPT-IN and runs only after the settings are already
      // committed, so a slow or failing reschedule can never take the settings
      // change down with it.
      reschedule,
    } = req.body;

    const schedule = await SalesSchedule.findOne({ date: parseDate(date) });
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

    const isSunday = getDayOfWeek(date) === 0;

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
        // explicit override. Without this flag the read-time overlay would keep
        // forcing the day closed and the toggle would appear to do nothing.
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

      schedule.workHours.startTime =
        workHours.startTime || schedule.workHours.startTime;
      schedule.workHours.endTime =
        workHours.endTime || schedule.workHours.endTime;
      schedule.workHours.totalMinutes = eh * 60 + em - (sh * 60 + sm);
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
      details: "Updated settings",
    });

    await schedule.save();

    const isNowAvailable = canScheduleOnDay(schedule.toObject());
    const dayStatusChanged = wasAvailable !== isNowAvailable;
    const availableMinutesChanged =
      originalAvailableMinutes !== schedule.availableMinutes;

    // The day is SAVED at this point, whatever happens next.
    let autoRescheduleResult = null;
    if (reschedule === true && (dayStatusChanged || availableMinutesChanged)) {
      try {
        autoRescheduleResult = await cascadeRescheduleFrom(date, req.user.id);
      } catch (err) {
        console.error("[sales-schedule] cascade failed after save:", err);
        autoRescheduleResult = {
          rescheduled: 0,
          failed: 0,
          error: err.message,
          message: "Settings saved, but rescheduling failed",
        };
      }
    }

    let finalSchedule = await SalesSchedule.findById(schedule._id).lean();
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
    console.error("[sales-schedule] day-settings error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST remove MANY work orders in one call, behind a single confirmation.
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

    const affected = await SalesSchedule.find({
      "scheduledWorkOrders.workOrderId": { $in: ids },
    })
      .select("_id")
      .lean();

    const result = await SalesSchedule.updateMany(
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

    const scheduleIds = affected.map((a) => a._id);
    setImmediate(async () => {
      try {
        const schedulesToUpdate = await SalesSchedule.find({
          _id: { $in: scheduleIds },
        });
        for (const schedule of schedulesToUpdate) {
          schedule.calculateUtilization();
          await schedule.save();
        }
      } catch (err) {
        console.error("[sales-schedule] utilization recalc failed:", err.message);
      }
    });

    res.json({
      success: true,
      message: `Unassigned ${ids.length} work order(s)`,
      removed: ids.length,
      daysAffected: result.modifiedCount,
    });
  } catch (error) {
    console.error("[sales-schedule] bulk remove error:", error);
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

// DELETE one work order off the calendar entirely
router.delete("/remove-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    const affected = await SalesSchedule.find({
      "scheduledWorkOrders.workOrderId": workOrderId,
    })
      .select("_id")
      .lean();

    const result = await SalesSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": workOrderId },
      {
        $pull: { scheduledWorkOrders: { workOrderId } },
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
      return res
        .status(404)
        .json({ success: false, message: "Work order not found in schedule" });
    }

    // Recalculate from the ids captured BEFORE the pull. The production route
    // re-finds them by regex over modifications.details, which is both slow and
    // wrong once a day has accumulated several entries.
    const scheduleIds = affected.map((a) => a._id);
    setImmediate(async () => {
      try {
        const schedules = await SalesSchedule.find({
          _id: { $in: scheduleIds },
        });
        for (const schedule of schedules) {
          schedule.calculateUtilization();
          await schedule.save();
        }
      } catch (err) {
        console.error("[sales-schedule] utilization recalc failed:", err.message);
      }
    });

    res.json({
      success: true,
      message: `Work order removed from ${result.modifiedCount} day(s)`,
      schedulesAffected: result.modifiedCount,
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE one segment of one work order off one specific day.
// The day view removes a single bar rather than the whole multi-day run.
router.delete("/remove-schedule/:scheduleId/:workOrderScheduleId", async (req, res) => {
  try {
    const { scheduleId, workOrderScheduleId } = req.params;

    const schedule = await SalesSchedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const entry = schedule.scheduledWorkOrders.id(workOrderScheduleId);
    if (!entry) {
      return res
        .status(404)
        .json({ success: false, message: "Not planned on this day" });
    }

    schedule.scheduledWorkOrders.pull({ _id: workOrderScheduleId });
    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_removed",
      details: `Removed one segment of work order ${entry.workOrderId}`,
    });

    await schedule.save();

    res.json({ success: true, message: "Removed from this day" });
  } catch (error) {
    console.error("[sales-schedule] remove-schedule:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT hand-set the start/end time of one bar on one day.
// A manual override: the times are stored as given and the duration recomputed
// from them, so the day view can nudge something without re-laying the day.
router.put("/update-schedule/:scheduleId/:workOrderScheduleId", async (req, res) => {
  try {
    const { scheduleId, workOrderScheduleId } = req.params;
    const { startTime, endTime } = req.body;

    if (!startTime || !endTime) {
      return res
        .status(400)
        .json({ success: false, message: "startTime and endTime are required" });
    }

    const schedule = await SalesSchedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const entry = schedule.scheduledWorkOrders.id(workOrderScheduleId);
    if (!entry) {
      return res
        .status(404)
        .json({ success: false, message: "Not planned on this day" });
    }

    const start = new Date(startTime);
    const end = new Date(endTime);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      return res
        .status(400)
        .json({ success: false, message: "startTime or endTime is not a date" });
    }
    if (end <= start) {
      return res
        .status(400)
        .json({ success: false, message: "endTime must be after startTime" });
    }

    entry.scheduledStartTime = start;
    entry.scheduledEndTime = end;
    entry.durationMinutes = Math.round((end - start) / 60000);

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_rescheduled",
      details: `Hand-set times for work order ${entry.workOrderId}`,
    });

    await schedule.save();

    res.json({ success: true, message: "Times updated" });
  } catch (error) {
    console.error("[sales-schedule] update-schedule:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET rollup for the analytics panel
router.get("/analytics", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res
        .status(400)
        .json({ success: false, message: "startDate and endDate required" });
    }

    const schedules = await SalesSchedule.find({
      date: { $gte: parseDate(startDate), $lte: parseDate(endDate) },
    })
      .select(
        "date availableMinutes scheduledMinutes utilizationPercentage isHoliday holidayOverride workHours scheduledWorkOrders",
      )
      .sort({ date: 1 })
      .lean();

    const days = schedules.map((s) => ({
      date: s.date,
      availableMinutes: s.availableMinutes || 0,
      scheduledMinutes: s.scheduledMinutes || 0,
      utilizationPercentage: s.utilizationPercentage || 0,
      workOrderCount: (s.scheduledWorkOrders || []).length,
      isWorkingDay: canScheduleOnDay(s),
    }));

    const workingDays = days.filter((d) => d.isWorkingDay);
    const totalAvailable = workingDays.reduce(
      (n, d) => n + d.availableMinutes,
      0,
    );
    const totalScheduled = workingDays.reduce(
      (n, d) => n + d.scheduledMinutes,
      0,
    );

    const uniqueWOs = new Set();
    schedules.forEach((s) =>
      (s.scheduledWorkOrders || []).forEach((swo) =>
        uniqueWOs.add(String(swo.workOrderId)),
      ),
    );

    res.json({
      success: true,
      analytics: {
        days,
        totalDays: days.length,
        workingDays: workingDays.length,
        totalAvailableMinutes: totalAvailable,
        totalScheduledMinutes: totalScheduled,
        utilization:
          totalAvailable > 0
            ? Math.round((totalScheduled / totalAvailable) * 10000) / 100
            : 0,
        overCapacityDays: days.filter((d) => d.utilizationPercentage > 100)
          .length,
        distinctWorkOrders: uniqueWOs.size,
      },
    });
  } catch (error) {
    console.error("[sales-schedule] analytics:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ============================================================================
// MANUAL TIME EDITING, SPLITTING, AND SEGMENT-LEVEL MOVES
// ============================================================================
//
// Everything above treats a work order as one indivisible run that the engine
// lays out. That is fine until a rush job lands mid-morning and an eight-hour
// item has to become "four hours today, the rest on Thursday". These three
// endpoints are how a planner does that by hand:
//
//   /resize-segment  shorten one day's bar; the remainder spills forward
//   /move-segment    move ONE bar, leaving the work order's other bars alone
//   /reorder-day     now orders by segment, so two bars of the same work order
//                    on one day can be sequenced independently
//
// They all address a single subdocument by its `_id`, never by workOrderId —
// that is the whole point. A work order may legitimately hold several segments
// on the same day now, and the workOrderId-keyed operations elsewhere ($pull on
// remove, move-entire-work-order) still deliberately act on ALL of them.

// Work minutes inside a wall-clock window, breaks excluded. durationMinutes is
// counted this way everywhere else — placeWork() steps OVER breaks rather than
// through them — so a hand-set window has to be measured the same way or the
// day's capacity arithmetic drifts from what the bars actually show.
function workMinutesBetween(schedule, startMin, endMin) {
  if (endMin <= startMin) return 0;
  let total = endMin - startMin;
  for (const b of getBreakRanges(schedule)) {
    const overlap = Math.min(endMin, b.e) - Math.max(startMin, b.s);
    if (overlap > 0) total -= overlap;
  }
  return Math.max(0, total);
}

/**
 * Lay `minutes` of work down from `startDate`, ALWAYS as brand-new segments.
 *
 * scheduleWorkOrder() cannot be reused here: it refuses a work order that is
 * already on the calendar, and its bulkWrite overwrites an existing same-day
 * entry rather than adding beside it. Both behaviours are correct for a fresh
 * plan and both are exactly wrong for a split, where the point is to end up
 * with two independent pieces of the same work order.
 */
async function placeExtraMinutes({ startDate, minutes, entry, userId, detail }) {
  let currentDate = parseDate(startDate);
  let remaining = Math.max(0, Math.round(minutes));
  if (remaining === 0) return { segments: [], placed: 0, unplaced: 0 };

  const maxDays = 100;
  const holidayMap = await getCompanyHolidayMap(
    currentDate,
    addDays(currentDate, maxDays),
  );

  const ops = [];
  const segments = [];
  let examined = 0;

  while (remaining > 0 && examined <= maxDays) {
    examined++;

    // Read fresh per day. The resize that triggered this spill has already been
    // written, so the day it came from now genuinely has room in it.
    const schedule = await getScheduleForDate(currentDate);
    const key = formatDate(currentDate);

    const blocked =
      (holidayBlocks(holidayMap.get(key)) &&
        schedule.holidayOverride !== true) ||
      !canScheduleOnDay(schedule);

    if (!blocked) {
      const take = Math.min(remaining, freeMinutes(schedule));
      const placed = take > 0 ? placeWork(schedule, take) : null;

      if (placed) {
        const scheduledStartTime = atMinutes(currentDate, placed.startMin);
        const scheduledEndTime = atMinutes(currentDate, placed.endMin);

        ops.push({
          updateOne: {
            filter: { _id: schedule._id },
            update: {
              $push: {
                scheduledWorkOrders: {
                  workOrderId: entry.workOrderId,
                  manufacturingOrderId: entry.manufacturingOrderId,
                  scheduledStartTime,
                  scheduledEndTime,
                  durationMinutes: take,
                  isEstimatedDuration: entry.isEstimatedDuration || false,
                  colorCode: entry.colorCode,
                  position: (schedule.scheduledWorkOrders || []).length,
                  status: "scheduled",
                },
                modifications: {
                  modifiedBy: userId,
                  modifiedAt: new Date(),
                  modificationType: "work_order_rescheduled",
                  details: detail,
                },
              },
            },
          },
        });

        segments.push({
          date: new Date(currentDate),
          minutes: take,
          scheduledStartTime,
          scheduledEndTime,
        });

        remaining -= take;
      }
    }

    if (remaining > 0) currentDate = addDays(currentDate, 1);
  }

  if (ops.length) await SalesSchedule.bulkWrite(ops);

  return { segments, placed: Math.round(minutes) - remaining, unplaced: remaining };
}

/**
 * Renumber every segment of one work order in chronological order.
 *
 * Without this a split leaves both halves claiming "Day 1 of 1", which is what
 * the bar tooltips and the ‹ › continuation arrows read from.
 */
async function refreshSpanFlags(workOrderId) {
  const days = await SalesSchedule.find({
    "scheduledWorkOrders.workOrderId": workOrderId,
  })
    .select("date scheduledWorkOrders")
    .sort({ date: 1 })
    .lean();

  const rows = [];
  for (const day of days) {
    for (const swo of day.scheduledWorkOrders || []) {
      if (String(swo.workOrderId) !== String(workOrderId)) continue;
      rows.push({
        scheduleId: day._id,
        segmentId: swo._id,
        start: new Date(swo.scheduledStartTime),
      });
    }
  }

  rows.sort((a, b) => a.start - b.start);

  const total = rows.length;
  if (!total) return;

  await SalesSchedule.bulkWrite(
    rows.map((r, i) => ({
      updateOne: {
        filter: { _id: r.scheduleId, "scheduledWorkOrders._id": r.segmentId },
        update: {
          $set: {
            "scheduledWorkOrders.$.currentDayNumber": i + 1,
            "scheduledWorkOrders.$.totalDaysSpanned": total,
            "scheduledWorkOrders.$.isMultiDay": total > 1,
          },
        },
      },
    })),
  );
}

async function recalcDays(scheduleIds) {
  const docs = await SalesSchedule.find({ _id: { $in: scheduleIds } });
  for (const doc of docs) {
    doc.calculateUtilization();
    await doc.save();
  }
}

/**
 * POST /resize-segment
 * body: { scheduleId, segmentId, startTime: "HH:MM", endTime: "HH:MM",
 *         spillDate?: "YYYY-MM-DD" }
 *
 * Hand-set one bar's window. Whatever no longer fits inside it is placed
 * forward as separate segments, starting the next day by default.
 */
router.post("/resize-segment", async (req, res) => {
  try {
    const { scheduleId, segmentId, startTime, endTime, spillDate } = req.body;

    if (!scheduleId || !segmentId || !startTime || !endTime) {
      return res.status(400).json({
        success: false,
        message: "scheduleId, segmentId, startTime and endTime are required",
      });
    }

    const schedule = await SalesSchedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const segment = schedule.scheduledWorkOrders.id(segmentId);
    if (!segment) {
      return res
        .status(404)
        .json({ success: false, message: "That bar is not on this day" });
    }

    const startMin = toMins(startTime);
    const endMin = toMins(endTime);

    if (endMin <= startMin) {
      return res
        .status(400)
        .json({ success: false, message: "End time must be after start time" });
    }

    const dayStart = toMins(schedule.workHours.startTime);
    const dayEnd = toMins(schedule.workHours.endTime);
    if (startMin < dayStart || endMin > dayEnd) {
      return res.status(400).json({
        success: false,
        message: `Times must sit inside the working day (${schedule.workHours.startTime}–${schedule.workHours.endTime})`,
      });
    }

    const originalMinutes = segment.durationMinutes || 0;
    const newMinutes = workMinutesBetween(schedule, startMin, endMin);

    if (newMinutes <= 0) {
      return res.status(400).json({
        success: false,
        message: "That window is entirely break time — no work fits in it",
      });
    }

    // Growing a bar has no source to draw the extra work from, so the window is
    // capped at what this segment actually holds. Shrinking is the useful case.
    const keptMinutes = Math.min(newMinutes, originalMinutes);
    const spillMinutes = originalMinutes - keptMinutes;

    segment.scheduledStartTime = atMinutes(schedule.date, startMin);
    segment.scheduledEndTime = atMinutes(schedule.date, endMin);
    segment.durationMinutes = keptMinutes;

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_rescheduled",
      details: `Hand-set ${startTime}–${endTime}${
        spillMinutes > 0 ? `, ${spillMinutes}m moved on` : ""
      }`,
    });

    await schedule.save();

    let spill = { segments: [], placed: 0, unplaced: 0 };

    if (spillMinutes > 0) {
      spill = await placeExtraMinutes({
        startDate: spillDate || addDays(schedule.date, 1),
        minutes: spillMinutes,
        entry: {
          workOrderId: segment.workOrderId,
          manufacturingOrderId: segment.manufacturingOrderId,
          colorCode: segment.colorCode,
          isEstimatedDuration: segment.isEstimatedDuration,
        },
        userId: req.user.id,
        detail: `Split off ${spillMinutes}m from ${formatDate(schedule.date)}`,
      });
    }

    await refreshSpanFlags(segment.workOrderId);
    await recalcDays([
      schedule._id,
      ...(await SalesSchedule.find({
        "scheduledWorkOrders.workOrderId": segment.workOrderId,
      })
        .select("_id")
        .lean()).map((d) => d._id),
    ]);

    res.json({
      success: true,
      message:
        spillMinutes > 0
          ? `Kept ${keptMinutes}m here, moved ${spill.placed}m on` +
            (spill.unplaced > 0
              ? ` — ${spill.unplaced}m could not be placed`
              : "")
          : "Times updated",
      keptMinutes,
      spillMinutes,
      spillPlaced: spill.placed,
      spillUnplaced: spill.unplaced,
      spillDates: spill.segments.map((s) => formatDate(s.date)),
    });
  } catch (error) {
    console.error("[sales-schedule] resize-segment:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /move-segment
 * body: { scheduleId, segmentId, targetDate }
 *
 * Move ONE bar. The work order's other segments stay exactly where they are,
 * and landing on a day that already holds a piece of the same work order adds
 * a second bar rather than merging — that separation is what makes it possible
 * to sequence a split around a rush job.
 */
router.post("/move-segment", async (req, res) => {
  try {
    const { scheduleId, segmentId, targetDate } = req.body;

    if (!scheduleId || !segmentId || !targetDate) {
      return res.status(400).json({
        success: false,
        message: "scheduleId, segmentId and targetDate are required",
      });
    }

    const schedule = await SalesSchedule.findById(scheduleId);
    if (!schedule) {
      return res.status(404).json({ success: false, message: "Day not found" });
    }

    const segment = schedule.scheduledWorkOrders.id(segmentId);
    if (!segment) {
      return res
        .status(404)
        .json({ success: false, message: "That bar is not on this day" });
    }

    const entry = {
      workOrderId: segment.workOrderId,
      manufacturingOrderId: segment.manufacturingOrderId,
      colorCode: segment.colorCode,
      isEstimatedDuration: segment.isEstimatedDuration,
    };
    const minutes = segment.durationMinutes || 0;

    schedule.scheduledWorkOrders.pull({ _id: segmentId });
    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_rescheduled",
      details: `Moved one bar to ${formatDate(targetDate)}`,
    });
    await schedule.save();

    const spill = await placeExtraMinutes({
      startDate: targetDate,
      minutes,
      entry,
      userId: req.user.id,
      detail: `Moved from ${formatDate(schedule.date)}`,
    });

    if (spill.placed === 0) {
      // Nothing landed — put it back rather than losing the work silently.
      await placeExtraMinutes({
        startDate: schedule.date,
        minutes,
        entry,
        userId: req.user.id,
        detail: "Restored after a failed move",
      });
      await refreshSpanFlags(entry.workOrderId);
      return res.status(400).json({
        success: false,
        message: `No room on or after ${formatDate(targetDate)} — left where it was`,
      });
    }

    await refreshSpanFlags(entry.workOrderId);
    await recalcDays(
      (
        await SalesSchedule.find({
          $or: [
            { _id: schedule._id },
            { "scheduledWorkOrders.workOrderId": entry.workOrderId },
          ],
        })
          .select("_id")
          .lean()
      ).map((d) => d._id),
    );

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      unplaced: spill.unplaced,
    });
  } catch (error) {
    console.error("[sales-schedule] move-segment:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET whether a work order already sits on the sales calendar
router.get("/check-scheduled/:workOrderId", async (req, res) => {
  try {
    const exists = await SalesSchedule.exists({
      "scheduledWorkOrders.workOrderId": req.params.workOrderId,
    });
    res.json({ success: true, isScheduled: !!exists });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
