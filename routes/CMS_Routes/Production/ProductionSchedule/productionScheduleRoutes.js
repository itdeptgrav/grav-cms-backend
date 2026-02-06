// routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js - FULLY FIXED

const express = require("express");
const router = express.Router();
const ProductionSchedule = require("../../../../models/CMS_Models/Manufacturing/Production/ProductionSchedule/ProductionSchedule");
const WorkOrder = require("../../../../models/CMS_Models/Manufacturing/WorkOrder/WorkOrder");
const CustomerRequest = require("../../../../models/Customer_Models/CustomerRequest");
const EmployeeAuthMiddleware = require("../../../../Middlewear/EmployeeAuthMiddlewear");
const mongoose = require("mongoose");
const moment = require("moment");

router.use(EmployeeAuthMiddleware);

// =====================
// HELPER FUNCTIONS
// =====================

const timeToMinutes = (timeString) => {
  const [hours, minutes] = timeString.split(":").map(Number);
  return hours * 60 + minutes;
};

const createDateWithTime = (date, timeString) => {
  const [hours, minutes] = timeString.split(":").map(Number);
  const newDate = new Date(date);
  newDate.setHours(hours, minutes, 0, 0);
  return newDate;
};

const calculateWorkOrderDuration = (workOrder) => {
  if (!workOrder.operations || workOrder.operations.length === 0) {
    return 0;
  }

  const totalSeconds = workOrder.operations.reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
    0,
  );

  const minutesPerUnit = Math.ceil(totalSeconds / 60);
  const totalMinutes = minutesPerUnit * (workOrder.quantity || 1);

  return totalMinutes;
};

const getOrCreateSchedule = async (date, userId = null) => {
  const searchDate = new Date(date);
  searchDate.setHours(0, 0, 0, 0);

  let schedule = await ProductionSchedule.findOne({ date: searchDate });

  if (!schedule) {
    const dayOfWeek = searchDate.getDay();
    const isSunday = dayOfWeek === 0;

    const defaultBreaks = [
      {
        name: "Lunch Break",
        startTime: "13:00",
        endTime: "14:00",
        durationMinutes: 60,
        isFixed: true,
      },
      {
        name: "Tea Break",
        startTime: "16:00",
        endTime: "16:15",
        durationMinutes: 15,
        isFixed: true,
      },
    ];

    schedule = new ProductionSchedule({
      date: searchDate,
      workHours: {
        startTime: "09:30",
        endTime: "18:30",
        totalMinutes: 540,
        isActive: !isSunday,
        customHours: false,
      },
      defaultBreaks,
      breaks: [],
      isHoliday: isSunday,
      isSundayOverride: false,
      scheduledWorkOrders: [],
      notes: isSunday ? "Sunday - Day Off" : "Regular Work Day",
    });

    schedule.calculateAvailableMinutes();

    if (userId) {
      schedule.modifications.push({
        modifiedBy: userId,
        modifiedAt: new Date(),
        modificationType: "schedule_created",
        details: "Schedule created automatically",
      });
    }

    await schedule.save();
  }

  return schedule;
};

const getAvailableTimeSlots = (schedule) => {
  const slots = [];

  if (!schedule.workHours.isActive || schedule.isHoliday) {
    return slots;
  }

  const scheduleDate = new Date(schedule.date);
  const workStart = createDateWithTime(
    scheduleDate,
    schedule.workHours.startTime,
  );
  const workEnd = createDateWithTime(scheduleDate, schedule.workHours.endTime);

  const allBreaks = [
    ...(schedule.defaultBreaks || []),
    ...(schedule.breaks || []),
  ].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));

  const scheduledWOs = [...(schedule.scheduledWorkOrders || [])].sort(
    (a, b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime),
  );

  const blockedTimes = [];

  allBreaks.forEach((br) => {
    blockedTimes.push({
      start: createDateWithTime(scheduleDate, br.startTime),
      end: createDateWithTime(scheduleDate, br.endTime),
      type: "break",
    });
  });

  scheduledWOs.forEach((wo) => {
    blockedTimes.push({
      start: new Date(wo.scheduledStartTime),
      end: new Date(wo.scheduledEndTime),
      type: "work_order",
    });
  });

  blockedTimes.sort((a, b) => a.start - b.start);

  let currentTime = new Date(workStart);

  for (const blocked of blockedTimes) {
    if (currentTime < blocked.start) {
      const duration = Math.floor((blocked.start - currentTime) / 60000);
      if (duration > 0) {
        slots.push({
          start: new Date(currentTime),
          end: new Date(blocked.start),
          durationMinutes: duration,
        });
      }
    }
    currentTime = new Date(Math.max(currentTime, blocked.end));
  }

  if (currentTime < workEnd) {
    const duration = Math.floor((workEnd - currentTime) / 60000);
    if (duration > 0) {
      slots.push({
        start: new Date(currentTime),
        end: new Date(workEnd),
        durationMinutes: duration,
      });
    }
  }

  return slots;
};

const isDayAvailable = (schedule) => {
  if (!schedule) return false;
  if (schedule.isHoliday) return false;
  if (!schedule.workHours || !schedule.workHours.isActive) return false;

  const dayOfWeek = new Date(schedule.date).getDay();
  if (dayOfWeek === 0 && !schedule.isSundayOverride) return false;

  return true;
};

// FIXED: Schedule work order across days - NO WorkOrder updates
const scheduleWorkOrderAcrossDays = async (
  workOrder,
  mo,
  startDate,
  colorCode,
  userId,
) => {
  try {
    const durationMinutes = calculateWorkOrderDuration(workOrder);

    if (durationMinutes <= 0) {
      return { success: false, message: "Work order has no planned duration" };
    }

    const workOrderNumber =
      workOrder.workOrderNumber || `WO-${workOrder._id.toString().slice(-6)}`;

    console.log(`[SCHEDULE] Starting ${workOrderNumber}:`, {
      totalDuration: durationMinutes,
      startDate: startDate.toDateString(),
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);

    if (currentDate < today) {
      console.log(`[WARNING] Start date is in past, moving to today`);
      currentDate = new Date(today);
    }

    let remainingMinutes = durationMinutes;
    const scheduledSegments = [];
    const scheduleIds = [];
    let daysSpanned = 0;
    const maxDays = 90;

    while (remainingMinutes > 0 && daysSpanned < maxDays) {
      const schedule = await getOrCreateSchedule(currentDate, userId);

      if (!isDayAvailable(schedule)) {
        console.log(`[SKIP] ${currentDate.toDateString()} - Not available`);
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      const timeSlots = getAvailableTimeSlots(schedule);

      if (timeSlots.length === 0) {
        console.log(
          `[SKIP] ${currentDate.toDateString()} - No available slots`,
        );
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      const totalAvailable = timeSlots.reduce(
        (sum, slot) => sum + slot.durationMinutes,
        0,
      );

      if (totalAvailable <= 0) {
        console.log(`[SKIP] ${currentDate.toDateString()} - No capacity`);
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      let minutesScheduledToday = 0;

      for (const slot of timeSlots) {
        if (remainingMinutes <= 0) break;

        const minutesToSchedule = Math.min(
          remainingMinutes,
          slot.durationMinutes,
        );
        const segmentEndTime = new Date(
          slot.start.getTime() + minutesToSchedule * 60000,
        );

        const scheduledSegment = {
          workOrderId: workOrder._id,
          workOrderNumber: workOrderNumber,
          manufacturingOrderId: mo._id,
          manufacturingOrderNumber: `MO-${mo.requestId}`,
          stockItemName: workOrder.stockItemId?.name || "Unknown",
          stockItemReference: workOrder.stockItemId?.reference || "",
          quantity: workOrder.quantity,
          scheduledStartTime: slot.start,
          scheduledEndTime: segmentEndTime,
          durationMinutes: minutesToSchedule,
          colorCode: colorCode,
          position: schedule.scheduledWorkOrders.length,
          status: "scheduled",
          isMultiDay: daysSpanned > 0 || remainingMinutes > minutesToSchedule,
          dayNumber: daysSpanned + 1,
          totalDays: Math.ceil(durationMinutes / 480),
        };

        schedule.scheduledWorkOrders.push(scheduledSegment);
        scheduledSegments.push(scheduledSegment);

        remainingMinutes -= minutesToSchedule;
        minutesScheduledToday += minutesToSchedule;
      }

      schedule.calculateUtilization();

      if (schedule.isOverCapacity) {
        scheduledSegments.forEach((seg) => {
          seg.exceedsCapacity = true;
          seg.warnings = [
            {
              type: "exceeds_day",
              message: `Exceeds capacity by ${Math.round(schedule.utilizationPercentage - 100)}%`,
              timestamp: new Date(),
            },
          ];
        });
      }

      schedule.modifications.push({
        modifiedBy: userId,
        modifiedAt: new Date(),
        modificationType: "work_order_added",
        details: `Scheduled ${workOrderNumber} (Day ${daysSpanned + 1})`,
      });

      await schedule.save();
      scheduleIds.push(schedule._id);
      daysSpanned++;

      if (remainingMinutes > 0) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }

    if (remainingMinutes > 0) {
      for (const scheduleId of scheduleIds) {
        const schedule = await ProductionSchedule.findById(scheduleId);
        if (schedule) {
          schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
            (wo) => wo.workOrderId.toString() !== workOrder._id.toString(),
          );
          schedule.calculateUtilization();
          await schedule.save();
        }
      }

      return {
        success: false,
        message: `Could not find capacity. Remaining: ${remainingMinutes} minutes`,
      };
    }

    const firstSegment = scheduledSegments[0];
    const lastSegment = scheduledSegments[scheduledSegments.length - 1];

    console.log(`[SUCCESS] ${workOrderNumber} scheduled:`, {
      daysSpanned,
      start: firstSegment.scheduledStartTime.toLocaleString(),
      end: lastSegment.scheduledEndTime.toLocaleString(),
      totalDuration: durationMinutes,
    });

    // NO WORKORDER UPDATES - Just return success
    return {
      success: true,
      scheduledStartTime: firstSegment.scheduledStartTime,
      scheduledEndTime: lastSegment.scheduledEndTime,
      daysSpanned,
      scheduleIds,
      scheduledSegments,
      totalDuration: durationMinutes,
      workOrderNumber,
    };
  } catch (error) {
    console.error("[ERROR] scheduleWorkOrderAcrossDays:", error);
    return { success: false, message: error.message };
  }
};

// FIXED: Reschedule only affected segments when day changes
const rescheduleAffectedWorkOrders = async (date, userId) => {
  try {
    console.log(`[RESCHEDULE-AFFECTED] Starting from ${date}`);

    const scheduleDate = new Date(date);
    scheduleDate.setHours(0, 0, 0, 0);

    // Get the schedule that was changed to holiday
    const changedSchedule = await ProductionSchedule.findOne({
      date: scheduleDate,
    });

    if (!changedSchedule) {
      return { success: true, message: "No schedule found" };
    }

    // Get all schedules after the changed date
    const subsequentSchedules = await ProductionSchedule.find({
      date: { $gte: scheduleDate },
      "scheduledWorkOrders.0": { $exists: true },
    }).sort({ date: 1 });

    if (subsequentSchedules.length === 0) {
      return { success: true, message: "No schedules to reschedule" };
    }

    // Group work orders by their ID across multiple days
    const workOrderMap = new Map();

    for (const schedule of subsequentSchedules) {
      for (const swo of schedule.scheduledWorkOrders) {
        const woKey = swo.workOrderId.toString();

        if (!workOrderMap.has(woKey)) {
          workOrderMap.set(woKey, {
            workOrderId: swo.workOrderId,
            workOrderNumber: swo.workOrderNumber,
            manufacturingOrderId: swo.manufacturingOrderId,
            manufacturingOrderNumber: swo.manufacturingOrderNumber,
            stockItemName: swo.stockItemName,
            stockItemReference: swo.stockItemReference,
            quantity: swo.quantity,
            colorCode: swo.colorCode,
            totalDuration: 0,
            segments: [],
          });
        }

        const woData = workOrderMap.get(woKey);
        woData.totalDuration += swo.durationMinutes;
        woData.segments.push({
          scheduleDate: new Date(schedule.date),
          durationMinutes: swo.durationMinutes,
          segmentData: swo,
        });
      }
    }

    // Clear all affected schedules
    for (const schedule of subsequentSchedules) {
      schedule.scheduledWorkOrders = [];
      await schedule.save();
    }

    // Reschedule each work order starting from the changed date
    let currentRescheduleDate = new Date(scheduleDate);
    const results = { rescheduled: 0, failed: 0 };

    // Sort work orders by their original start date
    const workOrdersToReschedule = Array.from(workOrderMap.values()).sort(
      (a, b) => {
        const aStart = a.segments[0]?.scheduleDate || new Date();
        const bStart = b.segments[0]?.scheduleDate || new Date();
        return aStart - bStart;
      },
    );

    for (const wo of workOrdersToReschedule) {
      try {
        // Get the work order document
        const workOrder = await WorkOrder.findById(wo.workOrderId)
          .populate("stockItemId", "name reference")
          .lean();

        if (!workOrder) {
          results.failed++;
          continue;
        }

        // Get manufacturing order
        const mo = await CustomerRequest.findById(wo.manufacturingOrderId)
          .select("requestId customerInfo priority")
          .lean();

        if (!mo) {
          results.failed++;
          continue;
        }

        // Start rescheduling from currentRescheduleDate
        let remainingMinutes = wo.totalDuration;
        let searchDate = new Date(currentRescheduleDate);
        let searchCount = 0;
        const maxSearchDays = 90;
        let lastScheduledDate = null;

        while (remainingMinutes > 0 && searchCount < maxSearchDays) {
          const targetSchedule = await getOrCreateSchedule(searchDate, userId);

          if (isDayAvailable(targetSchedule)) {
            const timeSlots = getAvailableTimeSlots(targetSchedule);
            let scheduledToday = 0;

            // Schedule in available slots for this day
            for (const slot of timeSlots) {
              if (remainingMinutes <= 0) break;

              const minutesToSchedule = Math.min(
                remainingMinutes,
                slot.durationMinutes,
              );

              const segmentEndTime = new Date(
                slot.start.getTime() + minutesToSchedule * 60000,
              );

              const scheduledSegment = {
                workOrderId: wo.workOrderId,
                workOrderNumber: wo.workOrderNumber,
                manufacturingOrderId: wo.manufacturingOrderId,
                manufacturingOrderNumber: wo.manufacturingOrderNumber,
                stockItemName: wo.stockItemName,
                stockItemReference: wo.stockItemReference,
                quantity: wo.quantity,
                scheduledStartTime: slot.start,
                scheduledEndTime: segmentEndTime,
                durationMinutes: minutesToSchedule,
                colorCode: wo.colorCode,
                position: targetSchedule.scheduledWorkOrders.length,
                status: "scheduled",
                isMultiDay: remainingMinutes > minutesToSchedule,
              };

              targetSchedule.scheduledWorkOrders.push(scheduledSegment);
              remainingMinutes -= minutesToSchedule;
              scheduledToday += minutesToSchedule;
            }

            if (scheduledToday > 0) {
              targetSchedule.calculateUtilization();
              await targetSchedule.save();
              lastScheduledDate = new Date(searchDate);
            }
          }

          if (remainingMinutes > 0) {
            searchDate.setDate(searchDate.getDate() + 1);
            searchCount++;
          }
        }

        if (remainingMinutes <= 0) {
          results.rescheduled++;
          // Update currentRescheduleDate to after the last scheduled date
          if (lastScheduledDate) {
            currentRescheduleDate = new Date(lastScheduledDate);
            currentRescheduleDate.setDate(currentRescheduleDate.getDate() + 1);
          }
        } else {
          results.failed++;
        }
      } catch (error) {
        console.error(
          `[ERROR] Failed to reschedule ${wo.workOrderNumber}:`,
          error,
        );
        results.failed++;
      }
    }

    console.log(
      `[RESCHEDULE-AFFECTED] Complete: ${results.rescheduled} success, ${results.failed} failed`,
    );
    return { success: true, results };
  } catch (error) {
    console.error("[ERROR] rescheduleAffectedWorkOrders:", error);
    return { success: false, message: error.message };
  }
};

const rescheduleAffectedDayOnly = async (holidayDate, userId) => {
  try {
    console.log(`[RESCHEDULE-DAY-ONLY] Starting from ${holidayDate}`);

    const scheduleDate = new Date(holidayDate);
    scheduleDate.setHours(0, 0, 0, 0);

    // Get the holiday schedule
    const holidaySchedule = await ProductionSchedule.findOne({
      date: scheduleDate,
    });

    if (!holidaySchedule || !holidaySchedule.scheduledWorkOrders?.length) {
      return { success: true, message: "No work orders on this day" };
    }

    // Group work orders by their ID to handle multi-day work orders
    const workOrderMap = new Map();

    // Collect all segments of work orders from the holiday day
    holidaySchedule.scheduledWorkOrders.forEach((swo) => {
      const woKey = swo.workOrderId.toString();

      if (!workOrderMap.has(woKey)) {
        workOrderMap.set(woKey, {
          workOrderId: swo.workOrderId,
          workOrderNumber: swo.workOrderNumber,
          manufacturingOrderId: swo.manufacturingOrderId,
          manufacturingOrderNumber: swo.manufacturingOrderNumber,
          stockItemName: swo.stockItemName,
          stockItemReference: swo.stockItemReference,
          quantity: swo.quantity,
          colorCode: swo.colorCode,
          segments: [],
          totalDuration: 0,
        });
      }

      const woData = workOrderMap.get(woKey);
      woData.segments.push({
        durationMinutes: swo.durationMinutes,
        segmentData: swo,
      });
      woData.totalDuration += swo.durationMinutes;
    });

    // Clear the holiday schedule
    holidaySchedule.scheduledWorkOrders = [];
    holidaySchedule.calculateUtilization();
    await holidaySchedule.save();

    const results = { rescheduled: 0, failed: 0 };

    // For each affected work order, find the next available slot
    for (const [woKey, woData] of workOrderMap) {
      try {
        // Find the next available day after the holiday
        let searchDate = new Date(scheduleDate);
        searchDate.setDate(searchDate.getDate() + 1);
        let searchCount = 0;
        const maxSearchDays = 365; // Search for a year

        let foundSlot = false;

        while (!foundSlot && searchCount < maxSearchDays) {
          const targetSchedule = await getOrCreateSchedule(searchDate, userId);

          if (isDayAvailable(targetSchedule)) {
            // Calculate available capacity
            targetSchedule.calculateAvailableMinutes();
            const scheduledToday = targetSchedule.scheduledMinutes || 0;
            const availableMinutes =
              targetSchedule.availableMinutes - scheduledToday;

            if (availableMinutes >= woData.totalDuration) {
              // We have enough space for the entire work order on this day
              const timeSlots = getAvailableTimeSlots(targetSchedule);

              if (timeSlots.length > 0) {
                // Find a continuous slot for the entire work order
                const suitableSlot = timeSlots.find(
                  (slot) => slot.durationMinutes >= woData.totalDuration,
                );

                if (suitableSlot) {
                  // Schedule all segments back-to-back in the found slot
                  let currentStartTime = new Date(suitableSlot.start);

                  for (const segment of woData.segments) {
                    const segmentEndTime = new Date(
                      currentStartTime.getTime() +
                        segment.durationMinutes * 60000,
                    );

                    const scheduledSegment = {
                      ...segment.segmentData,
                      scheduledStartTime: currentStartTime,
                      scheduledEndTime: segmentEndTime,
                      position: targetSchedule.scheduledWorkOrders.length,
                      isMultiDay: false,
                    };

                    targetSchedule.scheduledWorkOrders.push(scheduledSegment);
                    currentStartTime = new Date(segmentEndTime);
                  }

                  targetSchedule.calculateUtilization();
                  await targetSchedule.save();

                  console.log(
                    `[SUCCESS] ${woData.workOrderNumber} rescheduled to ${searchDate.toDateString()}`,
                  );
                  foundSlot = true;
                  results.rescheduled++;
                }
              }
            }
          }

          if (!foundSlot) {
            searchDate.setDate(searchDate.getDate() + 1);
            searchCount++;
          }
        }

        if (!foundSlot) {
          console.log(
            `[FAILED] Could not reschedule ${woData.workOrderNumber} within ${maxSearchDays} days`,
          );
          results.failed++;
        }
      } catch (error) {
        console.error(`[ERROR] Failed to reschedule ${woKey}:`, error);
        results.failed++;
      }
    }

    // Now we need to check and adjust subsequent days if they have the same work orders
    // This ensures work orders aren't scheduled twice
    const nextDay = new Date(scheduleDate);
    nextDay.setDate(nextDay.getDate() + 1);

    const subsequentSchedules = await ProductionSchedule.find({
      date: { $gte: nextDay },
      "scheduledWorkOrders.0": { $exists: true },
    }).sort({ date: 1 });

    // Remove duplicate segments of rescheduled work orders
    for (const schedule of subsequentSchedules) {
      const originalLength = schedule.scheduledWorkOrders.length;

      schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
        (swo) => {
          // Check if this work order was already rescheduled
          const woKey = swo.workOrderId.toString();
          return !workOrderMap.has(woKey);
        },
      );

      if (schedule.scheduledWorkOrders.length !== originalLength) {
        schedule.calculateUtilization();
        await schedule.save();
      }
    }

    console.log(
      `[RESCHEDULE-DAY-ONLY] Complete: ${results.rescheduled} success, ${results.failed} failed`,
    );
    return { success: true, results };
  } catch (error) {
    console.error("[ERROR] rescheduleAffectedDayOnly:", error);
    return { success: false, message: error.message };
  }
};

// =====================
// GET ROUTES
// =====================

router.get("/", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        message: "startDate and endDate are required",
      });
    }

    const start = new Date(startDate);
    start.setHours(0, 0, 0, 0);

    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);

    const schedules = await ProductionSchedule.find({
      date: { $gte: start, $lte: end },
    })
      .populate({
        path: "scheduledWorkOrders.workOrderId",
        select:
          "workOrderNumber quantity status stockItemId operations timeline",
        populate: {
          path: "stockItemId",
          select: "name reference category",
        },
      })
      .populate({
        path: "scheduledWorkOrders.manufacturingOrderId",
        select: "requestId customerInfo priority status",
        populate: {
          path: "customerInfo",
          select: "name email",
        },
      })
      .sort({ date: 1 })
      .lean();

    const existingDates = new Set(
      schedules.map((s) => s.date.toISOString().split("T")[0]),
    );
    const currentDate = new Date(start);

    while (currentDate <= end) {
      const dateStr = currentDate.toISOString().split("T")[0];
      if (!existingDates.has(dateStr)) {
        try {
          const newSchedule = await getOrCreateSchedule(
            currentDate,
            req.user?.id,
          );
          schedules.push(newSchedule.toObject());
        } catch (error) {
          console.error(`Error creating schedule for ${dateStr}:`, error);
        }
      }
      currentDate.setDate(currentDate.getDate() + 1);
    }

    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

    const enrichedSchedules = schedules.map((schedule) => {
      const scheduleDate = new Date(schedule.date);
      const isToday = scheduleDate.toDateString() === new Date().toDateString();
      const isPast = scheduleDate < new Date() && !isToday;

      const scheduledMinutes =
        schedule.scheduledWorkOrders?.reduce(
          (sum, wo) => sum + (wo.durationMinutes || 0),
          0,
        ) || 0;

      const utilization =
        schedule.availableMinutes > 0
          ? Math.min(100, (scheduledMinutes / schedule.availableMinutes) * 100)
          : 0;

      return {
        ...schedule,
        isToday,
        isPast,
        isLocked: schedule.isLocked || isPast,
        utilizationPercentage: Math.round(utilization * 100) / 100,
        scheduledMinutes,
        dayType: schedule.isHoliday
          ? "holiday"
          : scheduleDate.getDay() === 0 && !schedule.isSundayOverride
            ? "sunday"
            : scheduleDate.getDay() === 0 && schedule.isSundayOverride
              ? "sunday_override"
              : "workday",
      };
    });

    res.json({
      success: true,
      schedules: enrichedSchedules,
      count: enrichedSchedules.length,
      dateRange: { start: startDate, end: endDate },
    });
  } catch (error) {
    console.error("Error fetching production schedules:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching schedules",
      error: error.message,
    });
  }
});

router.get("/manufacturing-orders", async (req, res) => {
  try {
    const manufacturingOrders = await CustomerRequest.aggregate([
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
          _id: 1,
          requestId: 1,
          customerInfo: 1,
          priority: 1,
          status: 1,
          finalOrderPrice: 1,
          createdAt: 1,
          requestType: 1,
          measurementName: 1,
          workOrders: {
            $filter: {
              input: "$workOrders",
              as: "wo",
              cond: {
                $and: [
                  {
                    $in: [
                      "$$wo.status",
                      ["planned", "scheduled", "ready_to_start", "in_progress"],
                    ],
                  },
                  { $gt: [{ $size: { $ifNull: ["$$wo.operations", []] } }, 0] },
                  {
                    $or: [
                      {
                        $eq: [
                          { $size: { $ifNull: ["$$wo.rawMaterials", []] } },
                          0,
                        ],
                      },
                      {
                        $allElementsTrue: {
                          $map: {
                            input: { $ifNull: ["$$wo.rawMaterials", []] },
                            as: "rm",
                            in: {
                              $in: [
                                "$$rm.allocationStatus",
                                ["fully_allocated", "issued"],
                              ],
                            },
                          },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $match: {
          "workOrders.0": { $exists: true },
        },
      },
    ]);

    const processedManufacturingOrders = await Promise.all(
      manufacturingOrders.map(async (mo) => {
        const workOrders = await WorkOrder.find({
          _id: { $in: mo.workOrders.map((wo) => wo._id) },
        })
          .populate("stockItemId", "name reference category")
          .lean();

        const processedWorkOrders = await Promise.all(
          workOrders.map(async (wo) => {
            const planningStatus = {
              ready: true,
              reason: null,
            };

            if (!wo.operations || wo.operations.length === 0) {
              planningStatus.ready = false;
              planningStatus.reason = "No operations defined";
            } else {
              const unplannedOps = wo.operations.filter(
                (op) =>
                  !op.assignedMachine ||
                  !op.plannedTimeSeconds ||
                  op.plannedTimeSeconds <= 0,
              );

              if (unplannedOps.length > 0) {
                planningStatus.ready = false;
                planningStatus.reason = `${unplannedOps.length} operations missing machine or time`;
              }
            }

            if (wo.rawMaterials && wo.rawMaterials.length > 0) {
              const unallocatedMaterials = wo.rawMaterials.filter(
                (rm) =>
                  rm.allocationStatus !== "fully_allocated" &&
                  rm.allocationStatus !== "issued",
              );

              if (unallocatedMaterials.length > 0) {
                planningStatus.ready = false;
                planningStatus.reason = `${unallocatedMaterials.length} materials not allocated`;
              }
            }

            const durationMinutes = wo.operations.reduce((sum, op) => {
              const opTimeSeconds =
                op.plannedTimeSeconds || op.estimatedTimeSeconds || 0;
              const totalOpTime = (opTimeSeconds * wo.quantity) / 60;
              return sum + totalOpTime;
            }, 0);

            const scheduledInfo = await ProductionSchedule.findOne(
              { "scheduledWorkOrders.workOrderId": wo._id },
              { "scheduledWorkOrders.$": 1, date: 1 },
            ).lean();

            return {
              _id: wo._id,
              workOrderNumber: wo.workOrderNumber,
              quantity: wo.quantity,
              status: wo.status,
              stockItemId: wo.stockItemId?._id,
              stockItemName: wo.stockItemId?.name || "Unknown",
              stockItemReference: wo.stockItemId?.reference || "",
              category: wo.stockItemId?.category || "Uncategorized",
              durationMinutes: Math.ceil(durationMinutes),
              planningStatus,
              isPlanned: planningStatus.ready,
              scheduledInfo: scheduledInfo
                ? {
                    scheduleId: scheduledInfo._id,
                    scheduledStartTime:
                      scheduledInfo.scheduledWorkOrders[0]?.scheduledStartTime,
                    scheduledEndTime:
                      scheduledInfo.scheduledWorkOrders[0]?.scheduledEndTime,
                    scheduleDate: scheduledInfo.date,
                  }
                : null,
              timeline: wo.timeline || {},
            };
          }),
        );

        const plannedWorkOrders = processedWorkOrders.filter(
          (wo) => wo.isPlanned,
        );

        if (plannedWorkOrders.length === 0) {
          return null;
        }

        const totalDuration = plannedWorkOrders.reduce(
          (sum, wo) => sum + wo.durationMinutes,
          0,
        );
        const scheduledCount = plannedWorkOrders.filter(
          (wo) => wo.scheduledInfo,
        ).length;

        const colorMap = {
          urgent: "#EF4444",
          high: "#F59E0B",
          medium: "#3B82F6",
          low: "#10B981",
        };

        const colorCode = colorMap[mo.priority] || "#3B82F6";

        return {
          _id: mo._id,
          moNumber: `MO-${mo.requestId}`,
          customerInfo: mo.customerInfo,
          priority: mo.priority,
          status: mo.status,
          requestType: mo.requestType,
          measurementName: mo.measurementName,
          colorCode,
          workOrders: plannedWorkOrders,
          totalWorkOrders: plannedWorkOrders.length,
          scheduledWorkOrders: scheduledCount,
          totalDuration,
          createdAt: mo.createdAt,
          canSchedule: plannedWorkOrders.some((wo) => !wo.scheduledInfo),
          schedulingProgress:
            plannedWorkOrders.length > 0
              ? Math.round((scheduledCount / plannedWorkOrders.length) * 100)
              : 0,
        };
      }),
    );

    const validManufacturingOrders = processedManufacturingOrders.filter(
      (mo) => mo !== null,
    );

    res.json({
      success: true,
      manufacturingOrders: validManufacturingOrders,
      stats: {
        total: validManufacturingOrders.length,
        totalWorkOrders: validManufacturingOrders.reduce(
          (sum, mo) => sum + mo.totalWorkOrders,
          0,
        ),
        scheduledWorkOrders: validManufacturingOrders.reduce(
          (sum, mo) => sum + mo.scheduledWorkOrders,
          0,
        ),
        canScheduleCount: validManufacturingOrders.filter(
          (mo) => mo.canSchedule,
        ).length,
      },
    });
  } catch (error) {
    console.error("Error fetching manufacturing orders:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching manufacturing orders",
      error: error.message,
    });
  }
});

router.get("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const schedule = await getOrCreateSchedule(date, req.user?.id);

    const scheduledMinutes = schedule.scheduledWorkOrders.reduce(
      (sum, wo) => sum + (wo.durationMinutes || 0),
      0,
    );

    const utilization =
      schedule.availableMinutes > 0
        ? (scheduledMinutes / schedule.availableMinutes) * 100
        : 0;

    const scheduleDate = new Date(schedule.date);
    const dayType = schedule.isHoliday
      ? "holiday"
      : scheduleDate.getDay() === 0 && !schedule.isSundayOverride
        ? "sunday"
        : "workday";

    res.json({
      success: true,
      schedule: {
        ...schedule.toObject(),
        scheduledMinutes,
        utilizationPercentage: Math.round(utilization * 100) / 100,
        dayType,
        isLocked: schedule.isLocked || scheduleDate < new Date(),
      },
    });
  } catch (error) {
    console.error("Error fetching day settings:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching day settings",
      error: error.message,
    });
  }
});

// =====================
// POST ROUTES
// =====================

router.post("/schedule-work-order", async (req, res) => {
  try {
    const { workOrderId, manufacturingOrderId, startDate, colorCode } =
      req.body;

    if (!workOrderId || !startDate) {
      return res.status(400).json({
        success: false,
        message: "workOrderId and startDate are required",
      });
    }

    const workOrder = await WorkOrder.findById(workOrderId)
      .populate("stockItemId", "name reference")
      .lean();
    if (!workOrder) {
      return res
        .status(404)
        .json({ success: false, message: "Work order not found" });
    }

    const mo = await CustomerRequest.findById(
      manufacturingOrderId || workOrder.customerRequestId,
    )
      .select("requestId customerInfo priority")
      .lean();
    if (!mo) {
      return res
        .status(404)
        .json({ success: false, message: "Manufacturing order not found" });
    }

    const existingSchedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });
    if (existingSchedule) {
      return res
        .status(400)
        .json({ success: false, message: "Work order already scheduled" });
    }

    const result = await scheduleWorkOrderAcrossDays(
      workOrder,
      mo,
      new Date(startDate),
      colorCode || "#3B82F6",
      req.user.id,
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    // NO WORKORDER UPDATES
    res.json({
      success: true,
      message: `Work order scheduled across ${result.daysSpanned} day(s)`,
      workOrderNumber: result.workOrderNumber,
      daysSpanned: result.daysSpanned,
    });
  } catch (error) {
    console.error("[ERROR] schedule-work-order:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const {
      manufacturingOrderId,
      startDate,
      rescheduleExisting = false,
    } = req.body;

    const mo = await CustomerRequest.findById(manufacturingOrderId)
      .select("requestId customerInfo priority")
      .lean();
    if (!mo) {
      return res
        .status(404)
        .json({ success: false, message: "Manufacturing order not found" });
    }

    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
      status: { $in: ["planned", "ready_to_start", "scheduled", "pending"] },
    })
      .populate("stockItemId", "name reference")
      .lean();

    if (workOrders.length === 0) {
      return res
        .status(400)
        .json({ success: false, message: "No work orders found" });
    }

    const readyWorkOrders = [];

    for (const wo of workOrders) {
      const hasPlannedTime =
        wo.operations?.some((op) => op.plannedTimeSeconds > 0) || false;
      if (!hasPlannedTime) continue;

      const isScheduled = await ProductionSchedule.findOne({
        "scheduledWorkOrders.workOrderId": wo._id,
      });

      if (isScheduled && !rescheduleExisting) continue;

      if (isScheduled && rescheduleExisting) {
        isScheduled.scheduledWorkOrders =
          isScheduled.scheduledWorkOrders.filter(
            (swo) => swo.workOrderId.toString() !== wo._id.toString(),
          );
        isScheduled.calculateUtilization();
        await isScheduled.save();
      }

      readyWorkOrders.push(wo);
    }

    if (readyWorkOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No work orders ready for scheduling",
      });
    }

    readyWorkOrders.sort(
      (a, b) => calculateWorkOrderDuration(b) - calculateWorkOrderDuration(a),
    );

    let currentDate = new Date(startDate);
    const results = { successful: [], failed: [] };

    const colorMap = {
      urgent: "#EF4444",
      high: "#F59E0B",
      medium: "#3B82F6",
      low: "#10B981",
    };

    for (const wo of readyWorkOrders) {
      const result = await scheduleWorkOrderAcrossDays(
        wo,
        mo,
        currentDate,
        colorMap[mo.priority] || "#3B82F6",
        req.user.id,
      );

      if (result.success) {
        // NO WORKORDER UPDATES
        results.successful.push({
          workOrderNumber: result.workOrderNumber,
          daysSpanned: result.daysSpanned,
          scheduledStart: result.scheduledStartTime,
          scheduledEnd: result.scheduledEndTime,
        });

        currentDate = new Date(result.scheduledEndTime);
      } else {
        results.failed.push({
          workOrderNumber:
            wo.workOrderNumber || `WO-${wo._id.toString().slice(-6)}`,
          reason: result.message,
        });
      }
    }

    // NO MO STATUS UPDATES
    res.json({
      success: true,
      message: `Scheduled ${results.successful.length} work orders`,
      moNumber: `MO-${mo.requestId}`,
      results,
    });
  } catch (error) {
    console.error("[ERROR] schedule-manufacturing-order:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

router.post("/move-work-order-all-segments", async (req, res) => {
  try {
    const { workOrderId, segmentIds, sourceDate, targetDate } = req.body;

    console.log(`[MOVE-ALL-SEGMENTS] Received:`, {
      workOrderId,
      segmentIds,
      sourceDate,
      targetDate,
    });

    if (!workOrderId || !segmentIds || !sourceDate || !targetDate) {
      return res.status(400).json({
        success: false,
        message:
          "workOrderId, segmentIds, sourceDate, and targetDate are required",
      });
    }

    const sourceScheduleDate = new Date(sourceDate);
    sourceScheduleDate.setHours(0, 0, 0, 0);

    const sourceSchedule = await ProductionSchedule.findOne({
      date: sourceScheduleDate,
    });

    if (!sourceSchedule) {
      return res.status(404).json({
        success: false,
        message: "Source schedule not found",
      });
    }

    const segments = [];
    for (const segmentId of segmentIds) {
      const segmentIndex = sourceSchedule.scheduledWorkOrders.findIndex(
        (wo) => wo._id?.toString() === segmentId,
      );

      if (segmentIndex !== -1) {
        segments.push(sourceSchedule.scheduledWorkOrders[segmentIndex]);
      }
    }

    if (segments.length === 0) {
      return res.status(404).json({
        success: false,
        message: "No segments found to move",
      });
    }

    const totalDuration = segments.reduce(
      (sum, seg) => sum + seg.durationMinutes,
      0,
    );
    const firstSegment = segments[0];

    sourceSchedule.scheduledWorkOrders =
      sourceSchedule.scheduledWorkOrders.filter(
        (wo) => !segmentIds.includes(wo._id?.toString()),
      );

    sourceSchedule.calculateUtilization();

    sourceSchedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_rescheduled",
      details: `Moved ${segments.length} segments of ${firstSegment.workOrderNumber} to ${targetDate}`,
    });

    await sourceSchedule.save();

    const targetScheduleDate = new Date(targetDate);
    targetScheduleDate.setHours(0, 0, 0, 0);

    const targetSchedule = await getOrCreateSchedule(
      targetScheduleDate,
      req.user.id,
    );

    if (!isDayAvailable(targetSchedule)) {
      sourceSchedule.scheduledWorkOrders.push(...segments);
      sourceSchedule.calculateUtilization();
      await sourceSchedule.save();

      return res.status(400).json({
        success: false,
        message: "Target date is not available for scheduling",
      });
    }

    const scheduledToday = targetSchedule.scheduledWorkOrders.reduce(
      (sum, wo) => sum + wo.durationMinutes,
      0,
    );
    const availableMinutes = targetSchedule.availableMinutes - scheduledToday;

    if (availableMinutes < totalDuration) {
      sourceSchedule.scheduledWorkOrders.push(...segments);
      sourceSchedule.calculateUtilization();
      await sourceSchedule.save();

      return res.status(400).json({
        success: false,
        message: `Not enough capacity on target date. Need ${totalDuration} minutes, only ${availableMinutes} available`,
      });
    }

    const timeSlots = getAvailableTimeSlots(targetSchedule);
    let suitableSlot = null;

    for (const slot of timeSlots) {
      if (slot.durationMinutes >= totalDuration) {
        suitableSlot = slot;
        break;
      }
    }

    if (!suitableSlot) {
      sourceSchedule.scheduledWorkOrders.push(...segments);
      sourceSchedule.calculateUtilization();
      await sourceSchedule.save();

      return res.status(400).json({
        success: false,
        message: `No continuous slot long enough (${totalDuration} minutes needed)`,
      });
    }

    let currentStartTime = new Date(suitableSlot.start);
    const movedSegments = [];

    const sortedSegments = [...segments].sort(
      (a, b) => new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime),
    );

    for (const segment of sortedSegments) {
      const newEndTime = new Date(
        currentStartTime.getTime() + segment.durationMinutes * 60000,
      );

      segment.scheduledStartTime = currentStartTime;
      segment.scheduledEndTime = newEndTime;
      segment.position = targetSchedule.scheduledWorkOrders.length;
      segment.isMultiDay = false;

      targetSchedule.scheduledWorkOrders.push(segment);
      movedSegments.push(segment);

      currentStartTime = newEndTime;
    }

    targetSchedule.calculateUtilization();

    targetSchedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_added",
      details: `Added ${segments.length} segments of ${firstSegment.workOrderNumber}`,
    });

    await targetSchedule.save();

    res.json({
      success: true,
      message: `All ${segments.length} segments moved successfully`,
      segments: movedSegments,
      sourceDate: sourceSchedule.date,
      targetDate: targetSchedule.date,
    });
  } catch (error) {
    console.error("[ERROR] move-work-order-all-segments:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

// =====================
// PUT ROUTES
// =====================

// FIXED: Day settings update with proper rescheduling
router.put("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const {
      workHours,
      breaks,
      isHoliday,
      holidayReason,
      isSundayOverride,
      notes,
    } = req.body;

    const schedule = await getOrCreateSchedule(date, req.user.id);
    const scheduleDate = new Date(date);
    scheduleDate.setHours(0, 0, 0, 0);

    const wasAvailable = isDayAvailable(schedule);

    if (workHours) {
      schedule.workHours = {
        ...schedule.workHours,
        ...workHours,
        customHours: true,
        totalMinutes:
          timeToMinutes(workHours.endTime || schedule.workHours.endTime) -
          timeToMinutes(workHours.startTime || schedule.workHours.startTime),
      };
    }

    if (breaks !== undefined) {
      schedule.breaks = breaks.map((br) => ({
        ...br,
        durationMinutes:
          timeToMinutes(br.endTime) - timeToMinutes(br.startTime),
      }));
    }

    if (isHoliday !== undefined) {
      schedule.isHoliday = isHoliday;
      schedule.workHours.isActive = !isHoliday;
      schedule.holidayReason = isHoliday ? holidayReason || "Day off" : "";
    }

    if (isSundayOverride !== undefined && scheduleDate.getDay() === 0) {
      schedule.isSundayOverride = isSundayOverride;
      schedule.isHoliday = !isSundayOverride;
      schedule.workHours.isActive = isSundayOverride;
    }

    if (notes !== undefined) {
      schedule.notes = notes;
    }

    schedule.calculateAvailableMinutes();

    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "day_settings_changed",
      details: "Day settings updated",
    });

    await schedule.save();

    const isNowAvailable = isDayAvailable(schedule);

    // FIXED: Only reschedule if day became unavailable
    let rescheduleResult = null;
    if (
      wasAvailable &&
      !isNowAvailable &&
      schedule.scheduledWorkOrders.length > 0
    ) {
      console.log(
        `[DAY-CHANGE] Day became unavailable, rescheduling affected work`,
      );
      rescheduleResult = await rescheduleAffectedWorkOrders(
        scheduleDate,
        req.user.id,
      );
    }

    res.json({
      success: true,
      message: "Day settings updated successfully",
      schedule,
      rescheduleResult,
    });
  } catch (error) {
    console.error("[ERROR] update day settings:", error);
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

// =====================
// DELETE ROUTES
// =====================

// FIXED: Remove all segments of a work order
router.delete("/remove-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    console.log(`[REMOVE] Removing all segments of work order: ${workOrderId}`);

    if (!mongoose.Types.ObjectId.isValid(workOrderId)) {
      return res.status(400).json({
        success: false,
        message: "Invalid work order ID format",
      });
    }

    const objectId = new mongoose.Types.ObjectId(workOrderId);

    // Find ALL schedules containing this work order
    const schedules = await ProductionSchedule.find({
      "scheduledWorkOrders.workOrderId": objectId,
    });

    if (!schedules || schedules.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Work order not found in any schedule",
      });
    }

    let totalSegmentsRemoved = 0;

    // Remove from ALL schedules
    for (const schedule of schedules) {
      const segmentsToRemove = schedule.scheduledWorkOrders.filter(
        (wo) => wo.workOrderId.toString() === workOrderId,
      );

      if (segmentsToRemove.length > 0) {
        const woNumber = segmentsToRemove[0].workOrderNumber;

        schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
          (wo) => wo.workOrderId.toString() !== workOrderId,
        );

        schedule.modifications.push({
          modifiedBy: req.user.id,
          modifiedAt: new Date(),
          modificationType: "work_order_removed",
          details: `Removed ${segmentsToRemove.length} segments of ${woNumber}`,
        });

        schedule.calculateUtilization();
        await schedule.save();

        totalSegmentsRemoved += segmentsToRemove.length;
      }
    }

    // NO WORKORDER STATUS UPDATES
    res.json({
      success: true,
      message: `Removed ${totalSegmentsRemoved} segments from ${schedules.length} schedule(s)`,
      removedFrom: schedules.length,
      totalSegments: totalSegmentsRemoved,
    });
  } catch (error) {
    console.error("[ERROR] remove work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  }
});

module.exports = router;
