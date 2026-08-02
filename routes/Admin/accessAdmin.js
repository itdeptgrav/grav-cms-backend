// routes/Admin/accessAdmin.js
//
// The department & access configuration API — the backend for the admin
// config page, and the reason department credentials no longer live in source.
//
// Mounted at /api/admin (every route behind requirePlatformAdmin) plus one
// deliberately public route mounted separately at /api/public.
//
// WHAT IS PROTECTED AND WHY
// -------------------------
// The twelve seeded departments carry `isSystem: true`. For those rows the
// legacy bridge fields — legacyRole, legacyUserType, legacyModel, key — are
// REJECTED on update, and delete is refused outright. That is not caution for
// its own sake: ~270 authorization checks across this codebase compare against
// legacyRole, and it is the value that was read out of the database at
// migration time. Editing it through a form would revoke access across the app
// with no error raised anywhere. Names, icons, ordering and visibility are all
// freely editable, because those are the things that were actually meant to be.

"use strict";

const express = require("express");
const router = express.Router();
const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const { recordChange, historyFor, recentFor } = require("../../services/changeLog");

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const SLUG_RE = /^[a-z0-9-]+$/;

/** Fields an admin may edit on ANY department. */
const EDITABLE = [
  "name", "description", "iconUrl", "iconAlt", "accentColor",
  "dashboardPath", "loginRedirect", "showOnOnboarding", "sortOrder",
  "capabilities", "isActive",
];

/** Additionally editable, but only on departments this system did not seed. */
const EDITABLE_IF_NOT_SYSTEM = ["slug"];

/**
 * A temporary password a human can actually read out over the phone.
 *
 * crypto.randomBytes, not Math.random — the existing password reset uses
 * Math.random(), which is seeded predictably and is not safe for credentials.
 * Ambiguous characters are excluded so "l" and "1" cannot be confused when it
 * is dictated.
 */
function generateTempPassword(length = 14) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** Log every mutation with who did it. */
function audit(req, action, detail) {
  console.log(
    `[access-admin] ${action} by ${req.admin?.email || "unknown"} — ${detail}`,
  );
}

const fail = (res, code, message) => res.status(code).json({ success: false, message });

/* ================================================================== */
/* DEPARTMENTS                                                        */
/* ================================================================== */

/** GET /api/admin/departments — every department, with its member count. */
router.get("/departments", async (req, res) => {
  try {
    const departments = await AccessDepartment.find({}).sort({ sortOrder: 1, name: 1 }).lean();

    const counts = await DeptUser.aggregate([
      { $group: { _id: "$departmentId", total: { $sum: 1 }, active: { $sum: { $cond: ["$isActive", 1, 0] } } } },
    ]);
    const countBy = new Map(counts.map((c) => [String(c._id), c]));

    res.json({
      success: true,
      departments: departments.map((d) => ({
        ...d,
        userCount: countBy.get(String(d._id))?.total || 0,
        activeUserCount: countBy.get(String(d._id))?.active || 0,
        // Surfaced so the UI can grey out the fields it must not offer.
        locked: Boolean(d.isSystem),
      })),
    });
  } catch (error) {
    console.error("[access-admin] list departments:", error);
    fail(res, 500, error.message);
  }
});

/** GET /api/admin/departments/:id */
router.get("/departments/:id", async (req, res) => {
  try {
    const dept = await AccessDepartment.findById(req.params.id).lean();
    if (!dept) return fail(res, 404, "Department not found");

    const users = await DeptUser.find({ departmentId: dept._id })
      .select("name email employeeId isActive isAdmin lastLogin mustChangePassword")
      .sort({ name: 1 })
      .lean();

    res.json({ success: true, department: { ...dept, locked: Boolean(dept.isSystem) }, users });
  } catch (error) {
    fail(res, 500, error.message);
  }
});

/** POST /api/admin/departments — create one. No code change required. */
router.post("/departments", async (req, res) => {
  try {
    const { key, slug, name } = req.body || {};

    if (!name || !String(name).trim()) return fail(res, 400, "Name is required");

    const finalSlug = String(slug || name).toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

    if (!SLUG_RE.test(finalSlug)) {
      return fail(res, 400, "Slug may contain only lowercase letters, digits and hyphens");
    }

    const finalKey = String(key || finalSlug).toLowerCase().trim().replace(/[^a-z0-9_]+/g, "_");

    if (await AccessDepartment.exists({ $or: [{ key: finalKey }, { slug: finalSlug }] })) {
      return fail(res, 409, "A department with that key or slug already exists");
    }

    const dept = await AccessDepartment.create({
      key: finalKey,
      slug: finalSlug,
      name: String(name).trim(),
      description: req.body.description || "",
      iconUrl: req.body.iconUrl || "",
      iconAlt: req.body.iconAlt || "",
      accentColor: req.body.accentColor || "#4F46E5",
      // New departments land on the generic shell. Pointing one at a bespoke
      // dashboard is a code change, so it is not offered as a default.
      dashboardPath: req.body.dashboardPath || `/d/${finalSlug}`,
      showOnOnboarding: req.body.showOnOnboarding !== false,
      sortOrder: req.body.sortOrder ?? 500,
      capabilities: Array.isArray(req.body.capabilities) ? req.body.capabilities : [],
      isSystem: false,
      isActive: true,
      // No legacy literal exists, so the role IS the slug. It therefore matches
      // none of the existing allow-lists and is denied everywhere until
      // capabilities are granted explicitly — failing closed, by construction.
      legacyModel: "GenericDepartmentUser",
      legacyRole: finalSlug,
      legacyUserType: finalSlug,
      createdBy: req.admin._id,
    });

    audit(req, "department.create", `${dept.name} (${dept.slug})`);
    res.status(201).json({ success: true, department: dept });
  } catch (error) {
    console.error("[access-admin] create department:", error);
    fail(res, 500, error.message);
  }
});

/** PATCH /api/admin/departments/:id */
router.patch("/departments/:id", async (req, res) => {
  try {
    const dept = await AccessDepartment.findById(req.params.id);
    if (!dept) return fail(res, 404, "Department not found");

    const rejected = [];

    for (const [field, value] of Object.entries(req.body || {})) {
      if (EDITABLE.includes(field)) {
        dept[field] = value;
        continue;
      }
      if (EDITABLE_IF_NOT_SYSTEM.includes(field)) {
        if (dept.isSystem) { rejected.push(field); continue; }
        const next = String(value).toLowerCase().trim();
        if (!SLUG_RE.test(next)) return fail(res, 400, "Invalid slug");
        if (await AccessDepartment.exists({ slug: next, _id: { $ne: dept._id } })) {
          return fail(res, 409, "That slug is already taken");
        }
        dept.slug = next;
        continue;
      }
      // key / legacyRole / legacyUserType / legacyModel / isSystem land here.
      rejected.push(field);
    }

    // Deactivating a department must take effect now, not whenever the last
    // seven-day token happens to expire.
    if (req.body.isActive === false) {
      await DeptUser.updateMany({ departmentId: dept._id }, { $inc: { tokenVersion: 1 } });
      audit(req, "department.deactivate", `${dept.name} — all sessions revoked`);
    }

    dept.updatedBy = req.admin._id;
    await dept.save();

    res.json({
      success: true,
      department: dept,
      // Told plainly rather than silently dropped, so the UI can explain why a
      // field did not stick.
      rejectedFields: rejected,
      message: rejected.length
        ? `Saved. ${rejected.join(", ")} cannot be changed on a built-in department — ` +
          `authorization across the app depends on those values.`
        : "Saved",
    });
  } catch (error) {
    console.error("[access-admin] update department:", error);
    fail(res, 500, error.message);
  }
});

/**
 * DELETE /api/admin/departments/:id — soft only.
 *
 * A hard delete would orphan every ObjectId reference pointing at that
 * department's users: createdBy on payroll runs, approvedBy on vouchers,
 * updatedBy on purchase orders. Those resolve to null silently — no error, no
 * exception, just missing names in reports months later.
 */
router.delete("/departments/:id", async (req, res) => {
  try {
    const dept = await AccessDepartment.findById(req.params.id);
    if (!dept) return fail(res, 404, "Department not found");

    if (dept.isSystem) {
      return fail(res, 400,
        `"${dept.name}" is a built-in department and cannot be removed. ` +
        `Deactivate it instead — its historical records reference its users.`);
    }

    dept.isActive = false;
    dept.showOnOnboarding = false;
    dept.updatedBy = req.admin._id;
    await dept.save();

    const { modifiedCount } = await DeptUser.updateMany(
      { departmentId: dept._id },
      { $set: { isActive: false }, $inc: { tokenVersion: 1 } },
    );

    audit(req, "department.delete", `${dept.name} — ${modifiedCount} user(s) deactivated`);

    res.json({
      success: true,
      message: `"${dept.name}" deactivated and ${modifiedCount} user(s) signed out. ` +
               `Records referencing them are unchanged.`,
      usersDeactivated: modifiedCount,
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
});

/* ================================================================== */
/* USERS                                                              */
/* ================================================================== */

/** GET /api/admin/users?departmentId=&search=&includeInactive= */
router.get("/users", async (req, res) => {
  try {
    const filter = {};
    if (req.query.departmentId) filter.departmentId = req.query.departmentId;
    if (req.query.includeInactive !== "true") filter.isActive = true;

    if (req.query.search) {
      const rx = new RegExp(String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { email: rx }, { employeeId: rx }];
    }

    const users = await DeptUser.find(filter)
      .select("-passwordHash")
      .populate("departmentId", "name slug iconUrl isSystem")
      .sort({ name: 1 })
      .limit(500)
      .lean();

    res.json({ success: true, users, count: users.length });
  } catch (error) {
    fail(res, 500, error.message);
  }
});

/** POST /api/admin/users — add a login to a department. */
router.post("/users", async (req, res) => {
  try {
    const { name, email, departmentId, employeeId, phone, password, employeeRef } = req.body || {};

    if (!name || !email || !departmentId) {
      return fail(res, 400, "Name, email and department are required");
    }

    const normalised = String(email).toLowerCase().trim();

    if (await DeptUser.exists({ email: normalised })) {
      return fail(res, 409, "An account with that email already exists");
    }

    const dept = await AccessDepartment.findById(departmentId);
    if (!dept) return fail(res, 400, "That department does not exist");

    const tempPassword = password || generateTempPassword();

    const user = new DeptUser({
      name: String(name).trim(),
      email: normalised,
      employeeId: employeeId || undefined,
      phone: phone || undefined,
      employeeRef: employeeRef || undefined,
      departmentId: dept._id,
      // Frozen per user, so renaming the department later cannot change what
      // this account is authorized to do.
      legacyModel: dept.legacyModel,
      legacyRole: dept.legacyRole || dept.slug,
      isActive: true,
      createdBy: req.admin._id,
      passwordHash: "pending",   // replaced immediately below
    });

    await user.setPassword(tempPassword);
    user.mustChangePassword = !password;
    await user.save();

    audit(req, "user.create", `${normalised} → ${dept.name}`);

    res.status(201).json({
      success: true,
      user: user.toSafeJSON(),
      // Shown once and never retrievable again.
      temporaryPassword: password ? undefined : tempPassword,
      message: password
        ? "Account created."
        : "Account created. Give them this temporary password — it will not be shown again.",
    });
  } catch (error) {
    if (error.message?.includes("at least 8")) return fail(res, 400, error.message);
    console.error("[access-admin] create user:", error);
    fail(res, 500, error.message);
  }
});

/** PATCH /api/admin/users/:id — reassign, rename, activate, promote. */
router.patch("/users/:id", async (req, res) => {
  try {
    const user = await DeptUser.findById(req.params.id);
    if (!user) return fail(res, 404, "User not found");

    const changes = [];

    if (req.body.name !== undefined) { user.name = String(req.body.name).trim(); changes.push("name"); }
    if (req.body.phone !== undefined) { user.phone = req.body.phone; changes.push("phone"); }
    if (req.body.employeeId !== undefined) { user.employeeId = req.body.employeeId || undefined; changes.push("employeeId"); }
    if (req.body.employeeRef !== undefined) { user.employeeRef = req.body.employeeRef || undefined; changes.push("employeeRef"); }

    if (req.body.email !== undefined) {
      const next = String(req.body.email).toLowerCase().trim();
      if (next !== user.email) {
        if (await DeptUser.exists({ email: next, _id: { $ne: user._id } })) {
          return fail(res, 409, "That email is already in use");
        }
        user.email = next;
        changes.push("email");
      }
    }

    // Moving someone between departments changes what they can reach, so their
    // frozen role moves with them and their existing sessions are revoked.
    if (req.body.departmentId && String(req.body.departmentId) !== String(user.departmentId)) {
      const dept = await AccessDepartment.findById(req.body.departmentId);
      if (!dept) return fail(res, 400, "That department does not exist");
      user.departmentId = dept._id;
      user.legacyModel = dept.legacyModel;
      user.legacyRole = dept.legacyRole || dept.slug;
      user.tokenVersion += 1;
      changes.push(`department → ${dept.name}`);
    }

    if (req.body.isActive !== undefined) {
      user.isActive = Boolean(req.body.isActive);
      if (!user.isActive) user.tokenVersion += 1;   // sign them out now
      changes.push(user.isActive ? "activated" : "deactivated");
    }

    if (req.body.isAdmin !== undefined) {
      // Guard against removing the last administrator and locking everyone out
      // of the console that grants administrators.
      if (user.isAdmin && !req.body.isAdmin) {
        const others = await DeptUser.countDocuments({
          isAdmin: true, isActive: true, _id: { $ne: user._id },
        });
        if (others === 0) {
          return fail(res, 400,
            "This is the only active administrator. Promote someone else first.");
        }
      }
      user.isAdmin = Boolean(req.body.isAdmin);
      user.tokenVersion += 1;
      changes.push(user.isAdmin ? "granted admin" : "revoked admin");
    }

    user.updatedBy = req.admin._id;
    await user.save();

    audit(req, "user.update", `${user.email}: ${changes.join(", ") || "no change"}`);
    res.json({ success: true, user: user.toSafeJSON(), changes });
  } catch (error) {
    console.error("[access-admin] update user:", error);
    fail(res, 500, error.message);
  }
});

/** POST /api/admin/users/:id/reset-password */
router.post("/users/:id/reset-password", async (req, res) => {
  try {
    const user = await DeptUser.findById(req.params.id);
    if (!user) return fail(res, 404, "User not found");

    const newPassword = req.body?.password || generateTempPassword();

    await user.setPassword(newPassword);      // also bumps tokenVersion
    user.mustChangePassword = !req.body?.password;
    user.updatedBy = req.admin._id;
    await user.save();

    audit(req, "user.reset-password", user.email);

    res.json({
      success: true,
      temporaryPassword: req.body?.password ? undefined : newPassword,
      message:
        "Password reset and every existing session for this account signed out. " +
        (req.body?.password ? "" : "This password will not be shown again."),
    });
  } catch (error) {
    if (error.message?.includes("at least 8")) return fail(res, 400, error.message);
    fail(res, 500, error.message);
  }
});

/* ================================================================== */
/* EMPLOYEES — who may sign in, and where                             */
/* ================================================================== */

const Employee = require("../../models/Employee");

/**
 * GET /api/admin/employees?search=&assigned=all|yes|no
 *
 * Every employee with a login, and the department they are allowed to reach.
 * `assigned=no` is the list that matters operationally: people who can prove
 * who they are but have nowhere to go, which is the state a new joiner is in
 * until somebody acts.
 */
router.get("/employees", async (req, res) => {
  try {
    // EVERY employee, including those with no email on file.
    //
    // This used to require an email to exist. The intent was reasonable —
    // without one they cannot sign in — but the effect was that people simply
    // did not appear, with nothing on screen to say why, and an admin looking
    // for them concluded the search was broken. (The condition was also
    // half-dead: `{ $exists: true, $ne: null, $ne: "" }` is a duplicate key in
    // JS, so only the last $ne survived.)
    //
    // They are listed and badged NO EMAIL instead. Not being able to grant them
    // access is a fact about the record, and the screen should show it rather
    // than hide the person.
    const filter = {};

    if (req.query.assigned === "yes") filter.accessDepartmentId = { $ne: null };
    if (req.query.assigned === "no") filter.accessDepartmentId = null;

    if (req.query.search) {
      const rx = new RegExp(
        String(req.query.search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i",
      );
      filter.$or = [
        { firstName: rx }, { lastName: rx }, { email: rx },
        { biometricId: rx }, { department: rx }, { designation: rx },
      ];
    }

    // Filter by the HR org-chart department, which is what an admin actually
    // thinks in — "show me everyone in Production". It is the label HR already
    // maintains, so no second list has to be kept in step with it.
    if (req.query.hrDepartment && req.query.hrDepartment !== "all") {
      filter.department = req.query.hrDepartment;
    }

    const employees = await Employee.find(filter)
      .select("firstName lastName email department accessDepartmentId additionalDepartmentIds biometricId isActive status designation")
      .populate("accessDepartmentId", "name slug accentColor iconUrl isActive")
      .populate("additionalDepartmentIds", "name slug accentColor isActive")
      .sort({ firstName: 1 })
      .limit(2000)
      .lean();

    // NO operator/executive split.
    //
    // It used to derive one with the attendance engine's resolver and hide
    // "operators" by default. That resolver reads designation and department
    // lists HR maintains for payroll, and on this data it classified almost
    // everybody as an operator — so the default view of this screen was empty
    // and real employees appeared to be missing. Guessing who ought to be able
    // to sign in is not this screen's job; showing everybody and letting an
    // admin grant a department is.

    // The HR departments actually present, so the filter offers real choices
    // rather than a hardcoded list that drifts.
    const hrDepartments = (await Employee.distinct("department", {
      email: { $exists: true, $ne: null, $ne: "" },
    })).filter(Boolean).sort();

    // Only people a grant would actually help — somebody with no email is not
    // "waiting to be assigned", they are waiting for HR to record an email.
    const unassigned = employees.filter(
      (e) => e.email && !e.accessDepartmentId,
    ).length;
    const withoutEmail = employees.filter((e) => !e.email).length;

    res.json({
      success: true,
      employees: employees.map((e) => ({
        _id: e._id,
        // Falls through name -> email -> biometric ID, because a record with
        // no email may well have no usable name either, and an unlabelled row
        // is worse than an ID.
        name:
          `${e.firstName || ""} ${e.lastName || ""}`.trim() ||
          e.email ||
          e.biometricId ||
          "(unnamed)",
        email: e.email || "",
        employeeId: e.biometricId || "",
        designation: e.designation || "",
        // The HR org-chart label, shown so an admin can sanity-check the grant
        // against it. It confers nothing.
        hrDepartment: e.department || "",
        accessDepartment: e.accessDepartmentId || null,
        // Departments beyond the primary — a PM who also needs Store, say.
        additionalDepartments: e.additionalDepartmentIds || [],
        // An email is the credential the sign-in path looks them up by, so
        // without one no department grant can do anything for them.
        hasEmail: Boolean(e.email),
        canSignIn:
          Boolean(e.email) && Boolean(e.accessDepartmentId) && e.isActive !== false,
        isActive: e.isActive !== false && e.status !== "inactive",
      })),
      count: employees.length,
      unassigned,
      withoutEmail,
      hrDepartments,
    });
  } catch (error) {
    console.error("[access-admin] list employees:", error);
    fail(res, 500, error.message);
  }
});

/**
 * PATCH /api/admin/employees/:id — assign or revoke department access.
 *
 * Body: { accessDepartmentId: "<id>" | null }
 *
 * Takes effect on the employee's very next request, not when their token
 * expires: /api/auth/verify re-resolves the assignment from the database on
 * every call rather than trusting the claim in the token.
 */
router.patch("/employees/:id", async (req, res) => {
  try {
    // Read lean and write with updateOne rather than loading a document and
    // calling .save().
    //
    // Employee has a pre-save hook that decrypts, recalculates and re-encrypts
    // the whole salary block. On a document loaded with a partial .select()
    // the salary path is present but empty, its toObject() returns undefined,
    // and the hook died with "Cannot use 'in' operator to search for 'gross'
    // in undefined" — an error about payroll, raised by a screen that only
    // wanted to set one reference field.
    //
    // Assigning access has nothing to do with salary, so it should not be
    // running salary code at all.
    const employee = await Employee.findById(req.params.id)
      .select("firstName lastName email accessDepartmentId")
      .lean();
    if (!employee) return fail(res, 404, "Employee not found");

    const { accessDepartmentId, additionalDepartmentIds } = req.body || {};

    // Extra departments, set independently of the primary. Sent as an array;
    // an empty array clears them.
    if (Array.isArray(additionalDepartmentIds)) {
      const valid = await AccessDepartment.find({
        _id: { $in: additionalDepartmentIds },
        isActive: true,
      }).select("_id name").lean();

      // The primary is never duplicated into the extras — it is already granted.
      const extras = valid
        .map((d) => d._id)
        .filter((id) => String(id) !== String(accessDepartmentId || employee.accessDepartmentId));

      await Employee.updateOne(
        { _id: employee._id },
        { $set: { additionalDepartmentIds: extras } },
      );

      audit(req, "employee.extra-departments", `${employee.email} → ${extras.length} extra`);

      if (accessDepartmentId === undefined) {
        return res.json({
          success: true,
          message: extras.length
            ? `${employee.firstName || employee.email} can now also open ${valid.map((d) => d.name).join(", ")}.`
            : `${employee.firstName || employee.email} no longer has any extra departments.`,
        });
      }
    }

    if (accessDepartmentId) {
      const dept = await AccessDepartment.findById(accessDepartmentId);
      if (!dept) return fail(res, 400, "That department does not exist");
      if (!dept.isActive) return fail(res, 400, `${dept.name} is not active`);

      await Employee.updateOne(
        { _id: employee._id },
        { $set: { accessDepartmentId: dept._id } },
      );

      audit(req, "employee.assign", `${employee.email} → ${dept.name}`);
      return res.json({
        success: true,
        message: `${employee.firstName || employee.email} can now sign in to ${dept.name}.`,
        accessDepartment: { _id: dept._id, name: dept.name, slug: dept.slug },
      });
    }

    await Employee.updateOne(
      { _id: employee._id },
      { $set: { accessDepartmentId: null } },
    );

    audit(req, "employee.revoke", employee.email);
    res.json({
      success: true,
      message:
        `${employee.firstName || employee.email} can no longer sign in to any department. ` +
        `This applies immediately, including to anyone already signed in.`,
      accessDepartment: null,
    });
  } catch (error) {
    console.error("[access-admin] assign employee:", error);
    fail(res, 500, error.message);
  }
});

/**
 * POST /api/admin/employees/:id/set-password
 *
 * Give an employee a password an administrator actually knows.
 *
 * This exists because "what is this person's password?" had no answer. An
 * account could be carrying a bcrypt hash of a random string generated during a
 * bulk import months ago, with the plaintext sitting in `temporaryPassword`
 * where nobody thinks to look — so the employee is told "invalid email or
 * password" for a password they were never given.
 *
 * Body: { password } to set a specific one, or {} to generate one.
 * The result is shown once and never retrievable.
 */
router.post("/employees/:id/set-password", async (req, res) => {
  try {
    const employee = await Employee.findById(req.params.id)
      .select("firstName lastName email")
      .lean();
    if (!employee) return fail(res, 404, "Employee not found");
    if (!employee.email) {
      return fail(res, 400, "This employee has no email address, so they cannot sign in.");
    }

    const password = req.body?.password || generateTempPassword();
    if (String(password).length < 8) {
      return fail(res, 400, "Password must be at least 8 characters");
    }

    const hash = await bcrypt.hash(String(password), 10);

    // updateOne, not .save(): the Employee pre-save hook recalculates and
    // re-encrypts the whole salary block, and setting a password should not
    // run payroll code — especially not on a partially-selected document.
    // `temporaryPassword` is cleared because a readable copy of a live
    // password sitting in the record is exactly the problem being fixed.
    await Employee.updateOne(
      { _id: employee._id },
      { $set: { password: hash }, $unset: { temporaryPassword: 1 } },
    );

    audit(req, "employee.set-password", employee.email);

    res.json({
      success: true,
      temporaryPassword: req.body?.password ? undefined : password,
      message: req.body?.password
        ? "Password set."
        : "Password set. Give it to them now — it will not be shown again.",
    });
  } catch (error) {
    console.error("[access-admin] set employee password:", error);
    fail(res, 500, error.message);
  }
});

/* ================================================================== */
/* ACCOUNTANT ROLES                                                   */
/*                                                                    */
/* Backed by Acc_User — the SAME collection the accounting module's    */
/* own team page manages. Not a copy, not a mirror: create somebody    */
/* here and they appear there, change them there and it shows here,    */
/* because there is only one row.                                      */
/* ================================================================== */

const {
  ROLES: ACCOUNTANT_ROLES,
  findAccountantUser,
  setAccountantRole,
  resetAccountantPassword,
  revokeAccountantRole,
  deleteAccountantUser,
} = require("../../services/accountantAccess");

/* ================================================================== */
/* DEPARTMENT ROLES — one vocabulary for every department              */
/* ================================================================== */
//
// The accounting module has had owner/approver/editor/viewer for a while and
// every other department has been all-or-nothing. These three routes are the
// whole admin surface for fixing that. Underneath, accounting still reads its
// own Acc_User rows — see services/departmentRoles.js for why — but from here
// there is one screen, one vocabulary and one shape of answer.

const deptRoles = require("../../services/departmentRoles");

/** GET /api/admin/department-roles/vocabulary */
router.get("/department-roles/vocabulary", (req, res) => {
  res.json({ success: true, roles: deptRoles.ROLES });
});

/** GET /api/admin/department-roles/:slug — everyone holding a role there. */
router.get("/department-roles/:slug", async (req, res) => {
  try {
    const holders = await deptRoles.listRoles(req.params.slug);

    // Which of them are employees, so the UI can say who signs in with an HR
    // password and who needs one of their own.
    const emails = holders.map((h) => h.email);
    const employees = await Employee.find({ email: { $in: emails } }).select("email").lean();
    const isEmployee = new Set(employees.map((e) => String(e.email).toLowerCase()));

    res.json({
      success: true,
      slug: req.params.slug,
      roles: deptRoles.ROLES,
      holders: holders.map((h) => ({ ...h, isEmployee: isEmployee.has(h.email) })),
    });
  } catch (error) {
    console.error("[access-admin] list department roles:", error);
    fail(res, 500, error.message);
  }
});

/**
 * PUT /api/admin/department-roles/:slug
 * body: { email, name?, role, password? }   role: null revokes
 */
router.put("/department-roles/:slug", async (req, res) => {
  try {
    const { email, name, role, password } = req.body || {};
    if (!email) return fail(res, 400, "An email address is required");

    const result = await deptRoles.setRole({
      departmentSlug: req.params.slug,
      email, name, role: role || null, password,
      actor: req.admin,
    });

    audit(req, "department-role", `${req.params.slug}: ${email} -> ${role || "none"}`);

    // The same change, in the log every department will read from.
    await recordChange(req, {
      departmentSlug: req.params.slug,
      entity: "department-role",
      entityId: email,
      entityLabel: name || email,
      action: role ? (result.created ? "create" : "update") : "delete",
      summary: role
        ? `${email} set to ${role} in ${req.params.slug}`
        : `${email} removed from ${req.params.slug}`,
      before: { role: result.previous ?? null },
      after: { role: role || null },
    });

    res.json({
      success: true,
      role: result.role,
      message: role
        ? `${email} is now ${role}.`
        : `${email} no longer has a role here.`,
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

/* ================================================================== */
/* CHANGE LOG                                                          */
/* ================================================================== */

/** GET /api/admin/change-log?department=hr&entity=&entityId=&limit= */
router.get("/change-log", async (req, res) => {
  try {
    const { department, entity, entityId, limit } = req.query;
    const n = Math.min(Number(limit) || 50, 200);

    const entries = entity && entityId
      ? await historyFor(entity, entityId, n)
      : await recentFor(department, n);

    res.json({ success: true, entries });
  } catch (error) {
    console.error("[access-admin] change log:", error);
    fail(res, 500, error.message);
  }
});

/** GET /api/admin/accountant-roles — the vocabulary, for building a dropdown. */
router.get("/accountant-roles", (req, res) => {
  res.json({
    success: true,
    roles: [
      { value: "owner", label: "Owner", hint: "Full control; one per organisation" },
      { value: "approver", label: "Approver", hint: "Edit, and approve others' submissions" },
      { value: "editor", label: "Editor", hint: "Create and edit; changes need approval" },
      { value: "viewer", label: "Viewer", hint: "Read-only" },
    ].filter((r) => ACCOUNTANT_ROLES.includes(r.value)),
  });
});

/**
 * GET /api/admin/accountant-users — everyone with an accounting role.
 *
 * The same rows the accounting module's Team page lists. `isEmployee` tells the
 * UI which of them sign in with an HR password and which carry their own.
 */
router.get("/accountant-users", async (req, res) => {
  try {
    const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
    const users = await Acc_User.find({})
      .select("name email role isActive createdAt")
      .sort({ role: 1, name: 1 })
      .lean();

    const emails = users.map((u) => u.email);
    const employees = await Employee.find({ email: { $in: emails } })
      .select("email")
      .lean();
    const employeeEmails = new Set(employees.map((e) => String(e.email).toLowerCase()));

    res.json({
      success: true,
      users: users.map((u) => ({
        ...u,
        isEmployee: employeeEmails.has(String(u.email).toLowerCase()),
      })),
    });
  } catch (error) {
    console.error("[access-admin] list accountant users:", error);
    fail(res, 500, error.message);
  }
});

/** GET /api/admin/accountant-role/:email — what this person holds today. */
router.get("/accountant-role/:email", async (req, res) => {
  try {
    const user = await findAccountantUser(req.params.email);
    res.json({
      success: true,
      role: user && user.isActive ? user.role : null,
      name: user?.name || null,
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
});

/**
 * POST /api/admin/accountant-users/:email/set-password
 *
 * Only for accounting-only users. The service refuses employees, because their
 * password lives on the HR record and that is what login actually checks.
 */
router.post("/accountant-users/:email/set-password", async (req, res) => {
  try {
    const { password } = req.body || {};
    if (!password || String(password).length < 8) {
      return fail(res, 400, "The password must be at least 8 characters");
    }

    await resetAccountantPassword(req.params.email, password);
    audit(req, "accountant.set-password", req.params.email);

    res.json({
      success: true,
      message: `Password updated for ${req.params.email}. Their open sessions were ended.`,
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

/**
 * DELETE /api/admin/accountant-users/:email
 *
 * Hard delete, and only for people with no employee record. "Remove access"
 * for somebody whose entire account is this row has to actually remove them —
 * deactivating leaves a permanently dead entry cluttering the People list.
 */
router.delete("/accountant-users/:email", async (req, res) => {
  try {
    const email = String(req.params.email).toLowerCase().trim();

    if (await Employee.exists({ email })) {
      return fail(
        res,
        400,
        "This person is an employee. Set their accounting role to none instead — " +
          "deleting the row would not remove their employee account.",
      );
    }

    const removed = await deleteAccountantUser(email);
    audit(req, "accountant.delete", email);

    res.json({
      success: true,
      message: removed
        ? `${email} was deleted. They can no longer sign in anywhere.`
        : `${email} had no accounting account.`,
    });
  } catch (error) {
    fail(res, 400, error.message);
  }
});

/**
 * PUT /api/admin/accountant-role
 * body: { email, name?, role, password? }
 *
 * `role: null` revokes. A password is required only when creating a brand-new
 * accountant login — an existing user keeps the one they already have, so
 * changing somebody from editor to approver never disturbs their sign-in.
 */
router.put("/accountant-role", async (req, res) => {
  try {
    const { email, name, role, password } = req.body || {};
    if (!email) return fail(res, 400, "An email address is required");

    if (!role) {
      const revoked = await revokeAccountantRole(email);
      audit(req, "accountant.revoke", email);
      return res.json({
        success: true,
        role: null,
        message: revoked
          ? `${email} no longer has accounting access. Existing sessions were ended.`
          : `${email} had no accounting access.`,
      });
    }

    const { user, created } = await setAccountantRole({
      email,
      name,
      role,
      password,
      actorId: req.admin?._id,
    });

    audit(req, created ? "accountant.create" : "accountant.role", `${email} → ${role}`);

    res.json({
      success: true,
      role: user.role,
      created,
      message: created
        ? `Accounting login created for ${email} as ${user.role}.`
        : `${email} is now ${user.role} in Accounting.`,
    });
  } catch (error) {
    // These are operator-facing messages ("owner cannot be removed", "password
    // required"), not internal faults — 400 so the UI shows them as guidance.
    fail(res, 400, error.message);
  }
});

/** POST /api/admin/employees/bulk-assign — { employeeIds: [], accessDepartmentId } */
router.post("/employees/bulk-assign", async (req, res) => {
  try {
    const { employeeIds, accessDepartmentId } = req.body || {};
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      return fail(res, 400, "Select at least one employee");
    }

    let deptName = "no department";
    if (accessDepartmentId) {
      const dept = await AccessDepartment.findById(accessDepartmentId);
      if (!dept) return fail(res, 400, "That department does not exist");
      deptName = dept.name;
    }

    const { modifiedCount } = await Employee.updateMany(
      { _id: { $in: employeeIds } },
      { $set: { accessDepartmentId: accessDepartmentId || null } },
    );

    audit(req, "employee.bulk-assign", `${modifiedCount} → ${deptName}`);
    res.json({
      success: true,
      message: `${modifiedCount} employee(s) assigned to ${deptName}.`,
      modified: modifiedCount,
    });
  } catch (error) {
    fail(res, 500, error.message);
  }
});

module.exports = router;
module.exports.generateTempPassword = generateTempPassword;
