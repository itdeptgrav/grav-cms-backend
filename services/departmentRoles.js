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

/* The standalone Budget app's own slug. Its grant is the only one that carries
   which departments it covers — see DepartmentRole.budgetDepartments. */
const BUDGET = "budget";

/** Slugs, deduped, blanks dropped. An empty list is stored as an empty list:
 *  "granted the app, no departments yet" is a real state the app explains. */
function normaliseBudgetDepartments(value) {
  return [
    ...new Set(
      (Array.isArray(value) ? value : [])
        .map((v) => String(v ?? "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

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

/**
 * The strongest role this PERSON holds, across every address they are known by.
 *
 * ── WHY ONE EMAIL IS NOT ENOUGH ─────────────────────────────────────────────
 * A grant is made against whatever address an administrator typed, and people
 * have more than one: a work address, a personal one, an old domain. When the
 * address on the grant is not the address on the token, the person signs in and
 * the system sees no grant at all — so an approver is treated as an editor and
 * every change they make is held for an approval only they could give.
 *
 * So the lookup tries every identity the request carries — the token's email
 * and the email on their own employee record — and takes the HIGHEST role
 * found. Highest rather than first because holding two grants is common (an
 * editor grant made early, an approver grant added later on a different
 * address) and the answer somebody expects is the better of the two.
 *
 * It will NOT match on name. Two people share a name far more often than they
 * share an address, and quietly granting approver rights to the wrong person is
 * a worse failure than the one this fixes.
 */
async function getEffectiveRole(departmentSlug, req) {
  const slug = String(departmentSlug || "").toLowerCase().trim();
  if (!slug) return null;

  const u = req?.user || req?.admin || req?.dept || {};
  const candidates = new Set();
  const add = (v) => {
    const m = String(v || "").toLowerCase().trim();
    if (m) candidates.add(m);
  };

  add(u.email);

  /* Their own employee record's address — the one a grant is most often made
     against, because that is the address the HR list shows. */
  try {
    if (u.id || u._id || u.employeeId) {
      const Employee = require("../models/Employee");
      const or = [];
      const mongoose = require("mongoose");
      const id = u.id || u._id;
      if (id && mongoose.Types.ObjectId.isValid(String(id))) or.push({ _id: id });
      if (u.employeeId) or.push({ biometricId: String(u.employeeId) });
      if (or.length) {
        const emp = await Employee.findOne({ $or: or }).select("email").lean();
        add(emp?.email);
      }
    }
  } catch {
    /* An identity lookup that fails must not take the guard down with it; the
       token's own email is still tried below. */
  }

  let best = null;
  for (const mail of candidates) {
    const role = await getRole(slug, mail);
    if (role && (!best || roleAtLeast(role, best))) best = role;
  }
  return best;
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
    .select("name email role isActive updatedAt budgetDepartments")
    .sort({ role: 1, name: 1 })
    .lean();
  return rows.map((r) => ({
    email: r.email, name: r.name, role: r.role, isActive: r.isActive !== false, updatedAt: r.updatedAt,
    /* Only ever populated on the Budget grant; the admin screen reads it to
       show which departments a person may submit for. */
    budgetDepartments: r.budgetDepartments || [],
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
async function setRole({ departmentSlug, email, name, role, password, budgetDepartments, actor }) {
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
        /* Only the Budget grant carries departments. Sending them on any other
           slug is ignored rather than refused — one admin route serves every
           department, and a 400 here would make the caller special-case it. */
        ...(slug === BUDGET && budgetDepartments !== undefined
          ? { budgetDepartments: normaliseBudgetDepartments(budgetDepartments) }
          : {}),
        grantedBy: actor?._id,
        grantedByEmail: actor?.email || "",
      },
      $setOnInsert: { departmentSlug: slug, email: mail },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  /* There was a `dropRoleCaches(slug, null)` here, and another on the revoke
     path above. Neither ever existed: nothing in this file, or anywhere in the
     role path, defines or imports it — so every call to setRole threw
     `ReferenceError: dropRoleCaches is not defined`.

     The damage was worse than a failed request. The throw came AFTER the
     database write, so the role change landed and was then reported as an
     error: the caller saw a red banner, the role had actually changed, and
     re-trying looked like it did nothing.

     Removed rather than implemented. `getRole` and `listRoles` read the
     database on every call — there is no cache in front of them to invalidate,
     so a cache-drop here would be a no-op at best. If one is ever added, its
     invalidation belongs next to it, not as an undefined name here. */

  return { role: row.role, created: !before, previous: before?.role || null };
}

/**
 * Follow somebody's email when it changes.
 *
 * WHY THIS HAS TO EXIST
 * ---------------------
 * A role is keyed on an email address, and an email address is editable — by
 * HR, and by the person themselves on their own record. So changing it
 * silently orphans every role that person holds: the row still exists, still
 * says "editor", and matches nobody. They are locked out of the department the
 * moment they save, and the cause is invisible because the role list still
 * looks correct.
 *
 * That is not hypothetical. An HR editor changed their own email from a work
 * address to a personal one and immediately got "Not your department." on every
 * HR screen, with their editor row sitting there pointing at an address no
 * account had any more.
 *
 * Keying on an immutable id instead would be the deeper fix, and is a migration
 * — DepartmentRole rows exist in production keyed on email, and so does the
 * accounting side. Following the change keeps the two in step today without
 * moving anybody's data.
 *
 * Best effort and never fatal: an email change that worked must not fail
 * because the person happened to hold a role.
 *
 * @returns {number} how many access records were moved
 */
async function followEmailChange(oldEmail, newEmail) {
  const from = String(oldEmail || "").toLowerCase().trim();
  const to = String(newEmail || "").toLowerCase().trim();
  if (!from || !to || from === to) return 0;

  let moved = 0;
  try {
    /* Skip any department where the new address ALREADY holds a role — moving
       onto it would collide with the unique (departmentSlug, email) index, and
       which of the two roles should win is a decision, not a rename. */
    const mine = await DepartmentRole.find({ email: from }).select("departmentSlug").lean();
    for (const row of mine) {
      const clash = await DepartmentRole.exists({
        departmentSlug: row.departmentSlug,
        email: to,
      });
      if (clash) continue;
      await DepartmentRole.updateOne(
        { departmentSlug: row.departmentSlug, email: from },
        { $set: { email: to } },
      );
      moved += 1;
    }
  } catch (err) {
    console.warn("[department-roles] could not follow an email change:", err.message);
  }

  /* The accounting module keys on email too, in its own collection. */
  try {
    const { Acc_User } = require("../models/Accountant_model/Acc_OrgModels");
    const clash = await Acc_User.exists({ email: to });
    if (!clash) {
      const res = await Acc_User.updateOne({ email: from }, { $set: { email: to } });
      moved += res.modifiedCount || 0;
    }
  } catch (err) {
    console.warn("[department-roles] could not follow an accounting email:", err.message);
  }

  return moved;
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

      /* A platform administrator is not part of any department's chain.
         `requireApproval` in services/changeRequests.js already lets them
         through (`req.user?.isAdmin || req.admin`); this guard did not, so the
         two disagreed about the same person — an admin could be refused here
         and waved through there depending on which guard a route happened to
         reach first. They now agree. */
      if (req.user?.isAdmin || req.admin) return next();

      const slug = String(departmentSlug || "").toLowerCase();
      const assigned = await listRoles(slug);
      if (assigned.length === 0) return next();   // not yet configured — see above

      /* Every address this person is known by, not just the token's — a grant
         made against their other email is still their grant. */
      const role = await getEffectiveRole(slug, req);
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
  getEffectiveRole,
  ROLES,
  ROLE_KEYS,
  roleAtLeast,
  getRole,
  listRoles,
  setRole,
  followEmailChange,
  requireDepartmentRole,
};
