// models/Access/ChangeRequest.js
//
// An edit that is WAITING for someone to approve it.
//
// DepartmentRole already answers "may you change this". It cannot express the
// thing every department actually asks for next: "yes, but not on your own".
// An editor should be able to do the work — fill the form, get the details
// right — without the change taking effect until an approver or the owner has
// looked at it.
//
// HELD, NOT APPLIED-THEN-REVERSED
// -------------------------------
// The obvious cheap version is to let the write land and record that it needs
// blessing, then undo it if it is refused. That is wrong for this domain: a
// purchase order that briefly existed has already been read by the store, an
// approved-then-reverted price has already been quoted to a customer, and
// "undo" for a create is a delete that leaves a hole in a sequence. So nothing
// is written until the decision is made. Until then the change exists only
// here.
//
// HOW THE CHANGE IS REPLAYED
// --------------------------
// `intent` stores the HTTP write exactly as it arrived — method, path, body.
// On approval the server replays it against its own API, over loopback, as the
// ORIGINAL requester, carrying a one-shot header that tells the approval
// middleware to let it through this time. Replaying the real request through
// the real route is the whole point: the route's own validation, side effects
// and change-logging all run, so an approved change is indistinguishable from
// one an approver had typed themselves. Reimplementing each write a second
// time inside an "apply" function is how these systems drift.
//
// The body is capped: a held request is a queue entry, not a blob store. A
// write whose body does not fit is refused at hold time rather than silently
// truncated and replayed as something different from what was submitted.

"use strict";

const mongoose = require("mongoose");

/** Beyond this a body is refused rather than stored — see the note above. */
const MAX_BODY_BYTES = 256 * 1024;

const actorSchema = new mongoose.Schema(
  {
    id: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true },
    name: { type: String, default: "" },

    /* THE ROLE THE REQUESTER HELD WHEN THEY ASKED.
       Load-bearing, not descriptive: the approval replays the change as this
       person, and the routes it replays into check the role — PUT
       /api/employees/:id wants "hr_manager". Without this the replay had to
       invent one from the department slug ("hr"), which those routes reject,
       so every approval of an employee edit died as "Permission denied" no
       matter who approved it.

       Stored rather than looked up at approval time because it is the role
       they actually had at submission — the thing the approver is agreeing to
       — and it stays right even if their role changes while the request
       waits. */
    role: { type: String, default: "" },
    userType: { type: String, default: "" },
  },
  { _id: false },
);

const changeRequestSchema = new mongoose.Schema(
  {
    // Which department's approvers may decide this. Slug, not id, so the entry
    // stays readable after a department is renamed — same reasoning as ChangeLog.
    departmentSlug: { type: String, required: true, index: true, lowercase: true, trim: true },

    // Which page it was submitted from — the same key ChangeLog stores, so a
    // page's history can show "sent for approval" beside the changes that
    // actually landed. Resolved from the request path by
    // services/auditSections, because the guard that holds a change is mounted
    // above every route and never learns which one it was headed for.
    section: { type: String, default: "", index: true },
    sectionLabel: { type: String, default: "" },

    entity: { type: String, required: true, index: true },
    entityId: { type: String, default: "", index: true },
    // What a human recognises without opening the record.
    entityLabel: { type: String, default: "" },

    action: {
      type: String,
      enum: ["create", "update", "delete", "other"],
      default: "update",
      index: true,
    },

    // One line, written for the approver — not for a log reader.
    summary: { type: String, default: "" },
    // Field-level detail when the caller could work it out. Optional: for a
    // create there is nothing to compare against.
    changes: [
      {
        _id: false,
        // The human label, which is what the approval card prints.
        field: String,
        // The machine path it came from ("address.city"), kept alongside the
        // label because this list is replayed into the change log when the
        // submission and the decision are recorded, and a log keyed on a
        // display string cannot be searched for a field. Mongoose strict mode
        // drops anything not declared here, so both have to be named.
        path: String,
        label: String,
        from: mongoose.Schema.Types.Mixed,
        to: mongoose.Schema.Types.Mixed,
      },
    ],

    /** The held write, replayed verbatim on approval. */
    intent: {
      method: { type: String, default: "POST" },
      // Path only, including the query string. Never an absolute URL: the
      // replay must target this server, and taking the host from stored data
      // would let a held request point the replay somewhere else.
      path: { type: String, default: "" },
      body: { type: mongoose.Schema.Types.Mixed },
      contentType: { type: String, default: "application/json" },
    },

    /* pending  — waiting for a decision
       applying — claimed by one approver, replay in flight. A transient state,
                  and the reason it exists is that the replay is an HTTP round
                  trip: without a claim, two approvers pressing Approve at the
                  same moment both read "pending" and both replay, applying the
                  same change twice.
       approved — replayed and landed
       rejected — declined
       failed   — approved by a person, but the replay did not land. NOT
                  terminal: the cause is usually fixable, and Approve retries
                  it. It used to be terminal, so an owner whose first attempt
                  failed was told "this request has already been failed"
                  forever after. */
    status: {
      type: String,
      enum: ["pending", "applying", "approved", "rejected", "failed"],
      default: "pending",
      index: true,
    },

    requestedBy: { type: actorSchema, default: () => ({}) },
    decidedBy: { type: actorSchema, default: () => ({}) },
    decidedAt: { type: Date },
    decisionNote: { type: String, default: "" },

    // Set only when an APPROVED request could not be replayed — the record the
    // approver needs in order to understand why their approval did nothing.
    applyError: { type: String, default: "" },
    appliedAt: { type: Date },
  },
  { timestamps: true, collection: "change_requests" },
);

// The approver's queue: pending items for one department, newest first.
changeRequestSchema.index({ departmentSlug: 1, status: 1, createdAt: -1 });
// "What is outstanding on this record?", asked by every detail page that wants
// to warn an editor their previous change is still waiting.
changeRequestSchema.index({ entity: 1, entityId: 1, status: 1 });

module.exports =
  mongoose.models.ChangeRequest ||
  mongoose.model("ChangeRequest", changeRequestSchema, "change_requests");

module.exports.MAX_BODY_BYTES = MAX_BODY_BYTES;
