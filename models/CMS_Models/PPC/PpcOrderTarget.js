// models/CMS_Models/PPC/PpcOrderTarget.js
//
// A PIECE-COMPLETION TARGET PPC SETS FOR ONE DEPARTMENT ON ONE ORDER.
//
// "Cutting: 300 pieces a day from Mon to Thu on MO-REQ-2026-0002." The target
// is against the WHOLE manufacturing order (its total quantity), never a work
// order — an explicit request (24 Sep 2026). The department's own screen then
// shows the target beside what it actually did, counted from that
// department's existing records (services/ppc/orderTargets.service.js); the
// ACTUAL is never typed in anywhere.
//
// THREE SHAPES, because a target is set in whichever way the floor thinks:
//   per_day   N pieces every day, from → to (optionally only between two clock
//             times)
//   per_hour  N pieces every hour between two clock times, on each day from → to
//   total     N pieces in total by a date; the expected pace is spread evenly
//             over the days from → to
// A one-off "this many by 4 pm today" is `per_day` with from = to and hours set.
//
// ONE ACTIVE TARGET PER ORDER AND DEPARTMENT. Setting a new one replaces the
// old, which is kept with status "replaced" — a target the floor was shown
// happened, and the history must be able to say so. Nothing is ever deleted.
//
// This is deliberately NOT the planning-file stage schedule
// (PpcStageSchedule / PpcStagePublication): those are dated commitments
// derived from a frozen IE route on a Sales line. This is the daily number
// the floor is asked for, set directly on the order.
"use strict";

const mongoose = require("mongoose");

const DEPARTMENTS = Object.freeze([
  "cutting", "embroidery", "printing", "washing", "trimming", "ironing",
  "production", "qc", "packaging", "dispatch",
]);
const KINDS = Object.freeze(["per_day", "per_hour", "total"]);
const STATUS = Object.freeze(["active", "replaced", "cancelled"]);

const dayKey = { type: String, required: true, trim: true, validate: { validator: (v) => /^\d{4}-\d{2}-\d{2}$/.test(v), message: "A date is YYYY-MM-DD." } };
const clock = { type: String, trim: true, default: "", validate: { validator: (v) => v === "" || /^\d{2}:\d{2}$/.test(v), message: "A time is HH:MM." } };

const actorSchema = new mongoose.Schema({
  userId: { type: String, trim: true, default: "" },
  name: { type: String, trim: true, default: "" },
  email: { type: String, trim: true, lowercase: true, default: "" },
}, { _id: false });

const ppcOrderTargetSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    manufacturingOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "CustomerRequest", required: true, index: true },
    moNumber: { type: String, trim: true, default: "" },
    customerName: { type: String, trim: true, default: "" },
    /* The order's total quantity when the target was set — what "the whole
       order" meant at the time, so a later work-order split cannot rewrite
       what was asked. */
    orderQuantity: { type: Number, default: 0, min: 0 },

    department: { type: String, enum: DEPARTMENTS, required: true, index: true },
    kind: { type: String, enum: KINDS, required: true },
    pieces: { type: Number, required: true, min: 1 },
    from: dayKey,
    to: dayKey,
    hoursFrom: clock,
    hoursTo: clock,
    /* Which weekdays count. Default every day; a target "Mon–Sat" leaves
       Sunday out of the expected pace. 0 = Sunday … 6 = Saturday. */
    workingDays: { type: [Number], default: () => [0, 1, 2, 3, 4, 5, 6] },
    note: { type: String, trim: true, default: "", maxlength: 500 },
    /* IE's standard and the feasibility check as they stood when this was
       set — so a later change to the standard cannot rewrite what PPC was
       told at the time. */
    assessment: { type: mongoose.Schema.Types.Mixed, default: null },

    status: { type: String, enum: STATUS, default: "active", index: true },
    assignedBy: { type: actorSchema, default: () => ({}) },
    assignedAt: { type: Date, default: Date.now },
    replacedById: { type: mongoose.Schema.Types.ObjectId, default: null },
    endedAt: { type: Date, default: null },
    endedBy: { type: actorSchema, default: null },
    endReason: { type: String, trim: true, default: "" },
  },
  { timestamps: true, collection: "ppc_order_targets" },
);

ppcOrderTargetSchema.index({ department: 1, status: 1, from: 1, to: 1 });
ppcOrderTargetSchema.index({ manufacturingOrderId: 1, department: 1, status: 1 });

module.exports = mongoose.model("PpcOrderTarget", ppcOrderTargetSchema);
module.exports.DEPARTMENTS = DEPARTMENTS;
module.exports.KINDS = KINDS;
module.exports.STATUS = STATUS;
