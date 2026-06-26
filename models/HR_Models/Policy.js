// models/HR_Models/Policy.js
// ─────────────────────────────────────────────────────────────────────────────
// Compliance Policy model.
//
// A "Policy" is an HR-defined rule that, when violated, deducts SOP points
// from an employee. Policies are either GLOBAL (apply to every employee) or
// DEPARTMENT-scoped (apply only to one department).
//
// `points` is the magnitude of the deduction (always stored POSITIVE). When a
// violation is applied it becomes a "credit" bleach in Employee.sopPoints,
// which INCREASES totalDeducted — i.e. the same sign convention already used
// for C1/C2/C3. The C4 doc writes deductions as "-3"; that minus sign is just
// magnitude — here it lives as points: 3.
//
// `triggerKey` lets the attendance-suggestion engine auto-detect violations:
//   absent_no_notice  → DailyAttendance entry effective status === "AB"
//   late_arrival      → isLate && lateMins      > thresholdMins
//   early_departure   → isEarlyDeparture && earlyDepartureMins > thresholdMins
//   manual            → no auto-detection; HR applies this policy by hand
//
// Registered model name: "Policy"  (Employee.sopPoints.bleaches[].policyId → ref "Policy")
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const TRIGGER_KEYS = [
  "absent_no_notice",
  "late_arrival",
  "early_departure",
  "manual",
];

const policySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: "" },

    // This module is attendance/compliance-focused and is HARD-LOCKED to the
    // C4 category. HR cannot pick C1/C2/C3 — the route forces "C4" on every
    // write and this enum rejects anything else even on a direct API call.
    category: { type: String, trim: true, default: "C4", enum: ["C4"] },

    // Magnitude of the point change. Always stored POSITIVE; the direction
    // comes from bleachType below.
    points: { type: Number, required: true, min: 0, default: 0 },

    // ── Direction ──────────────────────────────────────────────────────────
    // "credit" = PENALTY → applying it INCREASES the employee's totalDeducted
    //            (penalty score goes up = bad). This is the default so every
    //            attendance policy and every pre-existing policy stays a penalty.
    // "debit"  = REWARD  → applying it DECREASES totalDeducted (score improves).
    //            Rewards cannot be auto-detected from attendance, so a reward
    //            policy is always triggerKey:"manual" and is applied by hand.
    bleachType: {
      type: String,
      enum: ["credit", "debit"],
      default: "credit",
    },

    // ── Scope ──────────────────────────────────────────────────────────────
    scope: {
      type: String,
      enum: ["global", "department"],
      default: "global",
    },
    departmentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Department",
      default: null,
    },
    // Department NAME is denormalised here because DailyAttendance stores the
    // department as a name string — suggestion matching is done by name.
    departmentName: { type: String, default: "" },

    // ── Attendance auto-trigger ────────────────────────────────────────────
    triggerKey: {
      type: String,
      enum: TRIGGER_KEYS,
      default: "manual",
    },
    // Only meaningful for late_arrival / early_departure. "Violation when the
    // employee is late / leaves early by MORE than this many minutes."
    thresholdMins: { type: Number, default: 15 },

    isActive: { type: Boolean, default: true },

    // Audit
    createdByName: { type: String, default: "HR Manager" },
    createdByRole: { type: String, default: "hr_manager" },
  },
  { timestamps: true },
);

policySchema.index({ scope: 1, departmentName: 1 });
policySchema.index({ triggerKey: 1, isActive: 1 });

module.exports = mongoose.model("Policy", policySchema);
module.exports.TRIGGER_KEYS = TRIGGER_KEYS;
