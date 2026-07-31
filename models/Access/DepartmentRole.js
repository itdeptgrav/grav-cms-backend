// models/Access/DepartmentRole.js
//
// What a person may DO inside a department they can open.
//
// The department grant answers "may you reach HR at all". This answers the
// second question every module eventually asks: may you only look, may you
// enter, may you approve, do you own it. Accounting has had that distinction
// for a while (owner / approver / editor / viewer); every other department has
// been all-or-nothing, which is why the same manager who should only read
// payroll could also rewrite it.
//
// ONE SCHEMA, ONE ROUTE
// ---------------------
// This is the general store, for every department. Accounting is the single
// exception and deliberately so: its module already reads `Acc_User` on every
// request as its own source of truth, and a second row saying something
// different would be a bug generator. So `services/departmentRoles.js` writes
// Acc_User for the accountant slug and this collection for everything else,
// behind one admin API. From Access Control there is one screen and one
// vocabulary; underneath, each module keeps reading what it already reads.
//
// WHY EMAIL AND NOT A USER ID
// ---------------------------
// A person can be an Employee, a DeptUser, or an accounting-only account, and
// which one they are is decided at sign-in by whichever identity matches. Email
// is the one thing all three share and the thing the admin actually types. The
// grant therefore survives a person changing identity kind, which happens when
// an external contractor is later put on the payroll.

"use strict";

const mongoose = require("mongoose");

/**
 * The default vocabulary, taken from the one that already exists in Accounting
 * rather than invented. Ranked, so "at least approver" is expressible without a
 * table of string comparisons scattered through the routes.
 */
const ROLES = [
  { key: "viewer",   label: "Viewer",   rank: 10, description: "Read only." },
  { key: "editor",   label: "Editor",   rank: 20, description: "Create and change; changes may need approval." },
  { key: "approver", label: "Approver", rank: 30, description: "Everything an editor can do, plus approve." },
  { key: "owner",    label: "Owner",    rank: 40, description: "Full control, including settings and people." },
];

const ROLE_KEYS = ROLES.map((r) => r.key);
const RANK = Object.fromEntries(ROLES.map((r) => [r.key, r.rank]));

/** Does `role` reach `required`? Used by every guard rather than string tests. */
function roleAtLeast(role, required) {
  return (RANK[role] || 0) >= (RANK[required] || 0);
}

const departmentRoleSchema = new mongoose.Schema(
  {
    departmentSlug: { type: String, required: true, index: true, lowercase: true, trim: true },
    departmentId: { type: mongoose.Schema.Types.ObjectId, ref: "AccessDepartment" },

    email: { type: String, required: true, index: true, lowercase: true, trim: true },
    // Denormalised for the admin list, which would otherwise do a lookup per
    // row across three possible identity collections.
    name: { type: String, default: "" },

    role: { type: String, enum: ROLE_KEYS, required: true },

    isActive: { type: Boolean, default: true },

    grantedBy: { type: mongoose.Schema.Types.ObjectId },
    grantedByEmail: { type: String, default: "" },
  },
  { timestamps: true, collection: "department_roles" },
);

// One role per person per department. Enforced by the database, not by a check
// that races itself when two admins save at once.
departmentRoleSchema.index({ departmentSlug: 1, email: 1 }, { unique: true });

module.exports =
  mongoose.models.DepartmentRole ||
  mongoose.model("DepartmentRole", departmentRoleSchema, "department_roles");

module.exports.ROLES = ROLES;
module.exports.ROLE_KEYS = ROLE_KEYS;
module.exports.roleAtLeast = roleAtLeast;
