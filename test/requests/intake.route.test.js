// test/requests/intake.route.test.js
//
// ONE DOOR IN, FOUR WAYS OUT — end to end.
//
// The claim under test is a claim about people, not about code: a requester
// asks for what they need without knowing how this company gets it, and the
// two questions they cannot answer — is there stock, and may we spend — are
// asked later, of the people who can.
//
// So these tests follow the request rather than the endpoint. Somebody asks;
// their manager agrees the department needs it; the store says whether it is
// on the shelf; and only when it is not does finance ever hear about it.
//
// ── AND THE OLD DOORS STILL OPEN ────────────────────────────────────────────
// Nothing was migrated. Requests raised through the two-tab form that this
// intake replaces are still exactly the documents they were, and the last
// group here proves they still appear on the desk — because a rewrite that
// loses last month's requests is not a rewrite anybody can ship.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

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
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/intake",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/intakeRequests"),
  );
  /* The purchase door the intake replaces, mounted so the "old requests still
     load" group can raise one the way it always was raised. */
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body, app = "intake" } = {}) =>
  fetch(`${base}/${app}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt.sign(
        { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
          name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
        process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
      )}`,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * Four people and one budget.
 *
 *   emp    a Tech employee who reports to tl
 *   tl     their manager, who reports to nobody
 *   store  Store & Purchase — holds the `store` department grant
 *   fin    a finance approver in the books
 *
 * Tech has one approved head with ₹40,000 on it. Merchandising has one too,
 * so "the head offered is the REQUESTER's, not the classifier's" has something
 * to be wrong about.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Intake Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = (name) =>
    Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`, groupId: expGroup._id,
      groupName: expGroup.name, nature: "expense",
    });

  const repairs = await mk("Repairs & Maintenance");
  const printing = await mk("Printing");

  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
        department: "Tech", allocatedAmount: 40000 },
      { ledgerId: printing._id, ledgerName: printing.name, nature: "expense",
        department: "Merchandising", allocatedAmount: 60000 },
    ],
  }));

  const tl = await Employee.create({
    firstName: "Meera", lastName: `L${n}`, email: `tl${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TL${n}`, department: "Tech",
  });
  const emp = await Employee.create({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TC${n}`, department: "Tech",
    primaryManager: { managerId: tl._id },
  });

  /* Store & Purchase, identified the way login identifies them: a department
     grant, not a role somebody typed on a form. */
  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: "store", slug: "store", name: "Store & Purchase",
      dashboardPath: "/store", isActive: true,
    }));
  const store = await Employee.create({
    firstName: "Bikash", lastName: `S${n}`, email: `store${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `ST${n}`, department: "Store",
    accessDepartmentId: storeDept._id,
  });

  const fin = await Employee.create({
    firstName: "Soumya", lastName: `F${n}`, email: `fin${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `FN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `fin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  HEAD = String(repairs._id);
  return { company, repairs, printing, emp, tl, store, fin };
}

/** What somebody needs. Note what is NOT here: no type, no head, no store-vs-buy. */
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

/**
 * Ask, then have the manager agree the department needs it AND choose the head.
 *
 * Both in one helper because they are now one action: the manager cannot
 * approve without naming the budget head, which is the whole point of moving
 * that choice off the requester and off Store.
 */
async function askAndApprove(s, over = {}, approve = null) {
  const raised = await call(s.emp, "/", { method: "POST", body: ask(over) });
  expect(raised.status).toBe(201);
  const id = raised.body.request.id;
  const ok = await call(s.tl, `/${id}/approve`, {
    method: "PATCH",
    body: approve || { ledgerId: String(s.repairs._id) },
  });
  if (ok.status !== 200) console.error("approve refused:", ok.status, ok.body);
  expect(ok.status).toBe(200);
  return { id, raised: raised.body.request, approved: ok.body.request };
}


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

/* ═══ ASKING ══════════════════════════════════════════════════════════════ */

describe("raising a request", () => {
  test("a requester never chooses store, purchase, service or recurring", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", { method: "POST", body: ask() });

    expect(status).toBe(201);
    // Accepted with no requestType, no ledgerId and no fulfilment kind in the
    // body at all — the three things the old two-tab form demanded up front.
    expect(body.request.number).toMatch(/^REQ-\d{4}-\d{4}$/);
    expect(body.request.stageLabel).toBe("Waiting for department approval");
    expect(body.request.fulfilmentLabel).toBeNull();

    const saved = await IntakeRequest.findById(body.request.id).lean();
    expect(saved.fulfilmentKind).toBeUndefined();
    expect(saved.spendRequestId).toBeUndefined();
    expect(saved.mrfId).toBeUndefined();
  });

  test("the head the requester chose is recorded, and nothing else about money is", async () => {
    /* This claim INVERTED. The head used to be the manager's to choose, on the
       ground that a person needing a blade does not know the department's
       accounting. That is still true of the CHART — and it is not true of the
       two or three lines their own department has budget on, which is all the
       picker offers. Naming it up front means the approval chain reads a
       request that already says which envelope it comes out of.

       What the requester is STILL never asked for is the commercial half: no
       vendor, no rate, no tax. Store owns pricing and sourcing. */
    const s = await seed();
    const { body } = await call(s.emp, "/", { method: "POST", body: ask() });
    const saved = await IntakeRequest.findById(body.request.id).lean();

    expect(String(saved.ledgerId)).toBe(String(s.repairs._id));
    expect(saved.budgetMatchStatus).toBe("matched");
    /* The figures they were looking at when they chose it. */
    expect(saved.budgetSnapshot.approved).toBe(40000);
    /* And nothing that prices it. */
    expect(saved).not.toHaveProperty("vendorName");
    expect(saved.items[0]).not.toHaveProperty("amount");
  });

  test("a rate is optional, and a total nobody could complete says so", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [
          { name: "Belt", quantity: 2, unit: "pcs", rate: 900 },
          { name: "Filter", quantity: 1, unit: "pcs" },
        ],
      }),
    });
    // 2 × 900 is what was estimated; the filter has no guess, so the figure is
    // reported as incomplete rather than quietly counting the filter as free.
    expect(body.request.estimate).toEqual({ amount: 1800, complete: false });
  });

  test("a line missing its quantity is refused by line number", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ name: "Belt", unit: "pcs" }] }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/Line 1: add a quantity/i);
  });

  test("an ask with no purpose is refused", async () => {
    const s = await seed();
    expect((await call(s.emp, "/", { method: "POST", body: ask({ purpose: "" }) })).status).toBe(400);
  });

  test("a title is optional and is composed from the lines when it is missing", async () => {
    // For a one-line request the title and the item name are the same
    // sentence, and demanding both is demanding it twice.
    const s = await seed();
    const one = await call(s.emp, "/", {
      method: "POST",
      body: ask({ title: "", items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }] }),
    });
    expect(one.status).toBe(201);
    expect(one.body.request.title).toBe("Cutting blade");

    const many = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        title: "",
        items: [
          { name: "Cutting blade", quantity: 10, unit: "pcs" },
          { name: "Belt", quantity: 1, unit: "pcs" },
          { name: "Filter", quantity: 1, unit: "pcs" },
        ],
      }),
    });
    expect(many.body.request.title).toBe("Cutting blade +2 more");
  });

  test("a title somebody wrote still wins", async () => {
    // A situation is a better summary than the part it needs.
    const s = await seed();
    const { body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({ title: "Compressor on line 2 is making a noise" }),
    });
    expect(body.request.title).toBe("Compressor on line 2 is making a noise");
  });

  test("a manager's own request skips the manager step", async () => {
    const s = await seed();
    const { body } = await call(s.tl, "/", { method: "POST", body: ask() });
    expect(body.request.stageLabel).toBe("With Store for fulfilment");
  });
});

/* ═══ THE MANAGER STEP ════════════════════════════════════════════════════ */

describe("the manager step", () => {
  test("the manager approves the NEED and nothing else", async () => {
    const s = await seed();
    const { approved } = await askAndApprove(s);

    expect(approved.stageLabel).toBe("With Store for fulfilment");
    expect(approved.tlApprovedByName).toMatch(/Meera/);
    // Nothing about money has been decided, and no spend document exists.
    expect(await SpendRequest.countDocuments({})).toBe(0);
  });

  test("it appears in the manager's queue and not the requester's", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });

    const tlQueue = await call(s.tl, "/approvals");
    expect(tlQueue.body.requests).toHaveLength(1);
    expect(tlQueue.body.requests[0].step).toBe("tl");

    const own = await call(s.emp, "/approvals");
    expect(own.body.requests).toHaveLength(0);
  });

  test("a rejection owes a reason", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const bad = await call(s.tl, `/${raised.body.request.id}/reject`, { method: "PATCH", body: {} });
    expect(bad.status).toBe(400);

    const ok = await call(s.tl, `/${raised.body.request.id}/reject`, {
      method: "PATCH", body: { note: "We are replacing that line next month" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.request.stageLabel).toBe("Rejected");
  });

  test("somebody else's manager cannot approve it", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const no = await call(s.store, `/${raised.body.request.id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });
    expect(no.status).toBe(403);
  });
});

/* ═══ CLASSIFICATION ══════════════════════════════════════════════════════ */

describe("classifying a request", () => {
  test("only store, purchase or finance may — never the requester", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s);

    const no = await call(s.emp, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/Store & Purchase or finance/i);

    const queue = await call(s.emp, "/fulfilment");
    expect(queue.status).toBe(403);
  });

  test("the queue shows what the manager has agreed to, and the ways out", async () => {
    const s = await seed();
    await askAndApprove(s);

    const { status, body } = await call(s.store, "/fulfilment");
    expect(status).toBe(200);
    expect(body.requests).toHaveLength(1);
    /* `partial` joined these when the store gained a way to say "I have eight
       of the twenty" — it issues what is on the shelf and sends only the
       balance for approval. */
    expect(body.kinds.map((k) => k.id).sort()).toEqual(
      ["partial", "purchase", "recurring", "service", "store_issue"],
    );
    expect(body.kinds.find((k) => k.id === "partial").needsFinance).toBe(true);
    // The screen is told which ways out cost money, so it can ask for a head
    // only where one is needed.
    expect(body.kinds.find((k) => k.id === "store_issue").needsFinance).toBe(false);
    expect(body.kinds.find((k) => k.id === "purchase").needsFinance).toBe(true);
  });

  test("stock the company already holds becomes an MRF and skips finance", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "store_issue" },
    });
    expect(status).toBe(200);
    expect(body.request.fulfilmentLabel).toBe("From store stock");
    expect(body.message).toMatch(/no finance approval needed/i);

    // Nothing was asked of finance, because nothing leaves the bank account.
    expect(await SpendRequest.countDocuments({})).toBe(0);

    const saved = await IntakeRequest.findById(id).lean();
    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.mrfNumber).toMatch(/^MRF/);
    // With the store, already TL-approved — exactly where an MRF approved
    // through the material app sits. No new state was invented.
    expect(mrf.status).toBe("APPROVED");
    expect(mrf.tlApproved).toBe(true);
    expect(mrf.requestedForId).toBe(s.emp.biometricId);
    // The line is UNMATCHED: the store's existing "not in the catalogue yet"
    // path, which they resolve on this same document as they do today.
    expect(mrf.items[0]).toMatchObject({
      rawItemName: "Cutting blade", requestedQty: 10, unit: "pcs", itemStatus: "UNMATCHED",
    });
  });

  test("something that has to be bought goes to the requester to confirm, not to finance", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Compressor belt", quantity: 2, unit: "pcs", rate: 1500 }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });
    expect(status).toBe(200);
    expect(body.request.fulfilmentLabel).toBe("Buy from outside");
    expect(body.message).toMatch(/with finance/i);

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    /* ── THIS ASSERTION CHANGED ─────────────────────────────────────────
       It used to be `pending_finance`: the department had agreed the need, so
       the only question left looked like money.

       It was not. Store sources what they think was meant, and "a mouse, the
       good one" can be sourced competently as the wrong model from a vendor
       on a six-week lead time. Finance approves it because the FIGURE fits,
       and the wrong thing is on order with the money committed. So the person
       who knows what they meant sees it first. */
    expect(spend.status).toBe("awaiting_requester_confirmation");
    expect(spend.requestType).toBe("PRODUCT");
    // The manager's yes is CARRIED, not reset. Asking them again would be the
    // same person answering the same question twice.
    expect(spend.tlApprovedByName).toMatch(/Meera/);
    expect(spend.totalAmount).toBe(3000);
    // The requester is still the requester — the classifier raised it FOR them.
    expect(spend.requestedById).toBe(s.emp.biometricId);
    expect(String(spend.intakeRequestId)).toBe(String(id));
    // And it matched the requester's department's envelope.
    expect(spend.budgetMatchStatus).toBe("matched");
    expect(spend.budgetSnapshot.approved).toBe(40000);
  });

  test("a repair becomes a service spend request, also waiting on the requester", async () => {
    const s = await seed();
    // Raised AS a service. The thing's own nature travels; the fulfilment
    // route is a different question and does not overwrite it.
    const { id } = await askAndApprove(s, { requestType: "SERVICE" });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "service", rates: { 0: 6500 } },
    });
    expect(status).toBe(200);

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.requestType).toBe("SERVICE");
    /* ── THIS ASSERTION CHANGED ─────────────────────────────────────────
       It used to be `pending_finance`: the department had agreed the need, so
       the only question left looked like money.

       It was not. Store sources what they think was meant, and "a mouse, the
       good one" can be sourced competently as the wrong model from a vendor
       on a six-week lead time. Finance approves it because the FIGURE fits,
       and the wrong thing is on order with the money committed. So the person
       who knows what they meant sees it first. */
    expect(spend.status).toBe("awaiting_requester_confirmation");
    expect(spend.totalAmount).toBe(6500);
  });

  test("a request with no head at all cannot become a spend request", async () => {
    /* Not reachable through the form any more — the head is required when the
       request is raised. Written straight into the collection the way a row
       from before that rule looks, because those still exist and still must
       not reach finance headless. */
    const s = await seed();
    const doc = await IntakeRequest.create({
      title: "Old ask", purpose: "Because", requestType: "PRODUCT",
      requestedBy: s.emp._id, requestedByName: "Rutu", requestedById: s.emp.biometricId,
      department: "Tech", status: "needs_classification",
      items: [{ name: "Belt", quantity: 1, unit: "pcs", rate: 1500 }],
    });

    const no = await call(s.store, `/${doc._id}/classify`, {
      method: "PATCH", body: { kind: "purchase" },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/budget head/i);
  });

  test("the heads offered are the REQUESTER's department's, not the classifier's", async () => {
    // A store person classifying a Tech request is spending Tech's envelope.
    const s = await seed();
    const { id } = await askAndApprove(s);

    const { status, body } = await call(s.store, `/${id}/budget-heads`);
    expect(status).toBe(200);
    expect(body.department).toBe("Tech");
    expect(body.heads.map((h) => h.ledgerId)).toEqual([String(s.repairs._id)]);
    /* Named, and with the year the picker's hint prints. Both were undefined
       once: the route read `ledgerName` off a service that calls the field
       `name`, and destructured a `financialYear` the service never returns. */
    expect(body.heads[0].ledgerName).toMatch(/Repairs/);
    expect(body.financialYear).toBe("2026-27");
    expect(body.heads.some((h) => h.ledgerId === String(s.printing._id))).toBe(false);
  });

  test("Store cannot substitute a head of its own at classification", async () => {
    // The head travels from the approval, and a ledger posted from this screen
    // is ignored rather than honoured. Store knows the shelf; the manager
    // knows the envelope.
    const s = await seed();
    const { id } = await askAndApprove(s, {}, { ledgerId: String(s.repairs._id) });

    const ok = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "purchase", rates: { 0: 500 }, ledgerId: String(s.printing._id) },
    });
    expect(ok.status).toBe(200);

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    // Repairs, which the manager chose — not Printing, which Store posted.
    expect(String(spend.ledgerId)).toBe(String(s.repairs._id));
  });

  test("a head that does not exist yet may still be asked for, in words", async () => {
    // The escape hatch, now the manager's. A department with nothing approved
    // is not stuck, and the ask reaches finance marked as a request FOR a head
    // rather than dressed up as a budgeted one.
    const s = await seed();
    const { id } = await askAndApprove(s, {}, {
      unbudgetedHead: true,
      requestedHeadName: "Drone survey",
      requestedHeadReason: "Nothing budgeted covers this",
    });
    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "service", rates: { 0: 12000 } },
    });
    expect(status).toBe(200);

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.unbudgetedHeadRequest).toBe(true);
    expect(spend.budgetApprovalKind).toBe("unbudgeted");
    expect(spend.ledgerName).toBe("Drone survey");
  });

  test("a line being bought with no rate anywhere is refused, by line", async () => {
    // A spend request whose lines are all zero is a request to approve nothing.
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Belt", quantity: 2, unit: "pcs" }],
    });
    const no = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/Line 1 \(Belt\) has no rate/);
  });

  test("classifying twice is refused", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s);
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });
    const again = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });
    expect(again.status).toBe(403);
    expect(again.body.message).toMatch(/already been classified/i);
  });

  test("a request the manager has not seen cannot be classified", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const no = await call(s.store, `/${raised.body.request.id}/classify`, {
      method: "PATCH", body: { kind: "store_issue" },
    });
    expect(no.status).toBe(403);
    expect(no.body.message).toMatch(/Waiting for department approval/);
  });
});

/* ═══ PRODUCT OR SERVICE, AND WHO CHOOSES THE HEAD ════════════════════════ */

describe("request type", () => {
  test("a requester submits a product with the head their department has budget on", async () => {
    /* The head is now part of the ask. What the requester is still not asked
       for is anything commercial — that is Store's. */
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({ requestType: "PRODUCT", title: "Two chairs" }),
    });
    expect(status).toBe(201);
    expect(body.request.requestTypeLabel).toBe("Product");
    expect(body.request.budgetHead.ledgerId).toBe(String(s.repairs._id));
    expect(body.request.budgetHead.matchStatus).toBe("matched");
  });

  test("a requester submits a service the same way", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({ requestType: "SERVICE", title: "Compressor service" }),
    });
    expect(status).toBe(201);
    expect(body.request.requestTypeLabel).toBe("Service");
    expect(body.request.budgetHead.ledgerId).toBe(String(s.repairs._id));
  });

  test("there is no third type — software is a service, not a category", async () => {
    // A subscription is work and access bought from a vendor. Offering it as
    // its own type only asked people to draw a line that does not exist.
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST", body: ask({ requestType: "SOFTWARE" }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/product or a service/i);
  });

  test("an unstated type defaults to product rather than failing", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", { method: "POST", body: ask() });
    expect(status).toBe(201);
    expect(body.request.requestType).toBe("PRODUCT");
  });
});

describe("the manager chooses the budget head", () => {
  test("an approver may correct the head, and a bad one is still refused", async () => {
    /* The head arrives on the request, so approving is one click again — but
       an approver holds the envelope and may disagree, and a correction is
       checked against the same approved list the requester picked from. */
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const id = raised.body.request.id;

    /* Approving with nothing posted leaves the requester's choice standing. */
    const plain = await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    expect(plain.status).toBe(200);
    expect(plain.body.request.budgetHead.ledgerId).toBe(String(s.repairs._id));

    /* And a correction to a head this department has no budget on is refused. */
    const raised2 = await call(s.emp, "/", { method: "POST", body: ask() });
    const bad = await call(s.tl, `/${raised2.body.request.id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.printing._id) },
    });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/not in this department's approved budget/i);
  });

  test("the head is recorded on the request, with what the manager was looking at", async () => {
    const s = await seed();
    const { id, approved } = await askAndApprove(s);

    expect(approved.budgetHead).toMatchObject({
      ledgerId: String(s.repairs._id),
      plannedItemKey: PLANNED_KEY,
      unbudgeted: false,
      financialYear: "2026-27",
    });
    expect(approved.budgetHead.ledgerName).toMatch(/Repairs/);
    // The figures at the moment of choosing — not the head's figures today.
    expect(approved.budgetHead.snapshot).toMatchObject({ approved: 40000, available: 40000 });

    const saved = await IntakeRequest.findById(id).lean();
    expect(String(saved.ledgerId)).toBe(String(s.repairs._id));
  });

  test("only the requester's department's approved heads may be chosen", async () => {
    // A manager cannot spend Merchandising's envelope on a Tech request, and
    // posting the id by hand does not help.
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const no = await call(s.tl, `/${raised.body.request.id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.printing._id) },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/not in this department's approved budget/i);
  });

  test("the manager sees exactly those heads, and nobody else's", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const { status, body } = await call(s.tl, `/${raised.body.request.id}/budget-heads`);
    expect(status).toBe(200);
    expect(body.department).toBe("Tech");
    expect(body.heads.map((h) => h.ledgerId)).toEqual([String(s.repairs._id)]);
    expect(body.heads[0].ledgerName).toMatch(/Repairs/);
  });

  test("the requester may not see the head list — that was the whole point", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const no = await call(s.emp, `/${raised.body.request.id}/budget-heads`);
    expect(no.status).toBe(403);
  });

  test("a manager with nothing that fits may ask for a head, with a reason", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const id = raised.body.request.id;

    const noReason = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { unbudgetedHead: true, requestedHeadName: "Drone survey" },
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/why none of the department's approved heads fit/i);

    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH",
      body: {
        unbudgetedHead: true,
        requestedHeadName: "Drone survey",
        requestedHeadReason: "Nothing budgeted covers aerial work",
      },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.request.budgetHead).toMatchObject({
      ledgerName: "Drone survey", unbudgeted: true,
    });
  });

  test("the manager may correct the type, and only to the other one", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", {
      method: "POST", body: ask({ requestType: "PRODUCT" }),
    });
    const id = raised.body.request.id;

    const bad = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id), requestType: "SOFTWARE" },
    });
    expect(bad.status).toBe(400);

    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH", body: { ledgerId: String(s.repairs._id), requestType: "SERVICE" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body.request.requestTypeLabel).toBe("Service");
  });

  test("the head the manager chose is the head the spend request is raised on", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      requestType: "SERVICE",
      items: [{ name: "Compressor service", quantity: 1, unit: "job", rate: 6500 }],
    });
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "service" } });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(String(spend.ledgerId)).toBe(String(s.repairs._id));
    expect(spend.requestType).toBe("SERVICE");
    expect(spend.budgetMatchStatus).toBe("matched");
  });
});

/* ═══ SOMETHING THAT COMES BACK ═══════════════════════════════════════════ */

describe("a recurring spend", () => {
  test("the requester ticks a box; the schedule is captured at classification", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", {
      method: "POST",
      body: ask({ repeats: true, items: [{ name: "Design tool seats", quantity: 4, unit: "seats", rate: 2000 }] }),
    });
    // The one fulfilment question the requester CAN answer: will you need this
    // again. Not "is this a recurring spend classified as a service".
    expect(raised.body.request.repeats).toBe(true);

    const id = raised.body.request.id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });

    const no = await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "recurring", },
    });
    expect(no.status).toBe(400);
    expect(no.body.message).toMatch(/how often/i);

    const ok = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        kind: "recurring", frequency: "QUARTERLY", startsOn: "2026-07-01",
      },
    });
    expect(ok.status).toBe(200);

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    /* ── THIS ASSERTION CHANGED ─────────────────────────────────────────
       It used to be `pending_finance`: the department had agreed the need, so
       the only question left looked like money.

       It was not. Store sources what they think was meant, and "a mouse, the
       good one" can be sourced competently as the wrong model from a vendor
       on a six-week lead time. Finance approves it because the FIGURE fits,
       and the wrong thing is on order with the money committed. So the person
       who knows what they meant sees it first. */
    expect(spend.status).toBe("awaiting_requester_confirmation");
    expect(spend.recurring.isRecurring).toBe(true);
    expect(spend.recurring.frequency).toBe("QUARTERLY");
    // Captured, not generated: exactly one spend request exists, not four.
    expect(await SpendRequest.countDocuments({})).toBe(1);
  });
});

/* ═══ THE DESK ════════════════════════════════════════════════════════════ */

describe("my requests", () => {
  test("the ask and the thing it became are one row, not two", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Belt", quantity: 1, unit: "pcs", rate: 1500 }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });

    const { body } = await call(s.emp, "/");
    expect(body.requests).toHaveLength(1);
    const row = body.requests[0];
    expect(row.number).toMatch(/^REQ-/);
    // The live state is read from the spend request, not copied onto the ask.
    expect(row.stageLabel).toBe("Waiting for you to confirm what Store found");
    expect(row.becameNumber).toMatch(/^SPR-/);
  });

  test("a classified store request reads the MRF's state, in the desk's words", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s);
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });

    const before = await call(s.emp, "/");
    expect(before.body.requests[0].stageLabel).toBe("Ready for store");

    // The store issues it. Nothing writes back to the intake row.
    const saved = await IntakeRequest.findById(id).lean();
    await MRF.updateOne({ _id: saved.mrfId }, { $set: { status: "ISSUED" } });

    const after = await call(s.emp, "/");
    expect(after.body.requests[0].stageLabel).toBe("Issued");
  });

  test("a requester may withdraw an ask, but not after it has become something", async () => {
    const s = await seed();
    const a = await askAndApprove(s);
    const b = await askAndApprove(s);

    const ok = await call(s.emp, `/${a.id}/cancel`, { method: "PATCH", body: {} });
    expect(ok.status).toBe(200);
    expect(ok.body.request.stageLabel).toBe("Withdrawn");

    await call(s.store, `/${b.id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });
    const no = await call(s.emp, `/${b.id}/cancel`, { method: "PATCH", body: {} });
    expect(no.status).toBe(409);
    // It names the document it became, so the requester knows where to go.
    expect(no.body.message).toMatch(/MRF/);
  });

  test("the desk tells a person which tabs are theirs", async () => {
    const s = await seed();
    const requester = await call(s.emp, "/me");
    expect(requester.body.me).toMatchObject({ managesPeople: false, isFinance: false, canFulfil: false });

    const manager = await call(s.tl, "/me");
    expect(manager.body.me.managesPeople).toBe(true);

    const storeman = await call(s.store, "/me");
    expect(storeman.body.me.canFulfil).toBe(true);

    const finance = await call(s.fin, "/me");
    expect(finance.body.me).toMatchObject({ isFinance: true, canFulfil: true });
  });
});

/* ═══ THINGS THE STORE ALREADY HAS A NAME FOR ═════════════════════════════ */

describe("picking out of the store's catalogue", () => {
  /** A catalogued item, with stock on the shelf. */
  const stocked = async (n, over = {}) =>
    RawItem.create({
      name: `Bond paper ${n}`, sku: `BP-${n}`, unit: "Pkt", quantity: 12, ...over,
    });

  test("a picked line carries the catalogue's name, sku and unit", async () => {
    const s = await seed();
    const item = await stocked(seq);

    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [{ rawItemId: String(item._id), name: "whatever they typed", quantity: 2, unit: "Pkt" }],
      }),
    });
    expect(status).toBe(201);

    const saved = await IntakeRequest.findById(body.request.id).lean();
    // The catalogue's name wins over the box: they are usually the same, and
    // when they are not it is because somebody typed over a pick.
    expect(saved.items[0]).toMatchObject({
      name: item.name, rawItemSku: item.sku, baseUnit: "Pkt",
    });
    expect(String(saved.items[0].rawItem)).toBe(String(item._id));
  });

  test("what the catalogue holds is read live, and never called 'available'", async () => {
    const s = await seed();
    const item = await stocked(`live${seq}`, { quantity: 12 });
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ rawItemId: String(item._id), name: item.name, quantity: 2, unit: "Pkt" }] }),
    });

    const before = await call(s.emp, "/");
    expect(before.body.requests[0].items[0]).toMatchObject({
      stockOnHand: 12, stockUnit: "Pkt", sku: item.sku,
    });
    // The store's VERDICT is still absent — the catalogue's count is not it.
    expect(before.body.requests[0].items[0].availability).toBeNull();

    // Read live: a count frozen into the request would be a number somebody
    // acts on three weeks after it stopped being true.
    await RawItem.updateOne({ _id: item._id }, { $set: { quantity: 3 } });
    const after = await call(s.emp, "/");
    expect(after.body.requests[0].items[0].stockOnHand).toBe(3);
  });

  test("the manager's card carries the same count", async () => {
    const s = await seed();
    const item = await stocked(`mgr${seq}`);
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ rawItemId: String(item._id), name: item.name, quantity: 2, unit: "Pkt" }] }),
    });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].items[0].stockOnHand).toBe(12);
  });

  test("a picked line reaches the store already matched", async () => {
    // The whole point: it is issuable rather than sitting in the UNMATCHED
    // queue waiting for somebody to work out which bond paper was meant.
    const s = await seed();
    const item = await stocked(`match${seq}`);
    const raised = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [
          { rawItemId: String(item._id), name: item.name, quantity: 2, unit: "Pkt" },
          { name: "Something nobody stocks", quantity: 1, unit: "pcs" },
        ],
      }),
    });
    const id = raised.body.request.id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });

    const saved = await IntakeRequest.findById(id).lean();
    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items[0]).toMatchObject({
      rawItemName: item.name, rawItemSku: item.sku, baseUnit: "Pkt", itemStatus: "APPROVED",
    });
    expect(String(mrf.items[0].rawItem)).toBe(String(item._id));
    // And the described one still takes the existing UNMATCHED path.
    expect(mrf.items[1]).toMatchObject({ rawItem: null, itemStatus: "UNMATCHED" });
  });

  test("an id that names nothing is dropped, not refused", async () => {
    // Describing something the store has never stocked was always allowed, and
    // a stale id should not cost somebody their request.
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [
          { rawItemId: String(new mongoose.Types.ObjectId()), name: "Hand-made jig", quantity: 1, unit: "pcs" },
        ],
      }),
    });
    expect(status).toBe(201);
    const saved = await IntakeRequest.findById(body.request.id).lean();
    expect(saved.items[0]).toMatchObject({ name: "Hand-made jig", rawItem: null });
  });

  test("a line with no catalogue item reports no stock rather than zero", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });
    const { body } = await call(s.emp, "/");
    expect(body.requests[0].items[0]).toMatchObject({ stockOnHand: null, sku: null });
  });
});

/* ═══ WHAT THE THING LOOKS LIKE ═══════════════════════════════════════════ */

describe("pictures", () => {
  const pic = (n) => ({ url: `https://res.cloudinary.com/demo/image/upload/ref${n}.jpg`, name: `ref${n}.jpg` });

  test("a described line carries the requester's own reference photos", async () => {
    // Worth the most exactly where the catalogue cannot help: a part with no
    // name anybody agrees on is settled in one look by a picture of it.
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [{ name: "That bracket thing", quantity: 2, unit: "pcs", images: [pic(1), pic(2)] }],
      }),
    });
    expect(status).toBe(201);
    expect(body.request.items[0].images).toEqual([
      { url: pic(1).url, name: "ref1.jpg" },
      { url: pic(2).url, name: "ref2.jpg" },
    ]);
    // And they are what the attachment count counts.
    expect(body.request.attachmentCount).toBe(2);
  });

  test("a picked line shows the store's registered picture instead", async () => {
    const s = await seed();
    const item = await RawItem.create({
      name: `Bond paper pic${seq}`, sku: `BPP-${seq}`, unit: "Pkt", quantity: 5,
      /* There is no item-level picture in RawItem — the registered ones hang
         off the variants, which is what the store's own screens write. */
      variants: [{ combination: ["A4"], image: "https://res.cloudinary.com/demo/image/upload/bond.jpg" }],
    });
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ rawItemId: String(item._id), name: item.name, quantity: 1, unit: "Pkt" }] }),
    });

    const { body } = await call(s.emp, "/");
    const line = body.requests[0].items[0];
    // The two are kept apart: they answer different questions, and merging
    // them would lose which was which.
    expect(line.catalogueImage).toBe("https://res.cloudinary.com/demo/image/upload/bond.jpg");
    expect(line.images).toEqual([]);
  });

  test("the registered picture is read live, like the count", async () => {
    const s = await seed();
    const item = await RawItem.create({
      name: `Live pic ${seq}`, sku: `LP-${seq}`, unit: "Pcs", quantity: 1,
      variants: [{ combination: ["std"], image: "https://res.cloudinary.com/demo/image/upload/old.jpg" }],
    });
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ rawItemId: String(item._id), name: item.name, quantity: 1, unit: "Pcs" }] }),
    });

    await RawItem.updateOne(
      { _id: item._id },
      { $set: { "variants.0.image": "https://res.cloudinary.com/demo/image/upload/new.jpg" } },
    );
    const { body } = await call(s.emp, "/");
    expect(body.requests[0].items[0].catalogueImage).toMatch(/new\.jpg$/);
  });

  test("the manager's card carries the photos", async () => {
    const s = await seed();
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ name: "That bracket thing", quantity: 1, unit: "pcs", images: [pic(9)] }] }),
    });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].items[0].images).toHaveLength(1);
    expect(body.requests[0].attachmentCount).toBe(1);
  });

  test("photos travel to the store on the MRF a store-issue becomes", async () => {
    // On an UNMATCHED line they are most of what the store has to go on when
    // deciding which catalogue item this is, or what to register.
    const s = await seed();
    const raised = await call(s.emp, "/", {
      method: "POST",
      body: ask({ items: [{ name: "That bracket thing", quantity: 2, unit: "pcs", images: [pic(3)] }] }),
    });
    const id = raised.body.request.id;
    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });

    const saved = await IntakeRequest.findById(id).lean();
    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items[0].images).toHaveLength(1);
    expect(mrf.items[0].images[0].url).toBe(pic(3).url);
    expect(mrf.items[0].itemStatus).toBe("UNMATCHED");
  });

  test("a junk image entry is dropped, and never costs somebody their request", async () => {
    // A photo is an aid. Losing the ask because one upload came back malformed
    // would trade the important thing for the helpful one.
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [{
          name: "Thing", quantity: 1, unit: "pcs",
          images: [{ url: "javascript:alert(1)" }, { nope: true }, pic(4)],
        }],
      }),
    });
    expect(status).toBe(201);
    expect(body.request.items[0].images).toEqual([{ url: pic(4).url, name: "ref4.jpg" }]);
  });

  test("more than four photos on a line are capped, not refused", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [{
          name: "Thing", quantity: 1, unit: "pcs",
          images: [pic(1), pic(2), pic(3), pic(4), pic(5), pic(6)],
        }],
      }),
    });
    expect(status).toBe(201);
    expect(body.request.items[0].images).toHaveLength(4);
  });

  test("a line with no picture of either kind says so with nulls", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });
    const { body } = await call(s.emp, "/");
    expect(body.requests[0].items[0]).toMatchObject({ images: [], catalogueImage: null });
    expect(body.requests[0].attachmentCount).toBe(0);
  });
});

/* ═══ WHAT A MANAGER IS GIVEN TO DECIDE ON ════════════════════════════════ */

describe("the approval card's data", () => {
  test("carries who asked, from where, by when and at what priority", async () => {
    // A card that shows a title and two buttons makes an approval a guess.
    const s = await seed();
    await call(s.emp, "/", {
      method: "POST",
      body: ask({ priority: "URGENT", neededBy: "2026-09-15" }),
    });

    const { body } = await call(s.tl, "/approvals");
    const row = body.requests[0];
    expect(row).toMatchObject({
      requestedByName: expect.stringMatching(/Rutu/),
      department: "Tech",
      priority: "URGENT",
      stageLabel: "Waiting for department approval",
    });
    expect(row.number).toMatch(/^REQ-/);
    expect(row.neededBy).toMatch(/^2026-09-15/);
    expect(row.createdAt).toBeTruthy();
    expect(row.purpose).toBe(ask().purpose);
  });

  test("every line carries quantity, unit, rate and amount", async () => {
    const s = await seed();
    await call(s.emp, "/", {
      method: "POST",
      body: ask({
        items: [
          { name: "Belt", quantity: 2, unit: "pcs", rate: 900, note: "The old one snapped" },
          { name: "Filter", quantity: 1, unit: "pcs" },
        ],
      }),
    });

    const { body } = await call(s.tl, "/approvals");
    const [belt, filter] = body.requests[0].items;
    expect(belt).toMatchObject({
      name: "Belt", quantity: 2, unit: "pcs", rate: 900, amount: 1800,
      note: "The old one snapped",
      // A figure on an intake line is a guess, and says so.
      estimated: true,
    });
    // A line with no rate reports none rather than a confident zero.
    expect(filter).toMatchObject({ rate: null, amount: null });
  });

  test("a spend line's rate is not marked as an estimate", async () => {
    // It is the figure finance approves, not what somebody guessed.
    const s = await seed();
    await call(s.emp, "/", {
      app: "spend", method: "POST",
      body: {
        title: "Licence", requestType: "SERVICE", purpose: "Expiring",
        ledgerId: String(s.repairs._id),
        plannedItemKey: PLANNED_KEY,
        items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000 }],
      },
    });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].items[0]).toMatchObject({
      rate: 8000, amount: 8000, estimated: false,
    });
  });

  test("the card says which approval this is and what it means", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });

    const tl = await call(s.tl, "/approvals");
    expect(tl.body.requests[0].stepLabel).toMatch(/^Your turn: /);
    // The two steps are different promises, and the card must not blur them.
    expect(tl.body.requests[0].stepNote).toMatch(/confirms the department need/i);
    expect(tl.body.requests[0].stepNote).toMatch(/not approving any spend/i);
  });

  test("finance's card says the opposite thing", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Belt", quantity: 1, unit: "pcs", rate: 1500 }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });

    /* ── THE TWO STEPS THAT NOW SIT BEFORE FINANCE ──────────────────────
       The requester confirms what Store found, then Store sends it on.
       Before this, classification landed straight on finance's desk. */
    {
      const saved = await IntakeRequest.findById(id).lean();
      await confirmAndSend(s, saved.spendRequestId, s.emp);
    }

    const { body } = await call(s.fin, "/approvals");
    expect(body.requests[0].stepNote).toMatch(/commits the money/i);
    // And the head it will be charged to is on the card, because that is what
    // finance is agreeing to.
    expect(body.requests[0].accountHead).toContain("Repairs");
  });

  test("an unclassified request says so rather than leaving a blank", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].classified).toBe(false);
    expect(body.requests[0].fulfilmentLabel).toBeNull();
    // Nothing claims a head, because nobody has chosen one.
    expect(body.requests[0].accountHead).toBeNull();
  });

  test("attachments are counted, and zero is an answer rather than a gap", async () => {
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].attachmentCount).toBe(0);
  });

  test("no stock claim is made before the store has looked", async () => {
    // The store reviews availability AFTER the manager approves, so a card that
    // said "in stock" here would be answering a question nobody has asked.
    const s = await seed();
    await call(s.emp, "/", { method: "POST", body: ask() });
    const { body } = await call(s.tl, "/approvals");
    expect(body.requests[0].stock).toBeNull();
    expect(body.requests[0].items[0].availability).toBeNull();
  });

  test("once the store HAS looked, the finding travels with the request", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, { method: "PATCH", body: { kind: "store_issue" } });

    const saved = await IntakeRequest.findById(id).lean();
    await MRF.updateOne(
      { _id: saved.mrfId },
      { $set: { "items.0.availability": "PARTIAL", "items.0.availableQty": 4 } },
    );

    const { body } = await call(s.emp, "/");
    // Read from the MRF, not copied onto the ask — one fact, not two.
    expect(body.requests[0].stock).toMatchObject({
      label: "Part of it is in store", reviewed: 1, total: 1,
    });
  });

  test("a request with no optional details at all still composes", async () => {
    // No needed-by, no rates, no note, no vendor. Every field the card reads
    // is present and null rather than missing.
    const s = await seed();
    await call(s.emp, "/", {
      method: "POST",
      /* Neither the head NOR the planned item is optional any more — the
         request names the row of the plan it spends against, not just the
         accounting bucket. Everything else here is still left out on
         purpose. */
      body: {
        title: "A thing", purpose: "Because", ledgerId: HEAD,
        plannedItemKey: PLANNED_KEY,
        items: [{ name: "Thing", quantity: 1, unit: "pcs" }],
      },
    });
    const { body } = await call(s.tl, "/approvals");
    const row = body.requests[0];
    expect(row).toMatchObject({
      neededBy: null, estimate: null, accountHead: null, stock: null,
      attachmentCount: 0, classified: false, priority: "NORMAL",
    });
    expect(row.items[0]).toMatchObject({ rate: null, amount: null, availability: null });
  });

  test("a rejection without a reason is refused; one with a reason is not", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const id = raised.body.request.id;

    const bare = await call(s.tl, `/${id}/reject`, { method: "PATCH", body: {} });
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/say why/i);

    const withReason = await call(s.tl, `/${id}/reject`, {
      method: "PATCH", body: { note: "The line is being replaced next month" },
    });
    expect(withReason.status).toBe(200);
    // And the reason travels back to the person who asked.
    const mine = await call(s.emp, "/");
    expect(mine.body.requests[0].decisionNote).toMatch(/replaced next month/);
  });

  test("an approval note is optional and is recorded when given", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const id = raised.body.request.id;

    const ok = await call(s.tl, `/${id}/approve`, {
      method: "PATCH",
      body: { note: "Do it before the shift change", ledgerId: String(s.repairs._id) },
    });
    expect(ok.status).toBe(200);

    const saved = await IntakeRequest.findById(id).lean();
    const entry = saved.history.find((h) => h.action === "approved at tl");
    // The note, and the head — so the trail says what was decided, not only
    // that somebody said yes.
    expect(entry.note).toMatch(/Do it before the shift change/);
    expect(entry.note).toMatch(/Repairs/);
  });

  test("approving twice is refused, so a double-tap cannot double-approve", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", { method: "POST", body: ask() });
    const id = raised.body.request.id;

    const first = await call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });
    expect(first.status).toBe(200);
    const second = await call(s.tl, `/${id}/approve`, { method: "PATCH", body: { ledgerId: String(s.repairs._id) } });
    expect(second.status).toBe(403);
    expect(second.body.message).toMatch(/With Store for fulfilment/);
  });
});

/* ═══ WHAT WAS RAISED BEFORE ANY OF THIS EXISTED ══════════════════════════ */

describe("requests raised through the doors this replaces", () => {
  test("an old material request still appears on the desk", async () => {
    const s = await seed();
    // Written exactly as the material app writes them — nothing migrated.
    await MRF.create({
      requestedFor: s.emp._id, requestedForName: "Rutu", requestedForDept: "Tech",
      requestedForId: s.emp.biometricId, requestType: "USES_BASED", status: "APPROVED",
      createdByRef: s.emp._id, createdByModel: "Employee", createdByName: "Rutu",
      items: [{ rawItem: null, rawItemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
    });

    const { body } = await call(s.emp, "/");
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0]).toMatchObject({
      source: "mrf",
      stageLabel: "Ready for store",
      fulfilmentLabel: "From store stock",
    });
    expect(body.requests[0].items[0]).toMatchObject({ name: "Thread cone", quantity: 6 });
  });

  test("an old purchase request still appears, and still approves", async () => {
    const s = await seed();
    const raised = await call(s.emp, "/", {
      app: "spend",
      method: "POST",
      body: {
        title: "Licence renewal", requestType: "SERVICE", purpose: "Expiring",
        ledgerId: String(s.repairs._id),
        plannedItemKey: PLANNED_KEY,
        items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000 }],
      },
    });
    expect(raised.status).toBe(201);

    const desk = await call(s.emp, "/");
    expect(desk.body.requests).toHaveLength(1);
    expect(desk.body.requests[0]).toMatchObject({
      source: "spend",
      number: raised.body.request.requestNumber,
      stageLabel: "Waiting for department approval",
    });

    // And its approval still routes to the same manager, on the same desk.
    const queue = await call(s.tl, "/approvals");
    expect(queue.body.requests).toHaveLength(1);
    expect(queue.body.requests[0].source).toBe("spend");
    expect(queue.body.requests[0].step).toBe("tl");
  });

  test("the approval desk carries all three kinds at once", async () => {
    const s = await seed();
    // One of each, all waiting on the same manager.
    await call(s.emp, "/", { method: "POST", body: ask() });
    await call(s.emp, "/", {
      app: "spend", method: "POST",
      body: {
        title: "Licence", requestType: "SERVICE", purpose: "Expiring",
        ledgerId: String(s.repairs._id),
        plannedItemKey: PLANNED_KEY,
        items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000 }],
      },
    });
    await MRF.create({
      requestedFor: s.emp._id, requestedForName: "Rutu", requestedForId: s.emp.biometricId,
      requestType: "USES_BASED", status: "PENDING",
      createdByRef: s.emp._id, createdByModel: "Employee", createdByName: "Rutu",
      approverBiometricId: s.tl.biometricId,
      items: [{ rawItem: null, rawItemName: "Thread cone", requestedQty: 6, unit: "pcs" }],
    });

    const { body } = await call(s.tl, "/approvals");
    expect(body.requests.map((r) => r.source).sort()).toEqual(["intake", "mrf", "spend"]);
    // Every one of them says whose approval it is waiting for, in one word.
    expect(body.requests.every((r) => r.stepLabel)).toBe(true);
  });

  test("a finance approver sees the finance step on the same desk", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Belt", quantity: 1, unit: "pcs", rate: 1500 }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { kind: "purchase", },
    });

    /* ── THE TWO STEPS THAT NOW SIT BEFORE FINANCE ──────────────────────
       The requester confirms what Store found, then Store sends it on.
       Before this, classification landed straight on finance's desk. */
    {
      const saved = await IntakeRequest.findById(id).lean();
      await confirmAndSend(s, saved.spendRequestId, s.emp);
    }

    const { body } = await call(s.fin, "/approvals");
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].step).toBe("finance");
    expect(body.requests[0].stepLabel).toBe("Finance approval");
    expect(body.counts).toEqual({ tl: 0, finance: 1 });
  });
});

/* ═══ THE ROUTE IS DERIVED FROM WHAT THE STORE CAN ISSUE ═══════════════════
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 * Store says how much of each line it can hand over today. The route follows
 * from that arithmetic and is never asked for as a separate answer, because a
 * category and a quantity are two chances to say the same thing and the two
 * can disagree. All of it → stock. None of it → buy. Some of it → both.
 *
 * ── AND WHY IT IS RE-DERIVED ON THE SERVER ──────────────────────────────────
 * The browser derives it too, to label the button. But the quantities are what
 * the MRF and the spend request are actually built from, so a posted `kind`
 * that disagrees with them would produce a document that contradicts its own
 * numbers. The quantities win; the posted kind is not read when a plan is
 * present. That is what the last test here pins.
 */
describe("the fulfilment route is inferred from the issue quantities", () => {
  test("issuing the whole quantity is a stock issue, and never reaches finance", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 10 } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("store_issue");
    expect(saved.mrfId).toBeTruthy();
    // Nothing left the bank account, so nobody was asked about money.
    expect(saved.spendRequestId).toBeUndefined();
    expect(body.request.stageLabel).toBe("Ready for store");
  });

  test("issuing none of it is a purchase", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 0 }, rates: { 0: 50 } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("purchase");
    expect(saved.spendRequestId).toBeTruthy();
    expect(saved.mrfId).toBeUndefined();
  });

  test("issuing some of it raises BOTH, and only the balance is priced", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 20, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 8 }, rates: { 0: 50 } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("partial");
    expect(saved.mrfId).toBeTruthy();
    expect(saved.spendRequestId).toBeTruthy();

    // The MRF describes its OWN half — eight, not the twenty that was asked
    // for. An MRF for twenty would read as twelve short forever.
    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items).toHaveLength(1);
    expect(mrf.items[0].requestedQty).toBe(8);

    // Finance is asked about the balance only. Approving twenty when eight are
    // already coming off the shelf is approving eight of them twice.
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].quantity).toBe(12);
    expect(spend.totalAmount).toBe(600);
    expect(body.message).toMatch(/for the balance/);
  });

  test("a line fully covered by stock is left off the spend request entirely", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Cutting blade", quantity: 10, unit: "pcs" },
        { name: "Coolant", quantity: 4, unit: "L" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      // The blades are all on the shelf; none of the coolant is.
      body: { issue: { 0: 10, 1: 0 }, rates: { 1: 200 } },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    // Not a zero-value blade line — finance is not asked to approve nothing.
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].name).toBe("Coolant");

    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items).toHaveLength(1);
    expect(mrf.items[0].rawItemName).toBe("Cutting blade");
  });

  test("GST is carried, and the budget is committed on the figure that will be paid", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 0 }, rates: { 0: 100 }, gstPercent: 18 },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.totalAmount).toBe(1000);
    expect(spend.gstPercent).toBe(18);
    expect(spend.taxAmount).toBe(180);
    // The whole point: a commitment raised on the pre-tax subtotal
    // under-reserves the head by the tax, and it only shows up when the
    // voucher posts and the head is suddenly over.
    expect(spend.grandTotal).toBe(1180);
  });

  test("you cannot issue more than was asked for", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 11 } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/cannot issue 11 against a request for 10/);
  });

  test("a negative issue quantity is refused", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: -1 } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/cannot be negative/);
  });

  test("a service can never be issued from stock", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      requestType: "SERVICE",
      items: [{ name: "Compressor service", quantity: 1, unit: "job" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 1 } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/cannot be issued from stock/);
  });

  test("a service with nothing issued arranges a service, not a purchase", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      requestType: "SERVICE",
      items: [{ name: "Compressor service", quantity: 1, unit: "job" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { issue: { 0: 0 }, rates: { 0: 4000 } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("service");
  });

  test("the quantities win over a kind that disagrees with them", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    // Claims a stock issue while issuing none of it. The documents are built
    // from the quantities, so a route taken from the label would produce an
    // MRF for ten items the store just said it does not have.
    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "store_issue", issue: { 0: 0 }, rates: { 0: 50 } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("purchase");
    expect(saved.mrfId).toBeUndefined();
  });

  test("naming the kind with no plan still works, for callers that predate this", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blade", quantity: 10, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "store_issue" },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("store_issue");
  });
});

/* ═══ THE STORE MATCHES THE ASK TO THE SHELF ═══════════════════════════════
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 * A requester describes what they need in their own words. The store's first
 * real job is deciding WHICH inventory item that is — or that it is not one
 * yet. Those two decisions, per line, are what the route falls out of; the
 * store never picks a route directly.
 *
 * ── WHY THE MATCH IS WORTH CARRYING ─────────────────────────────────────────
 * A described line used to reach the MRF as UNMATCHED, and somebody had to
 * work out which item was meant a second time on the MRF's own screen. When
 * the store has already said, the MRF arrives issuable. The negative half
 * matters as much: a quantity with no item behind it, or one the shelf cannot
 * cover, is refused rather than driving stock negative.
 */
describe("matching a requested line to an inventory item", () => {
  const stocked = async (n, over = {}) =>
    RawItem.create({ name: `Mouse ${n}`, sku: `MS-${n}`, unit: "pcs", quantity: 20, ...over });

  test("a matched line reaches the store already issuable", async () => {
    const s = await seed();
    const item = await stocked(seq++);
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse, the good one", quantity: 5, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { rawItemId: String(item._id), issueQty: 5 } } },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("store_issue");

    const mrf = await MRF.findById(saved.mrfId).lean();
    // The catalogue's identity, not the requester's paraphrase — and APPROVED
    // rather than UNMATCHED, so nobody matches it twice.
    expect(String(mrf.items[0].rawItem)).toBe(String(item._id));
    expect(mrf.items[0].rawItemName).toBe(item.name);
    expect(mrf.items[0].rawItemSku).toBe(item.sku);
    expect(mrf.items[0].itemStatus).toBe("APPROVED");
  });

  test("a line the store cannot place is bought under the name the store proposes", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Some kind of dock", quantity: 3, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, newItemName: "USB-C dock, dual HDMI, 100W PD", rate: 4500 },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("purchase");

    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    // The name a vendor and finance will both read, not the requester's guess.
    expect(spend.items[0].name).toBe("USB-C dock, dual HDMI, 100W PD");
    expect(spend.items[0].quantity).toBe(3);
    expect(spend.totalAmount).toBe(13500);
  });

  test("splitting one line issues the matched item and buys the balance", async () => {
    const s = await seed();
    const item = await stocked(seq++, { quantity: 8 });
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse, the good one", quantity: 20, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            rawItemId: String(item._id),
            issueQty: 8,
            newItemName: "Logitech MX Master 3S",
            rate: 7000,
          },
        },
      },
      });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("partial");

    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items[0].requestedQty).toBe(8);
    expect(String(mrf.items[0].rawItem)).toBe(String(item._id));

    // The balance is CALCULATED — 20 asked minus 8 issued — never typed.
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items[0].quantity).toBe(12);
    expect(spend.items[0].name).toBe("Logitech MX Master 3S");
    expect(spend.totalAmount).toBe(84000);
  });

  test("issuing more than is on the shelf is refused", async () => {
    const s = await seed();
    const item = await stocked(seq++, { quantity: 3 });
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { rawItemId: String(item._id), issueQty: 5, rate: 100 } } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/only 3 of .* is in store/);
  });

  test("a quantity with no item behind it is refused", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 4, rate: 100 } } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/choose which inventory item/);
  });

  test("an inventory item that does not exist is refused", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse", quantity: 10, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: { 0: { rawItemId: String(new mongoose.Types.ObjectId()), issueQty: 4 } },
      },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/not in the catalogue/);
  });

  test("lines decided differently produce one MRF and one spend request", async () => {
    const s = await seed();
    const item = await stocked(seq++, { quantity: 50 });
    const { id } = await askAndApprove(s, {
      items: [
        { name: "A mouse", quantity: 6, unit: "pcs" },
        { name: "A dock nobody stocks", quantity: 2, unit: "pcs" },
      ],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { rawItemId: String(item._id), issueQty: 6 },
          1: { issueQty: 0, newItemName: "USB-C dock", rate: 4000 },
        },
        gstPercent: 18,
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("partial");

    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items).toHaveLength(1);
    expect(mrf.items[0].rawItemName).toBe(item.name);

    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].name).toBe("USB-C dock");
    expect(spend.totalAmount).toBe(8000);
    expect(spend.grandTotal).toBe(9440);
  });
});

/* ═══ THE QUOTE, NOT AN ESTIMATE ═══════════════════════════════════════════
 * Finance approves a figure somebody was actually quoted. The two fields here
 * are what make that figure traceable afterwards: the vendor's own reference
 * for the quote, and the spec the item was quoted against. Both optional —
 * plenty of small purchases are quoted over the phone — and both additive, so
 * every request written before them still loads.
 */
describe("the quote a purchase is built from", () => {
  test("the vendor's quote reference and the line spec travel to finance", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Some kind of dock", quantity: 2, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            issueQty: 0,
            newItemName: "USB-C dock, dual HDMI",
            spec: "100W PD, 2x HDMI 2.0, 1x RJ45",
            rate: 4500,
          },
        },
        vendorName: "Sharma Systems",
        gstin: "22AAAAA0000A1Z5",
        quoteRef: "SS/Q/2026/118",
        gstPercent: 18,
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();

    expect(spend.quoteRef).toBe("SS/Q/2026/118");
    expect(spend.vendorName).toBe("Sharma Systems");
    expect(spend.items[0].spec).toBe("100W PD, 2x HDMI 2.0, 1x RJ45");
    // The quoted total, tax included, is the figure that moves forward.
    expect(spend.totalAmount).toBe(9000);
    expect(spend.grandTotal).toBe(10620);
  });

  test("the requester's own note stands in when the store adds no spec", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Coolant", quantity: 4, unit: "L", note: "The blue one, not the green" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 200 } } },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items[0].spec).toBe("The blue one, not the green");
  });
});

/* ═══ EVERY LINE HAS ITS OWN QUOTE ═════════════════════════════════════════
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 * Commercial terms belong to the LINE, not the request. A laptop and an annual
 * service contract are two vendors, two tax rates and two delivery dates, and
 * a request that holds one of each simply lost the second line's terms.
 *
 * ── AND WHAT THE REQUEST-LEVEL FIELDS BECAME ────────────────────────────────
 * A summary. They stay because every screen, report and voucher written before
 * this reads them. One distinct value across the lines is the request's value;
 * several is not, and saying "Multiple" beats naming whichever line happened to
 * be first on a purchase order.
 */
describe("line-wise vendors and quotes", () => {
  test("two lines can carry two vendors, two GST rates and two delivery dates", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Laptop", quantity: 2, unit: "pcs" },
        { name: "Annual service contract", quantity: 1, unit: "yr" },
      ],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            issueQty: 0, newItemName: "ThinkPad T14", rate: 50000,
            vendorName: "Sharma Systems", gstin: "22AAAAA0000A1Z5",
            quoteRef: "SS/Q/118", gstPercent: 18,
            expectedDeliveryDate: "2026-09-15",
          },
          1: {
            issueQty: 0, newItemName: "AMC — 1 year", rate: 12000,
            vendorName: "Verma Services", gstin: "22BBBBB0000B1Z5",
            quoteRef: "VS/2026/44", gstPercent: 5,
            expectedDeliveryDate: "2026-09-01",
          },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();

    const laptop = spend.items.find((l) => l.name === "ThinkPad T14");
    const amc = spend.items.find((l) => l.name === "AMC — 1 year");

    expect(laptop.vendorName).toBe("Sharma Systems");
    expect(laptop.gstPercent).toBe(18);
    expect(laptop.taxAmount).toBe(18000);
    expect(laptop.lineTotal).toBe(118000);
    expect(laptop.quoteRef).toBe("SS/Q/118");

    expect(amc.vendorName).toBe("Verma Services");
    expect(amc.gstPercent).toBe(5);
    expect(amc.taxAmount).toBe(600);
    expect(amc.lineTotal).toBe(12600);

    // Totals sum the LINES, each at its own rate — not one averaged rate over
    // a combined subtotal, which matched neither invoice.
    expect(spend.totalAmount).toBe(112000);
    expect(spend.taxAmount).toBe(18600);
    expect(spend.grandTotal).toBe(130600);
  });

  test("the request-level fields summarise the lines rather than picking one", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Laptop", quantity: 1, unit: "pcs" },
        { name: "Contract", quantity: 1, unit: "yr" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 100, vendorName: "Sharma", quoteRef: "A/1",
               expectedDeliveryDate: "2026-10-20" },
          1: { issueQty: 0, rate: 100, vendorName: "Verma", quoteRef: "B/2",
               expectedDeliveryDate: "2026-09-05" },
        },
      },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();

    expect(spend.vendorName).toBe("Multiple");
    expect(spend.quoteRef).toBe("Multiple");
    // The EARLIEST date — the first commitment anybody has to meet.
    expect(spend.expectedDeliveryDate.toISOString().slice(0, 10)).toBe("2026-09-05");
  });

  test("one vendor across every line is still that vendor, not 'Multiple'", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Laptop", quantity: 1, unit: "pcs" },
        { name: "Dock", quantity: 1, unit: "pcs" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 100, vendorName: "Sharma", gstin: "22AAAAA0000A1Z5" },
          1: { issueQty: 0, rate: 200, vendorName: "Sharma", gstin: "22AAAAA0000A1Z5" },
        },
      },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.vendorName).toBe("Sharma");
    // Never a sentinel: a GSTIN field is read as a real identifier elsewhere.
    expect(spend.gstin).toBe("22AAAAA0000A1Z5");
  });

  test("a stock line and a purchase line coexist, and only the purchase is quoted", async () => {
    const s = await seed();
    const item = await RawItem.create({
      name: `Bond paper ${seq++}`, sku: `BP-${seq}`, unit: "Pkt", quantity: 40,
    });
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Bond paper", quantity: 10, unit: "Pkt" },
        { name: "Laptop", quantity: 1, unit: "pcs" },
      ],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { rawItemId: String(item._id), issueQty: 10 },
          1: { issueQty: 0, newItemName: "ThinkPad T14", rate: 50000,
               vendorName: "Sharma Systems", gstPercent: 18 },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("partial");

    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items).toHaveLength(1);
    expect(mrf.items[0].rawItemName).toBe(item.name);

    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].name).toBe("ThinkPad T14");
    expect(spend.grandTotal).toBe(59000);
  });

  test("a line GST above 28 is refused", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 100, gstPercent: 40 } } },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/between 0 and 28/);
  });

  test("a request-level quote still applies to every line, for older callers", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Laptop", quantity: 1, unit: "pcs" },
        { name: "Dock", quantity: 1, unit: "pcs" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        issue: { 0: 0, 1: 0 },
        rates: { 0: 100, 1: 200 },
        gstPercent: 18,
        vendorName: "Sharma",
        quoteRef: "OLD/1",
      },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    // Inherited by every line, which is exactly what used to happen.
    expect(spend.items.every((l) => l.vendorName === "Sharma")).toBe(true);
    expect(spend.items.every((l) => l.gstPercent === 18)).toBe(true);
    expect(spend.vendorName).toBe("Sharma");
    expect(spend.grandTotal).toBe(354);
  });
});

/* ═══ THE SUPPLIER PICKED OFF THE BOOKS ════════════════════════════════════
 * Most quotes come from somebody the company already buys from. Picking them
 * rather than retyping is what stops four spellings of one supplier that no
 * report can add together — but a genuinely new supplier is ordinary, so a
 * typed name is never refused.
 */
describe("the supplier on a quote", () => {
  test("a picked supplier is joined to the master, and the typed name still wins on screen", async () => {
    const s = await seed();
    const vendor = await Vendor.create({
      companyName: "Sharma Engineering", contactPerson: "R Sharma",
      phone: "9999999999", gstNumber: "22AAAAA0000A1Z5", status: "Active",
    });
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            issueQty: 0, rate: 50000,
            vendorName: "Sharma Engineering",
            vendorId: String(vendor._id),
            gstin: "22AAAAA0000A1Z5",
          },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(String(spend.items[0].vendorId)).toBe(String(vendor._id));
    expect(spend.items[0].vendorName).toBe("Sharma Engineering");
  });

  test("a supplier nobody has heard of BECOMES a real vendor record", async () => {
    /* ── THIS ASSERTION INVERTED ─────────────────────────────────────────
       It used to expect a null id here — a typed name stored as a bare
       string, nothing added to the vendor register. That was a promise the
       picker's own copy already made and the backend never kept: "Not on the
       books — it will be recorded as a new supplier." This is what makes that
       sentence true rather than decorative. */
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: { 0: { issueQty: 0, rate: 50000, vendorName: "A Brand New Shop", gstin: "22AAAAA0000A1Z5" } },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items[0].vendorName).toBe("A Brand New Shop");
    expect(spend.items[0].vendorId).toBeTruthy();

    const created = await Vendor.findById(spend.items[0].vendorId).lean();
    expect(created).toBeTruthy();
    expect(created.companyName).toBe("A Brand New Shop");
    expect(created.gstNumber).toBe("22AAAAA0000A1Z5");
  });

  test("the same name typed again resolves to the SAME vendor, not a second record", async () => {
    /* "sharma systems" on one request and "Sharma Systems" on another have to
       be one supplier — otherwise every typo and every casing difference is a
       new, disconnected vendor and the register never converges. */
    const s = await seed();
    const first = await askAndApprove(s, { items: [{ name: "Laptop", quantity: 1, unit: "pcs" }] });
    await call(s.store, `/${first.id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 50000, vendorName: "Repeat Traders" } } },
    });
    const firstSaved = await IntakeRequest.findById(first.id).lean();
    const firstSpend = await SpendRequest.findById(firstSaved.spendRequestId).lean();

    const second = await askAndApprove(s, { items: [{ name: "Dock", quantity: 1, unit: "pcs" }] });
    await call(s.store, `/${second.id}/classify`, {
      method: "PATCH",
      /* Different casing, on purpose. */
      body: { lines: { 0: { issueQty: 0, rate: 4000, vendorName: "repeat traders" } } },
    });
    const secondSaved = await IntakeRequest.findById(second.id).lean();
    const secondSpend = await SpendRequest.findById(secondSaved.spendRequestId).lean();

    expect(String(secondSpend.items[0].vendorId)).toBe(String(firstSpend.items[0].vendorId));
    expect(await Vendor.countDocuments({ companyName: /^repeat traders$/i })).toBe(1);
  });

  test("the lookup is refused to somebody without fulfilment access", async () => {
    const s = await seed();
    const { status } = await call(s.emp, "/vendors?search=sharma");
    expect(status).toBe(403);
  });

  test("a blank search returns nothing rather than every supplier on the books", async () => {
    const s = await seed();
    await Vendor.create({
      companyName: "Someone Ltd", contactPerson: "X", phone: "1", status: "Active",
    });
    const { body } = await call(s.store, "/vendors?search=");
    expect(body.vendors).toEqual([]);
  });

  test("suppliers are found by name or by GSTIN, and inactive ones are not offered", async () => {
    const s = await seed();
    await Vendor.create({
      companyName: "Findable Traders", contactPerson: "X", phone: "1",
      gstNumber: "29ZZZZZ1111Z1Z9", status: "Active",
    });
    await Vendor.create({
      companyName: "Findable Retired", contactPerson: "X", phone: "1", status: "Inactive",
    });

    const byName = await call(s.store, "/vendors?search=Findable");
    expect(byName.body.vendors.map((v) => v.name)).toEqual(["Findable Traders"]);

    const byGst = await call(s.store, "/vendors?search=29ZZZZZ");
    expect(byGst.body.vendors[0].name).toBe("Findable Traders");
  });
});

/* ═══ A REQUEST IS NOT ONE DECISION ════════════════════════════════════════
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 * Refusal is per LINE. A box of blades may be on the shelf, a dock may have to
 * be bought, and a discontinued part may be gettable from nobody at all — and
 * the first two must not be held up by the third. The whole request is
 * returned only when EVERY line fails.
 *
 * ── AND THE REQUESTER FINDS OUT WHICH ───────────────────────────────────────
 * The reason lands on the line, not in a note at the foot of the request.
 * Before this, a partly-refused request produced a short delivery and the
 * person who asked had to work out what was missing.
 */
describe("refusing one line without refusing the request", () => {
  const stocked = async (n, over = {}) =>
    RawItem.create({ name: `Blade ${n}`, sku: `BL-${n}`, unit: "pcs", quantity: 50, ...over });

  test("one issued, one bought, one refused — and the first two still go", async () => {
    const s = await seed();
    const item = await stocked(seq++);
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Cutting blade", quantity: 10, unit: "pcs" },
        { name: "USB-C dock", quantity: 2, unit: "pcs" },
        { name: "Discontinued sensor", quantity: 1, unit: "pcs" },
      ],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { rawItemId: String(item._id), issueQty: 10 },
          1: { issueQty: 0, rate: 4000, vendorName: "Sharma Systems" },
          2: { cannotFulfil: true, reason: "The maker discontinued it and no vendor stocks one." },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    /* Not rejected. Two of the three are moving. */
    expect(saved.status).not.toBe("rejected");
    expect(saved.fulfilmentKind).toBe("partial");

    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items.map((l) => l.rawItemName)).toEqual([item.name]);

    /* The refused line is not priced and never reaches finance. */
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items).toHaveLength(1);
    expect(spend.items[0].name).toBe("USB-C dock");
    expect(spend.totalAmount).toBe(8000);

    /* And the requester can see which line, and why. */
    expect(saved.items[2].unfulfilled).toBe(true);
    expect(saved.items[2].unfulfilledReason).toMatch(/discontinued/);
    expect(saved.items[0].unfulfilled).toBe(false);
  });

  test("a refused line needs a reason", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Cutting blade", quantity: 10, unit: "pcs" },
        { name: "Discontinued sensor", quantity: 1, unit: "pcs" },
      ],
    });

    const { status, body } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 10 },
          1: { cannotFulfil: true, reason: "  " },
        },
      },
    });

    expect(status).toBe(400);
    expect(body.message).toMatch(/say why the store cannot fulfil this line/i);
  });

  test("every line refused returns the whole request, and raises nothing", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Discontinued sensor", quantity: 1, unit: "pcs" },
        { name: "Obsolete belt", quantity: 2, unit: "pcs" },
      ],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { cannotFulfil: true, reason: "Discontinued." },
          1: { cannotFulfil: true, reason: "No vendor makes this size." },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.status).toBe("rejected");
    /* No empty MRF and no zero-value spend request. */
    expect(saved.mrfId).toBeUndefined();
    expect(saved.spendRequestId).toBeUndefined();
    /* Both reasons survive, per line and merged on the decision. */
    expect(saved.items[0].unfulfilledReason).toBe("Discontinued.");
    expect(saved.items[1].unfulfilledReason).toMatch(/No vendor/);
    expect(saved.decisionNote).toMatch(/Discontinued sensor:/);
    expect(saved.decisionNote).toMatch(/Obsolete belt:/);
  });

  test("a refused line is left off the MRF even when it would have been issued", async () => {
    const s = await seed();
    const item = await stocked(seq++);
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Cutting blade", quantity: 10, unit: "pcs" },
        { name: "Second blade", quantity: 4, unit: "pcs" },
      ],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { rawItemId: String(item._id), issueQty: 10 },
          1: { cannotFulfil: true, reason: "None left and none coming." },
        },
      },
    });

    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("store_issue");
    const mrf = await MRF.findById(saved.mrfId).lean();
    expect(mrf.items).toHaveLength(1);
  });
});

/* ═══ THE VENDOR THE REQUESTER SUGGESTED, AND THE ONE STORE USED ═══════════
 * A requester who has been quoted by somebody is worth listening to. They are
 * not the person who negotiates terms, so the suggestion is information and
 * never an instruction — and finance sees both names, because "they asked for
 * Sharma and Store went to Verma" is a question worth being able to ask.
 */
describe("suggested versus selected vendor", () => {
  test("both names reach finance, with the reason Store went elsewhere", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });

    const { status } = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            issueQty: 0, rate: 50000,
            suggestedVendorName: "Sharma Systems",
            vendorName: "Verma Traders",
            vendorNote: "Sharma quoted 8% higher and could not deliver before the 20th.",
          },
        },
      },
    });

    expect(status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items[0].suggestedVendorName).toBe("Sharma Systems");
    expect(spend.items[0].vendorName).toBe("Verma Traders");
    expect(spend.items[0].vendorNote).toMatch(/8% higher/);
  });

  test("using the suggested vendor records the same name on both", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: {
            issueQty: 0, rate: 50000,
            suggestedVendorName: "Sharma Systems",
            vendorName: "Sharma Systems",
          },
        },
      },
    });

    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.items[0].suggestedVendorName).toBe("Sharma Systems");
    expect(spend.items[0].vendorName).toBe("Sharma Systems");
    // Nothing to explain when they agree.
    expect(spend.items[0].vendorNote).toBe("");
  });
});

/* ═══ THE REQUESTER CHECKS WHAT STORE FOUND ════════════════════════════════
 *
 * ── THE FAILURE THIS WHOLE LOOP EXISTS FOR ──────────────────────────────────
 * "A mouse, the good one" can be sourced perfectly competently as the wrong
 * model, from a vendor with a six-week lead time, at a price the requester
 * would never have asked for. Finance approves it because the FIGURE fits the
 * head — they are reading money against a budget, and catching the wrong item
 * is neither their job nor something they are equipped to do. By the time it
 * arrives, the money is committed.
 *
 * So the person who knows what they meant sees the item, spec, vendor, price
 * and date before anybody approves money against it.
 */
describe("requester confirmation, step by step", () => {
  /** Raise, approve, classify as a purchase, and return the spend request. */
  async function priced(s, over = {}) {
    const { id } = await askAndApprove(s, {
      items: [{ name: "A mouse, the good one", quantity: 2, unit: "pcs" }],
      ...over,
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: { 0: { issueQty: 0, rate: 2000, vendorName: "Sharma Systems" } },
      },
    });
    const saved = await IntakeRequest.findById(id).lean();
    return { id, spendId: saved.spendRequestId };
  }

  test("a classified purchase waits on the requester, not on finance", async () => {
    const s = await seed();
    const { spendId } = await priced(s);
    const spend = await SpendRequest.findById(spendId).lean();
    expect(spend.status).toBe("awaiting_requester_confirmation");
    expect(spend.requesterConfirmedAt).toBeUndefined();
  });

  test("confirming within budget hands it back to Store to send on", async () => {
    const s = await seed();
    const { spendId } = await priced(s);

    const { status, body } = await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { confirm: true } } },
    });

    expect(status).toBe(200);
    expect(body.request.status).toBe("requester_confirmed");
    const spend = await SpendRequest.findById(spendId).lean();
    expect(spend.requesterConfirmedByName).toBeTruthy();
    expect(spend.items[0].confirmedAt).toBeTruthy();
  });

  test("asking Store to look again sends it back, with the reason", async () => {
    const s = await seed();
    const { spendId } = await priced(s);

    const { status, body } = await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: {
        lines: { 0: { revise: true, reason: "That is the wireless one. I need USB-C." } },
      },
    });

    expect(status).toBe(200);
    expect(body.request.status).toBe("requester_revision_requested");
    const spend = await SpendRequest.findById(spendId).lean();
    expect(spend.items[0].revisionRequested).toBe(true);
    expect(spend.items[0].revisionReason).toMatch(/USB-C/);
    /* Not confirmed — a revision must never leave a stale confirmation
       underneath it for finance to read. */
    expect(spend.requesterConfirmedAt).toBeUndefined();
  });

  test("sending a line back needs a reason, or Store requotes the same thing", async () => {
    const s = await seed();
    const { spendId } = await priced(s);
    const { status, body } = await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "  " } } },
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/tell Store what is wrong/i);
  });

  test("one line confirmed and one sent back sends the whole quote back", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Mouse", quantity: 2, unit: "pcs" },
        { name: "Dock", quantity: 1, unit: "pcs" },
      ],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 2000, vendorName: "Sharma" },
          1: { issueQty: 0, rate: 4000, vendorName: "Sharma" },
        },
      },
    });
    const saved = await IntakeRequest.findById(id).lean();

    await call(s.emp, `/${saved.spendRequestId}/confirm`, {
      method: "PATCH", app: "spend",
      body: {
        lines: {
          0: { confirm: true },
          1: { revise: true, reason: "Only two HDMI ports on that one." },
        },
      },
    });

    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.status).toBe("requester_revision_requested");
    /* The line they were happy with keeps its confirmation — they should not
       have to re-answer a question they already answered. */
    expect(spend.items[0].confirmedAt).toBeTruthy();
    expect(spend.items[1].revisionRequested).toBe(true);
  });

  test("nobody else can confirm somebody's request", async () => {
    const s = await seed();
    const { spendId } = await priced(s);
    const { status } = await call(s.store, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { confirm: true } } },
    });
    expect(status).toBe(403);
  });

  test("Store cannot send an unconfirmed quote to finance", async () => {
    const s = await seed();
    const { spendId } = await priced(s);
    const { status, body } = await call(s.store, `/${spendId}/send-to-finance`, {
      method: "PATCH", app: "spend", body: {},
    });
    expect(status).toBe(409);
    expect(body.message).toMatch(/has not confirmed/i);
  });

  test("finance cannot approve an unconfirmed quote", async () => {
    const s = await seed();
    const { spendId } = await priced(s);
    /* Put it at finance without the confirmation — the state a client could
       reach by posting directly. The guard is on the DECISION, not only on
       the door that leads to it. */
    await SpendRequest.updateOne({ _id: spendId }, { $set: { status: "pending_finance" } });

    const { status, body } = await call(s.fin, `/${spendId}/approve`, {
      method: "PATCH", app: "spend", body: {},
    });
    expect(status).toBe(409);
    expect(body.message).toMatch(/has not confirmed/i);
  });

  test("the whole way through: confirm, send, approve", async () => {
    const s = await seed();
    const { spendId } = await priced(s);

    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend", body: { lines: { 0: { confirm: true } } },
    });
    const sent = await call(s.store, `/${spendId}/send-to-finance`, {
      method: "PATCH", app: "spend", body: {},
    });
    expect(sent.status).toBe(200);
    expect((await SpendRequest.findById(spendId).lean()).status).toBe("pending_finance");

    const ok = await call(s.fin, `/${spendId}/approve`, {
      method: "PATCH", app: "spend", body: {},
    });
    expect(ok.status).toBe(200);
    expect((await SpendRequest.findById(spendId).lean()).status).toBe("approved");
  });

  test("a request raised directly by the requester needs no confirmation", async () => {
    /* It IS their own ask. Asking them to confirm their own request would be
       a step that says nothing, so the guard applies only to quotes Store
       sourced on their behalf. */
    const s = await seed();
    /* Exercised through the shared decision service, which is where the guard
       lives — both finance doors call it. */
    const doc = new SpendRequest({
      requestNumber: `SR-DIRECT-${seq++}`,
      title: "Direct ask", purpose: "x", requestType: "PRODUCT",
      requestedBy: s.emp._id, requestedByName: "E", department: "Tech",
      items: [{ name: "Thing", whyNeeded: "x", quantity: 1, unit: "pcs", rate: 10, amount: 10 }],
      totalAmount: 10, status: "pending_finance", companyId: s.company._id,
    });
    await doc.save();
    const decision = require("../../services/spendFinanceDecision.service");
    const r = await decision.decide({
      request: doc,
      actor: { name: "Finance" },
      outcome: "approved",
    });
    expect(r.ok).toBe(true);
  });
});

/* ═══ THE BUDGET IS CHECKED AT CONFIRMATION ════════════════════════════════
 * The first moment a real figure exists AND the person who owns the head has
 * seen it. Earlier tests the requester's guess; later means finance is the
 * first to notice, by which point the requester has agreed to something they
 * cannot have.
 */
describe("confirming something the budget cannot take", () => {
  test("an over-budget confirmation becomes a budget exception, not a finance queue item", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Server rack", quantity: 1, unit: "pcs" }],
    });
    /* Priced far past the head. */
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 999999, vendorName: "Sharma" } } },
    });
    const saved = await IntakeRequest.findById(id).lean();

    const { body } = await call(s.emp, `/${saved.spendRequestId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { confirm: true } } },
    });

    expect(body.request.status).toBe("budget_exception");
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    /* Confirmed — they agreed it is the right thing — and stopped, because it
       is more than the head has left. */
    expect(spend.requesterConfirmedAt).toBeTruthy();
    expect(spend.budgetExceptionOverrun).toBeGreaterThan(0);

    /* And it never reached finance. */
    const desk = await call(s.fin, "/approvals");
    expect(desk.body.requests.filter((r) => r.source === "spend")).toHaveLength(0);
  });

  test("Store cannot send an over-budget exception on to finance", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Server rack", quantity: 1, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 999999, vendorName: "Sharma" } } },
    });
    const saved = await IntakeRequest.findById(id).lean();
    await call(s.emp, `/${saved.spendRequestId}/confirm`, {
      method: "PATCH", app: "spend", body: { lines: { 0: { confirm: true } } },
    });

    const { status } = await call(s.store, `/${saved.spendRequestId}/send-to-finance`, {
      method: "PATCH", app: "spend", body: {},
    });
    expect(status).toBe(409);
  });
});

/* ═══ A REQUEST SPENDS AGAINST THE PLAN, NOT THE BUCKET ════════════════════
 *
 * ── THE HOLE THIS CLOSES ────────────────────────────────────────────────────
 * A budget head is an accounting bucket: "Software Subscription Expenses".
 * What finance agreed to is the plan inside it — Claude approved, Copilot
 * refused, Codex still being argued over. A request that named only the head
 * could buy the refused row out of the money approved for something else, and
 * every budget report still balanced, because the head total was untouched.
 *
 * ── AND WHY THERE IS NO ESCAPE HATCH ────────────────────────────────────────
 * No "new item", no "not planned". A row that is not in the plan is not
 * something to invent on a request form — it is a reason to revise the budget,
 * which happens where finance can see it.
 */
describe("the planned item inside the head", () => {
  /** The seeded plan gives every head one approved row — see the helper. */
  const planned = (over = {}) => ({
    ledgerId: HEAD,
    plannedItemKey: PLANNED_KEY,
    title: "Compressor is making a noise",
    purpose: "It stops the second shift",
    items: [{ name: "Compressor service", quantity: 1, unit: "job" }],
    ...over,
  });

  test("the picker offers the rows finance approved, under each head", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/budget-heads");
    const head = body.heads.find((h) => h.ledgerId === String(s.repairs._id));
    expect(head.plannedItems.length).toBeGreaterThan(0);
    expect(head.plannedItems[0]).toMatchObject({ key: PLANNED_KEY });
    expect(head.plannedItems[0].amount).toBeGreaterThan(0);
  });

  test("head plus planned item is accepted, and both are recorded", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", { method: "POST", body: planned() });

    expect(status).toBe(201);
    const saved = await IntakeRequest.findById(body.request.id).lean();
    expect(saved.plannedItemKey).toBe(PLANNED_KEY);
    expect(saved.plannedItemName).toBeTruthy();
    /* A snapshot, like budgetSnapshot — the plan can be revised and the figure
       the requester was answering has to survive that. */
    expect(saved.plannedItemAmount).toBeGreaterThan(0);
  });

  test("the head alone is refused", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: planned({ plannedItemKey: undefined }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/choose the planned item/i);
  });

  test("a row that is not in this head's plan is refused", async () => {
    const s = await seed();
    const { status, body } = await call(s.emp, "/", {
      method: "POST",
      body: planned({ plannedItemKey: "r-does-not-exist" }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/not an approved row under this budget head/i);
  });

  test("the right key with the wrong name is refused", async () => {
    /* A positional key on a legacy row can come to point at a different row
       when a department reorders its working. The name stored beside it is
       what makes that detectable instead of silently recharging the request. */
    const s = await seed();
    const { status } = await call(s.emp, "/", {
      method: "POST",
      body: planned({ plannedItemName: "Something nobody planned" }),
    });
    expect(status).toBe(400);
  });

  test("a refused or countered row is never offered and never accepted", async () => {
    const s = await seed();
    const budget = await Acc_Budget.findOne({ "items.ledgerId": s.repairs._id });
    const req = budget.budgetRequests.find(
      (r) => String(r.ledgerId) === String(s.repairs._id),
    );
    req.workingLines.push(
      { rowId: "refused", label: "Refused row", decision: "refused", approvedAmount: 0, amount: 5000 },
      { rowId: "open", label: "Countered row", decision: "countered", amount: 5000 },
    );
    await budget.save();

    const { body } = await call(s.emp, "/budget-heads");
    const head = body.heads.find((h) => h.ledgerId === String(s.repairs._id));
    expect(head.plannedItems.map((p) => p.key)).not.toContain("refused");
    expect(head.plannedItems.map((p) => p.key)).not.toContain("open");

    for (const key of ["refused", "open"]) {
      const { status } = await call(s.emp, "/", {
        method: "POST",
        body: planned({ plannedItemKey: key }),
      });
      expect(status).toBe(400);
    }
  });

  test("a head whose plan has no approved rows cannot be spent against", async () => {
    const s = await seed();
    const budget = await Acc_Budget.findOne({ "items.ledgerId": s.repairs._id });
    const req = budget.budgetRequests.find(
      (r) => String(r.ledgerId) === String(s.repairs._id),
    );
    /* Every row refused: the head still holds its allocation, and there is
       nothing inside it anybody agreed to. */
    req.workingLines.forEach((l) => {
      l.decision = "refused";
      l.approvedAmount = 0;
    });
    await budget.save();

    const { body } = await call(s.emp, "/budget-heads");
    const head = body.heads.find((h) => h.ledgerId === String(s.repairs._id));
    expect(head.plannedItems).toHaveLength(0);

    const { status, body: refusal } = await call(s.emp, "/", {
      method: "POST",
      body: planned(),
    });
    expect(status).toBe(400);
    expect(refusal.message).toBe(
      "No planned items approved under this head. Revise the budget before raising a request.",
    );
  });

  test("the planned item travels to Store, and to the spend request", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Belt", quantity: 1, unit: "pcs" }],
    });

    /* Store sees the NAME — fulfilment context, so they issue the thing that
       was planned rather than anything that fits the head. */
    const desk = await call(s.store, "/fulfilment");
    const row = desk.body.requests.find((r) => r.id === id);
    expect(row.budgetHead.plannedItemName).toBeTruthy();
    /* And no figure: the approved amount for the row is money. */
    expect(row.budgetHead.plannedItemAmount).toBeNull();

    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 500, vendorName: "Sharma" } } },
    });
    const saved = await IntakeRequest.findById(id).lean();
    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    expect(spend.plannedItemKey).toBe(PLANNED_KEY);
    expect(spend.plannedItemName).toBe(saved.plannedItemName);
  });

  test("a request raised before planned items existed still renders", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s);
    /* Strip it back to the shape of a row written before this rule. */
    await IntakeRequest.updateOne(
      { _id: id },
      { $unset: { plannedItemKey: "", plannedItemName: "", plannedItemAmount: "" } },
    );

    const desk = await call(s.store, "/fulfilment");
    const row = desk.body.requests.find((r) => r.id === id);
    expect(row).toBeTruthy();
    /* Null rather than missing — the screens render "No planned item linked"
       from this, and a missing key would read as a rendering bug. */
    expect(row.budgetHead.plannedItemName).toBeNull();
  });
});

/* ═══ WHAT STORE FILLS IS WHAT THE REQUESTER READS ═════════════════════════
 *
 * ── THE CLAIM ───────────────────────────────────────────────────────────────
 * One set of fields, filled by Store and read by the requester. No derived
 * second shape that can drift — the confirmation screen shows the item Store
 * chose, the vendor Store chose, the rate Store was quoted and the document
 * Store attached, or it says plainly that Store has not finished.
 */
describe("the data Store fills is the data the requester confirms", () => {
  async function classifyWith(s, lines, items) {
    const { id } = await askAndApprove(s, { items });
    const r = await call(s.store, `/${id}/classify`, { method: "PATCH", body: { lines } });
    expect(r.status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    return { id, spend: await SpendRequest.findById(saved.spendRequestId).lean() };
  }

  test("everything Store entered reaches the line the requester reads", async () => {
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      {
        0: {
          issueQty: 0,
          newItemName: "ThinkPad T14 Gen 4",
          spec: "32GB RAM, 1TB NVMe",
          rate: 95000,
          vendorName: "Sharma Systems",
          gstin: "22AAAAA0000A1Z5",
          quoteRef: "SS/Q/2026/118",
          gstPercent: 18,
          expectedDeliveryDate: "2026-09-20",
          attachments: [
            { fileId: "drive-quote-1", fileName: "sharma-quote.pdf", fileType: "application/pdf", fileSize: 40000 },
          ],
        },
      },
      [{ name: "A laptop, a good one", quantity: 1, unit: "pcs" }],
    );

    const l = spend.items[0];
    expect(l.name).toBe("ThinkPad T14 Gen 4");
    /* The requester's own words survive beside Store's — the card's whole
       question is whether the two are the same thing. */
    expect(l.requestedName).toBe("A laptop, a good one");
    expect(l.spec).toBe("32GB RAM, 1TB NVMe");
    expect(l.vendorName).toBe("Sharma Systems");
    expect(l.quoteRef).toBe("SS/Q/2026/118");
    expect(l.rate).toBe(95000);
    expect(l.gstPercent).toBe(18);
    expect(l.lineTotal).toBe(112100);
    expect(l.expectedDeliveryDate).toBeTruthy();

    expect(l.attachments).toHaveLength(1);
    expect(l.attachments[0].fileId).toBe("drive-quote-1");
    /* Stamped from the session, never from the body. */
    expect(l.attachments[0].uploadedByName).toBeTruthy();
  });

  test("a supplier quote and a product photo stay distinguishable", async () => {
    /* They answer different questions — "is this price real" and "is this the
       thing I meant" — and the requester's card groups them by label. One
       undifferentiated list made you open every file to find out which. */
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      {
        0: {
          issueQty: 0, rate: 50000, vendorName: "Sharma",
          attachments: [
            { fileId: "q1", fileName: "sharma-quote.pdf", label: "quote" },
            { fileId: "p1", fileName: "thinkpad.jpg", label: "photo" },
          ],
        },
      },
      [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    );
    const byId = Object.fromEntries(spend.items[0].attachments.map((a) => [a.fileId, a.label]));
    expect(byId).toEqual({ q1: "quote", p1: "photo" });
  });

  test("an unrecognised label is filed as 'other' rather than kept verbatim", async () => {
    /* Free text would let one client write "Quote" and another "quotation",
       and the grouping would silently stop working. */
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      {
        0: {
          issueQty: 0, rate: 50000, vendorName: "Sharma",
          attachments: [{ fileId: "x1", fileName: "mystery.bin", label: "Quotation!!" }],
        },
      },
      [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    );
    expect(spend.items[0].attachments[0].label).toBe("other");
  });

  test("two lines can carry two vendors and two quote files", async () => {
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      {
        0: { issueQty: 0, rate: 50000, vendorName: "Sharma", quoteRef: "A/1",
             attachments: [{ fileId: "f1", fileName: "a.pdf" }] },
        1: { issueQty: 0, rate: 12000, vendorName: "Verma", quoteRef: "B/2",
             attachments: [{ fileId: "f2", fileName: "b.pdf" }] },
      },
      [
        { name: "Laptop", quantity: 1, unit: "pcs" },
        { name: "AMC", quantity: 1, unit: "yr" },
      ],
    );
    expect(spend.items.map((l) => l.vendorName)).toEqual(["Sharma", "Verma"]);
    expect(spend.items.map((l) => l.attachments[0].fileId)).toEqual(["f1", "f2"]);
  });

  test("a line Store has not finished pricing is flagged, not shown as ₹0", async () => {
    /* The old failure: the requester saw "Rate —" and had no idea whether
       Store had finished or the item was free. */
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma" } } },
    });
    const saved = await IntakeRequest.findById(id).lean();

    /* Strip the vendor back off, the shape of a half-filled line. */
    await SpendRequest.updateOne(
      { _id: saved.spendRequestId },
      { $set: { "items.0.vendorName": "" } },
    );

    const { body } = await call(s.emp, "/", { app: "spend" });
    const row = body.requests.find((x) => x._id === String(saved.spendRequestId));
    expect(row.items[0].pricingComplete).toBe(false);
  });

  test("a fully priced line says so, so the card can offer Confirm", async () => {
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma", expectedDeliveryDate: "2026-09-20" } },
      [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    );
    const { body } = await call(s.emp, "/", { app: "spend" });
    const row = body.requests.find((x) => x._id === String(spend._id));
    expect(row.items[0].pricingComplete).toBe(true);
  });

  test("a refused line can suggest an alternative", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Discontinued sensor", quantity: 1, unit: "pcs" },
        { name: "Laptop", quantity: 1, unit: "pcs" },
      ],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { cannotFulfil: true, reason: "Discontinued.", alternative: "The 3S fits the same mount." },
          1: { issueQty: 0, rate: 50000, vendorName: "Sharma" },
        },
      },
    });
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.items[0].unfulfilledReason).toBe("Discontinued.");
  });

  test("Store's queue shows a quote the requester sent back, and why", async () => {
    const s = await seed();
    const { spend } = await classifyWith(
      s,
      { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma" } },
      [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    );

    await call(s.emp, `/${spend._id}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Wrong model — I need 32GB." } } },
    });

    /* Before this, a rejected quote changed status and appeared on nobody's
       screen: the requester had answered and Store never found out. */
    const { body } = await call(s.store, "/to-send", { app: "spend" });
    const row = body.requests.find((x) => x._id === String(spend._id));
    expect(row).toBeTruthy();
    expect(row.confirmed).toBe(false);
    expect(row.revisionNote).toMatch(/32GB/);
  });
});

/* ═══ STORE CAN ACTUALLY DO SOMETHING ABOUT A SENT-BACK LINE ═══════════════
 *
 * ── THE GAP THIS CLOSES ─────────────────────────────────────────────────────
 * "Send back to Store" changed the request's status and gave Store nowhere to
 * act on it: the objection reason was visible, but there was no door back into
 * the commercial terms to fix it. And the request itself vanished from Store's
 * queue the moment it left their hands — `/to-send` only ever asked for
 * CONFIRMED and REVISION_REQUESTED, never AWAITING_CONFIRMATION, so a quote
 * sitting with the requester waiting on an answer was invisible to the people
 * who had just sent it.
 */
describe("Store sees every state a quote it raised can be in", () => {
  async function priced(s, over = {}) {
    const { id } = await askAndApprove(s, {
      items: [{ name: "A laptop, a good one", quantity: 1, unit: "pcs" }],
      ...over,
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma Systems" } },
      },
    });
    const saved = await IntakeRequest.findById(id).lean();
    return saved.spendRequestId;
  }

  test("a quote still sitting with the requester is visible to Store, not just after it moves", async () => {
    const s = await seed();
    const spendId = await priced(s);

    const { body } = await call(s.store, "/to-send", { app: "spend" });
    const row = body.requests.find((r) => r._id === String(spendId));
    expect(row).toBeTruthy();
    expect(row.status).toBe("awaiting_requester_confirmation");
  });

  test("requoting fixes only the flagged line, and sends it back to the requester", async () => {
    const s = await seed();
    const spendId = await priced(s);

    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Too expensive — get a lower quote." } } },
    });
    expect((await SpendRequest.findById(spendId).lean()).status).toBe("requester_revision_requested");

    const { status, body } = await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: {
        lines: {
          0: { rate: 42000, vendorName: "Verma Traders", expectedDeliveryDate: "2026-09-25" },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.request.status).toBe("awaiting_requester_confirmation");

    const spend = await SpendRequest.findById(spendId).lean();
    expect(spend.items[0].rate).toBe(42000);
    expect(spend.items[0].vendorName).toBe("Verma Traders");
    expect(spend.items[0].revisionRequested).toBe(false);
    expect(spend.totalAmount).toBe(42000);
    /* The objection is resolved, not merely hidden. */
    expect(spend.revisionNote).toBeUndefined();
  });

  test("requoting without a rate, vendor, or delivery date is refused", async () => {
    const s = await seed();
    const spendId = await priced(s);
    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Too expensive." } } },
    });

    const noRate = await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { vendorName: "Verma", expectedDeliveryDate: "2026-09-25" } } },
    });
    expect(noRate.status).toBe(400);

    const noVendor = await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { rate: 42000, expectedDeliveryDate: "2026-09-25" } } },
    });
    expect(noVendor.status).toBe(400);

    const noDelivery = await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { rate: 42000, vendorName: "Verma" } } },
    });
    expect(noDelivery.status).toBe(400);
  });

  test("a request nobody sent back cannot be requoted", async () => {
    const s = await seed();
    const spendId = await priced(s);
    const { status } = await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { rate: 1, vendorName: "X", expectedDeliveryDate: "2026-09-25" } } },
    });
    expect(status).toBe(409);
  });

  test("only Store may requote", async () => {
    const s = await seed();
    const spendId = await priced(s);
    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Too expensive." } } },
    });
    const { status } = await call(s.emp, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { rate: 1, vendorName: "X", expectedDeliveryDate: "2026-09-25" } } },
    });
    expect(status).toBe(403);
  });

  test("a confirmed line is untouched by a requote on a different line", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [
        { name: "Laptop", quantity: 1, unit: "pcs" },
        { name: "Dock", quantity: 1, unit: "pcs" },
      ],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 50000, vendorName: "Sharma" },
          1: { issueQty: 0, rate: 4000, vendorName: "Sharma" },
        },
      },
    });
    const saved = await IntakeRequest.findById(id).lean();
    const spendId = saved.spendRequestId;

    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: {
        lines: {
          0: { confirm: true },
          1: { revise: true, reason: "Wrong dock model." },
        },
      },
    });

    await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: { lines: { 1: { rate: 3500, vendorName: "Verma", expectedDeliveryDate: "2026-09-25" } } },
    });

    const spend = await SpendRequest.findById(spendId).lean();
    /* Line 0 was already confirmed and was never flagged — its confirmation
       and its original terms survive untouched. */
    expect(spend.items[0].confirmedAt).toBeTruthy();
    expect(spend.items[0].vendorName).toBe("Sharma");
    expect(spend.items[0].rate).toBe(50000);
    expect(spend.items[1].vendorName).toBe("Verma");
    expect(spend.totalAmount).toBe(53500);
  });
});

/* ═══ A CLASSIFIED REQUEST NEVER JUST DISAPPEARS ════════════════════════════
 *
 * ── THE BUG THIS CLOSES ─────────────────────────────────────────────────────
 * Classifying an intake request moves it out of `needs_classification`, which
 * is the only status `/fulfilment` reads. So the moment Store acted on a
 * request, it vanished from every screen Store had — a manufacturing order or
 * a material request never does this; both stay listed with an updated status
 * for as long as they exist. `/from-fulfilment` is the permanent record this
 * was missing: every spend request Store produced by classifying an intake
 * request, in whatever state it is now.
 */
describe("a classified request stays visible, whatever it becomes", () => {
  async function classified(s, over = {}) {
    const { id } = await askAndApprove(s, {
      items: [{ name: "A laptop, a good one", quantity: 1, unit: "pcs" }],
      ...over,
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { issueQty: 0, rate: 12000, vendorName: "Sharma Systems" } } },
    });
    return (await IntakeRequest.findById(id).lean()).spendRequestId;
  }

  test("it stays in Store's permanent list at every stage, not just while it needs an answer", async () => {
    const s = await seed();
    const spendId = await classified(s);

    const initial = await call(s.store, "/from-fulfilment", { app: "spend" });
    expect(initial.body.requests.map((r) => r._id)).toContain(String(spendId));
    expect(
      initial.body.requests.find((r) => r._id === String(spendId)).status,
    ).toBe("awaiting_requester_confirmation");

    /* Confirm it. Gone from `/to-send`'s "still your move" framing eventually,
       never gone from the permanent one. */
    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend", body: { lines: { 0: { confirm: true } } },
    });
    const afterConfirm = await call(s.store, "/from-fulfilment", { app: "spend" });
    expect(
      afterConfirm.body.requests.find((r) => r._id === String(spendId)).status,
    ).toBe("requester_confirmed");

    /* Send it to finance and approve it. Still there. */
    await call(s.store, `/${spendId}/send-to-finance`, { method: "PATCH", app: "spend", body: {} });
    await call(s.fin, `/${spendId}/approve`, { method: "PATCH", app: "spend", body: {} });
    const afterApproval = await call(s.store, "/from-fulfilment", { app: "spend" });
    const row = afterApproval.body.requests.find((r) => r._id === String(spendId));
    expect(row).toBeTruthy();
    expect(row.status).toBe("approved");
  });

  test("a request raised directly, with no intake behind it, is not in this list", async () => {
    /* `/from-fulfilment` is specifically the classified-from-intake record —
       a direct purchase request never went through Store's classification and
       has nothing for this list to be permanent ABOUT. */
    const s = await seed();
    const { body } = await call(s.emp, "/", {
      method: "POST", app: "spend",
      body: {
        title: "Direct ask", requestType: "SERVICE", purpose: "x",
        ledgerId: HEAD, plannedItemKey: PLANNED_KEY,
        items: [{ name: "Thing", whyNeeded: "x", quantity: 1, unit: "pcs", rate: 10 }],
      },
    });
    const list = await call(s.store, "/from-fulfilment", { app: "spend" });
    expect(list.body.requests.map((r) => r._id)).not.toContain(body.request._id);
  });

  test("only Store or finance may read the permanent list", async () => {
    const s = await seed();
    await classified(s);
    const { status } = await call(s.emp, "/from-fulfilment", { app: "spend" });
    expect(status).toBe(403);
  });
});

/* ═══ ONE SPEND REQUEST, FETCHED DIRECTLY BY ID ═════════════════════════════
 *
 * ── THE ROUTING MISTAKE THIS PINS ───────────────────────────────────────────
 * `GET /:id` matches ANY single path segment on this router. It was first
 * written ABOVE the router's other literal GETs — `/approvals`, `/purchasing`,
 * `/budget-check` — which is a live-breaking bug: Express resolves routes in
 * declaration order, so a request for `/approvals` would have been read as
 * `id = "approvals"`, failed the ObjectId check, and 404'd, silently taking
 * three working endpoints down with no error explaining why. It was moved to
 * be declared LAST among this router's GETs before it ever reached a running
 * server. These tests are what would catch it coming back.
 */
describe("fetching one spend request directly, and the routes it must not shadow", () => {
  test("every other literal GET route on this router still answers, not a 404 from :id", async () => {
    const s = await seed();
    for (const path of ["/approvals", "/purchasing", "/budget-check", "/to-send", "/from-fulfilment"]) {
      const { status } = await call(s.fin, path, { app: "spend" });
      expect(status).not.toBe(404);
    }
  });

  test("the requester, Store, and finance may each fetch it by id", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { lines: { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma" } } },
    });
    const spendId = (await IntakeRequest.findById(id).lean()).spendRequestId;

    for (const viewer of [s.emp, s.store, s.fin]) {
      const { status, body } = await call(viewer, `/${spendId}`, { app: "spend" });
      expect(status).toBe(200);
      expect(body.request._id).toBe(String(spendId));
    }
  });

  test("somebody with no stake in it cannot fetch it by id", async () => {
    const s = await seed();
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH", body: { lines: { 0: { issueQty: 0, rate: 50000, vendorName: "Sharma" } } },
    });
    const spendId = (await IntakeRequest.findById(id).lean()).spendRequestId;

    const stranger = await Employee.create({
      firstName: "Nobody", lastName: "Else", email: `stranger${seq++}@demo.example`,
      isActive: true, gender: "Other", biometricId: `NB${seq}`, department: "Sales",
    });
    const { status } = await call(stranger, `/${spendId}`, { app: "spend" });
    expect(status).toBe(403);
  });

  test("a non-existent id is a 404, not a 500", async () => {
    const s = await seed();
    const { status } = await call(s.store, `/${new mongoose.Types.ObjectId()}`, { app: "spend" });
    expect(status).toBe(404);
  });
});

/* ═══ REQUOTING A LINE MUST NOT LEAVE A STALE VENDOR ID BEHIND ═════════════
 *
 * ── THE BUG THIS CLOSES ─────────────────────────────────────────────────────
 * The requote handler overwrote `vendorName` on the flagged line but never
 * touched `vendorId`. Requoting FROM a picked supplier (which carries an id)
 * TO a freshly typed one left the OLD id attached to the NEW name — so
 * everything downstream that trusts the id, including the purchase order's
 * own vendor reference, silently pointed at a company nobody quoted.
 */
describe("requoting replaces the vendor id along with the vendor name", () => {
  async function pricedWithVendorId(s, vendorId) {
    const { id } = await askAndApprove(s, {
      items: [{ name: "Laptop", quantity: 1, unit: "pcs" }],
    });
    await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: {
        lines: {
          0: { issueQty: 0, rate: 12000, vendorName: "Old Supplier Pvt Ltd", vendorId },
        },
      },
    });
    return (await IntakeRequest.findById(id).lean()).spendRequestId;
  }

  test("typing a fresh name over a picked vendor replaces the old id, never keeps it", async () => {
    /* ── THIS ASSERTION CHANGED TWICE OVER ────────────────────────────────
       First it expected the OLD id to survive under the new name — the
       original bug this whole chunk started from. Then it expected `null` —
       correct once the id was properly cleared, but only half the promise:
       the picker already tells Store a typed name "will be recorded as a new
       supplier", so the right outcome is a NEW real vendor, not a blank. */
    const s = await seed();
    const oldVendor = await Vendor.create({ companyName: "Old Supplier Pvt Ltd", status: "Active" });
    const spendId = await pricedWithVendorId(s, oldVendor._id);

    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Wrong supplier." } } },
    });

    await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: {
        lines: {
          /* No vendorId posted — Store typed this one fresh. */
          0: { rate: 11000, vendorName: "New Supplier Pvt Ltd", expectedDeliveryDate: "2026-09-25" },
        },
      },
    });

    const spend = await SpendRequest.findById(spendId).lean();
    expect(spend.items[0].vendorName).toBe("New Supplier Pvt Ltd");
    expect(spend.items[0].vendorId).toBeTruthy();
    expect(String(spend.items[0].vendorId)).not.toBe(String(oldVendor._id));

    const created = await Vendor.findById(spend.items[0].vendorId).lean();
    expect(created.companyName).toBe("New Supplier Pvt Ltd");
  });

  test("picking a different vendor sets the new id, not the old one", async () => {
    const s = await seed();
    const oldVendor = await Vendor.create({ companyName: "Old Supplier Pvt Ltd", status: "Active" });
    const newVendor = await Vendor.create({ companyName: "Picked Supplier Pvt Ltd", status: "Active" });
    const spendId = await pricedWithVendorId(s, oldVendor._id);

    await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend",
      body: { lines: { 0: { revise: true, reason: "Wrong supplier." } } },
    });

    await call(s.store, `/${spendId}/requote`, {
      method: "PATCH", app: "spend",
      body: {
        lines: {
          0: {
            rate: 11000, vendorName: "Picked Supplier Pvt Ltd",
            vendorId: String(newVendor._id), expectedDeliveryDate: "2026-09-25",
          },
        },
      },
    });

    const spend = await SpendRequest.findById(spendId).lean();
    expect(String(spend.items[0].vendorId)).toBe(String(newVendor._id));
    expect(String(spend.items[0].vendorId)).not.toBe(String(oldVendor._id));
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * CATALOGUE IDENTITY, ALL THE WAY THROUGH THE REAL PATH
 *
 * The regex/source and already-shaped-line tests never exercised the actual
 * classification path. This one does: a matched IntakeRequest line, classified
 * as a purchase, becomes a SpendRequest, is approved by finance, and is
 * converted to a product PO. The RawItem id, its SKU and its base unit must be
 * the SAME across all three stored documents.
 * ═════════════════════════════════════════════════════════════════════════ */
describe("a matched item's identity survives intake → spend → purchase order", () => {
  const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");

  /* Confirm what Store found, send it to finance, and have finance approve —
     the three spend-side steps between classification and conversion. */
  async function toApproved(s, spendId) {
    const conf = await call(s.emp, `/${spendId}/confirm`, {
      method: "PATCH", app: "spend", body: { lines: { 0: { confirm: true } } },
    });
    if (conf.status !== 200) console.error("confirm refused:", conf.body);
    const sent = await call(s.store, `/${spendId}/send-to-finance`, {
      method: "PATCH", app: "spend", body: {},
    });
    if (sent.status !== 200) console.error("send refused:", sent.body);
    const app = await call(s.fin, `/${spendId}/approve`, { method: "PATCH", app: "spend", body: {} });
    if (app.status !== 200) console.error("approve refused:", app.body);
    return app;
  }

  test("full purchase: the same RawItem id, SKU and base unit reach the PO line", async () => {
    const s = await seed();
    /* customUnit distinct from unit, so the base-unit assertion is meaningful. */
    const item = await RawItem.create({
      name: "Logitech Mouse", sku: "SKU-MOUSE-1", unit: "pcs", customUnit: "Box", quantity: 20,
    });

    /* The requester PICKED it out of the catalogue — buildLines resolves the
       match onto the intake line. */
    const { id } = await askAndApprove(s, {
      items: [{ name: "A good mouse", quantity: 4, unit: "pcs", rate: 500, rawItemId: String(item._id) }],
    });

    /* Stage 1 — the IntakeRequest line carries the matched identity. */
    const intake = await IntakeRequest.findById(id).lean();
    expect(String(intake.items[0].rawItem)).toBe(String(item._id));
    expect(intake.items[0].rawItemSku).toBe("SKU-MOUSE-1");
    expect(intake.items[0].baseUnit).toBe("Box");

    /* Store classifies the whole requirement as a purchase, with a vendor. */
    const vendor = await Vendor.create({ companyName: "Mouse Mill", companyId: s.company._id });
    const cls = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { kind: "purchase", lines: { 0: { rate: 500, vendorId: String(vendor._id), vendorName: "Mouse Mill" } } },
    });
    expect(cls.status).toBe(200);

    /* Stage 2 — the SpendRequest line preserves the identity. */
    const saved = await IntakeRequest.findById(id).lean();
    const spendId = saved.spendRequestId;
    const spend = await SpendRequest.findById(spendId).lean();
    expect(String(spend.items[0].rawItem)).toBe(String(item._id));
    expect(spend.items[0].rawItemSku).toBe("SKU-MOUSE-1");
    expect(spend.items[0].baseUnit).toBe("Box");
    expect(spend.items[0].quantity).toBe(4);

    /* Finance approves, then Store converts to a product PO. */
    const approved = await toApproved(s, spendId);
    expect(approved.status).toBe(200);
    expect(approved.body.request.status).toBe("approved");

    const conv = await call(s.store, `/${spendId}/purchase-order`, { method: "POST", app: "spend", body: {} });
    expect(conv.status).toBe(201);

    /* Stage 3 — the PO line carries the same identity, unchanged. */
    const po = await PurchaseOrder.findOne({ spendRequestId: spendId }).lean();
    expect(String(po.items[0].rawItem)).toBe(String(item._id));
    expect(po.items[0].sku).toBe("SKU-MOUSE-1");
    expect(po.items[0].baseUnit).toBe("Box");
    expect(po.items[0].quantity).toBe(4);
  });

  test("partial stock: only the buy balance changes quantity; the identity is unchanged", async () => {
    const s = await seed();
    const item = await RawItem.create({
      name: "Cutting Blade", sku: "SKU-BLADE-9", unit: "pcs", customUnit: "Strip", quantity: 8,
    });
    /* Ask for 20 of a matched item the shelf only has 8 of. */
    const { id } = await askAndApprove(s, {
      items: [{ name: "Cutting blades", quantity: 20, unit: "pcs", rate: 100, rawItemId: String(item._id) }],
    });

    /* Store issues the 8 it holds and buys the 12-unit balance — same item. */
    const cls = await call(s.store, `/${id}/classify`, {
      method: "PATCH",
      body: { lines: { 0: { rawItemId: String(item._id), issueQty: 8, rate: 100 } } },
    });
    expect(cls.status).toBe(200);
    const saved = await IntakeRequest.findById(id).lean();
    expect(saved.fulfilmentKind).toBe("partial");

    const spend = await SpendRequest.findById(saved.spendRequestId).lean();
    /* Only the BUY balance is on the spend request. */
    expect(spend.items[0].quantity).toBe(12);
    /* Identity is unchanged by the split. */
    expect(String(spend.items[0].rawItem)).toBe(String(item._id));
    expect(spend.items[0].rawItemSku).toBe("SKU-BLADE-9");
    expect(spend.items[0].baseUnit).toBe("Strip");

    const approved = await toApproved(s, saved.spendRequestId);
    expect(approved.status).toBe(200);
    const conv = await call(s.store, `/${saved.spendRequestId}/purchase-order`, { method: "POST", app: "spend", body: {} });
    expect(conv.status).toBe(201);

    const po = await PurchaseOrder.findOne({ spendRequestId: saved.spendRequestId }).lean();
    expect(String(po.items[0].rawItem)).toBe(String(item._id));
    expect(po.items[0].sku).toBe("SKU-BLADE-9");
    expect(po.items[0].baseUnit).toBe("Strip");
    /* The balance, not the whole requirement. */
    expect(po.items[0].quantity).toBe(12);
  });
});
