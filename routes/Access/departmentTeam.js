// routes/Access/departmentTeam.js
//
// A department's own team screen. Mounted at /api/department-team.
//
// WHY THIS EXISTS WHEN CEO → ACCESS CONTROL ALREADY DOES IT
// ---------------------------------------------------------
// It is the same data — `DepartmentRole` rows — reached through a different
// door. Access Control is behind `requirePlatformAdmin`, which an HR owner is
// not, so today the only way to make somebody an HR editor is to ask a platform
// administrator. Accounts has not had that problem: an org owner manages their
// own team from inside the module. This gives every other department the same
// thing, over the SAME rows, so there is one answer to "who is an editor here"
// rather than two lists that drift.
//
// WHO MAY DO WHAT
//   read   anyone holding a role in the department (an editor should be able to
//          see who their approvers are — that is who they are waiting on)
//   write  OWNER only, plus platform admins
//
// Owner-only for writes, not approver-and-above, deliberately: granting a role
// is how somebody gets the ability to approve, so letting approvers grant it
// lets the approval requirement be voted away by the people it constrains.
//
// TWO THINGS IT REFUSES, both for the same reason — a department that can lock
// itself out has to be unlocked by a platform admin, which is exactly the
// dependency this router exists to remove:
//   • you cannot change or remove your own role
//   • you cannot remove the last owner

"use strict";

const express = require("express");
const router = express.Router();

const deptRoles = require("../../services/departmentRoles");
const Employee = require("../../models/Employee");
const { recordChange } = require("../../services/changeLog");
const { authenticateCmsSession } = require("../../services/cmsSession");

router.use(authenticateCmsSession);

const slugOf = (req) => String(req.params.slug || "").toLowerCase().trim();

/** The caller's role here. Platform admins are treated as owner. */
async function roleFor(req, slug) {
  if (req.user?.isAdmin) return "owner";
  return deptRoles.getRole(slug, req.user.email);
}

/**
 * May the caller look at this department's team?
 *
 * Mirrors requireDepartmentRole's migration rule exactly — a department with no
 * roles assigned yet has nothing to enforce, so anyone signed in to it may look.
 * The two MUST agree, or the screen that grants the first role is unreachable
 * until somebody has already been granted one.
 */
async function canRead(req, slug) {
  if (req.user?.isAdmin) return true;
  const assigned = await deptRoles.listRoles(slug);
  if (assigned.length === 0) return Boolean(req.user?.deptSlug === slug);
  return Boolean(await deptRoles.getRole(slug, req.user.email));
}

/* ------------------------------------------------------------------ */
/* GET /api/department-team/:slug                                      */
/* ------------------------------------------------------------------ */

router.get("/:slug", async (req, res) => {
  try {
    const slug = slugOf(req);
    if (!(await canRead(req, slug))) {
      return res.status(403).json({ success: false, message: "Not your department." });
    }

    const holders = await deptRoles.listRoles(slug);
    const myRole = await roleFor(req, slug);

    // Which holders are employees, and what to call them. A role row carries an
    // email and whatever name was typed when it was granted; the employee
    // record is the better source for both the name and the job title, and its
    // absence is itself worth showing — a role pointing at nobody is how the
    // "Not your department." lockout happened when somebody changed their own
    // email.
    const emails = holders.map((h) => h.email);
    const employees = await Employee.find({ email: { $in: emails } })
      /* biometricId, not employeeId: `employeeId` is a VIRTUAL on the Employee
         schema aliasing biometricId, and virtuals exist on neither a .lean()
         document nor a .select() projection. Reading it off a lean query is
         always undefined — silently, which is why no employee code ever
         appeared on this screen. */
      .select("email firstName lastName name biometricId designation department isActive")
      .lean();

    const byEmail = new Map(
      employees.map((e) => [String(e.email).toLowerCase(), e]),
    );

    res.json({
      success: true,
      slug,
      roles: deptRoles.ROLES,
      myRole: myRole || null,
      myEmail: req.user.email,
      canManage: myRole === "owner",
      members: holders.map((h) => {
        const emp = byEmail.get(String(h.email).toLowerCase()) || null;
        return {
          ...h,
          isEmployee: Boolean(emp),
          name:
            h.name ||
            emp?.name ||
            [emp?.firstName, emp?.lastName].filter(Boolean).join(" ") ||
            "",
          employeeId: emp?.biometricId || "",
          designation: emp?.designation || "",
          department: emp?.department || "",
          isActive: emp ? emp.isActive !== false : null,
        };
      }),
    });
  } catch (err) {
    console.error("[department-team] list:", err.message);
    res.status(500).json({ success: false, message: "Could not load the team." });
  }
});

/* ------------------------------------------------------------------ */
/* PUT /api/department-team/:slug    body: { email, name?, role|null } */
/* ------------------------------------------------------------------ */

router.put("/:slug", async (req, res) => {
  /* GAC-2 COMPATIBILITY ADAPTER — no permission logic of its own.
     Consumer: grav-cms app/hr/dashboard/team/page.js (the HR team screen).
     Every rule (Owner authority, self-change, last Owner, reason,
     idempotency, audit, cache invalidation, re-read) lives in
     services/access/accessGrantAdmin.service.js.
     Deletion condition: the HR team screen calls PUT /api/admin/app-access
     (or a department-owner equivalent of it) directly. */
  const { changeAppAccess, sendGrantError } = require("../../services/access/accessGrantAdmin.service");
  try {
    const out = await changeAppAccess({
      actor: { id: req.user.id, email: req.user.email, name: req.user.name, subject: req.user.subject, tv: req.user.tv },
      body: req.body,
      headers: req.headers,
      defaults: { application: slugOf(req) },
      via: "department-team",
    });
    const email = out.target.email;
    res.json({
      success: true,
      ...out,
      role: out.after.role,
      message: out.after.role ? `${email} is now ${out.after.role}.` : `${email} no longer has a role here.`,
    });
  } catch (err) {
    sendGrantError(res, err);
  }
});

/* ------------------------------------------------------------------ */
/* GET /api/department-team/:slug/candidates?q=                        */
/* ------------------------------------------------------------------ */

/**
 * People who could be added, so the owner picks a real account rather than
 * typing an address.
 *
 * A typo in an email is not a validation error here — it creates a role row
 * that matches nobody, silently, and the person it was meant for is refused
 * with "Not your department." That has already happened once.
 */
router.get("/:slug/candidates", async (req, res) => {
  try {
    const slug = slugOf(req);
    if ((await roleFor(req, slug)) !== "owner") {
      return res.status(403).json({ success: false, message: "Only an owner can add people." });
    }

    const q = String(req.query.q || "").trim();
    if (q.length < 2) return res.json({ success: true, candidates: [] });

    const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    const held = new Set(
      (await deptRoles.listRoles(slug)).map((h) => String(h.email).toLowerCase()),
    );

    const people = await Employee.find({
      isActive: { $ne: false },
      email: { $nin: [null, ""] },
      $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { biometricId: rx }],
    })
      .select("email firstName lastName name biometricId designation department")
      .limit(30)
      .lean();

    res.json({
      success: true,
      candidates: people
        .filter((p) => !held.has(String(p.email).toLowerCase()))
        .map((p) => ({
          email: String(p.email).toLowerCase(),
          name:
            p.name || [p.firstName, p.lastName].filter(Boolean).join(" ") || p.email,
          employeeId: p.biometricId || "",
          designation: p.designation || "",
          department: p.department || "",
        }))
        .slice(0, 12),
    });
  } catch (err) {
    console.error("[department-team] candidates:", err.message);
    res.status(500).json({ success: false, message: "Could not search." });
  }
});

module.exports = router;
