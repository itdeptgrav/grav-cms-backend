// test/costing/board-financing-policy.test.js
//
// THE BOARD'S FIRST GOVERNED DECISION: WHAT MONEY COSTS.
//
// Two claims are being defended here, and everything below serves one of them.
//
//   1. A company-wide rule is a VERSION, not a field. It is drafted, approved
//      by somebody with a name, effective from a date, and superseded rather
//      than overwritten — so "what was the rate in March" is answerable
//      without finding a costing frozen in March.
//
//   2. Nothing about it is available by default. No seeded rate, no admin
//      shortcut into the Board, and no company able to read another's.
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

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_policy" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/board/policies`;
  /* The unique index is one of the guarantees under test, so it has to exist
     rather than be created lazily on first write. */
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

/** An actor with named grants. `isAdmin` is a separate, deliberate choice. */
async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `bp${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "B", lastName: `P${n}`, email, biometricId: `BP${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "B" });
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

const METHODOLOGY = Object.freeze({
  annualRatePercent: "12",
  basis: "SUBTOTAL_BEFORE_FINANCING",
  advanceTreatment: "REDUCES_FINANCED_AMOUNT",
  dayCountBasis: 365,
});

const draft = (me, co, financing = METHODOLOGY, over = {}) => call("/FINANCING/drafts", {
  method: "POST", token: me.token, company: co._id,
  body: { financing, rationale: "Working-capital line at 12%.", ...over },
});

/* ═══ 1 · NOTHING IS AVAILABLE BY DEFAULT ═════════════════════════════════ */

describe("a company starts with no financing decision at all", () => {
  test("no policy is seeded, and the absence is reported as absence", async () => {
    const co = await company("Fresh");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    const r = await call("/FINANCING", { token: me.token, company: co._id });
    expect(r.status).toBe(200);
    expect(r.body.versions).toEqual([]);
    /* Null, never a rate. A seeded "typical" rate would put money nobody
       agreed into every quotation the company issues. */
    expect(r.body.effectiveId).toBeNull();

    const resolved = await boardPolicy.resolveEffective(co._id, "FINANCING", new Date());
    expect(resolved).toBeNull();
  });
});

/* ═══ 2 · ACCESS IS A GRANT, NOT A ROLE IN THE APPLICATION ════════════════ */

describe("Board access", () => {
  test("somebody with no Board grant is refused, not shown an empty list", async () => {
    const co = await company("NoGrant");
    /* Grants in three other departments — including ones that see plenty. */
    const me = await actor({ companies: [co], grants: { sales: "owner", store: "owner", accounting: "owner" } });

    const r = await call("/FINANCING", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
    /* An empty list would read as "the company has made no decisions", which
       is a different and untrue statement. */
    expect(r.body.versions).toBeUndefined();
  });

  test("a platform administrator is not on the Board", async () => {
    /* ── THE ONE THAT WOULD HAVE BEEN SILENT ───────────────────────────
       `requireDepartmentRole` waves through `req.user.isAdmin`, and using it
       here would have handed the company's financing rate to every platform
       administrator without anybody deciding that. So this route does not
       use it. */
    const co = await company("AdminOnly");
    const me = await actor({ companies: [co], isAdmin: true });

    const r = await call("/FINANCING", { token: me.token, company: co._id });
    expect(r.status).toBe(403);
    expect(r.body.error.details.reason).toBe("NO_BOARD_GRANT");
  });

  test("a viewer may read and may not draft; an editor may draft and may not approve", async () => {
    const co = await company("Ranks");
    const viewer = await actor({ companies: [co], grants: { board: "viewer" } });
    const editor = await actor({ companies: [co], grants: { board: "editor" } });

    const read = await call("/FINANCING", { token: viewer.token, company: co._id });
    expect(read.status).toBe(200);
    expect(read.body.can).toEqual({ draft: false, approve: false });

    expect((await draft(viewer, co)).status).toBe(403);

    const made = await draft(editor, co);
    expect(made.status).toBe(201);

    /* ── DRAFTING AND APPROVING ARE DIFFERENT RANKS ────────────────────
       A policy whose author is always its approver has a review step in name
       only, and the whole reason a Board decision is versioned is that
       somebody other than its author stands behind it. */
    const approved = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: editor.token, company: co._id,
      body: { effectiveFrom: "2026-07-01" },
    });
    expect(approved.status).toBe(403);
    expect(approved.body.error.details.reason).toBe("INSUFFICIENT_BOARD_ROLE");
  });
});

/* ═══ 3 · COMPANY ISOLATION ═══════════════════════════════════════════════ */

describe("one company's policy is not another's", () => {
  test("a Board member of one company cannot read or reach the other's", async () => {
    const a = await company("Alpha");
    const b = await company("Beta");
    const mine = await actor({ companies: [a], grants: { board: "owner" } });
    const theirs = await actor({ companies: [b], grants: { board: "owner" } });

    const made = await draft(theirs, b);
    expect(made.status).toBe(201);
    const otherId = made.body.version._id;

    /* Their versions are not in my list... */
    const mineList = await call("/FINANCING", { token: mine.token, company: a._id });
    expect(mineList.body.versions).toEqual([]);

    /* ...and naming theirs directly is NOT FOUND, not FORBIDDEN. A refusal
       that distinguishes the two confirms the record exists. */
    const reach = await call(`/FINANCING/drafts/${otherId}`, {
      method: "PUT", token: mine.token, company: a._id, body: { revision: 1, rationale: "x" },
    });
    expect(reach.status).toBe(404);
    expect(reach.body.error.code).toBe("BOARD_POLICY_NOT_FOUND");

    /* And the resolver never crosses companies either. */
    expect(await boardPolicy.resolveEffective(a._id, "FINANCING", new Date())).toBeNull();
  });
});

/* ═══ 4 · DRAFTS ARE EDITABLE; APPROVED VERSIONS ARE NOT ══════════════════ */

describe("the lifecycle", () => {
  test("a draft can be edited, and says what is still open", async () => {
    const co = await company("Editing");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    /* Started with nothing decided — which is what a draft is for. */
    const made = await draft(me, co, {});
    expect(made.status).toBe(201);
    expect(made.body.version.status).toBe("DRAFT");

    const list = await call("/FINANCING", { token: me.token, company: co._id });
    expect(list.body.gaps[made.body.version._id].map((g) => g.field).sort())
      .toEqual(["advanceTreatment", "annualRatePercent", "basis", "dayCountBasis"]);

    const edited = await call(`/FINANCING/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, financing: METHODOLOGY, rationale: "Agreed at the July board." },
    });
    expect(edited.status).toBe(200);
    expect(edited.body.version.financing.annualRatePercent).toBe("12");
    expect(edited.body.gaps).toEqual([]);
  });

  test("a stale edit is refused rather than allowed to undo somebody else's", async () => {
    const co = await company("Race");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const made = await draft(me, co);

    const first = await call(`/FINANCING/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, financing: { annualRatePercent: "9" } },
    });
    expect(first.status).toBe(200);

    const stale = await call(`/FINANCING/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, financing: { annualRatePercent: "20" } },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("BOARD_POLICY_REVISION_CONFLICT");

    const doc = await BoardPolicy.findById(made.body.version._id).lean();
    expect(doc.financing.annualRatePercent).toBe("9");
  });

  test("approval records who and when, and the version stops being editable", async () => {
    const co = await company("Approve");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);

    const approved = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.version.status).toBe("BOARD_APPROVED");
    /* The approver is stamped by the server from the authenticated actor. */
    expect(approved.body.version.approvedByActorName).toMatch(/^Board /);
    expect(approved.body.version.approvedAt).toBeTruthy();
    expect(new Date(approved.body.version.effectiveFrom).toISOString()).toMatch(/^2026-07-01/);

    const edit = await call(`/FINANCING/drafts/${made.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id, body: { revision: 1, rationale: "changed my mind" },
    });
    expect(edit.status).toBe(409);
    expect(edit.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
    /* And the message says what to do instead, rather than only refusing. */
    expect(edit.body.error.details.remedy).toBe("NEW_VERSION");

    /* Nor deleted: an approved version is the record of a decision, and its
       own frozen costings point at it. */
    const gone = await call(`/FINANCING/drafts/${made.body.version._id}`, {
      method: "DELETE", token: me.token, company: co._id,
    });
    expect(gone.status).toBe(409);
  });

  test("an approver cannot forge somebody else's name onto the approval", async () => {
    const co = await company("Forge");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);

    const approved = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id,
      body: {
        effectiveFrom: "2026-07-01",
        approvedByActorName: "The Chairman", approvedAt: "2020-01-01", status: "BOARD_APPROVED",
      },
    });
    expect(approved.status).toBe(200);
    expect(approved.body.version.approvedByActorName).not.toBe("The Chairman");
    expect(new Date(approved.body.version.approvedAt).getFullYear()).toBeGreaterThan(2020);
  });

  test("an incomplete methodology cannot be approved, and every gap is named", async () => {
    const co = await company("Half");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    /* A rate and nothing else. A rate with no period, no basis and no advance
       rule is not a cheaper methodology; it is an unanswered question. */
    const made = await draft(me, co, { annualRatePercent: "12" });

    const r = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: "2026-07-01" },
    });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps.map((g) => g.field).sort())
      .toEqual(["advanceTreatment", "basis", "dayCountBasis"]);
  });

  test("an approval with no effective date is refused", async () => {
    const co = await company("NoDate");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const made = await draft(me, co);
    const r = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: {},
    });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("EFFECTIVE_FROM_REQUIRED");
  });
});

/* ═══ 5 · EFFECTIVE DATES, SUPERSESSION AND OVERLAP ═══════════════════════ */

describe("what is in force, and when", () => {
  const approveAt = async (me, co, from, financing = METHODOLOGY) => {
    const made = await draft(me, co, financing);
    const r = await call(`/FINANCING/drafts/${made.body.version._id}/approve`, {
      method: "POST", token: me.token, company: co._id, body: { effectiveFrom: from },
    });
    return r;
  };

  test("a future-dated policy affects nothing before its date", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2030-01-01");

    /* Approved, and in force for nothing. That is the whole point of being
       able to approve one in advance. */
    expect(await boardPolicy.resolveEffective(co._id, "FINANCING", new Date())).toBeNull();
    const then = await boardPolicy.resolveEffective(co._id, "FINANCING", new Date("2030-06-01"));
    expect(then).toBeTruthy();

    const list = await call("/FINANCING", { token: me.token, company: co._id });
    expect(list.body.effectiveId).toBeNull();
    expect(list.body.versions[0].lifecycle).toBe("BOARD_APPROVED");
  });

  test("a later policy supersedes the earlier one, and the earlier one is not touched", async () => {
    const co = await company("Supersede");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    const first = await approveAt(me, co, "2026-01-01", { ...METHODOLOGY, annualRatePercent: "9" });
    const second = await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, annualRatePercent: "12" });
    expect(second.status).toBe(200);

    /* Each date resolves to the rule that was in force on it. */
    const march = await boardPolicy.resolveEffective(co._id, "FINANCING", new Date("2026-03-15"));
    expect(march.financing.annualRatePercent).toBe("9");
    const september = await boardPolicy.resolveEffective(co._id, "FINANCING", new Date("2026-09-15"));
    expect(september.financing.annualRatePercent).toBe("12");

    /* ── AND THE FIRST VERSION IS UNCHANGED ON DISK ────────────────────
       Superseded by the arithmetic of dates, not by a write. Nothing had to
       run to make it true, and nothing was rewritten to record it — which is
       why history cannot be lost by a job that did not run. */
    const stored = await BoardPolicy.findById(first.body.version._id).lean();
    expect(stored.status).toBe("BOARD_APPROVED");
    expect(stored.financing.annualRatePercent).toBe("9");
    expect(stored.updatedAt.getTime()).toBe(new Date(first.body.version.updatedAt).getTime());

    const list = await call("/FINANCING", { token: me.token, company: co._id, });
    const byId = Object.fromEntries(list.body.versions.map((v) => [String(v._id), v.lifecycle]));
    expect(byId[String(second.body.version._id)]).toBe("EFFECTIVE");
    expect(byId[String(first.body.version._id)]).toBe("SUPERSEDED");
  });

  test("two approved policies cannot take effect on the same date", async () => {
    const co = await company("Overlap");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    expect((await approveAt(me, co, "2026-07-01")).status).toBe(200);

    const clash = await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, annualRatePercent: "15" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");

    /* Two drafts may name the same date while they are argued about; only one
       of them can be approved onto it. */
    expect(await BoardPolicy.countDocuments({ companyId: co._id, status: "BOARD_APPROVED" })).toBe(1);
  });

  test("backdating changes what the next costing resolves and nothing already frozen", async () => {
    /* The half of that claim this suite can prove: resolution by date. The
       other half — that a frozen version never asks again — is proved in
       board-financing-costing.test.js against a real version. */
    const co = await company("Backdate");
    const me = await actor({ companies: [co], grants: { board: "approver" } });
    await approveAt(me, co, "2026-07-01", { ...METHODOLOGY, annualRatePercent: "12" });
    await approveAt(me, co, "2026-01-01", { ...METHODOLOGY, annualRatePercent: "6" });

    expect((await boardPolicy.resolveEffective(co._id, "FINANCING", new Date("2026-03-01")))
      .financing.annualRatePercent).toBe("6");
    expect((await boardPolicy.resolveEffective(co._id, "FINANCING", new Date("2026-09-01")))
      .financing.annualRatePercent).toBe("12");
  });
});

/* ═══ 6 · THE CONTROLLED VALUES ═══════════════════════════════════════════ */

describe("the methodology is stated in controlled terms", () => {
  test("the day count is 365 or 360, and nothing else", async () => {
    const co = await company("DayCount");
    const me = await actor({ companies: [co], grants: { board: "owner" } });

    for (const good of [365, 360]) {
      expect((await draft(me, co, { ...METHODOLOGY, dayCountBasis: good })).status).toBe(201);
    }
    /* 366, 300 and 12 are each somebody having misunderstood the question
       rather than having answered it differently. */
    const bad = await draft(me, co, { ...METHODOLOGY, dayCountBasis: 366 });
    expect(bad.status).toBe(400);
    expect(bad.body.error.details.field).toBe("dayCountBasis");
    expect(bad.body.error.details.allowed).toEqual([365, 360]);
  });

  test("the basis must be one the engine can actually resolve", async () => {
    const co = await company("BadBasis");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await draft(me, co, { ...METHODOLOGY, basis: "EVERYTHING" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("BASIS_UNKNOWN");
    /* A basis this record could name and the engine could not resolve would
       be a rule that never applies. */
    expect(r.body.error.details.allowed).toContain("SUBTOTAL_BEFORE_FINANCING");
  });

  test("the advance treatment is a Board decision, offered as two real answers", async () => {
    const co = await company("Advance");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const vocab = await call("/vocabulary", { token: me.token, company: co._id });
    expect(vocab.body.advanceTreatments).toEqual(["REDUCES_FINANCED_AMOUNT", "IGNORED"]);

    /* Both are approvable. Hard-coding either would be this code making a
       Board decision — and the two produce materially different garment
       costs on any order with a substantial advance. */
    for (const t of vocab.body.advanceTreatments) {
      expect((await draft(me, co, { ...METHODOLOGY, advanceTreatment: t })).status).toBe(201);
    }
  });

  test("a rate above 100% a year is a misplaced decimal point, not a rate", async () => {
    const co = await company("Rate");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await draft(me, co, { ...METHODOLOGY, annualRatePercent: "1200" });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("annualRatePercent");
  });

  test("a policy key nobody has migrated is refused, and the list says which exist", async () => {
    /* ── THIS USED TO ASSERT "ONLY FINANCING" ──────────────────────────
       Overhead has since been migrated onto the same lifecycle, so the list
       has two entries. What is still asserted is the thing that mattered: a
       key nothing implements is refused by name rather than answered with an
       empty history, which would read as "the Board has decided nothing about
       labour" when the truth is that nobody has built it. */
    const co = await company("OnePolicy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
        /* ── EVERY REAL KEY IS MIGRATED NOW ───────────────────────────────
       This used to name the next unbuilt policy, and each migration moved it
       along — overhead, labour, GST, development charges, contingency, margin,
       and finally customs duty. There is no unbuilt one left, so the example
       is a key that does not exist and never will. The rule under test is
       unchanged: an unknown key is refused BY NAME, and the refusal says which
       keys the company actually keeps. */
    const r = await call("/MOONLIGHT_POLICY", { token: me.token, company: co._id });
    expect(r.status).toBe(400);
    expect(r.body.error.details.allowed).toEqual(["FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY", "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY"]);

    /* And every implemented one answers. */
    for (const key of ["FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY", "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY"]) {
      expect((await call(`/${key}`, { token: me.token, company: co._id })).status).toBe(200);
    }
  });
});

/* ═══ 7 · THE DERIVED LIFECYCLE, IN ISOLATION ═════════════════════════════ */

describe("lifecycleOf", () => {
  const at = (iso) => new Date(iso);

  test("the four states are derived from two stored facts", () => {
    const id = new mongoose.Types.ObjectId();
    const doc = { _id: id, status: "BOARD_APPROVED", effectiveFrom: at("2026-07-01") };

    expect(boardPolicy.lifecycleOf({ status: "DRAFT" })).toBe("DRAFT");
    /* Approved, date not yet arrived. */
    expect(boardPolicy.lifecycleOf(doc, { asOf: at("2026-06-30") })).toBe("BOARD_APPROVED");
    /* Approved, date arrived, nothing later took over. */
    expect(boardPolicy.lifecycleOf(doc, { asOf: at("2026-08-01"), latestEffectiveId: id })).toBe("EFFECTIVE");
    /* Approved, date arrived, something later did. */
    expect(boardPolicy.lifecycleOf(doc, {
      asOf: at("2026-08-01"), latestEffectiveId: new mongoose.Types.ObjectId(),
    })).toBe("SUPERSEDED");
  });

  test("an approved version with no date is never reported as in force", () => {
    /* Unreachable through the service, which requires a date to approve. A
       document is not a promise, and EFFECTIVE would be the worst of the four
       available lies about it. */
    expect(boardPolicy.lifecycleOf({ status: "BOARD_APPROVED" }, { asOf: new Date() }))
      .toBe("BOARD_APPROVED");
  });
});
