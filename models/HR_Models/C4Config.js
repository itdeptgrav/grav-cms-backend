// models/HR_Models/C4Config.js
// ─────────────────────────────────────────────────────────────────────────────
// C4 — ATTENDANCE SCORING CONFIG (singleton) — POINTS-WISE.
//
// No percentages, no working-day math. Every value is a flat point amount:
//   • basePointsPerDay      → REWARD earned for each day present & on time
//                             (credited automatically by the always-on
//                              presence engine)
//   • lateArrivalPoints     → flat deduction per late instance
//   • absencePoints         → flat deduction per absent (AB) day
//   • earlyDeparturePoints  → flat deduction per early-departure instance
//
// These are the PRE-SAVED values the policy form auto-fills from when HR picks
// an attendance trigger — HR selects the rule, the points come pre-filled.
// ─────────────────────────────────────────────────────────────────────────────

const mongoose = require("mongoose");

const c4ConfigSchema = new mongoose.Schema({
  // ── Reward ────────────────────────────────────────────────────────────────
  // Flat points earned per working day present & on time. The presence engine
  // is ALWAYS ON — it credits this automatically (hourly, 7-day lookback).
  basePointsPerDay: { type: Number, default: 1, min: 0 },

  // ── Penalties — FLAT POINTS ───────────────────────────────────────────────
  lateArrivalPoints: { type: Number, default: 1, min: 0 }, // per instance
  absencePoints: { type: Number, default: 3, min: 0 }, // per day
  earlyDeparturePoints: { type: Number, default: 1, min: 0 }, // per instance

  // ── Thresholds ────────────────────────────────────────────────────────────
  lateThresholdMins: { type: Number, default: 15, min: 0 },
  earlyThresholdMins: { type: Number, default: 0, min: 0 },

  // Effective statuses that do NOT count as a working day (week-offs etc).
  nonWorkingStatuses: { type: [String], default: ["WO"] },

  // Throttle stamp for the lazy presence pass (runs at most once per hour,
  // claimed atomically so concurrent requests can't double-run).
  lastPresenceRunAt: { type: Date, default: () => new Date(0) },

  updatedByName: { type: String, default: "" },
  updatedByRole: { type: String, default: "" },
  updatedAt: { type: Date, default: Date.now },
});

// Always operate on one config document.
c4ConfigSchema.statics.getSingleton = async function () {
  let doc = await this.findOne();
  if (!doc) doc = await this.create({});
  return doc;
};

module.exports = mongoose.model("C4Config", c4ConfigSchema);
