// test/requests/tl-routing.route.test.js
//
// WHOSE APPROVAL A REQUEST IS WAITING FOR.
//
// The claim under test is one sentence: a request goes to the manager on the
// REQUESTER's own HR record — `Employee.primaryManager.managerId` — and to
// nobody else. Not to a department approver, not to whoever holds a role, not
// to finance, and not to another manager who happens to sit in the same team.
//
// ── WHY IT NEEDS ITS OWN SUITE ──────────────────────────────────────────────
// This is an authorisation boundary, and the interesting cases are all the
// NEGATIVE ones. `intake.route.test.js` proves the happy path works; what it
// cannot prove is that the four other people who might plausibly be handed
// this request are refused, in the queue as well as on the action. Those are
// the tests that fail silently in the worst way — a manager approving spend
// for a department that is not theirs looks exactly like the system working.
//
// ── AND WHY IT COVERS THREE COLLECTIONS ─────────────────────────────────────
// A request can be an IntakeRequest, an MRF or a SpendRequest, raised through
// three different doors that all existed at different times. They used to
// answer this question two different ways: MRF asked "is this addressed to
// me", the other two asked "do I manage this person today". The rule is now
// shared (services/tlRouting.service.js), and the point of testing all three
// is that they cannot drift apart again.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* ── THE MATERIAL DOOR'S FIREBASE EDGES ──────────────────────────────────────
 * `coworkMrfRoutes` is the only router here that reaches Firebase: push
 * notifications, the MRF chat thread, and the CoWork token verifier. All three
 * import `config/firebaseAdmin`, which THROWS at import when no service
 * account is set — so the router cannot even be loaded in a test process
 * without stubbing them.
 *
 * Stubbed rather than configured with a real key, deliberately. This suite
 * asks who may APPROVE a request; a push and a chat line are side effects with
 * nothing to assert on, and pointing tests at a live Firebase project would
 * make them slow, flaky and capable of writing to somebody's phone.
 *
 * Faithful stand-ins: every notify and chat call in the router is
 * fire-and-forget (`.catch(...)`) or feeds a screen this suite never reads, so
 * a resolved promise behaves exactly as the real one does for these paths. The
 * CMS door does not use the CoWork verifier at all — `cmsChain` is the CMS
 * employee session — so nothing under test goes near the mocked auth. */
jest.mock("../../config/firebaseAdmin", () => ({
  admin: {}, db: {}, auth: {}, messaging: {}, rtdb: {},
}));
jest.mock("../../services/mrfNotify.service", () => {
  const noop = () => Promise.resolve();
  return {
    submitted: noop, autoForwarded: noop, cancelled: noop, chatMessage: noop,
    tlApproved: noop, tlRejected: noop, productRequestChatMessage: noop,
    productRequestTlApproved: noop, productRequestTlRejected: noop,
  };
});
jest.mock("../../services/mrfChat.service", () => ({
  systemMessage: () => Promise.resolve(null),
  postMessage: () => Promise.resolve(null),
  listMessages: () => Promise.resolve([]),
  markRead: () => Promise.resolve({ unread: 0 }),
  describeSubject: () => ({ label: "" }),
}));

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const IntakeRequest = require("../../models/CMS_Models/Requests/IntakeRequest");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");
const Employee = require("../../models/Employee");
const AccessDepartment = require("../../models/Access/AccessDepartment");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/intake",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/intakeRequests"),
  );
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  /* The material door, mounted the way server.js mounts it for the CMS — same
     handlers, CMS session in front. "Material from Store still works" is one
     of the things this suite has to be able to say. */
  const mrfRoutes = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", mrfRoutes.cmsChain, mrfRoutes);

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

/**
 * One call as one person.
 *
 * `app` picks the door: the unified desk, the purchase door, or the material
 * door. All three read the same session, which is the point.
 */
const call = (emp, path, { method = "GET", body, app = "intake" } = {}) => {
  const url =
    app === "mrf" ? `${base}/cms/mrf${path}` : `${base}/requests/${app}${path}`;
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign(
        {
          id: String(emp._id),
          role: "employee",
          /* The session presents ONE id. Which of the HR record's two it is
             varies by person, and matching only one of them is how an approval
             queue silently empties — so some of these people deliberately have
             only an identityId. */
          employeeId: emp.biometricId || emp.identityId,
          name: `${emp.firstName} ${emp.lastName}`,
          email: emp.email,
        },
        process.env.JWT_SECRET || "grav_clothing_secret_key",
        { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
};

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * One department, several reporting lines, and every way one can break.
 *
 *   tl        Meera — manages emp. The one right answer for emp's requests.
 *   emp       Rutu — reports to Meera.
 *   otherTl   Anil — manages otherEmp. Same department, wrong person.
 *   otherEmp  reports to Anil, so Anil is genuinely a manager and not merely
 *             somebody with no reports. "Another TL cannot approve" has to
 *             mean a real TL.
 *   peer      same department as emp, manages nobody.
 *   fin       a finance approver in the books, managing nobody.
 *   orphan    no primaryManager at all.
 *   inactiveMgrEmp   manager exists in HR but is inactive.
 *   noIdMgrEmp       manager exists and is active but has neither id, so they
 *                    cannot sign in and cannot be routed to.
 *   idOnlyEmp        reports to a manager who has an identityId and no
 *                    biometricId — the alt-id case.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Routing Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const repairs = await Acc_Ledger.create({
    companyId: company._id, name: `Repairs & Maintenance ${n}`,
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{
      ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
      plannedItemKey: PLANNED_KEY,
      department: "Tech", allocatedAmount: 40000,
    }],
  }));

  const person = (over) =>
    Employee.create({ isActive: true, gender: "Other", department: "Tech", ...over });

  const tl = await person({
    firstName: "Meera", lastName: `L${n}`, email: `tl${n}@demo.example`, biometricId: `TL${n}`,
  });
  const otherTl = await person({
    firstName: "Anil", lastName: `K${n}`, email: `otl${n}@demo.example`, biometricId: `OT${n}`,
  });
  const emp = await person({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`, biometricId: `TC${n}`,
    primaryManager: { managerId: tl._id, managerName: "Meera" },
  });
  const otherEmp = await person({
    firstName: "Sujit", lastName: `P${n}`, email: `oe${n}@demo.example`, biometricId: `OE${n}`,
    primaryManager: { managerId: otherTl._id },
  });
  const peer = await person({
    firstName: "Priya", lastName: `N${n}`, email: `peer${n}@demo.example`, biometricId: `PR${n}`,
    primaryManager: { managerId: tl._id },
  });

  const fin = await person({
    firstName: "Soumya", lastName: `F${n}`, email: `fin${n}@demo.example`,
    biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  const orphan = await person({
    firstName: "Nabin", lastName: `O${n}`, email: `orph${n}@demo.example`, biometricId: `OR${n}`,
  });

  const inactiveMgr = await person({
    firstName: "Gone", lastName: `X${n}`, email: `gone${n}@demo.example`,
    biometricId: `GX${n}`, isActive: false, status: "inactive",
  });
  const inactiveMgrEmp = await person({
    firstName: "Dipti", lastName: `I${n}`, email: `imgr${n}@demo.example`, biometricId: `IM${n}`,
    primaryManager: { managerId: inactiveMgr._id },
  });

  /* Active, real, and unable to sign in to anything: no biometricId and no
     identityId means no session can ever present their id. */
  const noIdMgr = await person({
    firstName: "Paper", lastName: `M${n}`, email: `paper${n}@demo.example`,
  });
  const noIdMgrEmp = await person({
    firstName: "Alok", lastName: `B${n}`, email: `nbio${n}@demo.example`, biometricId: `NB${n}`,
    primaryManager: { managerId: noIdMgr._id },
  });

  const altIdMgr = await person({
    firstName: "Kabita", lastName: `S${n}`, email: `alt${n}@demo.example`, identityId: `ALT${n}`,
  });
  const idOnlyEmp = await person({
    firstName: "Manas", lastName: `R${n}`, email: `idonly${n}@demo.example`, biometricId: `IO${n}`,
    primaryManager: { managerId: altIdMgr._id },
  });

  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: "store", slug: "store", name: "Store & Purchase",
      dashboardPath: "/store", isActive: true,
    }));
  const store = await person({
    firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`,
    biometricId: `ST${n}`, department: "Store", accessDepartmentId: storeDept._id,
  });

  HEAD = String(repairs._id);
  return {
    company, repairs, tl, otherTl, emp, otherEmp, peer, fin, store,
    orphan, inactiveMgr, inactiveMgrEmp, noIdMgr, noIdMgrEmp, altIdMgr, idOnlyEmp,
  };
}

/* ── THE HEAD THE REQUESTER NOW CHOOSES ─────────────────────────────────────
 * Requests carry a budget head from the moment they are raised: the requester
 * picks one of their own department's approved allocations. `seed()` records
 * which head that is for the fixture, so every `ask()` below carries it
 * without every call site having to say so.
 *
 * A test that wants a HEADLESS request — the shape a row raised before this
 * rule has — passes `ask({ ledgerId: null })` and says why. */
let HEAD = null;

const ask = (over = {}) => ({
  ledgerId: HEAD,
  plannedItemKey: PLANNED_KEY,
  title: "Compressor is making a noise",
  purpose: "It is the only one on the line and it stops the second shift",
  items: [{ name: "Compressor service", quantity: 1, unit: "job" }],
  ...over,
});

const spendAsk = (s, over = {}) => ({
  title: "Licence renewal",
  requestType: "SERVICE",
  purpose: "Expiring at the end of the month",
  ledgerId: String(s.repairs._id),
  plannedItemKey: PLANNED_KEY,
  items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000 }],
  ...over,
});

/** Raise one on the unified desk and hand back the stored document. */
async function raise(s, who = null, over = {}) {
  const r = await call(who || s.emp, "/", { method: "POST", body: ask(over) });
  expect(r.status).toBe(201);
  return { id: r.body.request.id, row: r.body.request, doc: await IntakeRequest.findById(r.body.request.id).lean() };
}

/* ═══ 1 · WHERE IT GOES ═══════════════════════════════════════════════════ */

describe("a request is addressed to the requester's own Primary Manager", () => {
  test("the manager off the HR record is written onto the request", async () => {
    const s = await seed();
    const { doc } = await raise(s);

    /* Resolved from `emp.primaryManager.managerId`, not from a role, not from
       the department, and not from whoever was signed in. */
    expect(String(doc.approverEmployee)).toBe(String(s.tl._id));
    expect(doc.approverBiometricId).toBe(s.tl.biometricId);
    expect(doc.approverAltIds).toContain(s.tl.biometricId);
    expect(doc.approverName).toMatch(/Meera/);
    expect(doc.approverResolution).toBe("RESOLVED");
    expect(doc.approverResolutionNote).toBe("");
    expect(doc.status).toBe("pending_tl");
  });

  test("the desk says who it is waiting for, by name", async () => {
    const s = await seed();
    const { row } = await raise(s);
    expect(row.stageLabel).toBe("Waiting for department approval");
    expect(row.stageDetail).toMatch(/^Waiting for Meera/);
  });

  test("and the form says so before anything is typed", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/me");
    expect(body.me.approver).toMatchObject({ resolution: "RESOLVED" });
    expect(body.me.approver.name).toMatch(/Meera/);
  });

  test("the purchase door resolves the same manager", async () => {
    const s = await seed();
    const r = await call(s.emp, "/", { app: "spend", method: "POST", body: spendAsk(s) });
    expect(r.status).toBe(201);

    const doc = await SpendRequest.findById(r.body.request._id).lean();
    expect(String(doc.approverEmployee)).toBe(String(s.tl._id));
    expect(doc.approverBiometricId).toBe(s.tl.biometricId);
    expect(doc.approverResolution).toBe("RESOLVED");
    expect(doc.status).toBe("pending_tl");
  });

  test("the material door resolves the same manager", async () => {
    const s = await seed();
    const r = await call(s.emp, "/", {
      app: "mrf",
      method: "POST",
      body: {
        requestType: "USES_BASED",
        reason: "The old one failed inspection",
        priority: "NORMAL",
        items: [{ itemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.mrf.approverBiometricId).toBe(s.tl.biometricId);
    expect(r.body.mrf.approverResolution).toBe("RESOLVED");
    expect(r.body.mrf.status).toBe("PENDING");
  });
});

/* ═══ 2 · WHO SEES IT ═════════════════════════════════════════════════════ */

describe("the To approve queue", () => {
  test("the requester's own manager sees it", async () => {
    const s = await seed();
    await raise(s);

    const q = await call(s.tl, "/approvals");
    expect(q.body.requests).toHaveLength(1);
    expect(q.body.requests[0].step).toBe("tl");
    expect(q.body.requests[0].stepLabel).toMatch(/^Your turn: /);
  });

  test("another manager in the same department does not", async () => {
    const s = await seed();
    await raise(s);
    /* Anil manages somebody — he is a real TL, not a person with no reports —
       and this request is still none of his business. */
    const q = await call(s.otherTl, "/approvals");
    expect(q.body.requests).toHaveLength(0);
  });

  test("a colleague in the same department who manages nobody does not", async () => {
    const s = await seed();
    await raise(s);
    const q = await call(s.peer, "/approvals");
    expect(q.body.requests).toHaveLength(0);
  });

  test("finance does not see a request that is still waiting for a TL", async () => {
    const s = await seed();
    await raise(s);
    const q = await call(s.fin, "/approvals");
    expect(q.body.requests).toHaveLength(0);
    expect(q.body.counts).toEqual({ tl: 0, finance: 0 });
  });

  test("the requester does not see their own in it", async () => {
    const s = await seed();
    await raise(s);
    const q = await call(s.emp, "/approvals");
    expect(q.body.requests).toHaveLength(0);
  });

  test("one manager's queue holds only their own people", async () => {
    const s = await seed();
    await raise(s, s.emp);
    await raise(s, s.otherEmp);

    const mine = await call(s.tl, "/approvals");
    expect(mine.body.requests).toHaveLength(1);
    expect(mine.body.requests[0].requestedByName).toMatch(/Rutu/);

    const theirs = await call(s.otherTl, "/approvals");
    expect(theirs.body.requests).toHaveLength(1);
    expect(theirs.body.requests[0].requestedByName).toMatch(/Sujit/);
  });
});

/* ═══ 3 · WHO MAY ACT ═════════════════════════════════════════════════════ */

describe("the approval guard", () => {
  const approve = (s, who, id) =>
    call(who, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });

  test("the requester's own manager may approve", async () => {
    const s = await seed();
    const { id } = await raise(s);
    const ok = await approve(s, s.tl, id);
    expect(ok.status).toBe(200);
    expect(ok.body.request.tlApprovedByName).toMatch(/Meera/);
    expect(ok.body.request.stageDetail).toMatch(/Department approval complete/);
  });

  test("another manager may not, and is told who it is waiting for", async () => {
    const s = await seed();
    const { id } = await raise(s);
    const no = await approve(s, s.otherTl, id);
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/waiting for Meera/i);
    expect(await IntakeRequest.findById(id).lean()).toMatchObject({ status: "pending_tl" });
  });

  test("a colleague who manages nobody may not", async () => {
    const s = await seed();
    const { id } = await raise(s);
    expect((await approve(s, s.peer, id)).status).toBe(403);
  });

  test("finance may not clear the TL step", async () => {
    const s = await seed();
    const { id } = await raise(s);
    const no = await approve(s, s.fin, id);
    expect(no.status).toBe(403);
    /* Two approvals means two people. Letting finance take both would make the
       chain one person long, which is the whole reason there are two steps. */
    expect(no.body.message).toMatch(/waiting for/i);
  });

  test("the requester may not approve their own", async () => {
    const s = await seed();
    const { id } = await raise(s);
    const no = await approve(s, s.emp, id);
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/your own request/i);
  });

  test("nor reject it", async () => {
    const s = await seed();
    const { id } = await raise(s);
    const no = await call(s.emp, `/${id}/reject`, { method: "PATCH", body: { note: "never mind" } });
    expect(no.status).toBe(403);
  });

  test("a self-managed employee still cannot approve their own", async () => {
    const s = await seed();
    /* The one arrangement where "do I manage this person" answers YES for the
       requester themselves. The self-check runs first, so it does not matter. */
    await Employee.findByIdAndUpdate(s.orphan._id, {
      primaryManager: { managerId: s.orphan._id },
    });
    const raised = await call(s.orphan, "/", { method: "POST", body: ask() });
    expect(raised.status).toBe(201);
    /* No TL step exists for them at all — SELF_MANAGED is an unresolved chain. */
    expect(raised.body.request.status).toBe("needs_classification");

    const doc = await IntakeRequest.findById(raised.body.request.id).lean();
    /* Somebody listed as their own manager is a loop of length one — the walk
       catches it as such rather than as a special case. */
    expect(doc.chainStop).toBe("loop");
    expect(doc.approverBiometricId).toBe("");
  });

  test("the purchase door enforces the same rule", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { app: "spend", method: "POST", body: spendAsk(s) });
    const id = raised.body.request._id;

    expect((await call(s.otherTl, `/${id}/approve`, { method: "PATCH", app: "spend" })).status).toBe(403);
    expect((await call(s.peer, `/${id}/approve`, { method: "PATCH", app: "spend" })).status).toBe(403);
    expect((await call(s.fin, `/${id}/approve`, { method: "PATCH", app: "spend" })).status).toBe(403);
    expect((await call(s.emp, `/${id}/approve`, { method: "PATCH", app: "spend" })).status).toBe(403);

    const ok = await call(s.tl, `/${id}/approve`, { method: "PATCH", app: "spend" });
    expect(ok.status).toBe(200);
    /* And only now is it finance's. */
    expect(ok.body.request.status).toBe("pending_finance");
  });

  test("the material door enforces the same rule", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", {
      app: "mrf", method: "POST",
      body: {
        requestType: "USES_BASED", reason: "Old one failed", priority: "NORMAL",
        items: [{ itemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
      },
    });
    const id = raised.body.mrf._id;

    const no = await call(s.otherTl, `/${id}/tl-approve`, { method: "PATCH", app: "mrf" });
    expect(no.status).toBeGreaterThanOrEqual(400);

    const ok = await call(s.tl, `/${id}/tl-approve`, { method: "PATCH", app: "mrf" });
    expect(ok.status).toBe(200);
    expect((await MRF.findById(id).lean()).tlApproved).toBe(true);
  });
});

/* ═══ 4 · A TL'S OWN REQUEST ══════════════════════════════════════════════ */

describe("a manager's own request", () => {
  test("skips the TL step rather than waiting for themselves", async () => {
    const s = await seed();
    const raised = await call(s.tl, "/", { method: "POST", body: ask() });
    expect(raised.status).toBe(201);
    /* Straight to the people who work out how it gets got. Not a shortcut past
       a control: the classification step is a different question, and the TL
       step was only ever going to be answered by the person asking. */
    expect(raised.body.request.status).toBe("needs_classification");
  });

  test("on the purchase door it starts at finance", async () => {
    const s = await seed();
    const raised = await call(s.tl, "/", { app: "spend", method: "POST", body: spendAsk(s) });
    expect(raised.status).toBe(201);
    expect(raised.body.request.status).toBe("pending_finance");
    /* Two other people still stand between them and the money. */
    expect(raised.body.request.statusLabel).toBe("Waiting for finance");
  });
});

/* ═══ 5 · WHEN THE CHAIN BREAKS ═══════════════════════════════════════════ */

describe("the fallback, when HR names no usable manager", () => {
  /** Raise one and read back both the row and what was stored. */
  const raiseAs = async (who) => {
    const r = await call(who, "/", { method: "POST", body: ask() });
    expect(r.status).toBe(201);
    return { row: r.body.request, doc: await IntakeRequest.findById(r.body.request.id).lean() };
  };

  test("no Primary Manager at all — recorded, and said out loud", async () => {
    const s = await seed();
    const { row, doc } = await raiseAs(s.orphan);

    expect(doc.approverResolution).toBe("NO_MANAGER");
    expect(doc.approverEmployee).toBeFalsy();
    expect(doc.status).toBe("needs_classification");
    /* The point of the whole field: the requester can read WHY nobody
       approved this, instead of it looking approved. */
    expect(doc.chainStop).toBe("no_manager");
    expect(doc.chainStopReason).toMatch(/No Primary Manager is assigned in HR/);
    expect(doc.approverResolutionNote).toMatch(/Store & Purchase/);
    expect(row.stageDetail).toMatch(/^Approval skipped/);
    expect(row.stageDetailTone).toBe("warn");
    expect(row.approverResolution).toBe("NO_MANAGER");
  });

  test("an inactive manager", async () => {
    const s = await seed();
    const { doc } = await raiseAs(s.inactiveMgrEmp);
    expect(doc.chainStop).toBe("manager_inactive");
    expect(doc.approverBiometricId).toBe("");
    expect(doc.status).toBe("needs_classification");
  });

  test("a manager who has no id and therefore cannot sign in", async () => {
    const s = await seed();
    const { doc } = await raiseAs(s.noIdMgrEmp);
    expect(doc.chainStop).toBe("manager_no_login");
    expect(doc.status).toBe("needs_classification");
  });

  test("a manager whose HR record has been deleted", async () => {
    const s = await seed();
    await Employee.findByIdAndDelete(s.tl._id);
    const { doc } = await raiseAs(s.emp);
    expect(doc.chainStop).toBe("manager_not_found");
    expect(doc.status).toBe("needs_classification");
  });

  test("an unrouted request is in nobody's approval queue", async () => {
    const s = await seed();
    await raiseAs(s.orphan);
    for (const who of [s.tl, s.otherTl, s.peer, s.fin]) {
      const q = await call(who, "/approvals");
      expect(q.body.requests.filter((r) => r.source === "intake")).toHaveLength(0);
    }
  });

  test("the purchase door records it too, and routes to finance", async () => {
    const s = await seed();
    const r = await call(s.orphan, "/", { app: "spend", method: "POST", body: spendAsk(s) });
    expect(r.status).toBe(201);
    expect(r.body.request.status).toBe("pending_finance");
    expect(r.body.request.approverResolution).toBe("NO_MANAGER");
    expect(r.body.request.approverResolutionNote).toMatch(/finance/);
  });

  test("and the form warns before anything is typed", async () => {
    const s = await seed();
    const { body } = await call(s.orphan, "/me");
    expect(body.me.approver.resolution).toBe("no_manager");
    /* The form warns with the chain's own reason, and marks it as a
       broken line rather than an ordinary skip. */
    expect(body.me.approver.note).toMatch(/No Primary Manager is assigned in HR/);
    expect(body.me.approver.broken).toBe(true);
  });
});

/* ═══ 6 · THE MANAGER'S OTHER ID ══════════════════════════════════════════ */

describe("a manager who signs in with an identityId", () => {
  test("is routed to, and can act", async () => {
    const s = await seed();
    const { id, doc } = await (async () => {
      const r = await call(s.idOnlyEmp, "/", { method: "POST", body: ask() });
      expect(r.status).toBe(201);
      return { id: r.body.request.id, doc: await IntakeRequest.findById(r.body.request.id).lean() };
    })();

    /* Neither id is preferred over the other; both are stored, because only
       the manager's own session knows which one it presents. */
    expect(doc.approverBiometricId).toBe(s.altIdMgr.identityId);
    expect(doc.approverAltIds).toContain(s.altIdMgr.identityId);

    const q = await call(s.altIdMgr, "/approvals");
    expect(q.body.requests).toHaveLength(1);

    const ok = await call(s.altIdMgr, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    expect(ok.status).toBe(200);
  });
});

/* ═══ 7 · WHEN HR CHANGES AFTERWARDS ══════════════════════════════════════ */

describe("a reporting line that changes after the request was raised", () => {
  test("the manager who was asked is still the one who answers", async () => {
    const s = await seed();
    const { id } = await raise(s);

    /* HR moves Rutu under Anil. The request in Meera's queue was addressed to
       Meera, and an approval is a record of who was asked — not a function of
       the org chart's state at the moment somebody clicks. */
    await Employee.findByIdAndUpdate(s.emp._id, {
      primaryManager: { managerId: s.otherTl._id },
    });

    const anil = await call(s.otherTl, "/approvals");
    expect(anil.body.requests).toHaveLength(0);
    const refused = await call(s.otherTl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    expect(refused.status).toBe(403);

    const meera = await call(s.tl, "/approvals");
    expect(meera.body.requests).toHaveLength(1);
    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    expect(ok.status).toBe(200);
  });
});

/* ═══ 8 · REQUESTS THAT NAME NOBODY ═══════════════════════════════════════ */

describe("legacy rows, raised before an approver was ever stored", () => {
  /**
   * The one case where live HR still answers. Written by hand exactly as the
   * old routers wrote them: a requester, a status, and no approver at all.
   */
  const legacyMrf = (s, over = {}) =>
    MRF.create({
      requestedFor: s.emp._id, requestedForName: "Rutu", requestedForDept: "Tech",
      requestedForId: s.emp.biometricId, requestType: "USES_BASED", status: "PENDING",
      createdByRef: s.emp._id, createdByModel: "Employee", createdByName: "Rutu",
      items: [{ rawItem: null, rawItemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
      ...over,
    });

  test("a legacy spend request still reaches the right manager", async () => {
    const s = await seed();
    await SpendRequest.create({
      title: "Old licence", requestType: "SERVICE", purpose: "Expiring",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", companyId: s.company._id,
      items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000, amount: 8000 }],
      totalAmount: 8000,
      /* The pre-chain state, and no approver anywhere on the row. */
      status: "submitted",
    });

    const q = await call(s.tl, "/approvals", { app: "spend" });
    expect(q.body.requests).toHaveLength(1);
    expect(q.body.requests[0].step).toBe("tl");

    /* And nobody else's. */
    expect((await call(s.otherTl, "/approvals", { app: "spend" })).body.requests).toHaveLength(0);
    expect((await call(s.peer, "/approvals", { app: "spend" })).body.requests).toHaveLength(0);
  });

  test("a legacy material request still reaches the right manager", async () => {
    const s = await seed();
    await legacyMrf(s);

    const q = await call(s.tl, "/approvals");
    expect(q.body.requests.filter((r) => r.source === "mrf")).toHaveLength(1);
    expect((await call(s.otherTl, "/approvals")).body.requests).toHaveLength(0);
  });

  test("a legacy intake row does too", async () => {
    const s = await seed();
    await IntakeRequest.create({
      title: "Old ask", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", status: "pending_tl",
      items: [{ name: "Blade", quantity: 2, unit: "pcs" }],
    });

    expect((await call(s.tl, "/approvals")).body.requests).toHaveLength(1);
    expect((await call(s.otherTl, "/approvals")).body.requests).toHaveLength(0);
    expect((await call(s.peer, "/approvals")).body.requests).toHaveLength(0);
    expect((await call(s.fin, "/approvals")).body.requests).toHaveLength(0);
  });
});

/* ═══ 9 · CLASSIFICATION CARRIES THE ANSWER ═══════════════════════════════ */

describe("classification preserves the approval that was already given", () => {
  const approveIt = async (s) => {
    /* A rate on the line: the spend request this becomes needs one on every
       line, and a classification that cannot cost itself is refused. */
    const { id } = await raise(s, s.emp, {
      items: [{ name: "Compressor service", quantity: 1, unit: "job", rate: 12000 }],
    });
    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    expect(ok.status).toBe(200);
    return id;
  };

  test("a purchase carries the manager, their yes, and the routing record", async () => {
    const s = await seed();
    const id = await approveIt(s);

    const done = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase" },
    });
    expect(done.status).toBe(200);

    const spend = await SpendRequest.findOne({ intakeRequestId: id }).lean();
    /* The requester's manager, not the classifier's, and not re-resolved. */
    expect(String(spend.approverEmployee)).toBe(String(s.tl._id));
    expect(spend.approverBiometricId).toBe(s.tl.biometricId);
    expect(spend.approverAltIds).toContain(s.tl.biometricId);
    expect(spend.approverResolution).toBe("RESOLVED");
    /* Their yes travels, so the record does not read as unapproved. */
    expect(spend.tlApprovedByName).toMatch(/Meera/);
    expect(spend.tlApprovedAt).toBeTruthy();
    /* And it is not sent back to them to answer again. */
    /* Classified purchases now wait on the requester to confirm what Store
         found before finance is asked about the money. */
    expect(spend.status).toBe("awaiting_requester_confirmation");
    /* The requester is still the requester — the classifier raised it FOR
       them, and the id is what every approval rule keys on. */
    expect(spend.requestedById).toBe(s.emp.biometricId);
  });

  test("a store issue carries the same record onto the MRF", async () => {
    const s = await seed();
    const id = await approveIt(s);

    const done = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "store_issue" },
    });
    expect(done.status).toBe(200);

    const mrf = await MRF.findOne({ requestedForId: s.emp.biometricId }).lean();
    expect(mrf.approverBiometricId).toBe(s.tl.biometricId);
    expect(mrf.approverAltIds).toContain(s.tl.biometricId);
    expect(mrf.tlApproved).toBe(true);
    expect(mrf.tlApprovedByName).toMatch(/Meera/);
    /* Already agreed — the store does not ask the manager twice. */
    expect(mrf.status).toBe("APPROVED");
  });

  test("the manager is not re-asked even after HR moves the requester", async () => {
    const s = await seed();
    const id = await approveIt(s);
    await Employee.findByIdAndUpdate(s.emp._id, {
      primaryManager: { managerId: s.otherTl._id },
    });

    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "purchase" } });
    const spend = await SpendRequest.findOne({ intakeRequestId: id }).lean();
    expect(String(spend.approverEmployee)).toBe(String(s.tl._id));
    expect(spend.tlApprovedByName).toMatch(/Meera/);
  });
});
