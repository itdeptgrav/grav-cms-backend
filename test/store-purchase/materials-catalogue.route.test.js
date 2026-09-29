// test/store-purchase/materials-catalogue.route.test.js
//
// THE MATERIALS CATALOGUE'S MAINTENANCE FACTS — setup status, company-wide
// counts and the setup/budget/type filters on GET /api/cms/raw-items.
//
// The register used to headline Low stock / Out of stock (Inventory's job). It
// now headlines catalogue maintenance: how many materials need classification,
// a budget head or a base unit. Those counts must be COMPANY-WIDE and decided by
// the server (never a page-length count in the browser), and an unreadable
// budget mapping must never be reported as "unmapped".
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");

require("../../models/ProjectManager");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Employee = require("../../models/Employee");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const CategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const itemBudgetHead = require("../../services/itemBudgetHead.service");
const { setupOf, countSetup } = require("../../services/inventory/materialSetup.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/raw-items", require("../../routes/CMS_Routes/Inventory/Products/rawItems"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/raw-items`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => jest.restoreAllMocks());

const call = (token, qs = "") => fetch(`${base}${qs}`, { headers: { Authorization: `Bearer ${token}` } })
  .then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

async function seed() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Mat Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const other = await Acc_Company.create({ companyName: `Mat Other ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `mat${n}@test.example`;
  const emp = await Employee.create({ firstName: "M", lastName: `L${n}`, email, biometricId: `MAT${n}`, isActive: true, gender: "Other", department: "Store" });
  await DepartmentRole.create({ departmentSlug: "store", email, role: "approver", isActive: true });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  const token = jwt.sign({ id: String(emp._id), email, name: "M", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" });

  const group = await Acc_Group.create({ companyId: co._id, name: "Indirect Expenses", nature: "expense" });
  const ledger = await Acc_Ledger.create({ companyId: co._id, name: `Fabric head ${n}`, groupId: group._id, groupName: group.name, nature: "expense" });
  await CategoryBudget.create({ companyId: co._id, category: "Fabric", categoryKey: "fabric", budgetLedgerId: ledger._id, budgetLedgerName: ledger.name });

  const mk = (o) => RawItem.create({ companyId: co._id, name: `Item ${++seq}`, sku: `M-${seq}`, unit: "m", category: "Fabric", usedAs: "FABRIC", quantity: 0, ...o });
  const complete = await mk({});
  const unclassified = await mk({ usedAs: "NOT_CLASSIFIED" });
  const noCategory = await mk({ category: "" });            // no category → also no budget head
  const noUnit = await mk({ unit: "" });
  const unmappedOnly = await mk({ category: "Trims", usedAs: "TRIM" }); // category not mapped
  await RawItem.create({ companyId: other._id, name: "Foreign", sku: `F-${n}`, unit: "", category: "", quantity: 0 });
  return { co, token, complete, unclassified, noCategory, noUnit, unmappedOnly };
}

test("setupOf decides classification, unit and budget once — and unknown budget is null, not unmapped", () => {
  const map = new Map([["fabric", { budgetLedgerId: "L1", budgetLedgerName: "Fabric" }]]);
  expect(setupOf({ category: "Fabric", usedAs: "FABRIC", unit: "m" }, map)).toMatchObject({ needsSetup: false, budgetUnmapped: false });
  expect(setupOf({ category: "Fabric", unit: "m" }, map)).toMatchObject({ useUnclassified: true, classificationNeeded: true, needsSetup: true });
  expect(setupOf({ customCategory: "Fabric", usedAs: "FABRIC", customUnit: "roll" }, map)).toMatchObject({ needsSetup: false });
  const unknown = setupOf({ category: "Fabric", usedAs: "FABRIC", unit: "m" }, null);
  expect(unknown.budgetUnmapped).toBeNull();
  expect(unknown.needsSetup).toBe(false);
  expect(countSetup([{}], null).needBudgetMapping).toBeNull();
});

test("the list carries company-wide setup counts and a per-row setup verdict", async () => {
  const s = await seed();
  const r = await call(s.token, "?limit=2");
  expect(r.status).toBe(200);
  // Company-wide, not the 2-row page and not the other company.
  expect(r.body.setupCounts).toEqual({
    total: 5, needClassification: 2, needBudgetMapping: 2, needUnitSetup: 1, needsSetup: 4, budgetAvailable: true,
  });
  expect(r.body.rawItems).toHaveLength(2);
  for (const row of r.body.rawItems) expect(row.setup).toEqual(expect.objectContaining({ needsSetup: expect.any(Boolean) }));
  // Back-compat: the stock stats other callers read are still there.
  expect(r.body.stats).toEqual(expect.objectContaining({ total: 5 }));
});

test("setup=needed is applied on the server, so pagination is honest", async () => {
  const s = await seed();
  const r = await call(s.token, "?setup=needed&limit=50");
  const ids = r.body.rawItems.map((x) => String(x._id)).sort();
  expect(ids).toEqual([s.unclassified, s.noCategory, s.noUnit, s.unmappedOnly].map((x) => String(x._id)).sort());
  expect(r.body.pagination.total).toBe(4);
});

test("budget=unmapped narrows to items whose head does not resolve", async () => {
  const s = await seed();
  const r = await call(s.token, "?budget=unmapped&limit=50");
  expect(r.body.budgetFilter).toBe("applied");
  expect(r.body.rawItems.map((x) => String(x._id)).sort()).toEqual([s.noCategory, s.unmappedOnly].map((x) => String(x._id)).sort());
});

test("an unreadable budget mapping is disclosed, never counted as unmapped", async () => {
  const s = await seed();
  jest.spyOn(itemBudgetHead, "categoryMap").mockRejectedValue(new Error("mappings down"));
  jest.spyOn(console, "error").mockImplementation(() => {});
  const r = await call(s.token, "?budget=unmapped&limit=50");
  expect(r.status).toBe(200);
  expect(r.body.setupCounts.needBudgetMapping).toBeNull();
  expect(r.body.setupCounts.budgetAvailable).toBe(false);
  expect(r.body.budgetFilter).toBe("unavailable");
  expect(r.body.rawItems.every((x) => x.setup.budgetUnmapped === null)).toBe(true);
});
