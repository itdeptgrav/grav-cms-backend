// services/board/boardAccess.js
//
// WHO MAY SEE, DRAFT AND APPROVE A COMPANY-WIDE DECISION.
//
// ── ITS OWN DEPARTMENT, BECAUSE IT IS ITS OWN APPLICATION ───────────────────
// This read `ceo` for a while, because `ceo` was the only board-level boundary
// the repository had: `services/access/hrAccess.js` and
// `services/access/fulfilmentAccess.js` both declare
// `BOARD_DEPT_SLUGS = new Set(["ceo"])` and still do — those are genuine
// EXECUTIVE functions (board-level visibility of HR and fulfilment) and are
// deliberately left alone.
//
// Reusing it here coupled two independent applications. A person had to be
// granted the Executive Office before a Board role could even be chosen for
// them; granting the Executive Office implied Board; and revoking either
// quietly moved the other. `board` is now a seeded `AccessDepartment` of its
// own — see `services/ensureAccessDepartments.js` — so the grant is assignable
// on its own terms.
//
// ── ONE SOURCE OF TRUTH, AND NO `ceo || board` ──────────────────────────────
// There is no compatibility branch here on purpose. A guard that accepts
// either slug is a guard that cannot be reasoned about: every Executive would
// hold Board for as long as the branch survived, and nothing would ever force
// the branch to be removed. Compatibility lives in the MIGRATION
// (`scripts/migrations/board-department-split.js`), which copies each active
// explicit `ceo` role to `board` once, so the people who genuinely hold Board
// today keep it and this authority has exactly one answer.
//
// ── AND WHY NOT `requireDepartmentRole` ─────────────────────────────────────
// That guard is the right one for departmental screens and the wrong one here,
// for two reasons it documents about itself:
//
//   · `if (req.user?.isAdmin || req.admin) return next();` — every platform
//     administrator would hold Board approval. The company's financing rate is
//     not an administrative setting, and "do not silently assign Board access
//     to every administrator" is the explicit product rule;
//   · `if (assigned.length === 0) return next();` — a transitional convenience
//     that opens a department to EVERYONE until somebody is granted a role in
//     it. On a policy nobody has been granted yet, that is precisely backwards.
//
// So the grant is read directly and must be present. No bypass, no fallback.
//
// ── TWO FACTS, AND BOTH ARE REQUIRED ────────────────────────────────────────
// Being on the Board is a GRANT (the `board` department on somebody's employee
// record) and a ROLE (an active `DepartmentRole` saying what they may do).
// Neither stands in for the other:
//
//   · a role with no grant is a row, not a person. Board membership lives on
//     the EMPLOYEE document, so requiring it is what makes "only employees with
//     HR records hold Board" true in the guard rather than only on the screen
//     that writes the row. A grant withdrawn from somebody's departments must
//     not leave a working Board seat behind in a role row nobody looked at;
//   · a grant with no role is an administrator saying "this person belongs on
//     the Board" and not yet saying what they may do. Company policy is not
//     readable on the strength of a chip.
//
// The app switcher checks the same two facts, from the same two places, and
// `GET /access` below is how it learns the second one.
//
// ── READ EVERY TIME ─────────────────────────────────────────────────────────
// From the database on each request, never from the token: a grant withdrawn
// five minutes ago must not survive in a seven-day JWT. Same decision
// `services/centralCosting/capabilities.js` records for costing capabilities.
"use strict";

const mongoose = require("mongoose");

const { getEffectiveRole, roleAtLeast } = require("../departmentRoles");
const { fail } = require("../storePurchase/errors");

/** The Board's own grant. Never `ceo`, and never either-or. */
const BOARD_DEPT_SLUG = "board";

/**
 * What each act needs.
 *
 * Drafting and approving are deliberately different ranks. A policy whose
 * author is always its approver has a review step in name only, and the whole
 * reason a Board decision is versioned is that somebody other than its author
 * stands behind it. The ranks come from `DepartmentRole.ROLES` rather than a
 * private vocabulary.
 */
const BOARD_ACTS = Object.freeze({
  read: "viewer",
  draft: "editor",
  approve: "approver",
});

/**
 * Whether this caller's employee record carries the Board department.
 *
 * Read from the record rather than the token, for the same reason the role is:
 * a grant withdrawn five minutes ago must not survive in a seven-day JWT.
 *
 * An account with no employee record holds nothing. That is not an oversight to
 * be patched later with a special case — it IS the rule that Board is held by
 * employees, expressed where a guard can enforce it.
 */
async function holdsBoardDepartment(req) {
  const u = req?.user || req?.admin || req?.dept || {};
  const AccessDepartment = require("../../models/Access/AccessDepartment");
  const Employee = require("../../models/Employee");

  const department = await AccessDepartment
    .findOne({ slug: BOARD_DEPT_SLUG })
    .select("_id")
    .lean();
  /* No department row means the grant cannot exist yet — `server.js` holds
     Board shut until the seeder and migration have run, so this is the
     belt-and-braces answer rather than the one anybody should be reading. */
  if (!department) return false;

  const or = [];
  const id = u.id || u._id;
  if (id && mongoose.Types.ObjectId.isValid(String(id))) or.push({ _id: id });
  if (u.employeeId) or.push({ biometricId: String(u.employeeId) });
  const mail = String(u.email || "").toLowerCase().trim();
  if (mail) or.push({ email: mail });
  if (!or.length) return false;

  /* Every identity the request carries, because a grant is made against
     whichever address an administrator typed — the same reason
     `getEffectiveRole` looks somebody up by more than one. */
  const employees = await Employee.find({ $or: or })
    .select("accessDepartmentId additionalDepartmentIds")
    .lean();

  const wanted = String(department._id);
  return employees.some((e) => [
    String(e.accessDepartmentId || ""),
    ...(e.additionalDepartmentIds || []).map(String),
  ].includes(wanted));
}

/**
 * This caller's Board role, or null.
 *
 * Null is a refusal, never an empty result: a Board screen that renders "no
 * policies" to somebody with no grant has told them something untrue about the
 * company.
 *
 * The two reads are deliberately both made and then ANDed, rather than
 * short-circuiting on the cheaper one, so neither can quietly become the only
 * check that runs.
 */
async function boardRole(req) {
  const [granted, role] = await Promise.all([
    holdsBoardDepartment(req),
    getEffectiveRole(BOARD_DEPT_SLUG, req),
  ]);
  if (!granted) return null;
  return role || null;
}

/** Whether this role reaches an act. Exported so the projection can say so. */
const canDo = (role, act) => Boolean(role) && roleAtLeast(role, BOARD_ACTS[act] || "owner");

/**
 * Guard for one act. Throws the domain refusal; never returns false.
 *
 * The two failures are told apart on purpose: "you are not on the Board" and
 * "you are on the Board but may not approve" are different situations with
 * different remedies, and collapsing them into one 403 leaves a viewer
 * wondering whether their grant is broken.
 */
function assertBoard(role, act) {
  if (!role) {
    throw fail(
      "BOARD_ACCESS_REQUIRED",
      "Company policy is set by the Board. You have not been given a Board role.",
      { reason: "NO_BOARD_GRANT", departmentSlug: BOARD_DEPT_SLUG, requires: BOARD_ACTS[act] },
    );
  }
  if (!canDo(role, act)) {
    throw fail(
      "BOARD_ACCESS_REQUIRED",
      `This needs ${BOARD_ACTS[act]} access on the Board. You are ${role}.`,
      { reason: "INSUFFICIENT_BOARD_ROLE", role, requires: BOARD_ACTS[act] },
    );
  }
  return role;
}

module.exports = {
  BOARD_DEPT_SLUG, BOARD_ACTS, boardRole, canDo, assertBoard, holdsBoardDepartment,
};
