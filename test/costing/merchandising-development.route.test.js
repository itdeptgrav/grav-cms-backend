// test/costing/merchandising-development.route.test.js
//
// MERCHANDISING OWNS THE DEVELOPMENT AND TOOLING REQUIREMENT.
//
// The claims worth holding are the ones that decide whether this door is
// narrow enough to open:
//
//   · Merchandising creates, edits and removes; the two halves of the shared
//     array never touch each other;
//   · Production's outside processes survive a Development save byte for byte,
//     and Development survives a Production save;
//   · R&D's sample submit writes neither any more;
//   · another company's style and another company's service are refused;
//   · no rate, supplier, quotation, amount or policy value is accepted or
//     returned, and no Journey identity appears anywhere;
//   · two requirements naming the same charge stay two rows;
//   · legacy rows stay readable and are never rewritten.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    const raw = req.headers["x-test-user"];
    if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
    req.user = JSON.parse(raw);
    next();
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Account = require("../../models/CMS_Models/Sales/Account");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

/* ── THE CATALOGUE IS APPROVED, NOT CONFIGURED ────────────────────────────
   What the company charges for its own development work is a Board policy
   with an effective date and an approver. Seeded through the same door the
   legacy migration uses, so the fixtures' keys — which the requirements below
   point at — survive rather than being minted anew. */
/* A declaration, not a `const`: `describe` bodies run while this module is
   still being evaluated, so a fixture they reach for has to be hoisted. */
async function approveCharges(companyId, charges, { effectiveFrom = new Date(Date.now() - 365 * 24 * 3600 * 1000) } = {}) {
  const boardPolicy = require("../../services/board/boardPolicy.service");
  const { adaptTable } = require("../../services/centralCosting/developmentCharges");
  const ctx = { companyId, actorId: "fixture", actorName: "Board Fixture" };
  const draft = await boardPolicy.createDraft(ctx, {
    policyKey: "DEVELOPMENT_CHARGE_POLICY",
    seed: adaptTable(charges),
    rationale: "Fixture catalogue.",
  });
  return boardPolicy.approve(ctx, draft._id, { effectiveFrom });
}

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, user } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

/** A company, a member, a style, one active service and two configured charges. */
async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Merch ${n}`, booksFromDate: new Date("2026-04-01") });
  const email = `merch-${n}@test.com`;
  const emp = await Employee.create({
    firstName: "M", lastName: `D${n}`, email, biometricId: `MD${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });

  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-MD-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-MD-${n}`, styleCode: `SC-MD-${n}`,
    productName: "Soumya Tshirt", journeyId: journey._id,
    materials: { status: "selected", rawItems: [] },
    techSheet: { status: "pending" },
  });

  const printing = await Service.create({
    companyId: co._id, name: `Screen printing ${n}`, serviceCode: `PRT-${n}`,
    billingUnit: "Screen", status: "ACTIVE",
  });

  /* Two charges: one flat for the run, one per unit. Amounts exist in the
     policy and must never reach a Merchandising response. */
  await approveCharges(co._id, [
    {
      key: "pattern-development", label: "Pattern development", active: true,
      calculation: "FLAT_PER_RUN",
      rates: [{ amountMinor: 500000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
    },
    {
      key: "screen-making", label: "Screen making", active: true,
      calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
      rates: [{ amountMinor: 200000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
    },
  ]);

  /* ── A MERCHANDISING SEAT, BECAUSE THESE ARE MERCHANDISING DOORS ─────
     The development and packaging-selection routes now prove a LIVE
     `merchandiser` department grant as well as a Sales session: a Sales seat
     is authority over customers and quotations, not over stating what
     development a style needs. Owner, so this fixture can both state and
     decide; the editor/approver split has its own tests in
     test/merchandising/merchandising-authorisation.route.test.js. */
  await DepartmentRole.create({
    departmentSlug: "merchandiser", email, name: "M", role: "owner", isActive: true,
    departmentId: new mongoose.Types.ObjectId(),
  });

  return { co, emp, style, printing, n, user: { id: String(emp._id), email, name: "M", role: "sales" } };
}

const dev = (w, path = "") => `/merchandising/styles/${w.style._id}/development${path}`;
const put = (w, development) => call(dev(w), { method: "PUT", user: w.user, body: { development } });

/** An outside process written the way Production's own door writes one. */
const outsideProcess = (serviceId, rowId = "op-row-1") => ({
  rowId, purpose: "OUTSIDE_PROCESS", serviceId,
  serviceCode: "WSH-1", serviceName: "Enzyme wash",
  specification: "Two cycles", quantity: 1, billingUnit: "Piece",
  basis: "PER_GARMENT", owner: "PRODUCTION", included: true, notes: "",
});

/* ══ MERCHANDISING DOES THE WORK ═══════════════════════════════════════════ */

describe("Merchandising records the development requirement", () => {
  test("records internal work by charge key, and external work by service", async () => {
    const w = await world();
    const res = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development", specification: "Base size 40" },
      { developmentSource: "SUPPLIER_QUOTATION", serviceId: String(w.printing._id), specification: "Body and sleeve", quantity: 4 },
    ]);

    expect(res.status).toBe(200);
    expect(res.body.development).toHaveLength(2);

    const [internal, external] = res.body.development;
    expect(internal.developmentSource).toBe("COMPANY_POLICY");
    expect(internal.developmentChargeKey).toBe("pattern-development");
    /* Resolved live for display and never stored. */
    expect(internal.chargeLabel).toBe("Pattern development");
    expect(internal.gaps).toEqual([]);

    expect(external.developmentSource).toBe("SUPPLIER_QUOTATION");
    /* Identity re-read from the register, never taken from the body. */
    expect(external.serviceName).toBe(w.printing.name);
    expect(external.serviceCode).toBe(`PRT-${w.n}`);
    expect(external.gaps).toEqual([]);

    /* Stored where costing already reads it, one-time by definition. */
    const stored = await SampleStyle.findById(w.style._id).lean();
    const rows = stored.sample.serviceRequirements;
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.purpose).toBe("DEVELOPMENT_TOOLING");
      expect(r.basis).toBe("FIXED_PER_RUN");
    }
  });

  test("a per-unit charge needs a count; a flat one is not asked for one", async () => {
    const w = await world();
    const refused = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making" },
    ]);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/charged per Screen. Say how many/);

    const ok = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 4 },
    ]);
    expect(ok.status).toBe(200);
    expect(ok.body.development[0].quantity).toBe(4);
    /* The unit comes from the charge, never typed. */
    expect(ok.body.development[0].unit).toBe("Screen");
  });

  test("edits keep their row id, and two rows naming one charge stay two", async () => {
    const w = await world();
    const first = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 4, specification: "Body" },
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 2, specification: "Sleeve" },
    ]);
    expect(first.status).toBe(200);
    const [body, sleeve] = first.body.development;
    /* Screens for the body and screens for the sleeve are two requirements.
       Keyed by what they name they would be one, and one would be lost. */
    expect(body.rowId).not.toBe(sleeve.rowId);

    const second = await put(w, [
      { rowId: body.rowId, developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 6, specification: "Body" },
      { rowId: sleeve.rowId, developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 2, specification: "Sleeve" },
    ]);
    expect(second.body.development.map((r) => r.rowId)).toEqual([body.rowId, sleeve.rowId]);
    expect(second.body.development[0].quantity).toBe(6);
  });

  test("removing is sending a shorter list", async () => {
    const w = await world();
    await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" },
      { developmentSource: "SUPPLIER_QUOTATION", serviceId: String(w.printing._id) },
    ]);
    const res = await put(w, [{ developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" }]);
    expect(res.body.development).toHaveLength(1);
    expect(res.body.development[0].developmentChargeKey).toBe("pattern-development");
  });

  test("not applicable is a decision, and a decision needs a reason", async () => {
    const w = await world();
    const bare = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development", included: false },
    ]);
    expect(bare.status).toBe(400);
    expect(bare.body.message).toMatch(/Say why/);

    const ok = await put(w, [{
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
      included: false, excludedReason: "The buyer supplies the pattern.",
    }]);
    expect(ok.status).toBe(200);
    expect(ok.body.development[0].included).toBe(false);
    expect(ok.body.development[0].excludedReason).toBe("The buyer supplies the pattern.");
    /* An excluded row is answered, not outstanding. */
    expect(ok.body.development[0].gaps).toEqual([]);
  });

  test("one source, never two", async () => {
    const w = await world();
    const both = await put(w, [{
      developmentSource: "SUPPLIER_QUOTATION", serviceId: String(w.printing._id),
      developmentChargeKey: "screen-making",
    }]);
    expect(both.status).toBe(400);
    expect(both.body.message).toMatch(/one or the other/);
  });
});

/* ══ THE TWO HALVES OF ONE ARRAY NEVER TOUCH ═══════════════════════════════ */

describe("the shared array keeps both owners' rows", () => {
  test("a Development save preserves Production's outside processes byte for byte", async () => {
    const w = await world();
    const wash = await Service.create({
      companyId: w.co._id, name: "Enzyme wash", serviceCode: `WSH-${w.n}`,
      billingUnit: "Piece", status: "ACTIVE",
    });
    await SampleStyle.updateOne(
      { _id: w.style._id },
      { $set: { "sample.serviceRequirements": [outsideProcess(wash._id)] } },
    );
    const before = (await SampleStyle.findById(w.style._id).lean())
      .sample.serviceRequirements.find((r) => r.purpose === "OUTSIDE_PROCESS");

    const res = await put(w, [
      { developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" },
    ]);
    expect(res.status).toBe(200);
    /* The Development read shows only Development. */
    expect(res.body.development).toHaveLength(1);

    const after = (await SampleStyle.findById(w.style._id).lean()).sample.serviceRequirements;
    expect(after).toHaveLength(2);
    const kept = after.find((r) => r.purpose === "OUTSIDE_PROCESS");
    /* Carried through as the STORED object — not rebuilt, not re-validated. */
    expect(JSON.stringify(kept)).toBe(JSON.stringify(before));
  });

  test("a Production outside-process save preserves Development", async () => {
    const w = await world();
    await put(w, [{ developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" }]);
    const before = (await SampleStyle.findById(w.style._id).lean())
      .sample.serviceRequirements.find((r) => r.purpose === "DEVELOPMENT_TOOLING");

    const styleRoute = require("../../services/production/styleRoute.service");
    await styleRoute.saveOutsideProcesses({ companyId: w.co._id }, {
      styleId: String(w.style._id),
      outsideProcesses: [{
        serviceId: String(w.printing._id), specification: "Wash",
        quantity: 1, billingUnit: "Piece", basis: "PER_GARMENT",
      }],
    });

    const after = (await SampleStyle.findById(w.style._id).lean()).sample.serviceRequirements;
    const kept = after.find((r) => r.purpose === "DEVELOPMENT_TOOLING");
    expect(JSON.stringify(kept)).toBe(JSON.stringify(before));
    expect(after.filter((r) => r.purpose === "OUTSIDE_PROCESS")).toHaveLength(1);
  });

  test("Production's door cannot write a development row", async () => {
    const w = await world();
    const styleRoute = require("../../services/production/styleRoute.service");

    await expect(styleRoute.saveOutsideProcesses({ companyId: w.co._id }, {
      styleId: String(w.style._id),
      outsideProcesses: [{
        serviceId: String(w.printing._id),
        purpose: "DEVELOPMENT_TOOLING",
      }],
    })).rejects.toMatchObject({ code: "FIELD_NOT_ACCEPTED" });
  });

  test("R&D's sample submit writes neither half", async () => {
    const w = await world();
    await put(w, [{ developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" }]);
    const before = (await SampleStyle.findById(w.style._id).lean()).sample.serviceRequirements;

    /* The submit is refused for its own reasons on a style with no sample
       work; what matters is that whatever it does, it does not touch this
       array. Asserted on the stored document rather than on the response. */
    await call(`/${w.style._id}/sample`, {
      method: "POST", user: w.user,
      body: { action: "submit", serviceRequirements: [] },
    });
    const after = (await SampleStyle.findById(w.style._id).lean()).sample.serviceRequirements;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });
});

/* ══ NOTHING COMMERCIAL, AND NO JOURNEY ════════════════════════════════════ */

describe("what may not cross this boundary", () => {
  const MONEY = [
    { field: "price", value: 100 }, { field: "rate", value: 5 },
    { field: "amountMinor", value: 200000 }, { field: "supplierId", value: "x" },
    { field: "quotationReference", value: "Q-1" }, { field: "margin", value: 12 },
    { field: "gstRatePercent", value: 18 }, { field: "minimumMarginPercent", value: 20 },
  ];

  test.each(MONEY)("a body carrying $field is refused by name", async ({ field, value }) => {
    const w = await world();
    const res = await put(w, [{
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
      [field]: value,
    }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FIELD_NOT_ACCEPTED");
    expect(res.body.details.field).toBe(field);
  });

  test("a Journey field is refused, and none is ever returned", async () => {
    const w = await world();
    const res = await put(w, [{
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
      journeyId: String(w.style.journeyId),
    }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("FIELD_NOT_ACCEPTED");

    await put(w, [{ developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" }]);
    const read = await call(dev(w), { user: w.user });
    const serialised = JSON.stringify(read.body);
    expect(serialised).not.toMatch(new RegExp(String(w.style.journeyId)));
    expect(serialised).not.toMatch(/journey|enquiry|customer/i);
    /* And nobody is sent to the costing app. */
    expect(serialised).not.toMatch(/\/costing/);
  });

  test("no charge AMOUNT reaches the screen, only the key, label and unit", async () => {
    const w = await world();
    const read = await call(dev(w), { user: w.user });
    expect(read.status).toBe(200);
    expect(read.body.charges.map((c) => c.key).sort())
      .toEqual(["pattern-development", "screen-making"]);
    const serialised = JSON.stringify(read.body.charges);
    /* The policy holds 500000 and 200000 minor units. Neither may appear. */
    expect(serialised).not.toMatch(/500000|200000/);
    expect(serialised).not.toMatch(/amountMinor|rates|currency/i);
    for (const c of read.body.charges) {
      expect(c.amountMinor).toBeUndefined();
      expect(c.rates).toBeUndefined();
    }
  });

  test("packaging, materials and the route cannot be reached from here", async () => {
    const w = await world();
    for (const field of ["packagingRequirements", "packagingSelections", "materials", "operations"]) {
      const res = await put(w, [{
        developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
        [field]: [],
      }]);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("FIELD_NOT_ACCEPTED");
    }
  });
});

/* ══ SCOPE ═════════════════════════════════════════════════════════════════ */

describe("company scope", () => {
  test("another company's style is NOT FOUND", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await call(`/merchandising/styles/${theirs.style._id}/development`, { user: mine.user });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(new RegExp(theirs.style.styleCode));
  });

  test("another company's service is refused", async () => {
    const mine = await world();
    const theirs = await world();
    const res = await put(mine, [{
      developmentSource: "SUPPLIER_QUOTATION", serviceId: String(theirs.printing._id),
    }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SERVICE_NOT_REGISTERED");
  });

  test("a charge this company has not configured is refused", async () => {
    const w = await world();
    const res = await put(w, [{
      developmentSource: "COMPANY_POLICY", developmentChargeKey: "moulding",
    }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("DEVELOPMENT_CHARGE_NOT_CONFIGURED");
  });

  test("an inactive service is refused", async () => {
    const w = await world();
    await Service.updateOne({ _id: w.printing._id }, { $set: { status: "INACTIVE" } });
    const res = await put(w, [{
      developmentSource: "SUPPLIER_QUOTATION", serviceId: String(w.printing._id),
    }]);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SERVICE_NOT_REGISTERED");
  });
});

/* ══ LEGACY ════════════════════════════════════════════════════════════════ */

describe("legacy rows", () => {
  test("a row written before rowId existed stays readable and is marked", async () => {
    const w = await world();
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.serviceRequirements": [{
          purpose: "DEVELOPMENT_TOOLING", developmentSource: "COMPANY_POLICY",
          developmentChargeKey: "pattern-development", specification: "Old row",
          basis: "FIXED_PER_RUN", included: true,
        }],
      },
    });
    const read = await call(dev(w), { user: w.user });
    expect(read.status).toBe(200);
    expect(read.body.development).toHaveLength(1);
    expect(read.body.development[0].legacy).toBe(true);
    expect(read.body.development[0].specification).toBe("Old row");
    /* Nothing migrated it, and nothing minted it an id behind a read. */
    const stored = await SampleStyle.findById(w.style._id).lean();
    expect(stored.sample.serviceRequirements[0].rowId).toBeUndefined();
  });

  test("a retired charge is named rather than silently dropped", async () => {
    const w = await world();
    await put(w, [{ developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 2 }]);
    /* Withdrawn the way the Board withdraws one: a NEW approved catalogue,
       in force from today, with the charge deactivated rather than removed. */
    await approveCharges(w.co._id, [
      {
        key: "pattern-development", label: "Pattern development", active: true,
        calculation: "FLAT_PER_RUN",
        rates: [{ amountMinor: 500000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
      },
      {
        key: "screen-making", label: "Screen making", active: false,
        calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
        rates: [{ amountMinor: 200000, currency: "INR", effectiveFrom: new Date("2026-01-01") }],
      },
    ], { effectiveFrom: new Date() });
    const read = await call(dev(w), { user: w.user });
    const row = read.body.development[0];
    expect(row.developmentChargeKey).toBe("screen-making");
    expect(row.gaps.map((g) => g.field)).toContain("developmentChargeKey");
    expect(row.gaps[0].message).toMatch(/no longer a charge/);
  });
});
