// services/requests/departmentStaffRecord.js
//
// A STAFF RECORD FOR A LOGIN THAT IS A PERSON BUT SIGNS IN AS A DEPARTMENT.
//
// ── THE PROBLEM THIS SOLVES ─────────────────────────────────────────────────
// Not every login in this CMS sits on a row in `employees`. The CEO signs in
// through the legacy `ceodepartments` collection; so do several older
// department accounts. The requests desk resolved those logins to a STAND-IN
// — a read-only shape carrying the department and nothing personal — and then
// refused every write with "Raising a request has to be done by a member of
// staff, and this login is a department account with no staff record."
//
// That sentence was true and useless. The CEO IS a member of staff. What was
// missing was not a permission but a row.
//
// ── WHY A ROW RATHER THAN A LOOSER SCHEMA ───────────────────────────────────
// Three collections hold a REQUIRED ref into `employees` for the person who
// asked — `IntakeRequest.requestedBy`, `MRF.requestedFor`,
// `SpendRequest.requestedBy` — and perhaps twenty screens, the approval chain,
// the "my requests" list, withdraw-ownership and the MRF/spend spawn all read
// through them. Making all three optional would push a null check into every
// one of those readers, and the ones that were missed would fail as a deleted
// employee rather than as an error.
//
// Writing the row instead keeps every one of those refs valid and unchanged.
// It is the same move `Middlewear/coworkAuth.js` already makes for a `ceo`
// claim with no Firestore document (auto-provisioned as `E000`).
//
// ── WHAT IS AND IS NOT INVENTED ─────────────────────────────────────────────
// Only what the session already proves: the badge the token was issued with,
// the name and email on it, and the department it was issued for. No salary,
// no manager, no joining date, no password — this record is an identity, not
// an employment file. `isDepartmentAccount` marks it so HR can see at a glance
// that it was raised by a sign-in and still wants filling in.
//
// A login with no badge (`employeeId`) gets nothing: there would be no stable
// key to find the row by again, and the next sign-in would make a second one.
// Those logins keep the stand-in and keep the refusal.

const mongoose = require("mongoose");
const Employee = require("../../models/Employee");

/** The fields every caller of `requester()` selects. One list, one place. */
const SELECT =
  "_id firstName middleName lastName name email department biometricId identityId " +
  "primaryManager accessDepartmentId additionalDepartmentIds isActive status isDepartmentAccount";

/** First word / rest, so "Chief Executive Officer" is not all one firstName. */
function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/**
 * The department this session was issued for, when it is a real, live one.
 *
 * Looked up rather than taken from the token so the record says "Executive
 * Office" and not "ceo".
 */
async function departmentOf(deptId) {
  if (!deptId || !mongoose.isValidObjectId(deptId)) return null;
  const dept = await mongoose.connection
    .collection("access_departments")
    .findOne({ _id: new mongoose.Types.ObjectId(String(deptId)) })
    .catch(() => null);
  if (!dept || dept.isActive === false) return null;
  return dept;
}

/**
 * Find — or, once, create — the staff record behind a department login.
 *
 * Returns a lean employee document, or null when this login has nothing
 * stable to key one on (no badge, or no live department grant). Idempotent:
 * the create is an upsert on the badge, so two requests racing on a first
 * sign-in end up with one row, not two.
 */
async function ensureStaffRecord(req) {
  const badge = String(req?.user?.employeeId || "").trim();
  if (!badge) return null;

  const dept = await departmentOf(req?.user?.deptId);
  if (!dept) return null;

  const email = String(req?.user?.email || "").trim().toLowerCase();
  const { firstName, lastName } = splitName(req?.user?.name || dept.name);

  /* `$setOnInsert` only: a record somebody has since filled in by hand must
     never be flattened back to what the token happens to carry. The one thing
     kept current is the access grant, because that is the session's own fact
     and a department move has to reach the desk. */
  await Employee.updateOne(
    { $or: [{ biometricId: badge }, { identityId: badge }] },
    {
      $setOnInsert: {
        biometricId: badge,
        identityId: badge,
        firstName,
        lastName,
        ...(email ? { email } : {}),
        department: dept.name || "",
        designation: req?.user?.name || dept.name || "",
        isActive: true,
        status: "active",
        /* Raised by a sign-in, not by HR. Says so, rather than looking like a
           half-finished onboarding nobody can explain. */
        isDepartmentAccount: true,
      },
      $set: { accessDepartmentId: dept._id },
    },
    { upsert: true },
  );

  return Employee.findOne({ $or: [{ biometricId: badge }, { identityId: badge }] })
    .select(SELECT)
    .lean();
}

module.exports = { ensureStaffRecord, SELECT };
