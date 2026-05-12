"use strict";
const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
//  Attendancesettings — singleton document (_id = "singleton")
//  All attendance policy configuration lives here.
// ─────────────────────────────────────────────────────────────────────────────

const ShiftSchema = new mongoose.Schema(
  {
    start: { type: String, default: "09:30" },
    end: { type: String, default: "18:30" },
    lateGraceMins: { type: Number, default: 15 },
    halfDayThresholdMins: { type: Number, default: 240 }, // operator=390, executive=450 recommended
    otGraceMins: { type: Number, default: 30 },
  },
  { _id: false },
);

const LateHalfDayPolicySchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },

    // ── NEW COUNT-BASED FIELDS (per HR policy doc) ──────────────────────────
    // 1st, 2nd late → P* (no deduction)
    // Nth late → HD (counter resets) | Nth late → AB (counter resets)
    // Same rule for early departures
    lateHDOnCount: { type: Number, default: 3 }, // 3rd late → HD
    lateFullDayOnCount: { type: Number, default: 5 }, // 5th late → AB
    earlyOutHDOnCount: { type: Number, default: 3 }, // 3rd early-out → HD
    earlyOutFullDayOnCount: { type: Number, default: 5 }, // 5th early-out → AB
    autoDeductCL: { type: Boolean, default: false }, // deduct 0.5 CL on HD promotion

    // Kept for reference / backward compat (no longer used in promotion logic)
    cumulativeLateMinsThreshold: {
      operator: { type: Number, default: 30 },
      executive: { type: Number, default: 40 },
    },
  },
  { _id: false },
);

const GraceCarryForwardSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    triggerMins: { type: Number, default: 60 },
    bonusGraceMins: { type: Number, default: 15 },
    applyTo: {
      type: String,
      default: "both",
      enum: ["both", "operator", "executive"],
    },
  },
  { _id: false },
);

const SinglePunchHandlingSchema = new mongoose.Schema(
  {
    mode: {
      type: String,
      default: "midpoint",
      enum: ["midpoint", "assume-in", "assume-out"],
    },
  },
  { _id: false },
);

const AttendanceSettingsSchema = new mongoose.Schema(
  {
    _id: { type: String, default: "singleton" },

    shifts: {
      operator: {
        type: ShiftSchema,
        default: () => ({
          start: "09:00",
          end: "18:00",
          lateGraceMins: 10,
          halfDayThresholdMins: 390, // 6.5h net work excl. breaks
          otGraceMins: 15,
        }),
      },
      executive: {
        type: ShiftSchema,
        default: () => ({
          start: "09:30",
          end: "18:30",
          lateGraceMins: 15,
          halfDayThresholdMins: 450, // 7.5h total span incl. breaks
          otGraceMins: 30,
        }),
      },
    },

    lateHalfDayPolicy: { type: LateHalfDayPolicySchema, default: () => ({}) },
    graceCarryForward: { type: GraceCarryForwardSchema, default: () => ({}) },
    singlePunchHandling: {
      type: SinglePunchHandlingSchema,
      default: () => ({}),
    },

    // Employee classification
    operatorDepartments: { type: [String], default: [] }, // legacy
    departmentCategories: {
      core: { type: [String], default: [] }, // operator / production
      general: { type: [String], default: [] }, // executive / office
    },
    operatorDesignations: { type: [String], default: [] },
    executiveDesignations: { type: [String], default: [] },

    // UI display labels (status code → display string)
    displayLabels: { type: mongoose.Schema.Types.Mixed, default: {} },
  },
  {
    _id: false,
    timestamps: true,
  },
);

// ─── Static helper: always return the singleton, creating if needed ───────────
AttendanceSettingsSchema.statics.getConfig = async function () {
  let doc = await this.findById("singleton").lean();
  if (!doc) {
    doc = await this.create({ _id: "singleton" });
    doc = doc.toObject();
  }
  // Back-fill new count-based fields if they're missing (DB upgrade path)
  if (doc.lateHalfDayPolicy == null) doc.lateHalfDayPolicy = {};
  if (doc.lateHalfDayPolicy.lateHDOnCount == null)
    doc.lateHalfDayPolicy.lateHDOnCount = 3;
  if (doc.lateHalfDayPolicy.lateFullDayOnCount == null)
    doc.lateHalfDayPolicy.lateFullDayOnCount = 5;
  if (doc.lateHalfDayPolicy.earlyOutHDOnCount == null)
    doc.lateHalfDayPolicy.earlyOutHDOnCount = 3;
  if (doc.lateHalfDayPolicy.earlyOutFullDayOnCount == null)
    doc.lateHalfDayPolicy.earlyOutFullDayOnCount = 5;
  if (doc.lateHalfDayPolicy.autoDeductCL == null)
    doc.lateHalfDayPolicy.autoDeductCL = false;
  // Back-fill half-day thresholds to new defaults if still at old default (240)
  if (doc.shifts?.operator?.halfDayThresholdMins === 240)
    doc.shifts.operator.halfDayThresholdMins = 390;
  if (doc.shifts?.executive?.halfDayThresholdMins === 240)
    doc.shifts.executive.halfDayThresholdMins = 450;
  return doc;
};

const AttendanceSettings =
  mongoose.models.AttendanceSettings ||
  mongoose.model(
    "AttendanceSettings",
    AttendanceSettingsSchema,
    "attendancesettings",
  );

module.exports = AttendanceSettings;
