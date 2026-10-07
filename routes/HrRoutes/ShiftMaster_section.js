"use strict";
/**
 * routes/HrRoutes/ShiftMaster_section.js — HR › Attendance › Shift Management.
 *
 * Mounted at /api/hr/attendance/shifts. The page has shipped calling these
 * four routes, and none of them existed: the HR contract refused the
 * undeclared path for everybody, so the page said "Reading the shift master is
 * a separate permission" to the HR owner and the CEO alike (found by
 * scripts/pageSweep.js, 6 Oct 2026).
 *
 * These are named shift DEFINITIONS (name, code, hours, break, working days,
 * colour) in the `shifts` collection. They do not change how attendance is
 * judged — that still reads the operator / executive / custom timings in
 * Attendance Settings — so saving one here cannot move anybody's status.
 */

const express = require("express");
const mongoose = require("mongoose");
const router = express.Router();
const EmployeeAuthMiddleware = require("../../Middlewear/EmployeeAuthMiddlewear");

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const shiftSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true },
    startTime: { type: String, required: true, match: TIME },
    endTime: { type: String, required: true, match: TIME },
    breakMins: { type: Number, default: 60, min: 0, max: 600 },
    workingDays: { type: [Number], default: [1, 2, 3, 4, 5, 6] },
    color: { type: String, default: "#8b5cf6" },
    isDefault: { type: Boolean, default: false },
    createdBy: String,
    updatedBy: String,
  },
  { timestamps: true, collection: "shifts" },
);
const Shift = mongoose.models.HrShift || mongoose.model("HrShift", shiftSchema);

/** Only the fields a person may set; anything else in the body is ignored. */
function pick(body = {}) {
  const out = {};
  for (const k of ["name", "code", "startTime", "endTime", "color"]) if (body[k] !== undefined) out[k] = String(body[k]).trim();
  if (body.breakMins !== undefined) out.breakMins = Number(body.breakMins);
  if (Array.isArray(body.workingDays)) out.workingDays = [...new Set(body.workingDays.map(Number).filter((d) => d >= 0 && d <= 6))].sort();
  if (body.isDefault !== undefined) out.isDefault = Boolean(body.isDefault);
  return out;
}
const who = (req) => req.user?.name || req.user?.email || "HR";
const bad = (res, message) => res.status(400).json({ success: false, message });

router.get("/", EmployeeAuthMiddleware, async (req, res) => {
  const data = await Shift.find({}).sort({ isDefault: -1, name: 1 }).lean();
  res.json({ success: true, data });
});

router.post("/", EmployeeAuthMiddleware, async (req, res) => {
  const fields = pick(req.body);
  if (!fields.name || !fields.code) return bad(res, "Name and code are required.");
  if (await Shift.exists({ code: fields.code.toUpperCase() })) return bad(res, `A shift with code ${fields.code.toUpperCase()} already exists.`);
  try {
    if (fields.isDefault) await Shift.updateMany({}, { $set: { isDefault: false } });
    const doc = await Shift.create({ ...fields, createdBy: who(req), updatedBy: who(req) });
    res.status(201).json({ success: true, data: doc });
  } catch (err) {
    if (err.name === "ValidationError") return bad(res, "Check the times (HH:MM) and the break.");
    throw err;
  }
});

router.put("/:id", EmployeeAuthMiddleware, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Shift not found." });
  const fields = pick(req.body);
  if (fields.code && (await Shift.exists({ code: fields.code.toUpperCase(), _id: { $ne: req.params.id } }))) {
    return bad(res, `A shift with code ${fields.code.toUpperCase()} already exists.`);
  }
  try {
    if (fields.isDefault) await Shift.updateMany({ _id: { $ne: req.params.id } }, { $set: { isDefault: false } });
    const doc = await Shift.findByIdAndUpdate(req.params.id, { $set: { ...fields, updatedBy: who(req) } }, { new: true, runValidators: true });
    if (!doc) return res.status(404).json({ success: false, message: "Shift not found." });
    res.json({ success: true, data: doc });
  } catch (err) {
    if (err.name === "ValidationError") return bad(res, "Check the times (HH:MM) and the break.");
    throw err;
  }
});

router.delete("/:id", EmployeeAuthMiddleware, async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ success: false, message: "Shift not found." });
  const doc = await Shift.findByIdAndDelete(req.params.id);
  if (!doc) return res.status(404).json({ success: false, message: "Shift not found." });
  res.json({ success: true });
});

module.exports = router;
