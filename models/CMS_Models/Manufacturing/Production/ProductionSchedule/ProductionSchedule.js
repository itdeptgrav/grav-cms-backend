// models/CMS_Models/Manufacturing/Production/ProductionSchedule.js

const mongoose = require("mongoose");

// SIMPLIFIED: Only store essential WO reference data
const scheduledWorkOrderSchema = new mongoose.Schema(
  {
    workOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "WorkOrder",
      required: true,
    },
    manufacturingOrderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "CustomerRequest",
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
    // Visual tracking
    colorCode: {
      type: String,
      default: "#3B82F6",
    },
    position: {
      type: Number,
      default: 0,
    },
    // Status
    status: {
      type: String,
      enum: ["scheduled", "in_progress", "completed", "delayed", "cancelled"],
      default: "scheduled",
    },
    // Multi-day tracking - FIXED: Track span info
    isMultiDay: {
      type: Boolean,
      default: false,
    },
    totalDaysSpanned: {
      type: Number,
      default: 1,
    },
    currentDayNumber: {
      type: Number,
      default: 1,
    },
    // Alerts
    exceedsCapacity: {
      type: Boolean,
      default: false,
    },
  },
  { _id: true, timestamps: true }
);

// Break configuration schema
const breakConfigSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    startTime: {
      type: String,
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
      default: true,
    },
  },
  { _id: true }
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
      default: 540,
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
  { _id: false }
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
    defaultBreaks: [breakConfigSchema],
    breaks: [breakConfigSchema],
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
      default: false,
    },
    isSaturdayOverride: {
      type: Boolean,
      default: false,
    },
    // Scheduled work orders - SIMPLIFIED
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
    },
    isOverCapacity: {
      type: Boolean,
      default: false,
    },
    // Audit
    isLocked: {
      type: Boolean,
      default: false,
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
  }
);

// Indexes
productionScheduleSchema.index({ date: 1 }, { unique: true });
productionScheduleSchema.index({ "scheduledWorkOrders.workOrderId": 1 });
productionScheduleSchema.index({
  "scheduledWorkOrders.manufacturingOrderId": 1,
});

// Calculate available minutes
productionScheduleSchema.methods.calculateAvailableMinutes = function () {
  if (!this.workHours.isActive || this.isHoliday) {
    this.availableMinutes = 0;
    return 0;
  }

  let totalMinutes = this.workHours.totalMinutes;
  const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
  const breakMinutes = allBreaks.reduce(
    (sum, br) => sum + (br.durationMinutes || 0),
    0
  );

  this.availableMinutes = Math.max(0, totalMinutes - breakMinutes);
  return this.availableMinutes;
};

// Calculate scheduled minutes
productionScheduleSchema.methods.calculateScheduledMinutes = function () {
  const scheduled = (this.scheduledWorkOrders || []).reduce(
    (sum, wo) => sum + (wo.durationMinutes || 0),
    0
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

// Pre-save middleware
productionScheduleSchema.pre("save", function (next) {
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

module.exports = mongoose.model("ProductionSchedule", productionScheduleSchema);