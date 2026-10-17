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
/* "proposed" (16 Oct 2026, owner: "make the department page the gate of
   confirmation"): a target saved on an ORDER page is a proposal — nothing
   live reads it (every reader asks for "active"). It goes live when PPC takes
   it into the department's plan and saves there ("accepted", the new target
   replacing it), or is "declined" on that page. */
const STATUS = Object.freeze(["active", "replaced", "cancelled", "proposed", "accepted", "declined"]);

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

    /* ── WHAT IT IS ASKED AGAINST (16 Oct 2026) ───────────────────────────
       The whole order, or a named mix of its work orders — the two colours
       that have fabric, the half that is on line 1. ABSENT IS THE ORDER, so
       every target written before this reads exactly as it always did, and
       nothing had to be backfilled. `quantity` is what that scope was worth
       when the target was set, frozen like `orderQuantity` beside it, and
       `label` is how it was described to the person who set it.
       See services/ppc/targetScope.js — including why Dispatch cannot have
       one. */
    scope: {
      kind: { type: String, enum: ["order", "work_orders"], default: "order" },
      workOrderIds: { type: [mongoose.Schema.Types.ObjectId], ref: "WorkOrder", default: [] },
      quantity: { type: Number, default: null },
      count: { type: Number, default: null },
      label: { type: String, trim: true, default: "" },
      detail: { type: String, trim: true, default: "" },
      /* The quantity asked of EACH work order (16 Oct 2026). Present, the
         target's quantity is their sum and progress is read line by line;
         absent, the scope is the work orders above, in full. */
      allocations: {
        type: [new mongoose.Schema({ workOrderId: { type: mongoose.Schema.Types.ObjectId, ref: "WorkOrder" }, quantity: { type: Number, min: 1 } }, { _id: false })],
        default: [],
      },
    },
    /* ── THE CUT ORDER PLAN (16 Oct 2026) — cutting targets only ─────────
       What PPC hands the cutting room: the allowance, the knife's maximum lay
       height, the markers (a size ratio and a length) and the lays (a marker,
       a colour, plies). Stored as it was handed over; the requirement, the
       size balance and the fabric are DERIVED from it and the target's work
       orders every time it is read (services/ppc/cutPlan.js), so a later
       edit to a work order is reflected rather than contradicted.
       Embedded here because the cluster is at its collection cap, and
       because the cut plan IS the cutting target's instruction sheet. */
    cutPlan: {
      type: new mongoose.Schema({
        allowancePct: { type: Number, default: 3 },
        maxPlies: { type: Number, default: 60 },
        endAllowanceCm: { type: Number, default: 3 },
        markers: { type: [new mongoose.Schema({ key: String, name: String, ratio: [new mongoose.Schema({ size: String, count: Number }, { _id: false })], lengthM: Number, widthCm: Number, efficiencyPct: Number }, { _id: false })], default: [] },
        lays: { type: [new mongoose.Schema({ no: Number, markerKey: String, colour: String, plies: Number, date: String, time: String, table: String }, { _id: false })], default: [] },
      }, { _id: false }),
      default: null,
    },
    /* ── THE SHAPE OF IT (16 Oct 2026) ───────────────────────────────────
       `ramp` is the share of the day's number each of the FIRST days asks
       for, as whole percentages — [50, 75] is "half on day one, three
       quarters on day two, the full number from day three". A style new to
       the line does not reach its efficiency on day one, and planning it as
       if it did is how an order is behind on the day it starts.
       `hours` is the day split by hand — `{from, to, pieces}` — for the
       shifts where the hour before lunch is not the hour after it. Both are
       empty by default, which is the flat target every row written before
       this one already was. See services/ppc/targetCurve.js. */
    ramp: { type: [Number], default: [] },
    /* A daily or hourly pace that stops when its quantity is made (16 Oct
       2026): "18 garments at 4 a day" asks 4, 4, 4, 4 and then the 2 that are
       left — never 4 on the fifth day for garments that do not exist. Null is
       a pace with no ceiling, which is every target written before this. */
    cap: { type: Number, default: null, min: 1 },
    /* ── A PLAN BY BATCH, NOT BY RATE (16 Oct 2026, owner: "how will you do
       hour wise — some hours will be 0 and some hour will be boom, because of
       bulk layer cutting") ─────────────────────────────────────────────────
       Cutting does not produce at a pace: a lay is spread and cut for hours
       with nothing finished, then all of its garments are cut at once. So a
       cutting target can carry the lays' own schedule — each lay's garments,
       its date, and the time it is due off the table. A day expects what its
       lays deliver; within the day, nothing is due before a lay's time, and
       the whole lay is due after it. Empty: the target is paced as before. */
    dayPlan: {
      /* workOrderId (16 Oct 2026): the plan is a grid of work order × slot —
         which work order, when, how many — so an entry names its work order. */
      /* layKey (16 Oct 2026): department + day + hour — the same key on
         several orders' targets is ONE lay (load, run) shared by them,
         planned on PPC's department plan. */
      type: [new mongoose.Schema({ date: dayKey, time: clock, workOrderId: { type: String, default: "" }, pieces: { type: Number, min: 0 }, label: { type: String, default: "" }, layKey: { type: String, default: "" } }, { _id: false })],
      default: [],
    },
    /* Where the target was planned: "department" = PPC's department plan
       (all orders on one grid; this target is the order's share of it),
       "" = the order's own plan page or an older screen. */
    planSource: { type: String, enum: ["", "order", "department"], default: "" },
    hours: {
      type: [new mongoose.Schema({ from: clock, to: clock, pieces: { type: Number, min: 0 } }, { _id: false })],
      default: [],
    },
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
