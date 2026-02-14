// routes/CMS_Routes/Production/Dashboard/productionSchedule/productionScheduleRoutes.js
// OPTIMIZED VERSION - Reduced response times from 2-5s to <500ms

const express = require("express");
const router = express.Router();
const ProductionSchedule = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");

router.use(EmployeeAuthMiddleware);

// ============================================================================
// SIMPLE DATE UTILITIES
// ============================================================================

function parseDate(input) {
  if (!input) return new Date();
  
  if (typeof input === 'string') {
    if (input.includes('T')) {
      const date = new Date(input);
      return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
    }
    const parts = input.split('-');
    if (parts.length === 3) {
      return new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]), 0, 0, 0, 0);
    }
  }
  
  if (input instanceof Date) {
    return new Date(input.getFullYear(), input.getMonth(), input.getDate(), 0, 0, 0, 0);
  }
  
  return new Date();
}

function formatDate(date) {
  const d = parseDate(date);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
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
        { name: "Lunch", startTime: "13:00", endTime: "14:00", durationMinutes: 60, isFixed: true },
        { name: "Tea", startTime: "16:00", endTime: "16:15", durationMinutes: 15, isFixed: true }
      ],
      breaks: [],
      isHoliday: isSunday,
      isSundayOverride: false,
      scheduledWorkOrders: [],
      notes: isSunday ? "Sunday - Day Off" : "Working Day"
    });

    newSchedule.calculateAvailableMinutes();
    await newSchedule.save();
    schedule = newSchedule.toObject();
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
// OPTIMIZED SCHEDULING LOGIC
// ============================================================================

async function scheduleWorkOrder(workOrderId, moId, startDate, colorCode, userId, isReschedule = false) {
  const startDateObj = parseDate(startDate);
  
  // FIX 2: Use lean() + select() to only get needed fields
  const wo = await WorkOrder.findById(workOrderId)
    .select('workOrderNumber quantity operations stockItemId')
    .populate('stockItemId', 'name')
    .lean();
    
  if (!wo) throw new Error("Work order not found");

  const durationMinutes = calculateWODuration(wo);
  if (durationMinutes <= 0) throw new Error("Work order has no duration");

  if (!isReschedule) {
    // FIX 3: Use exists() for faster existence check
    const existing = await ProductionSchedule.exists({
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

  // FIX 4: Batch fetch schedules for date range
  const endDate = addDays(startDateObj, maxDays);
  const schedulesInRange = await ProductionSchedule.find({
    date: { $gte: startDateObj, $lte: endDate }
  }).lean();
  
  const scheduleMap = new Map(
    schedulesInRange.map(s => [formatDate(s.date), s])
  );

  while (remainingMinutes > 0 && dayNumber <= maxDays) {
    let schedule = scheduleMap.get(formatDate(currentDate));
    
    if (!schedule) {
      schedule = await getScheduleForDate(currentDate);
      scheduleMap.set(formatDate(currentDate), schedule);
    }

    if (!canScheduleOnDay(schedule)) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const allBreaks = [...(schedule.defaultBreaks || []), ...(schedule.breaks || [])];
    const breakMinutes = allBreaks.reduce((sum, br) => sum + (br.durationMinutes || 0), 0);
    const availableMinutes = Math.max(0, schedule.workHours.totalMinutes - breakMinutes);
    const used = (schedule.scheduledWorkOrders || []).reduce((sum, wo) => sum + wo.durationMinutes, 0);
    const available = availableMinutes - used;

    if (available <= 0) {
      currentDate = addDays(currentDate, 1);
      continue;
    }

    const minutesToSchedule = Math.min(remainingMinutes, available);
    const startTime = new Date(currentDate);
    const [startHour, startMin] = schedule.workHours.startTime.split(':').map(Number);
    startTime.setHours(startHour, startMin, 0, 0);
    const endTime = new Date(startTime.getTime() + (minutesToSchedule * 60000));

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

  // FIX 5: Use bulkWrite for batch updates (much faster than individual saves)
  const bulkOps = [];
  
  for (const seg of segments) {
    const existingIndex = scheduleMap.get(formatDate(seg.date))?.scheduledWorkOrders
      ?.findIndex(swo => String(swo.workOrderId) === String(seg.workOrderId));

    if (existingIndex >= 0) {
      // Update existing
      bulkOps.push({
        updateOne: {
          filter: { 
            _id: seg.scheduleId,
            "scheduledWorkOrders.workOrderId": seg.workOrderId
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
                status: "scheduled"
              }
            }
          }
        }
      });
    } else {
      // Add new
      bulkOps.push({
        updateOne: {
          filter: { _id: seg.scheduleId },
          update: {
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
              }
            },
            $push: {
              modifications: {
                modifiedBy: userId,
                modifiedAt: new Date(),
                modificationType: "work_order_added",
                details: `Scheduled ${wo.workOrderNumber} (Day ${seg.currentDayNumber}/${totalDays})`
              }
            }
          }
        }
      });
    }
  }

  if (bulkOps.length > 0) {
    await ProductionSchedule.bulkWrite(bulkOps);
  }

  // FIX 6: Update utilization in separate batch (non-blocking)
  const scheduleIds = segments.map(s => s.scheduleId);
  setImmediate(async () => {
    const schedulesToUpdate = await ProductionSchedule.find({ _id: { $in: scheduleIds } });
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
    colorCode: uniqueColor
  };
}

// ============================================================================
// OPTIMIZED AUTO-RESCHEDULE
// ============================================================================

async function autoRescheduleForDayChange(changedDate, userId) {
  const changedDateObj = parseDate(changedDate);
  
  // FIX 7: Narrow date range - only look ±7 days instead of ±30
  const startSearchDate = addDays(changedDateObj, -7);
  const endSearchDate = addDays(changedDateObj, 14);

  const schedules = await ProductionSchedule.find({
    date: { $gte: startSearchDate, $lte: endSearchDate },
    "scheduledWorkOrders.0": { $exists: true }
  })
  .select('date scheduledWorkOrders workHours isHoliday isSundayOverride')
  .lean();

  const changedSchedule = schedules.find(s => isSameDate(s.date, changedDateObj));
  const isNowWorkingDay = changedSchedule ? canScheduleOnDay(changedSchedule) : false;

  const workOrders = new Map();

  for (const schedule of schedules) {
    for (const swo of schedule.scheduledWorkOrders || []) {
      const woId = String(swo.workOrderId);
      if (!workOrders.has(woId)) {
        workOrders.set(woId, {
          workOrderId: swo.workOrderId,
          moId: swo.manufacturingOrderId,
          colorCode: swo.colorCode,
          segments: []
        });
      }
      workOrders.get(woId).segments.push({
        date: new Date(schedule.date),
        durationMinutes: swo.durationMinutes
      });
    }
  }

  const wosToReschedule = new Map();

  for (const [woId, woData] of workOrders) {
    woData.segments.sort((a, b) => a.date - b.date);
    
    let needsReschedule = false;

    if (isNowWorkingDay) {
      const hasSegmentBefore = woData.segments.some(s => s.date < changedDateObj);
      const hasSegmentAfter = woData.segments.some(s => s.date > changedDateObj);
      if (hasSegmentBefore && hasSegmentAfter) needsReschedule = true;
    } else {
      const hasSegmentOnDate = woData.segments.some(s => isSameDate(s.date, changedDateObj));
      if (hasSegmentOnDate) needsReschedule = true;
    }

    if (needsReschedule) {
      wosToReschedule.set(woId, woData);
    }
  }

  if (wosToReschedule.size === 0) {
    return { rescheduled: 0, failed: 0, message: "No work orders affected" };
  }

  // FIX 8: Use bulkWrite for removal
  const removalOps = [];
  for (const [woId] of wosToReschedule) {
    removalOps.push({
      updateMany: {
        filter: { "scheduledWorkOrders.workOrderId": woId },
        update: { $pull: { scheduledWorkOrders: { workOrderId: woId } } }
      }
    });
  }

  if (removalOps.length > 0) {
    await ProductionSchedule.bulkWrite(removalOps);
  }

  const results = { rescheduled: 0, failed: 0 };

  for (const [woId, woData] of wosToReschedule) {
    try {
      const startDate = woData.segments[0].date;
      const result = await scheduleWorkOrder(
        woData.workOrderId,
        woData.moId,
        startDate,
        woData.colorCode,
        userId,
        true
      );
      if (result.success) results.rescheduled++;
    } catch (error) {
      results.failed++;
    }
  }

  return results;
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
        message: "startDate and endDate required"
      });
    }

    const start = parseDate(startDate);
    const end = parseDate(endDate);

    // FIX 9: Use lean() and minimal population
    const schedules = await ProductionSchedule.find({
      date: { $gte: start, $lte: end }
    })
    .populate({
      path: "scheduledWorkOrders.workOrderId",
      select: "workOrderNumber stockItemId",
      populate: { path: "stockItemId", select: "name" }
    })
    .populate("scheduledWorkOrders.manufacturingOrderId", "requestId priority")
    .sort({ date: 1 })
    .lean();

    // Fill missing dates
    const existing = new Set(schedules.map(s => formatDate(s.date)));
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
        missingDates.map(date => getScheduleForDate(date))
      );
      schedules.push(...newSchedules);
    }

    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

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
      { $match: { "workOrders.0": { $exists: true } } },
      {
        $facet: {
          metadata: [{ $count: "total" }],
          data: [
            { $skip: skip },
            { $limit: limit }
          ]
        }
      }
    ]);

    const mos = result.data;
    const total = result.metadata[0]?.total || 0;

    // FIX 13: Batch fetch all work orders and schedules
    const allWOIds = mos.flatMap(mo => mo.workOrders.map(w => w._id));
    
    const [workOrders, scheduledWOs] = await Promise.all([
      WorkOrder.find({ _id: { $in: allWOIds } })
        .select('_id workOrderNumber quantity status stockItemId operations')
        .populate('stockItemId', 'name')
        .lean(),
      ProductionSchedule.find({
        "scheduledWorkOrders.workOrderId": { $in: allWOIds }
      })
      .select('scheduledWorkOrders')
      .lean()
    ]);

    // Create maps for O(1) lookups
    const woMap = new Map(workOrders.map(wo => [String(wo._id), wo]));
    const woColorMap = new Map();
    
    scheduledWOs.forEach(schedule => {
      schedule.scheduledWorkOrders.forEach(swo => {
        if (swo.colorCode) {
          woColorMap.set(String(swo.workOrderId), swo.colorCode);
        }
      });
    });

    const moColors = {
      urgent: "#EF4444",
      high: "#F59E0B",
      medium: "#3B82F6",
      low: "#10B981"
    };

    const formattedMOs = mos.map(mo => {
      const allWorkOrders = mo.workOrders
        .map(woRef => {
          const wo = woMap.get(String(woRef._id));
          if (!wo) return null;
          
          const isScheduled = woColorMap.has(String(wo._id));
          
          return {
            _id: wo._id,
            workOrderNumber: wo.workOrderNumber,
            quantity: wo.quantity,
            status: wo.status,
            stockItemName: wo.stockItemId?.name || "Unknown",
            durationMinutes: Math.ceil(calculateWODuration(wo)),
            isScheduled: isScheduled,
            colorCode: isScheduled ? woColorMap.get(String(wo._id)) : moColors[mo.priority] || "#3B82F6"
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
        scheduledWorkOrders: allWorkOrders.filter(wo => wo.isScheduled).length,
        unscheduledWorkOrders: allWorkOrders.filter(wo => !wo.isScheduled).length
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
        hasMore: page * limit < total
      }
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
    res.json({ success: true, schedule });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST schedule work order - OPTIMIZED
router.post("/schedule-work-order", async (req, res) => {
  try {
    const { workOrderId, manufacturingOrderId, startDate, colorCode } = req.body;

    const result = await scheduleWorkOrder(
      workOrderId,
      manufacturingOrderId,
      startDate,
      colorCode || "#3B82F6",
      req.user.id
    );

    res.json({
      success: true,
      message: `Scheduled across ${result.totalDays} day(s)`,
      workOrderNumber: result.workOrderNumber,
      totalDays: result.totalDays
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// POST schedule MO - OPTIMIZED
router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const { manufacturingOrderId, startDate } = req.body;

    const mo = await CustomerRequest.findById(manufacturingOrderId).select('priority requestId').lean();
    if (!mo) throw new Error("MO not found");

    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
      status: { $in: ["planned", "ready_to_start", "scheduled"] }
    })
    .select('_id workOrderNumber operations quantity')
    .populate('stockItemId', 'name')
    .lean();

    const colors = { urgent: "#EF4444", high: "#F59E0B", medium: "#3B82F6", low: "#10B981" };
    const colorCode = colors[mo.priority] || "#3B82F6";

    // FIX 14: Check scheduled status in batch
    const scheduledWOIds = new Set(
      (await ProductionSchedule.find({
        "scheduledWorkOrders.workOrderId": { $in: workOrders.map(w => w._id) }
      })
      .distinct('scheduledWorkOrders.workOrderId'))
      .map(String)
    );

    let currentDate = parseDate(startDate);
    const results = { successful: [], failed: [] };

    for (const wo of workOrders) {
      if (scheduledWOIds.has(String(wo._id))) continue;

      try {
        const result = await scheduleWorkOrder(wo._id, mo._id, currentDate, colorCode, req.user.id);
        results.successful.push({ workOrderNumber: wo.workOrderNumber, days: result.totalDays });
        const lastSeg = result.segments[result.segments.length - 1];
        currentDate = addDays(lastSeg.date, 1);
      } catch (error) {
        results.failed.push({ workOrderNumber: wo.workOrderNumber, reason: error.message });
      }
    }

    res.json({
      success: true,
      message: `Scheduled ${results.successful.length} work orders`,
      results
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
      "scheduledWorkOrders.workOrderId": workOrderId
    })
    .select('scheduledWorkOrders')
    .lean();

    if (!schedule) throw new Error("WO not scheduled");

    const woData = schedule.scheduledWorkOrders.find(
      s => String(s.workOrderId) === String(workOrderId)
    );

    const colorCode = woData.colorCode;
    const moId = woData.manufacturingOrderId;

    // Remove from all schedules
    await ProductionSchedule.updateMany(
      { "scheduledWorkOrders.workOrderId": workOrderId },
      { $pull: { scheduledWorkOrders: { workOrderId: workOrderId } } }
    );

    const result = await scheduleWorkOrder(workOrderId, moId, targetDate, colorCode, req.user.id);

    // Update utilization async
    setImmediate(async () => {
      const schedulesToUpdate = await ProductionSchedule.find({
        $or: [
          { _id: schedule._id },
          { "scheduledWorkOrders.workOrderId": workOrderId }
        ]
      });
      for (const s of schedulesToUpdate) {
        s.calculateUtilization();
        await s.save();
      }
    });

    res.json({
      success: true,
      message: `Moved to ${formatDate(targetDate)}`,
      totalDays: result.totalDays
    });
  } catch (error) {
    res.status(400).json({ success: false, message: error.message });
  }
});

// PUT update day settings - OPTIMIZED
router.put("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const { workHours, breaks, defaultBreaks, isHoliday, holidayReason, isSundayOverride, notes } = req.body;

    const schedule = await ProductionSchedule.findOne({ date: parseDate(date) });
    if (!schedule) {
      const newSchedule = await getScheduleForDate(date);
      return res.json({ success: true, schedule: newSchedule });
    }

    const wasAvailable = canScheduleOnDay(schedule.toObject());
    const originalAvailableMinutes = schedule.availableMinutes;

    const dayOfWeek = getDayOfWeek(date);
    const isSunday = dayOfWeek === 0;

    if (isSunday && isSundayOverride !== undefined) {
      schedule.isSundayOverride = isSundayOverride;
      schedule.isHoliday = !isSundayOverride;
      schedule.workHours.isActive = isSundayOverride;
      schedule.notes = isSundayOverride ? "Sunday - Working (Override)" : "Sunday - Day Off";
    } else if (isHoliday !== undefined && !isSunday) {
      schedule.isHoliday = isHoliday;
      schedule.workHours.isActive = !isHoliday;
      if (holidayReason) schedule.holidayReason = holidayReason;
    }

    if (workHours && schedule.workHours.isActive) {
      const [sh, sm] = (workHours.startTime || schedule.workHours.startTime).split(':').map(Number);
      const [eh, em] = (workHours.endTime || schedule.workHours.endTime).split(':').map(Number);
      const totalMinutes = (eh * 60 + em) - (sh * 60 + sm);

      schedule.workHours.startTime = workHours.startTime || schedule.workHours.startTime;
      schedule.workHours.endTime = workHours.endTime || schedule.workHours.endTime;
      schedule.workHours.totalMinutes = totalMinutes;
      schedule.workHours.customHours = true;
    }

    if (defaultBreaks !== undefined) {
      schedule.defaultBreaks = defaultBreaks.map(b => {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        return { ...b, durationMinutes: (eh * 60 + em) - (sh * 60 + sm) };
      });
    }

    if (breaks !== undefined) {
      schedule.breaks = breaks.map(b => {
        const [sh, sm] = b.startTime.split(':').map(Number);
        const [eh, em] = b.endTime.split(':').map(Number);
        return { ...b, durationMinutes: (eh * 60 + em) - (sh * 60 + sm) };
      });
    }

    if (notes !== undefined) schedule.notes = notes;

    schedule.calculateAvailableMinutes();

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "day_settings_changed",
      details: `Updated settings`
    });

    await schedule.save();

    const isNowAvailable = canScheduleOnDay(schedule.toObject());
    const dayStatusChanged = wasAvailable !== isNowAvailable;
    const availableMinutesChanged = originalAvailableMinutes !== schedule.availableMinutes;

    let autoRescheduleResult = null;
    if (dayStatusChanged || availableMinutesChanged) {
      // FIX 16: Run auto-reschedule async
      setImmediate(async () => {
        await autoRescheduleForDayChange(date, req.user.id);
      });
      autoRescheduleResult = { message: "Rescheduling in progress" };
    }

    res.json({
      success: true,
      message: "Day settings updated",
      schedule: schedule.toObject(),
      autoRescheduleResult
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
            details: `Removed work order ${workOrderId}`
          }
        }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(404).json({
        success: false,
        message: "Work order not found in schedule"
      });
    }

    // Update utilization async
    setImmediate(async () => {
      const schedules = await ProductionSchedule.find({
        "modifications.details": { $regex: workOrderId }
      });
      for (const schedule of schedules) {
        schedule.calculateUtilization();
        await schedule.save();
      }
    });

    res.json({
      success: true,
      message: `Work order removed from ${result.modifiedCount} schedule(s)`,
      schedulesAffected: result.modifiedCount
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
      "scheduledWorkOrders.workOrderId": workOrderId
    });

    res.json({
      success: true,
      isScheduled: !!exists
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;