"use strict";

/**
 * Somebody taken off the attendance register for a month, and kept off it.
 *
 * WHY THIS EXISTS
 * ---------------
 * "Remove from month" used to be a single `$pull` of that person's rows from
 * whatever days had already been written. It deleted what existed at that
 * instant and remembered nothing, so it failed in the one situation it is
 * actually used for: somebody leaves, HR removes them, and the next biometric
 * sync writes their rows straight back. On this database all five removals
 * performed on 2 Sep 2026 reported "0 day record(s) deleted" — the month was
 * two days old and their rows had not been written yet — and every one of
 * those five had September rows again within a fortnight.
 *
 * A removal is a statement about the ROLL ("this person was not with us in
 * September"), not about the rows that happen to exist when the button is
 * pressed. So it is stored, and the sync, the daily register and the muster
 * roll all read it. Deleting the rows still happens; it is now the
 * consequence of the record rather than the whole of it.
 *
 * SCOPED PER MONTH, deliberately. It mirrors the action HR actually performs
 * — the button removes somebody from one month — and it is what makes the
 * requirement work: excluded from September, still on August's sheet, because
 * August is a different record and they really were here in August.
 *
 * REVERSIBLE. `DELETE /attendance/remove-from-month` creates one of these,
 * `POST /attendance/restore-to-month` deletes it; the days themselves come
 * back on the next sync of that month.
 */

const mongoose = require("mongoose");

const attendanceExclusionSchema = new mongoose.Schema(
  {
    // Always upper-cased by the route. Attendance rows key on biometricId
    // rather than the employee _id (a device knows nothing about Mongo), and
    // matching those rows is the whole job of this record.
    biometricId: { type: String, required: true, uppercase: true, trim: true },

    // "YYYY-MM", the same field the day documents carry, so an exclusion can
    // be matched against a day without parsing its date.
    yearMonth: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}$/,
    },

    // Copied at the time of removal so the audit view can name the person
    // even after the employee record is deleted or renamed.
    employeeName: { type: String, default: "" },

    removedAt: { type: Date, default: Date.now },
    removedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    removedByName: { type: String, default: "" },
    reason: { type: String, default: "" },

    // How many rows the removal actually deleted. Zero is normal and is not a
    // failure — it means the month had not been synced for this person yet,
    // which is precisely the case the old behaviour got wrong.
    daysRemovedAtTime: { type: Number, default: 0 },
  },
  { timestamps: true },
);

// One record per person per month. `remove-from-month` upserts on this, so
// pressing the button twice is not an error and does not duplicate.
attendanceExclusionSchema.index({ biometricId: 1, yearMonth: 1 }, { unique: true });
// The read every consumer performs: "who is off the roll for these months?"
attendanceExclusionSchema.index({ yearMonth: 1 });

module.exports =
  mongoose.models.AttendanceExclusion ||
  mongoose.model("AttendanceExclusion", attendanceExclusionSchema);
