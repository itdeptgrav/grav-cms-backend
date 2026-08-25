// test/accountant/budget-departments.route.test.js
//
// The department registry and, more importantly, what normalisation does to
// budgets that never touch it.
//
// The defect being closed: `department` was free text, so "Logistics",
// "logistics" and "LOGISTICS " were three departments in every roll-up, three
// rows on the Departments tab, and three different answers to "does this
// voucher match this budget line?" in budget control.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/AccountantAuthMiddleware", () => ({
  accountantAuth: (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ error: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  },
}));

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_BudgetDepartment } = require("../../models/Accountant_model/Acc_BudgetDepartment");
const { Acc_Voucher } = require("../../models/Accountant_model/Acc_VoucherModels");

const OWNER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Priya Owner",
  email: "priya.owner@example.com",
  role: "owner",
  permissions: { canView: true, canEdit: true, canApprove: true },
};
const VIEWER = {
  id: new mongoose.Types.ObjectId().toString(),
  name: "Vik Viewer",
  email: "vik.viewer@example.com",
  role: "viewer",
  permissions: { canView: true },
};

let server;
let base;
let seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/accountant/budgets", require("../../routes/Accountant_Routes/Acc_budgets"));
  app.use(
    "/api/accountant/budget-departments",
    require("../../routes/Accountant_Routes/Acc_budgetDepartments"),
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}/api/accountant`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path, { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(user ? { "x-test-user": JSON.stringify(user) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function seedCompany() {
  const company = await Acc_Company.create({
    companyName: `Company ${seq++}`,
    booksFromDate: new Date("2026-04-01"),
  });
  const expGroup = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const revGroup = await Acc_Group.create({
    companyId: company._id, name: "Direct Income", nature: "revenue",
  });
  const expenseLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Freight & Forwarding",
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const otherLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Repairs & Maintenance",
    groupId: expGroup._id, groupName: expGroup.name, nature: "expense",
  });
  const revenueLedger = await Acc_Ledger.create({
    companyId: company._id, name: "Export Sales",
    groupId: revGroup._id, groupName: revGroup.name, nature: "revenue",
  });
  return { company, expenseLedger, otherLedger, revenueLedger };
}

const YEAR = { startDate: new Date("2026-04-01"), endDate: new Date("2027-03-31") };

const mkBudget = ({ company, items, name = "FY26-27", ...rest }) =>
  Acc_Budget.create({
    name, financialYear: "2026-27", period: "yearly", status: "active",
    companyId: company._id, ...YEAR, items, ...rest,
  });

const line = (ledger, department, allocatedAmount = 500000, nature = "expense") => ({
  ledgerId: ledger._id, ledgerName: ledger.name, nature, department, allocatedAmount,
});

const post = ({ company, ledger, amount, type = "Dr", date = "2026-08-15" }) =>
  Acc_Voucher.create({
    companyId: company._id, voucherType: type === "Cr" ? "sales" : "purchase",
    voucherNumber: `DP/${seq++}/${Date.now()}`,
    voucherDate: new Date(date), status: "posted", grandTotal: amount,
    ledgerEntries: [{ ledgerId: ledger._id, ledgerName: ledger.name, type, amount }],
  });

const dash = (company, extra = "") =>
  call(`/budgets/dashboard?companyId=${company._id}&asOf=2027-03-31${extra}`);

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REGISTRY
 * ══════════════════════════════════════════════════════════════════════════ */

describe("the department registry", () => {
  test("a department is created with a derived slug — the caller never supplies one", async () => {
    const { company } = await seedCompany();
    const { status, body } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST",
      /* A slug in the payload is deliberately ignored: a slug the user can
         type is a second name to keep in step with the first. */
      body: { name: "  Logistics  ", slug: "something-else" },
    });

    expect(status).toBe(201);
    expect(body.department).toMatchObject({ slug: "logistics", name: "Logistics", isActive: true });
  });

  test("registering the same department twice returns the existing one, not an error", async () => {
    const { company } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const { status, body } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "  LOGISTICS " },
    });

    /* The department they asked for exists, which is the state they wanted. */
    expect(status).toBe(200);
    expect(body.alreadyExisted).toBe(true);
    expect(body.department.name).toBe("Logistics");
  });

  test("a nameless department is refused", async () => {
    const { company } = await seedCompany();
    for (const name of ["", "   ", "---", undefined]) {
      const { status } = await call(`/budget-departments?companyId=${company._id}`, {
        method: "POST", body: { name },
      });
      expect(status).toBe(400);
    }
  });

  test("a read-only role cannot register a department", async () => {
    const { company } = await seedCompany();
    const { status } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" }, user: VIEWER,
    });
    expect(status).toBe(403);
    expect(await Acc_BudgetDepartment.countDocuments({ companyId: company._id })).toBe(0);
  });

  test("the registry is company-scoped — one company's departments never reach another", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    await call(`/budget-departments?companyId=${a.company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });

    const { body: mine } = await call(`/budget-departments?companyId=${a.company._id}`);
    const { body: theirs } = await call(`/budget-departments?companyId=${b.company._id}`);

    expect(mine.departments.map((d) => d.slug)).toEqual(["logistics"]);
    expect(theirs.departments).toEqual([]);
  });

  test("two companies may each have their own Logistics", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const one = await call(`/budget-departments?companyId=${a.company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const two = await call(`/budget-departments?companyId=${b.company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.body.alreadyExisted).toBeUndefined();
  });

  test("a company is required", async () => {
    const { status } = await call("/budget-departments");
    expect(status).toBe(400);
  });

  test("the list names spellings already in use that nobody has registered", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [line(expenseLedger, "Logistics"), line(expenseLedger, "logistics"), line(expenseLedger, "Admin")],
    });

    const { body } = await call(`/budget-departments?companyId=${company._id}`);

    /* The migration story: a company sees its own history offered as one-click
       registrations rather than an empty registry and a memory test. Variants
       collapse, so "Logistics" and "logistics" are ONE suggestion of 2. */
    const byslug = Object.fromEntries(body.unregistered.map((u) => [u.slug, u.count]));
    expect(byslug).toEqual({ logistics: 2, admin: 1 });
  });

  test("a registered department drops out of the unregistered list", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics")] });
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });

    const { body } = await call(`/budget-departments?companyId=${company._id}`);
    expect(body.unregistered).toEqual([]);
    expect(body.departments.map((d) => d.slug)).toEqual(["logistics"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ALIASES — the only cure for a misspelling
 * ══════════════════════════════════════════════════════════════════════════ */

describe("aliases", () => {
  test("an alias resolves a misspelling that no rule could fold", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body: created } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics", aliases: ["Logistcs"] },
    });
    expect(created.department.aliases).toEqual(["logistcs"]);

    /* A budget written long ago carrying the typo. */
    await mkBudget({ company, items: [line(expenseLedger, "Logistcs"), line(expenseLedger, "Logistics")] });

    const { body } = await dash(company);
    const rows = body.byDepartment.filter((d) => d.departmentSlug === "logistics");
    expect(rows).toHaveLength(1);
    expect(rows[0].department).toBe("Logistics");
    expect(rows[0].expense.allocated).toBe(1000000);
  });

  test("an alias may be added after the fact, and past rows resolve immediately", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body: created } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    await mkBudget({ company, items: [line(expenseLedger, "Logistcs"), line(expenseLedger, "Logistics")] });

    const before = await dash(company);
    expect(before.body.byDepartment).toHaveLength(2);

    await call(`/budget-departments/${created.department._id}?companyId=${company._id}`, {
      method: "PATCH", body: { aliases: ["logistcs"] },
    });

    /* No budget was rewritten — the registry simply now knows what the typo
       means, and every past row carrying it resolves. */
    const after = await dash(company);
    expect(after.body.byDepartment).toHaveLength(1);
    expect(after.body.byDepartment[0].expense.allocated).toBe(1000000);
  });

  test("a real department cannot be made an alias of another", async () => {
    const { company } = await seedCompany();
    const { body: logistics } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Admin" },
    });

    /* Allowing it would make Logistics silently swallow Admin's spend, by a
       precedence nobody can see on screen. */
    const { status, body } = await call(
      `/budget-departments/${logistics.department._id}?companyId=${company._id}`,
      { method: "PATCH", body: { aliases: ["Admin"] } },
    );
    expect(status).toBe(400);
    expect(body.message).toMatch(/department in its own right/);
  });

  test("a department cannot be its own alias", async () => {
    const { company } = await seedCompany();
    const { body } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics", aliases: ["logistics", "LOGISTICS"] },
    });
    expect(body.department.aliases).toEqual([]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * RENAME AND RETIRE
 * ══════════════════════════════════════════════════════════════════════════ */

describe("rename and retire", () => {
  test("renaming changes the label without orphaning a single budget", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body: created } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    await mkBudget({ company, items: [line(expenseLedger, "Logistics")] });

    const { body: renamed } = await call(
      `/budget-departments/${created.department._id}?companyId=${company._id}`,
      { method: "PATCH", body: { name: "Supply Chain" } },
    );

    /* The slug does NOT move. That is the whole point of having one: budgets
       still say "Logistics" and still resolve. */
    expect(renamed.department.slug).toBe("logistics");
    expect(renamed.department.name).toBe("Supply Chain");

    const { body } = await dash(company);
    expect(body.byDepartment[0].department).toBe("Supply Chain");
    expect(body.byDepartment[0].expense.allocated).toBe(500000);
  });

  test("a retired department leaves the picker but keeps reporting", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body: created } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    await mkBudget({ company, items: [line(expenseLedger, "Logistics")] });
    await post({ company, ledger: expenseLedger, amount: 120000 });

    await call(`/budget-departments/${created.department._id}?companyId=${company._id}`, {
      method: "PATCH", body: { isActive: false },
    });

    const { body: picker } = await call(`/budget-departments?companyId=${company._id}`);
    expect(picker.departments).toEqual([]);

    const { body: all } = await call(`/budget-departments?companyId=${company._id}&includeInactive=true`);
    expect(all.departments.map((d) => d.slug)).toEqual(["logistics"]);

    /* A company that dissolves Logistics in March still has to explain what
       Logistics spent in January. Nothing in the read path drops it. */
    const { body } = await dash(company);
    const row = body.byDepartment.find((d) => d.departmentSlug === "logistics");
    expect(row.department).toBe("Logistics");
    expect(row.expense.actual).toBe(120000);
  });

  test("another company's department cannot be renamed", async () => {
    const a = await seedCompany();
    const b = await seedCompany();
    const { body: mine } = await call(`/budget-departments?companyId=${a.company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const { status } = await call(
      `/budget-departments/${mine.department._id}?companyId=${b.company._id}`,
      { method: "PATCH", body: { name: "Hijacked" } },
    );
    expect(status).toBe(404);
  });

  test("a read-only role cannot rename or retire", async () => {
    const { company } = await seedCompany();
    const { body: created } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const { status } = await call(
      `/budget-departments/${created.department._id}?companyId=${company._id}`,
      { method: "PATCH", body: { name: "Nope" }, user: VIEWER },
    );
    expect(status).toBe(403);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NORMALISATION WITHOUT A REGISTRY — legacy rows, untouched
 * ══════════════════════════════════════════════════════════════════════════ */

describe("normalisation of rows nobody registered", () => {
  test("case and spacing variants group together with no registry at all", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [
        line(expenseLedger, "Logistics", 100000),
        line(expenseLedger, "logistics", 200000),
        line(expenseLedger, "LOGISTICS ", 300000),
        line(expenseLedger, " Logistics", 400000),
      ],
    });

    const { body } = await dash(company);

    /* Four rows on the Departments tab, each holding a quarter of the answer,
       was the defect. Registering nothing still fixes it. */
    expect(body.byDepartment).toHaveLength(1);
    expect(body.byDepartment[0].expense.allocated).toBe(1000000);
    expect(body.byDepartment[0].departmentSlug).toBe("logistics");
  });

  test("the row is labelled with the commonest spelling, not the first one seen", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [
        line(expenseLedger, "logistics", 100000),
        line(expenseLedger, "Logistics", 100000),
        line(expenseLedger, "Logistics", 100000),
      ],
    });

    const { body } = await dash(company);
    /* Labelling by first-seen would make the heading depend on which budget
       happened to be created first. */
    expect(body.byDepartment[0].department).toBe("Logistics");
    expect(body.byDepartment[0].registered).toBe(false);
  });

  test("inconsistent spelling is said out loud, so someone can tidy it", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [line(expenseLedger, "Logistics"), line(expenseLedger, "logistics")],
    });

    const { body } = await dash(company);
    expect(body.byDepartment[0].spellings).toEqual(["Logistics", "logistics"]);
  });

  test("a consistently spelled department reports no spelling problem", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics")] });
    const { body } = await dash(company);
    expect(body.byDepartment[0].spellings).toBeUndefined();
  });

  test("lines with no department at all are still Unassigned, not a department", async () => {
    const { company, expenseLedger, otherLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [line(expenseLedger, "Logistics"), line(otherLedger, null)],
    });

    const { body } = await dash(company);
    const unassigned = body.byDepartment.find((d) => d.department === "Unassigned");
    expect(unassigned).toBeTruthy();
    expect(unassigned.departmentSlug).toBeNull();
  });

  test("a legacy budget's own detail view groups variants too", async () => {
    const { company, expenseLedger } = await seedCompany();
    const budget = await mkBudget({
      company,
      items: [line(expenseLedger, "Logistics", 100000), line(expenseLedger, "logistics", 200000)],
    });

    const { body } = await call(`/budgets/${budget._id}?companyId=${company._id}&asOf=2027-03-31`);
    /* One budget carrying both spellings is the same defect at a smaller
       scale, and is fixed by the same rule. */
    expect(body.budget.byDepartment).toHaveLength(1);
    expect(body.budget.byDepartment[0].expense.allocated).toBe(300000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WRITES STORE THE CANONICAL SPELLING
 * ══════════════════════════════════════════════════════════════════════════ */

describe("writes normalise", () => {
  test("a department-scope budget stores the registry's spelling", async () => {
    const { company, expenseLedger } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });

    const { status, body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: {
        name: "Logistics FY", financialYear: "2026-27", period: "yearly", status: "active",
        startDate: "2026-04-01", endDate: "2027-03-31",
        scope: "department", department: "  lOgIsTiCs ",
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", department: "LOGISTICS", allocatedAmount: 500000 }],
      },
    });

    expect(status).toBe(201);
    expect(body.budget.department).toBe("Logistics");
    expect(body.budget.items[0].department).toBe("Logistics");
  });

  test("an unregistered department is stored as typed — no spelling is invented for it", async () => {
    const { company, expenseLedger } = await seedCompany();
    const { body } = await call(`/budgets?companyId=${company._id}`, {
      method: "POST",
      body: {
        name: "Ops FY", financialYear: "2026-27", period: "yearly", status: "active",
        startDate: "2026-04-01", endDate: "2027-03-31",
        scope: "department", department: "  Field Operations  ",
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", department: "field operations", allocatedAmount: 1 }],
      },
    });

    /* Whitespace is tidied; case is not touched, because choosing a
       capitalisation for a department nobody registered is inventing one. */
    expect(body.budget.department).toBe("Field Operations");
    expect(body.budget.items[0].department).toBe("field operations");
  });

  test("updating a budget canonicalises too", async () => {
    const { company, expenseLedger } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const budget = await mkBudget({ company, items: [line(expenseLedger, "Admin")], scope: "company" });

    const { body } = await call(`/budgets/${budget._id}?companyId=${company._id}`, {
      method: "PUT",
      body: {
        scope: "department", department: "LOGISTICS",
        items: [{ ledgerId: String(expenseLedger._id), nature: "expense", department: "logistics", allocatedAmount: 500000 }],
      },
    });

    expect(body.budget.department).toBe("Logistics");
    expect(body.budget.items[0].department).toBe("Logistics");
  });

  test("a request stores the asking department canonically", async () => {
    const { company, expenseLedger } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics" },
    });
    const budget = await mkBudget({ company, items: [], status: "collecting" });

    const { status, body } = await call(`/budgets/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: {
        department: " logistics ", ledgerId: String(expenseLedger._id),
        requestedAmount: 100000, purpose: "Peak season freight",
      },
    });

    expect(status).toBe(201);
    /* Two spellings in one collection round would make close-collection
       default one of them as never having replied. */
    expect(body.request.department).toBe("Logistics");
  });

  test("an alias typed into a request resolves to the real department", async () => {
    const { company, expenseLedger } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics", aliases: ["Logistcs"] },
    });
    const budget = await mkBudget({ company, items: [], status: "collecting" });

    const { body } = await call(`/budgets/${budget._id}/requests?companyId=${company._id}`, {
      method: "POST",
      body: {
        department: "Logistcs", ledgerId: String(expenseLedger._id),
        requestedAmount: 100000, purpose: "Peak season freight",
      },
    });
    expect(body.request.department).toBe("Logistics");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * FILTERS
 * ══════════════════════════════════════════════════════════════════════════ */

describe("department filters accept any spelling", () => {
  async function twoDepartments() {
    const { company, expenseLedger, otherLedger } = await seedCompany();
    await mkBudget({
      company, name: "Mixed",
      items: [line(expenseLedger, "LOGISTICS", 500000), line(otherLedger, "Admin", 300000)],
    });
    return { company, expenseLedger, otherLedger };
  }

  test("the dashboard filter matches whatever case the caller uses", async () => {
    const { company } = await twoDepartments();
    for (const spelling of ["Logistics", "logistics", "LOGISTICS", "%20Logistics%20"]) {
      const { body } = await dash(company, `&department=${spelling}`);
      expect(body.totals.expense.allocated).toBe(500000);
    }
  });

  test("the dashboard filter accepts a registered alias", async () => {
    const { company } = await twoDepartments();
    const { body: dept } = await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics", aliases: ["Logistcs"] },
    });
    expect(dept.department.slug).toBe("logistics");

    const { body } = await dash(company, "&department=Logistcs");
    expect(body.totals.expense.allocated).toBe(500000);
  });

  test("the list filter matches any spelling too", async () => {
    const { company } = await twoDepartments();
    const { body } = await call(`/budgets?companyId=${company._id}&department=logistics`);
    expect(body.budgets.map((b) => b.name)).toEqual(["Mixed"]);

    const { body: none } = await call(`/budgets?companyId=${company._id}&department=Marketing`);
    expect(none.budgets).toEqual([]);
  });

  test("filtering to a department shows only its lines, whatever they are spelled", async () => {
    const { company } = await twoDepartments();
    const { body } = await dash(company, "&department=logistics");
    expect(body.totals.lineCount).toBe(1);
    expect(body.byDepartment).toHaveLength(1);
    expect(body.byDepartment[0].departmentSlug).toBe("logistics");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * BUDGET CONTROL
 * ══════════════════════════════════════════════════════════════════════════ */

describe("budget control matches departments on identity", () => {
  const check = (company, ledger, department, amount = 50000) =>
    call("/budgets/check-availability", {
      method: "POST",
      body: {
        companyId: String(company._id), voucherDate: "2026-08-15", department,
        ledgerEntries: [{ ledgerId: String(ledger._id), type: "Dr", amount }],
      },
    });

  test("a voucher tagged \"logistics\" matches a line reading \"Logistics\"", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });

    const { body } = await check(company, expenseLedger, "logistics");

    /* A miss here is not a small thing: with no matching line the spend reads
       as UNBUDGETED and the posting is refused or forced through an override,
       for a budget that exists and has room. */
    expect(body.results[0].status).not.toBe("missing_budget");
    expect(body.results[0].allocated).toBe(500000);
  });

  test("every case and spacing variant matches", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });

    for (const spelling of ["Logistics", "logistics", "LOGISTICS", "  Logistics  "]) {
      const { body } = await check(company, expenseLedger, spelling);
      expect(body.results[0].allocated).toBe(500000);
    }
  });

  test("a registered alias matches", async () => {
    const { company, expenseLedger } = await seedCompany();
    await call(`/budget-departments?companyId=${company._id}`, {
      method: "POST", body: { name: "Logistics", aliases: ["Logistcs"] },
    });
    await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });

    const { body } = await check(company, expenseLedger, "Logistcs");
    expect(body.results[0].allocated).toBe(500000);
  });

  test("a genuinely different department still does not match", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });

    const { body } = await check(company, expenseLedger, "Marketing");
    /* Normalisation must not become "everything matches everything". */
    expect(body.results[0].status).toBe("missing_budget");
  });

  test("an unregistered misspelling still misses — only an alias can fix that", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });

    const { body } = await check(company, expenseLedger, "Logistcs");
    expect(body.results[0].status).toBe("missing_budget");
  });

  test("allocations across spelling variants still sum, as they always did", async () => {
    const { company, expenseLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [line(expenseLedger, "Logistics", 300000), line(expenseLedger, "logistics", 200000)],
    });

    const { body } = await check(company, expenseLedger, "LOGISTICS");
    expect(body.results[0].allocated).toBe(500000);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NOTHING ELSE MOVED
 * ══════════════════════════════════════════════════════════════════════════ */

describe("actuals are untouched by any of this", () => {
  test("spend figures are identical whether or not a department is registered", async () => {
    const read = async (register) => {
      const { company, expenseLedger } = await seedCompany();
      if (register) {
        await call(`/budget-departments?companyId=${company._id}`, {
          method: "POST", body: { name: "Logistics" },
        });
      }
      await mkBudget({ company, items: [line(expenseLedger, "Logistics", 500000)] });
      await post({ company, ledger: expenseLedger, amount: 120000 });
      const { body } = await dash(company);
      return body.totals;
    };

    const plain = await read(false);
    const registered = await read(true);

    expect(registered.expense.actual).toBe(plain.expense.actual);
    expect(registered.expense.allocated).toBe(plain.expense.allocated);
    expect(plain.expense.actual).toBe(120000);
  });

  test("revenue keeps its sign through department grouping", async () => {
    const { company, revenueLedger } = await seedCompany();
    await mkBudget({
      company,
      items: [
        line(revenueLedger, "Sales", 4000000, "revenue"),
        line(revenueLedger, "sales", 1000000, "revenue"),
      ],
    });
    await post({ company, ledger: revenueLedger, amount: 900000, type: "Cr" });

    const { body } = await dash(company);
    const sales = body.byDepartment.find((d) => d.departmentSlug === "sales");
    expect(sales.revenue.allocated).toBe(5000000);
    expect(sales.revenue.actual).toBe(900000);
  });

  test("another company's postings never reach a department roll-up", async () => {
    const { company, expenseLedger } = await seedCompany();
    const other = await seedCompany();
    await mkBudget({ company, items: [line(expenseLedger, "Logistics")] });
    await post({ company, ledger: expenseLedger, amount: 100000 });
    await post({ company: other.company, ledger: expenseLedger, amount: 900000 });

    const { body } = await dash(company);
    expect(body.byDepartment[0].expense.actual).toBe(100000);
  });
});
