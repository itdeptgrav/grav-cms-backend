"use strict";
/**
 * services/employeeDeparture.js — what "this person has left" does to everything
 * that still points at them.
 *
 * Deactivating an employee already ends their sessions (the HR contract's
 * revocation) and keeps them out of attendance sheets once they stop punching.
 * It did NOT detach them from anything else, so a person who had left went on:
 *
 *   • being somebody's manager — RANI TUDU's secondary manager was still
 *     PRADEEP PRADHAN, inactive, so her requests were routed to him;
 *   • holding up requests — two of her regularizations sat in
 *     `manager_approved` waiting on a manager who can no longer sign in, and
 *     nobody else could move them;
 *   • holding application access — ARIJIT PANI, inactive, still had an active
 *     Store approver grant, listed on Users & Roles as if he could approve.
 *
 * This is the one routine that undoes all three. Nothing is deleted: the
 * employee record stays exactly as it was (status inactive), every grant is
 * deactivated rather than removed, and every request keeps the chain it had —
 * the departed manager is only taken off what is still WAITING. HR can always
 * see who has left and what they did; nothing current points at them.
 *
 * Idempotent: running it on somebody already detached changes nothing. It is
 * called from the employee update and bulk-update routes when a record turns
 * inactive, and once from scripts to clear what predates it.
 */

const OPEN = {
  leaveapplications: ["pending", "manager_approved", "withdraw_pending"],
  regularizationrequests: ["pending", "manager_approved"],
  overtimereports: ["pending", "manager_approved"],
};

/* Only people still working here lose the manager. On a FORMER employee's
   record, who they reported to is history, and HR's Inactive list should
   still show it — the first run of this cleared it on six people who had
   left and it had to be put back. */
const STILL_HERE = { isActive: { $ne: false }, status: { $ne: "inactive" } };

/** The same rule `onStaff` uses in the attendance routes. */
function hasLeft(employee) {
  return Boolean(employee) && (employee.isActive === false || employee.status === "inactive");
}

/**
 * @param {object} db         a connected mongodb Db (mongoose.connection.db)
 * @param {object} employee   the departed employee ({ _id, email, firstName, … })
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false]  report, write nothing
 * @param {string}  [opts.by]            who deactivated them, for the record
 * @returns {Promise<object>} what was (or would be) changed
 */
async function detachDepartedEmployee(db, employee, { dryRun = false, by = "" } = {}) {
  const id = employee._id;
  /* Stored ids are ObjectIds in some collections and strings in others. */
  const anyId = { $in: [id, String(id)] };
  const name = `${employee.firstName || ""} ${employee.lastName || ""}`.trim();
  const out = { employee: `${name} (${employee.biometricId || ""})`, reports: [], departments: [], requests: [], grants: [] };
  const now = new Date();

  /* ── 1. Nobody reports to somebody who has left ───────────────────────── */
  for (const slot of ["primaryManager", "secondaryManager"]) {
    const reports = await db
      .collection("employees")
      .find({ [`${slot}.managerId`]: anyId, ...STILL_HERE }, { projection: { firstName: 1, lastName: 1, biometricId: 1 } })
      .toArray();
    for (const r of reports) out.reports.push(`${r.firstName} ${r.lastName || ""} (${r.biometricId}) · ${slot}`.replace(/\s+·/, " ·"));
    if (!dryRun && reports.length) {
      await db.collection("employees").updateMany(
        { [`${slot}.managerId`]: anyId, ...STILL_HERE },
        { $set: { [slot]: { managerId: null, managerName: "" }, updatedAt: now } },
      );
    }
  }

  /* ── 2. No department hands new joiners to them ─────────────────────── */
  for (const slot of ["primaryManager", "secondaryManager"]) {
    const depts = await db.collection("departments").find({ [`${slot}.managerId`]: anyId }, { projection: { name: 1 } }).toArray();
    for (const d of depts) out.departments.push(`${d.name} · ${slot}`);
    if (!dryRun && depts.length) {
      await db.collection("departments").updateMany(
        { [`${slot}.managerId`]: anyId },
        { $set: { [`${slot}.managerId`]: null, [`${slot}.managerName`]: "", [`${slot}.designation`]: "" } },
      );
    }
  }

  /* ── 3. Nothing still WAITING is waiting on them ─────────────────────────
     Only open requests, and only their entry in `managersNotified`; a
     decision they already made stays in `managerDecisions` and the history.
     What happens next follows from the routes as they are: a request whose
     remaining approver was them now has no manager step left, so HR decides
     it from the HR pages (both HR approve routes accept `pending` and
     `manager_approved`). It is NOT approved on anybody's behalf. */
  for (const [col, statuses] of Object.entries(OPEN)) {
    const rows = await db
      .collection(col)
      .find({ status: { $in: statuses }, "managersNotified.managerId": anyId }, { projection: { employeeName: 1, status: 1, dateStr: 1, fromDate: 1 } })
      .toArray();
    for (const r of rows) out.requests.push(`${col.replace(/s$/, "")} · ${r.employeeName} · ${r.dateStr || r.fromDate} · ${r.status}`);
    if (!dryRun && rows.length) {
      await db.collection(col).updateMany(
        { _id: { $in: rows.map((r) => r._id) } },
        {
          $pull: { managersNotified: { managerId: anyId } },
          $set: {
            updatedAt: now,
            departedManagerNote: `${name} left the company; their approval step was removed${by ? ` by ${by}` : ""} on ${now.toISOString().slice(0, 10)}. HR decides what remains.`,
          },
        },
      );
    }
  }

  /* ── 4. No application access ────────────────────────────────────────── */
  const email = String(employee.email || "").toLowerCase();
  if (email) {
    const grants = await db
      .collection("department_roles")
      .find({ email, isActive: true }, { projection: { departmentSlug: 1, role: 1 } })
      .toArray();
    for (const g of grants) out.grants.push(`${g.departmentSlug} · ${g.role}`);
    if (!dryRun && grants.length) {
      await db.collection("department_roles").updateMany(
        { email, isActive: true },
        { $set: { isActive: false, deactivatedAt: now, deactivatedReason: "Employee left the company", updatedAt: now } },
      );
    }
  }

  return out;
}

module.exports = { detachDepartedEmployee, hasLeft };
