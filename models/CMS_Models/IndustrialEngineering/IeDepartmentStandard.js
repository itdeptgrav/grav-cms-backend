// models/CMS_Models/IndustrialEngineering/IeDepartmentStandard.js
//
// A DEPARTMENT'S STANDARD, AS INDUSTRIAL ENGINEERING STATES IT (24 Sep 2026):
// how many minutes one piece takes at this department (its SAM), how many
// people work it, for how many hours a day, and the efficiency IE plans at.
// From those four, and nothing else, the day's capacity follows:
//
//   capacity per day = operators × hours × 60 × efficiency ÷ SAM
//
// PPC reads it when setting a target — "1,200 pieces needs about 4 working
// days here", "this asks 400 a day of a department that does ~260" — and the
// department's overview reads it to show efficiency: earned minutes (pieces ×
// SAM) against the minutes the people were there.
//
// One row per company and department. The per-style technical standard IE
// freezes into a release (processRoute.schema.js) is a different, richer
// thing; this is the floor-level planning figure, and it is deliberately the
// same shape for all ten departments.
"use strict";

const mongoose = require("mongoose");
const { DEPARTMENTS } = require("../PPC/PpcOrderTarget");

const actor = new mongoose.Schema({
  userId: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
}, { _id: false });

const ieDepartmentStandardSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    department: { type: String, enum: DEPARTMENTS, required: true },
    /* Standard Allowed Minutes for ONE piece at this department. */
    samMinutesPerPiece: { type: Number, required: true, min: 0.01, max: 600 },
    operators: { type: Number, required: true, min: 1, max: 2000 },
    hoursPerDay: { type: Number, required: true, min: 0.5, max: 24 },
    efficiencyPct: { type: Number, required: true, min: 1, max: 150, default: 80 },
    notes: { type: String, trim: true, default: "", maxlength: 500 },
    /* HOW THE DEPARTMENT BATCHES ITS WORK (16 Oct 2026, owner: "the
       technicality should come from the IE"). Some departments do not work
       at a rate: a cutting LAY comes off a table whole, a washing LOAD out
       of a machine, an embroidery RUN off the heads — and packing counts in
       CARTONS. IE states the machines (tables), the batch size and the
       minutes a batch takes; PPC's plan for the department is filled from
       these. Which fields a department needs: BATCH_FIELDS in
       departmentStandards.service.js. null = not stated. */
    batch: {
      type: new mongoose.Schema({
        machines: { type: Number, min: 1, max: 200, default: null },
        perBatch: { type: Number, min: 1, max: 20000, default: null },
        minutesPerBatch: { type: Number, min: 1, max: 1440, default: null },
      }, { _id: false }),
      default: null,
    },
    /* The first version of the above, cutting only, written on 16 Oct 2026
       before it was generalised: read as cutting's batch when `batch` is
       absent (batchOf), never written again. */
    cutting: { type: mongoose.Schema.Types.Mixed, default: undefined },
    updatedBy: { type: actor, default: () => ({}) },
    history: {
      type: [new mongoose.Schema({
        at: { type: Date, required: true },
        by: { type: actor, default: () => ({}) },
        samMinutesPerPiece: Number, operators: Number, hoursPerDay: Number, efficiencyPct: Number,
      }, { _id: false })],
      default: [],
    },
  },
  { timestamps: true, collection: "ie_department_standards" },
);

ieDepartmentStandardSchema.index({ companyId: 1, department: 1 }, { unique: true });

module.exports = mongoose.model("IeDepartmentStandard", ieDepartmentStandardSchema);
