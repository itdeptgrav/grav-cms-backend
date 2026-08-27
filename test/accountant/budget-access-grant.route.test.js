// WHO MAY SUBMIT A BUDGET, AND WHERE THAT IS DECIDED.
//
// Access used to need two setups that no single screen could show: grant the
// Budget app in Access Control, then have finance link that person's portal to
// a budget department. Granting the app alone produced "your account is not
// linked to a budget department", and neither screen could say what was
// missing.
//
// The grant now carries the answer — `DepartmentRole.budgetDepartments` — and
// these tests pin both halves of that: the new path works on its own, and
// every mapping made the old way still resolves.
//
// ── WHAT IS DELIBERATELY NOT TESTED HERE ────────────────────────────────────
// The money model. Approving still writes the allocation line through
// syncAllocationFromRequest, unchanged, and budget-end-to-end covers it. The
// last test below only confirms this change did not move that.
"use strict";
/* Employee's pre-save hook encrypts salary fields and refuses to run without a
   key. These fixtures carry no salary, but the hook runs regardless — so the
   suite supplies a throwaway key rather than reaching around the model. */
process.env.SALARY_ENCRYPTION_KEY =
  process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { SECRET } = require("../../config/jwt");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const Employee = require("../../models/Employee");
const AccessDepartment = require("../../models/Access/AccessDepartment");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    req.user = JSON.parse(req.headers["x-test-user"]);
    next();
  },
}));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");
const FINANCE = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner", email: "priya.owner@example.com", role: "owner",
  permissions: { canEdit: true, canApprove: true, canPostDirectly: true },
};

let deptSrv, finSrv, adminSrv, deptBase, finBase, adminBase, seq = 0;

beforeAll(async () => {
  const d = express(); d.use(express.json());
  d.use("/api/budget-proposals", require("../../routes/Access/budgetProposals"));
  await new Promise((r) => { deptSrv = d.listen(0, r); });
  deptBase = `http://127.0.0.1:${deptSrv.address().port}/api/budget-proposals`;
  const f = express(); f.use(express.json());
  f.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  await new Promise((r) => { finSrv = f.listen(0, r); });
  finBase = `http://127.0.0.1:${finSrv.address().port}/api/accountant/budgets`;

  /* Access Control's own API, mounted WITHOUT requirePlatformAdmin — that
     guard is server.js's and is not what these assert. `req.admin` is what the
     route reads for the audit trail. */
  const a = express();
  a.use(express.json());
  a.use((req, _res, next) => {
    req.admin = { _id: new mongoose.Types.ObjectId(), email: "exec@grav.in" };
    next();
  });
  a.use("/api/admin", require("../../routes/Admin/accessAdmin"));
  await new Promise((r) => { adminSrv = a.listen(0, r); });
  adminBase = `http://127.0.0.1:${adminSrv.address().port}/api/admin`;
});
afterAll(async () => {
  await new Promise((r) => deptSrv.close(r));
  await new Promise((r) => finSrv.close(r));
  await new Promise((r) => adminSrv.close(r));
});

const admin = (path, body, method) =>
  fetch(`${adminBase}${path}`, {
    method: method || (body ? "PUT" : "GET"),
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/* A person who signs into NO portal — the case the old resolution could not
   answer at all. `deptSlug: "budget"` is the standalone app, which is not a
   department anybody budgets for. */
const tokenFor = (email) =>
  jwt.sign(
    { v: 2, id: new mongoose.Types.ObjectId().toString(), deptSlug: "budget", email, name: "Rakesh" },
    SECRET,
    { expiresIn: "1h" },
  );

const as = (email) => (path, body, method) =>
  fetch(`${deptBase}${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(email)}` },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const fin = (path, body) =>
  fetch(`${finBase}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(FINANCE) },
    body: JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** A company with two budget departments and one collecting round. */
async function seed({ accessSlugOnLogistics = null, budgetEnabled = true } = {}) {
  const n = seq++;
  /* The company's own departments — the list Command Centre manages and the
     one the picker offers. No finance registry is needed for access. */
  await portalNamed("logistics", "Logistics", { budgetEnabled });
  await portalNamed("marketing", "Marketing", { budgetEnabled: true });
  const company = await Acc_Company.create({
    companyName: `Grant Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Freight ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "logistics", name: "Logistics",
    ...(accessSlugOnLogistics ? { accessSlug: accessSlugOnLogistics } : {}),
  });
  await Acc_BudgetDepartment.create({
    companyId: company._id, slug: "marketing", name: "Marketing",
  });
  const budget = await Acc_Budget.create({
    name: `Round ${n}`, financialYear: "2026-27", period: "yearly", status: "collecting",
    startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
  });
  return { company, budget, ledger };
}

/** An access-control department, created once — `slug` is globally unique. */
const portalNamed = (slug, name, extra = {}) =>
  AccessDepartment.findOneAndUpdate(
    { slug },
    {
      $setOnInsert: {
        key: slug.toUpperCase().replace(/-/g, "_"),
        slug,
        name,
        dashboardPath: `/${slug}`,
        isActive: true,
      },
      $set: extra,
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

/** An employee holding some access-control departments.
 *  `gender` is passed because the model defaults it to "", which its own enum
 *  does not accept — a bare create fails validation. */
const employeeWith = (email, { primary = null, extras = [] } = {}) =>
  Employee.create({
    firstName: "Rakesh", lastName: "Biswal", email, isActive: true, gender: "Other",
    ...(primary ? { accessDepartmentId: primary } : {}),
    ...(extras.length ? { additionalDepartmentIds: extras } : {}),
  });

/** Grant the Budget app to somebody, naming the departments it covers. */
const grant = (email, budgetDepartments) =>
  DepartmentRole.create({
    departmentSlug: "budget", email, name: "Rakesh", role: "editor",
    isActive: true, budgetDepartments,
  });

/* ═══ THE NORMAL PATH ══════════════════════════════════════════════════════ */

test("Budget access naming Logistics returns Logistics — no accessSlug anywhere", async () => {
  const { company } = await seed();
  const email = `rakesh${seq}@demo.example`;
  await grant(email, ["logistics"]);

  const ctx = await as(email)("/context");
  expect(ctx.status).toBe(200);
  const co = ctx.body.companies.find((c) => String(c._id) === String(company._id));
  expect(co).toBeTruthy();
  expect(co.departments.map((d) => d.name)).toEqual(["Logistics"]);

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.status).toBe(200);
  expect(cycles.body.cycles).toHaveLength(1);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

test("Budget access with no departments named opens the app but grants nothing", async () => {
  const { company } = await seed();
  const email = `nodept${seq}@demo.example`;
  await grant(email, []);

  const ctx = await as(email)("/context");
  expect(ctx.status).toBe(200);
  /* The setup state: the app is reachable and says so, rather than 403-ing at
     somebody who has done nothing wrong. */
  expect(ctx.body.companies).toEqual([]);

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.status).toBe(200);
  expect(cycles.body.cycles).toEqual([]);
});

test("several departments on one grant all come back", async () => {
  const { company } = await seed();
  const email = `multi${seq}@demo.example`;
  await grant(email, ["logistics", "marketing"]);

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name).sort()).toEqual(["Logistics", "Marketing"]);
});

/* ═══ THE BOUNDARIES ═══════════════════════════════════════════════════════ */

test("a Logistics grant cannot submit for Marketing", async () => {
  const { company, budget, ledger } = await seed();
  const email = `logi${seq}@demo.example`;
  await grant(email, ["logistics"]);

  const mine = await as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(),
    requestedAmount: 100000, purpose: "ours",
  });
  expect(mine.status).toBe(201);

  /* The department is read from the BODY, so this is the exact attempt the
     guard exists for: a real grant, a real cycle, somebody else's department. */
  const theirs = await as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Marketing", ledgerId: ledger._id.toString(),
    requestedAmount: 100000, purpose: "not ours",
  });
  expect(theirs.status).toBe(403);
  /* And the refusal does not name what they could have used instead. */
  expect(theirs.body.message).not.toMatch(/logistics/i);
});

test("a grant in one company does not reach another company's books", async () => {
  const a = await seed();
  const b = await seed();
  const email = `crossco${seq}@demo.example`;
  await grant(email, ["logistics"]);   // the slug exists in BOTH companies

  const inA = await as(email)(`/open-cycles?companyId=${a.company._id}`);
  expect(inA.body.departments.map((d) => d.name)).toEqual(["Logistics"]);

  /* Same slug, different books: the department resolves per company, so B's
     Logistics is reachable only because B has its own row — and a request
     into A's cycle from B's company id must not cross over. */
  const intoBsCycleFromA = await as(email)(
    `/${a.budget._id}/requests?companyId=${b.company._id}`,
    { department: "Logistics", ledgerId: a.ledger._id.toString(), requestedAmount: 1000, purpose: "x" },
  );
  expect(intoBsCycleFromA.status).toBe(404);
});

test("no grant at all is empty, never everything", async () => {
  const { company } = await seed();
  const email = `stranger${seq}@demo.example`;

  const ctx = await as(email)("/context");
  expect(ctx.body.companies).toEqual([]);
  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.cycles).toEqual([]);
  expect(cycles.body.departments).toEqual([]);
});

/* ═══ THE OLD WAY STILL WORKS ══════════════════════════════════════════════ */

test("a legacy accessSlug mapping still resolves, with no new grant", async () => {
  const { company } = await seed({ accessSlugOnLogistics: "packaging-dispatch" });
  const email = `legacy${seq}@demo.example`;
  /* Granted the PORTAL the old way — a role in packaging-dispatch — and
     nothing about budgets anywhere. */
  await DepartmentRole.create({
    departmentSlug: "packaging-dispatch", email, name: "Old Hand", role: "editor", isActive: true,
  });

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

test("holding both sources yields one row per department, not two", async () => {
  const { company } = await seed({ accessSlugOnLogistics: "packaging-dispatch" });
  const email = `both${seq}@demo.example`;
  await DepartmentRole.create({
    departmentSlug: "packaging-dispatch", email, name: "Both", role: "editor", isActive: true,
  });
  await grant(email, ["logistics"]);

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments).toHaveLength(1);
  expect(cycles.body.departments[0].name).toBe("Logistics");
});

test("revoking the grant revokes the access", async () => {
  const { company } = await seed();
  const email = `revoked${seq}@demo.example`;
  await grant(email, ["logistics"]);
  await DepartmentRole.updateOne(
    { departmentSlug: "budget", email },
    { $set: { isActive: false } },
  );

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments).toEqual([]);
});

/* ═══ THE MONEY MODEL IS UNTOUCHED ═════════════════════════════════════════ */

test("finance approving a granted user's request still writes the allocation line", async () => {
  const { company, budget, ledger } = await seed();
  const email = `flow${seq}@demo.example`;
  await grant(email, ["logistics"]);

  const made = await as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(),
    requestedAmount: 450000, purpose: "Peak freight",
  });
  expect(made.status).toBe(201);

  const agreed = await fin(
    `/${budget._id}/requests/${made.body.request._id}/agree?companyId=${company._id}`,
    { agreedAmount: 450000 },
  );
  expect(agreed.status).toBe(200);

  const fresh = await Acc_Budget.findById(budget._id).lean();
  const line = fresh.items.find(
    (i) => String(i.sourceRequestId) === String(made.body.request._id),
  );
  expect(line).toBeTruthy();
  expect(line.allocatedAmount).toBe(450000);
  /* Stored the registry's canonical name, not whatever case was typed. */
  expect(line.department).toBe("Logistics");
});

test("the canonical department name is stored however it was typed", async () => {
  const { company, budget, ledger } = await seed();
  const email = `case${seq}@demo.example`;
  await grant(email, ["logistics"]);

  const made = await as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "  lOgIsTiCs ", ledgerId: ledger._id.toString(),
    requestedAmount: 1000, purpose: "case test",
  });
  expect(made.status).toBe(201);
  expect(made.body.request.department).toBe("Logistics");
});

/* ═══ WHAT ACCESS CONTROL ACTUALLY WRITES ══════════════════════════════════
   The screen grants the app and names the departments in one save. These pin
   that contract, because the UI is built on it and nothing else asserts it. */

test("Access Control grants the app and its departments in one call", async () => {
  const { company } = await seed();
  const email = `viaadmin${seq}@demo.example`;

  const saved = await admin("/department-roles/budget", {
    email, name: "Rakesh", role: "editor", budgetDepartments: ["logistics"],
  });
  expect(saved.status).toBe(200);

  /* Read back the way the screen reads it. */
  const holders = await admin("/department-roles/budget");
  const hit = holders.body.holders.find((h) => h.email === email);
  expect(hit.budgetDepartments).toEqual(["logistics"]);

  /* And the app agrees, with no second setup step anywhere. */
  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

test("changing the departments on a grant changes what resolves", async () => {
  const { company } = await seed();
  const email = `changed${seq}@demo.example`;
  await admin("/department-roles/budget", {
    email, name: "Rakesh", role: "editor", budgetDepartments: ["logistics"],
  });
  await admin("/department-roles/budget", {
    email, name: "Rakesh", role: "editor", budgetDepartments: ["marketing"],
  });

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Marketing"]);
});

test("departments sent on a non-Budget grant are ignored, not stored", async () => {
  const email = `notbudget${seq}@demo.example`;
  await admin("/department-roles/hr", {
    email, name: "Someone", role: "editor", budgetDepartments: ["logistics"],
  });
  const holders = await admin("/department-roles/hr");
  const hit = holders.body.holders.find((h) => h.email === email);
  expect(hit.budgetDepartments).toEqual([]);
});

test("the picker offers the company's own departments, not a finance registry", async () => {
  await seed();
  const list = await admin("/budget-departments");
  expect(list.status).toBe(200);
  const slugs = list.body.departments.map((d) => d.slug);
  expect(slugs).toEqual(expect.arrayContaining(["logistics", "marketing"]));
  /* The Budget app and platform-admin are apps, not cost centres — offering
     "submit a budget for Budget" would be offering nonsense. */
  expect(slugs).not.toContain("budget");
  expect(slugs).not.toContain("platform-admin");
});

test("a department with budget submissions turned off is not offered", async () => {
  await seed();
  await portalNamed("dormant", "Dormant Unit", { budgetEnabled: false });
  const list = await admin("/budget-departments");
  expect(list.body.departments.map((d) => d.slug)).not.toContain("dormant");
});

test("a department with budget submissions off cannot be submitted for", async () => {
  const { company, budget, ledger } = await seed();
  await portalNamed("dormant", "Dormant Unit", { budgetEnabled: false });
  const email = `dormant${seq}@demo.example`;
  await grant(email, ["dormant"]);

  /* The grant names it, but the department is closed to budget submissions —
     so it resolves to nothing rather than to itself. */
  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments).toEqual([]);

  const refused = await as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Dormant Unit", ledgerId: ledger._id.toString(),
    requestedAmount: 1000, purpose: "x",
  });
  expect(refused.status).toBe(403);
});

/* ═══ HOW COMMAND CENTRE ACTUALLY GRANTS AN EMPLOYEE ═══════════════════════
   An employee is given an app by adding it to their EMPLOYEE record — the one
   they land on plus any extras. Reading only DeptUser and DepartmentRole meant
   a person who had genuinely been granted the Budget app resolved to nothing,
   which is precisely the "I turned it on and nothing changed" report. */

test("an employee granted a portal on their employee record resolves through it", async () => {
  const { company } = await seed({ accessSlugOnLogistics: "packaging-dispatch" });
  const email = `emp${seq}@demo.example`;

  const portal = await portalNamed("packaging-dispatch", "Packaging & Dispatch");
  await employeeWith(email, { extras: [portal._id] });

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

test("the app a person lands on counts too, not only the extras", async () => {
  const { company } = await seed({ accessSlugOnLogistics: "store" });
  const email = `primary${seq}@demo.example`;

  const portal = await portalNamed("store", "Store");
  await employeeWith(email, { primary: portal._id });

  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

test("an employee holding only the Budget app, with no departments chosen, still gets nothing", async () => {
  const { company } = await seed();
  const email = `appOnly${seq}@demo.example`;

  const budgetApp = await portalNamed("budget", "Budget");
  await employeeWith(email, { extras: [budgetApp._id] });

  /* Holding the Budget app is not itself a department anybody budgets for —
     it is the app. Until somebody names the departments, this is the setup
     state, and it must not widen into every department. */
  const ctx = await as(email)("/context");
  expect(ctx.body.companies).toEqual([]);
  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.departments).toEqual([]);
});

/* ═══ THE DAY AFTER A CLEAN START ══════════════════════════════════════════ */

test("a granted person is still linked when no round has been opened yet", async () => {
  /* The company exists and the person is granted; nobody has opened a round.
     They must NOT be told their account is unlinked — that is a different
     problem with a different fix, and conflating the two sent people back to
     Access Control to re-do a grant that was already correct. */
  const n = seq++;
  await portalNamed("logistics", "Logistics", { budgetEnabled: true });
  const company = await Acc_Company.create({
    companyName: `No Rounds Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const email = `norounds${n}@demo.example`;
  await grant(email, ["logistics"]);

  const ctx = await as(email)("/context");
  expect(ctx.status).toBe(200);
  const co = ctx.body.companies.find((c) => String(c._id) === String(company._id));
  expect(co).toBeTruthy();
  expect(co.departments.map((d) => d.name)).toEqual(["Logistics"]);

  /* And the app correctly has nothing to submit into — which the screen says
     in its own words, rather than as an access failure. */
  const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(cycles.body.cycles).toEqual([]);
  expect(cycles.body.departments.map((d) => d.name)).toEqual(["Logistics"]);
});

/* ═══ THE SUBMISSION WINDOW ════════════════════════════════════════════════
   When the money applies and when departments may ask are different ranges.
   These pin the second one — including that a round created before it existed
   is unrestricted, which is the only safe reading of a missing window. */

const windowSeed = async (window) => {
  const n = seq++;
  await portalNamed("logistics", "Logistics", { budgetEnabled: true });
  const company = await Acc_Company.create({
    companyName: `Window Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const ledger = await Acc_Ledger.create({
    companyId: company._id, name: `Freight W${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });
  const budget = await Acc_Budget.create({
    name: `Budget FY 2026-27 #${n}`, financialYear: "2026-27", period: "yearly",
    status: "collecting", startDate: FY_START, endDate: FY_END,
    companyId: company._id, items: [], budgetRequests: [], ...window,
  });
  const email = `win${n}@demo.example`;
  await grant(email, ["logistics"]);
  return { company, budget, ledger, email };
};

const propose = (email, company, budget, ledger) =>
  as(email)(`/${budget._id}/requests?companyId=${company._id}`, {
    department: "Logistics", ledgerId: ledger._id.toString(),
    requestedAmount: 100000, purpose: "inside the window",
  });

test("a department can submit inside the window", async () => {
  /* The window is set around today so the assertion does not rot. */
  const today = new Date();
  const from = new Date(today.getTime() - 5 * 86400000);
  const to = new Date(today.getTime() + 5 * 86400000);
  const { company, budget, ledger, email } = await windowSeed({
    submissionStartDate: from, submissionEndDate: to,
  });
  const { status } = await propose(email, company, budget, ledger);
  expect(status).toBe(201);
});

test("before the window, the refusal carries the opening date", async () => {
  const soon = new Date(Date.now() + 30 * 86400000);
  const later = new Date(Date.now() + 60 * 86400000);
  const { company, budget, ledger, email } = await windowSeed({
    submissionStartDate: soon, submissionEndDate: later,
  });
  const { status, body } = await propose(email, company, budget, ledger);
  expect(status).toBe(409);
  expect(body.code).toBe("SUBMISSIONS_NOT_OPEN");
  /* A bare "you cannot submit" sends somebody to find out why. */
  expect(body.message).toMatch(/Submissions open on \d/);
});

test("after the window, the refusal carries the closing date", async () => {
  const from = new Date(Date.now() - 60 * 86400000);
  const to = new Date(Date.now() - 30 * 86400000);
  const { company, budget, ledger, email } = await windowSeed({
    submissionStartDate: from, submissionEndDate: to,
  });
  const { status, body } = await propose(email, company, budget, ledger);
  expect(status).toBe(409);
  expect(body.code).toBe("SUBMISSIONS_CLOSED");
  expect(body.message).toMatch(/Submissions closed on \d/);
});

test("a round with no window at all still accepts submissions", async () => {
  /* Every round that existed before this feature. Absent means unrestricted;
     anything else would have silently closed them all. */
  const { company, budget, ledger, email } = await windowSeed({});
  const { status } = await propose(email, company, budget, ledger);
  expect(status).toBe(201);
});

test("a closed window still LISTS the round, with its dates", async () => {
  /* Hiding it would read as "finance has not opened anything yet". The
     department needs to see the round and when it was open. */
  const from = new Date(Date.now() + 10 * 86400000);
  const to = new Date(Date.now() + 20 * 86400000);
  const { company, email } = await windowSeed({
    submissionStartDate: from, submissionEndDate: to,
  });
  const { body } = await as(email)(`/open-cycles?companyId=${company._id}`);
  expect(body.cycles).toHaveLength(1);
  expect(body.cycles[0].submissionState).toBe("before");
  expect(body.cycles[0].submissionStartDate).toBeTruthy();
  expect(body.cycles[0].submissionEndDate).toBeTruthy();
});

test("finance can still approve a request that came in through a window", async () => {
  const today = new Date();
  const { company, budget, ledger, email } = await windowSeed({
    submissionStartDate: new Date(today.getTime() - 86400000),
    submissionEndDate: new Date(today.getTime() + 86400000),
  });
  const made = await propose(email, company, budget, ledger);
  expect(made.status).toBe(201);

  /* The window governs ASKING. It must not govern deciding — finance reviews
     after it closes, which is the whole point of having one. */
  const agreed = await fin(
    `/${budget._id}/requests/${made.body.request._id}/agree?companyId=${company._id}`,
    { agreedAmount: 100000 },
  );
  expect(agreed.status).toBe(200);
  const fresh = await Acc_Budget.findById(budget._id).lean();
  expect(fresh.items).toHaveLength(1);
  expect(fresh.items[0].allocatedAmount).toBe(100000);
});

/* ═══ WHEN THE NAME IS NOT THE SLUG ════════════════════════════════════════
   Every fixture above names a department "Logistics" under the slug
   `logistics`, so the name and the slug are the same string and the module's
   quiet assumption that they always are held.

   In the real data they do not. Ten of eighteen departments are granted under
   one spelling and displayed under another — `hr` / "Human Resources", `qc` /
   "Quality Control", `store` / "Store & Purchase" — and the form submits the
   NAME, because that is what it shows and what every stored request carries.

   The result was a 403 for a properly granted department, and, through the
   same comparison in `ownedBy`, their own submitted lines disappearing from
   their screen. These pin both. */

describe("a department whose name does not slugify to its slug", () => {
  /** `hr` / "Human Resources" — slugify("Human Resources") is "human-resources". */
  async function seedHr() {
    const n = seq++;
    await portalNamed("hr", "Human Resources");
    const company = await Acc_Company.create({
      companyName: `Naming Co ${n}`, booksFromDate: new Date("2026-04-01"),
    });
    const group = await Acc_Group.create({
      companyId: company._id, name: "Indirect Expenses", nature: "expense",
    });
    const ledger = await Acc_Ledger.create({
      companyId: company._id, name: `Training ${n}`, groupId: group._id,
      groupName: group.name, nature: "expense",
    });
    const budget = await Acc_Budget.create({
      name: `Round ${n}`, financialYear: "2026-27", period: "yearly", status: "collecting",
      startDate: FY_START, endDate: FY_END, companyId: company._id, items: [], budgetRequests: [],
    });
    const email = `hr${n}@demo.example`;
    await grant(email, ["hr"]);
    return { company, budget, ledger, email };
  }

  const proposal = (ledger, department) => ({
    department,
    ledgerId: ledger._id.toString(),
    requestedAmount: 120000,
    purpose: "Team training",
    phasingMode: "even",
    workingLines: [{ label: "Course", description: "Annual programme", quantity: 1, unit: "course", rate: 120000 }],
  });

  test("the picker offers the display name", async () => {
    const { company, email } = await seedHr();
    const cycles = await as(email)(`/open-cycles?companyId=${company._id}`);
    expect(cycles.body.departments.map((d) => [d.slug, d.name])).toEqual([["hr", "Human Resources"]]);
  });

  test("submitting under the name the picker showed is accepted", async () => {
    /* The exact 403 from the screen: "You cannot submit budget for that
       department", for a department the person holds. */
    const { company, budget, ledger, email } = await seedHr();
    const res = await as(email)(
      `/${budget._id}/requests?companyId=${company._id}`,
      proposal(ledger, "Human Resources"),
    );
    expect(res.status).toBe(201);
    expect(res.body.request.department).toBe("Human Resources");
  });

  test("and submitting under the slug is accepted too", async () => {
    const { company, budget, ledger, email } = await seedHr();
    const res = await as(email)(
      `/${budget._id}/requests?companyId=${company._id}`,
      proposal(ledger, "hr"),
    );
    expect(res.status).toBe(201);
    /* Stored under the registry's spelling either way, so finance sees one
       section rather than "hr" and "Human Resources" side by side. */
    expect(res.body.request.department).toBe("Human Resources");
  });

  test("a department can see the line it just submitted", async () => {
    /* `ownedBy` ran the same comparison, so the submit could succeed and the
       row still be invisible to the person who filed it. */
    const { company, budget, ledger, email } = await seedHr();
    await as(email)(`/${budget._id}/requests?companyId=${company._id}`, proposal(ledger, "Human Resources"));

    const mine = await as(email)(`/my-requests?companyId=${company._id}`);
    expect(mine.status).toBe(200);
    expect(mine.body.requests.map((r) => r.department)).toEqual(["Human Resources"]);
  });

  test("a department nobody granted is still refused", async () => {
    /* The whole point of accepting two spellings is that it accepts two
       spellings of an ALLOWED department, and widens nothing else. */
    const { company, budget, ledger, email } = await seedHr();
    await portalNamed("qc", "Quality Control");
    for (const named of ["Quality Control", "qc"]) {
      const res = await as(email)(
        `/${budget._id}/requests?companyId=${company._id}`,
        proposal(ledger, named),
      );
      expect(res.status).toBe(403);
    }
  });
});
