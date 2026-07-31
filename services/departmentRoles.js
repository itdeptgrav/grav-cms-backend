// services/departmentRoles.js
//
// One vocabulary of roles for every department, behind one API.
//
// Accounting is the exception underneath, and only underneath. Its module reads
// `Acc_User` on every request and has done since before this existed; writing a
// DepartmentRole row for it would create a second answer to the same question,
// and the two would disagree the first time somebody edited one directly. So
// this service reads and writes Acc_User for the accountant slug and
// DepartmentRole for everything else. Callers do not know or care — they ask
// for "the role this person holds in this department" and get one answer.

"use strict";

const DepartmentRole = require("../models/Access/DepartmentRole");
const { ROLES, ROLE_KEYS, roleAtLeast } = DepartmentRole;

const ACCOUNTING = "accountant";

/* ------------------------------------------------------------------ */
/* Reading                                                             */
/* ------------------------------------------------------------------ */

/**
 * The role this email holds in this department, or null.
 *
 * Never throws for an unknown department: a department with no roles assigned
 * yet is the normal state for the eleven that have just gained the feature, and
 * a guard that explodes on it would take those dashboards down.
 */
async function getRole(departmentSlug, email) {
  const slug = String(departmentSlug || "").toLowerCase().trim();
  const mail = String(email || "").toLowerCase().trim();
  if (!slug || !mail) return null;

  if (slug === ACCOUNTING) {
    const { findAccountantUser } = require("./accountantAccess");
    const user = await findAccountantUser(mail);
    return user && user.isActive ? user.role : null;
  }

  const row = await DepartmentRole.findOne({ departmentSlug: slug, email: mail }).lean();
  return row && row.isActive ? row.role : null;
}

/** Everyone holding a role in this department. */
async function listRoles(departmentSlug) {
  const slug = String(departmentSlug || "").toLowerCase().trim();

  if (slug === ACCOUNTING) {
    const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");
    const rows = await Acc_User.find({}).select("name email role isActive").sort({ role: 1, name: 1 }).lean();
    return rows.map((r) => ({
      email: r.email, name: r.name, role: r.role, isActive: r.isActive !== false,
    }));
  }

  const rows = await DepartmentRole.find({ departmentSlug: slug })
    .select("name email role isActive updatedAt")
    .sort({ role: 1, name: 1 })
    .lean();
  return rows.map((r) => ({
    email: r.email, name: r.name, role: r.role, isActive: r.isActive !== false, updatedAt: r.updatedAt,
  }));
}

/* ------------------------------------------------------------------ */
/* Writing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Grant or change a role. `role: null` revokes.
 *
 * @param actor  the administrator doing it, recorded on the row so the change
 *               log and the row itself agree about who is responsible
 */
async function setRole({ departmentSlug, email, name, role, password, actor }) {
  const slug = String(departmentSlug || "").toLowerCase().trim();
  const mail = String(email || "").toLowerCase().trim();
  if (!slug) throw new Error("A department is required");
  if (!mail) throw new Error("An email address is required");
  if (role !== null && !ROLE_KEYS.includes(role)) {
    throw new Error(`Role must be one of: ${ROLE_KEYS.join(", ")}`);
  }

  // Accounting keeps its own store — see the note at the top of this file.
  if (slug === ACCOUNTING) {
    const { setAccountantRole, revokeAccountantRole } = require("./accountantAccess");
    if (role === null) {
      await revokeAccountantRole(mail);
      return { role: null, revoked: true };
    }
    const { user, created } = await setAccountantRole({
      email: mail, name, role, password, actorId: actor?._id,
    });
    return { role: user.role, created };
  }

  if (role === null) {
    const res = await DepartmentRole.findOneAndUpdate(
      { departmentSlug: slug, email: mail },
      { $set: { isActive: false } },
      { new: true },
    );
    return { role: null, revoked: Boolean(res) };
  }

  // Exactly one owner per department, matching how Accounting already behaves.
  // Demote the incumbent rather than letting a second one exist quietly.
  if (role === "owner") {
    await DepartmentRole.updateMany(
      { departmentSlug: slug, role: "owner", email: { $ne: mail } },
      { $set: { role: "approver" } },
    );
  }

  const before = await DepartmentRole.findOne({ departmentSlug: slug, email: mail }).lean();

  const row = await DepartmentRole.findOneAndUpdate(
    { departmentSlug: slug, email: mail },
    {
      $set: {
        role,
        isActive: true,
        ...(name ? { name } : {}),
        grantedBy: actor?._id,
        grantedByEmail: actor?.email || "",
      },
      $setOnInsert: { departmentSlug: slug, email: mail },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  return { role: row.role, created: !before, previous: before?.role || null };
}

/* ------------------------------------------------------------------ */
/* Guarding                                                            */
/* ------------------------------------------------------------------ */

/**
 * Express guard: this route needs at least `required` in `departmentSlug`.
 *
 * FAILS OPEN FOR DEPARTMENTS WITH NO ROLES YET, ON PURPOSE.
 *
 * Eleven departments have never had roles. Turning this on as a hard gate would
 * lock every one of their users out the moment it shipped, before any
 * administrator had a chance to assign anybody. So a department with no role
 * rows at all behaves exactly as it does today, and starts enforcing the moment
 * the first role is granted. That is a deliberate migration decision, not an
 * oversight — remove this once every department has been populated.
 */
function requireDepartmentRole(departmentSlug, required = "editor") {
  return async (req, res, next) => {
    try {
      const email = req.user?.email || req.dept?.email;
      if (!email) {
        return res.status(401).json({ success: false, message: "Not authenticated" });
      }

      const slug = String(departmentSlug || "").toLowerCase();
      const assigned = await listRoles(slug);
      if (assigned.length === 0) return next();   // not yet configured — see above

      const role = await getRole(slug, email);
      if (!role) {
        return res.status(403).json({
          success: false,
          code: "NO_DEPARTMENT_ROLE",
          message: "You have not been given a role in this department yet.",
        });
      }
      if (!roleAtLeast(role, required)) {
        return res.status(403).json({
          success: false,
          code: "INSUFFICIENT_DEPARTMENT_ROLE",
          role,
          requires: required,
          message: `This action needs ${required} access. You are ${role}.`,
        });
      }

      req.departmentRole = role;
      next();
    } catch (err) {
      console.error("[department-roles] guard failed:", err.message);
      res.status(500).json({ success: false, message: "Could not check your access." });
    }
  };
}

module.exports = {
  ROLES,
  ROLE_KEYS,
  roleAtLeast,
  getRole,
  listRoles,
  setRole,
  requireDepartmentRole,
};
