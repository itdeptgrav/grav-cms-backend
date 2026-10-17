// models/CMS_Models/FollowUps/FollowUp.js
//
// ONE THING ONE DEPARTMENT IS WAITING ON ANOTHER FOR (9 Oct 2026).
//
// The production manager (PPC), Merchandising and Design (R&D) had no shared
// follow-up: each portal saw only its own queue, the hand-offs between them
// were one-way emails, and nothing waiting on somebody had a name, a date or a
// reminder. A follow-up is that missing object:
//
//   - it is ABOUT a record (a style in development, or a manufacturing order)
//     or about nothing in particular (`subject.type: "none"`);
//   - it is OWNED by a named person in a department (the owner's choice: never
//     "the department" alone). An automatic one whose person cannot be worked
//     out is saved with `needsPerson` and shown to the whole department until
//     somebody picks — losing the follow-up would be worse than an empty name;
//   - it has a due date, a status and a thread.
//
// Status: open (waiting on the assignee) → answered (waiting on whoever raised
// it to accept) → closed. The raiser can reopen. A follow-up the SYSTEM raised
// at a hand-off closes itself when the awaited thing happens (`openKey`).
//
// The rules (who may do what, which view a row is in, overdue) are in
// services/followUps/followUpRules.js, with no database, and tested there.
"use strict";

const mongoose = require("mongoose");

const personSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    kind: { type: String, default: "" }, // "employee" | "deptUser" | ""
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
  },
  { _id: false },
);

const actorSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    name: { type: String, trim: true, default: "" },
    email: { type: String, trim: true, lowercase: true, default: "" },
    dept: { type: String, default: "" },
    system: { type: Boolean, default: false },
  },
  { _id: false },
);

const entrySchema = new mongoose.Schema(
  {
    at: { type: Date, default: Date.now },
    by: { type: actorSchema, default: () => ({}) },
    // comment | answer | close | reopen | reassign | due | system | create
    kind: { type: String, default: "comment" },
    text: { type: String, trim: true, default: "" },
    from: { type: String, default: "" },
    to: { type: String, default: "" },
  },
  { _id: true },
);

const followUpSchema = new mongoose.Schema(
  {
    seq: { type: Number, required: true, unique: true },
    number: { type: String, required: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    detail: { type: String, trim: true, default: "", maxlength: 4000 },

    // "manual", or one of the automatic kinds in followUpRules.AUTO_KINDS.
    kind: { type: String, default: "manual", index: true },
    // Set ONLY while an automatic follow-up is not closed, so a hand-off that
    // fires twice finds the open one instead of raising a second. Unset on
    // close (sparse unique index below), so the same hand-off can raise again
    // later — a tech sheet sent back for changes is a new follow-up.
    openKey: { type: String, default: undefined },

    subject: {
      type: { type: String, enum: ["style", "order", "none"], default: "none" },
      id: { type: String, default: "" },
      label: { type: String, trim: true, default: "" },
      code: { type: String, trim: true, default: "" },
    },

    fromDept: { type: String, required: true },
    toDept: { type: String, required: true, index: true },
    assignee: { type: personSchema, default: () => ({}) },
    needsPerson: { type: Boolean, default: false },
    raisedBy: { type: actorSchema, default: () => ({}) },

    dueAt: { type: Date, default: null },
    priority: { type: String, enum: ["normal", "urgent"], default: "normal" },
    status: { type: String, enum: ["open", "answered", "closed"], default: "open", index: true },

    thread: { type: [entrySchema], default: [] },
    lastActivityAt: { type: Date, default: Date.now },
    answeredAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    closedBy: { type: actorSchema, default: undefined },

    // The day (IST, YYYY-MM-DD) this follow-up last went out in the morning
    // reminder, so a restart cannot send the same reminder twice.
    remindedOn: { type: String, default: "" },
  },
  { timestamps: true, collection: "followups" },
);

followUpSchema.index({ openKey: 1 }, { unique: true, sparse: true });
followUpSchema.index({ "subject.type": 1, "subject.id": 1, status: 1 });
followUpSchema.index({ "assignee.email": 1, status: 1 });
followUpSchema.index({ "raisedBy.email": 1, status: 1 });
followUpSchema.index({ status: 1, dueAt: 1 });

module.exports = mongoose.models.FollowUp || mongoose.model("FollowUp", followUpSchema);
