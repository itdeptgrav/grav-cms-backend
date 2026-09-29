// test/costing/board-overhead-policy.test.js
//
// THE SECOND POLICY ON THE BOARD LIFECYCLE: COMPANY AND FACTORY OVERHEAD.
//
// ── WHAT THIS SUITE IS ACTUALLY GUARDING ────────────────────────────────────
// Financing proved the lifecycle. Overhead proves it is a LIFECYCLE and not a
// financing feature — the draft, the approval, the effective dating, the
// supersession and the company isolation all had to work for a policy with a
// completely different payload without either policy's own validation being
// weakened to accommodate the other.
//
// So the two things under test are:
//
//   1. every lifecycle guarantee holds for OVERHEAD, independently;
//   2. adding it changed nothing about FINANCING — same records, same
//      contract, same refusals.
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
const boardPolicy = require("../../services/board/boardPolicy.service");
const overheadPolicy = require("../../services/centralCosting/overheadPolicy.service");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_overhead" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/board/policies`;
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

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});


/* ── A GRANT IS A DEPARTMENT AND A ROLE ──────────────────────────────────────
   Access Control writes both, and `services/board/boardAccess.js` requires
   both: a role row with nobody holding the department is a row, not a person —
   which is how "only employees with HR records hold Board" is enforced in the
   guard rather than only on the screen that writes the row.

   These fixtures used to write the role alone. Created on demand rather than in
   `beforeAll` because `test/setup.js` empties every collection after each
   test. */
const deptRow = (slug) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, key: slug, name: slug, dashboardPath: `/${slug}` } },
  { upsert: true, new: true },
).lean();

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `oh${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "O", lastName: `H${n}`, email, biometricId: `OH${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "O" });
  }
  const held = [];
  for (const [departmentSlug, role] of Object.entries(grants)) {
    const dept = await deptRow(departmentSlug);
    held.push(dept._id);
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: dept._id,
    });
  }
  if (held.length) {
    await Employee.updateOne({ _id: emp._id }, { $set: { additionalDepartmentIds: held } });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Board ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const METHODOLOGY = Object.freeze({ ratePercent: "12", basis: "DIRECT_PLUS_FIXED" });

const draft = (me, co, overhead = METHODOLOGY, over = {}) => call("/OVERHEAD/drafts", {
  method: "POST", token: me.token, company: co._id,
  body: { overhead, rationale: "Reviewed factory and corporate cost pool.", ...over },
});

const approveAt = async (me, co, from, overhead = METHODOLOGY) => {
  const made = await draft(me, co, overhead);
  return call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom: from },
  });
};

/* ═══ 1 · NOTHING IS AVAILABLE BY DEFAULT ═════════════════════════════════ */

describe("a company starts with no overhead decision", () => {
  test("no policy is seeded, and the absence is reported as absence", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
    expect(r.body.effectiveId).toBeNull();

    /* ── AND THE CALCULATION SIDE AGREES ───────────────────────────────
       Not a 0% rate, which would read as "this company costs nothing to
       run" — a claim nobody made. */
    const resolved = await overheadPolicy.resolveFor({ companyId: co._id }, {});
    expect(resolved.state).toBe(overheadPolicy.STATE.POLICY_MISSING);
    expect(resolved.ratePercent).toBeNull();
    expect(resolved.missing[0].owner.department).toBe("Board");
    expect(overheadPolicy.overlayFor(resolved)).toEqual({
      overheadRatePercent: undefined, overheadBasis: undefined,
    });
  });
});

/* ═══ 2 · ACCESS AND COMPANY ISOLATION ════════════════════════════════════ */

describe("Board access", () => {
  test("somebody with no Board grant is refused, not shown an empty list", async () => {
    const co = await company("NoGrant");
    const me = await actor({ companies: [co], grants: { sales: "owner", store: "owner" } });
    const r = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
    expect(r.body.versions).toBeUndefined();
  });

  test("a platform administrator is not on the Board", async () => {
    const co = await company("AdminOnly");
    const me = await actor({ companies: [co], isAdmin: true });
    const r = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("an editor may draft and may not approve", async () => {
    const co = await company("Ranks");
    const editor = await actor({ companies: [co], grants: { board: "editor" } });
    const made = await draft(editor, co);
    expect(made.status).toBe(201);

    const approved = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: editor.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(approved.status).toBe(403);
    expect(approved.body.error.details.reason).toBe("INSUFFICIENT_BOARD_ROLE");
  });
});

describe("one company's overhead is not another's", () => {
  test("every read, draft and approval is scoped", async () => {
    const a = await company("Alpha");
    const b = await company("Beta");
    const mine = await actor({ companies: [a], grants: { board: "owner" } });
    const theirs = await actor({ companies: [b], grants: { board: "owner" } });

    const made = await draft(theirs, b);
    expect(made.status).toBe(201);

    /* Their versions are not in my list... */
    expect((await call("/OVERHEAD", { token: mine.token, company: a._id })).body.versions).toEqual([]);

    /* ...and naming theirs directly is NOT FOUND, not FORBIDDEN — a refusal
       that told them apart would confirm the record exists. */
    const reach = await call(`/OVERHEAD/drafts/${made.body.version._id}`, {
      method: "PUT", token: mine.token, company: a._id, body: { revision: 1, rationale: "x" },
    });
    expect(reach.status).toBe(404);

    const approve = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: mine.token, company: a._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(approve.status).toBe(404);

    /* And the resolver never crosses companies. */
    expect(await boardPolicy.resolveEffective(a._id, "OVERHEAD", new Date())).toBeNull();
  });
});

/* ═══ 3 · DRAFTS, VALIDATION AND IMMUTABILITY ═════════════════════════════ */

describe("the lifecycle", () => {
  test("a draft can be edited, and says what is still open", async () => {
    const co = await company("Editing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const made = await draft(me, co, {});
    expect(made.status).toBe(201);
    expect(made.body.version.status).toBe("DRAFT");
    expect(made.body.version.policyKey).toBe("OVERHEAD");

    const list = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(list.body.gaps[made.body.version._id].map((g) => g.field).sort())
      .toEqual(["basis", "ratePercent"]);

    const edited = await call(`/OVERHEAD/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, overhead: METHODOLOGY, rationale: "Agreed at the July board." },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.version.overhead.ratePercent).toBe("12");
    expect(edited.body.gaps).toEqual([]);
  });

  test("a rate with no basis cannot be approved — it is a percentage of nothing", async () => {
    const co = await company("HalfRule");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co, { ratePercent: "12" });

    const r = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["basis"]);
  });

  test("an approval with no effective date is refused", async () => {
    const co = await company("NoDate");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);
    const r = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: {},
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("EFFECTIVE_FROM_REQUIRED");
  });

  test("approval records who and when, and the version stops being editable", async () => {
    const co = await company("Approve");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);

    const approved = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.version.status).toBe("BOARD_APPROVED");
    expect(approved.body.version.approvedByActorName).toMatch(/^Board /);
    expect(approved.body.version.approvedAt).toBeTruthy();

    const edit = await call(`/OVERHEAD/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, overhead: { ratePercent: "30" } },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
    expect(edit.body.error.details.remedy).toBe("NEW_VERSION");

    /* And the stored rate did not move. */
    const doc = await BoardPolicy.findById(made.body.version._id).lean();
    expect(doc.overhead.ratePercent).toBe("12");
  });

  test("an approver cannot forge somebody else's name onto the approval", async () => {
    const co = await company("Forge");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);
    const approved = await call(`/OVERHEAD/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id,
      body: { effectiveFrom: "2026-07-01", approvedByActorName: "The Chairman", approvedAt: "2020-01-01" },
    });
    expect(approved.body.version.approvedByActorName).not.toBe("The Chairman");
    expect(new Date(approved.body.version.approvedAt).getFullYear()).toBeGreaterThan(2020);
  });

  test("a stale edit is refused rather than allowed to undo somebody else's", async () => {
    const co = await company("Race");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await draft(me, co);
    await call(`/OVERHEAD/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, overhead: { ratePercent: "9" } },
    });
    const stale = await call(`/OVERHEAD/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, overhead: { ratePercent: "20" } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("BOARD_POLICY_REVISION_CONFLICT");
    expect((await BoardPolicy.findById(made.body.version._id).lean()).overhead.ratePercent).toBe("9");
  });

  test("the basis must be one the engine can actually resolve", async () => {
    const co = await company("BadBasis");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await draft(me, co, { ...METHODOLOGY, basis: "EVERYTHING" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("BASIS_UNKNOWN");
    expect(r.body.error.details.allowed).toContain("DIRECT_PLUS_FIXED");
  });

  test("the rate ceiling is the one the rule it replaces allowed", async () => {
    const co = await company("Ceiling");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    /* A real overhead pool on a narrow basis can exceed 100% of it. */
    expect((await draft(me, co, { ...METHODOLOGY, ratePercent: "250" })).status).toBe(201);
    const bad = await draft(me, co, { ...METHODOLOGY, ratePercent: "1200" });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.field).toBe("ratePercent");
  });
});

/* ═══ 4 · EFFECTIVE DATES, SUPERSESSION AND OVERLAP ═══════════════════════ */

describe("what is in force, and when", () => {
  test("a future-dated policy affects nothing before its date", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2030-01-01");

    expect(await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date("2030-06-01"))).toBeTruthy();

    const list = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(list.body.effectiveId).toBeNull();
    expect(list.body.versions[0].lifecycle).toBe("BOARD_APPROVED");
  });

  test("a later policy supersedes the earlier one, which is not touched", async () => {
    const co = await company("Supersede");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const first = await approveAt(me, co, "2026-01-01", { ratePercent: "9", basis: "DIRECT" });
    const second = await approveAt(me, co, "2026-07-01", { ratePercent: "12", basis: "DIRECT_PLUS_FIXED" });
    expect(second.status).toBe(200);

    /* Each date resolves to the rule in force on it — including the BASIS,
       which is half the decision and the half a bare rate history loses. */
    const march = await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date("2026-03-15"));
    expect(march.overhead).toMatchObject({ ratePercent: "9", basis: "DIRECT" });
    const september = await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date("2026-09-15"));
    expect(september.overhead).toMatchObject({ ratePercent: "12", basis: "DIRECT_PLUS_FIXED" });

    /* ── AND THE FIRST VERSION IS UNCHANGED ON DISK ────────────────────
       Superseded by the arithmetic of dates, not by a write. */
    const stored = await BoardPolicy.findById(first.body.version._id).lean();
    expect(stored.status).toBe("BOARD_APPROVED");
    expect(stored.overhead.ratePercent).toBe("9");
    expect(stored.updatedAt.getTime()).toBe(new Date(first.body.version.updatedAt).getTime());

    const list = await call("/OVERHEAD", { token: me.token, company: co._id });
    const byId = Object.fromEntries(list.body.versions.map((v) => [String(v._id), v.lifecycle]));
    expect(byId[String(second.body.version._id)]).toBe("EFFECTIVE");
    expect(byId[String(first.body.version._id)]).toBe("SUPERSEDED");
  });

  test("two approved policies cannot take effect on the same date", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    expect((await approveAt(me, co, "2026-07-01")).status).toBe(200);
    const clash = await approveAt(me, co, "2026-07-01", { ratePercent: "15", basis: "DIRECT" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
    expect(await BoardPolicy.countDocuments({ companyId: co._id, status: "BOARD_APPROVED" })).toBe(1);
  });

  test("backdating changes what the next costing resolves, by date", async () => {
    const co = await company("Backdate");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2026-07-01", { ratePercent: "12", basis: "DIRECT" });
    await approveAt(me, co, "2026-01-01", { ratePercent: "6", basis: "DIRECT" });

    expect((await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date("2026-03-01")))
      .overhead.ratePercent).toBe("6");
    expect((await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date("2026-09-01")))
      .overhead.ratePercent).toBe("12");
  });
});

/* ═══ 5 · THE FOUR READINESS STATES ═══════════════════════════════════════ */

describe("why a company has no policy in force — four answers, not one", () => {
  const S = boardPolicy.POLICY_STATE;

  test("nothing at all", async () => {
    const co = await company("StateNone");
    expect((await boardPolicy.resolveState(co._id, "OVERHEAD")).state).toBe(S.NONE);
  });

  test("a draft nobody has approved is waiting for an APPROVER, not an author", async () => {
    const co = await company("StateDraft");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await draft(me, co);
    const st = await boardPolicy.resolveState(co._id, "OVERHEAD");
    expect(st.state).toBe(S.DRAFT_ONLY);
    expect(st.draftCount).toBe(1);
  });

  test("approved for next quarter is not 'the Board has not decided'", async () => {
    const co = await company("StateFuture");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2031-01-01");
    const st = await boardPolicy.resolveState(co._id, "OVERHEAD");
    expect(st.state).toBe(S.FUTURE_ONLY);
    /* Nobody has to act — a costing dated after it will pick it up. */
    expect(new Date(st.nextEffectiveFrom).getFullYear()).toBe(2031);
  });

  test("in force, and it says what is queued behind it without saying what it is", async () => {
    const co = await company("StateEffective");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2020-01-01", { ratePercent: "9", basis: "DIRECT" });
    await approveAt(me, co, "2032-01-01", { ratePercent: "15", basis: "DIRECT" });

    const st = await boardPolicy.resolveState(co._id, "OVERHEAD");
    expect(st.state).toBe(S.EFFECTIVE);
    expect(st.approvedByName).toBeTruthy();
    expect(new Date(st.nextEffectiveFrom).getFullYear()).toBe(2032);
    /* ── AND IT CARRIES NO RATE ────────────────────────────────────────
       This is what a DEPARTMENT reads. Presence and dates; never the rule. */
    expect(JSON.stringify({ ...st, effective: undefined })).not.toMatch(/ratePercent|DIRECT/);
  });
});

/* ═══ 6 · FINANCING IS UNCHANGED ══════════════════════════════════════════ */

describe("adding a second policy changed nothing about the first", () => {
  test("the two keys are separate records with separate payloads", async () => {
    const co = await company("Both");
    const me = await actor({ companies: [co], grants: { board: "approver" } });

    await approveAt(me, co, "2026-01-01");
    const fin = await call("/FINANCING/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: {
        financing: {
          annualRatePercent: "12", basis: "SUBTOTAL_BEFORE_FINANCING",
          advanceTreatment: "REDUCES_FINANCED_AMOUNT", dayCountBasis: 365,
        },
      },
    });
    expect(fin.status).toBe(201);

    /* Each list holds only its own. */
    const oh = await call("/OVERHEAD", { token: me.token, company: co._id });
    expect(oh.body.versions).toHaveLength(1);
    expect(oh.body.versions[0].policyKey).toBe("OVERHEAD");
    const fl = await call("/FINANCING", { token: me.token, company: co._id });
    expect(fl.body.versions).toHaveLength(1);
    expect(fl.body.versions[0].policyKey).toBe("FINANCING");

    /* And approving one leaves the other's effective policy alone. */
    expect(await boardPolicy.resolveEffective(co._id, "FINANCING", new Date())).toBeNull();
    expect(await boardPolicy.resolveEffective(co._id, "OVERHEAD", new Date())).toBeTruthy();
  });

  test("a body carrying the other policy's payload writes none of it", async () => {
    /* The service reads only the sub-document its own key owns. */
    const co = await company("CrossPayload");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await call("/OVERHEAD/drafts", {
      method: "POST", token: me.token, company: co._id,
      body: { overhead: METHODOLOGY, financing: { annualRatePercent: "99", dayCountBasis: 360 } },
    });
    expect(made.status).toBe(201);
    const doc = await BoardPolicy.findById(made.body.version._id).lean();
    expect(doc.overhead.ratePercent).toBe("12");
    expect(doc.financing?.annualRatePercent).toBeUndefined();
  });

  test("each policy keeps its own completeness rule", async () => {
    /* The whole reason the contracts are not merged: a shared "payload is
       non-empty" check would approve an overhead rate with no basis and a
       financing rate with no day count. */
    expect(boardPolicy.overheadGaps({}).map((g) => g.field).sort()).toEqual(["basis", "ratePercent"]);
    expect(boardPolicy.financingGaps({}).map((g) => g.field).sort())
      .toEqual(["advanceTreatment", "annualRatePercent", "basis", "dayCountBasis"]);
    expect(boardPolicy.overheadGaps({ ratePercent: "12", basis: "DIRECT" })).toEqual([]);
    /* ── A COMPLETE OVERHEAD PAYLOAD IS NOT A COMPLETE FINANCING ONE ────
       The two contracts share one field NAME — `basis` — and nothing else, so
       an overhead payload satisfies exactly one of financing's four questions
       and is still refused on the other three. That single overlap is the
       reason the check has to be per key rather than "does the payload have
       some fields in it". */
    expect(boardPolicy.financingGaps({ ratePercent: "12", basis: "DIRECT" }).map((g) => g.field).sort())
      .toEqual(["advanceTreatment", "annualRatePercent", "dayCountBasis"]);
  });
});

/* ═══ 7 · EXACTLY ONE OVERHEAD WRITER ═════════════════════════════════════ */

describe("only one thing in this repository can set an overhead rate", () => {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const run = promisify(execFile);
  const root = require("node:path").resolve(__dirname, "../..");

  const grep = async (pattern, dir) => {
    const { stdout } = await run("grep", ["-rn", "--include=*.js", pattern, `${root}/${dir}`])
      .catch((e) => ({ stdout: e.stdout || "" }));
    return stdout.trim().split("\n").filter(Boolean);
  };

  test("nothing outside the Board lifecycle assigns an overhead methodology", async () => {
    /* The Board service is the writer. Everything else may READ the resolved
       rule — the engine does, through the overlay — and nothing else may set
       one. A second writer is how a company ends up with two overhead rules
       and nothing deciding which applies. */
    const writers = (await grep("overhead: *{ *ratePercent", "services"))
      .concat(await grep("\\.overhead *=", "services"))
      .concat(await grep("overhead\\.ratePercent *=", "services"));
    for (const line of writers) {
      expect(line).toMatch(/services\/board\/boardPolicy\.service\.js/);
    }
  });

  test("the legacy fields are written by nothing at all", async () => {
    /* `savePolicy` refuses them; the only assignments left are the ones that
       CLEAR them and the ones that read a stored document. */
    const hits = await grep("overheadRatePercent: *[\"'][0-9]", "services");
    expect(hits).toEqual([]);
  });

  test("the costing engine reads the rule and never resolves it", async () => {
    /* One resolution, in `getPolicy`. A second place that resolved the rate
       would be a second answer, and the one nobody updates is the one some
       screen reads. */
    const enginePolicy = await grep("boardPolicy\\|BoardPolicy", "services/centralCosting/engine.js");
    expect(enginePolicy).toEqual([]);
    const resolvers = await grep("resolveEffective(.*OVERHEAD", "services");
    /* The overhead service, and nothing else. */
    for (const line of resolvers) {
      expect(line).toMatch(/overheadPolicy\.service\.js|boardPolicy\.service\.js/);
    }
  });
});
