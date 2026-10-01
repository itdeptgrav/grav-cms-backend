// test/costing/board-access-endpoint.test.js
//
// GET /api/cms/board/policies/access — THE ONE QUESTION A MENU ASKS.
//
// ── WHAT IT IS FOR ──────────────────────────────────────────────────────────
// `/api/auth/verify` answers with department TILES and carries no roles, so a
// switcher built from it can only know somebody was MEANT to be on the Board.
// Offering the app on that alone puts a tile in front of a person the app then
// refuses outright — which for a platform administrator is guaranteed, because
// `verify` hands an admin every active department.
//
// So the Board API is asked directly, exactly as the costing tile asks
// `/api/costings/access`.
//
// ── WHAT THIS SUITE PINS ────────────────────────────────────────────────────
// Two things, and they pull in opposite directions:
//
//   1. It must be ACCURATE. `allowed` is the same answer the Board app itself
//      will give — both halves of the grant, re-read from the database on this
//      request. A menu that disagrees with the app is worse than no menu.
//   2. It must say NOTHING ELSE. It is reachable by every authenticated
//      employee in the company, including people with no Board access at all,
//      so it must not become a thin door onto policy, other people, or which
//      companies exist.
//
// And it must never answer on the strength of `ceo`.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const deptRoles = require("../../services/departmentRoles");
const boardPolicy = require("../../services/board/boardPolicy.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_access" });

  const app = express();
  app.use(express.json());
  /* The production router, at the path `server.js` mounts it on. */
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

const call = (path, { token, company } = {}) =>
  fetch(`${base}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* The router is mounted under its own prefix, exactly as `server.js` mounts it. */
const boardCall = (path, opts) => call(`/api/cms/board/policies${path}`, opts);

const access = (me, company) =>
  boardCall("/access", { token: me?.token, company });

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

/** A department row, on demand — `test/setup.js` empties everything per test. */
const deptRow = (slug, name) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, key: slug, name: name || slug, dashboardPath: `/${slug}` } },
  { upsert: true, new: true },
).lean();

/**
 * A person, with membership and roles as two separate arguments.
 *
 * Separate on purpose: this whole suite is about telling "an administrator put
 * them on the Board" apart from "an administrator said what they may do", and a
 * helper that wrote both together could not express three of the cases below.
 */
async function person({ companies = [], memberOf = [], roles = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `ba${n}@grav.test`;
  const held = [];
  for (const slug of memberOf) held.push((await deptRow(slug))._id);

  const emp = await Employee.create({
    firstName: "A", lastName: `B${n}`, email, biometricId: `BA${n}`,
    isActive: true, gender: "Other", department: "Tech",
    additionalDepartmentIds: held,
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: "A",
    });
  }
  for (const [departmentSlug, role] of Object.entries(roles)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `Person ${n}`, role, isActive: true,
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

/** What Access Control does when an administrator picks a role. */
const setRole = (slug, email, role) => deptRoles.setRole({
  departmentSlug: slug, email, name: "User", role,
  actor: { _id: new mongoose.Types.ObjectId(), email: "admin@grav.test" },
});

/* ═══ 1 · AUTHENTICATION ══════════════════════════════════════════════════ */

describe("who may even ask", () => {
  test("no authentication is 401, and answers nothing", async () => {
    const r = await access(null);
    expect(r.status).toBe(401);
    /* Not `allowed: false` — that would be an answer, and an unauthenticated
       caller is not entitled to one. */
    expect(r.body.allowed).toBeUndefined();
    expect(r.body.role).toBeUndefined();
  });

  test("a forged token is 401 too", async () => {
    const forged = jwt.sign({ id: String(new mongoose.Types.ObjectId()), email: "x@y.z" }, "not-the-secret");
    const r = await access({ token: forged });
    expect(r.status).toBe(401);
  });
});

/* ═══ 2 · BOTH HALVES, AND NEITHER ALONE ═════════════════════════════════ */

describe("the grant and the role", () => {
  test("an authenticated employee with neither is allowed:false", async () => {
    const me = await person({});
    const r = await access(me);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      success: true,
      allowed: false,
      role: null,
      can: { read: false, draft: false, approve: false },
    });
  });

  test("Board membership with no active role is false", async () => {
    /* An administrator has said this person belongs on the Board and has not
       yet said what they may do. The app refuses every request until they do,
       so the menu must not offer it. */
    const me = await person({ memberOf: ["board"] });
    const r = await access(me);
    expect(r.body.allowed).toBe(false);
    expect(r.body.role).toBeNull();
  });

  test("an active Board role with no Board membership is false", async () => {
    /* ── THE STALE ROW ─────────────────────────────────────────────────
       Board membership lives on the EMPLOYEE record. A role row left behind
       after somebody's department was withdrawn is a row, not a Board member —
       and it is the same rule that keeps Board off accounts with no HR
       record. */
    const me = await person({ roles: { board: "owner" } });
    const r = await access(me);
    expect(r.body.allowed).toBe(false);
    expect(r.body.role).toBeNull();
    /* The row really is there and really is active; it just is not enough. */
    const row = await DepartmentRole.findOne({ departmentSlug: "board", email: me.email }).lean();
    expect(row.role).toBe("owner");
    expect(row.isActive).toBe(true);
  });

  const RANKS = {
    viewer: { read: true, draft: false, approve: false },
    editor: { read: true, draft: true, approve: false },
    approver: { read: true, draft: true, approve: true },
    owner: { read: true, draft: true, approve: true },
  };

  for (const [role, can] of Object.entries(RANKS)) {
    test(`membership plus an active ${role} role is true, and names ${role}`, async () => {
      const me = await person({ memberOf: ["board"], roles: { board: role } });
      const r = await access(me);
      expect(r.status).toBe(200);
      expect(r.body.allowed).toBe(true);
      /* The role itself, so a screen can say "you are a viewer" rather than
         only "no" — and so the switcher reads the role rather than trusting a
         summarising flag it cannot tell from a failed request. */
      expect(r.body.role).toBe(role);
      /* ── THE SAME RANKS THE APP APPLIES ────────────────────────────
         Drafting and approving are different ranks: a policy whose author is
         always its approver has a review step in name only. */
      expect(r.body.can).toEqual(can);
    });
  }

  test("the ranks it publishes are the ones the guard actually uses", async () => {
    /* Not a second table. If `canDo` and this endpoint ever disagreed, a menu
       would offer an action the app refuses. */
    const { canDo } = require("../../services/board/boardAccess");
    for (const [role, can] of Object.entries(RANKS)) {
      expect({
        read: canDo(role, "read"),
        draft: canDo(role, "draft"),
        approve: canDo(role, "approve"),
      }).toEqual(can);
    }
  });
});

/* ═══ 3 · IT IS READ EVERY TIME, NOT FROM THE TOKEN ══════════════════════ */

describe("revocation is immediate", () => {
  test("revoking the role flips it to false on the SAME login token", async () => {
    const me = await person({ memberOf: ["board"], roles: { board: "approver" } });
    expect((await access(me)).body.allowed).toBe(true);

    /* `role: null` is what the dropdown's "— No board access —" sends. */
    await setRole("board", me.email, null);

    /* No new sign-in, no re-issued token. The grant is re-read per request. */
    const after = await access(me);
    expect(after.body.allowed).toBe(false);
    expect(after.body.role).toBeNull();
    expect(after.body.can).toEqual({ read: false, draft: false, approve: false });
  });

  test("deactivating the row directly flips it too", async () => {
    /* Revocation deactivates rather than deletes, so the row survives. An
       inactive row is not a role. */
    const me = await person({ memberOf: ["board"], roles: { board: "owner" } });
    expect((await access(me)).body.allowed).toBe(true);

    await DepartmentRole.updateOne(
      { departmentSlug: "board", email: me.email }, { $set: { isActive: false } },
    );
    expect((await access(me)).body.allowed).toBe(false);
  });

  test("withdrawing the department flips it too, role row intact", async () => {
    /* The other half, withdrawn on its own. Both are load-bearing, so both
       must be able to take the answer away by themselves. */
    const me = await person({ memberOf: ["board"], roles: { board: "owner" } });
    expect((await access(me)).body.allowed).toBe(true);

    const board = await AccessDepartment.findOne({ slug: "board" }).lean();
    await Employee.updateOne(
      { _id: me.employeeId }, { $pull: { additionalDepartmentIds: board._id } },
    );

    expect((await access(me)).body.allowed).toBe(false);
    expect((await DepartmentRole.findOne({ departmentSlug: "board", email: me.email }).lean()).role)
      .toBe("owner");
  });

  test("a demotion is reflected, not cached", async () => {
    const me = await person({ memberOf: ["board"], roles: { board: "owner" } });
    expect((await access(me)).body.can.approve).toBe(true);

    await setRole("board", me.email, "editor");
    const r = await access(me);
    expect(r.body.role).toBe("editor");
    expect(r.body.can).toEqual({ read: true, draft: true, approve: false });
  });
});

/* ═══ 4 · THE EXECUTIVE OFFICE IS NOT THE BOARD ══════════════════════════ */

describe("no ceo fallback, in any form", () => {
  test("Executive Office membership does not satisfy Board", async () => {
    const me = await person({ memberOf: ["ceo"] });
    const nobody = await person({});
    /* The SAME answer somebody with no access whatsoever gets — not a softer
       one, and above all not an allowance. */
    expect((await access(me)).body).toEqual((await access(nobody)).body);
    expect((await access(me)).body.allowed).toBe(false);
  });

  test("an active ceo ROLE does not satisfy Board either", async () => {
    /* The stronger case: the very row `services/access/hrAccess.js` and
       `fulfilmentAccess.js` read for board-level visibility of HR and
       fulfilment. It is still not a seat on the Board. */
    const me = await person({ memberOf: ["ceo"], roles: { ceo: "owner" } });
    const r = await access(me);
    expect(r.body.allowed).toBe(false);
    expect(r.body.role).toBeNull();
  });

  test("a platform administrator is not on the Board", async () => {
    /* `/api/auth/verify` hands an admin every active department, so without the
       role check this is precisely the person who would be offered a tile the
       app then refuses. */
    const me = await person({ memberOf: ["board", "ceo"], isAdmin: true });
    expect((await access(me)).body.allowed).toBe(false);
  });

  test("holding every other department is not holding Board", async () => {
    const me = await person({
      memberOf: ["sales", "store", "hr", "accountant"],
      roles: { sales: "owner", store: "owner", hr: "owner" },
    });
    expect((await access(me)).body.allowed).toBe(false);
  });

  test("the authority names one slug, and it is not ceo", async () => {
    const src = await require("node:fs/promises").readFile(
      require("node:path").resolve(__dirname, "../../services/board/boardAccess.js"), "utf8",
    );
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/BOARD_DEPT_SLUG = "board"/);
    expect(code).not.toMatch(/"ceo"/);
    expect(code).not.toMatch(/isAdmin/);
  });
});

/* ═══ 5 · IT ANSWERS ONE QUESTION AND NOTHING ELSE ═══════════════════════ */

describe("what the response may contain", () => {
  /** Everything this endpoint is allowed to say. */
  const KEYS = ["success", "allowed", "role", "can"];

  test("the shape is closed, for a holder and for a stranger alike", async () => {
    const holder = await person({ memberOf: ["board"], roles: { board: "owner" } });
    const stranger = await person({});
    for (const who of [holder, stranger]) {
      const r = await access(who);
      expect(Object.keys(r.body).sort()).toEqual([...KEYS].sort());
      expect(Object.keys(r.body.can).sort()).toEqual(["approve", "draft", "read"]);
    }
  });

  test("no policy data reaches it, even for an Owner of a company with policies", async () => {
    const co = await company("Policied");
    const me = await person({ companies: [co], memberOf: ["board"], roles: { board: "owner" } });

    /* A real approved decision, so "there is nothing to leak" is not the
       reason the assertion passes. */
    const ctx = { companyId: co._id, actorId: "fixture", actorName: "Fixture" };
    const draft = await boardPolicy.createDraft(ctx, {
      policyKey: "FINANCING",
      financing: {
        annualRatePercent: "17.25", basis: "SUBTOTAL_BEFORE_FINANCING",
        advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
      },
    });
    await boardPolicy.approve(ctx, draft._id, { effectiveFrom: "2026-07-01" });

    const r = await access(me, co._id);

    /* ── THE WHOLE RESPONSE, NOT A LIST OF BANNED WORDS ────────────────
       An exact match is the only assertion that cannot be argued with: `can`
       legitimately contains the word "draft" because drafting is a capability,
       so a substring blocklist here would either be wrong or be silently
       weakened until it proved nothing. This says what the body IS. */
    expect(r.body).toEqual({
      success: true,
      allowed: true,
      role: "owner",
      can: { read: true, draft: true, approve: true },
    });

    /* And the thing that would matter most if it did leak: the rate the
       company borrows at, which is the whole point of the policy. */
    expect(JSON.stringify(r.body)).not.toMatch(/17\.25/);
    expect(JSON.stringify(r.body)).not.toMatch(String(draft._id));

    /* The comparison that makes that meaningful — the policy really is there,
       and the Board route really does serve it to this same caller. */
    const policy = await boardCall("/FINANCING", { token: me.token, company: co._id });
    expect(policy.status).toBe(200);
    expect(JSON.stringify(policy.body)).toMatch(/17\.25/);
  });

  test("no other person appears in it", async () => {
    const co = await company("Crowded");
    const me = await person({ companies: [co], memberOf: ["board"], roles: { board: "viewer" } });
    const someoneElse = await person({ companies: [co], memberOf: ["board"], roles: { board: "owner" } });

    const text = JSON.stringify((await access(me, co._id)).body);
    expect(text).not.toMatch(new RegExp(someoneElse.email, "i"));
    /* Not even the caller's own address — a menu does not need it, and
       anything it does not need is something it cannot leak. */
    expect(text).not.toMatch(new RegExp(me.email, "i"));
    expect(text).not.toMatch(/@/);
  });

  test("no company state is inferable, and a foreign company changes nothing", async () => {
    /* ── WHY THIS IS NOT ABOUT SCOPING ─────────────────────────────────
       Being on the Board is not a per-company fact at this level, so the
       endpoint deliberately takes no company. The risk is the mirror image: it
       must not become a way to probe WHICH companies exist, or whether the
       caller has a relationship with one, by watching the answer change. */
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await person({ companies: [mine], memberOf: ["board"], roles: { board: "approver" } });

    const none = await access(me);
    const own = await access(me, mine._id);
    const foreign = await access(me, theirs._id);
    const invented = await access(me, new mongoose.Types.ObjectId());

    /* Identical, byte for byte. A different status, a different shape or a
       different message would each be a signal. */
    expect(own).toEqual(none);
    expect(foreign).toEqual(none);
    expect(invented).toEqual(none);
    expect(foreign.status).toBe(200);

    const text = JSON.stringify(foreign.body);
    expect(text).not.toMatch(new RegExp(String(theirs._id)));
    expect(text).not.toMatch(new RegExp(String(mine._id)));
    expect(text).not.toMatch(/company|Company/);
  });

  test("a stranger's answer is indistinguishable from a foreign-company stranger's", async () => {
    /* The same probe from the other side: somebody with no Board access must
       not be able to tell one company from another by asking. */
    const a = await company("A");
    const b = await company("B");
    const me = await person({ companies: [a] });
    expect((await access(me, b._id))).toEqual(await access(me, a._id));
  });
});

/* ═══ 6 · AND IT IS NOT A GUARD ══════════════════════════════════════════ */

describe("it authorises nothing", () => {
  test("a false answer does not stop the app refusing for itself", async () => {
    /* The endpoint exists so a menu can be honest. Every act inside Board
       re-checks for itself, so hiding the tile is never the protection. */
    const me = await person({ companies: [await company("Self")] });
    expect((await access(me)).body.allowed).toBe(false);

    const co = await Acc_Company.findOne({}).lean();
    const r = await boardCall("/FINANCING", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("a true answer is the same answer the app gives", async () => {
    const co = await company("Agree");
    const me = await person({ companies: [co], memberOf: ["board"], roles: { board: "approver" } });

    const menu = await access(me, co._id);
    const app = await boardCall("/FINANCING", { token: me.token, company: co._id });
    expect(menu.body.allowed).toBe(true);
    expect(app.status).toBe(200);
    /* The app publishes the same two capabilities under the same names. */
    expect(app.body.can).toEqual({ draft: menu.body.can.draft, approve: menu.body.can.approve });
  });
});
