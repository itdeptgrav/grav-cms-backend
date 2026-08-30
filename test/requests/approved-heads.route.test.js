// test/requests/approved-heads.route.test.js
//
// WHICH ACCOUNT HEADS A DEPARTMENT MAY SPEND AGAINST.
//
// The form used to offer the whole chart of accounts — four hundred-odd expense
// ledgers, most belonging to other departments. Picking from that is guessing,
// and the wrong choice does not fail: it files spend against a head nobody is
// watching.
//
// What a department may spend against is what finance approved FOR THEM, in the
// period that is running. Usually two or three lines.
//
// ── AND THE WAY OUT ─────────────────────────────────────────────────────────
// A genuinely new kind of spend has no line. Refusing it would send that
// spending somewhere nobody is measuring, so it may be asked for in words — and
// it arrives marked as unbudgeted rather than dressed up as a budgeted request
// against an arbitrary ledger.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Employee = require("../../models/Employee");
const MRF = require("../../models/CMS_Models/Inventory/Operations/MRF");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/requests/spend",
    require("../../Middlewear/EmployeeAuthMiddlewear"),
    require("../../routes/CMS_Routes/Requests/spendRequests"),
  );
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/requests/spend`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
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
 * Tech has two approved heads. The company also carries: a revenue target for
 * Tech, an expense head belonging to Merchandising, an unbudgeted expense
 * ledger, and a head budgeted only in a cycle that has not started.
 */
async function seed() {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Heads Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: "Direct Income", nature: "revenue",
  });

  const mk = async (name, group = expGroup) =>
    Acc_Ledger.create({
      companyId: company._id, name: `${name} ${n}`, groupId: group._id,
      groupName: group.name, nature: group.nature,
    });

  const software = await mk("Software Subscription");
  const repairs = await mk("Repairs & Maintenance");
  const exportSales = await mk("Export Sales", revGroup);
  const printing = await mk("Printing");          // Merchandising's
  const stationery = await mk("Stationery");      // budgeted nowhere
  const training = await mk("Training");          // next year's round only

  await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Tech", allocatedAmount: 40000 },
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
        department: "Tech", allocatedAmount: 12500 },
      /* A revenue target for the same department — a floor to reach, not an
         envelope to spend out of. */
      { ledgerId: exportSales._id, ledgerName: exportSales.name, nature: "revenue",
        department: "Tech", allocatedAmount: 2000000 },
      /* Another department's money. */
      { ledgerId: printing._id, ledgerName: printing.name, nature: "expense",
        department: "Merchandising", allocatedAmount: 60000 },
    ],
  }));

  /* A round that has not started. */
  await Acc_Budget.create({
    name: `Budget FY 2027-28 (${n})`, financialYear: "2027-28", period: "yearly",
    status: "collecting", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [{ ledgerId: training._id, ledgerName: training.name, nature: "expense",
              department: "Tech", allocatedAmount: 90000 }],
  });

  const tech = await Employee.create({
    firstName: "Rutu", lastName: `T${n}`, email: `tech${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `TC${n}`, department: "Tech",
  });
  const nobody = await Employee.create({
    firstName: "Nil", lastName: `N${n}`, email: `nil${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `NB${n}`, department: "Housekeeping",
  });

  return { company, tech, nobody, software, repairs, exportSales, printing, stationery, training };
}

const spendBody = (over = {}) => ({
  title: "Annual renewal",
  requestType: "SERVICE",
  purpose: "The licences expire this month",
  items: [{ name: "Licence", whyNeeded: "Expiring", quantity: 1, unit: "year", rate: 8000 }],
  ...over,
});

/* ═══ THE PICKER ══════════════════════════════════════════════════════════ */

describe("the heads a department is offered", () => {
  test("only its own approved expense heads, with what is left on each", async () => {
    const { tech, software, repairs } = await seed();
    const { status, body } = await call(tech, "/budget-heads");

    expect(status).toBe(200);
    expect(body.heads.map((h) => h.ledgerId).sort()).toEqual(
      [String(software._id), String(repairs._id)].sort(),
    );
    const soft = body.heads.find((h) => h.ledgerId === String(software._id));
    expect(soft).toMatchObject({ approved: 40000, committed: 0, actual: 0, available: 40000 });
    expect(soft.financialYear).toBe("2026-27");
  });

  test("a revenue target is never offered", async () => {
    /* A target is a floor to reach. There is nothing to spend out of it. */
    const { tech, exportSales } = await seed();
    const { body } = await call(tech, "/budget-heads");
    expect(body.heads.some((h) => h.ledgerId === String(exportSales._id))).toBe(false);
  });

  test("another department's head is never offered", async () => {
    const { tech, printing } = await seed();
    const { body } = await call(tech, "/budget-heads");
    expect(body.heads.some((h) => h.ledgerId === String(printing._id))).toBe(false);
  });

  test("a head budgeted only in a round that has not started is not offered", async () => {
    const { tech, training } = await seed();
    const { body } = await call(tech, "/budget-heads");
    expect(body.heads.some((h) => h.ledgerId === String(training._id))).toBe(false);
  });

  test("an expense ledger nobody budgeted is not offered", async () => {
    const { tech, stationery } = await seed();
    const { body } = await call(tech, "/budget-heads");
    expect(body.heads.some((h) => h.ledgerId === String(stationery._id))).toBe(false);
  });

  test("a department with nothing approved gets an empty list and a reason", async () => {
    /* Not a giant blank dropdown — the screen has to be able to say why. */
    const { nobody } = await seed();
    const { body } = await call(nobody, "/budget-heads");
    expect(body.heads).toEqual([]);
    expect(body.reason).toBe("no_lines");
  });
});

/* ═══ THE SERVER DOES NOT TRUST THE PICKER ════════════════════════════════ */

describe("what a submitted request may be charged to", () => {
  test("an approved head goes through and is matched", async () => {
    const { tech, software } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: spendBody({ ledgerId: String(software._id) }),
    });
    expect(status).toBe(201);
    expect(body.request.budgetMatchStatus).toBe("matched");
    expect(body.request.unbudgetedHeadRequest).toBe(false);
  });

  test("another department's head cannot be forced through the payload", async () => {
    /* The picker would never offer it; this is somebody typing the id in. */
    const { tech, printing } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: spendBody({ ledgerId: String(printing._id) }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("HEAD_NOT_APPROVED");
    expect(body.message).toMatch(/not in this department's approved budget/);
  });

  test("an unbudgeted ledger cannot be forced through either", async () => {
    const { tech, stationery } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: spendBody({ ledgerId: String(stationery._id) }),
    });
    expect(status).toBe(400);
    expect(body.code).toBe("HEAD_NOT_APPROVED");
  });

  test("a revenue head cannot be spent against", async () => {
    const { tech, exportSales } = await seed();
    const { status } = await call(tech, "/", {
      method: "POST", body: spendBody({ ledgerId: String(exportSales._id) }),
    });
    expect(status).toBe(400);
  });

  test("no head at all is still refused", async () => {
    const { tech } = await seed();
    const { status, body } = await call(tech, "/", { method: "POST", body: spendBody() });
    expect(status).toBe(400);
    expect(body.message).toBe("Choose the account head this spend belongs to.");
  });
});

/* ═══ ASKING FOR A HEAD THAT DOES NOT EXIST ═══════════════════════════════ */

describe("requesting another head", () => {
  const asking = (over = {}) =>
    spendBody({
      unbudgetedHead: true,
      requestedHeadName: "Design tooling",
      requestedHeadReason: "None of our approved heads cover design software.",
      ...over,
    });

  test("it submits without naming any ledger, and arrives marked unbudgeted", async () => {
    const { tech } = await seed();
    const { status, body } = await call(tech, "/", { method: "POST", body: asking() });

    expect(status).toBe(201);
    const r = body.request;
    expect(r.unbudgetedHeadRequest).toBe(true);
    expect(r.budgetMatchStatus).toBe("no_budget_line");
    expect(r.budgetApprovalKind).toBe("unbudgeted");
    expect(r.requestedHeadName).toBe("Design tooling");
    expect(r.requestedHeadReason).toMatch(/design software/);
    /* Something to call it on every screen. */
    expect(r.ledgerName).toBe("Design tooling");
  });

  test("no budget check is run against a head that does not exist", async () => {
    const { tech } = await seed();
    const { body } = await call(tech, "/", { method: "POST", body: asking() });
    expect(body.request.budgetSnapshot).toBeNull();
  });

  test("it has to say what the head is called", async () => {
    const { tech } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: asking({ requestedHeadName: "" }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/Name the head you need/);
  });

  test("and why the approved ones do not fit", async () => {
    const { tech } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: asking({ requestedHeadReason: "" }),
    });
    expect(status).toBe(400);
    expect(body.message).toMatch(/why none of your approved budget heads fit/);
  });

  test("finance sees the proposed head, the reason, the amount and the department", async () => {
    const { tech } = await seed();
    const { body } = await call(tech, "/", { method: "POST", body: asking() });
    const listed = await call(tech, "/");
    const r = listed.body.requests.find((x) => x._id === body.request._id);

    expect(r.requestedHeadName).toBe("Design tooling");
    expect(r.requestedHeadReason).toMatch(/design software/);
    expect(r.totalAmount).toBe(8000);
    expect(r.department).toBe("Tech");
    expect(r.unbudgetedHeadRequest).toBe(true);
  });

  test("a department with no approved heads can still ask for one", async () => {
    /* Otherwise a department finance has not budgeted yet could raise nothing
       at all, and would go around the system entirely. */
    const { nobody } = await seed();
    const { status, body } = await call(nobody, "/", { method: "POST", body: asking() });
    expect(status).toBe(201);
    expect(body.request.unbudgetedHeadRequest).toBe(true);
  });
});

/* ═══ MATERIAL FROM STORE ═════════════════════════════════════════════════ */

test("none of this reaches an MRF", async () => {
  const before = await MRF.countDocuments({});
  const { tech, software } = await seed();
  await call(tech, "/", { method: "POST", body: spendBody({ ledgerId: String(software._id) }) });
  await expect(MRF.countDocuments({})).resolves.toBe(before);
});

/* ═══ TWO KINDS OF ASK, NOT THREE ═════════════════════════════════════════
   "Software / tool" never described a different KIND of request — a
   subscription is work and access bought from a vendor, which is what Service
   already means. The third option only asked people to draw a line that does
   not exist: is a hosted design tool software, or a service?

   The value stays in the SCHEMA so rows written under it still load, and is
   refused by the ROUTE so nothing new is created with it. */

describe("request types", () => {
  const ofType = (requestType, ledger) =>
    spendBody({ requestType, ledgerId: String(ledger._id) });

  test("a product request submits", async () => {
    const { tech, software } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: ofType("PRODUCT", software),
    });
    expect(status).toBe(201);
    expect(body.request.requestType).toBe("PRODUCT");
    expect(body.request.requestTypeLabel).toBe("Product");
  });

  test("a service request submits", async () => {
    const { tech, software } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: ofType("SERVICE", software),
    });
    expect(status).toBe(201);
    expect(body.request.requestTypeLabel).toBe("Service");
  });

  test("a new SOFTWARE request is refused", async () => {
    const { tech, software } = await seed();
    const { status, body } = await call(tech, "/", {
      method: "POST", body: ofType("SOFTWARE", software),
    });
    expect(status).toBe(400);
    expect(body.message).toBe("Choose whether this is a product or a service.");
  });

  test("so is anything else", async () => {
    const { tech, software } = await seed();
    expect((await call(tech, "/", { method: "POST", body: ofType("SUBSCRIPTION", software) })).status).toBe(400);
    expect((await call(tech, "/", { method: "POST", body: ofType("", software) })).status).toBe(400);
  });

  test("a row already saved as SOFTWARE reads as Service, and does not crash", async () => {
    /* Exactly what an old row looks like. The schema still accepts the value,
       so it loads; the label says what it always meant. */
    const { tech, software } = await seed();
    const { body } = await call(tech, "/", { method: "POST", body: ofType("SERVICE", software) });
    await SpendRequest.updateOne({ _id: body.request._id }, { $set: { requestType: "SOFTWARE" } });

    const listed = await call(tech, "/");
    const r = listed.body.requests.find((x) => x._id === body.request._id);
    expect(r).toBeTruthy();
    expect(r.requestType).toBe("SOFTWARE");
    expect(r.requestTypeLabel).toBe("Service");
  });
});
