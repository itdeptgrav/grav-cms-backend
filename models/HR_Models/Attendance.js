const mongoose = require("mongoose");

const attendanceSchema = new mongoose.Schema(
    {
        // ── Employee Reference ─────────────────────────────────────────
        employeeId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Employee",
            required: true,
        },
        employeeName: { type: String, required: true },
        biometricId: { type: String },
        department: { type: String },
        designation: { type: String },

        // ── Date & Time ────────────────────────────────────────────────
        date: { type: Date, required: true },      // midnight of the day
        dateString: { type: String, required: true },      // "2025-03-09" for easy querying

        checkIn: { type: Date },
        checkOut: { type: Date },
        checkInTime: { type: String },   // "09:02 AM"
        checkOutTime: { type: String },   // "06:15 PM"

        // ── Duration ───────────────────────────────────────────────────
        workingMinutes: { type: Number, default: 0 },
        breakMinutes: { type: Number, default: 0 },
        overtimeMinutes: { type: Number, default: 0 },
        effectiveMinutes: { type: Number, default: 0 },  // working - break

        // ── Status ─────────────────────────────────────────────────────
        status: {
            type: String,
            enum: [
                "present", "absent", "late", "half_day",
                "on_leave", "holiday", "weekend", "work_from_home", "early_departure",
            ],
            default: "absent",
        },

        // ── Flags ──────────────────────────────────────────────────────
        isLate: { type: Boolean, default: false },
        isEarlyCheckout: { type: Boolean, default: false },
        hasOvertime: { type: Boolean, default: false },
        isManualEntry: { type: Boolean, default: false },

        // ── Shift Info ─────────────────────────────────────────────────
        shiftStart: { type: String, default: "09:00" },
        shiftEnd: { type: String, default: "18:00" },
        lateThresholdMinutes: { type: Number, default: 15 },

        // ── Location / Device ─────────────────────────────────────────
        checkInLocation: { type: String },
        checkOutLocation: { type: String },
        ipAddress: { type: String },

        // ── Notes ─────────────────────────────────────────────────────
        notes: { type: String },
        remarks: { type: String },

        // ── Audit ─────────────────────────────────────────────────────
        markedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
        updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "HRDepartment" },
    },
    { timestamps: true }
);

// ── Parse "HH:MM" → total minutes since midnight ──────────────────────────
function parseHHMM(str) {
    const [h, m] = (str || "09:00").split(":").map(Number);
    return h * 60 + (m || 0);
}

// ── Auto-compute durations & flags before save ────────────────────────────
attendanceSchema.pre("save", function (next) {
    if (this.checkIn && this.checkOut) {
        const diffMs = this.checkOut - this.checkIn;
        const totalMins = Math.round(diffMs / 60000);
        this.workingMinutes = Math.max(0, totalMins);
        this.effectiveMinutes = Math.max(0, totalMins - (this.breakMinutes || 0));

        const shiftEndMins = parseHHMM(this.shiftEnd || "18:00");
        const checkOutMins = this.checkOut.getHours() * 60 + this.checkOut.getMinutes();
        this.overtimeMinutes = Math.max(0, checkOutMins - shiftEndMins);
        this.hasOvertime = this.overtimeMinutes > 0;
        this.isEarlyCheckout = checkOutMins < shiftEndMins - 30;
    }

    if (this.checkIn) {
        const shiftStartMins = parseHHMM(this.shiftStart || "09:00");
        const checkInMins = this.checkIn.getHours() * 60 + this.checkIn.getMinutes();
        this.isLate = checkInMins > shiftStartMins + (this.lateThresholdMinutes || 15);
        if (this.isLate && this.status === "present") this.status = "late";
    }

    next();
});

attendanceSchema.index({ employeeId: 1, dateString: 1 }, { unique: true });
attendanceSchema.index({ dateString: 1 });
attendanceSchema.index({ department: 1, dateString: 1 });
attendanceSchema.index({ status: 1, dateString: 1 });

module.exports = mongoose.model("Attendance", attendanceSchema);