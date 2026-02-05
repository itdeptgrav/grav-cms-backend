// routes/CMS_Routes/Production/ProductionSchedule/productionScheduleRoutes.js - ENHANCED

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
// ENHANCED HELPER FUNCTIONS
// =====================

/**
 * Parse time string to minutes since midnight
 */
const timeToMinutes = (timeString) => {
  const [hours, minutes] = timeString.split(":").map(Number);
  return hours * 60 + minutes;
};

/**
 * Convert minutes to time string
 */
const minutesToTime = (minutes) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
};

/**
 * Create date with specific time
 */
const createDateWithTime = (date, timeString) => {
  const [hours, minutes] = timeString.split(":").map(Number);
  const newDate = new Date(date);
  newDate.setHours(hours, minutes, 0, 0);
  return newDate;
};

/**
 * Check if work order is fully planned and can be scheduled
 */
const isWorkOrderReadyForScheduling = (workOrder) => {
  // Get work order number for logging
  const workOrderNumber =
    workOrder.workOrderNumber ||
    `ID:${workOrder._id?.toString().slice(-6) || "unknown"}`;

  // Only block if in_progress, completed, or cancelled
  const nonSchedulableStatuses = [
    "in_progress",
    "completed",
    "cancelled",
    "delayed",
  ];

  if (nonSchedulableStatuses.includes(workOrder.status)) {
    return {
      ready: false,
      reason: `Cannot schedule work order with status: ${workOrder.status}`,
    };
  }

  // Allow scheduled work orders to be rescheduled
  if (workOrder.status === "scheduled") {
    console.log(
      `Allowing rescheduling of ${workOrderNumber} (currently scheduled)`,
    );
  }

  // Check operations
  if (!workOrder.operations || workOrder.operations.length === 0) {
    return {
      ready: false,
      reason: "No operations defined",
    };
  }

  // Check if operations have planned time
  const operationsWithoutTime = workOrder.operations.filter(
    (op) => !op.plannedTimeSeconds || op.plannedTimeSeconds <= 0,
  );

  if (operationsWithoutTime.length > 0) {
    return {
      ready: false,
      reason: `${operationsWithoutTime.length} operations missing planned time`,
      operationsWithoutTime: operationsWithoutTime.map((op, idx) => ({
        operationNumber: idx + 1,
        operationType: op.operationType,
      })),
    };
  }

  // Check raw materials (warning but allow)
  const unallocatedMaterials = [];
  if (workOrder.rawMaterials && workOrder.rawMaterials.length > 0) {
    workOrder.rawMaterials.forEach((rm) => {
      if (
        rm.allocationStatus &&
        rm.allocationStatus !== "fully_allocated" &&
        rm.allocationStatus !== "issued"
      ) {
        unallocatedMaterials.push({
          name: rm.name,
          status: rm.allocationStatus,
        });
      }
    });
  }

  // Calculate total planned time
  const totalPlannedSeconds = workOrder.operations.reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || 0),
    0,
  );

  if (totalPlannedSeconds <= 0) {
    return {
      ready: false,
      reason: "No planned time in operations",
    };
  }

  return {
    ready: true,
    reason:
      workOrder.status === "scheduled"
        ? "Ready for rescheduling"
        : "Ready for scheduling",
    totalPlannedSeconds,
    operationsCount: workOrder.operations.length,
    warnings:
      unallocatedMaterials.length > 0
        ? [`${unallocatedMaterials.length} materials not fully allocated`]
        : [],
    unallocatedMaterials:
      unallocatedMaterials.length > 0 ? unallocatedMaterials : undefined,
  };
};

/**
 * Calculate total duration for work order in minutes - FIXED
 */
const calculateWorkOrderDuration = (workOrder) => {
  // FIXED: Calculate from operations (including quantity)
  if (!workOrder.operations || workOrder.operations.length === 0) {
    return 0;
  }

  // Sum planned time from all operations
  const totalPlannedSeconds = workOrder.operations.reduce(
    (sum, op) => sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
    0,
  );

  // Convert to minutes
  const minutesPerUnit = Math.ceil(totalPlannedSeconds / 60);

  // Multiply by quantity for total duration
  const totalMinutes = minutesPerUnit * (workOrder.quantity || 1);

  console.log(`Duration calculation for ${workOrder.workOrderNumber}:`, {
    totalPlannedSeconds,
    quantity: workOrder.quantity,
    minutesPerUnit,
    totalMinutes,
    operations: workOrder.operations.map((op) => ({
      type: op.operationType,
      plannedSeconds: op.plannedTimeSeconds,
    })),
  });

  return totalMinutes;
};

/**
 * Get or create schedule for a specific date with enhanced settings
 */
const getOrCreateSchedule = async (date, userId = null) => {
  const searchDate = new Date(date);
  searchDate.setHours(0, 0, 0, 0);

  let schedule = await ProductionSchedule.findOne({ date: searchDate });

  if (!schedule) {
    // Create new schedule with default settings
    const dayOfWeek = searchDate.getDay();
    const isSunday = dayOfWeek === 0;
    const isSaturday = dayOfWeek === 6;

    // Default work hours
    const startTime = "09:30";
    const endTime = "18:30";
    const totalMinutes = timeToMinutes(endTime) - timeToMinutes(startTime);

    // Default breaks
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
        startTime: startTime,
        endTime: endTime,
        totalMinutes: totalMinutes,
        isActive: !isSunday,
        customHours: false,
      },
      defaultBreaks: defaultBreaks,
      breaks: [],
      isHoliday: isSunday,
      isSundayOverride: false,
      isSaturdayOverride: false,
      scheduledWorkOrders: [],
      notes: isSunday
        ? "Sunday - Day Off"
        : isSaturday
          ? "Saturday - Weekend"
          : "Regular Work Day",
    });

    // Calculate available minutes
    schedule.calculateAvailableMinutes();

    // Add creation record
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

/**
 * Calculate available time slots for a day considering breaks
 */
const calculateAvailableTimeSlots = (schedule, startDate = null) => {
  const slots = [];

  if (!schedule.workHours.isActive || schedule.isHoliday) {
    return slots;
  }

  const scheduleDate = new Date(schedule.date);
  const workStartTime = createDateWithTime(
    scheduleDate,
    schedule.workHours.startTime,
  );
  const workEndTime = createDateWithTime(
    scheduleDate,
    schedule.workHours.endTime,
  );

  // Get all breaks sorted by start time
  const allBreaks = [
    ...(schedule.defaultBreaks || []),
    ...(schedule.breaks || []),
  ];
  allBreaks.sort(
    (a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime),
  );

  // Start from provided start time or work start time
  let currentTime = startDate
    ? new Date(Math.max(startDate, workStartTime))
    : workStartTime;

  for (const br of allBreaks) {
    const breakStart = createDateWithTime(scheduleDate, br.startTime);
    const breakEnd = createDateWithTime(scheduleDate, br.endTime);

    // If current time is before break start, add slot
    if (currentTime < breakStart) {
      const slotDuration = (breakStart - currentTime) / 60000; // in minutes
      if (slotDuration > 0) {
        slots.push({
          start: new Date(currentTime),
          end: new Date(breakStart),
          durationMinutes: slotDuration,
          type: "work",
        });
      }
      currentTime = breakEnd;
    }
    // If current time is during break, skip to break end
    else if (currentTime >= breakStart && currentTime < breakEnd) {
      currentTime = breakEnd;
    }
  }

  // Add remaining time after last break
  if (currentTime < workEndTime) {
    const slotDuration = (workEndTime - currentTime) / 60000;
    if (slotDuration > 0) {
      slots.push({
        start: new Date(currentTime),
        end: new Date(workEndTime),
        durationMinutes: slotDuration,
        type: "work",
      });
    }
  }

  return slots;
};

/**
 * Find best slot for work order considering existing schedules
 */
const findBestSlotForWorkOrder = async (
  workOrder,
  mo,
  targetDate,
  colorCode,
  userId,
) => {
  try {
    const durationMinutes = calculateWorkOrderDuration(workOrder);

    if (durationMinutes <= 0) {
      return {
        success: false,
        message: "Work order has no planned duration",
      };
    }

    let currentDate = new Date(targetDate);
    currentDate.setHours(0, 0, 0, 0);

    const scheduledSlots = [];
    let remainingMinutes = durationMinutes;
    let daysSpanned = 0;
    const maxSearchDays = 90; // 3 months max search

    while (remainingMinutes > 0 && daysSpanned < maxSearchDays) {
      // Get schedule for current date
      const schedule = await getOrCreateSchedule(currentDate, userId);

      // Skip if day is not available
      if (schedule.isHoliday || !schedule.workHours.isActive) {
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Calculate available time slots for this day
      const availableSlots = calculateAvailableTimeSlots(schedule);

      // Deduct already scheduled time
      const scheduledMinutes = schedule.scheduledWorkOrders.reduce(
        (sum, wo) => sum + wo.durationMinutes,
        0,
      );

      const availableMinutes = schedule.availableMinutes - scheduledMinutes;

      if (availableMinutes <= 0) {
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Determine start time for this day
      let startTimeForDay;
      if (daysSpanned === 0) {
        // First day - start at the earliest available slot
        if (availableSlots.length > 0) {
          startTimeForDay = availableSlots[0].start;
        } else {
          startTimeForDay = createDateWithTime(
            currentDate,
            schedule.workHours.startTime,
          );
        }
      } else {
        // Continuation day - start at work hours
        startTimeForDay = createDateWithTime(
          currentDate,
          schedule.workHours.startTime,
        );
      }

      // Find available time after start time
      const timeSlots = calculateAvailableTimeSlots(schedule, startTimeForDay);

      // Try to fit work order into available slots
      for (const slot of timeSlots) {
        if (remainingMinutes <= 0) break;

        const minutesInSlot = Math.min(remainingMinutes, slot.durationMinutes);
        if (minutesInSlot <= 0) continue;

        const endTime = new Date(slot.start.getTime() + minutesInSlot * 60000);

        scheduledSlots.push({
          date: currentDate,
          start: slot.start,
          end: endTime,
          durationMinutes: minutesInSlot,
          scheduleId: schedule._id,
        });

        remainingMinutes -= minutesInSlot;
        daysSpanned++;

        // If we still have remaining minutes, continue to next day
        if (remainingMinutes > 0) {
          currentDate.setDate(currentDate.getDate() + 1);
          break;
        }
      }

      // Move to next day if we haven't found slot today
      if (remainingMinutes > 0) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }

    if (remainingMinutes > 0) {
      return {
        success: false,
        message: `Could not find enough time in the next ${maxSearchDays} days`,
      };
    }

    return {
      success: true,
      scheduledSlots,
      totalDuration: durationMinutes,
      daysSpanned,
    };
  } catch (error) {
    console.error("Error finding slot:", error);
    return {
      success: false,
      message: error.message,
    };
  }
};

const generateWorkOrderNumber = (workOrder) => {
  if (workOrder.workOrderNumber) {
    return workOrder.workOrderNumber;
  }

  // Generate a work order number based on ID and timestamp
  const timestamp = workOrder.createdAt || new Date();
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const idShort = workOrder._id.toString().slice(-6);

  return `WO-${year}${month}${day}-${idShort}`;
};

// =====================
// GET ROUTES
// =====================

/**
 * GET /api/cms/manufacturing/production-schedule
 * Get schedules for a date range with enhanced data
 */
router.get("/", async (req, res) => {
  try {
    const { startDate, endDate, includeDetails = "false" } = req.query;

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

    // Find all schedules in range
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

    // Create schedules for dates that don't exist
    const existingDates = new Set(
      schedules.map((s) => s.date.toISOString().split("T")[0]),
    );
    const currentDate = new Date(start);
    const schedulesToCreate = [];

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

    // Sort by date and enrich with additional info
    schedules.sort((a, b) => new Date(a.date) - new Date(b.date));

    const enrichedSchedules = schedules.map((schedule) => {
      const scheduleDate = new Date(schedule.date);
      const isToday = scheduleDate.toDateString() === new Date().toDateString();
      const isPast = scheduleDate < new Date() && !isToday;

      // Calculate utilization
      const scheduledMinutes =
        schedule.scheduledWorkOrders?.reduce(
          (sum, wo) => sum + (wo.durationMinutes || 0),
          0,
        ) || 0;

      const utilization =
        schedule.availableMinutes > 0
          ? Math.min(100, (scheduledMinutes / schedule.availableMinutes) * 100)
          : 0;

      // Group work orders by manufacturing order for frontend
      const workOrdersByMO = {};
      schedule.scheduledWorkOrders?.forEach((wo) => {
        const moId =
          wo.manufacturingOrderId?._id?.toString() ||
          wo.manufacturingOrderId?.toString();
        if (!workOrdersByMO[moId]) {
          workOrdersByMO[moId] = {
            manufacturingOrder: wo.manufacturingOrderId,
            workOrders: [],
            totalDuration: 0,
          };
        }
        workOrdersByMO[moId].workOrders.push(wo);
        workOrdersByMO[moId].totalDuration += wo.durationMinutes || 0;
      });

      return {
        ...schedule,
        isToday,
        isPast,
        isLocked: schedule.isLocked || isPast,
        utilizationPercentage: Math.round(utilization * 100) / 100,
        scheduledMinutes,
        workOrdersByMO: Object.values(workOrdersByMO),
        dayType: schedule.isHoliday
          ? "holiday"
          : scheduleDate.getDay() === 0 && !schedule.isSundayOverride
            ? "sunday"
            : scheduleDate.getDay() === 0 && schedule.isSundayOverride
              ? "sunday_override"
              : scheduleDate.getDay() === 6 && !schedule.isSaturdayOverride
                ? "saturday"
                : scheduleDate.getDay() === 6 && schedule.isSaturdayOverride
                  ? "saturday_override"
                  : "workday",
      };
    });

    res.json({
      success: true,
      schedules: enrichedSchedules,
      count: enrichedSchedules.length,
      dateRange: {
        start: startDate,
        end: endDate,
      },
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

/**
 * GET /api/cms/manufacturing/production-schedule/day-settings/:date
 * Get or create day settings with enhanced info
 */
router.get("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const schedule = await getOrCreateSchedule(date, req.user?.id);

    // Calculate current utilization
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
        : scheduleDate.getDay() === 0 && schedule.isSundayOverride
          ? "sunday_override"
          : scheduleDate.getDay() === 6 && !schedule.isSaturdayOverride
            ? "saturday"
            : scheduleDate.getDay() === 6 && schedule.isSaturdayOverride
              ? "saturday_override"
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

/**
 * GET /api/cms/manufacturing/production-schedule/manufacturing-orders
 * Get all manufacturing orders with enhanced scheduling info
 */
router.get("/manufacturing-orders", async (req, res) => {
  try {
    // FIXED: Get CustomerRequests that are sales approved (not just specific statuses)
    const manufacturingOrders = await CustomerRequest.aggregate([
      {
        $match: {
          // FIXED: Only require sales approval and have quotations
          "quotations.0": { $exists: true },
          "quotations.salesApproval.approved": true,
          status: {
            $in: [
              "quotation_sales_approved",
              "production",
              "in_progress",
              "pending", // ADDED: Include pending that have approved quotations
              "in_progress", // ADDED
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
          // FIXED: Filter work orders that are ready for scheduling
          workOrders: {
            $filter: {
              input: "$workOrders",
              as: "wo",
              cond: {
                $and: [
                  // FIXED: Include planned, scheduled, and ready_to_start
                  {
                    $in: [
                      "$$wo.status",
                      ["planned", "scheduled", "ready_to_start", "in_progress"],
                    ],
                  },
                  // FIXED: Ensure operations exist and have machines assigned
                  { $gt: [{ $size: { $ifNull: ["$$wo.operations", []] } }, 0] },
                  // FIXED: Ensure raw materials are allocated
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
        // FIXED: Only include MOs that have eligible work orders
        $match: {
          "workOrders.0": { $exists: true },
        },
      },
    ]);

    // Process manufacturing orders
    const processedManufacturingOrders = await Promise.all(
      manufacturingOrders.map(async (mo) => {
        // Get work orders with full details
        const workOrders = await WorkOrder.find({
          _id: { $in: mo.workOrders.map((wo) => wo._id) },
        })
          .populate("stockItemId", "name reference category")
          .lean();

        // FIXED: Better planning status check
        const processedWorkOrders = await Promise.all(
          workOrders.map(async (wo) => {
            // FIXED: Proper planning status calculation
            const planningStatus = {
              ready: true,
              reason: null,
            };

            // Check operations
            if (!wo.operations || wo.operations.length === 0) {
              planningStatus.ready = false;
              planningStatus.reason = "No operations defined";
            } else {
              // Check if all operations have machines and planned time
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

            // Check raw materials
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

            // FIXED: Calculate total duration properly (multiply by quantity)
            const durationMinutes = wo.operations.reduce((sum, op) => {
              const opTimeSeconds =
                op.plannedTimeSeconds || op.estimatedTimeSeconds || 0;
              // MULTIPLY by quantity for total time
              const totalOpTime = (opTimeSeconds * wo.quantity) / 60; // Convert to minutes
              return sum + totalOpTime;
            }, 0);

            // Get scheduled info if exists
            const scheduledInfo = await ProductionSchedule.findOne(
              {
                "scheduledWorkOrders.workOrderId": wo._id,
              },
              {
                "scheduledWorkOrders.$": 1,
                date: 1,
              },
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
              durationMinutes: Math.ceil(durationMinutes), // FIXED: Total time for all units
              planningStatus,
              isPlanned: planningStatus.ready,
              operations: wo.operations?.map((op, idx) => ({
                operationNumber: idx + 1,
                operationType: op.operationType,
                machineType: op.machineType,
                plannedTimeSeconds: op.plannedTimeSeconds,
                estimatedTimeSeconds: op.estimatedTimeSeconds,
                assignedMachine: op.assignedMachine,
                assignedMachineName: op.assignedMachineName,
                status: op.status,
              })),
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

        // FIXED: Only include work orders that are actually ready
        const plannedWorkOrders = processedWorkOrders.filter(
          (wo) => wo.isPlanned,
        );

        if (plannedWorkOrders.length === 0) {
          return null;
        }

        // Calculate totals
        const totalDuration = plannedWorkOrders.reduce(
          (sum, wo) => sum + wo.durationMinutes,
          0,
        );
        const scheduledCount = plannedWorkOrders.filter(
          (wo) => wo.scheduledInfo,
        ).length;

        // FIXED: Color code based on priority
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

    // Filter out null entries
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

/**
 * GET /api/cms/manufacturing/production-schedule/work-order/:workOrderId
 * Get work order details for scheduling
 */
router.get("/work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    const workOrder = await WorkOrder.findById(workOrderId)
      .populate("stockItemId", "name reference category numberOfPanels")
      .populate("customerRequestId", "requestId customerInfo priority")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check planning status
    const planningStatus = isWorkOrderReadyForScheduling(workOrder);
    const durationMinutes = calculateWorkOrderDuration(workOrder);

    // Check if already scheduled
    const existingSchedule = await ProductionSchedule.findOne(
      {
        "scheduledWorkOrders.workOrderId": workOrderId,
      },
      {
        "scheduledWorkOrders.$": 1,
        date: 1,
      },
    ).lean();

    res.json({
      success: true,
      workOrder: {
        ...workOrder,
        durationMinutes,
        planningStatus,
        isReadyForScheduling: planningStatus.ready,
        scheduledInfo: existingSchedule
          ? {
              scheduleId: existingSchedule._id,
              scheduleDate: existingSchedule.date,
              scheduledStartTime:
                existingSchedule.scheduledWorkOrders[0]?.scheduledStartTime,
              scheduledEndTime:
                existingSchedule.scheduledWorkOrders[0]?.scheduledEndTime,
              durationMinutes:
                existingSchedule.scheduledWorkOrders[0]?.durationMinutes,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("Error fetching work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching work order",
      error: error.message,
    });
  }
});

// =====================
// POST/PUT ROUTES - SCHEDULING
// =====================

/**
 * POST /api/cms/manufacturing/production-schedule/schedule-work-order
 * Schedule a single work order with advanced logic
 */
router.post("/schedule-work-order", async (req, res) => {
  try {
    const {
      workOrderId,
      manufacturingOrderId,
      startDate,
      colorCode,
      allowRescheduling = true,
    } = req.body;

    if (!workOrderId || !startDate) {
      return res.status(400).json({
        success: false,
        message: "workOrderId and startDate are required",
      });
    }

    // Get work order
    const workOrder = await WorkOrder.findById(workOrderId)
      .populate("stockItemId", "name reference")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check if work order is ready for scheduling
    const planningStatus = isWorkOrderReadyForScheduling(workOrder);

    if (!planningStatus.ready) {
      return res.status(400).json({
        success: false,
        message: "Work order is not ready for scheduling",
        details: planningStatus,
      });
    }

    // Get MO details if not provided
    let mo;
    if (manufacturingOrderId) {
      mo = await CustomerRequest.findById(manufacturingOrderId)
        .select("requestId customerInfo")
        .lean();
    } else {
      mo = await CustomerRequest.findById(workOrder.customerRequestId)
        .select("requestId customerInfo")
        .lean();
    }

    if (!mo) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    // Check if already scheduled
    const existingSchedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });

    if (existingSchedule && !allowRescheduling) {
      return res.status(400).json({
        success: false,
        message: "Work order is already scheduled",
        existingSchedule: {
          scheduleId: existingSchedule._id,
          date: existingSchedule.date,
          scheduledStartTime: existingSchedule.scheduledWorkOrders.find(
            (wo) => wo.workOrderId.toString() === workOrderId,
          )?.scheduledStartTime,
        },
      });
    }

    // Remove from existing schedule if rescheduling
    if (existingSchedule && allowRescheduling) {
      existingSchedule.scheduledWorkOrders =
        existingSchedule.scheduledWorkOrders.filter(
          (wo) => wo.workOrderId.toString() !== workOrderId,
        );
      existingSchedule.calculateUtilization();
      await existingSchedule.save();
    }

    // Find best slot for work order
    const slotResult = await findBestSlotForWorkOrder(
      workOrder,
      mo,
      new Date(startDate),
      colorCode || "#3B82F6",
      req.user.id,
    );

    if (!slotResult.success) {
      return res.status(400).json({
        success: false,
        message: slotResult.message,
        details: slotResult,
      });
    }

    // Schedule work order in each slot
    const scheduledEntries = [];

    for (const slot of slotResult.scheduledSlots) {
      const schedule = await ProductionSchedule.findById(slot.scheduleId);

      if (!schedule) {
        console.error(`Schedule not found: ${slot.scheduleId}`);
        continue;
      }

      // Create scheduled work order entry
      const scheduledWO = {
        workOrderId: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        manufacturingOrderId: mo._id,
        manufacturingOrderNumber: `MO-${mo.requestId}`,
        stockItemName: workOrder.stockItemId?.name || "Unknown",
        stockItemReference: workOrder.stockItemId?.reference || "",
        quantity: workOrder.quantity,
        scheduledStartTime: slot.start,
        scheduledEndTime: slot.end,
        durationMinutes: slot.durationMinutes,
        colorCode: colorCode || "#3B82F6",
        position: schedule.scheduledWorkOrders.length,
        status: "scheduled",
        isMultiDay: slotResult.scheduledSlots.length > 1,
        originalScheduleId: slotResult.scheduledSlots[0].scheduleId,
        continuationScheduleIds: slotResult.scheduledSlots
          .slice(1)
          .map((s) => s.scheduleId),
      };

      // Add to schedule
      schedule.scheduledWorkOrders.push(scheduledWO);
      schedule.calculateUtilization();

      // Add modification record
      schedule.modifications.push({
        modifiedBy: req.user.id,
        modifiedAt: new Date(),
        modificationType: "work_order_added",
        details: `Scheduled ${workOrder.workOrderNumber} from ${slot.start.toLocaleTimeString()} to ${slot.end.toLocaleTimeString()}`,
      });

      await schedule.save();
      scheduledEntries.push({
        scheduleId: schedule._id,
        date: schedule.date,
        startTime: slot.start,
        endTime: slot.end,
      });
    }

    // Update work order timeline and status
    const firstSlot = slotResult.scheduledSlots[0];
    const lastSlot =
      slotResult.scheduledSlots[slotResult.scheduledSlots.length - 1];

    await WorkOrder.findByIdAndUpdate(workOrderId, {
      $set: {
        "timeline.scheduledStartDate": firstSlot.start,
        "timeline.scheduledEndDate": lastSlot.end,
        "timeline.totalPlannedSeconds": slotResult.totalDuration * 60, // Store in seconds
        status: "scheduled",
      },
      $push: {
        productionNotes: {
          note: `Scheduled for production from ${firstSlot.start.toLocaleDateString()} ${firstSlot.start.toLocaleTimeString()} to ${lastSlot.end.toLocaleDateString()} ${lastSlot.end.toLocaleTimeString()}`,
          addedBy: req.user.id,
          addedByModel: "ProjectManager",
          addedAt: new Date(),
        },
      },
    });

    res.json({
      success: true,
      message: `Work order scheduled successfully`,
      workOrderNumber: workOrder.workOrderNumber,
      totalDuration: slotResult.totalDuration,
      daysSpanned: slotResult.daysSpanned,
      scheduledEntries,
      timeline: {
        scheduledStartDate: firstSlot.start,
        scheduledEndDate: lastSlot.end,
      },
    });
  } catch (error) {
    console.error("Error scheduling work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while scheduling work order",
      error: error.message,
    });
  }
});

router.get("/debug/check-eligibility", async (req, res) => {
  try {
    const allCustomerRequests = await CustomerRequest.find({})
      .select("requestId status quotations")
      .lean();

    const debugInfo = [];

    for (const cr of allCustomerRequests) {
      const hasQuotation = cr.quotations && cr.quotations.length > 0;
      const hasSalesApproval =
        hasQuotation && cr.quotations[0].salesApproval?.approved;

      const workOrders = await WorkOrder.find({ customerRequestId: cr._id })
        .select("workOrderNumber status operations rawMaterials")
        .lean();

      debugInfo.push({
        moNumber: `MO-${cr.requestId}`,
        status: cr.status,
        hasQuotation,
        hasSalesApproval,
        workOrderCount: workOrders.length,
        workOrders: workOrders.map((wo) => ({
          number: wo.workOrderNumber,
          status: wo.status,
          hasOperations: wo.operations && wo.operations.length > 0,
          operationsCount: wo.operations?.length || 0,
          operationsWithMachines:
            wo.operations?.filter((op) => op.assignedMachine).length || 0,
          rawMaterialsCount: wo.rawMaterials?.length || 0,
          rawMaterialsAllocated:
            wo.rawMaterials?.filter(
              (rm) =>
                rm.allocationStatus === "fully_allocated" ||
                rm.allocationStatus === "issued",
            ).length || 0,
        })),
      });
    }

    res.json({
      success: true,
      totalCustomerRequests: allCustomerRequests.length,
      debugInfo,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/cms/manufacturing/production-schedule/schedule-manufacturing-order
 * Schedule all work orders in a manufacturing order with intelligent sequencing
 */
router.post("/schedule-manufacturing-order", async (req, res) => {
  try {
    const {
      manufacturingOrderId,
      startDate,
      strategy = "sequential",
      maxConcurrent = 1,
      rescheduleExisting = true, // NEW: Allow rescheduling
    } = req.body;

    console.log("Schedule MO Request:", {
      manufacturingOrderId,
      startDate,
      strategy,
      maxConcurrent,
      rescheduleExisting,
    });

    if (!manufacturingOrderId || !startDate) {
      return res.status(400).json({
        success: false,
        message: "manufacturingOrderId and startDate are required",
      });
    }

    // Get MO and its work orders
    const mo = await CustomerRequest.findById(manufacturingOrderId)
      .select("requestId customerInfo priority")
      .lean();

    if (!mo) {
      return res.status(404).json({
        success: false,
        message: "Manufacturing order not found",
      });
    }

    console.log(`Found MO: MO-${mo.requestId}`);

    // Get all work orders for this MO
    const workOrders = await WorkOrder.find({
      customerRequestId: manufacturingOrderId,
      status: { $in: ["planned", "ready_to_start", "scheduled", "pending"] }, // Include pending
    })
      .populate("stockItemId", "name reference")
      .lean();

    console.log(
      `Found ${workOrders.length} work orders for MO-${mo.requestId}`,
    );

    if (workOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No work orders found for this manufacturing order",
      });
    }

    // Filter to only work orders ready for scheduling
    const readyWorkOrders = [];
    const notReadyWorkOrders = [];

    for (const wo of workOrders) {
      const workOrderNumber =
        wo.workOrderNumber || `ID:${wo._id.toString().slice(-6)}`;
      const planningStatus = isWorkOrderReadyForScheduling(wo);

      console.log(`Work Order ${workOrderNumber}:`, {
        status: wo.status,
        operationsCount: wo.operations?.length || 0,
        plannedTimeSeconds: wo.operations?.[0]?.plannedTimeSeconds,
        assignedMachine: wo.operations?.[0]?.assignedMachine,
        rawMaterials: wo.rawMaterials?.length || 0,
        planningStatus: planningStatus,
      });

      if (planningStatus.ready) {
        // Remove existing schedule if rescheduling
        if (wo.status === "scheduled" && rescheduleExisting) {
          try {
            const existingSchedule = await ProductionSchedule.findOne({
              "scheduledWorkOrders.workOrderId": wo._id,
            });

            if (existingSchedule) {
              console.log(
                `Removing ${workOrderNumber} from existing schedule ${existingSchedule._id}`,
              );

              existingSchedule.scheduledWorkOrders =
                existingSchedule.scheduledWorkOrders.filter(
                  (scheduledWO) =>
                    scheduledWO.workOrderId.toString() !== wo._id.toString(),
                );

              existingSchedule.calculateUtilization();
              await existingSchedule.save();

              await WorkOrder.findByIdAndUpdate(wo._id, {
                $set: {
                  status: "planned",
                  "timeline.scheduledStartDate": null,
                  "timeline.scheduledEndDate": null,
                },
              });

              console.log(
                `Updated ${workOrderNumber} status from scheduled to planned`,
              );
            }
          } catch (error) {
            console.error(
              `Error removing ${workOrderNumber} from schedule:`,
              error,
            );
          }
        }

        readyWorkOrders.push({
          workOrder: wo,
          durationMinutes: calculateWorkOrderDuration(wo),
          planningStatus,
          wasScheduled: wo.status === "scheduled",
        });
      } else {
        notReadyWorkOrders.push({
          workOrderNumber: workOrderNumber,
          reason: planningStatus.reason,
          details: planningStatus,
        });
      }
    }

    console.log(
      `Ready WOs: ${readyWorkOrders.length}, Not Ready: ${notReadyWorkOrders.length}`,
    );

    if (readyWorkOrders.length === 0) {
      return res.status(400).json({
        success: false,
        message: "No work orders are ready for scheduling",
        notReadyWorkOrders,
        details: "Check if work orders have operations with planned time",
      });
    }

    // Sort work orders based on strategy
    if (strategy === "sequential") {
      readyWorkOrders.sort((a, b) => {
        // Sort by wasScheduled first (already scheduled ones first)
        if (a.wasScheduled && !b.wasScheduled) return -1;
        if (!a.wasScheduled && b.wasScheduled) return 1;

        // Then by duration (longest first)
        return b.durationMinutes - a.durationMinutes;
      });
    } else if (strategy === "parallel") {
      readyWorkOrders.sort((a, b) => {
        const aCategory = a.workOrder.stockItemId?.category || "";
        const bCategory = b.workOrder.stockItemId?.category || "";
        return aCategory.localeCompare(bCategory);
      });
    }

    // Schedule work orders
    let currentDate = new Date(startDate);
    const scheduledResults = [];
    const failedResults = [];
    let concurrentCount = 0;

    for (const {
      workOrder,
      durationMinutes,
      wasScheduled,
    } of readyWorkOrders) {
      try {
        // FIXED: Get or generate work order number
        const workOrderNumber =
          workOrder.workOrderNumber || generateWorkOrderNumber(workOrder);

        console.log(
          `Scheduling ${workOrderNumber} (${wasScheduled ? "rescheduling" : "new"}), duration: ${durationMinutes} minutes`,
        );

        // Find best slot for work order
        const slotResult = await findBestSlotForWorkOrder(
          workOrder,
          mo,
          currentDate,
          getColorCode(mo.priority),
          req.user.id,
        );

        if (slotResult.success) {
          const firstSlot = slotResult.scheduledSlots[0];
          const lastSlot =
            slotResult.scheduledSlots[slotResult.scheduledSlots.length - 1];

          console.log(`Found slot for ${workOrderNumber}:`, {
            daysSpanned: slotResult.daysSpanned,
            slots: slotResult.scheduledSlots.length,
            firstSlot: firstSlot.start,
            lastSlot: lastSlot.end,
          });

          // Calculate total planned seconds for timeline
          const totalPlannedSeconds = workOrder.operations.reduce(
            (sum, op) => sum + (op.plannedTimeSeconds || 0),
            0,
          );

          // Schedule the work order
          for (const slot of slotResult.scheduledSlots) {
            const schedule = await ProductionSchedule.findById(slot.scheduleId);

            const scheduledWO = {
              workOrderId: workOrder._id,
              workOrderNumber: workOrderNumber, // Use generated number
              manufacturingOrderId: mo._id,
              manufacturingOrderNumber: `MO-${mo.requestId}`,
              stockItemName: workOrder.stockItemId?.name || "Unknown",
              stockItemReference: workOrder.stockItemId?.reference || "",
              quantity: workOrder.quantity,
              scheduledStartTime: slot.start,
              scheduledEndTime: slot.end,
              durationMinutes: slot.durationMinutes,
              colorCode: getColorCode(mo.priority),
              position: schedule.scheduledWorkOrders.length,
              status: "scheduled",
              isMultiDay: slotResult.scheduledSlots.length > 1,
              originalScheduleId: firstSlot.scheduleId,
              continuationScheduleIds: slotResult.scheduledSlots
                .slice(1)
                .map((s) => s.scheduleId),
            };

            schedule.scheduledWorkOrders.push(scheduledWO);
            schedule.calculateUtilization();

            schedule.modifications.push({
              modifiedBy: req.user.id,
              modifiedAt: new Date(),
              modificationType: wasScheduled
                ? "work_order_rescheduled"
                : "work_order_added",
              details: `${wasScheduled ? "Rescheduled" : "Scheduled"} ${workOrderNumber} as part of MO-${mo.requestId}`,
            });

            await schedule.save();
            console.log(
              `Added ${workOrderNumber} to schedule ${schedule.date.toISOString().split("T")[0]}`,
            );
          }

          // Update work order with the generated number if missing
          const updateData = {
            $set: {
              status: "scheduled",
              "timeline.scheduledStartDate": firstSlot.start,
              "timeline.scheduledEndDate": lastSlot.end,
              "timeline.totalPlannedSeconds": totalPlannedSeconds,
              "timeline.totalEstimatedSeconds": totalPlannedSeconds,
              "timeline.plannedStartDate": firstSlot.start,
              "timeline.plannedEndDate": lastSlot.end,
            },
            $push: {
              productionNotes: {
                note: `Scheduled for production from ${firstSlot.start.toLocaleDateString()} to ${lastSlot.end.toLocaleDateString()} (${durationMinutes} minutes)`,
                addedBy: req.user.id,
                addedByModel: "ProjectManager",
                addedAt: new Date(),
              },
            },
          };

          // Add workOrderNumber to update if missing
          if (!workOrder.workOrderNumber) {
            updateData.$set.workOrderNumber = workOrderNumber;
          }

          await WorkOrder.findByIdAndUpdate(workOrder._id, updateData);

          scheduledResults.push({
            workOrderNumber: workOrderNumber,
            originalWorkOrderId: workOrder._id,
            durationMinutes: durationMinutes,
            scheduledStart: firstSlot.start,
            scheduledEnd: lastSlot.end,
            daysSpanned: slotResult.daysSpanned,
            wasScheduled: wasScheduled,
            workOrderNumberGenerated: !workOrder.workOrderNumber,
          });

          console.log(
            `Successfully ${wasScheduled ? "rescheduled" : "scheduled"} ${workOrderNumber}`,
          );

          // Update current date for next work order
          if (strategy === "sequential") {
            currentDate = new Date(lastSlot.end);
          } else if (strategy === "parallel") {
            concurrentCount++;
            if (concurrentCount >= maxConcurrent) {
              const earliestEnd = scheduledResults
                .slice(-maxConcurrent)
                .reduce(
                  (earliest, result) =>
                    result.scheduledEnd < earliest
                      ? result.scheduledEnd
                      : earliest,
                  scheduledResults[scheduledResults.length - 1].scheduledEnd,
                );
              currentDate = earliestEnd;
              concurrentCount = 0;
            }
          }
        } else {
          console.log(
            `Failed to find slot for ${workOrderNumber}:`,
            slotResult.message,
          );
          failedResults.push({
            workOrderNumber: workOrderNumber,
            reason: slotResult.message,
            wasScheduled: wasScheduled,
          });
        }
      } catch (error) {
        console.error(
          `Error scheduling ${workOrder.workOrderNumber || workOrder._id}:`,
          error,
        );
        failedResults.push({
          workOrderNumber:
            workOrder.workOrderNumber || workOrder._id.toString().slice(-6),
          reason: error.message,
          wasScheduled: wasScheduled,
        });
      }
    }
    // Update MO status if any work orders scheduled
    if (scheduledResults.length > 0) {
      await CustomerRequest.findByIdAndUpdate(manufacturingOrderId, {
        $set: {
          status: "production",
        },
      });
      console.log(`Updated MO-${mo.requestId} status to production`);
    }

    res.json({
      success: true,
      message: `${scheduledResults.length} work orders scheduled (${scheduledResults.filter((r) => r.wasScheduled).length} rescheduled)${failedResults.length > 0 ? `, ${failedResults.length} failed` : ""}`,
      moNumber: `MO-${mo.requestId}`,
      scheduledResults,
      failedResults,
      notReadyWorkOrders,
      summary: {
        totalWorkOrders: workOrders.length,
        readyForScheduling: readyWorkOrders.length,
        successfullyScheduled: scheduledResults.length,
        failedToSchedule: failedResults.length,
        notReady: notReadyWorkOrders.length,
        rescheduled: scheduledResults.filter((r) => r.wasScheduled).length,
        newlyScheduled: scheduledResults.filter((r) => !r.wasScheduled).length,
      },
    });
  } catch (error) {
    console.error("Error scheduling manufacturing order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while scheduling manufacturing order",
      error: error.message,
      stack: error.stack,
    });
  }
});

// Helper function to get color code based on priority
const getColorCode = (priority) => {
  const colorMap = {
    urgent: "#EF4444", // red-500
    high: "#F59E0B", // amber-500
    medium: "#3B82F6", // blue-500
    low: "#10B981", // emerald-500
  };
  return colorMap[priority] || "#3B82F6"; // default blue
};

/**
 * POST /api/cms/manufacturing/production-schedule/bulk-schedule
 * Schedule multiple work orders at once
 */
router.post("/bulk-schedule", async (req, res) => {
  try {
    const { workOrderIds, startDate, strategy = "sequential" } = req.body;

    if (
      !workOrderIds ||
      !Array.isArray(workOrderIds) ||
      workOrderIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: "workOrderIds array is required",
      });
    }

    if (!startDate) {
      return res.status(400).json({
        success: false,
        message: "startDate is required",
      });
    }

    const results = {
      successful: [],
      failed: [],
      skipped: [],
    };

    let currentDate = new Date(startDate);

    // Get all work orders first
    const workOrders = await WorkOrder.find({
      _id: { $in: workOrderIds },
    })
      .populate("stockItemId", "name reference")
      .populate("customerRequestId", "requestId customerInfo")
      .lean();

    // Process each work order
    for (const workOrder of workOrders) {
      try {
        // Check if ready for scheduling
        const planningStatus = isWorkOrderReadyForScheduling(workOrder);

        if (!planningStatus.ready) {
          results.skipped.push({
            workOrderNumber: workOrder.workOrderNumber,
            reason: planningStatus.reason,
          });
          continue;
        }

        // Check if already scheduled
        const existingSchedule = await ProductionSchedule.findOne({
          "scheduledWorkOrders.workOrderId": workOrder._id,
        });

        if (existingSchedule) {
          results.skipped.push({
            workOrderNumber: workOrder.workOrderNumber,
            reason: "Already scheduled",
            scheduleId: existingSchedule._id,
          });
          continue;
        }

        // Find MO
        const mo = await CustomerRequest.findById(workOrder.customerRequestId)
          .select("requestId customerInfo")
          .lean();

        if (!mo) {
          results.failed.push({
            workOrderNumber: workOrder.workOrderNumber,
            reason: "Manufacturing order not found",
          });
          continue;
        }

        // Find best slot
        const slotResult = await findBestSlotForWorkOrder(
          workOrder,
          mo,
          currentDate,
          "#3B82F6", // Default color
          req.user.id,
        );

        if (!slotResult.success) {
          results.failed.push({
            workOrderNumber: workOrder.workOrderNumber,
            reason: slotResult.message,
          });
          continue;
        }

        // Schedule work order
        for (const slot of slotResult.scheduledSlots) {
          const schedule = await ProductionSchedule.findById(slot.scheduleId);

          const scheduledWO = {
            workOrderId: workOrder._id,
            workOrderNumber: workOrder.workOrderNumber,
            manufacturingOrderId: mo._id,
            manufacturingOrderNumber: `MO-${mo.requestId}`,
            stockItemName: workOrder.stockItemId?.name || "Unknown",
            stockItemReference: workOrder.stockItemId?.reference || "",
            quantity: workOrder.quantity,
            scheduledStartTime: slot.start,
            scheduledEndTime: slot.end,
            durationMinutes: slot.durationMinutes,
            colorCode: "#3B82F6",
            position: schedule.scheduledWorkOrders.length,
            status: "scheduled",
            isMultiDay: slotResult.scheduledSlots.length > 1,
          };

          schedule.scheduledWorkOrders.push(scheduledWO);
          schedule.calculateUtilization();
          await schedule.save();
        }

        // Update work order
        const firstSlot = slotResult.scheduledSlots[0];
        const lastSlot =
          slotResult.scheduledSlots[slotResult.scheduledSlots.length - 1];

        await WorkOrder.findByIdAndUpdate(workOrder._id, {
          $set: {
            "timeline.scheduledStartDate": firstSlot.start,
            "timeline.scheduledEndDate": lastSlot.end,
            status: "scheduled",
          },
        });

        results.successful.push({
          workOrderNumber: workOrder.workOrderNumber,
          scheduledStart: firstSlot.start,
          scheduledEnd: lastSlot.end,
          daysSpanned: slotResult.daysSpanned,
        });

        // Update current date for next work order
        if (strategy === "sequential") {
          currentDate = new Date(lastSlot.end);
        }
      } catch (error) {
        console.error(`Error processing ${workOrder.workOrderNumber}:`, error);
        results.failed.push({
          workOrderNumber: workOrder.workOrderNumber,
          reason: error.message,
        });
      }
    }

    res.json({
      success: true,
      message: `Bulk scheduling completed`,
      results,
      summary: {
        total: workOrderIds.length,
        successful: results.successful.length,
        failed: results.failed.length,
        skipped: results.skipped.length,
      },
    });
  } catch (error) {
    console.error("Error in bulk scheduling:", error);
    res.status(500).json({
      success: false,
      message: "Server error during bulk scheduling",
      error: error.message,
    });
  }
});

// =====================
// UPDATE ROUTES
// =====================

/**
 * PUT /api/cms/manufacturing/production-schedule/day-settings/:date
 * Update day settings with enhanced validation
 */
router.put("/day-settings/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const {
      workHours,
      breaks,
      isHoliday,
      holidayReason,
      isSundayOverride,
      isSaturdayOverride,
      notes,
    } = req.body;

    const schedule = await getOrCreateSchedule(date, req.user.id);

    // Store old settings for comparison
    const oldSettings = {
      workHours: { ...schedule.workHours },
      breaks: [...schedule.breaks],
      isHoliday: schedule.isHoliday,
      isSundayOverride: schedule.isSundayOverride,
      isSaturdayOverride: schedule.isSaturdayOverride,
    };

    // Update work hours
    if (workHours) {
      schedule.workHours = {
        ...schedule.workHours,
        ...workHours,
        customHours: true,
      };

      // Recalculate total minutes
      const startMinutes = timeToMinutes(schedule.workHours.startTime);
      const endMinutes = timeToMinutes(schedule.workHours.endTime);
      schedule.workHours.totalMinutes = Math.max(0, endMinutes - startMinutes);
    }

    // Update breaks
    if (breaks !== undefined) {
      schedule.breaks = breaks.map((breakItem) => ({
        ...breakItem,
        durationMinutes:
          timeToMinutes(breakItem.endTime) - timeToMinutes(breakItem.startTime),
      }));
    }

    // Update holiday status
    if (isHoliday !== undefined) {
      schedule.isHoliday = isHoliday;
      if (isHoliday) {
        schedule.workHours.isActive = false;
        schedule.holidayReason = holidayReason || "Day off";
      } else {
        schedule.workHours.isActive = true;
        schedule.holidayReason = "";
      }
    }

    // Update Sunday override
    if (isSundayOverride !== undefined && new Date(date).getDay() === 0) {
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
    }

    // Update Saturday override
    if (isSaturdayOverride !== undefined && new Date(date).getDay() === 6) {
      schedule.isSaturdayOverride = isSaturdayOverride;
      if (isSaturdayOverride) {
        schedule.workHours.isActive = true;
        schedule.notes = "Saturday - Working (Override)";
      } else {
        schedule.workHours.isActive = false;
        schedule.notes = "Saturday - Weekend";
      }
    }

    // Update notes
    if (notes !== undefined) {
      schedule.notes = notes;
    }

    // Recalculate available minutes
    schedule.calculateAvailableMinutes();

    // Check for rescheduling needed
    const needsRescheduling =
      (!oldSettings.workHours.isActive && schedule.workHours.isActive) ||
      (oldSettings.isHoliday && !schedule.isHoliday) ||
      oldSettings.workHours.totalMinutes !== schedule.workHours.totalMinutes;

    if (needsRescheduling && schedule.scheduledWorkOrders.length > 0) {
      // Reschedule logic would go here
      // For now, just mark for attention
      schedule.notes += " [Note: Work orders may need rescheduling]";
    }

    // Add modification record
    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "day_settings_changed",
      details: `Updated day settings: ${JSON.stringify({
        workHours: schedule.workHours,
        isHoliday: schedule.isHoliday,
        holidayReason: schedule.holidayReason,
      })}`,
    });

    await schedule.save();

    res.json({
      success: true,
      message: "Day settings updated successfully",
      schedule: schedule,
      needsRescheduling,
      warning: needsRescheduling
        ? "Work orders may need to be rescheduled"
        : null,
    });
  } catch (error) {
    console.error("Error updating day settings:", error);
    res.status(500).json({
      success: false,
      message: "Server error while updating day settings",
      error: error.message,
    });
  }
});

/**
 * PUT /api/cms/manufacturing/production-schedule/reschedule-work-order/:workOrderId
 * Reschedule a work order to a new date
 */
router.put("/reschedule-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const { newStartDate, reason } = req.body;

    if (!newStartDate) {
      return res.status(400).json({
        success: false,
        message: "newStartDate is required",
      });
    }

    // Find work order
    const workOrder = await WorkOrder.findById(workOrderId)
      .populate("stockItemId", "name reference")
      .populate("customerRequestId", "requestId")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Find existing schedule
    const existingSchedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });

    if (!existingSchedule) {
      return res.status(404).json({
        success: false,
        message: "Work order is not scheduled",
      });
    }

    // Remove from existing schedule
    const removedWO = existingSchedule.scheduledWorkOrders.find(
      (wo) => wo.workOrderId.toString() === workOrderId,
    );

    existingSchedule.scheduledWorkOrders =
      existingSchedule.scheduledWorkOrders.filter(
        (wo) => wo.workOrderId.toString() !== workOrderId,
      );

    existingSchedule.calculateUtilization();
    existingSchedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_removed",
      details: `Removed ${workOrder.workOrderNumber} for rescheduling: ${reason || "No reason provided"}`,
    });

    await existingSchedule.save();

    // Find MO
    const mo = await CustomerRequest.findById(workOrder.customerRequestId)
      .select("requestId customerInfo")
      .lean();

    // Find new slot
    const slotResult = await findBestSlotForWorkOrder(
      workOrder,
      mo,
      new Date(newStartDate),
      removedWO?.colorCode || "#3B82F6",
      req.user.id,
    );

    if (!slotResult.success) {
      // Restore to original schedule if rescheduling fails
      existingSchedule.scheduledWorkOrders.push(removedWO);
      existingSchedule.calculateUtilization();
      await existingSchedule.save();

      return res.status(400).json({
        success: false,
        message: slotResult.message,
        restored: true,
      });
    }

    // Schedule in new slots
    for (const slot of slotResult.scheduledSlots) {
      const schedule = await ProductionSchedule.findById(slot.scheduleId);

      const scheduledWO = {
        ...removedWO,
        scheduledStartTime: slot.start,
        scheduledEndTime: slot.end,
        durationMinutes: slot.durationMinutes,
        isMultiDay: slotResult.scheduledSlots.length > 1,
        continuationScheduleIds: slotResult.scheduledSlots
          .slice(1)
          .map((s) => s.scheduleId),
      };

      schedule.scheduledWorkOrders.push(scheduledWO);
      schedule.calculateUtilization();

      schedule.modifications.push({
        modifiedBy: req.user.id,
        modifiedAt: new Date(),
        modificationType: "work_order_rescheduled",
        details: `Rescheduled ${workOrder.workOrderNumber} from ${existingSchedule.date.toLocaleDateString()}`,
      });

      await schedule.save();
    }

    // Update work order
    const firstSlot = slotResult.scheduledSlots[0];
    const lastSlot =
      slotResult.scheduledSlots[slotResult.scheduledSlots.length - 1];

    await WorkOrder.findByIdAndUpdate(workOrderId, {
      $set: {
        "timeline.scheduledStartDate": firstSlot.start,
        "timeline.scheduledEndDate": lastSlot.end,
      },
      $push: {
        productionNotes: {
          note: `Rescheduled: ${reason || "No reason provided"}. New schedule: ${firstSlot.start.toLocaleDateString()} - ${lastSlot.end.toLocaleDateString()}`,
          addedBy: req.user.id,
          addedByModel: "ProjectManager",
          addedAt: new Date(),
        },
      },
    });

    res.json({
      success: true,
      message: "Work order rescheduled successfully",
      workOrderNumber: workOrder.workOrderNumber,
      oldSchedule: {
        date: existingSchedule.date,
        startTime: removedWO?.scheduledStartTime,
        endTime: removedWO?.scheduledEndTime,
      },
      newSchedule: {
        startDate: firstSlot.start,
        endDate: lastSlot.end,
        daysSpanned: slotResult.daysSpanned,
      },
      reason,
    });
  } catch (error) {
    console.error("Error rescheduling work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while rescheduling work order",
      error: error.message,
    });
  }
});

/**
 * PUT /api/cms/manufacturing/production-schedule/update-work-order-time/:scheduleId/:workOrderScheduleId
 * Update a specific work order's time within the same day
 */
router.put(
  "/update-work-order-time/:scheduleId/:workOrderScheduleId",
  async (req, res) => {
    try {
      const { scheduleId, workOrderScheduleId } = req.params;
      const { scheduledStartTime, scheduledEndTime, reason } = req.body;

      if (!scheduledStartTime || !scheduledEndTime) {
        return res.status(400).json({
          success: false,
          message: "scheduledStartTime and scheduledEndTime are required",
        });
      }

      const schedule = await ProductionSchedule.findById(scheduleId);
      if (!schedule) {
        return res.status(404).json({
          success: false,
          message: "Schedule not found",
        });
      }

      // Check if schedule is locked (past date)
      if (schedule.isLocked || schedule.date < new Date()) {
        return res.status(400).json({
          success: false,
          message: "Cannot modify past schedules",
        });
      }

      const woSchedule = schedule.scheduledWorkOrders.id(workOrderScheduleId);
      if (!woSchedule) {
        return res.status(404).json({
          success: false,
          message: "Work order schedule not found",
        });
      }

      // Validate new times
      const newStartTime = new Date(scheduledStartTime);
      const newEndTime = new Date(scheduledEndTime);
      const scheduleDate = new Date(schedule.date);

      // Ensure times are on the same day
      if (
        newStartTime.toDateString() !== scheduleDate.toDateString() ||
        newEndTime.toDateString() !== scheduleDate.toDateString()
      ) {
        return res.status(400).json({
          success: false,
          message: "Times must be on the same day as the schedule",
        });
      }

      // Check work hours
      const workStart = createDateWithTime(
        scheduleDate,
        schedule.workHours.startTime,
      );
      const workEnd = createDateWithTime(
        scheduleDate,
        schedule.workHours.endTime,
      );

      if (newStartTime < workStart || newEndTime > workEnd) {
        return res.status(400).json({
          success: false,
          message: `Times must be within work hours (${schedule.workHours.startTime} - ${schedule.workHours.endTime})`,
        });
      }

      // Check for breaks
      const allBreaks = [
        ...(schedule.defaultBreaks || []),
        ...(schedule.breaks || []),
      ];
      for (const br of allBreaks) {
        const breakStart = createDateWithTime(scheduleDate, br.startTime);
        const breakEnd = createDateWithTime(scheduleDate, br.endTime);

        if (
          (newStartTime >= breakStart && newStartTime < breakEnd) ||
          (newEndTime > breakStart && newEndTime <= breakEnd) ||
          (newStartTime <= breakStart && newEndTime >= breakEnd)
        ) {
          return res.status(400).json({
            success: false,
            message: `Schedule conflicts with break: ${br.name} (${br.startTime} - ${br.endTime})`,
          });
        }
      }

      // Check for conflicts with other work orders
      for (const otherWO of schedule.scheduledWorkOrders) {
        if (otherWO._id.toString() === workOrderScheduleId) continue;

        if (
          (newStartTime >= otherWO.scheduledStartTime &&
            newStartTime < otherWO.scheduledEndTime) ||
          (newEndTime > otherWO.scheduledStartTime &&
            newEndTime <= otherWO.scheduledEndTime) ||
          (newStartTime <= otherWO.scheduledStartTime &&
            newEndTime >= otherWO.scheduledEndTime)
        ) {
          return res.status(400).json({
            success: false,
            message: `Schedule conflicts with ${otherWO.workOrderNumber}`,
          });
        }
      }

      // Update times
      const oldStartTime = woSchedule.scheduledStartTime;
      const oldEndTime = woSchedule.scheduledEndTime;

      woSchedule.scheduledStartTime = newStartTime;
      woSchedule.scheduledEndTime = newEndTime;

      // Recalculate duration
      const durationMs = newEndTime - newStartTime;
      woSchedule.durationMinutes = Math.ceil(durationMs / 60000);

      // Add modification record
      schedule.modifications.push({
        modifiedBy: req.user.id,
        modifiedAt: new Date(),
        modificationType: "work_order_time_updated",
        details: `Updated ${woSchedule.workOrderNumber} from ${oldStartTime.toLocaleTimeString()} to ${newStartTime.toLocaleTimeString()}. Reason: ${reason || "No reason provided"}`,
      });

      schedule.calculateUtilization();
      await schedule.save();

      // Update work order timeline
      await WorkOrder.findByIdAndUpdate(woSchedule.workOrderId, {
        $set: {
          "timeline.scheduledStartDate": newStartTime,
          "timeline.scheduledEndDate": newEndTime,
        },
      });

      res.json({
        success: true,
        message: "Work order time updated successfully",
        schedule: {
          _id: schedule._id,
          date: schedule.date,
          utilizationPercentage: schedule.utilizationPercentage,
        },
        workOrder: {
          workOrderNumber: woSchedule.workOrderNumber,
          oldTimes: {
            start: oldStartTime,
            end: oldEndTime,
          },
          newTimes: {
            start: newStartTime,
            end: newEndTime,
          },
          durationMinutes: woSchedule.durationMinutes,
        },
      });
    } catch (error) {
      console.error("Error updating work order time:", error);
      res.status(500).json({
        success: false,
        message: "Server error while updating work order time",
        error: error.message,
      });
    }
  },
);

// =====================
// DELETE ROUTES
// =====================

/**
 * DELETE /api/cms/manufacturing/production-schedule/remove-work-order/:workOrderId
 * Remove a work order from schedule
 */
router.delete("/remove-work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;
    const { reason } = req.body;

    // Find schedule containing this work order
    const schedule = await ProductionSchedule.findOne({
      "scheduledWorkOrders.workOrderId": workOrderId,
    });

    if (!schedule) {
      return res.status(404).json({
        success: false,
        message: "Work order is not scheduled",
      });
    }

    // Check if schedule is locked
    if (schedule.isLocked || schedule.date < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Cannot remove from past schedules",
      });
    }

    // Find and remove the work order
    const woSchedule = schedule.scheduledWorkOrders.find(
      (wo) => wo.workOrderId.toString() === workOrderId,
    );

    if (!woSchedule) {
      return res.status(404).json({
        success: false,
        message: "Work order schedule not found",
      });
    }

    schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
      (wo) => wo.workOrderId.toString() !== workOrderId,
    );

    // Add modification record
    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "work_order_removed",
      details: `Removed ${woSchedule.workOrderNumber} from schedule. Reason: ${reason || "No reason provided"}`,
    });

    schedule.calculateUtilization();
    await schedule.save();

    // Update work order status
    await WorkOrder.findByIdAndUpdate(workOrderId, {
      $set: {
        status: "planned",
        "timeline.scheduledStartDate": null,
        "timeline.scheduledEndDate": null,
      },
      $push: {
        productionNotes: {
          note: `Removed from production schedule. Reason: ${reason || "No reason provided"}`,
          addedBy: req.user.id,
          addedByModel: "ProjectManager",
          addedAt: new Date(),
        },
      },
    });

    res.json({
      success: true,
      message: "Work order removed from schedule",
      workOrderNumber: woSchedule.workOrderNumber,
      scheduleDate: schedule.date,
      reason,
    });
  } catch (error) {
    console.error("Error removing work order from schedule:", error);
    res.status(500).json({
      success: false,
      message: "Server error while removing work order",
      error: error.message,
    });
  }
});

/**
 * DELETE /api/cms/manufacturing/production-schedule/clear-day/:date
 * Clear all scheduled work orders from a day
 */
router.delete("/clear-day/:date", async (req, res) => {
  try {
    const { date } = req.params;
    const { reason } = req.body;

    const schedule = await getOrCreateSchedule(date, req.user.id);

    // Check if schedule is locked
    if (schedule.isLocked || schedule.date < new Date()) {
      return res.status(400).json({
        success: false,
        message: "Cannot clear past schedules",
      });
    }

    if (schedule.scheduledWorkOrders.length === 0) {
      return res.json({
        success: true,
        message: "Schedule is already empty",
        schedule,
      });
    }

    const removedWorkOrders = [...schedule.scheduledWorkOrders];
    const workOrderIds = removedWorkOrders.map((wo) => wo.workOrderId);

    // Update work orders back to planned status
    await WorkOrder.updateMany(
      { _id: { $in: workOrderIds } },
      {
        $set: {
          status: "planned",
          "timeline.scheduledStartDate": null,
          "timeline.scheduledEndDate": null,
        },
        $push: {
          productionNotes: {
            note: `Schedule cleared for ${schedule.date.toLocaleDateString()}. Reason: ${reason || "No reason provided"}`,
            addedBy: req.user.id,
            addedByModel: "ProjectManager",
            addedAt: new Date(),
          },
        },
      },
    );

    // Clear schedule
    schedule.scheduledWorkOrders = [];

    // Add modification record
    schedule.modifications.push({
      modifiedBy: req.user.id,
      modifiedAt: new Date(),
      modificationType: "schedule_cleared",
      details: `Cleared all ${removedWorkOrders.length} work orders. Reason: ${reason || "No reason provided"}`,
    });

    schedule.calculateUtilization();
    await schedule.save();

    res.json({
      success: true,
      message: `Cleared ${removedWorkOrders.length} work orders from schedule`,
      date: schedule.date,
      clearedWorkOrders: removedWorkOrders.map((wo) => ({
        workOrderNumber: wo.workOrderNumber,
        manufacturingOrderNumber: wo.manufacturingOrderNumber,
      })),
      reason,
    });
  } catch (error) {
    console.error("Error clearing day schedule:", error);
    res.status(500).json({
      success: false,
      message: "Server error while clearing schedule",
      error: error.message,
    });
  }
});

// =====================
// ANALYTICS ROUTES
// =====================

/**
 * GET /api/cms/manufacturing/production-schedule/analytics
 * Get scheduling analytics
 */
router.get("/analytics", async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date();
    start.setHours(0, 0, 0, 0);

    const end = endDate ? new Date(endDate) : new Date();
    end.setMonth(end.getMonth() + 1); // Next month
    end.setHours(23, 59, 59, 999);

    // Get schedules in range
    const schedules = await ProductionSchedule.find({
      date: { $gte: start, $lte: end },
    })
      .populate("scheduledWorkOrders.workOrderId", "workOrderNumber quantity")
      .populate(
        "scheduledWorkOrders.manufacturingOrderId",
        "requestId priority",
      )
      .lean();

    // Calculate analytics
    let totalDays = 0;
    let workDays = 0;
    let holidayDays = 0;
    let totalScheduledMinutes = 0;
    let totalAvailableMinutes = 0;
    let manufacturingOrderStats = {};
    let dailyUtilization = [];

    const currentDate = new Date(start);
    while (currentDate <= end) {
      totalDays++;

      const schedule = schedules.find(
        (s) => s.date.toDateString() === currentDate.toDateString(),
      );

      if (schedule) {
        if (schedule.isHoliday || !schedule.workHours.isActive) {
          holidayDays++;
        } else {
          workDays++;
          totalScheduledMinutes += schedule.scheduledMinutes || 0;
          totalAvailableMinutes += schedule.availableMinutes || 0;

          dailyUtilization.push({
            date: schedule.date,
            utilization: schedule.utilizationPercentage || 0,
            scheduledMinutes: schedule.scheduledMinutes || 0,
            availableMinutes: schedule.availableMinutes || 0,
          });

          // Track MO stats
          schedule.scheduledWorkOrders?.forEach((wo) => {
            const moId =
              wo.manufacturingOrderId?._id || wo.manufacturingOrderId;
            if (!manufacturingOrderStats[moId]) {
              manufacturingOrderStats[moId] = {
                moNumber: wo.manufacturingOrderNumber,
                workOrderCount: 0,
                totalMinutes: 0,
                daysSpanned: new Set(),
              };
            }
            manufacturingOrderStats[moId].workOrderCount++;
            manufacturingOrderStats[moId].totalMinutes +=
              wo.durationMinutes || 0;
            manufacturingOrderStats[moId].daysSpanned.add(
              schedule.date.toDateString(),
            );
          });
        }
      } else {
        // Day without schedule (likely future day)
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek === 0) {
          holidayDays++;
        } else {
          workDays++;
        }
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Calculate overall utilization
    const overallUtilization =
      totalAvailableMinutes > 0
        ? (totalScheduledMinutes / totalAvailableMinutes) * 100
        : 0;

    // Convert MO stats to array
    const moStatsArray = Object.values(manufacturingOrderStats).map((stat) => ({
      ...stat,
      daysSpanned: stat.daysSpanned.size,
      averageMinutesPerDay:
        stat.daysSpanned.size > 0
          ? stat.totalMinutes / stat.daysSpanned.size
          : stat.totalMinutes,
    }));

    // Sort by total minutes
    moStatsArray.sort((a, b) => b.totalMinutes - a.totalMinutes);

    res.json({
      success: true,
      analytics: {
        dateRange: { start, end },
        days: {
          total: totalDays,
          workDays,
          holidayDays,
          utilizationRate: workDays > 0 ? (workDays / totalDays) * 100 : 0,
        },
        capacity: {
          totalAvailableMinutes,
          totalScheduledMinutes,
          remainingMinutes: Math.max(
            0,
            totalAvailableMinutes - totalScheduledMinutes,
          ),
          overallUtilization: Math.round(overallUtilization * 100) / 100,
        },
        manufacturingOrders: {
          total: moStatsArray.length,
          stats: moStatsArray,
          topConsumers: moStatsArray.slice(0, 5),
        },
        dailyUtilization: dailyUtilization.sort(
          (a, b) => new Date(a.date) - new Date(b.date),
        ),
        recommendations: generateSchedulingRecommendations(
          schedules,
          moStatsArray,
        ),
      },
    });
  } catch (error) {
    console.error("Error fetching analytics:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching analytics",
      error: error.message,
    });
  }
});

/**
 * Helper function to generate scheduling recommendations
 */
function generateSchedulingRecommendations(schedules, moStats) {
  const recommendations = [];

  // Check for over-utilized days
  schedules.forEach((schedule) => {
    if (schedule.utilizationPercentage > 100) {
      recommendations.push({
        type: "over_capacity",
        date: schedule.date,
        message: `Day is over capacity (${schedule.utilizationPercentage}% utilization)`,
        severity: "high",
        suggestedAction: "Reschedule some work orders to adjacent days",
      });
    } else if (schedule.utilizationPercentage > 80) {
      recommendations.push({
        type: "high_utilization",
        date: schedule.date,
        message: `High utilization (${schedule.utilizationPercentage}%)`,
        severity: "medium",
        suggestedAction: "Consider spreading work to other days",
      });
    }
  });

  // Check for long-running manufacturing orders
  moStats.forEach((stat) => {
    if (stat.daysSpanned > 7) {
      recommendations.push({
        type: "long_running_mo",
        moNumber: stat.moNumber,
        message: `${stat.moNumber} spans ${stat.daysSpanned} days`,
        severity: "low",
        suggestedAction: "Consider splitting or prioritizing this order",
      });
    }
  });

  return recommendations;
}

/**
 * GET /api/cms/manufacturing/production-schedule/upcoming-work
 * Get upcoming scheduled work
 */
router.get("/upcoming-work", async (req, res) => {
  try {
    const { days = 7, limit = 20 } = req.query;

    const startDate = new Date();
    startDate.setHours(0, 0, 0, 0);

    const endDate = new Date();
    endDate.setDate(endDate.getDate() + parseInt(days));
    endDate.setHours(23, 59, 59, 999);

    // Get schedules with upcoming work
    const schedules = await ProductionSchedule.find({
      date: { $gte: startDate, $lte: endDate },
      "scheduledWorkOrders.0": { $exists: true },
    })
      .select("date scheduledWorkOrders workHours isHoliday")
      .populate({
        path: "scheduledWorkOrders.workOrderId",
        select: "workOrderNumber quantity status priority stockItemId",
        populate: {
          path: "stockItemId",
          select: "name reference",
        },
      })
      .populate({
        path: "scheduledWorkOrders.manufacturingOrderId",
        select: "requestId customerInfo priority",
        populate: {
          path: "customerInfo",
          select: "name",
        },
      })
      .sort({ date: 1 })
      .lean();

    // Flatten work orders with schedule info
    const upcomingWork = [];
    schedules.forEach((schedule) => {
      if (schedule.isHoliday || !schedule.workHours.isActive) return;

      schedule.scheduledWorkOrders.forEach((wo) => {
        upcomingWork.push({
          ...wo,
          scheduleDate: schedule.date,
          isToday: schedule.date.toDateString() === new Date().toDateString(),
          dayOfWeek: schedule.date.toLocaleDateString("en-US", {
            weekday: "long",
          }),
        });
      });
    });

    // Sort by start time
    upcomingWork.sort((a, b) => {
      if (a.scheduleDate.toDateString() !== b.scheduleDate.toDateString()) {
        return a.scheduleDate - b.scheduleDate;
      }
      return new Date(a.scheduledStartTime) - new Date(b.scheduledStartTime);
    });

    res.json({
      success: true,
      upcomingWork: upcomingWork.slice(0, parseInt(limit)),
      total: upcomingWork.length,
      dateRange: { startDate, endDate },
      summary: {
        totalDays: schedules.length,
        totalWorkOrders: upcomingWork.length,
        next7Days: upcomingWork.filter((w) => {
          const daysDiff = Math.ceil(
            (w.scheduleDate - new Date()) / (1000 * 60 * 60 * 24),
          );
          return daysDiff <= 7;
        }).length,
      },
    });
  } catch (error) {
    console.error("Error fetching upcoming work:", error);
    res.status(500).json({
      success: false,
      message: "Server error while fetching upcoming work",
      error: error.message,
    });
  }
});

/**
 * GET /api/cms/manufacturing/production-schedule/debug/work-order/:workOrderId
 * Debug work order scheduling eligibility
 */
router.get("/debug/work-order/:workOrderId", async (req, res) => {
  try {
    const { workOrderId } = req.params;

    const workOrder = await WorkOrder.findById(workOrderId)
      .populate("stockItemId", "name reference")
      .populate("customerRequestId", "requestId status")
      .lean();

    if (!workOrder) {
      return res.status(404).json({
        success: false,
        message: "Work order not found",
      });
    }

    // Check planning status
    const planningStatus = isWorkOrderReadyForScheduling(workOrder);
    const durationMinutes = calculateWorkOrderDuration(workOrder);

    // Check if already scheduled
    const existingSchedule = await ProductionSchedule.findOne(
      {
        "scheduledWorkOrders.workOrderId": workOrderId,
      },
      {
        "scheduledWorkOrders.$": 1,
        date: 1,
      },
    ).lean();

    // Detailed analysis
    const analysis = {
      workOrderNumber: workOrder.workOrderNumber,
      status: workOrder.status,
      quantity: workOrder.quantity,
      timeline: workOrder.timeline,
      operationsCount: workOrder.operations?.length || 0,
      operations: workOrder.operations?.map((op, idx) => ({
        number: idx + 1,
        type: op.operationType,
        plannedTimeSeconds: op.plannedTimeSeconds,
        estimatedTimeSeconds: op.estimatedTimeSeconds,
        assignedMachine: op.assignedMachine,
        machineType: op.machineType,
      })),
      rawMaterialsCount: workOrder.rawMaterials?.length || 0,
      rawMaterials: workOrder.rawMaterials?.map((rm) => ({
        name: rm.name,
        allocationStatus: rm.allocationStatus,
        quantityRequired: rm.quantityRequired,
        quantityAllocated: rm.quantityAllocated,
      })),
      planningStatus,
      durationMinutes,
      isReady: planningStatus.ready,
      totalPlannedSeconds:
        workOrder.operations?.reduce(
          (sum, op) =>
            sum + (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0),
          0,
        ) || 0,
      existingSchedule: existingSchedule
        ? {
            scheduleId: existingSchedule._id,
            date: existingSchedule.date,
            scheduledStartTime:
              existingSchedule.scheduledWorkOrders[0]?.scheduledStartTime,
            scheduledEndTime:
              existingSchedule.scheduledWorkOrders[0]?.scheduledEndTime,
          }
        : null,
    };

    // Calculate what needs to be fixed
    const recommendations = [];
    if (!planningStatus.ready) {
      recommendations.push(`Fix: ${planningStatus.reason}`);
    }
    if (workOrder.timeline?.totalPlannedSeconds === 0) {
      recommendations.push(
        "Timeline needs totalPlannedSeconds calculated from operations",
      );
    }
    if (workOrder.status === "scheduled" && !existingSchedule) {
      recommendations.push(
        "Work order marked as scheduled but not in any production schedule",
      );
    }

    res.json({
      success: true,
      analysis,
      recommendations,
      canBeScheduled: planningStatus.ready,
      actionRequired:
        workOrder.status === "scheduled"
          ? "May need rescheduling"
          : "Ready to schedule",
    });
  } catch (error) {
    console.error("Error debugging work order:", error);
    res.status(500).json({
      success: false,
      message: "Server error while debugging work order",
      error: error.message,
    });
  }
});

module.exports = router;
