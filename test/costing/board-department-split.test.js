// test/costing/board-department-split.test.js
//
// BOARD IS ITS OWN APPLICATION, ITS OWN DEPARTMENT, AND NOBODY LOST ACCESS.
//
// ── WHAT CHANGED ────────────────────────────────────────────────────────────
// `services/board/boardAccess.js` read the `ceo` department, because `ceo` was
// the only board-level boundary this repository had. That made the Executive
// Office and the Board one grant: a Board seat could not be given without the
// executive dashboard, granting the dashboard silently carried a Board seat, and
// revoking either moved the other.
//
// It now reads `board`. Flipping that constant alone would take Board away from
// everybody who has it, so the people who genuinely hold it are copied across
// once — `scripts/migrations/board-department-split.js`.
//
// ── WHAT THIS SUITE DEFENDS ─────────────────────────────────────────────────
//   · the seeder registers the department the guard reads;
//   · the preservation boundary is an ACTIVE EXPLICIT `ceo` ROLE, not Executive
//     Office membership — because membership alone was already refused, and
//     "preserving" it would be granting Board to a population nobody reviewed;
//   · no `ceo` row is changed, deactivated or deleted, because HR and fulfilment
//     still read those rows for board-level visibility;
//   · it is safe to run twice, and does not overrule a later admin decision;
//   · when it cannot resolve the department or the person, it REFUSES — and
//     Board stays shut with a reason rather than falling back to `ceo`.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

const AccessDepartment = require("../../models/Access/AccessDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const { ensureAccessDepartments } = require("../../services/ensureAccessDepartments");
const {
  FROM_SLUG, TO_SLUG, REFUSALS,
  planBoardSplit, applyBoardSplit, isSafe, describe: explain,
} = require("../../scripts/migrations/board-department-split");
const boardReadiness = require("../../services/board/boardReadiness");

const models = () => ({ AccessDepartment, DepartmentRole, Employee });
const repo = (rel) => readFile(path.resolve(__dirname, "../..", rel), "utf8");

let seq = 0;

/** One request through the readiness gate, and what came back. */
async function gateThrough() {
  const app = express();
  app.use(boardReadiness.requireBoardReady);
  app.get("/x", (req, res) => res.json({ success: true, through: true }));
  const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/x`);
    return { status: res.status, body: await res.json() };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

/** The Board department, as the seeder registers it. */
const seedBoard = () => AccessDepartment.create({
  key: "board", slug: "board", name: "Board",
  dashboardPath: "/board/dashboard/policies/financing",
});

const seedExecutive = () => AccessDepartment.create({
  key: "ceo", slug: "ceo", name: "Executive Office", dashboardPath: "/ceo/dashboard",
});

/**
 * A person, with whatever combination of membership and role a case needs.
 *
 * `memberOf` is department MEMBERSHIP; `role` is a `DepartmentRole`. Keeping them
 * separate arguments is the whole point — the migration treats them as different
 * facts, and a helper that conflated them could not tell these cases apart.
 */
async function person({ memberOf = [], role = null, roleActive = true, roleSlug = FROM_SLUG } = {}) {
  const n = ++seq;
  const email = `split${n}@grav.test`;
  const depts = await AccessDepartment.find({ slug: { $in: memberOf } }).lean();
  const emp = await Employee.create({
    firstName: "S", lastName: `P${n}`, email, biometricId: `SP${n}`,
    isActive: true, gender: "Other", department: "Tech",
    additionalDepartmentIds: depts.map((d) => d._id),
  });
  if (role) {
    await DepartmentRole.create({
      departmentSlug: roleSlug, email, name: `Person ${n}`, role, isActive: roleActive,
    });
  }
  return { email, employeeId: emp._id };
}

const boardRoleOf = (email) =>
  DepartmentRole.findOne({ departmentSlug: TO_SLUG, email }).lean();
const execRoleOf = (email) =>
  DepartmentRole.findOne({ departmentSlug: FROM_SLUG, email }).lean();

/** Whether this employee holds the Board department. */
async function holdsBoardDepartment(employeeId) {
  const dept = await AccessDepartment.findOne({ slug: TO_SLUG }).lean();
  const emp = await Employee.findById(employeeId).lean();
  const held = [
    String(emp.accessDepartmentId || ""),
    ...(emp.additionalDepartmentIds || []).map(String),
  ];
  return held.includes(String(dept._id));
}

/* ═══ 1 · THE SEEDER REGISTERS THE DEPARTMENT THE GUARD READS ═════════════ */

describe("the board department exists before anybody can be granted it", () => {
  test("the boot seeder registers it, alongside the Executive Office", async () => {
    await ensureAccessDepartments(mongoose.connection);

    const board = await AccessDepartment.findOne({ key: "board" }).lean();
    expect(board).toBeTruthy();
    expect(board.slug).toBe("board");
    expect(board.name).toBe("Board");
    expect(board.isActive).toBe(true);
    /* The switcher's tile opens this address, and `Board_DashboardLayout`'s
       guard reads this slug. */
    expect(board.dashboardPath).toBe("/board/dashboard/policies/financing");
    /* Not an external app: there is no separate origin and no SSO handoff, so
       Access Control renders it as an ordinary grantable chip. */
    expect(board.externalBaseUrl).toBeFalsy();
    /* ── NO LEGACY LOGINS TO MIRROR ────────────────────────────────────
       Every other seeded department mirrors a pre-existing department login
       collection. There have never been Board logins, so naming one would make
       the seeder look for a collection that does not exist. */
    expect(board.legacyModel).toBeFalsy();
    expect(board.legacyCollection).toBeFalsy();

    /* And the Executive Office is still its own separate department. */
    const exec = await AccessDepartment.findOne({ key: "ceo" }).lean();
    expect(exec.slug).toBe("ceo");
    expect(exec.name).toBe("Executive Office");
    expect(String(exec._id)).not.toBe(String(board._id));
  });

  test("the seeded slug is the one the guard actually reads", async () => {
    const { BOARD_DEPT_SLUG } = require("../../services/board/boardAccess");
    expect(BOARD_DEPT_SLUG).toBe("board");
    await ensureAccessDepartments(mongoose.connection);
    expect(await AccessDepartment.countDocuments({ slug: BOARD_DEPT_SLUG })).toBe(1);
  });
});

/* ═══ 1a · BOARD IS NOT A PUBLIC DEPARTMENT LOGIN ═════════════════════════ */

describe("the onboarding grid", () => {
  /** The real public router and the real Access Control router, side by side. */
  const app = () => {
    const a = express();
    a.use(express.json());
    a.use("/api/public", require("../../routes/Admin/publicDepartments"));
    /* `requirePlatformAdmin` is applied at the mount in `server.js`, not inside
       the router, so this is the production router with its guard omitted —
       and the guard itself is asserted on source in
       `board-role-assignment.test.js`. */
    a.use("/api/admin", require("../../routes/Admin/accessAdmin"));
    return a;
  };

  const get = async (path) => {
    const a = app();
    const server = await new Promise((r) => { const sv = a.listen(0, () => r(sv)); });
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      return { status: res.status, body: await res.json() };
    } finally {
      await new Promise((r) => server.close(r));
    }
  };

  test("the boot seeder keeps Board off the public grid, and nothing else", async () => {
    await ensureAccessDepartments(mongoose.connection);

    const board = await AccessDepartment.findOne({ key: "board" }).lean();
    expect(board.showOnOnboarding).toBe(false);
    /* ── AND ONLY BOARD ────────────────────────────────────────────────
       The flag used to be a hard-coded `true` for every seeded row. Making it
       per-entry must not have taken anybody else off the grid. */
    const others = await AccessDepartment.find({ key: { $ne: "board" } })
      .select("key showOnOnboarding").lean();
    expect(others.length).toBeGreaterThan(10);
    expect(others.filter((d) => d.showOnOnboarding !== true)).toEqual([]);
  });

  test("Board is absent from /onboarding, and its login page does not exist", async () => {
    await ensureAccessDepartments(mongoose.connection);

    const list = await get("/api/public/departments");
    expect(list.status).toBe(200);
    const slugs = list.body.departments.map((d) => d.slug);
    expect(slugs).not.toContain("board");
    /* The Executive Office, and the rest, are exactly where they were. */
    expect(slugs).toContain("ceo");
    expect(slugs).toContain("hr");
    expect(slugs).toContain("sales");

    /* ── AND NO BRANDED LOGIN FORM EITHER ──────────────────────────────
       `/api/public/departments/:slug` backs a department's own sign-in page. A
       404 is the same answer an unknown slug gets, so the public surface says
       nothing about Board existing. */
    const one = await get("/api/public/departments/board");
    expect(one.status).toBe(404);
    expect(JSON.stringify(one.body)).not.toMatch(/[Bb]oard/);

    /* The comparison that makes that meaningful: a department that IS public
       answers. */
    expect((await get("/api/public/departments/ceo")).status).toBe(200);
  });

  test("Board is still a grantable chip in Access Control", async () => {
    await ensureAccessDepartments(mongoose.connection);

    /* Access Control reads the authenticated admin route, which lists every
       row and does not filter on `showOnOnboarding` — so hiding Board from the
       public page cannot hide it from the person who grants it. */
    const r = await get("/api/admin/departments");
    expect(r.status).toBe(200);
    const board = r.body.departments.find((d) => d.slug === "board");
    expect(board).toBeTruthy();
    expect(board.name).toBe("Board");
    expect(board.isActive).toBe(true);
    expect(board.showOnOnboarding).toBe(false);
    /* Not external, so `PeoplePanel` renders it as an ordinary on/off chip
       rather than the account-owning control. */
    expect(board.externalBaseUrl).toBeFalsy();

    /* And the Executive Office is still its own separate chip beside it. */
    const exec = r.body.departments.find((d) => d.slug === "ceo");
    expect(exec.name).toBe("Executive Office");
    expect(exec.showOnOnboarding).toBe(true);
  });

  test("an eligible employee can still be given Board through Access Control", async () => {
    /* The end-to-end grant, on the routes the screen actually posts to: the
       department chip, then the role. Hiding the public tile must not have
       touched either. */
    await ensureAccessDepartments(mongoose.connection);
    const board = await AccessDepartment.findOne({ slug: TO_SLUG }).lean();
    const me = await person({ memberOf: [] });

    const deptRoles = require("../../services/departmentRoles");
    await Employee.updateOne(
      { _id: me.employeeId }, { $addToSet: { additionalDepartmentIds: board._id } },
    );
    await deptRoles.setRole({
      departmentSlug: TO_SLUG, email: me.email, name: "Person", role: "owner",
      actor: { _id: new mongoose.Types.ObjectId(), email: "admin@grav.test" },
    });

    expect(await holdsBoardDepartment(me.employeeId)).toBe(true);
    expect((await boardRoleOf(me.email)).role).toBe("owner");
    /* And the grant is real where it counts. */
    expect(await deptRoles.getEffectiveRole(TO_SLUG, { user: { email: me.email } }))
      .toBe("owner");
  });

  test("Board cannot be assigned to an external account", async () => {
    /* ── WHERE THIS IS ENFORCED ────────────────────────────────────────
       `ExternalPersonForm` offers exactly `externalCapableModules()`, which
       filters on `supportsExternal`. Board declares false, so it is not one of
       the choices — there is no Board branch to bypass. That half is asserted
       in the frontend's `moduleRoles.test.mjs`, which can load the registry.

       This is the half that matters on the server, and it is stronger than a
       flag: Board membership lives on the EMPLOYEE document, so an account with
       no employee record cannot hold the department however its role row came
       to exist. A stray role row is not a Board member. */
    await ensureAccessDepartments(mongoose.connection);
    await DepartmentRole.create({
      departmentSlug: TO_SLUG, email: "outsider@example.com", name: "Outsider",
      role: "owner", isActive: true,
    });
    expect(await Employee.countDocuments({ email: "outsider@example.com" })).toBe(0);
    const board = await AccessDepartment.findOne({ slug: TO_SLUG }).lean();
    const members = await Employee.find({
      $or: [{ accessDepartmentId: board._id }, { additionalDepartmentIds: board._id }],
    }).lean();
    expect(members).toEqual([]);
  });
});

/* ═══ 2 · THREE PEOPLE, THREE DIFFERENT ANSWERS ═══════════════════════════ */

describe("who the migration preserves, and who it does not", () => {
  test("an active explicit ceo role is copied, with Board membership", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "approver" });

    const out = await applyBoardSplit(models());
    expect(out.outcome).toBe("MIGRATED");
    expect(isSafe(out)).toBe(true);

    /* The role, at the same rank. A copy, not a promotion and not a demotion. */
    const copied = await boardRoleOf(holder.email);
    expect(copied).toBeTruthy();
    expect(copied.role).toBe("approver");
    expect(copied.isActive).toBe(true);
    /* And the membership, so Access Control shows them the Board chip and the
       switcher's grant check passes. */
    expect(await holdsBoardDepartment(holder.employeeId)).toBe(true);
  });

  test("Executive Office membership with no role gets nothing", async () => {
    await seedExecutive();
    await seedBoard();
    /* ── WHY THIS IS THE RIGHT BOUNDARY ────────────────────────────────
       `boardAccess.js` has always required an explicit role, so this person was
       ALREADY refused by Board. Giving them a Board grant now would not be
       preserving access — it would be granting it, quietly, to whoever happened
       to hold the executive department. */
    const bystander = await person({ memberOf: ["ceo"] });

    await applyBoardSplit(models());

    expect(await boardRoleOf(bystander.email)).toBeNull();
    expect(await holdsBoardDepartment(bystander.employeeId)).toBe(false);
  });

  test("an inactive ceo role gets nothing", async () => {
    await seedExecutive();
    await seedBoard();
    /* Revocation deactivates rather than deletes. A grant somebody took away
       stays taken away. */
    const revoked = await person({ memberOf: ["ceo"], role: "owner", roleActive: false });

    await applyBoardSplit(models());

    expect(await boardRoleOf(revoked.email)).toBeNull();
    expect(await holdsBoardDepartment(revoked.employeeId)).toBe(false);
    /* The inactive row itself is untouched — still there, still inactive. */
    const exec = await execRoleOf(revoked.email);
    expect(exec.role).toBe("owner");
    expect(exec.isActive).toBe(false);
  });

  test("all three at once, so the migration is telling them apart", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "owner" });
    const bystander = await person({ memberOf: ["ceo"] });
    const revoked = await person({ memberOf: ["ceo"], role: "approver", roleActive: false });

    const out = await applyBoardSplit(models());
    expect(out.rolesCopied).toBe(1);
    expect(out.membershipsAdded).toBe(1);

    expect((await boardRoleOf(holder.email)).role).toBe("owner");
    expect(await boardRoleOf(bystander.email)).toBeNull();
    expect(await boardRoleOf(revoked.email)).toBeNull();
    expect(await AccessDepartment.countDocuments({ slug: TO_SLUG })).toBe(1);
  });

  test("a role with no isActive field at all counts as active", async () => {
    /* The field defaults to true, so the oldest rows have no value — asking for
       `isActive: true` would silently skip a founding director's grant. */
    await seedExecutive();
    await seedBoard();
    const old = await person({ memberOf: ["ceo"], role: "owner" });
    await DepartmentRole.collection.updateOne(
      { departmentSlug: FROM_SLUG, email: old.email }, { $unset: { isActive: "" } },
    );

    await applyBoardSplit(models());
    expect((await boardRoleOf(old.email)).role).toBe("owner");
  });
});

/* ═══ 3 · THE EXECUTIVE OFFICE IS NOT TOUCHED ═════════════════════════════ */

describe("nothing about ceo changes", () => {
  test("the source row keeps its rank, its active flag and its existence", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "owner" });

    await applyBoardSplit(models());

    const exec = await execRoleOf(holder.email);
    expect(exec).toBeTruthy();
    expect(exec.role).toBe("owner");
    expect(exec.isActive).toBe(true);
    expect(await DepartmentRole.countDocuments({ departmentSlug: FROM_SLUG })).toBe(1);
  });

  test("HR and fulfilment still read ceo, deliberately", async () => {
    /* ── THE READERS THAT ARE STAYING ──────────────────────────────────
       What THEY mean is "an executive may read this", which is the Executive
       Office. Moving them would change who can see HR and fulfilment, which is
       not what this task was. */
    for (const rel of ["services/access/hrAccess.js", "services/access/fulfilmentAccess.js"]) {
      expect(await repo(rel)).toMatch(/BOARD_DEPT_SLUGS = new Set\(\["ceo"\]\)/);
    }
  });

  test("Executive Office membership is left exactly as it was", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "approver" });

    await applyBoardSplit(models());

    const exec = await AccessDepartment.findOne({ slug: FROM_SLUG }).lean();
    const emp = await Employee.findById(holder.employeeId).lean();
    /* Board was ADDED. The executive grant is still there, and the primary
       department — the dashboard they land on when they sign in — is unchanged. */
    expect((emp.additionalDepartmentIds || []).map(String)).toContain(String(exec._id));
    expect(emp.accessDepartmentId).toBeNull();
  });
});

/* ═══ 4 · SAFE TO RUN TWICE ═══════════════════════════════════════════════ */

describe("idempotence", () => {
  test("a second run writes nothing and duplicates nothing", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "approver" });

    const first = await applyBoardSplit(models());
    expect(first.rolesCopied).toBe(1);
    expect(first.membershipsAdded).toBe(1);

    const second = await applyBoardSplit(models());
    expect(second.outcome).toBe("ALREADY_MIGRATED");
    expect(second.rolesCopied).toBe(0);
    expect(second.membershipsAdded).toBe(0);

    /* One role row, one membership entry. The unique index would refuse a
       duplicate role; `$addToSet` is what keeps the array from growing. */
    expect(await DepartmentRole.countDocuments({ departmentSlug: TO_SLUG })).toBe(1);
    const emp = await Employee.findById(holder.employeeId).lean();
    const board = await AccessDepartment.findOne({ slug: TO_SLUG }).lean();
    expect(emp.additionalDepartmentIds.filter((id) => String(id) === String(board._id)).length)
      .toBe(1);
  });

  test("a second run changes nothing at all, byte for byte", async () => {
    /* ── THE STRONGEST FORM OF THE CLAIM ───────────────────────────────
       Not "it reports nothing to do" — everything the migration can touch,
       photographed before and after, and compared. A rerun that quietly
       rewrote a name, a departmentId or an ordering would pass a counting
       assertion and fail this one. */
    await seedExecutive();
    await seedBoard();
    await person({ memberOf: ["ceo"], role: "owner" });
    await person({ memberOf: ["ceo"], role: "viewer" });
    await person({ memberOf: ["ceo"] });

    const first = await applyBoardSplit(models());
    expect(first.outcome).toBe("MIGRATED");

    const snapshot = async () => JSON.stringify({
      roles: await DepartmentRole.find({}).select("-_id -__v -createdAt -updatedAt")
        .sort({ departmentSlug: 1, email: 1 }).lean(),
      employees: await Employee.find({})
        .select("email accessDepartmentId additionalDepartmentIds -_id")
        .sort({ email: 1 }).lean(),
      departments: await AccessDepartment.find({})
        .select("slug showOnOnboarding isActive -_id").sort({ slug: 1 }).lean(),
    });

    const before = await snapshot();
    const second = await applyBoardSplit(models());
    const after = await snapshot();

    expect(second.outcome).toBe("ALREADY_MIGRATED");
    expect(second.rolesCopied).toBe(0);
    expect(second.membershipsAdded).toBe(0);
    expect(second.hiddenFromOnboarding).toBe(0);
    expect(after).toEqual(before);

    /* A third, for the same money. */
    await applyBoardSplit(models());
    expect(await snapshot()).toEqual(before);
  });

  test("a rerun does not overrule a later administrator decision", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "owner" });
    await applyBoardSplit(models());

    /* An administrator demotes them on the Board afterwards. */
    await DepartmentRole.updateOne(
      { departmentSlug: TO_SLUG, email: holder.email }, { $set: { role: "viewer" } },
    );

    await applyBoardSplit(models());
    expect((await boardRoleOf(holder.email)).role).toBe("viewer");
  });

  test("a rerun does not restore a Board department grant somebody removed", async () => {
    /* Idempotence is "changes nothing the second time", not "reasserts itself".
       An administrator who takes the Board chip off a row has made a decision. */
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "approver" });
    await applyBoardSplit(models());

    const board = await AccessDepartment.findOne({ slug: TO_SLUG }).lean();
    await Employee.updateOne(
      { _id: holder.employeeId }, { $pull: { additionalDepartmentIds: board._id } },
    );

    await applyBoardSplit(models());
    expect(await holdsBoardDepartment(holder.employeeId)).toBe(false);
  });

  test("planning twice reports the same thing and writes nothing", async () => {
    await seedExecutive();
    await seedBoard();
    await person({ memberOf: ["ceo"], role: "approver" });

    const a = await planBoardSplit(models());
    const b = await planBoardSplit(models());
    expect(a.outcome).toBe("WILL_MIGRATE");
    expect(b.outcome).toBe("WILL_MIGRATE");
    expect(await DepartmentRole.countDocuments({ departmentSlug: TO_SLUG })).toBe(0);
  });
});

/* ═══ 5 · WHEN IT CANNOT BE DONE SAFELY, IT REFUSES ═══════════════════════ */

describe("refusals, and no fallback", () => {
  test("no board department means refuse, not proceed", async () => {
    await seedExecutive();
    const holder = await person({ memberOf: ["ceo"], role: "owner" });

    const out = await applyBoardSplit(models());
    expect(out.outcome).toBe("NO_BOARD_DEPARTMENT");
    expect(isSafe(out)).toBe(false);
    expect(explain(out)).toMatch(/REFUSING/);
    expect(explain(out)).toMatch(/ensureAccessDepartments/);

    /* ── AND IT WROTE NOTHING ──────────────────────────────────────────
       A half-migrated database that looks migrated is worse than one that
       plainly is not. */
    expect(await boardRoleOf(holder.email)).toBeNull();
    expect(await DepartmentRole.countDocuments({ departmentSlug: TO_SLUG })).toBe(0);
  });

  test("two employees sharing an address means refuse, not guess", async () => {
    await seedExecutive();
    await seedBoard();
    const holder = await person({ memberOf: ["ceo"], role: "owner" });
    /* A data problem, not something to try harder at: picking one would hand a
       Board seat to a person nobody named. */
    await Employee.create({
      firstName: "Twin", lastName: "Two", email: holder.email, biometricId: `TW${++seq}`,
      isActive: true, gender: "Other", department: "Tech",
    });

    const out = await applyBoardSplit(models());
    expect(out.outcome).toBe("AMBIGUOUS_EMPLOYEE");
    expect(isSafe(out)).toBe(false);
    expect(explain(out)).toMatch(/Refusing to guess/);
    expect(await boardRoleOf(holder.email)).toBeNull();
  });

  test("a role holder with no employee record means refuse, not proceed", async () => {
    await seedExecutive();
    await seedBoard();
    /* ── WHY THIS IS NOT A SKIP ────────────────────────────────────────
       Board access is a role AND the board department on an EMPLOYEE record.
       An address with no record cannot hold the second half, so copying the
       role alone would write a seat that never works — and reporting success
       would say everybody was migrated when somebody was not. */
    await DepartmentRole.create({
      departmentSlug: FROM_SLUG, email: "ghost@grav.test", name: "Ghost",
      role: "approver", isActive: true,
    });

    const out = await applyBoardSplit(models());
    expect(out.outcome).toBe(REFUSALS.UNRESOLVED_EMPLOYEE);
    expect(isSafe(out)).toBe(false);
    expect(out.unresolved).toEqual([{ email: "ghost@grav.test", reason: "NO_EMPLOYEE_RECORD" }]);
    /* Named, searchable, and it says what to do. */
    expect(explain(out)).toMatch(/REFUSING \[UNRESOLVED_EMPLOYEE\]/);
    expect(explain(out)).toMatch(/ghost@grav\.test/);
    expect(explain(out)).toMatch(/inventing no employee/);

    /* ── AND NOTHING PARTIAL WAS WRITTEN ───────────────────────────────
       Not the role, not a membership, not even the onboarding flag. */
    expect(await boardRoleOf("ghost@grav.test")).toBeNull();
    expect(await DepartmentRole.countDocuments({ departmentSlug: TO_SLUG })).toBe(0);
    expect(await Employee.countDocuments({ email: "ghost@grav.test" })).toBe(0);
  });

  test("one unresolvable person stops the whole run — nobody is half migrated", async () => {
    /* The failure a per-row skip would produce: the resolvable people migrate,
       the unresolvable one does not, and the run reports success. Then nobody
       goes back for them. */
    await seedExecutive();
    await seedBoard();
    const resolvable = await person({ memberOf: ["ceo"], role: "owner" });
    await DepartmentRole.create({
      departmentSlug: FROM_SLUG, email: "ghost@grav.test", name: "Ghost",
      role: "approver", isActive: true,
    });

    const out = await applyBoardSplit(models());
    expect(out.outcome).toBe(REFUSALS.UNRESOLVED_EMPLOYEE);
    expect(await boardRoleOf(resolvable.email)).toBeNull();
    expect(await holdsBoardDepartment(resolvable.employeeId)).toBe(false);
    expect(await DepartmentRole.countDocuments({ departmentSlug: TO_SLUG })).toBe(0);

    /* Resolve the address and the same run completes — the refusal was about
       the data, and it told somebody exactly which row to fix. */
    await Employee.create({
      firstName: "G", lastName: "Host", email: "ghost@grav.test", biometricId: `GH${++seq}`,
      isActive: true, gender: "Other", department: "Tech",
    });
    const again = await applyBoardSplit(models());
    expect(again.outcome).toBe("MIGRATED");
    expect(again.rolesCopied).toBe(2);
    expect(again.membershipsAdded).toBe(2);
  });

  test("a refused migration leaves Board shut, and says BOARD_NOT_READY", async () => {
    /* ── THE TWO SENTENCES THAT MUST NOT BE CONFUSED ───────────────────
       "We cannot work out who is on the Board" is not "you are not on the
       Board". The second one is a lie that gets an administrator to restore
       the `ceo` fallback. */
    await seedExecutive();
    await seedBoard();
    await DepartmentRole.create({
      departmentSlug: FROM_SLUG, email: "ghost@grav.test", name: "Ghost",
      role: "approver", isActive: true,
    });

    boardReadiness.arm();
    const { migrateBoardDepartment } = require("../../scripts/migrations/board-department-split");
    let thrown = null;
    try { await migrateBoardDepartment(); } catch (err) { thrown = err; }

    expect(thrown).toBeTruthy();
    expect(thrown.code).toBe(REFUSALS.UNRESOLVED_EMPLOYEE);
    boardReadiness.markFailed(thrown);

    const status = boardReadiness.status();
    expect(status.state).toBe("failed");
    expect(status.code).toBe(REFUSALS.UNRESOLVED_EMPLOYEE);

    const r = await gateThrough();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("BOARD_NOT_READY");
    expect(r.body.diagnostic).toBe(REFUSALS.UNRESOLVED_EMPLOYEE);
    expect(JSON.stringify(r.body)).not.toMatch(/NO_BOARD_GRANT/);
    expect(r.body.message).toMatch(/no fallback has been applied/);

    /* And the authority still has exactly one answer. */
    const src = await repo("services/board/boardAccess.js");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/"ceo"/);
    boardReadiness._reset();
  });

  test("the boot entry point throws on a refusal rather than returning quietly", async () => {
    await seedExecutive();
    await person({ memberOf: ["ceo"], role: "owner" });
    const { migrateBoardDepartment } = require("../../scripts/migrations/board-department-split");
    await expect(migrateBoardDepartment()).rejects.toThrow(/REFUSING/);
  });

  test("nothing anywhere in the migration falls back to ceo", async () => {
    const src = await repo("scripts/migrations/board-department-split.js");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* It READS `ceo` — that is its job. What it must never do is write one,
       deactivate one, or delete one. */
    expect(code).not.toMatch(/departmentSlug: FROM_SLUG[^)]*\$set/);
    expect(code).not.toMatch(/deleteOne|deleteMany|findOneAndDelete/);
    expect(code).not.toMatch(/isAdmin/);
  });
});

/* ═══ 6 · BOARD DOES NOT ANSWER UNTIL THE GRANT EXISTS ════════════════════ */

describe("the readiness gate", () => {
  afterEach(() => boardReadiness._reset());

  const gateStatus = gateThrough;

  test("while the migration is still running, Board says so — and does not say NO_BOARD_GRANT", async () => {
    boardReadiness.arm();
    const r = await gateStatus();
    expect(r.status).toBe(503);
    expect(r.body.code).toBe("BOARD_NOT_READY");
    /* ── WHY THIS MATTERS MORE THAN IT LOOKS ───────────────────────────
       The wrong answer here is "you have no Board grant". A director reads that
       as broken access, asks an administrator to fix it, and the fix somebody
       reaches for is `ceo || board` in the guard. */
    expect(JSON.stringify(r.body)).not.toMatch(/NO_BOARD_GRANT/);
    expect(r.body.message).toMatch(/not a problem with your access/);
  });

  test("once it has run, requests go through", async () => {
    boardReadiness.arm();
    boardReadiness.markReady();
    const r = await gateStatus();
    expect(r.status).toBe(200);
    expect(r.body.through).toBe(true);
  });

  test("if it refused, Board stays shut with the reason and nothing is granted", async () => {
    boardReadiness.arm();
    boardReadiness.markFailed(new Error("no board department on this database"));
    const r = await gateStatus();
    expect(r.status).toBe(503);
    expect(r.body.reason).toBe("MIGRATION_FAILED");
    expect(r.body.detail).toMatch(/no board department/);
    expect(r.body.message).toMatch(/no fallback has been applied/);
  });

  test("server.js arms it, runs the migration, and gates Board with it", async () => {
    const src = await repo("server.js");
    expect(src).toMatch(/boardReadiness\.arm\(\)/);
    expect(src).toMatch(/migrateBoardDepartment/);
    expect(src).toMatch(/boardReadiness\.markReady\(\)/);
    expect(src).toMatch(/boardReadiness\.markFailed\(err\)/);

    /* ── ORDER IS THE WHOLE POINT ──────────────────────────────────────
       The gate has to be mounted BEFORE the router, or the router answers
       first and the gate is decoration. */
    const gate = src.indexOf('app.use("/api/cms/board/policies", boardReadiness.requireBoardReady)');
    const router = src.indexOf('app.use("/api/cms/board/policies", require("./routes/CMS_Routes/Board/policies"))');
    expect(gate).toBeGreaterThan(-1);
    expect(router).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(router);

    /* And the migration runs after the seeder, because it needs the department
       the seeder registers. */
    const seed = src.indexOf("await ensureAccessDepartments(mongoose.connection)");
    expect(seed).toBeLessThan(src.indexOf("migrateBoardDepartment"));
  });
});
