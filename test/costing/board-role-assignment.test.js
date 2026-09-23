// test/costing/board-role-assignment.test.js
//
// THE BOARD ROLE IS ASSIGNABLE THROUGH ACCESS CONTROL, AND STILL REQUIRED.
//
// ── THE BUG ─────────────────────────────────────────────────────────────────
// `boardAccess.js` requires an explicit `DepartmentRole` on the Board
// department. That is correct and it was unreachable:
// `components/access/moduleRoles.js` did not register the role family, so no
// screen could write the row the guard asks for. Everybody was refused with
// `BOARD_ACCESS_REQUIRED / NO_BOARD_GRANT`.
//
// ── AND THE SECOND BUG ──────────────────────────────────────────────────────
// The row was written against `ceo`, so the Executive Office and the Board were
// one grant. They are separate applications, and the separation is asserted in
// both directions here: an active `ceo` role is not a Board role, and a Board
// role is not the executive dashboard.
//
// ── WHAT THIS SUITE DEFENDS ─────────────────────────────────────────────────
// The fix is the assignment screen, NOT a looser guard. So these tests pin
// both halves at once: the admin route writes the row Board reads, and every
// way of *nearly* having Board access still fails.
//
//   membership ≠ role. admin ≠ role. tile ≠ role. another department ≠ role.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const deptRoles = require("../../services/departmentRoles");

let server, base, rs, seq = 0;

/**
 * The admin surface, mounted with a stand-in for `requirePlatformAdmin`.
 *
 * The real guard reads a platform-admin record; what matters here is what the
 * ROUTE does once past it, and that it is the same generic route every other
 * department already uses. Access Control's own protection is unchanged and is
 * asserted separately below, on the source.
 */
beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_roles" });

  const app = express();
  app.use(express.json());

  /* The one admin endpoint under test, wired to the same service the real
     route calls — so the one-Owner demotion and the change log are the real
     ones rather than a re-implementation. */
  app.put("/api/admin/department-roles/:slug", async (req, res) => {
    try {
      const { email, name, role } = req.body || {};
      const result = await deptRoles.setRole({
        departmentSlug: req.params.slug,
        email, name, role: role || null,
        actor: { _id: new mongoose.Types.ObjectId(), email: "admin@grav.test" },
      });
      res.json({ success: true, role: result.role });
    } catch (err) {
      res.status(400).json({ success: false, message: err.message });
    }
  });
  app.get("/api/admin/department-roles/:slug", async (req, res) => {
    res.json({ success: true, holders: await deptRoles.listRoles(req.params.slug) });
  });

  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await BoardPolicy.init();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * A department row, created on demand.
 *
 * Real rows rather than stand-in ids, because membership is an ObjectId
 * reference and a fabricated one would make "holds the Executive Office" and
 * "holds Board" indistinguishable — which is the exact confusion these tests
 * exist to rule out. Per-call rather than once in `beforeAll` because
 * `test/setup.js` empties every collection after each test. The seeder's own
 * wording is asserted in `board-department-split.test.js`.
 */
const DEPT_SEED = {
  ceo: { key: "ceo", name: "Executive Office", dashboardPath: "/ceo/dashboard" },
  board: { key: "board", name: "Board", dashboardPath: "/board/dashboard/policies/financing" },
};

const deptRow = (slug) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, ...DEPT_SEED[slug] } },
  { upsert: true, new: true },
).lean();

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

/**
 * A person, their company membership, and their department grants.
 *
 * `grants` is what Access Control writes. `isAdmin` is a separate, deliberate
 * choice, and so is holding a DEPARTMENT with no role in it — which is the exact
 * state the bug left everybody in.
 *
 * `departments` are department MEMBERSHIPS, which are a different fact from a
 * role and are what the Executive-Office/Board independence tests turn on.
 */
async function person({ companies = [], grants = {}, departments = [], isAdmin = false } = {}) {
  const n = ++seq;
  const email = `br${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "B", lastName: `R${n}`, email, biometricId: `BR${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "B" });
  }
  if (departments.length) {
    const rows = [];
    for (const slug of departments) rows.push(await deptRow(slug));
    await Employee.updateOne(
      { _id: emp._id },
      { $set: { additionalDepartmentIds: rows.map((r) => r._id) } },
    );
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    employeeId: emp._id,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Person ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * The Board department chip, granted on somebody's row.
 *
 * Kept apart from `assign` deliberately: Access Control performs two acts — the
 * department, then the role — and `services/board/boardAccess.js` requires
 * both. A helper that did them together could not express "membership with no
 * role" or "a role row with no membership", which are two of the cases this
 * suite exists to pin.
 */
async function onBoard(me) {
  const dept = await deptRow("board");
  await Employee.updateOne(
    { _id: me.employeeId }, { $addToSet: { additionalDepartmentIds: dept._id } },
  );
  return me;
}

/** What Access Control does when an administrator picks a Board role. */
const assign = (email, role) => call("/api/admin/department-roles/board", {
  method: "PUT", body: { email, name: "User", role },
});

/** Both acts, in the order the screen performs them. */
const giveBoard = async (me, role) => {
  await onBoard(me);
  return assign(me.email, role);
};

/** The same control, on the Executive Office row. A different application. */
const assignExecutive = (email, role) => call("/api/admin/department-roles/ceo", {
  method: "PUT", body: { email, name: "User", role },
});

const METHODOLOGY = {
  annualRatePercent: "12", basis: "SUBTOTAL_BEFORE_FINANCING",
  advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
};

const read = (me, co) => call("/FINANCING", { token: me.token, company: co._id })
  .then((r) => r);
const draft = (me, co) => call("/FINANCING/drafts", {
  method: "POST", token: me.token, company: co._id, body: { financing: METHODOLOGY },
});
const approve = (me, co, id) => call(`/FINANCING/drafts/${id}/approve`, {
  method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
});

/* The Board router is mounted under its own prefix in this app. */
const boardCall = (path, opts) => call(`/api/cms/board/policies${path}`, opts);
const boardRead = (me, co) => boardCall("/FINANCING", { token: me.token, company: co._id });
const boardDraft = (me, co) => boardCall("/FINANCING/drafts", {
  method: "POST", token: me.token, company: co._id, body: { financing: METHODOLOGY },
});
const boardApprove = (me, co, id) => boardCall(`/FINANCING/drafts/${id}/approve`, {
  method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
});

/* ═══ 1 · NEARLY HAVING BOARD ACCESS IS NOT HAVING IT ═════════════════════ */

describe("what does not grant a Board role", () => {
  test("Board department membership with no Board role is refused", async () => {
    /* ── THE STATE THE BUG LEFT EVERYBODY IN ───────────────────────────
       An administrator has said this person belongs on the Board and has not yet
       said what they may do. The refusal is CORRECT and stays — which is also
       why the switcher must not offer them the app. */
    const co = await company("MemberOnly");
    const me = await person({ companies: [co], departments: ["board"] });

    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
    expect(r.body.error.details.departmentSlug).toBe("board");
  });

  test("Executive Office membership is refused, exactly as no grant at all is", async () => {
    /* ── THE COUPLING THIS SUITE NOW PINS OPEN ─────────────────────────
       Holding the Executive Office is not being on the Board. The refusal must
       be the SAME refusal somebody with no access whatsoever gets — not a
       different code, not a softer one, and above all not an allowance. */
    const co = await company("ExecMember");
    const exec = await person({ companies: [co], departments: ["ceo"] });
    const nobody = await person({ companies: [co] });

    const a = await boardRead(exec, co);
    const b = await boardRead(nobody, co);
    expect(a.status).toBe(403);
    expect(a.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
    expect(a.body.error.details.reason).toBe("NO_BOARD_GRANT");
    expect(a.body.error.details).toEqual(b.body.error.details);
  });

  test("an active executive ROLE is not a Board role either", async () => {
    /* The stronger case: not just membership but the `ceo` role itself, which
       is what `hrAccess.js` and `fulfilmentAccess.js` read for board-level
       visibility of HR and fulfilment. It is still not Board. */
    const co = await company("ExecRole");
    const me = await person({ companies: [co], departments: ["ceo"] });
    const set = await assignExecutive(me.email, "owner");
    expect(set.status).toBe(200);

    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("a platform administrator is still refused", async () => {
    const co = await company("AdminOnly");
    const me = await person({ companies: [co], isAdmin: true });
    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("owning another department is still refused", async () => {
    const co = await company("OtherOwner");
    const me = await person({ companies: [co], grants: { sales: "owner", store: "owner", hr: "owner" } });
    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("a Board role with no Board department is refused", async () => {
    /* ── THE OTHER HALF, AND THE STALE ROW IT GUARDS AGAINST ───────────
       Access Control writes two things, and `boardAccess.js` requires both.
       A role row surviving a withdrawn department is a row, not a Board member
       — and the same rule is what keeps Board off an account with no HR record,
       because membership lives on the EMPLOYEE document. */
    const co = await company("RoleOnly");
    const me = await person({ companies: [co] });
    const set = await assign(me.email, "owner");
    expect(set.status).toBe(200);

    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");

    /* The row is there and active; it is simply not enough on its own. */
    const row = await DepartmentRole.findOne({ departmentSlug: "board", email: me.email }).lean();
    expect(row.role).toBe("owner");
    expect(row.isActive).toBe(true);

    /* Add the chip an administrator would also have clicked, and the same
       token works — nothing else changed. */
    await onBoard(me);
    expect((await boardRead(me, co)).status).toBe(200);
  });

  test("withdrawing the department revokes Board, on the same token", async () => {
    const co = await company("ChipPulled");
    const me = await person({ companies: [co] });
    await giveBoard(me, "owner");
    expect((await boardRead(me, co)).status).toBe(200);

    const dept = await deptRow("board");
    await Employee.updateOne(
      { _id: me.employeeId }, { $pull: { additionalDepartmentIds: dept._id } },
    );

    const after = await boardRead(me, co);
    expect(after.status).toBe(403);
    expect(after.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("an inactive board row is not a role", async () => {
    /* Revocation deactivates rather than deletes, so the row still exists. */
    const co = await company("Inactive");
    const me = await person({ companies: [co], grants: { board: "owner" } });
    await DepartmentRole.updateOne(
      { email: me.email, departmentSlug: "board" }, { $set: { isActive: false } },
    );
    const r = await boardRead(me, co);
    expect(r.status).toBe(403);
  });
});

/* ═══ 2 · ASSIGNING ONE THROUGH ACCESS CONTROL ════════════════════════════ */

describe("an administrator sets the role, and Board honours it", () => {
  test("the admin route writes the board DepartmentRole Board reads", async () => {
    const co = await company("Assign");
    const me = await person({ companies: [co] });
    await DepartmentRole.deleteMany({ email: me.email, departmentSlug: "board" });

    expect((await boardRead(me, co)).status).toBe(403);

    const set = await giveBoard(me, "viewer");
    expect(set.status).toBe(200);
    expect(set.body.role).toBe("viewer");

    /* The same row, by the same name Board's guard looks it up under. */
    const row = await DepartmentRole.findOne({ departmentSlug: "board", email: me.email }).lean();
    expect(row.role).toBe("viewer");
    expect(row.isActive).toBe(true);

    /* ── AND IT TAKES EFFECT ON THE NEXT REQUEST ───────────────────────
       Same token, no new sign-in: `getEffectiveRole` re-reads the grant on
       every request rather than trusting a seven-day JWT. */
    const after = await boardRead(me, co);
    expect(after.status).toBe(200);
  });

  test("viewer may read, and may neither draft nor approve", async () => {
    const co = await company("Viewer");
    const me = await person({ companies: [co] });
    await giveBoard(me, "viewer");

    const r = await boardRead(me, co);
    expect(r.status).toBe(200);
    expect(r.body.can).toEqual({ draft: false, approve: false });
    expect((await boardDraft(me, co)).status).toBe(403);
  });

  test("editor may draft, and may not approve", async () => {
    const co = await company("Editor");
    const me = await person({ companies: [co] });
    await giveBoard(me, "editor");

    const made = await boardDraft(me, co);
    expect(made.status).toBe(201);

    /* ── DRAFTING AND APPROVING ARE DIFFERENT RANKS ────────────────────
       A policy whose author is always its approver has a review step in name
       only, which is why Access Control offers them as two roles. */
    const r = await boardApprove(me, co, made.body.version._id);
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("INSUFFICIENT_BOARD_ROLE");
  });

  test("approver may approve", async () => {
    const co = await company("Approver");
    const me = await person({ companies: [co] });
    await giveBoard(me, "approver");

    const made = await boardDraft(me, co);
    expect(made.status).toBe(201);
    const ok = await boardApprove(me, co, made.body.version._id);
    expect(ok.status).toBe(200);
    expect(ok.body.version.status).toBe("BOARD_APPROVED");
    expect(ok.body.version.approvedByActorName).toBeTruthy();
  });

  test("owner has full control", async () => {
    const co = await company("Owner");
    const me = await person({ companies: [co] });
    await giveBoard(me, "owner");

    const r = await boardRead(me, co);
    expect(r.body.can).toEqual({ draft: true, approve: true });
    const made = await boardDraft(me, co);
    expect(made.status).toBe(201);
    expect((await boardApprove(me, co, made.body.version._id)).status).toBe(200);
  });
});

/* ═══ 3 · CHANGING AND REVOKING ═══════════════════════════════════════════ */

describe("a role can be changed and taken away", () => {
  test("revocation takes effect on the next request, with no new sign-in", async () => {
    const co = await company("Revoke");
    const me = await person({ companies: [co] });
    await giveBoard(me, "approver");
    expect((await boardRead(me, co)).status).toBe(200);

    /* `role: null` is what the dropdown's "— No board access —" sends. */
    const off = await assign(me.email, null);
    expect(off.status).toBe(200);

    /* The SAME token. Nothing was re-issued, and nothing cached the grant. */
    const after = await boardRead(me, co);
    expect(after.status).toBe(403);
    expect(after.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("demotion takes effect on the next request too", async () => {
    const co = await company("Demote");
    const me = await person({ companies: [co] });
    await giveBoard(me, "approver");
    const made = await boardDraft(me, co);
    expect(made.status).toBe(201);

    await assign(me.email, "viewer");
    /* Same token, and the act they could perform a moment ago is refused. */
    expect((await boardApprove(me, co, made.body.version._id)).status).toBe(403);
    expect((await boardRead(me, co)).status).toBe(200);
  });

  test("promoting an Owner demotes the incumbent to Approver", async () => {
    /* The generic one-Owner rule, which Board inherits by using the same
       store — not a second implementation. */
    const co = await company("OneOwner");
    const first = await person({ companies: [co] });
    const second = await person({ companies: [co] });
    await giveBoard(first, "owner");
    await giveBoard(second, "owner");

    const rows = Object.fromEntries(
      (await DepartmentRole.find({ departmentSlug: "board" }).lean())
        .filter((r) => [first.email, second.email].includes(r.email))
        .map((r) => [r.email, r.role]),
    );
    expect(rows[second.email]).toBe("owner");
    expect(rows[first.email]).toBe("approver");

    /* And the demoted one can still approve, which is what Approver means. */
    const made = await boardDraft(first, co);
    expect((await boardApprove(first, co, made.body.version._id)).status).toBe(200);
  });

  test("the role is scoped to board and touches no other department", async () => {
    const co = await company("Scoped");
    const me = await person({ companies: [co], grants: { sales: "viewer" } });
    await giveBoard(me, "owner");

    const sales = await DepartmentRole.findOne({ departmentSlug: "sales", email: me.email }).lean();
    expect(sales.role).toBe("viewer");
    const all = await DepartmentRole.find({ email: me.email }).lean();
    expect(all.map((r) => r.departmentSlug).sort()).toEqual(["board", "sales"]);
  });

  test("revoking Board leaves the Executive Office exactly as it was", async () => {
    /* ── THE WHOLE POINT OF THE SPLIT ──────────────────────────────────
       One grant meant one revocation. Taking Board away must not cost somebody
       the executive dashboard, and it must not touch the `ceo` role that
       `hrAccess.js` and `fulfilmentAccess.js` read. */
    const co = await company("RevokeIndependent");
    const me = await person({ companies: [co], departments: ["ceo", "board"] });
    await assignExecutive(me.email, "owner");
    await assign(me.email, "owner");

    const off = await assign(me.email, null);
    expect(off.status).toBe(200);

    /* Board is gone. */
    expect((await boardRead(me, co)).status).toBe(403);
    /* The Executive Office is not. */
    const exec = await DepartmentRole.findOne({ departmentSlug: "ceo", email: me.email }).lean();
    expect(exec.role).toBe("owner");
    expect(exec.isActive).toBe(true);
    /* And both memberships are still there — a role is not a membership. */
    const emp = await Employee.findById(me.employeeId).lean();
    const held = await AccessDepartment.find({
      _id: { $in: emp.additionalDepartmentIds || [] },
    }).lean();
    expect(held.map((d) => d.slug).sort()).toEqual(["board", "ceo"]);
  });

  test("revoking the Executive Office leaves Board exactly as it was", async () => {
    const co = await company("RevokeExec");
    const me = await person({ companies: [co], departments: ["ceo", "board"] });
    await assignExecutive(me.email, "owner");
    await assign(me.email, "approver");

    expect((await assignExecutive(me.email, null)).status).toBe(200);

    /* Board is untouched, and still works on the same token. */
    const board = await DepartmentRole.findOne({ departmentSlug: "board", email: me.email }).lean();
    expect(board.role).toBe("approver");
    expect(board.isActive).toBe(true);
    const made = await boardDraft(me, co);
    expect(made.status).toBe(201);
    expect((await boardApprove(me, co, made.body.version._id)).status).toBe(200);
  });

  test("promoting a Board Owner demotes the previous Board Owner only", async () => {
    /* The one-Owner rule is generic on `departmentSlug`, so it must not reach
       across into the Executive Office. */
    const co = await company("OwnerScope");
    const first = await person({ companies: [co] });
    const second = await person({ companies: [co] });
    await assignExecutive(first.email, "owner");
    await assign(first.email, "owner");
    await assign(second.email, "owner");

    const board = Object.fromEntries(
      (await DepartmentRole.find({ departmentSlug: "board" }).lean())
        .filter((r) => [first.email, second.email].includes(r.email))
        .map((r) => [r.email, r.role]),
    );
    expect(board[second.email]).toBe("owner");
    expect(board[first.email]).toBe("approver");

    /* The executive Owner is not demoted by a Board promotion. */
    const exec = await DepartmentRole.findOne({ departmentSlug: "ceo", email: first.email }).lean();
    expect(exec.role).toBe("owner");
  });
});

/* ═══ 4 · BOARD DOES NOT OPEN THE EXECUTIVE OFFICE ════════════════════════ */

describe("the independence runs the other way too", () => {
  test("a Board Owner is not an executive, so HR stays shut", async () => {
    /* ── THE READER THAT IS STAYING ON `ceo` ───────────────────────────
       `services/access/hrAccess.js` declares `BOARD_DEPT_SLUGS = new Set(["ceo"])`
       and means "an executive may read this". A Board seat is company policy, not
       board-level visibility of everybody's salary. */
    const co = await company("BoardOnly");
    const me = await person({ companies: [co], departments: ["board"] });
    await assign(me.email, "owner");
    expect((await boardRead(me, co)).status).toBe(200);

    const { resolveHrAccess } = require("../../services/access/hrAccess");
    const hr = await resolveHrAccess({ id: String(me.employeeId), email: me.email, role: "employee" });
    expect(hr.allowed).toBe(false);
    expect(hr.via).toBeNull();
  });

  test("a Board Owner does not get board-level fulfilment visibility", async () => {
    const co = await company("BoardOnlyFul");
    const me = await person({ companies: [co], departments: ["board"] });
    await assign(me.email, "owner");

    const ful = require("../../services/access/fulfilmentAccess");
    const src = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../services/access/fulfilmentAccess.js"), "utf8",
    );
    /* Asserted on the reader's own declaration, because that is where the
       boundary is stated — and it still says `ceo`. */
    expect(src).toMatch(/BOARD_DEPT_SLUGS = new Set\(\["ceo"\]\)/);
    expect(src).not.toMatch(/"board"/);
    expect(typeof ful).toBe("object");
  });

  test("an executive is still an executive, with no Board seat", async () => {
    /* The mirror of the test above: separating the two applications must not
       have cost the Executive Office anything it had. */
    const co = await company("ExecKeeps");
    const me = await person({ companies: [co], departments: ["ceo"] });
    await assignExecutive(me.email, "owner");

    const { resolveHrAccess } = require("../../services/access/hrAccess");
    const hr = await resolveHrAccess({ id: String(me.employeeId), email: me.email, role: "employee" });
    expect(hr.allowed).toBe(true);
    expect(hr.via).toBe("ceo");

    /* And Board is still shut. */
    expect((await boardRead(me, co)).status).toBe(403);
  });
});

/* ═══ 5 · COMPANY SCOPING IS UNCHANGED ════════════════════════════════════ */

describe("a Board role is not a passport to another company", () => {
  test("a Board Owner cannot reach another company's policies by naming it", async () => {
    /* ── HOW ISOLATION ACTUALLY WORKS HERE ─────────────────────────────
       `resolveCompanyForActor` decides which company this actor may act for; an
       unheld company in the header does not produce a 403, it produces THEIR
       company. So the claim worth asserting is not a status code — it is that no
       byte of the other company's decision comes back. */
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await person({ companies: [mine], departments: ["board"] });
    const them = await person({ companies: [theirs], departments: ["board"] });
    await assign(me.email, "owner");
    await assign(them.email, "owner");

    const made = await boardDraft(them, theirs);
    expect(made.status).toBe(201);
    const theirVersion = made.body.version._id;

    /* Asking for their company returns my own empty history, not theirs. */
    const asked = await boardCall("/FINANCING", { token: me.token, company: theirs._id });
    expect(asked.status).toBe(200);
    expect(asked.body.versions).toEqual([]);

    /* And naming their version directly is NOT FOUND — the same refusal a
       version that does not exist gets, so the answer confirms nothing. */
    const reach = await boardCall(`/FINANCING/drafts/${theirVersion}`, {
      method: "PUT", token: me.token, company: theirs._id, body: { revision: 1, rationale: "x" },
    });
    expect(reach.status).toBe(404);
    expect(reach.body.error.code).toBe("BOARD_POLICY_NOT_FOUND");
  });
});

/* ═══ 6 · THE GUARD ITSELF IS UNCHANGED ═══════════════════════════════════ */

describe("the fix was the screen, not the guard", () => {
  const read = (rel) => require("node:fs/promises")
    .readFile(require("node:path").resolve(__dirname, "../..", rel), "utf8");

  test("boardAccess still has no administrator bypass and no empty-list fallback", async () => {
    const src = await read("services/board/boardAccess.js");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    /* The two things `requireDepartmentRole` does that this guard must not. */
    expect(code).not.toMatch(/isAdmin/);
    expect(code).not.toMatch(/assigned\.length === 0/);
    expect(code).not.toMatch(/requireDepartmentRole/);
    /* Read per request, so a grant withdrawn five minutes ago cannot survive
       in a seven-day token — which is what makes revocation immediate. */
    expect(code).toMatch(/getEffectiveRole/);
    expect(code).toMatch(/BOARD_DEPT_SLUG = "board"/);
    /* ── AND NO COMPATIBILITY BRANCH ───────────────────────────────────
       A guard that accepts either slug hands Board to every executive for as
       long as the branch survives. The compatibility is the migration. */
    expect(code).not.toMatch(/"ceo"/);
  });

  test("the ranks each act needs are unchanged", async () => {
    const { BOARD_ACTS, canDo } = require("../../services/board/boardAccess");
    expect(BOARD_ACTS).toEqual({ read: "viewer", draft: "editor", approve: "approver" });
    expect(canDo("viewer", "read")).toBe(true);
    expect(canDo("viewer", "draft")).toBe(false);
    expect(canDo("editor", "approve")).toBe(false);
    expect(canDo("approver", "approve")).toBe(true);
    expect(canDo("owner", "approve")).toBe(true);
    expect(canDo(null, "read")).toBe(false);
  });

  test("Access Control itself is still platform-admin only", async () => {
    const src = await read("routes/Admin/accessAdmin.js");
    expect(src).toMatch(/every route behind requirePlatformAdmin/);
  });

  test("the admin route is the generic one, and audits every change", async () => {
    /* No second Board-role table and no second API — so the one-Owner rule,
       the audit entry and the change-log record are the existing ones. */
    const src = await read("routes/Admin/accessAdmin.js");
    expect(src).toMatch(/router\.put\("\/department-roles\/:slug"/);
    expect(src).toMatch(/audit\(req, "department-role"/);
    expect(src).toMatch(/recordChange\(req, \{/);
    expect(src).not.toMatch(/board-roles|BoardRole/);
  });
});
