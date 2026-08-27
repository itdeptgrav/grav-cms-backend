/**
 * ShiftSwap_section.js — exchange two employees' shifts.
 *
 * Mounted at /hr/shift-swaps (matching /hr/attendance, NOT /api/hr — the
 * attendance router uses the bare prefix and the frontend talks to it
 * that way).
 *
 * WHAT THIS DOES
 * --------------
 * Swaps the `workShift` assignment between two people, then recomputes
 * today's register. That is the whole feature.
 *
 * On the floor, people trade shifts: someone covers a 07:00 start for a
 * colleague with a hospital appointment. Before this, attendance had no idea —
 * the 09:30 person who clocked in at 10:02 to work a 07:00 shift was judged
 * against their OWN shift and shown as 22 minutes late instead of nearly three
 * hours late.
 *
 * WHY A DIRECT EXCHANGE, NOT A SWAP RECORD
 * ----------------------------------------
 * An earlier version kept a ShiftSwap collection with effective dates, an end
 * action and a history table. It was more machinery than the problem needs:
 * attendance already judges everyone by the shift on their employee record, so
 * exchanging those two values makes the register correct with no second source
 * of truth to keep in step. Swapping back is just running the exchange again.
 *
 * PUNCHES ARE NEVER TOUCHED
 * -------------------------
 * A biometric punch belongs to whoever's finger touched the reader. This
 * endpoint changes only which shift those punches are measured against, so the
 * register can never disagree with the device log.
 *
 * THE ONE CONSEQUENCE WORTH KNOWING
 * ---------------------------------
 * `Employee.workShift` carries no effective-date range, so it describes the
 * present, not history. Recomputing a PAST day after an exchange will judge
 * that day by the new shifts. The hourly cron only ever syncs today, so this
 * surfaces only if someone force-resyncs an older date from the daily screen.
 */

"use strict";
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const EmployeeAuthMiddlewear = require("../../Middlewear/EmployeeAuthMiddlewear");
const attendanceRouter = require("./Attendance_section");
const { recordChange } = require("../../services/changeLog");
const ChangeLog = require("../../models/Access/ChangeLog");

// Reused from the attendance router rather than re-derived here. Employee
// documents are not uniformly shaped — names sit at the top level as
// firstName/lastName on most records and under basicInfo/personalInfo on
// others. A hand-rolled extractor that only checked `name`/`fullName` found
// nothing on any real record and returned an empty employee list.
const {
  extractName,
  extractBiometricId,
  extractDepartment,
  extractDesignation,
} = attendanceRouter;

const istToday = () => {
  const n = new Date(Date.now() + 330 * 60 * 1000);
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, "0")}-${String(n.getUTCDate()).padStart(2, "0")}`;
};

/**
 * The shift a person is on, in the shape the picker shows.
 *
 * Reads `workShift` directly rather than through `resolveShift`, because this
 * is what gets EXCHANGED — the stored assignment, not the resolved answer.
 * Resolving would bake a department-inferred fallback into the record and
 * quietly convert an unset shift into a fixed one.
 */
function shiftOf(emp) {
  const ws = emp?.workShift || {};
  return {
    mode: ws.mode || null,
    start: ws.start || null,
    end: ws.end || null,
    punches: ws.punches ?? null,
  };
}

/** Human label for the audit trail and the response. */
function shiftLabel(ws) {
  if (!ws?.mode) return "unset";
  if (ws.mode === "custom") return `custom ${ws.start || "?"}–${ws.end || "?"}`;
  return ws.mode;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /employees — everyone pickable, with the shift they are on now.
//
// The picker shows each person's hours because the whole point of the choice
// is which hours are being traded; hiding them behind a second lookup would
// make it a guess.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/employees", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    // No .select() — the name extractor reads a dozen possible paths and a
    // projection that misses the one a given record uses silently yields a
    // nameless employee. A few hundred documents is cheaper than that bug.
    const employees = await Employee.find({
      $and: [
        { $or: [{ isActive: { $exists: false } }, { isActive: true }] },
        {
          $or: [{ status: { $exists: false } }, { status: { $ne: "inactive" } }],
        },
      ],
    }).lean();

    const out = employees
      .map((e) => {
        const bid = String(extractBiometricId(e) || "").toUpperCase();
        // Never drop somebody for having no resolvable name — fall back to
        // the biometric ID so they stay pickable and the gap is visible.
        return {
          _id: e._id,
          name: extractName(e) || bid || "Unnamed employee",
          biometricId: bid,
          department: extractDepartment(e) || "",
          designation: extractDesignation(e) || "",
          shift: shiftOf(e),
          hasBiometricId: !!bid,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    res.json({ success: true, employees: out, count: out.length });
  } catch (e) {
    console.error("[shift-swap] employees:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /exchange — trade two employees' shifts, then recompute today.
//
// body: { employeeAId, employeeBId }
// ─────────────────────────────────────────────────────────────────────────────
router.post("/exchange", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const { employeeAId, employeeBId } = req.body || {};
    if (!employeeAId || !employeeBId)
      return res
        .status(400)
        .json({ success: false, message: "Both employees are required" });
    if (String(employeeAId) === String(employeeBId))
      return res.status(400).json({
        success: false,
        message: "An employee cannot swap shifts with themselves",
      });
    for (const id of [employeeAId, employeeBId])
      if (!mongoose.Types.ObjectId.isValid(String(id)))
        return res.status(400).json({
          success: false,
          message: `"${id}" is not a valid employee id`,
        });

    const [a, b] = await Promise.all([
      Employee.findById(employeeAId),
      Employee.findById(employeeBId),
    ]);
    if (!a || !b)
      return res
        .status(404)
        .json({ success: false, message: "Employee not found" });

    const beforeA = shiftOf(a);
    const beforeB = shiftOf(b);

    if (!beforeA.mode && !beforeB.mode)
      return res.status(400).json({
        success: false,
        message:
          "Neither employee has a shift assigned, so there is nothing to exchange. Set their Work Shift on the employee form first.",
      });

    // Snapshot before writing: assigning a.workShift to b and then reading
    // a.workShift back would hand both of them the same shift.
    a.workShift = { ...beforeB };
    b.workShift = { ...beforeA };
    // `shift` is a legacy display-only label derived from the same answer;
    // leaving it stale would make the employee list disagree with the
    // register about who works when.
    const legacyA = a.shift;
    a.shift = b.shift ?? legacyA;
    b.shift = legacyA;

    await Promise.all([a.save(), b.save()]);

    const nameA = extractName(a) || String(a.biometricId || "");
    const nameB = extractName(b) || String(b.biometricId || "");

    // Recompute today so the register reflects the exchange immediately rather
    // than at the next hourly tick. Force, because the plain path
    // short-circuits over days whose punches are already complete — exactly
    // the case when a swap is recorded late in the shift.
    const dateStr = istToday();
    let resync = { dateStr, ok: true };
    try {
      await attendanceRouter.syncDayForce(dateStr);
    } catch (e) {
      // A resync failure must not undo the exchange — the shift assignment is
      // the record of fact and the hourly cron will catch up. Report it so HR
      // knows the grid may lag.
      console.error(`[shift-swap] resync ${dateStr} failed:`, e.message);
      resync = { dateStr, ok: false, error: e.message };
    }

    try {
      await recordChange(req, {
        departmentSlug: "hr",
        entity: "shift-swap",
        entityId: String(a._id),
        action: "update",
        summary: `Swapped shifts: ${nameA} ${shiftLabel(beforeA)} → ${shiftLabel(beforeB)}, ${nameB} ${shiftLabel(beforeB)} → ${shiftLabel(beforeA)}`,
        // The pair rides along on the log entry so the dialog can offer
        // "these two again" without a second collection to maintain. The
        // audit trail already records every swap; this just makes it
        // queryable as data rather than only readable as a sentence.
        after: {
          employeeAId: String(a._id),
          employeeBId: String(b._id),
          employeeAName: nameA,
          employeeBName: nameB,
        },
      });
    } catch {
      /* the audit trail must never fail the write */
    }

    res.json({
      success: true,
      resync,
      result: {
        a: { _id: a._id, name: nameA, before: beforeA, after: shiftOf(a) },
        b: { _id: b._id, name: nameB, before: beforeB, after: shiftOf(b) },
      },
    });
  } catch (e) {
    console.error("[shift-swap] exchange:", e);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /recent — the pairs swapped most recently.
//
// Swapping back is by far the most common next action: someone covers a shift
// on Monday and it goes back on Tuesday. Re-finding both people in a list of
// several hundred to undo what you just did is the kind of friction that gets
// a feature abandoned, so the last few pairs are offered as one click.
//
// Read from the audit trail rather than from a dedicated collection — every
// swap is already recorded there, and a second store would be one more thing
// to keep in step for no extra information.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/recent", EmployeeAuthMiddlewear, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 5, 20);

    const logs = await ChangeLog.find({
      entity: "shift-swap",
      "after.employeeAId": { $exists: true },
    })
      .sort({ createdAt: -1 })
      .limit(60) // read wide, dedupe down — the same pair often swaps repeatedly
      .lean();

    // Unordered pair: swapping A↔B and later B↔A is the same two people, and
    // offering both as separate suggestions would fill the list with one
    // relationship.
    const seen = new Set();
    const pairs = [];
    for (const l of logs) {
      const a = String(l.after?.employeeAId || "");
      const b = String(l.after?.employeeBId || "");
      if (!a || !b) continue;
      const key = [a, b].sort().join("|");
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, at: l.createdAt });
      if (pairs.length >= limit) break;
    }
    if (!pairs.length) return res.json({ success: true, recent: [] });

    // Resolve names and CURRENT shifts fresh. The names on the log entry are
    // a snapshot from swap time; someone may have been renamed, and the shifts
    // have certainly moved since — showing stale hours would make the
    // suggestion actively misleading about what clicking it does.
    const ids = [...new Set(pairs.flatMap((p) => [p.a, p.b]))].filter((id) =>
      mongoose.Types.ObjectId.isValid(id),
    );
    const emps = await Employee.find({ _id: { $in: ids } }).lean();
    const byId = new Map(emps.map((e) => [String(e._id), e]));

    const recent = pairs
      .map((p) => {
        const ea = byId.get(p.a);
        const eb = byId.get(p.b);
        // Drop a pair whose people no longer exist rather than rendering a
        // suggestion that fails the moment it is clicked.
        if (!ea || !eb) return null;
        const shape = (e) => ({
          _id: e._id,
          name: extractName(e) || String(e.biometricId || ""),
          biometricId: String(extractBiometricId(e) || "").toUpperCase(),
          department: extractDepartment(e) || "",
          shift: shiftOf(e),
        });
        return { a: shape(ea), b: shape(eb), at: p.at };
      })
      .filter(Boolean);

    res.json({ success: true, recent });
  } catch (e) {
    console.error("[shift-swap] recent:", e);
    // A missing suggestion list must never break the dialog — it is a
    // convenience, and the pickers work without it.
    res.json({ success: true, recent: [] });
  }
});

module.exports = router;
