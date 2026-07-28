// models/CMS_Models/Sales/SalesSchedule/SalesSchedule.js
//
// Sales-side planning calendar.
//
// Deliberately a SEPARATE collection from ProductionSchedule even though the
// shape is nearly identical. Sales plans against EVERY manufacturing order and
// work order — including ones production has not accepted yet, and ones that
// are cancelled or already finished — so the two calendars would fight over the
// same documents if they shared a collection. Production owns what the factory
// actually runs; this owns what sales has promised.

const mongoose = require("mongoose");

// Only essential WO reference data is stored — the rest is populated on read.
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
    // True when the work order carried no operation timings and the duration
    // below is a fallback rather than a real estimate. Sales sees work orders
    // that have not been costed yet, so this is common here and never happens
    // on the production calendar.
    isEstimatedDuration: {
      type: Boolean,
      default: false,
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
    // Multi-day tracking
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
  { _id: true, timestamps: true },
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
  { _id: false },
);

const salesScheduleSchema = new mongoose.Schema(
  {
    // Indexed once, below, as a unique index. Declaring `index: true` here as
    // well is what makes mongoose log a duplicate-index warning at boot.
    date: {
      type: Date,
      required: true,
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
    // Sales overriding an HR company holiday for THIS day only. HR owns the
    // holiday calendar and it is applied as a read-time overlay, so without a
    // stored flag the overlay would keep forcing the day closed and the Active
    // Day switch would silently revert on every fetch. Setting this does not
    // change anything on HR's side, nor on the production calendar.
    holidayOverride: {
      type: Boolean,
      default: false,
    },
    // Planned work orders
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
      ref: "Employee",
    },
    modifications: [
      {
        modifiedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "Employee",
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
  },
);

// Indexes
salesScheduleSchema.index({ date: 1 }, { unique: true });
salesScheduleSchema.index({ "scheduledWorkOrders.workOrderId": 1 });
salesScheduleSchema.index({ "scheduledWorkOrders.manufacturingOrderId": 1 });

// Calculate available minutes
salesScheduleSchema.methods.calculateAvailableMinutes = function () {
  // An overridden company holiday is a normal working day for this calendar.
  const closed = this.isHoliday && !this.holidayOverride;

  if (!this.workHours.isActive || closed) {
    this.availableMinutes = 0;
    return 0;
  }

  const totalMinutes = this.workHours.totalMinutes;
  const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
  const breakMinutes = allBreaks.reduce(
    (sum, br) => sum + (br.durationMinutes || 0),
    0,
  );

  this.availableMinutes = Math.max(0, totalMinutes - breakMinutes);
  return this.availableMinutes;
};

// Calculate scheduled minutes
salesScheduleSchema.methods.calculateScheduledMinutes = function () {
  const scheduled = (this.scheduledWorkOrders || []).reduce(
    (sum, wo) => sum + (wo.durationMinutes || 0),
    0,
  );
  this.scheduledMinutes = scheduled;
  return scheduled;
};

// Calculate utilization
salesScheduleSchema.methods.calculateUtilization = function () {
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

salesScheduleSchema.pre("save", function (next) {
  this.calculateUtilization();

  // NOTE: unlike ProductionSchedule, past days are NOT auto-locked here.
  // Sales regularly back-fills a plan for a week that has already started
  // (a late PI, a re-promise after a slip), and auto-locking made those edits
  // silently impossible.

  next();
});

module.exports = mongoose.model("SalesSchedule", salesScheduleSchema);
