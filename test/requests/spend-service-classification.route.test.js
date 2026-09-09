// test/requests/spend-service-classification.route.test.js
//
// WHICH BUDGET A SERVICE COMES OUT OF — asked BEFORE the money is promised.
//
// ── THE PROBLEM THIS SUITE PINS ─────────────────────────────────────────────
// A service line was matched to the Service Master while the SERVICE ORDER was
// raised, which happens after finance approved and after the commitment was
// written. So the one moment the company had to ask "this service normally
// comes out of Repairs — are we approving it against Repairs?" was the one
// moment it could not, because the answer no longer changed anything.
//
// Matching moves before finance. Nothing else moves with it: the request-level
// head stays the commitment authority, there is still exactly ONE commitment,
// the approved quotation still beats the master's defaults, and no voucher,
// actual, PO, GRN or stock movement is created anywhere in here.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const { planEveryItem, PLANNED_KEY } = require("./plannedItems.helper");
const AccessDepartment = require("../../models/Access/AccessDepartment");
const { Acc_Budget } = require("../../models/Accountant_model/Acc_OperationalModels");
const { Acc_User } = require("../../models/Accountant_model/Acc_OrgModels");
const Commitment = require("../../models/Accountant_model/Acc_BudgetCommitment");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const ItemCategoryBudget = require("../../models/Accountant_model/Acc_ItemCategoryBudget");
const Employee = require("../../models/Employee");

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

const tokenFor = (emp) =>
  jwt.sign(
    { id: String(emp._id), role: "employee", employeeId: emp.biometricId,
      name: `${emp.firstName} ${emp.lastName}`, email: emp.email },
    process.env.JWT_SECRET || "grav_clothing_secret_key",
    { expiresIn: "10m" },
  );

const call = (emp, path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(emp)}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const FY_START = new Date("2026-03-31T18:30:00.000Z");
const FY_END = new Date("2027-03-31T18:29:59.999Z");

/**
 * A company with TWO approved budget lines for Logistics — so "the head the
 * request is on" and "the head the service prefers" can genuinely differ
 * while both remain spendable — plus one expense head that is NOT budgeted
 * for this department at all.
 */
async function seed({ allocated = 50000 } = {}) {
  const n = seq++;
  const company = await Acc_Company.create({
    companyName: `Svc Co ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const group = await Acc_Group.create({
    companyId: company._id, name: "Indirect Expenses", nature: "expense",
  });
  const mk = (name) => Acc_Ledger.create({
    companyId: company._id, name: `${name} ${n}`, groupId: group._id,
    groupName: group.name, nature: "expense",
  });

  const repairs = await mk("Repairs");
  const software = await mk("Software Subscriptions");
  /* Real, expense-natured, classifiable as spend — and this department has no
     approved budget line on it. The distinction the screen must not blur. */
  const unbudgeted = await mk("Travel");

  const budget = await planEveryItem(await Acc_Budget.create({
    name: `Budget FY 2026-27 (${n})`, financialYear: "2026-27", period: "yearly",
    status: "active", startDate: FY_START, endDate: FY_END, companyId: company._id,
    items: [
      { ledgerId: repairs._id, ledgerName: repairs.name, nature: "expense",
        department: "Logistics", allocatedAmount: allocated },
      { ledgerId: software._id, ledgerName: software.name, nature: "expense",
        department: "Logistics", allocatedAmount: allocated },
    ],
    budgetRequests: [],
  }));

  const tl = await Employee.create({
    firstName: "Sakib", lastName: `Tl${n}`, email: `svctl${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `SVTL${n}`, department: "Logistics",
  });
  const emp = await Employee.create({
    firstName: "Rutu", lastName: `Emp${n}`, email: `svcemp${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `SVEM${n}`, department: "Logistics",
    primaryManager: { managerId: tl._id },
  });
  const finEmp = await Employee.create({
    firstName: "Soumya", lastName: `Fin${n}`, email: `svcfin${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `SVFN${n}`, department: "Accounts",
  });
  await Acc_User.create({
    organizationId: new mongoose.Types.ObjectId(), email: `svcfin${n}@demo.example`,
    name: "Finance", role: "approver", isActive: true, passwordHash: "x",
  });

  const storeDept =
    (await AccessDepartment.findOne({ slug: "store" })) ||
    (await AccessDepartment.create({
      key: `store-${n}`, slug: "store", name: "Store & Purchase",
      dashboardPath: "/store/dashboard", isActive: true,
    }));
  const store = await Employee.create({
    firstName: "Bikash", lastName: `S${n}`, email: `svcstore${n}@demo.example`,
    isActive: true, gender: "Other", biometricId: `SVST${n}`,
    department: "Store", accessDepartmentId: storeDept._id,
  });

  return { company, repairs, software, unbudgeted, budget, emp, tl, finEmp, store };
}

const service = (company, over = {}) => Service.create({
  companyId: company._id,
  serviceCode: `SVC/2026-27/${String(++seq).padStart(4, "0")}`,
  name: over.name || `Service ${seq}`,
  status: "ACTIVE",
  ...over,
});

/** A SERVICE request, raised on `ledger`, sitting at pending_finance. */
async function atFinance(s, ledger, amount = 12000, over = {}) {
  const { body } = await call(s.emp, "/", {
    method: "POST",
    body: {
      title: "Compressor repair",
      requestType: "SERVICE",
      purpose: "Failed the annual inspection",
      ledgerId: String(ledger._id),
      plannedItemKey: PLANNED_KEY,
      items: [{ name: "Service visit", whyNeeded: "Failed inspection",
                quantity: 1, unit: "visit", rate: amount }],
      ...over,
    },
  });
  const id = body.request._id;
  /* ── THE QUOTE IS STORE'S, NOT THE REQUESTER'S ───────────────────────────
     `buildLines` deliberately ignores GST and vendor on creation — a
     requester does not quote. The real flow gets them from Store's
     fulfilment step; set here directly so these tests start from a priced
     line without dragging the whole intake flow in. */
  await SpendRequest.updateOne(
    { _id: id },
    { $set: { "items.0.gstPercent": 18, "items.0.vendorName": "Otis Elevators" } },
  );
  await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
  return { id, request: body.request };
}

const classify = (s, id, lines) =>
  call(s.store, `/${id}/service-lines`, { method: "PATCH", body: { lines } });

const classification = (s, id, who) =>
  call(who || s.store, `/${id}/service-classification`);

const lineIdOf = async (id) => {
  const doc = await SpendRequest.findById(id).lean();
  return String(doc.items[0]._id);
};

/* ═══ 0 · THE POLICY MARKER ════════════════════════════════════════════════ */

describe("which rules a request was raised under", () => {
  test("a new SERVICE request is stamped by the server", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);

    const doc = await SpendRequest.findById(id).lean();
    expect(doc.serviceClassificationPolicy).toBe("service-classification-v1");
  });

  test("a PRODUCT request is not stamped", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs, 12000, { requestType: "PRODUCT" });

    /* It has no service lines to classify, and marking it would make it look
       like a request the service gate has opinions about. */
    expect((await SpendRequest.findById(id).lean()).serviceClassificationPolicy).toBeUndefined();
  });

  test("a client cannot set or clear the marker", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/", {
      method: "POST",
      body: {
        title: "Compressor repair", requestType: "SERVICE", purpose: "p",
        ledgerId: String(s.repairs._id), plannedItemKey: PLANNED_KEY,
        /* A request that could name its own policy could opt itself out of
           the rule, which is the whole rule. */
        serviceClassificationPolicy: null,
        items: [{ name: "Visit", whyNeeded: "w", quantity: 1, unit: "visit", rate: 100 }],
      },
    });

    const doc = await SpendRequest.findById(body.request._id).lean();
    expect(doc.serviceClassificationPolicy).toBe("service-classification-v1");
  });

  test("the stamp is written by the shared creator, so every door applies it", () => {
    const fs = require("fs");
    const path = require("path");
    const root = path.join(__dirname, "../..");

    /* One function creates every spend request; three routers call it. If a
       second `SpendRequest.create` ever appears, that door would silently
       raise unstamped requests which the gate would then exempt. */
    const creates = ["routes", "services"].flatMap((dir) => {
      const out = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const full = path.join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.name.endsWith(".js")
            && /SpendRequest\.create\(|new SpendRequest\(/.test(fs.readFileSync(full, "utf8"))) {
            out.push(path.relative(root, full));
          }
        }
      };
      walk(path.join(root, dir));
      return out;
    });
    expect(creates).toEqual(["services/spendRequestCreate.service.js"]);

    const src = fs.readFileSync(path.join(root, "services/spendRequestCreate.service.js"), "utf8");
    expect(src).toMatch(/serviceClassificationPolicy: classifiedPolicy/);
  });

  test("the marker has no schema default, so a legacy document stays legacy", () => {
    /* A default would stamp every historical request the moment it was loaded
       and saved, quietly converting it into a new-policy one that the
       late-match door then refuses — stranding real, already-committed work. */
    expect(SpendRequest.schema.path("serviceClassificationPolicy").defaultValue).toBeUndefined();
  });

  test("the classification read reports which policy applies", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);

    const now = await classification(s, id, s.emp);
    expect(now.body.classification.policy).toBe("service-classification-v1");

    await SpendRequest.updateOne({ _id: id }, { $unset: { serviceClassificationPolicy: "" } });
    const legacy = await classification(s, id, s.emp);
    /* So a screen can say "this predates the rule" rather than rendering a
       legacy request as one somebody failed to classify. */
    expect(legacy.body.classification.policy).toBeNull();
  });
});

/* ═══ 1–3 · MATCHING BEFORE FINANCE ════════════════════════════════════════ */

describe("Store matches a service line before finance decides", () => {
  test("an active same-company service can be matched while the request is with finance", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    expect(res.status).toBe(200);
    const doc = await SpendRequest.findById(id).lean();
    /* Before finance, not after: the request has not been approved. */
    expect(doc.status).toBe("pending_finance");
    expect(String(doc.items[0].service)).toBe(String(svc._id));
  });

  test("the identity snapshot is stored on the line", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", billingUnit: "Per visit", sacCode: "998719",
    });
    const { id } = await atFinance(s, s.repairs);

    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const doc = await SpendRequest.findById(id).lean();
    expect(doc.items[0].serviceCode).toBe(svc.serviceCode);
    expect(doc.items[0].billingUnit).toBe("Per visit");
    expect(doc.items[0].sacCode).toBe("998719");
  });

  test("an inactive service is refused", async () => {
    const s = await seed();
    const retired = await service(s.company, { name: "Old AMC", status: "INACTIVE" });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(retired._id) }]);

    expect(res.status).toBe(400);
    expect(res.body.lineErrors[0].reason).toBe("SERVICE_INACTIVE");
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.items[0].service).toBeNull();
  });

  test("another company's service is refused, worded as not found", async () => {
    const s = await seed();
    /* ── ONE SET OF BOOKS PER TEST ────────────────────────────────────────
       `theCompany()` refuses to raise a request at all when more than one
       `Acc_Company` exists, so a second seeded company would break request
       creation rather than test the scope. The service carries a foreign
       `companyId` directly, which is exactly the shape the route guards
       against — its query is `{ _id, companyId: doc.companyId }`. */
    const theirs = await Service.create({
      companyId: new mongoose.Types.ObjectId(),
      serviceCode: "SVC/2026-27/8888", name: "Their AMC", status: "ACTIVE",
    });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(theirs._id) }]);

    expect(res.status).toBe(400);
    expect(res.body.lineErrors[0].reason).toBe("SERVICE_NOT_IN_COMPANY");
  });

  test("classification is refused once the request is approved", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);
    /* Matched first: a new-policy request cannot reach `approved` unclassified. */
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    const other = await service(s.company, { name: "Something else" });
    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(other._id) }]);

    /* The commitment exists; the classification it was made against must stop
       moving. The late-match door is the service-order route, and only there. */
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("TOO_LATE_TO_CLASSIFY");
  });

  test("Store can read the classification of a request still with finance", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    /* `maySeeRequest` admits Store only from APPROVED onward — right while
       their first job was raising the order, wrong now that they have an
       earlier one. A screen they may act on but not read is not a screen. */
    const res = await call(s.store, `/${id}/service-classification`);
    expect(res.status).toBe(200);
    expect(res.body.classification.lines).toHaveLength(1);
  });

  test("somebody with no claim on the request still cannot read it", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);
    /* Not the requester, not their TL, not finance, not Store. */
    const stranger = await Employee.create({
      firstName: "Nobody", lastName: `X${++seq}`, email: `stranger${seq}@demo.example`,
      isActive: true, gender: "Other", biometricId: `SX${seq}`, department: "Design",
    });

    const res = await call(stranger, `/${id}/service-classification`);
    expect(res.status).toBe(403);
  });

  test("only Store may classify", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);

    const res = await call(s.emp, `/${id}/service-lines`, {
      method: "PATCH",
      body: { lines: [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }] },
    });
    expect(res.status).toBe(403);
  });

  test("a product request has no service classification", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs, 12000, { requestType: "PRODUCT" });

    /* Asked by the requester: the visibility check runs before the type
       check, and Store has no claim on a product request they are not
       fulfilling. Reversing the two would leak the existence of a request. */
    const res = await classification(s, id, s.emp);
    expect(res.status).toBe(400);
    expect(res.body.reason).toBe("NOT_A_SERVICE_REQUEST");
  });
});

/* ═══ 4–6 · WHAT THE DEFAULT RESOLVES TO ═══════════════════════════════════ */

describe("the service's own budget default", () => {
  test("a configured default resolves with source service_default", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const line = res.body.classification.lines[0];
    expect(line.serviceDefault.source).toBe("service_default");
    expect(String(line.serviceDefault.budgetLedgerId)).toBe(String(s.repairs._id));
    expect(line.agreement).toBe("default_matches_request_head");
  });

  test("a service with no default stays honestly unresolved", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Pest control" });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const line = res.body.classification.lines[0];
    expect(line.serviceDefault.source).toBe("unresolved");
    expect(line.serviceDefault.budgetLedgerId).toBeNull();
    expect(line.agreement).toBe("service_default_unresolved");

    const doc = await SpendRequest.findById(id).lean();
    /* Not "manual_selection with a null head", which would read as somebody's
       decision. Nobody has decided anything yet. */
    expect(doc.items[0].budgetAllocation.resolutionSource).toBe("unresolved");
    expect(doc.items[0].budgetAllocation.status).toBe("unresolved");
  });

  test("an Item Category mapping is never consulted for a service line", async () => {
    const s = await seed();
    /* Finance maps the ITEM category "Facilities" to Software Subscriptions. */
    await ItemCategoryBudget.create({
      companyId: s.company._id, category: "Facilities", categoryKey: "facilities",
      budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
    });
    /* A service in a category spelled exactly the same, with no default. */
    const svc = await service(s.company, { name: "Lift AMC", category: "Facilities" });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    /* Item categories describe what the STORE STOCKS. A maintenance contract
       inheriting one would be charged to a materials budget and look
       completely deliberate on the report. */
    const line = res.body.classification.lines[0];
    expect(line.serviceDefault.source).toBe("unresolved");
    expect(line.serviceDefault.budgetLedgerId).toBeNull();
  });
});

/* ═══ 7 · THE QUOTE WINS ═══════════════════════════════════════════════════ */

describe("the approved quotation beats the master's defaults", () => {
  test("rate, GST and supplier are never overwritten by the service master", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC",
      defaultRate: 99999, defaultGstRate: 5, preferredVendorName: "Schindler",
      budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs, 12000);

    const done = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    /* Without this the test passes when the match FAILS: an untouched line
       still shows the quoted figures, so "nothing was overwritten" is true
       for the wrong reason. */
    expect(done.status).toBe(200);
    expect(String(done.body.request.items[0].service)).toBe(String(svc._id));

    const doc = await SpendRequest.findById(id).lean();
    const line = doc.items[0];
    /* What the vendor actually quoted, untouched. */
    expect(line.rate).toBe(12000);
    expect(line.gstPercent).toBe(18);
    expect(line.vendorName).toBe("Otis Elevators");
  });

  test("the classification route never even loads the master's commercial fields", () => {
    /* ── THE ACTUAL GUARD ─────────────────────────────────────────────────
       Not "we remember not to assign them" — the matching route's projection
       does not SELECT `defaultRate`, `defaultGstRate` or `preferredVendorId`,
       so there is nothing in scope to copy over a quote. Proven structurally
       because behaviourally it is unprovable: adding the assignment alone
       changes nothing (the fields are undefined), so a behavioural test stays
       green against code that clearly intends the overwrite. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "../../routes/CMS_Routes/Requests/spendRequests.js"),
      "utf8",
    );
    const at = src.indexOf('router.patch("/:id/service-lines"');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n});", at));

    const select = /\.select\("([^"]+)"\)/.exec(body);
    expect(select).toBeTruthy();
    for (const commercial of ["defaultRate", "defaultGstRate", "preferredVendor"]) {
      expect(select[1]).not.toContain(commercial);
    }
    /* And the line's own commercial fields are never assigned here either. */
    for (const field of ["line.rate", "line.gstPercent", "line.vendorName", "line.quantity"]) {
      expect(body).not.toContain(`${field} =`);
    }
  });

  test("the difference is reported as a note, not applied", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", defaultRate: 99999, defaultGstRate: 5, preferredVendorName: "Schindler",
    });
    const { id } = await atFinance(s, s.repairs, 12000);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    expect(res.status).toBe(200);

    const fields = res.body.classification.lines[0].masterDifferences.map((d) => d.field).sort();
    expect(fields).toEqual(["gst", "rate", "vendor"]);
    /* And the quoted figure is what travels beside it. */
    const rate = res.body.classification.lines[0].masterDifferences.find((d) => d.field === "rate");
    expect(rate.quoted).toBe(12000);
    expect(rate.masterDefault).toBe(99999);
  });
});

/* ═══ 8 · AVAILABLE MEANS APPROVED IN THIS DEPARTMENT ══════════════════════ */

describe("a mappable expense ledger is not the same as available budget", () => {
  test("a default with no approved budget line here reads as unavailable", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Site travel", budgetLedgerId: s.unbudgeted._id, budgetLedgerName: s.unbudgeted.name,
    });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const line = res.body.classification.lines[0];
    /* Travel is a perfectly good expense head. This department has no money on
       it, and offering it as a choice would point the request at an envelope
       that does not exist. */
    expect(line.agreement).toBe("default_not_available_in_department");
    expect(line.adoptable).toBe(false);
    expect(line.agreementMessage).toMatch(/not an approved budget head/i);
  });

  test("the available heads are the department's approved lines, not every expense ledger", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const res = await classification(s, id, s.emp);
    expect(res.status).toBe(200);
    const names = res.body.classification.availableHeads.map((h) => h.name).sort();
    expect(names).toEqual([s.repairs.name, s.software.name].sort());
    expect(names).not.toContain(s.unbudgeted.name);
  });

  test("a default on another approved head of this department IS adoptable", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Licence renewal", budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
    });
    const { id } = await atFinance(s, s.repairs);

    const res = await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const line = res.body.classification.lines[0];
    expect(line.agreement).toBe("different_head_selected");
    expect(line.adoptable).toBe(true);
  });

  test("classifying never rewrites the request's own head", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Licence renewal", budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
    });
    const { id } = await atFinance(s, s.repairs);

    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const doc = await SpendRequest.findById(id).lean();
    /* The service recommends; it does not decide. */
    expect(String(doc.ledgerId)).toBe(String(s.repairs._id));
  });
});

/* ═══ 9–13 · FINANCE RESOLVES CONSCIOUSLY ══════════════════════════════════ */

describe("finance must answer a mismatch before approving", () => {
  async function mismatched() {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Licence renewal", budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
    });
    /* Request on Repairs; the service's default is Software Subscriptions. */
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    return { s, id, svc };
  }

  test("finance cannot unknowingly approve a configured-default mismatch", async () => {
    const { s, id } = await mismatched();

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SERVICE_CLASSIFICATION_UNRESOLVED");
    /* The mismatch travels with the refusal, so the screen can render the
       choice rather than send finance off to find it. */
    expect(res.body.unresolved).toHaveLength(1);
    expect(res.body.unresolved[0].serviceDefaultName).toBe(s.software.name);
    expect(res.body.unresolved[0].requestHeadName).toBe(s.repairs.name);
    /* And nothing was promised. */
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
    expect((await SpendRequest.findById(id).lean()).status).toBe("pending_finance");
  });

  test("a deliberate choice with a reason is accepted and audited", async () => {
    const { s, id } = await mismatched();

    const res = await call(s.finEmp, `/${id}/approve`, {
      method: "PATCH",
      body: {
        serviceClassification: {
          reason: "This renewal is site maintenance, not a software licence.",
        },
      },
    });

    expect(res.status).toBe(200);
    const doc = await SpendRequest.findById(id).lean();
    const alloc = doc.items[0].budgetAllocation;
    expect(alloc.resolutionSource).toBe("manual_selection");
    expect(alloc.resolutionReason).toMatch(/site maintenance/);
    expect(alloc.selectedByName).toMatch(/^Soumya Fin/);
    expect(alloc.selectedAt).toBeInstanceOf(Date);
    expect(alloc.status).toBe("resolved");
    /* The head on the line is the REQUEST's head — one commitment, one
       authority. The source records that a person put it there. */
    expect(String(alloc.budgetLedgerId)).toBe(String(s.repairs._id));
  });

  test("a per-line reason works as well as a blanket one", async () => {
    const { s, id } = await mismatched();
    const lineId = await lineIdOf(id);

    const res = await call(s.finEmp, `/${id}/approve`, {
      method: "PATCH",
      body: {
        serviceClassification: {
          lines: [{ spendLineId: lineId, reason: "Charged to Repairs this year." }],
        },
      },
    });

    expect(res.status).toBe(200);
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.items[0].budgetAllocation.resolutionReason).toMatch(/Repairs this year/);
  });

  test("a matching default needs no reason and records service_default", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(200);
    const alloc = (await SpendRequest.findById(id).lean()).items[0].budgetAllocation;
    expect(alloc.resolutionSource).toBe("service_default");
    expect(alloc.status).toBe("resolved");
    /* No reason, no selector — nobody overrode anything. */
    expect(alloc.resolutionReason).toBe("");
    expect(alloc.selectedByName).toBe("");
  });

  test("a service with no default blocks nothing, and is recorded as a manual selection", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Pest control" });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    /* Nobody expressed an intention to contradict, so demanding a reason for
       departing from it would teach people to type "n/a". */
    expect(res.status).toBe(200);
    const alloc = (await SpendRequest.findById(id).lean()).items[0].budgetAllocation;
    expect(alloc.resolutionSource).toBe("manual_selection");
    expect(String(alloc.budgetLedgerId)).toBe(String(s.repairs._id));
    /* And the Service Master is NOT retroactively called resolved. */
    const master = await Service.findById(svc._id).lean();
    expect(master.budgetLedgerId).toBeNull();
  });

  test("an unmatched line BLOCKS approval on a new-policy request", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    /* An approval is the moment the money is promised. Promising it against a
       line nobody has identified is the thing this chunk exists to stop. */
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SERVICE_LINES_UNCLASSIFIED");
    expect(res.body.unclassified).toHaveLength(1);
    expect(res.body.unclassified[0].fault).toBe("NOT_MATCHED");

    const doc = await SpendRequest.findById(id).lean();
    expect(doc.status).toBe("pending_finance");
    expect(doc.items[0].budgetAllocation).toBeUndefined();
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("a reason cannot buy past a missing service", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);

    const res = await call(s.finEmp, `/${id}/approve`, {
      method: "PATCH",
      body: { serviceClassification: { reason: "Charge it to Repairs, I take responsibility." } },
    });

    /* A reason explains WHICH head was chosen. It cannot explain away a line
       whose service is unknown — there is nothing there to have an opinion
       about. */
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SERVICE_LINES_UNCLASSIFIED");
    expect(res.body.message).toMatch(/reason cannot stand in for a missing service/i);
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("a service retired after matching blocks approval", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await Service.updateOne({ _id: svc._id }, { $set: { status: "INACTIVE" } });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(409);
    expect(res.body.unclassified[0].fault).toBe("SERVICE_INACTIVE");
    expect(res.body.unclassified[0].message).toMatch(/retired/i);
  });

  test("a matched service that has vanished blocks approval", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await Service.deleteOne({ _id: svc._id });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(409);
    expect(res.body.unclassified[0].fault).toBe("SERVICE_NOT_IN_COMPANY");
  });

  test("a service moved to another company blocks approval, and says no more than that", async () => {
    const s = await seed();
    const svc = await service(s.company, { name: "Lift AMC" });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    /* The company-scoped lookup now misses it. */
    await Service.updateOne({ _id: svc._id },
      { $set: { companyId: new mongoose.Types.ObjectId() } });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(409);
    /* One message for "gone" and "another company's": distinguishing them
       would confirm the record exists somewhere else. */
    expect(res.body.unclassified[0].fault).toBe("SERVICE_NOT_IN_COMPANY");
    expect(res.body.unclassified[0].message).toMatch(/not available in this company/i);
  });

  test("a legacy request with no policy marker is still approvable unmatched", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);
    /* A request raised before the rule existed. It could not have been
       followed, and refusing it now would strand already-committed work. */
    await SpendRequest.updateOne({ _id: id }, { $unset: { serviceClassificationPolicy: "" } });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(200);
    expect((await SpendRequest.findById(id).lean()).status).toBe("approved");
  });

  test("a product request is never subject to the identity gate", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs, 12000, { requestType: "PRODUCT" });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(200);
    /* And it was never stamped: a product has no service lines to classify,
       and marking it would make it look like one the gate has opinions on. */
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.serviceClassificationPolicy).toBeUndefined();
  });

  test("rejection is never gated on classification", async () => {
    const { s, id } = await mismatched();

    const res = await call(s.finEmp, `/${id}/reject`, {
      method: "PATCH", body: { note: "Not this year." },
    });

    /* Refusing an unclassified or mismatched request is a perfectly good
       answer, and often the right one. */
    expect(res.status).toBe(200);
    expect((await SpendRequest.findById(id).lean()).status).toBe("rejected");
  });

  test("the existing unbudgeted exception path still works and fabricates nothing", async () => {
    const s = await seed();
    const { body } = await call(s.emp, "/", {
      method: "POST",
      body: {
        title: "Design tooling", requestType: "SERVICE",
        purpose: "No head covers this yet",
        unbudgetedHead: true,
        requestedHeadName: "Design tooling",
        requestedHeadReason: "None of our approved heads cover it.",
        items: [{ name: "Licence", whyNeeded: "New need", quantity: 1, unit: "year", rate: 12000 }],
      },
    });
    const id = body.request._id;
    expect(body.request.budgetMatchStatus).toBe("no_budget_line");

    await call(s.tl, `/${id}/approve`, { method: "PATCH", body: {} });
    const svc = await service(s.company, { name: "Design tooling" });
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(200);
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.budgetApprovalKind).toBe("unbudgeted");
    /* No head was in force, so the line is honestly unresolved rather than
       recorded as a manual selection of nothing. */
    const alloc = doc.items[0].budgetAllocation;
    expect(alloc.budgetLedgerId).toBeNull();
    expect(alloc.resolutionSource).toBe("unresolved");
    expect(alloc.status).toBe("unresolved");
  });
});

/* ═══ 14–15 · ONE COMMITMENT, UNCHANGED ════════════════════════════════════ */

describe("the commitment is exactly what it was", () => {
  test("approval creates one request-level commitment on the request's head", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs, 12000);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    /* One per REQUEST, not one per line. B2 does not split commitments. */
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(String(c.ledgerId)).toBe(String(s.repairs._id));
  });

  test("the amount is the approved grand total, not a line's own figure", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
    });
    const { id } = await atFinance(s, s.repairs, 12000);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await call(s.finEmp, `/${id}/approve`, {
      method: "PATCH", body: { serviceClassification: { reason: "Charged to Repairs." } },
    });

    const doc = await SpendRequest.findById(id).lean();
    const c = await Commitment.findOne({ spendRequestId: id }).lean();
    expect(c.amount).toBe(doc.grandTotal);
    /* A manual line classification does not redirect the money. */
    expect(String(c.ledgerId)).toBe(String(s.repairs._id));
  });

  test("re-approving does not write a second commitment", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);

    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
  });
});

/* ═══ 16–18 · CONVERSION AND LEGACY ════════════════════════════════════════ */

describe("the service order consumes the approved snapshot", () => {
  async function approvedAndMatched() {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", billingUnit: "Per visit", sacCode: "998719",
      budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    return { s, id, svc };
  }

  test("a new request needs no lineMatches — the stored match is used", async () => {
    const { s, id, svc } = await approvedAndMatched();

    const res = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });

    expect(res.status).toBe(201);
    const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(String(so.lines[0].service)).toBe(String(svc._id));
    expect(so.lines[0].serviceCode).toBe(svc.serviceCode);
    /* Not a late match: the request already carried it. */
    expect(res.body.legacyLateMatch).toBeUndefined();
  });

  test("changing the Service Master after approval does not restate the request", async () => {
    const { s, id, svc } = await approvedAndMatched();
    const before = await SpendRequest.findById(id).lean();

    await Service.updateOne({ _id: svc._id }, {
      $set: {
        name: "Lift AMC (renamed)", serviceCode: "SVC/2026-27/9999",
        billingUnit: "Per month", sacCode: "000000",
        budgetLedgerId: s.software._id, budgetLedgerName: s.software.name,
        defaultGstRate: 5, defaultRate: 1,
      },
    });

    const after = await SpendRequest.findById(id).lean();
    expect(after.items[0].serviceCode).toBe(before.items[0].serviceCode);
    expect(after.items[0].billingUnit).toBe(before.items[0].billingUnit);
    expect(after.items[0].sacCode).toBe(before.items[0].sacCode);
    expect(String(after.items[0].budgetAllocation.budgetLedgerId))
      .toBe(String(before.items[0].budgetAllocation.budgetLedgerId));
    expect(after.items[0].budgetAllocation.resolutionSource)
      .toBe(before.items[0].budgetAllocation.resolutionSource);
  });

  test("and the order built from it carries the approved snapshot, not the new master", async () => {
    const { s, id, svc } = await approvedAndMatched();
    await Service.updateOne({ _id: svc._id }, {
      $set: { serviceCode: "SVC/2026-27/9999", billingUnit: "Per month", sacCode: "000000" },
    });

    await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });

    const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    const line = await SpendRequest.findById(id).lean();
    /* The order is built from what was approved. A master edited afterwards
       does not reach back through an approval. */
    expect(so.lines[0].serviceCode).toBe(line.items[0].serviceCode);
    expect(so.lines[0].serviceCode).not.toBe("SVC/2026-27/9999");
  });

  test("a legacy approved request can still be matched late, and says so", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);
    /* Genuinely legacy: no policy marker, so the identity gate exempts it and
       the late-match door is open. Simulated by unsetting the stamp, which is
       exactly the shape a pre-B2 document has. */
    await SpendRequest.updateOne({ _id: id }, { $unset: { serviceClassificationPolicy: "" } });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    const svc = await service(s.company, { name: "Lift AMC" });

    const res = await call(s.store, `/${id}/service-order`, {
      method: "POST",
      body: { lineMatches: [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }] },
    });

    expect(res.status).toBe(201);
    /* Isolated and labelled: finance approved this without a classification,
       and the response says so rather than looking like the ordinary path. */
    expect(res.body.legacyLateMatch).toBeTruthy();
    expect(res.body.legacyLateMatch.message).toMatch(/approved it without them/i);
  });

  test("a late match on a new-policy request is refused outright", async () => {
    const { s, id } = await approvedAndMatched();
    const other = await service(s.company, { name: "Something else" });

    const res = await call(s.store, `/${id}/service-order`, {
      method: "POST",
      body: { lineMatches: [{ spendLineId: await lineIdOf(id), serviceId: String(other._id) }] },
    });

    /* This request was classified before approval, by definition — the finance
       gate refuses otherwise. So a late match can only be an attempt to supply
       an identity the approval never saw. Refused rather than silently
       ignored: ignoring it would tell Store their choice was accepted. */
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("LATE_MATCH_NOT_ALLOWED");

    const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
    expect(await ServiceOrder.countDocuments({ spendRequestId: id })).toBe(0);
  });

  test("the approved match is still what the order uses, with no body at all", async () => {
    const { s, id, svc } = await approvedAndMatched();

    const res = await call(s.store, `/${id}/service-order`, { method: "POST", body: {} });

    expect(res.status).toBe(201);
    const ServiceOrder = require("../../models/CMS_Models/Inventory/Operations/ServiceOrder");
    const so = await ServiceOrder.findOne({ spendRequestId: id }).lean();
    expect(String(so.lines[0].service)).toBe(String(svc._id));
  });

  test("a legacy request may still send lineMatches", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);
    await SpendRequest.updateOne({ _id: id }, { $unset: { serviceClassificationPolicy: "" } });
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    const svc = await service(s.company, { name: "Lift AMC" });

    const res = await call(s.store, `/${id}/service-order`, {
      method: "POST",
      body: { lineMatches: [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }] },
    });

    expect(res.status).toBe(201);
    expect(res.body.legacyLateMatch).toBeTruthy();
  });
});

/* ═══ 19–20 · WHAT MUST NOT HAVE CHANGED ═══════════════════════════════════ */

describe("nothing else moved", () => {
  test("a product request is unaffected end to end", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs, 12000, { requestType: "PRODUCT" });

    const res = await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });

    expect(res.status).toBe(200);
    const doc = await SpendRequest.findById(id).lean();
    expect(doc.status).toBe("approved");
    /* No service gate ran, and no allocation was invented on a product line. */
    expect(doc.items[0].budgetAllocation).toBeUndefined();
    expect(await Commitment.countDocuments({ spendRequestId: id })).toBe(1);
  });

  test("loading a request model creates no collections", () => {
    /* ── A REAL REGRESSION, CAUGHT BY THE BASELINE AUDIT ──────────────────
       The models first got the allocation enum by importing the RESOLVER,
       which pulls in `Acc_ItemCategoryBudget` and `Acc_Ledger`. Registering a
       mongoose model builds its indexes, and building indexes creates the
       collection — so merely requiring a request model made those collections
       exist. The baseline audit reads a collection's ABSENCE as "this feature
       was never deployed", so an undeployed feature started reading as 0%
       coverage instead of as unknown.

       The vocabulary now lives in a leaf module with no requires. */
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../models/CMS_Models/Requests/SpendRequest.js"), "utf8");
    expect(src).toMatch(/budgetAllocationVocabulary/);
    expect(src).not.toMatch(/require\(".*itemBudgetHead\.service"\)/);

    const leaf = fs.readFileSync(
      path.join(__dirname, "../../services/budgetAllocationVocabulary.js"), "utf8");
    /* And the leaf stays a leaf. One `require` in it is one model registered
       by every schema that reads the vocabulary. */
    expect(leaf).not.toMatch(/\brequire\(/);

    /* Both files agree on the words, because there is only one list. */
    const vocab = require("../../services/budgetAllocationVocabulary");
    const resolver = require("../../services/itemBudgetHead.service");
    expect(resolver.RESOLUTION_SOURCES).toEqual(vocab.RESOLUTION_SOURCES);
    expect(resolver.SOURCE_MANUAL).toBe(vocab.SOURCE_MANUAL);
  });

  test("the item resolution vocabulary is untouched and still valid", async () => {
    const svc = require("../../services/itemBudgetHead.service");
    /* B2 added two values; it removed none, and the item sources keep their
       exact strings — a stored document written before this must still load. */
    expect(svc.SOURCE_ITEM).toBe("item_override");
    expect(svc.SOURCE_CATEGORY).toBe("category_mapping");
    expect(svc.SOURCE_NONE).toBe("unresolved");
    expect(svc.RESOLUTION_SOURCES).toContain("service_default");
    expect(svc.RESOLUTION_SOURCES).toContain("manual_selection");

    const path = SpendRequest.schema.path("items").schema
      .path("budgetAllocation").schema.path("resolutionSource");
    for (const legacy of ["item_override", "category_mapping", "unresolved"]) {
      expect(path.enumValues).toContain(legacy);
    }
  });

  test("a legacy line with no allocation loads, and is not defaulted into one", async () => {
    const s = await seed();
    const { id } = await atFinance(s, s.repairs);

    const doc = await SpendRequest.findById(id).lean();
    /* Absent, not "unresolved". A default here would manufacture a decision
       on thousands of historical lines that nobody ever made. */
    expect(doc.items[0].budgetAllocation).toBeUndefined();

    const res = await call(s.emp, `/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.request.items[0].budgetAllocation).toBeNull();
  });

  test("classifying and approving creates no voucher, actual, PO, GRN or stock record", async () => {
    const s = await seed();
    const svc = await service(s.company, {
      name: "Lift AMC", budgetLedgerId: s.repairs._id, budgetLedgerName: s.repairs.name,
    });
    const { id } = await atFinance(s, s.repairs);

    const WATCHED = [
      "acc_vouchers", "purchaseorders", "serviceorders",
      "stocktransactions", "stockadjustments", "goodsreceipts", "rawitems",
    ];
    const db = mongoose.connection.db;
    const countAll = async () => {
      const out = {};
      for (const n of WATCHED) out[n] = await db.collection(n).countDocuments();
      return out;
    };

    const before = await countAll();
    await classify(s, id, [{ spendLineId: await lineIdOf(id), serviceId: String(svc._id) }]);
    await call(s.finEmp, `/${id}/approve`, { method: "PATCH", body: {} });
    const after = await countAll();

    /* The commitment is the one thing approval writes, and it already did
       before B2. Everything else is somebody else's step. */
    expect(after).toEqual(before);
  });
});
