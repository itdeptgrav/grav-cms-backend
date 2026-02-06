// models/CMS_Models/Manufacturing/Production/ProductionSchedule.js

const mongoose = require("mongoose");

// Break configuration schema
const breakConfigSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    startTime: {
      type: String, // Format: "HH:MM" (24-hour)
      required: true,
    },
    endTime: {
      type: String,
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
    },
    isFixed: {
      type: Boolean,
      default: true, // Fixed breaks are standard (lunch, tea)
    },
  },
  { _id: true },
);

// Work hours configuration
const workHoursSchema = new mongoose.Schema(
  {
    startTime: {
      type: String,
      default: "09:30",
    },
    endTime: {
      type: String,
      default: "18:30",
    },
    totalMinutes: {
      type: Number,
      default: 540, // 9 hours
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    customHours: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false },
);

// Scheduled work order schema
const scheduledWorkOrderSchema = new mongoose.Schema(
  {
    workOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      required: true,
    },
    workOrderNumber: {
      type: String,
      required: true,
    },
    manufacturingOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
      required: true,
    },
    manufacturingOrderNumber: {
      type: String,
      required: true,
    },
    stockItemName: {
      type: String,
      required: true,
    },
    stockItemReference: {
      type: String,
    },
    quantity: {
      type: Number,
      required: true,
    },

    // Scheduling details
    scheduledStartTime: {
      type: Date,
      required: true,
    },
    scheduledEndTime: {
      type: Date,
      required: true,
    },
    durationMinutes: {
      type: Number,
      required: true,
    },

    // Visual and tracking
    colorCode: {
      type: String,
      default: "#3B82F6", // Default blue
    },
    position: {
      type: Number, // Order of appearance in day
      default: 0,
    },

    // Status tracking
    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "delayed", "cancelled"],
      default: "scheduled",
    },

    // Completion tracking
    actualStartTime: {
      type: Date,
    },
    actualEndTime: {
      type: Date,
    },
    completionPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    // Multi-day tracking
    isMultiDay: {
      type: Boolean,
      default: false,
    },
    originalScheduleId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionSchedule", // Reference to the schedule where it started
    },
    continuationScheduleIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "ProductionSchedule",
      },
    ],

    // Alerts and warnings
    exceedsCapacity: {
      type: Boolean,
      default: false,
    },
    warnings: [
      {
        type: {
          type: String,
          enum: [
            "exceeds_day",
            "overlaps",
            "insufficient_time",
            "unplanned_wo",
          ],
        },
        message: String,
        timestamp: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { _id: true, timestamps: true },
);

// Main production schedule schema
const productionScheduleSchema = new mongoose.Schema(
  {
    date: {
      type: Date,
      required: true,
      index: true,
    },

    // Day configuration
    workHours: workHoursSchema,

    defaultBreaks: [breakConfigSchema], // Standard breaks (lunch, tea)
    breaks: [breakConfigSchema], // Additional custom breaks

    // Day status
    isHoliday: {
      type: Boolean,
      default: false,
    },
    holidayReason: {
      type: String,
      trim: true,
    },
    isSundayOverride: {
      type: Boolean,
      default: false, // Allow scheduling on Sunday
    },

    // Scheduled work orders
    scheduledWorkOrders: [scheduledWorkOrderSchema],

    // Capacity tracking
    availableMinutes: {
      type: Number,
      default: 0,
    },
    scheduledMinutes: {
      type: Number,
      default: 0,
    },
    utilizationPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    isOverCapacity: {
      type: Boolean,
      default: false,
    },

    // History and audit
    isLocked: {
      type: Boolean,
      default: false, // Lock past dates
    },
    lockedAt: {
      type: Date,
    },
    lockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectManager",
    },

    modifications: [
      {
        modifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "ProjectManager",
        },
        modifiedAt: {
          type: Date,
          default: Date.now,
        },
        modificationType: {
          type: String,
          enum: [
            "schedule_created",
            "work_order_added",
            "work_order_removed",
            "work_order_rescheduled",
            "day_settings_changed",
            "break_added",
            "break_removed",
            "work_order_time_updated",
            "schedule_cleared",
            "work_order_moved",
          ],
        },
        details: {
          type: String,
        },
      },
    ],

    notes: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Indexes for performance
productionScheduleSchema.index({ date: 1 }, { unique: true });
productionScheduleSchema.index({ "scheduledWorkOrders.workOrderId": 1 });
productionScheduleSchema.index({
  "scheduledWorkOrders.manufacturingOrderId": 1,
});
productionScheduleSchema.index({ date: 1, isHoliday: 1 });

// Virtual for day type
productionScheduleSchema.virtual("dayType").get(function () {
  if (this.isHoliday) return "holiday";

  const dayOfWeek = new Date(this.date).getDay();
  if (dayOfWeek === 0) {
    return this.isSundayOverride ? "sunday_override" : "sunday_off";
  }

  return this.workHours.isActive ? "workday" : "off_day";
});

// Methods

// Calculate available minutes for the day
productionScheduleSchema.methods.calculateAvailableMinutes = function () {
  if (!this.workHours.isActive || this.isHoliday) {
    this.availableMinutes = 0;
    return 0;
  }

  // Total work hours
  let totalMinutes = this.workHours.totalMinutes;

  // Subtract all breaks
  const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
  const breakMinutes = allBreaks.reduce(
    (sum, br) => sum + (br.durationMinutes || 0),
    0,
  );

  this.availableMinutes = Math.max(0, totalMinutes - breakMinutes);
  return this.availableMinutes;
};

// Calculate scheduled minutes
productionScheduleSchema.methods.calculateScheduledMinutes = function () {
  const scheduled = (this.scheduledWorkOrders || []).reduce(
    (sum, wo) => sum + (wo.durationMinutes || 0),
    0,
  );

  this.scheduledMinutes = scheduled;
  return scheduled;
};

// Calculate utilization
productionScheduleSchema.methods.calculateUtilization = function () {
  this.calculateAvailableMinutes();
  this.calculateScheduledMinutes();

  if (this.availableMinutes === 0) {
    this.utilizationPercentage = 0;
    this.isOverCapacity = false;
    return 0;
  }

  const utilization = (this.scheduledMinutes / this.availableMinutes) * 100;
  this.utilizationPercentage = Math.round(utilization * 100) / 100;
  this.isOverCapacity = this.utilizationPercentage > 100;

  return this.utilizationPercentage;
};

// Check if time slot is during a break
productionScheduleSchema.methods.isDuringBreak = function (time) {
  const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
  const timeMinutes = time.getHours() * 60 + time.getMinutes();

  return allBreaks.some((br) => {
    const [startHour, startMin] = br.startTime.split(":").map(Number);
    const [endHour, endMin] = br.endTime.split(":").map(Number);
    const breakStart = startHour * 60 + startMin;
    const breakEnd = endHour * 60 + endMin;

    return timeMinutes >= breakStart && timeMinutes < breakEnd;
  });
};

// Get next available time slot after current time
productionScheduleSchema.methods.getNextAvailableTime = function (currentTime) {
  if (this.isDuringBreak(currentTime)) {
    // Find which break we're in and return its end time
    const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
    const timeMinutes = currentTime.getHours() * 60 + currentTime.getMinutes();

    for (const br of allBreaks) {
      const [startHour, startMin] = br.startTime.split(":").map(Number);
      const [endHour, endMin] = br.endTime.split(":").map(Number);
      const breakStart = startHour * 60 + startMin;
      const breakEnd = endHour * 60 + endMin;

      if (timeMinutes >= breakStart && timeMinutes < breakEnd) {
        const nextTime = new Date(currentTime);
        nextTime.setHours(endHour, endMin, 0, 0);
        return nextTime;
      }
    }
  }

  return currentTime;
};

// Pre-save middleware
productionScheduleSchema.pre("save", function (next) {
  // Calculate metrics before saving
  this.calculateUtilization();

  // Auto-lock past dates
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const scheduleDate = new Date(this.date);
  scheduleDate.setHours(0, 0, 0, 0);

  if (scheduleDate < today && !this.isLocked) {
    this.isLocked = true;
    this.lockedAt = new Date();
  }

  next();
});

// Add to productionScheduleRoutes.js - Enhanced scheduling logic

/**
 * Enhanced helper function to schedule work order with proper break handling
 * and multi-day scheduling
 */
async function scheduleWorkOrderOnDate(
  workOrder,
  mo,
  startDate,
  durationMinutes,
  colorCode,
  userId,
) {
  try {
    let currentDate = new Date(startDate);
    currentDate.setHours(0, 0, 0, 0);

    let remainingMinutes = durationMinutes;
    let scheduledStartTime = null;
    let scheduledEndTime = null;
    const scheduleIds = [];
    const scheduledSegments = [];
    let daysSpanned = 0;

    // Get work order operations for more precise scheduling
    const operations = workOrder.operations || [];

    // Calculate operations time distribution
    const operationTimes = operations.map((op) => ({
      operationType: op.operationType,
      plannedSeconds: op.plannedTimeSeconds || op.estimatedTimeSeconds || 0,
      plannedMinutes: Math.ceil(
        (op.plannedTimeSeconds || op.estimatedTimeSeconds || 0) / 60,
      ),
    }));

    // Safety limit to prevent infinite loops
    const maxDays = 30;
    let daysProcessed = 0;

    while (remainingMinutes > 0 && daysProcessed < maxDays) {
      daysProcessed++;

      // Get or create schedule for current date
      const schedule = await getOrCreateSchedule(currentDate);

      // Check if day is available
      if (!isDayAvailable(schedule)) {
        // Skip to next day
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Calculate available time for this day
      schedule.calculateAvailableMinutes();
      const scheduledToday = schedule.scheduledMinutes || 0;
      const availableMinutes = schedule.availableMinutes - scheduledToday;

      if (availableMinutes <= 0) {
        // Day is full, move to next day
        currentDate.setDate(currentDate.getDate() + 1);
        continue;
      }

      // Determine start time for this day
      let startTimeForDay;
      if (daysSpanned === 0) {
        // First day - try to start at the requested time
        const requestedTime = new Date(startDate);
        if (
          requestedTime >= new Date(currentDate) &&
          requestedTime <=
            createDateWithTime(currentDate, schedule.workHours.endTime)
        ) {
          startTimeForDay = requestedTime;
        } else {
          // Start at work hours start time
          startTimeForDay = createDateWithTime(
            currentDate,
            schedule.workHours.startTime,
          );
        }
      } else {
        // Continuation day - start at work hours start
        startTimeForDay = createDateWithTime(
          currentDate,
          schedule.workHours.startTime,
        );
      }

      // Adjust start time for breaks and existing schedules
      startTimeForDay = await getAdjustedStartTime(schedule, startTimeForDay);

      // Calculate how much we can schedule today
      const minutesToSchedule = Math.min(remainingMinutes, availableMinutes);

      // Calculate end time with break consideration
      let endTimeForDay = await calculateEndTimeWithBreaks(
        schedule,
        startTimeForDay,
        minutesToSchedule,
      );

      // If end time exceeds work hours, adjust
      const workEndTime = createDateWithTime(
        currentDate,
        schedule.workHours.endTime,
      );
      if (endTimeForDay > workEndTime) {
        endTimeForDay = workEndTime;

        // Recalculate actual minutes that can be scheduled
        const actualMinutes = Math.floor(
          (endTimeForDay - startTimeForDay) / (1000 * 60),
        );

        if (actualMinutes <= 0) {
          // No time available today, move to next day
          currentDate.setDate(currentDate.getDate() + 1);
          continue;
        }

        remainingMinutes -= actualMinutes;
      } else {
        remainingMinutes -= minutesToSchedule;
      }

      // Create scheduled work order segment
      const scheduledSegment = {
        workOrderId: workOrder._id,
        workOrderNumber: workOrder.workOrderNumber,
        manufacturingOrderId: mo._id,
        manufacturingOrderNumber: `MO-${mo.requestId}`,
        stockItemName: workOrder.stockItemId?.name || "Unknown",
        stockItemReference: workOrder.stockItemId?.reference || "",
        quantity: workOrder.quantity,
        scheduledStartTime: startTimeForDay,
        scheduledEndTime: endTimeForDay,
        durationMinutes: Math.floor(
          (endTimeForDay - startTimeForDay) / (1000 * 60),
        ),
        colorCode: colorCode,
        position: schedule.scheduledWorkOrders.length,
        status: "scheduled",
        isMultiDay: remainingMinutes > 0,
        originalScheduleId: daysSpanned === 0 ? schedule._id : scheduleIds[0],
        segmentIndex: daysSpanned,
        dayNumber: daysSpanned + 1,
      };

      // Add to schedule
      schedule.scheduledWorkOrders.push(scheduledSegment);
      schedule.calculateUtilization();

      // Add warning if over capacity
      if (schedule.isOverCapacity) {
        scheduledSegment.exceedsCapacity = true;
        scheduledSegment.warnings = [
          {
            type: "exceeds_day",
            message: `Schedule exceeds day capacity by ${Math.round(schedule.utilizationPercentage - 100)}%`,
            timestamp: new Date(),
          },
        ];
      }

      await schedule.save();

      scheduleIds.push(schedule._id);
      scheduledSegments.push(scheduledSegment);

      // Set overall start and end times
      if (daysSpanned === 0) {
        scheduledStartTime = startTimeForDay;
      }
      scheduledEndTime = endTimeForDay;

      daysSpanned++;

      // Move to next day if needed
      if (remainingMinutes > 0) {
        currentDate.setDate(currentDate.getDate() + 1);
      }
    }

    if (remainingMinutes > 0) {
      // Roll back all scheduled segments
      for (const scheduleId of scheduleIds) {
        const schedule = await ProductionSchedule.findById(scheduleId);
        if (schedule) {
          schedule.scheduledWorkOrders = schedule.scheduledWorkOrders.filter(
            (wo) =>
              !scheduledSegments.find(
                (s) => s._id?.toString() === wo._id?.toString(),
              ),
          );
          schedule.calculateUtilization();
          await schedule.save();
        }
      }

      return {
        success: false,
        message: `Could not fully schedule work order. ${remainingMinutes} minutes remaining after ${maxDays} days.`,
        scheduledSegments: [],
      };
    }

    return {
      success: true,
      scheduledStartTime,
      scheduledEndTime,
      daysSpanned,
      scheduleIds,
      scheduledSegments,
    };
  } catch (error) {
    console.error("Error in enhanced scheduleWorkOrderOnDate:", error);
    return {
      success: false,
      message: error.message,
      scheduledSegments: [],
    };
  }
}

/**
 * Check if day is available for scheduling
 */
function isDayAvailable(schedule) {
  if (schedule.isHoliday) return false;
  if (!schedule.workHours.isActive) return false;

  const dayOfWeek = new Date(schedule.date).getDay();
  if (dayOfWeek === 0 && !schedule.isSundayOverride) return false;

  return true;
}

/**
 * Get adjusted start time considering breaks and existing schedules
 */
async function getAdjustedStartTime(schedule, proposedStartTime) {
  let adjustedTime = new Date(proposedStartTime);

  // Check if time is during a break
  if (schedule.isDuringBreak(adjustedTime)) {
    adjustedTime = schedule.getNextAvailableTime(adjustedTime);
  }

  // Check for overlap with existing schedules
  const workStartTime = createDateWithTime(
    schedule.date,
    schedule.workHours.startTime,
  );
  const workEndTime = createDateWithTime(
    schedule.date,
    schedule.workHours.endTime,
  );

  if (adjustedTime < workStartTime) {
    adjustedTime = new Date(workStartTime);
  }

  if (adjustedTime >= workEndTime) {
    // No time available today
    return null;
  }

  // Check for conflicts with existing schedules
  const existingSchedules = schedule.scheduledWorkOrders || [];
  for (const existing of existingSchedules) {
    const existingStart = new Date(existing.scheduledStartTime);
    const existingEnd = new Date(existing.scheduledEndTime);

    if (adjustedTime >= existingStart && adjustedTime < existingEnd) {
      // Move to after this schedule
      adjustedTime = new Date(existingEnd);

      // Check if we're in a break after moving
      if (schedule.isDuringBreak(adjustedTime)) {
        adjustedTime = schedule.getNextAvailableTime(adjustedTime);
      }
    }
  }

  return adjustedTime;
}

module.exports = mongoose.model("ProductionSchedule", productionScheduleSchema);
