const mongoose = require("mongoose");

const breakSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  startTime: {
    type: String,
    required: true
  },
  endTime: {
    type: String,
    required: true
  },
  durationMinutes: {
    type: Number,
    min: 0
  },
  isFixed: {
    type: Boolean,
    default: false
  }
}, { _id: true });

const scheduledWorkOrderSchema = new mongoose.Schema({
  workOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "WorkOrder",
    required: true
  },
  workOrderNumber: {
    type: String,
    required: true,
    trim: true
  },
  manufacturingOrderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "CustomerRequest",
    required: true
  },
  manufacturingOrderNumber: {
    type: String,
    required: true,
    trim: true
  },
  stockItemName: {
    type: String,
    trim: true
  },
  quantity: {
    type: Number,
    min: 1
  },
  scheduledStartTime: {
    type: Date,
    required: true
  },
  scheduledEndTime: {
    type: Date,
    required: true
  },
  durationMinutes: {
    type: Number,
    min: 0,
    required: true
  },
  colorCode: {
    type: String,
    default: "#3B82F6"
  },
  priority: {
    type: String,
    enum: ["low", "medium", "high", "urgent"],
    default: "medium"
  },
  status: {
    type: String,
    enum: ["scheduled", "in_progress", "completed", "delayed", "cancelled"],
    default: "scheduled"
  },
  assignedTo: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProductionManager"
  },
  notes: {
    type: String,
    trim: true
  },
  actualStartTime: {
    type: Date
  },
  actualEndTime: {
    type: Date
  }
}, { timestamps: true });

const productionScheduleSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true,
    unique: true
  },
  // Flexible work hours
  workHours: {
    startTime: {
      type: String,
      default: "09:30"
    },
    endTime: {
      type: String,
      default: "18:30"
    },
    totalMinutes: {
      type: Number,
      default: 540 // 9 hours
    },
    isActive: {
      type: Boolean,
      default: true
    },
    customHours: {
      type: Boolean,
      default: false
    }
  },
  // Breaks configuration
  breaks: [breakSchema],
  // Default breaks (fixed)
  defaultBreaks: [{
    name: {
      type: String,
      default: "Lunch Break"
    },
    startTime: {
      type: String,
      default: "13:00"
    },
    endTime: {
      type: String,
      default: "13:45"
    },
    durationMinutes: {
      type: Number,
      default: 45
    },
    isFixed: {
      type: Boolean,
      default: true
    }
  }, {
    name: {
      type: String,
      default: "Evening Tea Break"
    },
    startTime: {
      type: String,
      default: "17:00"
    },
    endTime: {
      type: String,
      default: "17:15"
    },
    durationMinutes: {
      type: Number,
      default: 15
    },
    isFixed: {
      type: Boolean,
      default: true
    }
  }],
  scheduledWorkOrders: [scheduledWorkOrderSchema],
  totalScheduledMinutes: {
    type: Number,
    default: 0
  },
  availableMinutes: {
    type: Number,
    default: 540
  },
  utilizationPercentage: {
    type: Number,
    default: 0
  },
  isHoliday: {
    type: Boolean,
    default: false
  },
  holidayReason: {
    type: String,
    trim: true
  },
  isSundayOverride: {
    type: Boolean,
    default: false
  },
  overrideSettings: {
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProductionManager"
    },
    at: {
      type: Date
    },
    reason: {
      type: String,
      trim: true
    }
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProductionManager",
    required: true
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "ProductionManager"
  }
}, { timestamps: true });

// FIXED: Pre-save middleware to calculate totals
productionScheduleSchema.pre("save", function(next) {
    // Calculate total break minutes
    const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
    const totalBreakMinutes = allBreaks.reduce((total, br) => {
        return total + (br.durationMinutes || this.calculateBreakMinutes(br));
    }, 0);
    
    // Calculate work minutes
    this.workHours.totalMinutes = this.calculateWorkMinutes();
    this.availableMinutes = Math.max(0, this.workHours.totalMinutes - totalBreakMinutes);
    
    // Calculate total scheduled minutes
    this.totalScheduledMinutes = this.scheduledWorkOrders.reduce(
        (total, wo) => total + wo.durationMinutes, 0
    );
    
    // Calculate utilization percentage (excluding breaks)
    if (this.availableMinutes > 0) {
        this.utilizationPercentage = Math.min(
            100,
            (this.totalScheduledMinutes / this.availableMinutes) * 100
        );
    }
    
    // FIXED: Handle Sunday override logic properly
    const dayOfWeek = this.date.getUTCDay();
    const isSunday = dayOfWeek === 0;
    
    if (isSunday) {
        if (this.isSundayOverride) {
            // Sunday override enabled - make it a working day
            this.isHoliday = false;
            this.workHours.isActive = true;
            if (this.holidayReason === "Sunday - Day Off") {
                this.holidayReason = "";
            }
        } else {
            // Sunday override disabled - holiday
            this.isHoliday = true;
            this.workHours.isActive = false;
            if (!this.holidayReason) {
                this.holidayReason = "Sunday - Day Off";
            }
        }
    } else {
        // Non-Sunday days
        if (this.isHoliday) {
            this.workHours.isActive = false;
        }
    }
    
});

// Instance method to calculate work minutes
productionScheduleSchema.methods.calculateWorkMinutes = function() {
    if (!this.workHours.isActive) return 0;
    
    const startTime = this.workHours.startTime || "09:30";
    const endTime = this.workHours.endTime || "18:30";
    
    const [startHour, startMinute] = startTime.split(":").map(Number);
    const [endHour, endMinute] = endTime.split(":").map(Number);
    
    const startTotal = startHour * 60 + startMinute;
    const endTotal = endHour * 60 + endMinute;
    
    return Math.max(0, endTotal - startTotal);
};

// Instance method to calculate break minutes
productionScheduleSchema.methods.calculateBreakMinutes = function(breakItem) {
    const [startHour, startMinute] = breakItem.startTime.split(":").map(Number);
    const [endHour, endMinute] = breakItem.endTime.split(":").map(Number);
    
    const startTotal = startHour * 60 + startMinute;
    const endTotal = endHour * 60 + endMinute;
    
    return Math.max(0, endTotal - startTotal);
};

// Method to get effective available minutes for scheduling
productionScheduleSchema.methods.getEffectiveAvailableMinutes = function() {
    if (!this.workHours.isActive) return 0;
    
    const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
    const totalBreakMinutes = allBreaks.reduce((total, br) => {
        return total + (br.durationMinutes || this.calculateBreakMinutes(br));
    }, 0);
    
    return Math.max(0, this.workHours.totalMinutes - totalBreakMinutes);
};

// Method to check if time slot is available (considering breaks)
productionScheduleSchema.methods.isTimeSlotAvailable = function(startTime, endTime, excludeWorkOrderId = null) {
    if (!this.workHours.isActive) return false;
    
    const allBreaks = [...(this.defaultBreaks || []), ...(this.breaks || [])];
    const requestedStart = new Date(startTime);
    const requestedEnd = new Date(endTime);
    const requestedDate = new Date(requestedStart.toDateString());
    
    // Check if within work hours
    const workStart = new Date(requestedDate);
    const [workStartHour, workStartMinute] = this.workHours.startTime.split(":").map(Number);
    workStart.setHours(workStartHour, workStartMinute, 0, 0);
    
    const workEnd = new Date(requestedDate);
    const [workEndHour, workEndMinute] = this.workHours.endTime.split(":").map(Number);
    workEnd.setHours(workEndHour, workEndMinute, 0, 0);
    
    if (requestedStart < workStart || requestedEnd > workEnd) {
        return false;
    }
    
    // Check for break conflicts
    for (const breakItem of allBreaks) {
        const breakStart = new Date(requestedDate);
        const [breakStartHour, breakStartMinute] = breakItem.startTime.split(":").map(Number);
        breakStart.setHours(breakStartHour, breakStartMinute, 0, 0);
        
        const breakEnd = new Date(requestedDate);
        const [breakEndHour, breakEndMinute] = breakItem.endTime.split(":").map(Number);
        breakEnd.setHours(breakEndHour, breakEndMinute, 0, 0);
        
        // Check if requested time overlaps with break
        if (
            (requestedStart < breakEnd && requestedEnd > breakStart) ||
            (requestedStart >= breakStart && requestedStart < breakEnd) ||
            (requestedEnd > breakStart && requestedEnd <= breakEnd)
        ) {
            return false;
        }
    }
    
    // Check for existing work order conflicts
    for (const wo of this.scheduledWorkOrders) {
        if (excludeWorkOrderId && wo._id.toString() === excludeWorkOrderId.toString()) {
            continue;
        }
        
        const woStart = new Date(wo.scheduledStartTime);
        const woEnd = new Date(wo.scheduledEndTime);
        
        if (
            (requestedStart < woEnd && requestedEnd > woStart) ||
            (requestedStart >= woStart && requestedStart < woEnd) ||
            (requestedEnd > woStart && requestedEnd <= woEnd)
        ) {
            return false;
        }
    }
    
    return true;
};

// Index for efficient date queries
productionScheduleSchema.index({ date: 1 });
productionScheduleSchema.index({ "scheduledWorkOrders.workOrderId": 1 });

module.exports = mongoose.model("ProductionSchedule", productionScheduleSchema);