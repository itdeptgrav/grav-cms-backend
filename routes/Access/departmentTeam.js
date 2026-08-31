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
      .select("email firstName lastName name employeeId designation department isActive")
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
          employeeId: emp?.employeeId || "",
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
  try {
    const slug = slugOf(req);
    const myRole = await roleFor(req, slug);
    if (myRole !== "owner") {
      return res.status(403).json({
        success: false,
        code: "OWNER_ONLY",
        message: "Only an owner can change who is on this team.",
      });
    }

    const email = String(req.body?.email || "").toLowerCase().trim();
    const role = req.body?.role || null; // null revokes
    if (!email) {
      return res.status(400).json({ success: false, message: "An email address is required." });
    }
    if (role && !deptRoles.ROLE_KEYS.includes(role)) {
      return res.status(400).json({ success: false, message: `Unknown role "${role}".` });
    }

    if (email === req.user.email && !req.user.isAdmin) {
      return res.status(400).json({
        success: false,
        code: "SELF_CHANGE",
        message:
          "You cannot change your own role. Ask another owner, so a department " +
          "can never be left without one by accident.",
      });
    }

    // Removing or demoting the last owner leaves nobody who can grant a role
    // here, and getting out of that needs a platform administrator — the exact
    // dependency this screen exists to remove.
    if (role !== "owner") {
      const owners = (await deptRoles.listRoles(slug)).filter((h) => h.role === "owner");
      const isLastOwner =
        owners.length === 1 && String(owners[0].email).toLowerCase() === email;
      if (isLastOwner) {
        return res.status(400).json({
          success: false,
          code: "LAST_OWNER",
          message: "This is the only owner. Make somebody else an owner first.",
        });
      }
    }

    const name = String(req.body?.name || "").trim();
    const result = await deptRoles.setRole({
      departmentSlug: slug,
      email,
      name,
      role,
      actor: req.user,
    });

    // Into the same log every department reads, with the same shape Access
    // Control writes — one history, whichever door the change came through.
    await recordChange(req, {
      departmentSlug: slug,
      entity: "department-role",
      entityId: email,
      entityLabel: name || email,
      action: role ? (result.created ? "create" : "update") : "delete",
      summary: role
        ? `${email} set to ${role} in ${slug}`
        : `${email} removed from ${slug}`,
      before: { role: result.previous ?? null },
      after: { role: role || null },
    }).catch(() => {});

    res.json({
      success: true,
      role: result.role,
      message: role ? `${email} is now ${role}.` : `${email} no longer has a role here.`,
    });
  } catch (err) {
    console.error("[department-team] set role:", err.message);
    res.status(400).json({ success: false, message: err.message });
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
      $or: [{ email: rx }, { firstName: rx }, { lastName: rx }, { employeeId: rx }],
    })
      .select("email firstName lastName name employeeId designation department")
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
          employeeId: p.employeeId || "",
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
