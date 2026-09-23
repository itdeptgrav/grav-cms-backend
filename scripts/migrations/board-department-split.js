// scripts/migrations/board-department-split.js
//
// Give the people who genuinely hold Board access today a Board grant of their
// own, and change nothing about the Executive Office.
//
// ── WHAT HAPPENED ───────────────────────────────────────────────────────────
// The Board app read the `ceo` department, because `ceo` was the only
// board-level boundary the repository had. That made two independent
// applications one grant: a Board seat could not be given without the executive
// dashboard, granting the executive dashboard silently carried a Board seat, and
// revoking either moved the other. `services/board/boardAccess.js` now reads
// `board`, seeded by `services/ensureAccessDepartments.js`.
//
// Flipping that constant on its own would take Board away from everybody who has
// it. This is the compatibility, and it is HERE rather than a `ceo || board`
// branch in the guard on purpose: a guard that accepts either slug hands Board to
// every executive for as long as the branch survives, and nothing ever forces the
// branch to be removed. One copy, once, and then one answer.
//
// ── THE PRESERVATION BOUNDARY ───────────────────────────────────────────────
// An ACTIVE, EXPLICIT `ceo` DepartmentRole. Not Executive Office membership.
//
// Those are different populations and only the first one could actually use the
// Board app: `boardAccess.js` has always required an explicit role row, with no
// administrator bypass and no "nobody is granted yet" fallback, so somebody who
// merely held the `ceo` department was already refused. Giving them Board now
// would be GRANTING access this migration was asked to PRESERVE — quietly, to a
// population nobody reviewed, at the exact moment the two applications were
// being separated.
//
// So:
//   · an active `ceo` role          → copied to `board`, membership added
//   · `ceo` membership, no role     → nothing (they had no Board access)
//   · an inactive `ceo` role        → nothing (a withdrawn grant stays withdrawn)
//
// ── WHAT IT NEVER DOES ──────────────────────────────────────────────────────
// It does not change, deactivate or delete a single `ceo` row. The Executive
// Office is left exactly as it was, because those rows are ALSO what
// `services/access/hrAccess.js` and `fulfilmentAccess.js` read for board-level
// visibility of HR and fulfilment, and those readers are staying on `ceo`.
//
// It does not move anybody's primary department: Board membership is added to
// `additionalDepartmentIds`, so whichever dashboard a director lands on when they
// sign in is unchanged.
//
// ── AN UNRESOLVABLE PERSON IS A REFUSAL, NOT A WARNING ──────────────────────
// It invents no employee, and it does not proceed around one either.
//
// Board access is a role AND the `board` department on an EMPLOYEE record — see
// `services/board/boardAccess.js`. So an address holding an active `ceo` role
// with no Employee record cannot be migrated: copying the role alone would
// produce a half-grant that never works, and inventing a record would hand a
// Board seat to somebody nobody hired.
//
// Either way the honest answer is that Board access on this database cannot be
// determined. It refuses, `server.js` records a named diagnostic, and Board
// answers `BOARD_NOT_READY` rather than `NO_BOARD_GRANT` — because "we cannot
// work out who is on the Board" and "you are not on the Board" are different
// statements, and only the first one is true.
//
// Nothing partial is written: the refusal is decided in the PLAN, before any
// write happens.
//
// ── IDEMPOTENT ──────────────────────────────────────────────────────────────
// Every write is `$setOnInsert` or `$addToSet`. A second run inserts nothing,
// adds no duplicate membership, and — importantly — does not undo an
// administrator's later decision: if somebody was copied as `owner` and has
// since been set to `viewer`, the second run leaves them `viewer`.
//
// ── IT RUNS AT BOOT, AND BOARD WAITS FOR IT ─────────────────────────────────
// `server.js` runs this after `ensureAccessDepartments` and before Board accepts
// a request — see `services/board/boardReadiness.js`. It can also be run by hand:
//
//   node scripts/migrations/board-department-split.js           # dry run
//   node scripts/migrations/board-department-split.js --apply   # writes
"use strict";

const FROM_SLUG = "ceo";
const TO_SLUG = "board";

/** The outcomes that mean "go ahead and write". Everything else is a refusal. */
const CAN_PROCEED = new Set(["WILL_MIGRATE", "ALREADY_MIGRATED"]);

/** Refusals, named so `server.js` can log which one and a test can pin it. */
const REFUSALS = Object.freeze({
  NO_BOARD_DEPARTMENT: "NO_BOARD_DEPARTMENT",
  AMBIGUOUS_EMPLOYEE: "AMBIGUOUS_EMPLOYEE",
  UNRESOLVED_EMPLOYEE: "UNRESOLVED_EMPLOYEE",
});

/**
 * The active, explicit `ceo` roles — the whole population this migration is about.
 *
 * `isActive: { $ne: false }` rather than `isActive: true`: the field defaults to
 * true and rows written before it existed have no value at all, so asking for
 * `true` would silently skip the oldest grants — the ones most likely to be a
 * founding director's.
 */
async function activeSourceRoles(DepartmentRole) {
  return DepartmentRole.find({ departmentSlug: FROM_SLUG, isActive: { $ne: false } })
    .select("email name role isActive")
    .lean();
}

/**
 * Resolve the one employee an email belongs to.
 *
 * Returns `{ employee }`, `{ missing: true }` or `{ ambiguous: n }`. Both of the
 * latter are refusals rather than guesses: two Employee records sharing an
 * address is a data problem, and picking one would hand Board to a person
 * nobody chose; no record at all means the grant has no employee to sit on.
 */
async function resolveEmployee(Employee, email) {
  const rows = await Employee.find({ email: String(email).toLowerCase().trim() })
    .select("_id email accessDepartmentId additionalDepartmentIds")
    .lean();
  if (rows.length === 0) return { missing: true };
  if (rows.length > 1) return { ambiguous: rows.length };
  return { employee: rows[0] };
}

/**
 * Decide what this migration would do, without doing it.
 *
 * Separated from the writing so the DECISION is testable: "an inactive role is
 * skipped" and "membership without a role is skipped" are claims about this
 * function, and neither needs a write to prove.
 */
async function planBoardSplit({ AccessDepartment, DepartmentRole, Employee }) {
  const department = await AccessDepartment.findOne({ slug: TO_SLUG })
    .select("_id slug name isActive showOnOnboarding updatedBy")
    .lean();

  /* ── THE ONE THING WORTH REFUSING OVER ────────────────────────────────────
     Without the Board department row there is nothing to grant membership on,
     and every copied role would point at a department that does not exist. The
     seeder creates it; if it has not run, this must say so rather than proceed
     and leave a half-migrated database that looks migrated. */
  if (!department) {
    return {
      outcome: "NO_BOARD_DEPARTMENT",
      reason:
        `No "${TO_SLUG}" AccessDepartment exists on this database. `
        + "`services/ensureAccessDepartments.js` seeds it at boot — run that first. "
        + "Refusing to migrate Board access without the department it belongs to.",
      roles: [], memberships: [], unresolved: [], skipped: [],
    };
  }

  /* ── AND TAKE IT OFF THE PUBLIC GRID ──────────────────────────────────────
     The seeder writes `showOnOnboarding: false` on insert, but it is
     `$setOnInsert` — by design, so that an administrator's choices survive a
     restart. A database seeded during the short window before that was decided
     has the row with the default `true`, which puts Board on `/onboarding`: an
     unauthenticated page inviting anybody to pick the department they work in.

     So it is corrected once, here, and ONLY while the row still looks
     system-supplied. `updatedBy` is set by `PUT /api/admin/departments/:id`
     every time an administrator saves one, so its absence is the honest marker
     for "nobody has made a decision about this row". If somebody HAS — even to
     put Board back on the grid — that is their decision and it is reported
     rather than overwritten. Without that guard this would be a boot-time
     setting that silently undoes an administrator every restart, which is the
     failure `server.js` already records about the old account seeders. */
  const onboarding = (() => {
    if (department.showOnOnboarding !== true) return { outcome: "ALREADY_HIDDEN" };
    if (department.updatedBy) return { outcome: "CUSTOMISED" };
    return { outcome: "WILL_HIDE" };
  })();

  const source = await activeSourceRoles(DepartmentRole);
  const existing = new Map(
    (await DepartmentRole.find({ departmentSlug: TO_SLUG }).select("email role").lean())
      .map((r) => [r.email, r.role]),
  );

  const roles = [];
  const memberships = [];
  const unresolved = [];
  const ambiguous = [];

  for (const row of source) {
    const email = String(row.email || "").toLowerCase().trim();
    if (!email) continue;

    /* Already has a Board role: left exactly as it is, whatever it now says.
       This migration preserves access; it does not re-assert a rank an
       administrator has since changed. */
    const roleAlready = existing.has(email);
    roles.push({
      email,
      name: row.name || "",
      role: roleAlready ? existing.get(email) : row.role,
      already: roleAlready,
    });

    /* ── MEMBERSHIP FOLLOWS THE COPY, NOT THE SOURCE ROW ──────────────────
       Only considered for a role this run is actually copying. Otherwise a
       rerun would re-add a department grant an administrator had since taken
       away — which is not idempotence, it is overruling them. */
    if (roleAlready) continue;

    const found = await resolveEmployee(Employee, email);
    if (found.ambiguous) { ambiguous.push({ email, records: found.ambiguous }); continue; }
    /* No HR record: a refusal, not a skip. See the header — the role half alone
       is a grant that can never work, and the migration must not report success
       having silently left somebody out. */
    if (found.missing) { unresolved.push({ email, reason: "NO_EMPLOYEE_RECORD" }); continue; }

    const emp = found.employee;
    const held = [
      String(emp.accessDepartmentId || ""),
      ...(emp.additionalDepartmentIds || []).map(String),
    ];
    memberships.push({
      email,
      employeeId: String(emp._id),
      already: held.includes(String(department._id)),
    });
  }

  /* ── THE TWO PEOPLE-SHAPED REFUSALS ───────────────────────────────────────
     Neither can be resolved by trying harder, and both are decided here, before
     a single write — so a refusal leaves the database exactly as it found it
     rather than half migrated. */
  if (ambiguous.length) {
    return {
      outcome: "AMBIGUOUS_EMPLOYEE",
      reason:
        "More than one Employee record shares an address that holds an active "
        + `${FROM_SLUG} role: ${ambiguous.map((a) => `${a.email} (${a.records})`).join(", ")}. `
        + "Refusing to guess which person the Board seat belongs to.",
      department, roles: [], memberships: [], unresolved, ambiguous, skipped: [],
      onboarding,
    };
  }

  if (unresolved.length) {
    return {
      outcome: "UNRESOLVED_EMPLOYEE",
      reason:
        `An active ${FROM_SLUG} role belongs to an address with no Employee record: `
        + `${unresolved.map((u) => u.email).join(", ")}. `
        + "Board access is a role AND the board department on an employee record, so this "
        + "grant cannot be migrated; copying the role alone would leave a seat that never "
        + "works. Refusing, and inventing no employee. Resolve the address — or withdraw "
        + `the ${FROM_SLUG} role if the person has left — and run this again.`,
      department, roles: [], memberships: [], unresolved, ambiguous, skipped: [],
      onboarding,
    };
  }

  const toWriteRoles = roles.filter((r) => !r.already);
  const toAddMembers = memberships.filter((m) => !m.already);

  const nothingToDo = !toWriteRoles.length
    && !toAddMembers.length
    && onboarding.outcome !== "WILL_HIDE";

  return {
    outcome: nothingToDo ? "ALREADY_MIGRATED" : "WILL_MIGRATE",
    department,
    roles, memberships, unresolved, ambiguous,
    onboarding,
    willCopyRoles: toWriteRoles.length,
    willAddMemberships: toAddMembers.length,
    willHideFromOnboarding: onboarding.outcome === "WILL_HIDE",
    sourceRoles: source.length,
  };
}

/**
 * Do it.
 *
 * `$setOnInsert` on the role and `$addToSet` on the membership, so this is the
 * same function whether it has run before or not.
 */
async function applyBoardSplit({ AccessDepartment, DepartmentRole, Employee }) {
  const plan = await planBoardSplit({ AccessDepartment, DepartmentRole, Employee });
  /* Every refusal returns the plan untouched. Nothing below this line runs, so
     a refused migration writes nothing at all — not the roles, not the
     memberships, and not the onboarding flag. */
  if (!CAN_PROCEED.has(plan.outcome)) return plan;

  let rolesCopied = 0;
  let membershipsAdded = 0;
  let hiddenFromOnboarding = 0;

  if (plan.onboarding?.outcome === "WILL_HIDE") {
    /* Narrowly matched: this one row, only while it still reads `true`, and
       only while no administrator has saved it. A concurrent edit between the
       plan and here loses the match and is left alone. */
    const res = await AccessDepartment.updateOne(
      { _id: plan.department._id, showOnOnboarding: true, updatedBy: { $exists: false } },
      { $set: { showOnOnboarding: false } },
    );
    hiddenFromOnboarding = res.modifiedCount || 0;
  }

  for (const r of plan.roles) {
    if (r.already) continue;
    const res = await DepartmentRole.updateOne(
      { departmentSlug: TO_SLUG, email: r.email },
      {
        $setOnInsert: {
          departmentSlug: TO_SLUG,
          departmentId: plan.department._id,
          email: r.email,
          /* Display text for the admin list. The role is what authorises. */
          name: r.name || "",
          role: r.role,
          isActive: true,
          grantedByEmail: "migration:board-department-split",
        },
      },
      { upsert: true },
    );
    if (res.upsertedCount) rolesCopied++;
  }

  for (const m of plan.memberships) {
    if (m.already) continue;
    const res = await Employee.updateOne(
      { _id: m.employeeId },
      /* ADDITIONAL, never primary: which dashboard a director lands on when they
         sign in is their own setting and not this migration's business. */
      { $addToSet: { additionalDepartmentIds: plan.department._id } },
    );
    if (res.modifiedCount) membershipsAdded++;
  }

  /* The outcome from the plan survives when there was nothing to write, so a
     rerun reads as "already migrated" rather than as a migration that happened
     to write nothing — two different things to whoever is reading the log. */
  return {
    ...plan,
    outcome: rolesCopied || membershipsAdded || hiddenFromOnboarding ? "MIGRATED" : plan.outcome,
    rolesCopied,
    membershipsAdded,
    hiddenFromOnboarding,
  };
}

/** What a person running this should read on their terminal. */
function describe(plan, { applied } = {}) {
  switch (plan.outcome) {
    case "NO_BOARD_DEPARTMENT":
    case "AMBIGUOUS_EMPLOYEE":
    case "UNRESOLVED_EMPLOYEE":
      return `REFUSING [${plan.outcome}]: ${plan.reason}`;
    case "ALREADY_MIGRATED":
      return `Nothing to do. ${plan.sourceRoles} active ${FROM_SLUG} role(s); every one already `
        + `has its ${TO_SLUG} role and membership.`;
    case "WILL_MIGRATE":
      return `DRY RUN — would copy ${plan.willCopyRoles} role(s) and add `
        + `${plan.willAddMemberships} Board membership(s). No ${FROM_SLUG} row is changed.`
        + (plan.willHideFromOnboarding
          ? "\n  Would also take Board off the public onboarding grid."
          : "")
        + (plan.onboarding?.outcome === "CUSTOMISED"
          ? "\n  Leaving `showOnOnboarding` alone: an administrator has saved this row."
          : "")
        + "\nRe-run with --apply to write it.";
    case "MIGRATED":
      return `Copied ${plan.rolesCopied} role(s) and added ${plan.membershipsAdded} Board `
        + `membership(s). No ${FROM_SLUG} row was changed.`
        + (plan.hiddenFromOnboarding
          ? "\n  Board was taken off the public onboarding grid."
          : "")
        + (plan.onboarding?.outcome === "CUSTOMISED"
          ? "\n  `showOnOnboarding` left alone: an administrator has saved this row."
          : "");
    default:
      return `Unrecognised outcome: ${plan.outcome}`;
  }
}

/** Whether an outcome means Board may start answering requests. */
const isSafe = (plan) => plan?.outcome === "MIGRATED" || plan?.outcome === "ALREADY_MIGRATED";

/**
 * The boot entry point. Loads the models itself so `server.js` names one thing.
 *
 * Throws on a refusal, deliberately: `server.js` turns that into Board refusing
 * every request with a reason, which is the honest answer while the grant it
 * reads has not been established. Falling back to `ceo` is the one thing that
 * must not happen.
 */
async function migrateBoardDepartment() {
  const plan = await applyBoardSplit({
    AccessDepartment: require("../../models/Access/AccessDepartment"),
    DepartmentRole: require("../../models/Access/DepartmentRole"),
    Employee: require("../../models/Employee"),
  });
  if (!isSafe(plan)) {
    /* The named outcome rides on the error, so `server.js` can record a
       diagnostic a person can search for rather than a sentence. */
    const err = new Error(describe(plan, { applied: true }));
    err.code = plan.outcome;
    err.boardMigration = plan;
    throw err;
  }
  return plan;
}

async function main() {
  require("dotenv").config();
  const mongoose = require("mongoose");
  const APPLY = process.argv.includes("--apply");

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is not set. Refusing to guess a database.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  try {
    const models = {
      AccessDepartment: require("../../models/Access/AccessDepartment"),
      DepartmentRole: require("../../models/Access/DepartmentRole"),
      Employee: require("../../models/Employee"),
    };
    const result = APPLY ? await applyBoardSplit(models) : await planBoardSplit(models);
    console.log(describe(result, { applied: APPLY }));
    if (!isSafe(result) && result.outcome !== "WILL_MIGRATE") process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = {
  FROM_SLUG, TO_SLUG, REFUSALS,
  planBoardSplit, applyBoardSplit, migrateBoardDepartment, describe, isSafe,
};
