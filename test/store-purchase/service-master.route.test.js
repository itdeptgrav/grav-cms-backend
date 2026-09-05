// test/store-purchase/service-master.route.test.js
//
// Store & Purchase — the Service Master boundary.
//
// ── WHY A SEPARATE MASTER GETS ITS OWN BOUNDARY TEST ────────────────────────
// The cheap way to buy an AMC contract in this system was to register it as a
// catalogue item, which gives it a quantity, a warehouse, a reorder level and
// a goods receipt — four questions nobody can answer about a service, all of
// which then appear on stock reports as facts. This suite pins the two things
// that keep that from happening again:
//
//   · the boundary — a service belongs to one company, and its supplier and
//     budget head must belong to the SAME company;
//   · the absence — nothing inventory-shaped exists on the model or leaves
//     the API, and no amount of client input can add it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Employee = require("../../models/Employee");
const { Acc_Company, Acc_Group, Acc_Ledger } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SpDocumentSequence = require("../../models/CMS_Models/StorePurchase/SpDocumentSequence");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/services", require("../../routes/CMS_Routes/Inventory/Services/services"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    /* A method the router does not define falls through to Express's own
       HTML 404. Reading that as JSON would throw and hide the status, which
       is the very thing the "no delete route" test is asserting. */
    let body = null;
    try { body = JSON.parse(text || "null"); } catch { body = { nonJson: text }; }
    return { status: r.status, body };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function person({ co, grant = "store", role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `svc${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `SVC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: name });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const supplier = ({ co, name }) =>
  Vendor.create({ companyId: co._id, companyName: name || `Vendor ${++seq}` });

/* ── A HEAD WITH A REAL GROUP BEHIND IT ─────────────────────────────────────
 * This used to invent a `groupId` that pointed at nothing. The classification
 * contract derives a head's nature from its GROUP, so every fixture ledger was
 * unclassifiable — which happened to pass while the route asked `nature ===
 * "expense"` on the ledger itself, and stopped passing the moment the route
 * started using the same gate Finance uses. The fixture was the unrealistic
 * part: a ledger in this system always hangs off a group. */
const groupFor = async (co, nature) => Acc_Group.create({
  companyId: co._id,
  name: nature === "expense" ? `Indirect Expenses ${++seq}`
    : nature === "revenue" ? `Sales Accounts ${++seq}`
      : `Fixed Assets ${++seq}`,
  nature,
});

/** An expense budget head unless told otherwise. */
const ledger = async ({ co, name, nature = "expense" }) => {
  const group = await groupFor(co, nature);
  return Acc_Ledger.create({
    companyId: co._id, name: name || `Head ${++seq}`,
    groupId: group._id, groupName: group.name, nature,
  });
};

const register = (actor, co, body) =>
  call("/services", { method: "POST", token: actor.token, company: co._id, body });

/* ═══════════════════════════════════════════════════════════════════════════
 * THE COMPANY BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("a service belongs to one company", () => {
  test("the register shows this company's services and not another's", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });

    await register(mine, a, { name: "Lift AMC" });
    await register(theirs, b, { name: "Generator AMC" });

    const seen = await call("/services", { token: mine.token, company: a._id });
    expect(seen.status).toBe(200);
    expect(seen.body.services.map((s) => s.name)).toEqual(["Lift AMC"]);
  });

  test("the counts are this company's, not the system's", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });

    await register(mine, a, { name: "Pest control" });
    await register(theirs, b, { name: "Pest control B" });
    await register(theirs, b, { name: "Window cleaning" });

    const seen = await call("/services", { token: mine.token, company: a._id });
    expect(seen.body.stats).toEqual({ total: 1, active: 1 });
  });

  test("another company's service reads as missing, not as forbidden", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });

    const made = await register(theirs, b, { name: "Courier retainer" });
    const peek = await call(`/services/${made.body.service._id}`, { token: mine.token, company: a._id });

    expect(peek.status).toBe(404);
    /* 403 would confirm the service exists. 404 tells a prober nothing. */
    expect(peek.body.code).toBe("SERVICE_NOT_FOUND");
  });

  test("another company's service cannot be edited through this company", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });

    const made = await register(theirs, b, { name: "Legal retainer" });
    const edit = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: mine.token, company: a._id, body: { category: "Hijacked" },
    });

    expect(edit.status).toBe(404);
    const after = await Service.findById(made.body.service._id).lean();
    expect(after.category).toBe("");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NAMES
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("a service name is unique inside a company and free across companies", () => {
  test("two companies may both run a service called Lift AMC", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });

    const first = await register(mine, a, { name: "Lift AMC" });
    const second = await register(theirs, b, { name: "Lift AMC" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  test("the same name twice in one company is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    expect((await register(actor, co, { name: "Lift AMC" })).status).toBe(201);
    const again = await register(actor, co, { name: "Lift AMC" });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SERVICE_NAME_DUPLICATE");
  });

  test("case and spacing do not make a name different", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    await register(actor, co, { name: "Lift AMC" });
    const shouted = await register(actor, co, { name: "  lift   amc  " });

    expect(shouted.status).toBe(409);
  });

  test("renaming onto another service's name is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    await register(actor, co, { name: "Lift AMC" });
    const other = await register(actor, co, { name: "Chiller AMC" });

    const rename = await call(`/services/${other.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id, body: { name: "lift amc" },
    });

    expect(rename.status).toBe(409);
  });

  test("saving a service under its own unchanged name is not a clash", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const edit = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id,
      body: { name: "Lift AMC", category: "Facilities" },
    });

    expect(edit.status).toBe(200);
    expect(edit.body.service.category).toBe("Facilities");
  });

  test("a service must be named", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const blank = await register(actor, co, { name: "   " });

    expect(blank.status).toBe(400);
    expect(blank.body.field).toBe("name");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CODE IS THE SERVER'S
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("the internal code is issued by the server", () => {
  test("a code is issued on save and is unique in the company", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const one = await register(actor, co, { name: "Lift AMC" });
    const two = await register(actor, co, { name: "Chiller AMC" });

    expect(one.body.service.serviceCode).toMatch(/^SVC\/\d{4}-\d{2}\/\d{4}$/);
    expect(two.body.service.serviceCode).not.toBe(one.body.service.serviceCode);
  });

  test("a code supplied by the client is refused, not silently ignored", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const forged = await register(actor, co, { name: "Lift AMC", serviceCode: "SVC/1900-01/0001" });

    expect(forged.status).toBe(400);
    expect(forged.body.field).toBe("serviceCode");
    expect(await Service.countDocuments({ companyId: co._id })).toBe(0);
  });

  test("the code cannot be rewritten later", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const edit = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id, body: { serviceCode: "SVC/1900-01/9999" },
    });

    expect(edit.status).toBe(400);
    const after = await Service.findById(made.body.service._id).lean();
    expect(after.serviceCode).toBe(made.body.service.serviceCode);
  });

  /* ── ON PROVING THIS ────────────────────────────────────────────────────
   * The obvious test fires two registrations through `Promise.all` and asserts
   * two distinct codes. It is not a proof: when the two requests happen to
   * serialise, a read-last-plus-one implementation passes it too — measured at
   * two passes in three runs against a deliberately broken version. So the
   * mechanism is pinned instead of the timing. */
  test("codes come from the shared atomic counter, not from reading the last row", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    await register(actor, co, { name: "Counter A" });
    await register(actor, co, { name: "Counter B" });

    const counter = await SpDocumentSequence.findOne({
      companyId: co._id, documentType: "SERVICE",
    }).lean();

    /* The counter moved twice. An implementation that sorts the collection and
       adds one never creates this document at all. */
    expect(counter).toBeTruthy();
    expect(counter.next).toBe(2);
  });

  test("two services registered at the same moment get two different codes", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const both = await Promise.all([
      register(actor, co, { name: "Racing A" }),
      register(actor, co, { name: "Racing B" }),
    ]);

    expect(both.map((r) => r.status).sort()).toEqual([201, 201]);
    expect(new Set(both.map((r) => r.body.service.serviceCode)).size).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * OWNERSHIP AND AUDIT ARE THE SERVER'S TOO
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("ownership and authorship cannot be supplied by a caller", () => {
  test("a body naming another company is refused", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const actor = await person({ co: a });

    const forged = await register(actor, a, { name: "Lift AMC", companyId: String(b._id) });

    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(await Service.countDocuments({ companyId: b._id })).toBe(0);
  });

  test("the recorded author is the signed-in person, not the body", async () => {
    const co = await company("Alpha");
    const actor = await person({ co, name: "Asha" });

    const forged = await register(actor, co, { name: "Lift AMC", createdByName: "Someone Else" });
    expect(forged.status).toBe(400);
    expect(forged.body.field).toBe("createdByName");

    const honest = await register(actor, co, { name: "Lift AMC" });
    expect(honest.body.service.createdByName).toBe("Asha");
  });

  test("status is not editable through the general edit route", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const sneak = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "INACTIVE" },
    });

    expect(sneak.status).toBe(400);
    expect((await Service.findById(made.body.service._id).lean()).status).toBe("ACTIVE");
  });

  test("a signed-in person without store authority cannot register a service", async () => {
    const co = await company("Alpha");
    const outsider = await person({ co, grant: null });

    const attempt = await register(outsider, co, { name: "Lift AMC" });

    expect(attempt.status).toBeGreaterThanOrEqual(403);
    expect(await Service.countDocuments({ companyId: co._id })).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SUPPLIER AND THE BUDGET HEAD
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("references must belong to the same company", () => {
  test("a supplier in this company is accepted and its name is kept", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const v = await supplier({ co, name: "Otis Elevators" });

    const made = await register(actor, co, { name: "Lift AMC", preferredVendorId: String(v._id) });

    expect(made.status).toBe(201);
    expect(made.body.service.preferredVendorName).toBe("Otis Elevators");
  });

  test("another company's supplier is refused", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const actor = await person({ co: a });
    const theirs = await supplier({ co: b, name: "Their Vendor" });

    const made = await register(actor, a, { name: "Lift AMC", preferredVendorId: String(theirs._id) });

    expect(made.status).toBe(400);
    expect(made.body.code).toBe("SERVICE_SUPPLIER_INVALID");
    expect(await Service.countDocuments({ companyId: a._id })).toBe(0);
  });

  test("an expense head in this company is accepted", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const head = await ledger({ co, name: "Repairs & Maintenance" });

    const made = await register(actor, co, { name: "Lift AMC", budgetLedgerId: String(head._id) });

    expect(made.status).toBe(201);
    expect(made.body.service.budgetLedgerName).toBe("Repairs & Maintenance");
  });

  test("another company's budget head is refused", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const actor = await person({ co: a });
    const theirs = await ledger({ co: b });

    const made = await register(actor, a, { name: "Lift AMC", budgetLedgerId: String(theirs._id) });

    expect(made.status).toBe(400);
    expect(made.body.code).toBe("SERVICE_BUDGET_HEAD_INVALID");
  });

  test("a ledger that is not a spending budget is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const asset = await ledger({ co, name: "Plant & Machinery", nature: "asset" });

    const made = await register(actor, co, { name: "Lift AMC", budgetLedgerId: String(asset._id) });

    expect(made.status).toBe(400);
    expect(made.body.code).toBe("SERVICE_BUDGET_HEAD_INVALID");
    expect(made.body.message).toMatch(/not a budget head/i);
  });

  test("a revenue target is refused, and the message says what it is", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const sales = await ledger({ co, name: "Domestic Sales", nature: "revenue" });

    const made = await register(actor, co, { name: "Lift AMC", budgetLedgerId: String(sales._id) });

    expect(made.status).toBe(400);
    /* A figure to hit, not an envelope to spend from. */
    expect(made.body.message).toMatch(/revenue target/i);
  });

  test("an expense-natured head nobody budgets is refused too", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    /* Round Off IS an expense. It is not a budget head, and asking
       `nature === "expense"` — which this route used to do — accepted it. */
    const roundOff = await ledger({ co, name: "Round Off", nature: "expense" });

    const made = await register(actor, co, { name: "Lift AMC", budgetLedgerId: String(roundOff._id) });

    expect(made.status).toBe(400);
    expect(made.body.code).toBe("SERVICE_BUDGET_HEAD_INVALID");
  });

  test("a reference that is not an id at all is refused rather than crashing", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, { name: "Lift AMC", preferredVendorId: "not-an-id" });

    expect(made.status).toBe(400);
    expect(made.body.code).toBe("SERVICE_SUPPLIER_INVALID");
  });

  test("a preferred supplier can be cleared", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const v = await supplier({ co });
    const made = await register(actor, co, { name: "Lift AMC", preferredVendorId: String(v._id) });

    const cleared = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id, body: { preferredVendorId: null },
    });

    expect(cleared.body.service.preferredVendorId).toBeNull();
    expect(cleared.body.service.preferredVendorName).toBe("");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NUMBERS
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("rates and percentages", () => {
  test.each([[-1], [101], [999]])("a GST rate of %p is refused", async (bad) => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, { name: `GST ${bad}`, defaultGstRate: bad });

    expect(made.status).toBe(400);
    expect(made.body.field).toBe("defaultGstRate");
  });

  test("a GST rate that is not a number is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, { name: "Lift AMC", defaultGstRate: "eighteen" });

    expect(made.status).toBe(400);
  });

  test.each([[0], [5], [18], [100]])("a GST rate of %p is stored", async (ok) => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, { name: `GST ok ${ok}`, defaultGstRate: ok });

    expect(made.status).toBe(201);
    expect(made.body.service.defaultGstRate).toBe(ok);
  });

  test("no default rate reads as absent, and zero reads as zero", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const silent = await register(actor, co, { name: "Unpriced" });
    const free = await register(actor, co, { name: "Free of charge", defaultRate: 0 });

    /* "Nobody has estimated this" and "this costs nothing" are different
       answers and the API must not collapse them into 0. */
    expect(silent.body.service.defaultRate).toBeNull();
    expect(free.body.service.defaultRate).toBe(0);
  });

  test("a negative default rate is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    expect((await register(actor, co, { name: "Negative", defaultRate: -50 })).status).toBe(400);
  });

  test("a SAC code is optional and stored clean when given", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const none = await register(actor, co, { name: "No SAC" });
    const some = await register(actor, co, { name: "With SAC", sacCode: "  998719  " });

    expect(none.body.service.sacCode).toBe("");
    expect(some.body.service.sacCode).toBe("998719");
  });

  test("a recurring term outside the recorded list is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, { name: "Odd", recurring: { frequency: "FORTNIGHTLY" } });

    expect(made.status).toBe(400);
    expect(made.body.field).toBe("recurring.frequency");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * INACTIVATION INSTEAD OF DELETION
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("a service is retired, never deleted", () => {
  test("there is no delete route", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const gone = await call(`/services/${made.body.service._id}`, {
      method: "DELETE", token: actor.token, company: co._id,
    });

    expect(gone.status).toBe(404);
    expect(await Service.countDocuments({ _id: made.body.service._id })).toBe(1);
  });

  test("deactivating leaves the record readable", async () => {
    const co = await company("Alpha");
    const actor = await person({ co, name: "Asha" });
    const made = await register(actor, co, { name: "Lift AMC" });

    const off = await call(`/services/${made.body.service._id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "INACTIVE" },
    });

    expect(off.status).toBe(200);
    expect(off.body.service.status).toBe("INACTIVE");
    expect(off.body.service.selectable).toBe(false);

    const still = await call(`/services/${made.body.service._id}`, { token: actor.token, company: co._id });
    expect(still.status).toBe(200);
    expect(still.body.service.name).toBe("Lift AMC");
  });

  test("who retired it and when are recorded", async () => {
    const co = await company("Alpha");
    const actor = await person({ co, name: "Asha" });
    const made = await register(actor, co, { name: "Lift AMC" });

    await call(`/services/${made.body.service._id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "INACTIVE" },
    });

    const stored = await Service.findById(made.body.service._id).lean();
    expect(stored.statusChangedByName).toBe("Asha");
    expect(stored.statusChangedAt).toBeInstanceOf(Date);
  });

  test("a retired service can be brought back", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });
    const id = made.body.service._id;

    await call(`/services/${id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "INACTIVE" },
    });
    const back = await call(`/services/${id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "ACTIVE" },
    });

    expect(back.body.service.status).toBe("ACTIVE");
    expect(back.body.service.selectable).toBe(true);
  });

  test("a status that is not one of the two is refused", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const bad = await call(`/services/${made.body.service._id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "DELETED" },
    });

    expect(bad.status).toBe(400);
  });

  test("the register can be filtered to active, inactive or everything", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const keep = await register(actor, co, { name: "Kept" });
    const drop = await register(actor, co, { name: "Dropped" });
    await call(`/services/${drop.body.service._id}/status`, {
      method: "PATCH", token: actor.token, company: co._id, body: { status: "INACTIVE" },
    });

    const active = await call("/services?status=ACTIVE", { token: actor.token, company: co._id });
    const inactive = await call("/services?status=INACTIVE", { token: actor.token, company: co._id });
    const all = await call("/services", { token: actor.token, company: co._id });

    expect(active.body.services.map((s) => s.name)).toEqual(["Kept"]);
    expect(inactive.body.services.map((s) => s.name)).toEqual(["Dropped"]);
    expect(all.body.services).toHaveLength(2);
    expect(keep.body.service.status).toBe("ACTIVE");
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT THE FORM IS OFFERED
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("options offer only what this company may choose", () => {
  test("suppliers and expense heads are this company's", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const actor = await person({ co: a });
    await supplier({ co: a, name: "Mine" });
    await supplier({ co: b, name: "Theirs" });
    await ledger({ co: a, name: "My Repairs" });
    await ledger({ co: b, name: "Their Repairs" });

    const opts = await call("/services/options", { token: actor.token, company: a._id });

    expect(opts.body.suppliers.map((s) => s.name)).toEqual(["Mine"]);
    expect(opts.body.budgetHeads.map((h) => h.name)).toEqual(["My Repairs"]);
  });

  test("only expense heads are offered as budget heads", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    await ledger({ co, name: "Repairs", nature: "expense" });
    await ledger({ co, name: "Bank Account", nature: "asset" });
    await ledger({ co, name: "Sales", nature: "revenue" });

    const opts = await call("/services/options", { token: actor.token, company: co._id });

    expect(opts.body.budgetHeads.map((h) => h.name)).toEqual(["Repairs"]);
  });

  test("options carry a name and an id, not a supplier's bank details", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    await supplier({ co, name: "Otis" });

    const opts = await call("/services/options", { token: actor.token, company: co._id });

    expect(Object.keys(opts.body.suppliers[0]).sort()).toEqual(["code", "id", "name"]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SEARCH
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("the register can be searched the way a buyer thinks", () => {
  test("by name, category, SAC, supplier and budget head", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const v = await supplier({ co, name: "Otis Elevators" });
    const head = await ledger({ co, name: "Repairs & Maintenance" });
    await register(actor, co, {
      name: "Lift AMC", category: "Facilities", sacCode: "998719",
      preferredVendorId: String(v._id), budgetLedgerId: String(head._id),
    });
    await register(actor, co, { name: "Courier", category: "Logistics" });

    for (const term of ["lift", "facilities", "998719", "otis", "repairs"]) {
      const hit = await call(`/services?search=${encodeURIComponent(term)}`, {
        token: actor.token, company: co._id,
      });
      expect(hit.body.services.map((s) => s.name)).toEqual(["Lift AMC"]);
    }
  });

  test("a search term is text, not a pattern", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    await register(actor, co, { name: "Lift AMC" });

    const hit = await call("/services?search=.*", { token: actor.token, company: co._id });

    /* `.*` matches everything if the term is spliced into a regex unescaped. */
    expect(hit.body.services).toHaveLength(0);
  });

  test("searching cannot reach across companies", async () => {
    const [a, b] = [await company("Alpha"), await company("Beta")];
    const mine = await person({ co: a });
    const theirs = await person({ co: b });
    await register(theirs, b, { name: "Lift AMC" });

    const hit = await call("/services?search=lift", { token: mine.token, company: a._id });

    expect(hit.body.services).toHaveLength(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ABSENCE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════ */
describe("a service is not stock and cannot be made to look like it", () => {
  const STOCK_WORDS = [
    "quantity", "qty", "warehouse", "location", "variant", "variants",
    "barcode", "batch", "lot", "reorder", "minStock", "maxStock",
    "openingStock", "currentStock", "stockTransactions", "unitOfMeasure",
    "goodsReceipt", "grn",
  ];

  test("the model defines no inventory field", () => {
    const paths = Object.keys(Service.schema.paths).map((p) => p.toLowerCase());
    const found = STOCK_WORDS.filter((w) => paths.some((p) => p.includes(w.toLowerCase())));
    expect(found).toEqual([]);
  });

  test("the API returns no inventory field", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const keys = Object.keys(made.body.service).map((k) => k.toLowerCase());
    const found = STOCK_WORDS.filter((w) => keys.some((k) => k.includes(w.toLowerCase())));
    expect(found).toEqual([]);
  });

  test("inventory fields sent by a client are not stored", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });

    const made = await register(actor, co, {
      name: "Lift AMC", quantity: 40, warehouse: "Main", reorderLevel: 5, barcode: "123456",
    });

    expect(made.status).toBe(201);
    const stored = await Service.findById(made.body.service._id).lean();
    for (const k of ["quantity", "warehouse", "reorderLevel", "barcode"]) {
      expect(stored[k]).toBeUndefined();
    }
  });

  test("registering a service creates no stock record of any kind", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const before = await mongoose.connection.db.listCollections().toArray();

    await register(actor, co, { name: "Lift AMC" });

    const stockish = (await mongoose.connection.db.listCollections().toArray())
      .map((c) => c.name)
      .filter((n) => !before.some((b) => b.name === n))
      .filter((n) => /stock|ledger|movement|inventory|receipt/i.test(n));
    expect(stockish).toEqual([]);
  });

  test("a service exposes a stable id for a later Service Request to name", async () => {
    const co = await company("Alpha");
    const actor = await person({ co });
    const made = await register(actor, co, { name: "Lift AMC" });

    const edited = await call(`/services/${made.body.service._id}`, {
      method: "PATCH", token: actor.token, company: co._id, body: { name: "Lift AMC (revised)" },
    });

    /* Renaming must not re-identify the service: requests already point at it. */
    expect(edited.body.service._id).toBe(made.body.service._id);
    expect(edited.body.service.serviceCode).toBe(made.body.service.serviceCode);
  });
});
