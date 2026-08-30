// test/requests/tl-budget-head.route.test.js
//
// THE HEAD THE MANAGER CHOOSES, AND WHERE IT ENDS UP.
//
// ── THE CLAIM ───────────────────────────────────────────────────────────────
// When a manager approves a request they pick the budget head out of a list
// that is ONLY their department's approved expense allocations in the cycle
// that is running — never the chart of accounts, never another department's
// money, never a revenue target, never a line from a round that has not
// started. The server enforces the same list, so a ledger id typed into a
// payload by hand buys nothing. And what they chose then travels, whole, to
// the people who fulfil it.
//
// ── WHY THE PICKER'S SOURCE IS THE INTERESTING PART ─────────────────────────
// Offering the full chart of accounts does not fail loudly. Somebody picks a
// plausible-looking head, the request goes through, and a budget report is
// quietly wrong months later. Every negative case here is a thing that would
// have succeeded silently.
//
// ── AND WHY THE CARRY-FORWARD IS TESTED FIELD BY FIELD ──────────────────────
// Store & Purchase are deciding how to spend somebody else's envelope. A head
// NAME on its own does not tell them whether that is comfortable; the position
// behind it does, and half of it arriving is the same as none.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

/* The material door reaches Firebase at import; see tl-routing.route.test.js
   for why these are stubbed rather than configured. */
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
  const mrfRoutes = require("../../routes/CMS_Routes/Inventory/Operations/coworkMrfRoutes");
  app.use("/api/cms/mrf", mrfRoutes.cmsChain, mrfRoutes);

  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body, app = "intake" } = {}) => {
  const url = app === "mrf" ? `${base}/cms/mrf${path}` : `${base}/requests/${app}${path}`;
  return fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId || emp.identityId,
          name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));
};

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * One live cycle, and every kind of head that must NOT reach the picker.
 *
 *   repairs      Tech, expense, approved            ← offered
 *   software     Tech, expense, approved            ← offered
 *   exportSales  Tech, REVENUE target               ← a floor, not an envelope
 *   printing     Merchandising, expense, approved   ← another department's
 *   stationery   a real expense ledger, budgeted nowhere
 *   proposed     Tech, asked for but NOT allocated — a budgetRequests row with
 *                no items[] line behind it. The commonest way an "approved"
 *                head is not one.
 *   training     Tech, expense, in a cycle that has not been activated
 *
 * People: emp reports to tl; store holds the Store & Purchase grant; fin is a
 * finance approver; hrEmp is in another department entirely.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Head Picker Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: "Direct Income", nature: "revenue",
  });
  const mk = (name, group = expGroup) =>
    Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`, groupId: group._id,
      groupName: group.name, nature: group.nature,
    });

  const repairs = await mk("Repairs & Maintenance");
  const software = await mk("Software Subscription");
  const exportSales = await mk("Export Sales", revGroup);
  const printing = await mk("Printing");
  const stationery = await mk("Stationery");
  const proposed = await mk("Drone Survey");
  const training = await mk("Training");

  const live = await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
        department: "Tech", allocatedAmount: 40000 },
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Tech", allocatedAmount: 12500 },
      { ledgerId: exportSales._id, ledgerName: exportSales.name, nature: "revenue",
        department: "Tech", allocatedAmount: 2000000 },
      { ledgerId: printing._id, ledgerName: printing.name, nature: "expense",
        department: "Merchandising", allocatedAmount: 60000 },
    ],
    /* Asked for, argued about, and not yet agreed. A proposal is not an
       envelope and must never reach a picker that spends one. */
    budgetRequests: [{
      department: "Tech", ledgerId: proposed._id, ledgerName: proposed.name,
      nature: "expense", requestedAmount: 90000, purpose: "Site survey work",
      state: "submitted",
    }],
  });
  /* Give every head its approved plan — a request now names a
     planned item, not just a head. See plannedItems.helper. */
  await planEveryItem(live);

  /* A round nobody has activated. */
  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2027-28 (${n})`, financialYear: "2027-28", period: "yearly",
    status: "collecting", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: training._id, ledgerName: training.name, nature: "expense",
              department: "Tech", allocatedAmount: 90000 }],
  }));

  const person = (over) =>
    Employee.create({ isActive: true, gender: "Other", department: "Tech", ...over });

  const tl = await person({
    firstName: "Meera", lastName: `L${n}`, email: `tl${n}@demo.example`, biometricId: `TL${n}`,
  });
  const emp = await person({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`, biometricId: `TC${n}`,
    primaryManager: { managerId: tl._id },
  });

  /* Another department, with its own manager, so "the heads offered are the
     REQUESTER's" has something to be wrong about. */
  const hrTl = await person({
    firstName: "Anil", lastName: `K${n}`, email: `hrtl${n}@demo.example`,
    biometricId: `HT${n}`, department: "Merchandising",
  });
  const hrEmp = await person({
    firstName: "Sujit", lastName: `P${n}`, email: `hr${n}@demo.example`,
    biometricId: `HR${n}`, department: "Merchandising",
    primaryManager: { managerId: hrTl._id },
  });

  /* A department with no budget at all. */
  const hkTl = await person({
    firstName: "Bhabani", lastName: `M${n}`, email: `hktl${n}@demo.example`,
    biometricId: `HK${n}`, department: "Housekeeping",
  });
  const hkEmp = await person({
    firstName: "Laxmi", lastName: `D${n}`, email: `hke${n}@demo.example`,
    biometricId: `HE${n}`, department: "Housekeeping",
    primaryManager: { managerId: hkTl._id },
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

  const fin = await person({
    firstName: "Soumya", lastName: `F${n}`, email: `fin${n}@demo.example`,
    biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  HEAD = String(repairs._id);
  return {
    company, live, repairs, software, exportSales, printing, stationery, proposed, training,
    tl, emp, hrTl, hrEmp, hkTl, hkEmp, store, fin,
  };
}

/** What somebody needs. A rate, so the classification can cost it. */
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
  neededBy: "2026-09-15",
  items: [{ name: "Compressor service", quantity: 1, unit: "job", rate: 12000 }],
  ...over,
});

const raise = async (s, who = null, over = {}) => {
  const r = await call(who || s.emp, "/", { method: "POST", body: ask(over) });
  expect(r.status).toBe(201);
  return r.body.request.id;
};

/**
 * A department with no approved head cannot raise a request at all.
 *
 * This used to be the escape hatch — ask for a head in words, with a reason.
 * It is gone from this door on purpose: what came out of it was an accounting
 * category invented on a stock-request form, spelled however the requester
 * spelled it, arriving at finance as a line nobody had agreed to. Finance adds
 * the head first; then the request can be raised against it.
 */
const refusedWithoutHead = async (s, who, over = {}) => {
  const r = await call(who, "/", {
    method: "POST",
    body: ask({
      ledgerId: undefined,
      plannedItemKey: PLANNED_KEY,
      unbudgetedHead: true,
      requestedHeadName: "Housekeeping consumables",
      requestedHeadReason: "Nothing is budgeted for this department yet",
      ...over,
    }),
  });
  expect(r.status).toBe(400);
  return r;
};

/* ═══ 1 · WHAT THE MANAGER IS OFFERED ═════════════════════════════════════ */


/**
 * Walk a classified purchase from Store to finance the way it now goes:
 * the requester confirms what Store found, then Store sends it on.
 *
 * Extracted because three suites needed the same two steps the moment
 * classification stopped landing on finance's desk. Confirmation is not a
 * formality — it is the step that catches Store sourcing the wrong model from
 * the wrong vendor, which finance reads as a perfectly good figure.
 */
async function confirmAndSend(s, spendId, requesterEmp) {
  const conf = await call(requesterEmp, `/${spendId}/confirm`, {
    method: "PATCH",
    app: "spend",
    body: { lines: { 0: { confirm: true }, 1: { confirm: true }, 2: { confirm: true } } },
  });
  if (conf.status !== 200) console.error("confirm refused:", conf.body);
  const sent = await call(s.store, `/${spendId}/send-to-finance`, {
    method: "PATCH",
    app: "spend",
    body: {},
  });
  if (sent.status !== 200) console.error("send-to-finance refused:", sent.body);
  return sent;
}

describe("the TL's budget head picker", () => {
  test("offers only the requester's department's approved expense heads", async () => {
    const s = await seed();
    const id = await raise(s);

    const { status, body } = await call(s.tl, `/${id}/budget-heads`);
    expect(status).toBe(200);
    expect(body.department).toBe("Tech");
    expect(body.financialYear).toBe("2026-27");
    expect(body.heads.map((h) => h.ledgerId).sort()).toEqual(
      [String(s.repairs._id), String(s.software._id)].sort(),
    );
    /* With the position on each, so the choice is made against a figure. */
    const head = body.heads.find((h) => h.ledgerId === String(s.repairs._id));
    expect(head).toMatchObject({
      ledgerName: expect.stringContaining("Repairs"),
      approved: 40000, committed: 0, actual: 0, available: 40000,
    });
  });

  test("is not the chart of accounts — a real ledger nobody budgeted is absent", async () => {
    const s = await seed();
    const id = await raise(s);
    const { body } = await call(s.tl, `/${id}/budget-heads`);
    expect(body.heads.some((h) => h.ledgerId === String(s.stationery._id))).toBe(false);
    /* Two heads out of seven ledgers. The list is an allocation list. */
    expect(body.heads).toHaveLength(2);
  });

  test("a head only PROPOSED is not offered", async () => {
    /* The department asked for it and finance has not agreed. A proposal is
       not an envelope, and offering one would let a manager commit against
       money nobody has approved. */
    const s = await seed();
    const id = await raise(s);
    const { body } = await call(s.tl, `/${id}/budget-heads`);
    expect(body.heads.some((h) => h.ledgerId === String(s.proposed._id))).toBe(false);
  });

  test("another department's approved head is not offered", async () => {
    const s = await seed();
    const id = await raise(s);
    const { body } = await call(s.tl, `/${id}/budget-heads`);
    expect(body.heads.some((h) => h.ledgerId === String(s.printing._id))).toBe(false);
  });

  test("a head in a cycle that has not been activated is not offered", async () => {
    const s = await seed();
    const id = await raise(s);
    const { body } = await call(s.tl, `/${id}/budget-heads`);
    expect(body.heads.some((h) => h.ledgerId === String(s.training._id))).toBe(false);
  });

  test("a revenue target is not offered", async () => {
    /* A sales target is a floor to reach. There is nothing to spend out of it,
       and treating one as an envelope would let a department "spend" its own
       income line. */
    const s = await seed();
    const id = await raise(s);
    const { body } = await call(s.tl, `/${id}/budget-heads`);
    expect(body.heads.some((h) => h.ledgerId === String(s.exportSales._id))).toBe(false);
  });

  test("the list follows the REQUESTER's department, not the manager's", async () => {
    /* Merchandising's manager reading a Merchandising request gets Printing —
       and never Tech's heads, even though Tech is where the other requests in
       this fixture live. */
    const s = await seed();
    /* Merchandising's own head, chosen by their own requester. */
    const id = await raise(s, s.hrEmp, { ledgerId: String(s.printing._id) });
    const { body } = await call(s.hrTl, `/${id}/budget-heads`);
    expect(body.department).toBe("Merchandising");
    expect(body.heads.map((h) => h.ledgerId)).toEqual([String(s.printing._id)]);
  });

  test("a department with nothing approved cannot raise at all, and is told why", async () => {
    /* The form shows the same dead end: "No approved budget heads for this
       department. Ask finance to add one." Enforced here too, so a client
       that skips the picker gets the same answer. */
    const s = await seed();
    const no = await refusedWithoutHead(s, s.hkEmp);
    expect(no.body.code).toBe("HEAD_NOT_REQUESTABLE");
    expect(no.body.message).toMatch(/New heads are added by finance/);

    /* And the picker that would have fed the form is genuinely empty. */
    const heads = await call(s.hkEmp, "/budget-heads");
    expect(heads.body.heads).toEqual([]);
    expect(heads.body.emptyMessage).toMatch(/No approved budget heads/);
  });
});

/* ═══ 2 · THE SERVER DOES NOT TRUST THE PICKER ════════════════════════════ */

describe("choosing a head the picker never offered", () => {
  /* A correction posted by the approver, checked against the same list the
     requester picked from. */
  const approveWith = (s, id, ledgerId) =>
    call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(ledgerId) } });

  test("a valid head is accepted", async () => {
    const s = await seed();
    const id = await raise(s);
    const ok = await approveWith(s, id, s.repairs._id);
    expect(ok.status).toBe(200);
    expect(ok.body.request.budgetHead.ledgerName).toMatch(/Repairs/);
  });

  test("a real ledger nobody budgeted is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    const no = await approveWith(s, id, s.stationery._id);
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/That budget head is not in this department's approved budget/);
    /* And nothing was written — the request is still waiting. */
    /* Nothing was written: the request still carries the head the requester
       legitimately chose, not the one the correction tried to force. */
    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.status).toBe("pending_tl");
    expect(String(doc.ledgerId)).toBe(String(s.repairs._id));
  });

  test("another department's approved head is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    const no = await approveWith(s, id, s.printing._id);
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/not in this department's approved budget/);
  });

  test("a revenue head is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    expect((await approveWith(s, id, s.exportSales._id)).status).toBe(400);
  });

  test("a head from an unactivated cycle is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    expect((await approveWith(s, id, s.training._id)).status).toBe(400);
  });

  test("a merely proposed head is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    expect((await approveWith(s, id, s.proposed._id)).status).toBe(400);
  });

  test("an id that is not a ledger at all is refused", async () => {
    const s = await seed();
    const id = await raise(s);
    const no = await approveWith(s, id, new mongoose.Types.ObjectId());
    expect(no.status).toBe(400);
  });

  test("raising with no head at all is refused", async () => {
    /* The gate moved to creation. The whole point of asking the requester is
       that it gets asked — a request with no envelope cannot be reviewed by
       anybody downstream. */
    const s = await seed();
    const no = await call(s.emp, "/", { method: "POST", body: ask({ ledgerId: undefined }) });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/budget head/i);
  });

  test("there is no escape hatch on this door any more", async () => {
    /* Not a free ledger choice AND not a free-text head. The only thing this
       form accepts is one of the department's approved allocations.

       The APPROVER's route still accepts a requested head — a different
       decision, made by somebody who holds the envelope — and the purchase
       door has its own. This is about what a requester may raise. */
    const s = await seed();
    await refusedWithoutHead(s, s.emp);

    /* Even naming a head without claiming it is unbudgeted is refused: the
       field itself is what this door will not take. */
    const named = await call(s.emp, "/", {
      method: "POST",
      body: ask({ ledgerId: undefined, requestedHeadName: "Drone survey" }),
    });
    expect(named.status).toBe(400);
    expect(named.body.code).toBe("HEAD_NOT_REQUESTABLE");
  });
});

/* ═══ 3 · WHAT TRAVELS ════════════════════════════════════════════════════ */

describe("the chosen head is carried forward", () => {
  const approve = async (s, id) => {
    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    expect(ok.status).toBe(200);
    return ok.body.request;
  };

  test("every field is persisted on the request itself", async () => {
    const s = await seed();
    const id = await raise(s);
    await approve(s, id);

    const doc = await IntakeRequest.findById(id).lean();
    expect(String(doc.ledgerId)).toBe(String(s.repairs._id));
    expect(doc.ledgerName).toMatch(/Repairs/);
    /* Both halves of the address: a line id inside an items[] array cannot be
       looked up without the budget that holds it. */
    expect(String(doc.budgetCycleId)).toBe(String(s.live._id));
    expect(doc.budgetLineId).toBeTruthy();
    expect(doc.budgetFinancialYear).toBe("2026-27");
    expect(doc.budgetDepartment).toBe("Tech");
    expect(doc.budgetMatchStatus).toBe("matched");
    expect(doc.budgetSnapshot).toMatchObject({
      approved: 40000, committed: 0, actual: 0, available: 40000,
    });
  });

  test("the line id points at the allocation it says it does", async () => {
    const s = await seed();
    const id = await raise(s);
    await approve(s, id);

    const doc = await IntakeRequest.findById(id).lean();
    const budget = await Acc_Budget.findById(doc.budgetCycleId).lean();
    const line = (budget.items || []).find((i) => String(i._id) === String(doc.budgetLineId));
    expect(line).toBeTruthy();
    expect(String(line.ledgerId)).toBe(String(s.repairs._id));
    expect(line.allocatedAmount).toBe(40000);
  });

  test("the snapshot is what the manager saw, not what the head says later", async () => {
    const s = await seed();
    const id = await raise(s);
    await approve(s, id);

    /* Finance tops the head up afterwards. The record of the decision does not
       move — it is a statement about a moment. */
    await Acc_Budget.updateOne(
      { _id: s.live._id, "items.ledgerId": s.repairs._id },
      { $set: { "items.$.allocatedAmount": 90000 } },
    );

    const doc = await IntakeRequest.findById(id).lean();
    expect(doc.budgetSnapshot.approved).toBe(40000);
  });
});

/* ═══ 4 · WHAT STORE & PURCHASE SEE ═══════════════════════════════════════ */

describe("the request reaches Store & Purchase with the head", () => {
  const approved = async (s, over = {}) => {
    const id = await raise(s, s.emp, over);
    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id), note: "Agreed" },
    });
    expect(ok.status).toBe(200);
    return id;
  };

  test("it appears on the fulfilment queue", async () => {
    const s = await seed();
    const id = await approved(s);

    const { body } = await call(s.store, "/fulfilment");
    expect(body.requests.map((r) => r.id)).toContain(id);
    const row = body.requests.find((r) => r.id === id);
    expect(row.stageLabel).toBe("With Store for fulfilment");
  });

  test("the card carries the head and the whole budget position", async () => {
    const s = await seed();
    const id = await approved(s);

    const { body } = await call(s.store, "/fulfilment");
    const row = body.requests.find((r) => r.id === id);

    expect(row.budgetHead).toMatchObject({
      ledgerId: String(s.repairs._id),
      plannedItemKey: PLANNED_KEY,
      unbudgeted: false,
      budgetCycleId: String(s.live._id),
      financialYear: "2026-27",
      department: "Tech",
      matchStatus: "matched",
    });
    expect(row.budgetHead.ledgerName).toMatch(/Repairs/);
    expect(row.budgetHead.budgetLineId).toBeTruthy();

    /* ── AND NO BALANCES AT ALL ────────────────────────────────────────
       This assertion INVERTED. Store used to receive approved, spent,
       committed and what the request would leave, and the screen showed all
       four.

       Store is the fulfilment and commercial medium: they match stock and
       price a quote. Whether the company can afford that quote is finance's
       question, asked after it arrives. Showing Store the balance invited
       them to answer it — by trimming a quote to fit an envelope that is not
       theirs to manage, or by justifying an overrun they have no standing to
       justify.

       Stripped from the RESPONSE and not merely from the screen, which is the
       whole point: a figure that never leaves the server cannot be read out
       of the network tab. */
    expect(row.budgetHead.snapshot).toBeNull();
    expect(row.budgetHead.availableAfter).toBeNull();
  });

  test("the head's NAME still reaches Store, because routing needs it", async () => {
    /* The distinction the rule turns on. A store person has to know which
       envelope a request is charged to — it is on the purchase order and it
       decides which department is being spent on. What they must not see is
       how much is left in it. */
    const s = await seed();
    const id = await approved(s, {
      items: [
        { name: "Compressor service", quantity: 1, unit: "job", rate: 12000 },
        { name: "Filter", quantity: 2, unit: "pcs" },
      ],
    });

    const { body } = await call(s.store, "/fulfilment");
    const row = body.requests.find((r) => r.id === id);

    expect(row.budgetHead.ledgerName).toMatch(/Repairs/);
    expect(row.budgetHead.department).toBe("Tech");
    expect(row.budgetHead.snapshot).toBeNull();
  });

  test("and everything else the fulfiller has to decide with", async () => {
    const s = await seed();
    const id = await approved(s);

    const { body } = await call(s.store, "/fulfilment");
    const row = body.requests.find((r) => r.id === id);

    expect(row.requestedByName).toMatch(/Rutu/);
    expect(row.department).toBe("Tech");
    expect(row.purpose).toMatch(/second shift/);
    expect(row.neededBy).toBeTruthy();
    expect(row.items[0]).toMatchObject({ name: "Compressor service", quantity: 1, unit: "job" });
    expect(row.tlApprovedByName).toMatch(/Meera/);
    expect(typeof row.attachmentCount).toBe("number");
  });

  test("Store cannot change the head, whatever it posts", async () => {
    const s = await seed();
    const id = await approved(s);

    /* Printing is Merchandising's, and it is a real approved head — the most
       plausible thing a client could post. It is ignored, not refused,
       because the head is simply not read from this request body. */
    const done = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "purchase", ledgerId: String(s.printing._id) },
    });
    expect(done.status).toBe(200);

    const spend = await SpendRequest.findOne({ intakeRequestId: id }).lean();
    expect(String(spend.ledgerId)).toBe(String(s.repairs._id));
    expect(String(spend.ledgerId)).not.toBe(String(s.printing._id));
  });

  test("the spend request finance sees carries the same head and its own figures", async () => {
    const s = await seed();
    const id = await approved(s);
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "purchase" } });

    const spend = await SpendRequest.findOne({ intakeRequestId: id }).lean();
    expect(String(spend.ledgerId)).toBe(String(s.repairs._id));
    expect(spend.budgetMatchStatus).toBe("matched");
    expect(String(spend.budgetCycleId)).toBe(String(s.live._id));
    expect(spend.budgetFinancialYear).toBe("2026-27");
    expect(spend.budgetDepartment).toBe("Tech");
    /* Recomputed against the agreed total rather than the estimate — this one
       is finance's figure, and it is not a guess. */
    expect(spend.budgetSnapshot).toMatchObject({
      approved: 40000, availableBefore: 40000, requested: 12000, availableAfter: 28000,
    });

    /* And finance's own desk reads it in the same shape as everything else —
       once the requester has confirmed the item and Store has sent it on. */
    {
      const saved = await IntakeRequest.findById(id).lean();
      await confirmAndSend(s, saved.spendRequestId, s.emp);
    }
    const desk = await call(s.fin, "/approvals");
    const row = desk.body.requests.find((r) => r.source === "spend");
    expect(row.budgetHead.snapshot).toMatchObject({ approved: 40000, available: 40000 });
    expect(row.budgetHead.availableAfter).toBe(28000);
    expect(row.budgetHead.availableAfterEstimated).toBe(false);
  });

  test("a head withdrawn between approval and classification is caught", async () => {
    const s = await seed();
    const id = await approved(s);

    /* Finance removes the allocation after the manager chose it. Filing spend
       against a head that is no longer approved is the silent wrong the
       picker exists to prevent, so the re-check refuses. */
    await Acc_Budget.updateOne(
      { _id: s.live._id },
      { $pull: { items: { ledgerId: s.repairs._id } } },
    );

    const no = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase" },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/no longer available to this department/);
    expect(await SpendRequest.countDocuments({ intakeRequestId: id })).toBe(0);
  });
});

/* ═══ 5 · OLD DATA ════════════════════════════════════════════════════════ */

describe("a request approved before managers chose heads", () => {
  test("renders with the head absent rather than blowing up", async () => {
    const s = await seed();
    /* Written the way the old flow left them: TL-approved, no head anywhere. */
    const doc = await IntakeRequest.create({
      title: "Old ask", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", status: "needs_classification",
      items: [{ name: "Blade", quantity: 2, unit: "pcs" }],
      tlApprovedByName: "Meera", tlApprovedAt: new Date(),
    });

    const { body } = await call(s.store, "/fulfilment");
    const row = body.requests.find((r) => r.id === String(doc._id));
    expect(row).toBeTruthy();
    /* Null, and the screen says "Budget head not set" — not a fabricated one. */
    expect(row.budgetHead).toBeNull();
  });

  test("and cannot become a spend request until somebody sets one", async () => {
    const s = await seed();
    const doc = await IntakeRequest.create({
      title: "Old ask", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", status: "needs_classification",
      items: [{ name: "Blade", quantity: 2, unit: "pcs", rate: 500 }],
    });

    const no = await call(s.store, `/${doc._id}/classify`, {
      method: "PATCH", body: { kind: "purchase" },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/budget head/i);
  });
});

/* ═══ 6 · MATERIAL FROM STORE ═════════════════════════════════════════════ */

describe("stock the company already holds", () => {
  test("still becomes an MRF with no finance step and no commitment", async () => {
    const s = await seed();
    const id = await raise(s);
    await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });

    const done = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "store_issue" },
    });
    expect(done.status).toBe(200);

    const mrf = await MRF.findOne({ requestedForId: s.emp.biometricId }).lean();
    expect(mrf.status).toBe("APPROVED");
    expect(mrf.tlApproved).toBe(true);
    /* Issuing owned stock spends nothing. */
    expect(await SpendRequest.countDocuments({})).toBe(0);
  });

  test("the material app's own door is untouched", async () => {
    const s = await seed();
    const r = await call(s.emp, "/", {
      app: "mrf", method: "POST",
      body: {
        requestType: "USES_BASED", reason: "Old one failed", priority: "NORMAL",
        items: [{ itemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.mrf.status).toBe("PENDING");
    /* No head was ever chosen on this path, and none is invented. */
    expect(r.body.mrf.budgetLedgerId).toBeFalsy();
  });

  test("the head the manager chose stays available for a later purchase", async () => {
    /* The store may find it cannot supply it after all. The decision the
       manager already made is still on the record — on the request AND on the
       MRF — so nobody has to answer the same question twice. */
    const s = await seed();
    const id = await raise(s);
    await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id) },
    });
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });

    const doc = await IntakeRequest.findById(id).lean();
    expect(String(doc.ledgerId)).toBe(String(s.repairs._id));
    expect(String(doc.budgetCycleId)).toBe(String(s.live._id));
    expect(doc.budgetMatchStatus).toBe("matched");

    const mrf = await MRF.findById(doc.mrfId).lean();
    expect(String(mrf.intakeRequestId)).toBe(String(id));
    expect(String(mrf.budgetLedgerId)).toBe(String(s.repairs._id));
    expect(String(mrf.budgetCycleId)).toBe(String(s.live._id));
    expect(mrf.budgetDepartment).toBe("Tech");
    expect(mrf.budgetHeadRequested).toBe(false);

    /* And the desk shows it on the MRF row, so the store can see which
       envelope this would come out of if they cannot supply it. */
    const { body } = await call(s.emp, "/");
    const row = body.requests.find((r) => r.id === id);
    expect(row.budgetHead.ledgerName).toMatch(/Repairs/);
  });
});
