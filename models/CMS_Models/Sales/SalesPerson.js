// models/CMS_Models/Sales/SalesPerson.js
//
// WHO ON THE SALES TEAM IS BEING TRACKED, AND BY WHICH PHONE NUMBER.
//
// Explicit request, 30 Aug 2026: "in the setting page, put the input for
// defining the sales person ok, so basically just via dropdown it is needed to
// define ok, so select the employee, describe what he/she is doing/responsible
// for and all... the main moto of this is ki we need to track these sales
// person corporate office phone number from the employee schema ok.. so
// basically only these phone number's need to take reference as an sales
// person's in order to track the call logs, location tracking and all."
//
// THE PROBLEM THIS SOLVES. `models/CallEvent.js` records every call the
// PersonalCallRecorder app reports, but its `phoneNumber` is the OTHER party —
// the customer. Nothing on that document says whose phone made the call, and
// the ingestion route (`routes/callEvents.js`) never accepted such a field. So
// the call log could say "someone at GRAV rang this customer for 4 minutes"
// and never who. Field tracking has the opposite shape: it carries
// `employeeId`/`employeeName` but no phone.
//
// This collection is the join. An admin names the employees who are on sales
// duty; each row snapshots that employee's CORPORATE phone —
// `Employee.workPhone`, which the Employee schema itself describes as "the
// number the company gives them, as opposed to `phone`, which is the personal
// one they log into the app with" — and `normalizedPhone` is the digits-only
// key call events are matched on.
//
// WHY THE PHONE IS SNAPSHOTTED RATHER THAN ALWAYS READ THROUGH THE EMPLOYEE.
// A call that happened in March was made from whatever number that person
// carried in March. If HR reassigns a work number in June, re-reading it live
// would silently re-attribute every historical call to a different person.
// `syncedAt` records when the snapshot was taken, and the settings screen
// offers a re-sync when the two have drifted — an explicit act, not a silent
// rewrite of history.
"use strict";

const mongoose = require("mongoose");

/** Digits only, last 10 kept — the same shape callRecordingMatch.service's
 *  `phoneKey` produces, so a sales person's number and a call event's number
 *  are comparable without either side knowing about the other's formatting
 *  (+91 / 0 / spaces / dashes). */
function normalizePhone(raw) {
  const digits = String(raw || "").replace(/\D+/g, "");
  if (!digits) return "";
  return digits.length > 10 ? digits.slice(-10) : digits;
}

const salesPersonSchema = new mongoose.Schema(
  {
    // The Employee this row is about. `employeeRef` is the Mongo _id;
    // `employeeCode` is the biometric id (GR0108-style) that
    // FieldTrackingSession/FieldLocationPing already key on, so location
    // history can be joined without a second lookup.
    employeeRef: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, unique: true },
    employeeCode: { type: String, default: "", trim: true, index: true },

    // Snapshots, so the log stays readable even if the employee record later
    // changes or is deactivated — see the header on why these are not read
    // live.
    name: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true, lowercase: true },
    department: { type: String, default: "", trim: true },
    designation: { type: String, default: "", trim: true },

    // THE TRACKING KEY. `workPhone` verbatim as displayed; `normalizedPhone`
    // is what every match actually compares.
    workPhone: { type: String, default: "", trim: true },
    normalizedPhone: { type: String, default: "", index: true },

    /** What this person is responsible for — free text, shown next to their
     *  name wherever their calls and routes are listed. The request asked for
     *  it specifically: "describe what he/she is doing/responsible for". */
    responsibility: { type: String, default: "", trim: true, maxlength: 500 },

    /** Inactive keeps the row (and therefore every past attribution) while
     *  taking the person off the current roster. Deleting would orphan the
     *  history this collection exists to preserve. */
    active: { type: Boolean, default: true, index: true },

    syncedAt: { type: Date, default: Date.now },
    addedByEmail: { type: String, default: "", trim: true, lowercase: true },
  },
  { timestamps: true },
);

// Keep the match key in step with the number, however the number was set.
salesPersonSchema.pre("save", function (next) {
  if (this.isModified("workPhone")) this.normalizedPhone = normalizePhone(this.workPhone);
  next();
});

module.exports = {
  SalesPerson: mongoose.models.SalesPerson || mongoose.model("SalesPerson", salesPersonSchema),
  normalizePhone,
};
