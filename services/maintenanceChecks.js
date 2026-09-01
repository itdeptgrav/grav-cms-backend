// services/maintenanceChecks.js
//
// Safe, named maintenance operations for the developer side.
//
// A REGISTRY, like jobRegistry and for the same reason: the UI can only invoke
// a check that shipped in code, by name. Each entry declares whether it only
// REPORTS (reads and describes) or ACTS (changes something) — acting checks
// sit behind a higher role and a typed reason at the route.
//
// Every check here earns its place from a real incident or support pattern in
// this codebase's history, not from a template of what admin panels usually
// have. The first one IS the lockout bug from 31 Aug: an HR editor changed
// their own email and their role row silently pointed at nobody.

"use strict";

const CHECKS = new Map();

function register(name, { label, description, kind, run }) {
  CHECKS.set(name, { name, label, description, kind, run });
}

function listChecks() {
  return [...CHECKS.values()].map(({ name, label, description, kind }) => ({
    name,
    label,
    description,
    kind, // "report" | "action"
  }));
}

async function runCheck(name) {
  const check = CHECKS.get(name);
  if (!check) throw new Error(`"${name}" is not a registered check`);
  const started = Date.now();
  const result = await check.run();
  return { name, kind: check.kind, durationMs: Date.now() - started, ...result };
}

/* ------------------------------------------------------------------ */
/* The checks                                                          */
/* ------------------------------------------------------------------ */

register("orphan-department-roles", {
  label: "Roles pointing at nobody",
  description:
    "DepartmentRole rows whose email matches no employee and no legacy department account. " +
    "This is exactly how someone gets 'Not your department.' after changing their own email — " +
    "the role survives, the address does not. Reports each orphan with what to do.",
  kind: "report",
  run: async () => {
    const DepartmentRole = require("../models/Access/DepartmentRole");
    const Employee = require("../models/Employee");
    const roles = await DepartmentRole.find({}).select("departmentSlug email role name").lean();
    const emails = [...new Set(roles.map((r) => String(r.email).toLowerCase()))];
    const known = new Set(
      (await Employee.find({ email: { $in: emails } }).select("email").lean()).map((e) =>
        String(e.email).toLowerCase(),
      ),
    );
    // Legacy department accounts can also legitimately hold a role.
    try {
      const HRDepartment = require("../models/HRDepartment");
      for (const r of await HRDepartment.find({ email: { $in: emails } }).select("email").lean()) {
        known.add(String(r.email).toLowerCase());
      }
    } catch {
      /* model absent on some databases */
    }
    const orphans = roles.filter((r) => !known.has(String(r.email).toLowerCase()));
    return {
      ok: orphans.length === 0,
      summary: orphans.length
        ? `${orphans.length} role(s) reach nobody — remove them or re-grant at the person's current address.`
        : "Every role points at a real account.",
      items: orphans.map((o) => ({
        department: o.departmentSlug,
        email: o.email,
        role: o.role,
        name: o.name,
      })),
    };
  },
});

register("duplicate-employee-emails", {
  label: "Employees sharing an email",
  description:
    "Two active accounts on one address means roles, notifications and sign-in are ambiguous. " +
    "The employee-profile route refuses NEW clashes; this finds the ones that already exist.",
  kind: "report",
  run: async () => {
    const Employee = require("../models/Employee");
    const dupes = await Employee.aggregate([
      { $match: { email: { $nin: [null, ""] } } },
      { $group: { _id: { $toLower: "$email" }, count: { $sum: 1 }, names: { $push: "$firstName" } } },
      { $match: { count: { $gt: 1 } } },
      { $limit: 50 },
    ]);
    return {
      ok: dupes.length === 0,
      summary: dupes.length
        ? `${dupes.length} address(es) are shared by more than one employee record.`
        : "Every employee email is unique.",
      items: dupes.map((d) => ({ email: d._id, records: d.count, names: d.names })),
    };
  },
});

register("active-without-password", {
  label: "Active employees who cannot sign in",
  description:
    "Active employee records with no password set — the person exists everywhere in the system " +
    "but cannot log in, which surfaces as a support request with no obvious cause.",
  kind: "report",
  run: async () => {
    const Employee = require("../models/Employee");
    const rows = await Employee.find({
      isActive: { $ne: false },
      email: { $nin: [null, ""] },
      $or: [{ password: null }, { password: "" }, { password: { $exists: false } }],
    })
      .select("firstName lastName email department")
      .limit(100)
      .lean();
    return {
      ok: rows.length === 0,
      summary: rows.length
        ? `${rows.length} active account(s) have no password — set one from HR → Security or Access Control.`
        : "Every active account has a password.",
      items: rows.map((r) => ({
        name: [r.firstName, r.lastName].filter(Boolean).join(" "),
        email: r.email,
        department: r.department,
      })),
    };
  },
});

register("setting-overrides", {
  label: "Where settings differ from global",
  description:
    "Every per-department override currently in force, in one list — the answer to " +
    "'why does HR behave differently', without opening each department's settings.",
  kind: "report",
  run: async () => {
    const SystemSetting = require("../models/DevOps/SystemSetting");
    const rows = await SystemSetting.find({ key: /@/ })
      .select("key value updatedByName updatedByEmail updatedAt")
      .lean();
    return {
      ok: true,
      summary: rows.length
        ? `${rows.length} per-department override(s) in force.`
        : "No department differs from the global defaults.",
      items: rows.map((r) => {
        const [key, department] = r.key.split("@");
        return {
          key,
          department,
          value: r.value,
          by: r.updatedByName || r.updatedByEmail,
          at: r.updatedAt,
        };
      }),
    };
  },
});

register("purge-resolved-alerts", {
  label: "Purge old resolved alerts now",
  description:
    "Deletes RESOLVED alerts older than the retention setting, without waiting for the next " +
    "scan. Open and acknowledged alerts are never touched.",
  kind: "action",
  run: async () => {
    const DevAlert = require("../models/DevOps/DevAlert");
    const { getSetting } = require("./devConfig");
    const days = await getSetting("alerts.retentionDays");
    const cutoff = new Date(Date.now() - days * 864e5);
    const gone = await DevAlert.deleteMany({ status: "resolved", resolvedAt: { $lt: cutoff } });
    return {
      ok: true,
      summary: `Purged ${gone.deletedCount} resolved alert(s) older than ${days} days.`,
      items: [],
    };
  },
});

module.exports = { listChecks, runCheck };
