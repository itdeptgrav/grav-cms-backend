// COMPLETELY NEW PRODUCTION SCHEDULE SYSTEM
// Simple, clean, and it WILL work

const express = require("express");
const router = express.Router();
const ProductionSchedule = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);


function getUserId(req) {
  return req.user?.id || 'anonymous';
}

// ============================================================================
// SIMPLE DATE UTILITIES - NO TIMEZONE NONSENSE
// ============================================================================

function parseDate(input) {
  if (!input) {
    console.error('parseDate: Input is null/undefined');
    return new Date();
  }

  if (typeof input === 'string') {
    if (input.includes('T')) {
      const date = new Date(input);
      if (isNaN(date.getTime())) {
        console.error('parseDate: Invalid ISO string:', input);
        return new Date();
      }
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    }

    const parts = input.split('-');
    if (parts.length === 3) {
      const year = parseInt(parts[0], 10);
      const month = parseInt(parts[1], 10) - 1;
      const day = parseInt(parts[2], 10);

      if (isNaN(year) || isNaN(month) || isNaN(day)) {
        console.error('parseDate: Invalid date parts:', input);
        return new Date();
      }

      return new Date(year, month, day, 0, 0, 0, 0);
    }
  }

  if (input instanceof Date) {
    if (isNaN(input.getTime())) {
      console.error('parseDate: Invalid Date object');
      return new Date();
    }
    return new Date(input.getFullYear(), input.getMonth(), input.getDate(), 0, 0, 0, 0);
  }

  console.error('parseDate: Unknown input type:', typeof input, input);
  return new Date();
}

function formatDate(date) {
  try {
    const d = parseDate(date);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
  } catch (error) {
    console.error('formatDate error:', error);
    return 'Invalid Date';
  }
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
// SCHEDULE MANAGEMENT - SIMPLE & CLEAR
// ============================================================================

async function getScheduleForDate(date) {
  const searchDate = parseDate(date);
  let schedule = await ProductionSchedule.findOne({ date: searchDate });

  if (!schedule) {
    const dayOfWeek = getDayOfWeek(searchDate);
    const isSunday = dayOfWeek === 0;

    schedule = new ProductionSchedule({
      date: searchDate,
      workHours: {
        startTime: "09:30",
        endTime: "18:30",
        totalMinutes: 540,
        isActive: !isSunday,
        customHours: false,
      },
      defaultBreaks: [
        { name: "Lunch", startTime: "13:00", endTime: "14:00", durationMinutes: 60, isFixed: true },
        { name: "Tea", startTime: "16:00", endTime: "16:15", durationMinutes: 15, isFixed: true }
      ],
      breaks: [],
      isHoliday: isSunday,
      isSundayOverride: false,
      isSaturdayOverride: false,
      scheduledWorkOrders: [],
      notes: isSunday ? "Sunday - Day Off" : "Working Day"
    });

    schedule.calculateAvailableMinutes();
    await schedule.save();
  }

  return schedule;
}

function canScheduleOnDay(schedule) {
  if (!schedule) return false;
  if (schedule.isHoliday) return false;
  if (!schedule.workHours || !schedule.workHours.isActive) return false;

  const dayOfWeek = getDayOfWeek(schedule.date);
  if (dayOfWeek === 0 && !schedule.isSundayOverride) return false;

  return true;
}

function calculateWODuration(workOrder) {
  if (!workOrder.operations || workOrder.operations.length === 0) return 0;

  const totalSeconds = workOrder.operations.reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
    0
  );

  const minutesPerUnit = Math.ceil(totalSeconds / 60);
  return minutesPerUnit * (workOrder.quantity || 1);
}

// ============================================================================
// CORE SCHEDULING LOGIC - UPDATED FOR AUTO-RESCHEDULE
// ============================================================================


function generateUniqueColor(workOrderNumber, manufacturingOrderId) {
  // Create a hash from work order number
  let hash = 0;
  const str = `${workOrderNumber}-${manufacturingOrderId}`;

  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }

  // Convert hash to HSL color
  const hue = Math.abs(hash % 360);

  // Predefined set of nice colors (avoid too light/dark)
  const niceColors = [
    `hsl(${hue}, 70%, 50%)`,       // Standard
    `hsl(${(hue + 30) % 360}, 70%, 50%)`,  // Complementary
    `hsl(${(hue + 60) % 360}, 70%, 50%)`,  // Triadic
    `hsl(${(hue + 120) % 360}, 70%, 50%)`, // More variation
    `hsl(${(hue + 180) % 360}, 70%, 50%)`, // Opposite
  ];

  return niceColors[Math.abs(hash % niceColors.length)];
}


async function scheduleWorkOrder(workOrderId, moId, startDate, colorCode, userId, isReschedule = false) {
  console.log(`\n[SCHEDULE] Starting for WO ${workOrderId}`);
  console.log(`[SCHEDULE] Start Date: ${formatDate(startDate)}`);
  console.log(`[SCHEDULE] Is Reschedule: ${isReschedule}`);

  let startDateObj;
  if (typeof startDate === 'string') {
    startDateObj = parseDate(startDate);
  } else if (startDate instanceof Date) {
    startDateObj = startDate;
  } else {
    startDateObj = new Date();
  }

  const wo = await WorkOrder.findById(workOrderId).populate("stockItemId").lean();
  if (!wo) throw new Error("Work order not found");

  const durationMinutes = calculateWODuration(wo);
  console.log(`[SCHEDULE] Duration: ${durationMinutes} minutes`);

  if (durationMinutes <= 0) throw new Error("Work order has no duration");

  if (!isReschedule) {
    const existing = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId
    });
    if (existing) throw new Error("Already scheduled");
  }

  const uniqueColor = colorCode || generateUniqueColor(wo.workOrderNumber, moId);

  let currentDate = startDateObj;
  let remainingMinutes = durationMinutes;
  const segments = [];
  let dayNumber = 1;
  const maxDays = 100;

  while (remainingMinutes > 0 && dayNumber <= maxDays) {
    console.log(`\n[SCHEDULE] Checking date: ${formatDate(currentDate)}`);

    const schedule = await getScheduleForDate(currentDate);

    if (!canScheduleOnDay(schedule)) {
      console.log(`[SCHEDULE] Day not available, skipping to next day...`);
      currentDate = addDays(currentDate, 1);
      continue;
    }

    schedule.calculateAvailableMinutes();
    const used = schedule.scheduledMinutes || 0;
    const available = schedule.availableMinutes - used;

    console.log(`[SCHEDULE] Available: ${available} min, Need: ${remainingMinutes} min`);

    if (available <= 0) {
      console.log(`[SCHEDULE] No capacity, moving to next day...`);
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const minutesToSchedule = Math.min(remainingMinutes, available);

    const startTime = new Date(currentDate);
    const [startHour, startMin] = schedule.workHours.startTime.split(':').map(Number);
    startTime.setHours(startHour, startMin, 0, 0);

    const endTime = new Date(startTime.getTime() + (minutesToSchedule * 60000));

    console.log(`[SCHEDULE] Scheduling ${minutesToSchedule} min on ${formatDate(currentDate)}`);

    segments.push({
      scheduleId: schedule._id,
      date: new Date(currentDate),
      workOrderId: wo._id,
      manufacturingOrderId: moId,
      scheduledStartTime: startTime,
      scheduledEndTime: endTime,
      durationMinutes: minutesToSchedule,
      colorCode: uniqueColor || "#3B82F6",
      currentDayNumber: dayNumber,
      totalDaysSpanned: 0,
      isMultiDay: false,
    });

    remainingMinutes -= minutesToSchedule;
    dayNumber++;

    if (remainingMinutes > 0) {
      currentDate = addDays(currentDate, 1);
    }
  }

  if (remainingMinutes > 0) {
    throw new Error(`Not enough capacity. ${remainingMinutes} minutes remaining`);
  }

  const totalDays = segments.length;
  const isMultiDay = totalDays > 1;

  for (const seg of segments) {
    seg.totalDaysSpanned = totalDays;
    seg.isMultiDay = isMultiDay;
  }

  // Save to database
  for (const seg of segments) {
    const schedule = await ProductionSchedule.findById(seg.scheduleId);

    // Check if this WO is already scheduled on this day
    const existingIndex = schedule.scheduledWorkOrders.findIndex(
      swo => String(swo.workOrderId) === String(seg.workOrderId)
    );

    if (existingIndex >= 0) {
      // Update existing
      schedule.scheduledWorkOrders[existingIndex] = {
        ...schedule.scheduledWorkOrders[existingIndex].toObject(),
        scheduledStartTime: seg.scheduledStartTime,
        scheduledEndTime: seg.scheduledEndTime,
        durationMinutes: seg.durationMinutes,
        currentDayNumber: seg.currentDayNumber,
        totalDaysSpanned: seg.totalDaysSpanned,
        isMultiDay: seg.isMultiDay,
      };
    } else {
      // Add new
      schedule.scheduledWorkOrders.push({
        workOrderId: seg.workOrderId,
        manufacturingOrderId: seg.manufacturingOrderId,
        scheduledStartTime: seg.scheduledStartTime,
        scheduledEndTime: seg.scheduledEndTime,
        durationMinutes: seg.durationMinutes,
        colorCode: uniqueColor,
        position: schedule.scheduledWorkOrders.length,
        status: "scheduled",
        isMultiDay: seg.isMultiDay,
        totalDaysSpanned: seg.totalDaysSpanned,
        currentDayNumber: seg.currentDayNumber,
      });
    }

    schedule.calculateUtilization();

    schedule.modifications.push({
      modifiedBy: userId,
      modifiedAt: new Date(),
      modificationType: "work_order_added",
      details: `Scheduled ${wo.workOrderNumber} (Day ${seg.currentDayNumber}/${totalDays})`
    });

    await schedule.save();
  }

  console.log(`[SCHEDULE] SUCCESS! Scheduled across ${totalDays} days`);

  return {
    success: true,
    totalDays: totalDays,
    segments: segments,
    workOrderNumber: wo.workOrderNumber,
    colorCode: uniqueColor
  };
}

// ============================================================================
// INTELLIGENT AUTO-RESCHEDULE SYSTEM
// ============================================================================

async function autoRescheduleForDayChange(changedDate, userId) {
  console.log(`\n[AUTO-RESCHEDULE] Day changed: ${formatDate(changedDate)}`);

  const changedDateObj = parseDate(changedDate);
  const changedSchedule = await getScheduleForDate(changedDateObj);
  const isNowWorkingDay = canScheduleOnDay(changedSchedule);

  console.log(`[AUTO-RESCHEDULE] Day is now ${isNowWorkingDay ? 'WORKING' : 'HOLIDAY'}`);

  // Get all WOs scheduled after or adjacent to changed date
  const startSearchDate = addDays(changedDateObj, -7); // Look back 7 days for context
  const endSearchDate = addDays(changedDateObj, 30); // Look ahead 30 days

  const schedules = await ProductionSchedule.find({
    date: { $gte: startSearchDate, $lte: endSearchDate },
    "scheduledWorkOrders.0": { $exists: true }
  }).sort({ date: 1 }).lean();

  // Group WOs by their ID
  const workOrders = new Map();

  for (const schedule of schedules) {
    for (const swo of schedule.scheduledWorkOrders || []) {
      const woId = String(swo.workOrderId);

      if (!workOrders.has(woId)) {
        workOrders.set(woId, {
          workOrderId: swo.workOrderId,
          moId: swo.manufacturingOrderId,
          colorCode: swo.colorCode,
          segments: [],
          firstDate: null,
          lastDate: null
        });
      }

      workOrders.get(woId).segments.push({
        scheduleId: schedule._id,
        date: new Date(schedule.date),
        scheduledStartTime: swo.scheduledStartTime,
        scheduledEndTime: swo.scheduledEndTime,
        durationMinutes: swo.durationMinutes
      });
    }
  }

  console.log(`[AUTO-RESCHEDULE] Found ${workOrders.size} work orders in range`);

  // Filter WOs that need rescheduling
  const wosToReschedule = new Map();

  for (const [woId, woData] of workOrders) {
    // Sort segments by date
    woData.segments.sort((a, b) => a.date - b.date);
    woData.firstDate = woData.segments[0].date;
    woData.lastDate = woData.segments[woData.segments.length - 1].date;

    // Check if this WO is affected by the date change
    let needsReschedule = false;

    if (isNowWorkingDay) {
      // Day became WORKING - check if WO spans across this date
      // If WO has segments before AND after this date, it should include this new working day
      const hasSegmentBefore = woData.segments.some(s => s.date < changedDateObj);
      const hasSegmentAfter = woData.segments.some(s => s.date > changedDateObj);

      if (hasSegmentBefore && hasSegmentAfter) {
        // This WO spans across the changed date - should be rescheduled to include it
        needsReschedule = true;
        console.log(`[AUTO-RESCHEDULE] WO ${woId} spans across ${formatDate(changedDateObj)} - will reschedule to include it`);
      }
    } else {
      // Day became HOLIDAY - check if WO has segment on this date
      const hasSegmentOnDate = woData.segments.some(s =>
        isSameDate(s.date, changedDateObj)
      );

      if (hasSegmentOnDate) {
        // WO is scheduled on the new holiday - needs rescheduling
        needsReschedule = true;
        console.log(`[AUTO-RESCHEDULE] WO ${woId} scheduled on ${formatDate(changedDateObj)} - will move to next available day`);
      }
    }

    if (needsReschedule) {
      wosToReschedule.set(woId, woData);
    }
  }

  console.log(`[AUTO-RESCHEDULE] ${wosToReschedule.size} work orders need rescheduling`);

  if (wosToReschedule.size === 0) {
    return { rescheduled: 0, failed: 0, message: "No work orders affected" };
  }

  // Remove affected WOs from all schedules
  for (const [woId, woData] of wosToReschedule) {
    const woSchedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": woId
    });

    for (const schedule of woSchedules) {
      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) !== woId
      );
      schedule.calculateUtilization();
      await schedule.save();
    }
  }

  // Reschedule affected WOs
  const results = { rescheduled: 0, failed: 0 };

  for (const [woId, woData] of wosToReschedule) {
    try {
      // Start from the original first date
      const startDate = woData.firstDate;

      const result = await scheduleWorkOrder(
        woData.workOrderId,
        woData.moId,
        startDate,
        woData.colorCode,
        userId,
        true // Mark as reschedule
      );

      if (result.success) {
        results.rescheduled++;
        console.log(`[AUTO-RESCHEDULE] Successfully rescheduled WO ${woId}`);
      }
    } catch (error) {
      console.error(`[AUTO-RESCHEDULE] Failed for ${woId}:`, error.message);
      results.failed++;
    }
  }

  console.log(`[AUTO-RESCHEDULE] Complete: ${results.rescheduled} rescheduled, ${results.failed} failed`);
  return results;
}

// ============================================================================
// API ROUTES
// ============================================================================

// GET schedules for date range
router.get("/", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate required"
      });
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);

    const schedules = await ProductionSchedule.find({
      date: { $gte: start, $lte: end }
    })
      .populate({
        path: "scheduledWorkOrders.workOrderId",
        select: "workOrderNumber quantity status stockItemId",
        populate: {
          path: "stockItemId",
          select: "name"
        }
      })

      .populate("scheduledWorkOrders.manufacturingOrderId", "requestId customerInfo priority")
      .sort({ date: 1 })
      .lean();

    const existing = new Set(schedules.map(s => formatDate(s.date)));
    let current = new Date(start);

    while (current <= end) {
      const dateStr = formatDate(current);
      if (!existing.has(dateStr)) {
        const newSchedule = await getScheduleForDate(current);
        schedules.push(newSchedule.toObject());
      }
      current = addDays(current, 1);
    }

    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ success: true, schedules, count: schedules.length });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// In productionScheduleRoutes.js, update the GET manufacturing orders endpoint:

// GET manufacturing orders - UPDATED to include scheduled WOs
router.get("/manufacturing-orders", async (req, res) => {
  try {
    const mos = await CustomerRequest.aggregate([
      {
        $match: {
          "quotations.0": { $exists: true },
          "quotations.salesApproval.approved": true,
          status: { $in: ["quotation_sales_approved", "production", "in_progress", "pending"] }
        }
      },
      {
        $lookup: {
          from: "workorders",
          localField: "_id",
          foreignField: "customerRequestId",
          as: "workOrders"
        }
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
                  { $in: ["$$wo.status", ["planned", "scheduled", "ready_to_start"]] },
                  { $gt: [{ $size: { $ifNull: ["$$wo.operations", []] } }, 0] }
                ]
              }
            }
          }
        }
      },
      { $match: { "workOrders.0": { $exists: true } } }
    ]);

    const result = [];

    for (const mo of mos) {
      const workOrders = await WorkOrder.find({
        _id: { $in: mo.workOrders.map(w => w._id) }
      }).populate("stockItemId").lean();

      const allWorkOrders = []; // Store ALL work orders

      // Colors for MO priorities (for unscheduled WOs)
      const moColors = {
        urgent: "#EF4444",
        high: "#F59E0B",
        medium: "#3B82F6",
        low: "#10B981"
      };

      // Get scheduled work orders to get their colors
      const scheduledWOs = await ProductionSchedule.find({
        "scheduledWorkOrders.workOrderId": { $in: workOrders.map(w => w._id) }
      });

      // Create a map of workOrderId to color
      const woColorMap = new Map();
      scheduledWOs.forEach(schedule => {
        schedule.scheduledWorkOrders.forEach(swo => {
          if (swo.colorCode) {
            woColorMap.set(String(swo.workOrderId), swo.colorCode);
          }
        });
      });

      for (const wo of workOrders) {
        const isScheduled = woColorMap.has(String(wo._id));

        allWorkOrders.push({
          _id: wo._id,
          workOrderNumber: wo.workOrderNumber,
          quantity: wo.quantity,
          status: wo.status,
          stockItemName: wo.stockItemId?.name || "Unknown",
          durationMinutes: Math.ceil(calculateWODuration(wo)),
          isScheduled: isScheduled,
          colorCode: isScheduled ? woColorMap.get(String(wo._id)) : moColors[mo.priority] || "#3B82F6"
        });
      }

      if (allWorkOrders.length > 0) {
        result.push({
          _id: mo._id,
          moNumber: `MO-${mo.requestId}`,
          customerInfo: mo.customerInfo,
          priority: mo.priority,
          colorCode: moColors[mo.priority] || "#3B82F6",
          workOrders: allWorkOrders, // Include ALL work orders
          totalWorkOrders: allWorkOrders.length,
          scheduledWorkOrders: allWorkOrders.filter(wo => wo.isScheduled).length,
          unscheduledWorkOrders: allWorkOrders.filter(wo => !wo.isScheduled).length
        });
      }
    }

    res.json({ success: true, manufacturingOrders: result });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET day settings
router.get("/day-settings/:date", async (req, res) => {
  try {
    const schedule = await getScheduleForDate(req.params.date);
    res.json({ success: true, schedule });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.post("/schedule-work-order", async (req, res) => {
  try {
    const { workOrderId, manufacturingOrderId, startDate, colorCode } = req.body;

    console.log(`\n[API] Schedule WO Request:`);
    console.log(`  WO ID: ${workOrderId}`);
    console.log(`  Start Date (raw): ${startDate}`);
    console.log(`  Start Date (parsed): ${formatDate(startDate)}`);

    const result = await scheduleWorkOrder(
      workOrderId,
      manufacturingOrderId,
      startDate,
      colorCode || "#3B82F6",
      req.user.id
    );

    // Get WebSocket instance
    const io = req.app.get("io");
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");

    // Broadcast update
    await broadcastProductionScheduleUpdate("WORK_ORDER_SCHEDULED", {
      workOrderId: workOrderId,
      manufacturingOrderId: manufacturingOrderId,
      startDate: startDate,
      result: result
    });

    // Also notify specific manufacturing order room
    io.to(`manufacturing-order-${manufacturingOrderId}`).emit("manufacturing-order:updated", {
      type: "WORK_ORDER_SCHEDULED",
      workOrderId: workOrderId,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      message: `Scheduled across ${result.totalDays} day(s)`,
      workOrderNumber: result.workOrderNumber,
      totalDays: result.totalDays
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const { manufacturingOrderId, startDate } = req.body;
    const userId = req.user?.id || "system";

    console.log(`\n[API] Schedule MO Request: ${manufacturingOrderId}`);
    console.log(`  Start Date: ${formatDate(startDate)}`);

    const mo = await CustomerRequest.findById(manufacturingOrderId).lean();
    if (!mo) throw new Error("MO not found");

    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
      status: { $in: ["planned", "ready_to_start", "scheduled"] }
    }).populate("stockItemId").lean();

    const colors = { urgent: "#EF4444", high: "#F59E0B", medium: "#3B82F6", low: "#10B981" };
    const colorCode = colors[mo.priority] || "#3B82F6";

    let currentDate = parseDate(startDate);
    const results = { successful: [], failed: [] };

    const io = req.app.get("io");
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");

    for (const wo of workOrders) {
      const isScheduled = await ProductionSchedule.findOne({
        "scheduledWorkOrders.workOrderId": wo._id
      });

      if (isScheduled) continue;

      try {
        const result = await scheduleWorkOrder(wo._id, mo._id, currentDate, colorCode, userId);
        results.successful.push({ workOrderNumber: wo.workOrderNumber, days: result.totalDays });

        // Broadcast individual work order scheduled
        if (io) {
          io.to("production-schedule").emit("production-schedule:update", {
            type: "WORK_ORDER_SCHEDULED",
            data: {
              workOrderId: wo._id,
              manufacturingOrderId: mo._id,
              startDate: currentDate,
              result: result,
              timestamp: new Date().toISOString()
            }
          });
        }

        const lastSeg = result.segments[result.segments.length - 1];
        currentDate = addDays(lastSeg.date, 1);
      } catch (error) {
        results.failed.push({ workOrderNumber: wo.workOrderNumber, reason: error.message });
      }
    }

    // Broadcast manufacturing order completion
    if (io) {
      io.to("production-schedule").emit("production-schedule:update", {
        type: "MANUFACTURING_ORDER_SCHEDULED",
        data: {
          manufacturingOrderId: manufacturingOrderId,
          startDate: startDate,
          results: results,
          timestamp: new Date().toISOString()
        }
      });

      // Also broadcast to specific manufacturing order room
      io.to(`manufacturing-order-${manufacturingOrderId}`).emit("manufacturing-order:updated", {
        type: "MANUFACTURING_ORDER_SCHEDULED",
        data: {
          manufacturingOrderId: manufacturingOrderId,
          successfulCount: results.successful.length,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.json({
      success: true,
      message: `Scheduled ${results.successful.length} work orders`,
      results
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});

router.post("/move-work-order", async (req, res) => {
  try {
    const { workOrderId, sourceDate, targetDate } = req.body;

    console.log(`\n[MOVE] Moving WO ${workOrderId}`);
    console.log(`[MOVE] From: ${sourceDate}`);
    console.log(`[MOVE] To: ${targetDate}`);

    const source = parseDate(sourceDate);
    const target = parseDate(targetDate);

    if (isNaN(source.getTime()) || isNaN(target.getTime())) {
      throw new Error(`Invalid dates. Source: ${sourceDate}, Target: ${targetDate}`);
    }

    const schedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    if (schedules.length === 0) throw new Error("WO not scheduled");

    let colorCode = "#3B82F6";
    let moId = null;

    for (const schedule of schedules) {
      const segments = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) === String(workOrderId)
      );

      if (segments.length > 0) {
        colorCode = segments[0].colorCode;
        moId = segments[0].manufacturingOrderId;
      }

      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) !== String(workOrderId)
      );
      schedule.calculateUtilization();
      await schedule.save();
    }

    const result = await scheduleWorkOrder(workOrderId, moId, target, colorCode, req.user.id);

    // Broadcast update via WebSocket
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");
    await broadcastProductionScheduleUpdate("WORK_ORDER_MOVED", {
      workOrderId: workOrderId,
      fromDate: sourceDate,
      toDate: targetDate,
      result: result
    });

    res.json({
      success: true,
      message: `Moved to ${formatDate(target)}`,
      totalDays: result.totalDays
    });
  } catch (error) {
    console.error("Error moving work order:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});


router.post("/move-work-order-all-segments", async (req, res) => {
  try {
    const { workOrderId, segmentIds, sourceDate, targetDate } = req.body;

    console.log(`\n[MOVE ALL] Moving WO ${workOrderId}`);
    console.log(`[MOVE ALL] Segments: ${segmentIds.length}`);
    console.log(`[MOVE ALL] From: ${sourceDate} To: ${targetDate}`);

    const source = parseDate(sourceDate);
    const target = parseDate(targetDate);

    if (isNaN(source.getTime()) || isNaN(target.getTime())) {
      throw new Error(`Invalid dates. Source: ${sourceDate}, Target: ${targetDate}`);
    }

    const schedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    if (schedules.length === 0) throw new Error("WO not scheduled");

    let colorCode = "#3B82F6";
    let moId = null;

    for (const schedule of schedules) {
      const segments = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) === String(workOrderId)
      );

      if (segments.length > 0) {
        colorCode = segments[0].colorCode;
        moId = segments[0].manufacturingOrderId;
      }

      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) !== String(workOrderId)
      );
      schedule.calculateUtilization();
      await schedule.save();
    }

    const result = await scheduleWorkOrder(workOrderId, moId, target, colorCode, req.user.id, true);

    // Broadcast update via WebSocket
    const io = req.app.get("io");
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");

    if (io) {
      io.to("production-schedule").emit("production-schedule:update", {
        type: "WORK_ORDER_MOVED_ALL_SEGMENTS",
        data: {
          workOrderId: workOrderId,
          fromDate: sourceDate,
          toDate: targetDate,
          segmentCount: segmentIds.length,
          result: result,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.json({
      success: true,
      message: `Moved ${segmentIds.length} segments to ${formatDate(target)}`,
      totalDays: result.totalDays
    });
  } catch (error) {
    console.error("Error moving work order segments:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});


router.post("/move-entire-work-order", async (req, res) => {
  try {
    const { workOrderId, sourceDate, targetDate } = req.body;

    console.log(`\n[MOVE ENTIRE] Moving entire WO ${workOrderId}`);
    console.log(`[MOVE ENTIRE] From: ${sourceDate} To: ${targetDate}`);

    const source = parseDate(sourceDate);
    const target = parseDate(targetDate);

    if (isNaN(source.getTime()) || isNaN(target.getTime())) {
      throw new Error(`Invalid dates. Source: ${sourceDate}, Target: ${targetDate}`);
    }

    const schedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    if (schedules.length === 0) throw new Error("WO not scheduled");

    let colorCode = "#3B82F6";
    let moId = null;

    for (const schedule of schedules) {
      const segments = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) === String(workOrderId)
      );

      if (segments.length > 0) {
        colorCode = segments[0].colorCode;
        moId = segments[0].manufacturingOrderId;
      }

      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) !== String(workOrderId)
      );
      schedule.calculateUtilization();
      await schedule.save();
    }

    const result = await scheduleWorkOrder(workOrderId, moId, target, colorCode, req.user.id, true);

    // Broadcast update via WebSocket
    const io = req.app.get("io");
    if (io) {
      io.to("production-schedule").emit("production-schedule:update", {
        type: "WORK_ORDER_MOVED_ENTIRE",
        data: {
          workOrderId: workOrderId,
          fromDate: sourceDate,
          toDate: targetDate,
          result: result,
          timestamp: new Date().toISOString()
        }
      });
    }

    res.json({
      success: true,
      message: `Moved entire work order to ${formatDate(target)}`,
      totalDays: result.totalDays
    });
  } catch (error) {
    console.error("Error moving entire work order:", error);
    res.status(400).json({ success: false, message: error.message });
  }
});


router.put("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const { workHours, breaks, defaultBreaks, isHoliday, holidayReason, isSundayOverride, notes } = req.body;

    console.log(`\n[DAY-SETTINGS] Update request for ${formatDate(date)}`);

    const schedule = await getScheduleForDate(date);
    const wasAvailable = canScheduleOnDay(schedule);
    const dayOfWeek = getDayOfWeek(date);
    const isSunday = dayOfWeek === 0;

    // Store original state
    const originalIsHoliday = schedule.isHoliday;
    const originalWorkHoursActive = schedule.workHours.isActive;
    const originalStartTime = schedule.workHours.startTime;
    const originalEndTime = schedule.workHours.endTime;
    const originalAvailableMinutes = schedule.availableMinutes;

    // Handle Sunday override
    if (isSunday && isSundayOverride !== undefined) {
      schedule.isSundayOverride = isSundayOverride;
      if (isSundayOverride) {
        schedule.isHoliday = false;
        schedule.workHours.isActive = true;
        schedule.notes = "Sunday - Working (Override)";
      } else {
        schedule.isHoliday = true;
        schedule.workHours.isActive = false;
        schedule.notes = "Sunday - Day Off";
      }
    } else if (isHoliday !== undefined && !isSunday) {
      schedule.isHoliday = isHoliday;
      schedule.workHours.isActive = !isHoliday;
      if (holidayReason) schedule.holidayReason = holidayReason;
    }

    // Update work hours if provided
    if (workHours && schedule.workHours.isActive) {
      const [sh, sm] = (workHours.startTime || schedule.workHours.startTime).split(':').map(Number);
      const [eh, em] = (workHours.endTime || schedule.workHours.endTime).split(':').map(Number);
      const totalMinutes = (eh * 60 + em) - (sh * 60 + sm);

      schedule.workHours.startTime = workHours.startTime || schedule.workHours.startTime;
      schedule.workHours.endTime = workHours.endTime || schedule.workHours.endTime;
      schedule.workHours.totalMinutes = totalMinutes;
      schedule.workHours.customHours = true;
    }

    // Update default breaks if provided
    if (defaultBreaks !== undefined) {
      schedule.defaultBreaks = defaultBreaks.map(b => {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        return {
          ...b,
          durationMinutes: (eh * 60 + em) - (sh * 60 + sm)
        };
      });
    }

    // Update additional breaks if provided
    if (breaks !== undefined) {
      schedule.breaks = breaks.map(b => {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        return {
          ...b,
          durationMinutes: (eh * 60 + em) - (sh * 60 + sm)
        };
      });
    }

    if (notes !== undefined) schedule.notes = notes;

    // Calculate available minutes based on breaks
    schedule.calculateAvailableMinutes();

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "day_settings_changed",
      details: `Updated settings: ${schedule.workHours.startTime} - ${schedule.workHours.endTime}, ${schedule.breaks?.length || 0} additional breaks`
    });

    await schedule.save();

    const isNowAvailable = canScheduleOnDay(schedule);

    // Check if day status changed
    const dayStatusChanged = (originalIsHoliday !== schedule.isHoliday) ||
      (originalWorkHoursActive !== schedule.workHours.isActive);
    
    const availableMinutesChanged = originalAvailableMinutes !== schedule.availableMinutes;
    const workHoursChanged = (originalStartTime !== schedule.workHours.startTime) || 
                            (originalEndTime !== schedule.workHours.endTime);

    // AUTO-RESCHEDULE if any significant change detected
    let autoRescheduleResult = null;
    if (dayStatusChanged || availableMinutesChanged || workHoursChanged) {
      console.log(`[DAY-SETTINGS] Triggering intelligent auto-reschedule...`);
      autoRescheduleResult = await autoRescheduleForDayChange(date, req.user.id);
    }

    // Broadcast update via WebSocket
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");
    await broadcastProductionScheduleUpdate("DAY_SETTINGS_UPDATED", {
      date: date,
      schedule: schedule,
      autoRescheduleResult: autoRescheduleResult,
      changesDetected: {
        dayStatusChanged,
        availableMinutesChanged,
        workHoursChanged
      }
    });

    res.json({
      success: true,
      message: "Day settings updated",
      schedule,
      autoRescheduleResult,
      changesDetected: {
        dayStatusChanged,
        availableMinutesChanged,
        workHoursChanged
      }
    });
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

router.delete("/remove-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    console.log(`\n[REMOVE] Removing WO ${workOrderId} from schedule`);

    // Find all schedules containing this work order
    const schedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    if (schedules.length === 0) {
      console.log(`[REMOVE] Work order ${workOrderId} not found in any schedule`);
      return res.status(404).json({
        success: false,
        message: "Work order not found in schedule"
      });
    }

    console.log(`[REMOVE] Found in ${schedules.length} schedule(s)`);

    // Remove from all schedules
    for (const schedule of schedules) {
      const beforeCount = schedule.scheduledWorkOrders.length;

      // Filter out the work order
      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        s => String(s.workOrderId) !== String(workOrderId)
      );

      const afterCount = schedule.scheduledWorkOrders.length;
      const removedCount = beforeCount - afterCount;

      console.log(`[REMOVE] Schedule ${formatDate(schedule.date)}: Removed ${removedCount} segment(s)`);

      // Recalculate utilization
      schedule.calculateUtilization();

      // Add modification log
      schedule.modifications.push({
        modifiedBy: req.user.id,
        modifiedAt: new Date(),
        modificationType: "work_order_removed",
        details: `Removed work order ${workOrderId} from schedule`
      });

      await schedule.save();
    }

    console.log(`[REMOVE] Successfully removed from all schedules`);

    // Broadcast update via WebSocket
    const broadcastProductionScheduleUpdate = req.app.get("broadcastProductionScheduleUpdate");
    await broadcastProductionScheduleUpdate("WORK_ORDER_REMOVED", {
      workOrderId: workOrderId,
      schedulesAffected: schedules.length
    });

    res.json({
      success: true,
      message: `Work order removed from ${schedules.length} schedule(s)`,
      schedulesAffected: schedules.length
    });
  } catch (error) {
    console.error("Error removing work order:", error);
    res.status(500).json({
      success: false,
      message: error.message || "Error removing work order"
    });
  }
});


// In your production-schedule routes, add this endpoint:
router.get("/check-scheduled/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    const schedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    res.json({
      success: true,
      isScheduled: !!schedule,
      foundIn: schedule ? formatDate(schedule.date) : null
    });
  } catch (error) {
    console.error("Error checking schedule status:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});


router.post("/websocket/reconnect", (req, res) => {
  const io = req.app.get("io");
  
  if (!io) {
    return res.status(500).json({
      success: false,
      message: "WebSocket server not available"
    });
  }

  // Force disconnect all clients (they will reconnect)
  io.sockets.sockets.forEach(socket => {
    socket.disconnect(true);
  });

  res.json({
    success: true,
    message: "WebSocket reconnection initiated",
    disconnectedClients: io.sockets.sockets.size
  });
});

module.exports = router;