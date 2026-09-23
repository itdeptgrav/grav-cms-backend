// test/costing/costing-supplier-data-gate.test.js
//
// Central Costing — Chunk 3A. THE PREREQUISITE GATE.
//
// Chunk 3 will attach confidential supplier quotations and item prices to
// costings. Before that happens this proves the four things that make it safe:
// supplier and item facts are company-scoped, units are not public, an enquiry
// used as costing context belongs to the same company, and reading Store facts
// does not hand Store the margin.
//
// It deliberately proves NOTHING about supplier offers — that model does not
// exist yet, and building it here would be starting Chunk 3.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Unit = require("../../models/CMS_Models/Inventory/Configurations/Unit");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

const storeFacts = require("../../services/centralCosting/storeFacts.service");
const costingCompanyContext = require("../../services/centralCosting/companyContext.service");
const costingCaps = require("../../services/centralCosting/capabilities");
const { CAPABILITIES } = costingCaps;
const { ownershipFieldsFor } = require("../../services/companyContext/ownershipStamp.service");

let vendorSrv, itemSrv, unitSrv, seq = 0;

beforeAll(async () => {
  /* Each router gets its own app, mounted at the root, so a test path is the
     router's own path and nothing depends on remembering a prefix. */
  const mount = (router) => {
    const app = express();
    app.use(express.json());
    app.use("/", require(router));
    return new Promise((r) => { const s = app.listen(0, () => r(s)); });
  };
  vendorSrv = await mount("../../routes/CMS_Routes/Inventory/Vendor-Buyer/vendor");
  itemSrv = await mount("../../routes/CMS_Routes/Inventory/Products/rawItems");
  unitSrv = await mount("../../routes/CMS_Routes/Inventory/Configurations/units");
});
afterAll(async () => {
  for (const s of [vendorSrv, itemSrv, unitSrv]) await new Promise((r) => s.close(r));
});

const url = (srv, p) => `http://127.0.0.1:${srv.address().port}${p}`;

const call = (srv, path_, { method = "GET", body, token, company, idempotencyKey } = {}) =>
  fetch(url(srv, path_), {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return { status: r.status, body: parsed };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function storeUser({ companies = [], role = "approver" } = {}) {
  const n = ++seq;
  const email = `gate${n}@test.example`;
  const emp = await Employee.create({
    firstName: "S", lastName: `L${n}`, email, biometricId: `GT${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DepartmentRole.create({ departmentSlug: "store", email, role, isActive: true });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "S" });
  }
  return {
    email, emp,
    token: jwt.sign(
      { id: String(emp._id), email, name: "S", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

async function salesUser({ companies = [], admin = false } = {}) {
  const n = ++seq;
  const email = `sales${n}@test.example`;
  const emp = await Employee.create({
    firstName: "Q", lastName: `L${n}`, email, biometricId: `SL${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (admin) {
    await DeptUser.create({
      name: "Q", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "Q" });
  }
  return { email, emp, user: { id: String(emp._id), email, name: "Q" } };
}

const supplier = (co, name) =>
  Vendor.create({ ...(co ? { companyId: co._id } : {}), companyName: `${name} ${++seq}`, gstNumber: `GST${seq}` });

const item = async (co, name, aliasVendor = null) => {
  const n = ++seq;
  const vendor = aliasVendor || (await supplier(co, "Alias supplier"));
  return RawItem.create({
    ...(co ? { companyId: co._id } : {}),
    name: `${name} ${n}`, sku: `ITEM-${n}`, unit: "m", category: "Fabric",
    variants: [{
      name: "Navy", sku: `SKU-${n}`, unit: "m",
      vendorNicknames: [{ vendor: vendor._id, nickname: "Acme code A1", price: 412.5, deliveryDays: 7 }],
    }],
  });
};

const unit = (co, name) => Unit.create({ ...(co ? { companyId: co._id } : {}), name: `${name}-${++seq}` });

/* ═══ 1 · SUPPLIER AND ITEM FACTS ARE COMPANY-SCOPED ═════════════════════ */

describe("supplier and item facts", () => {
  test("another company's suppliers are neither listed nor readable", async () => {
    const a = await company("SupA");
    const b = await company("SupB");
    const mine = await storeUser({ companies: [a] });
    const theirs = await supplier(b, "Theirs");
    await supplier(a, "Mine");

    const list = await call(vendorSrv, "/", { token: mine.token, company: a._id });
    expect(list.status).toBe(200);
    const names = JSON.stringify(list.body);
    expect(names).toContain("Mine");
    expect(names).not.toContain("Theirs");

    /* Foreign and missing are the same answer. */
    const foreign = await call(vendorSrv, `/${theirs._id}`, { token: mine.token, company: a._id });
    const missing = await call(vendorSrv, `/${new mongoose.Types.ObjectId()}`, { token: mine.token, company: a._id });
    expect(foreign.status).toBe(404);
    expect(foreign.status).toBe(missing.status);
  });

  test("another company's item and variant commercial data is unreachable", async () => {
    const a = await company("ItemA");
    const b = await company("ItemB");
    const mine = await storeUser({ companies: [a] });
    const theirs = await item(b, "Their fabric");

    const detail = await call(itemSrv, `/${theirs._id}`, { token: mine.token, company: a._id });
    expect(detail.status).toBe(404);
    /* The alias price is the commercial fact Chunk 3 will consume. */
    expect(JSON.stringify(detail.body)).not.toContain("412.5");
  });

  test("a legacy-global record is absent from a company list and cannot be edited through it", async () => {
    const a = await company("LegacyItems");
    const mine = await storeUser({ companies: [a] });
    const orphan = await item(null, "Unowned fabric");

    const list = await call(itemSrv, "/", { token: mine.token, company: a._id });
    expect(JSON.stringify(list.body)).not.toContain("Unowned fabric");

    const edit = await call(itemSrv, `/${orphan._id}`, {
      method: "PUT", token: mine.token, company: a._id, body: { name: "Claimed" },
    });
    expect(edit.status).toBeGreaterThanOrEqual(400);
    const after = await RawItem.findById(orphan._id).lean();
    expect(after.name).toBe(orphan.name);
    expect(after.companyId ?? null).toBeNull();
  });

  test("a body-supplied company is ignored or refused, never honoured", async () => {
    /* THE TAMPERING TEST: the browser naming somebody else's company. */
    const a = await company("TamperA");
    const b = await company("TamperB");
    const mine = await storeUser({ companies: [a] });

    const r = await call(vendorSrv, "/", {
      method: "POST", token: mine.token, company: a._id, idempotencyKey: `gate-${++seq}`,
      body: { companyName: "Tampered supplier", companyId: String(b._id), company: String(b._id) },
    });

    if (r.status < 400) {
      const created = await Vendor.findOne({ companyName: "Tampered supplier" }).lean();
      expect(String(created.companyId)).toBe(String(a._id));
      expect(String(created.companyId)).not.toBe(String(b._id));
    } else {
      expect(await Vendor.countDocuments({ companyId: b._id })).toBe(0);
    }
  });
});

/* ═══ 2 · UNITS ═════════════════════════════════════════════════════════ */

describe("units and conversions", () => {
  test("the units endpoint is no longer open to anyone", async () => {
    /* Chunk 0 recorded this router as answering every request, signed in or
       not, including writes. */
    for (const [path_, opts] of [
      ["/", {}],
      ["/", { method: "POST", body: { name: "Anonymous" } }],
    ]) {
      const r = await call(unitSrv, path_, opts);
      expect(r.status).toBe(401);
    }
    expect(await Unit.countDocuments({ name: "Anonymous" })).toBe(0);
  });

  test("an unowned unit is not treated as a shared global standard", async () => {
    /* There is no global-unit concept in the model, and absence of a company
       is NOT it: an unowned unit is legacy, excluded from company lists, and
       reachable only through the explicit legacy mode. */
    const a = await company("UnitCo");
    const mine = await storeUser({ companies: [a] });
    const orphan = await unit(null, "LegacyMetre");
    await unit(a, "Metre");

    const list = await call(unitSrv, "/", { token: mine.token, company: a._id });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain("Metre");
    expect(JSON.stringify(list.body)).not.toContain("LegacyMetre");

    const detail = await call(unitSrv, `/${orphan._id}`, { token: mine.token, company: a._id });
    expect(detail.status).toBe(404);
  });
});

/* ═══ 3 · THE COSTING SERVICE READ BOUNDARY ═════════════════════════════ */

describe("costing reads Store facts through one narrow door", () => {
  const svc = (co) => costingCompanyContext.forService({ companyId: co._id, reason: "chunk 3A test" });

  test("a service context reads only its own company's facts", async () => {
    const a = await company("SvcA");
    const b = await company("SvcB");
    const mineItem = await item(a, "My fabric");
    const theirItem = await item(b, "Their fabric");
    const mineSupplier = await supplier(a, "My supplier");
    const theirSupplier = await supplier(b, "Their supplier");

    expect((await storeFacts.itemFacts(svc(a), mineItem._id)).name).toContain("My fabric");
    expect(await storeFacts.itemFacts(svc(a), theirItem._id)).toBeNull();
    expect((await storeFacts.supplierIdentity(svc(a), mineSupplier._id)).name).toContain("My supplier");
    expect(await storeFacts.supplierIdentity(svc(a), theirSupplier._id)).toBeNull();
  });

  test("a read with no company, or no stated reason, is refused outright", async () => {
    const a = await company("SvcGuard");
    const it = await item(a, "Fabric");
    await expect(storeFacts.itemFacts({}, it._id)).rejects.toMatchObject({ code: "TENANT_MEMBERSHIP_UNPROVEN" });
    await expect(storeFacts.itemFacts({ companyId: a._id }, it._id)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  test("the legacy alias price comes back labelled provisional, never verified", async () => {
    const a = await company("Alias");
    const it = await item(a, "Fabric");
    const facts = await storeFacts.itemFacts(svc(a), it._id);
    const alias = facts.variants[0].aliasPrices[0];
    expect(alias.priceMajor).toBe(412.5);
    expect(alias.confidence).toBe("PROVISIONAL");
    expect(alias.evidence).toBe("LEGACY_ALIAS_FIELD");
    expect(facts.purchaseUom).toBe("m");

    /* ── A GAP REPORTED, NOT PAPERED OVER ──────────────────────────────
       RawItem carries no HSN code and no GST rate at all, and a supplier offer
       needs both. Empty strings would read as "this item has no HSN" — untrue,
       and a costing would later treat it as zero-rated. The boundary says so
       instead, and it is recorded as an open Chunk 3 dependency. */
    expect(facts.tax.available).toBe(false);
    expect(facts.tax.reason).toBe("NOT_MODELLED_ON_RAW_ITEM");
    expect(facts.tax.hsnCode).toBeNull();
  });

  test("a foreign supplier reference on a local item is omitted, price and all", async () => {
    /* ── PROVING THE ITEM'S COMPANY IS NOT PROVING ITS REFERENCES' ──────
       The item is ours; the supplier it points at is not. Returning the id
       discloses that another company's supplier exists and attaches a price to
       it — and Chunk 3 will turn exactly these references into quotations. */
    const a = await company("RefA");
    const b = await company("RefB");
    const theirSupplier = await supplier(b, "Their supplier");
    const ourSupplier = await supplier(a, "Our supplier");

    const it = await item(a, "Fabric", ourSupplier);
    await RawItem.updateOne({ _id: it._id }, {
      $set: {
        primaryVendor: theirSupplier._id,
        alternateVendors: [theirSupplier._id, ourSupplier._id],
      },
      $push: {
        "variants.0.vendorNicknames": {
          vendor: theirSupplier._id, nickname: "Their code", price: 999.99, deliveryDays: 2,
        },
      },
    });

    const facts = await storeFacts.itemFacts(svc(a), it._id);

    /* Omitted, not nulled with an explanation: saying "there is a supplier
       here you may not see" is still saying it exists. */
    expect(facts.primarySupplierId).toBeNull();
    expect(facts.alternateSupplierIds).toEqual([String(ourSupplier._id)]);
    expect(facts.variants[0].aliasPrices).toHaveLength(1);
    expect(facts.variants[0].aliasPrices[0].supplierId).toBe(String(ourSupplier._id));

    const payload = JSON.stringify(facts);
    expect(payload).not.toContain(String(theirSupplier._id));
    expect(payload).not.toContain("999.99");
    expect(payload).not.toContain("Their code");
  });

  test("same-company supplier references still come back intact", async () => {
    const a = await company("RefOk");
    const ourSupplier = await supplier(a, "Our supplier");
    const it = await item(a, "Fabric", ourSupplier);
    await RawItem.updateOne({ _id: it._id }, {
      $set: { primaryVendor: ourSupplier._id, alternateVendors: [ourSupplier._id] },
    });

    const facts = await storeFacts.itemFacts(svc(a), it._id);
    expect(facts.primarySupplierId).toBe(String(ourSupplier._id));
    expect(facts.alternateSupplierIds).toEqual([String(ourSupplier._id)]);
    expect(facts.variants[0].aliasPrices[0]).toMatchObject({
      supplierId: String(ourSupplier._id), priceMajor: 412.5,
      confidence: "PROVISIONAL", evidence: "LEGACY_ALIAS_FIELD",
    });
  });

  test("a conversion pointing at another company's unit is dropped, not returned", async () => {
    const a = await company("ConvA");
    const b = await company("ConvB");
    const metre = await unit(a, "Metre");
    const mineCm = await unit(a, "Centimetre");
    const theirs = await unit(b, "Foreign");
    await Unit.updateOne({ _id: metre._id }, {
      $set: { conversions: [{ toUnit: mineCm._id, quantity: 100 }, { toUnit: theirs._id, quantity: 3.28 }] },
    });

    const facts = await storeFacts.unitFacts(svc(a), metre._id);
    expect(facts.conversions).toHaveLength(1);
    expect(String(facts.conversions[0].toUnitId)).toBe(String(mineCm._id));
    expect(facts.conversions[0]).toMatchObject({ toUnitName: mineCm.name, factor: 100 });
    expect(JSON.stringify(facts)).not.toContain("3.28");
  });
});

/* ═══ 4 · THE COSTING / STORE PERMISSION BOUNDARY ═══════════════════════ */

describe("Store authority is not costing authority", () => {
  test("a Store sourcing grant reveals no costing capability at all", async () => {
    const resolved = costingCaps.capabilitiesFromGrants(
      [{ departmentSlug: "store", role: "owner" }], false,
    );
    expect(resolved.capabilities).toEqual([]);
    for (const cap of [CAPABILITIES.MARGIN_READ, CAPABILITIES.POLICY_MANAGE, CAPABILITIES.APPROVE]) {
      expect(resolved.capabilities).not.toContain(cap);
    }
  });

  test("costing.draft.write implies costing.cost.read — and nothing else", async () => {
    /* A person cannot professionally edit a costing while being unable to read
       the inputs they are editing. Resolved centrally, so no screen has to
       grant itself anything. */
    const implied = costingCaps.applyImplications(new Set([CAPABILITIES.DRAFT_WRITE]));
    expect(implied).toContain(CAPABILITIES.COST_READ);
    for (const cap of [CAPABILITIES.MARGIN_READ, CAPABILITIES.APPROVE, CAPABILITIES.POLICY_MANAGE]) {
      expect(implied).not.toContain(cap);
    }
    /* And the implication does not run backwards. */
    expect(costingCaps.applyImplications(new Set([CAPABILITIES.COST_READ])))
      .not.toContain(CAPABILITIES.DRAFT_WRITE);
  });

  test("Sales still receives approved output, and no supplier data", () => {
    /* Sales also holds `costing.prepare` from `editor` upward — the right to
       ASK for an estimate. It is not a reading grant: what this test exists to
       protect is that Store's supplier data never reaches Sales, and that is
       decided by `cost.read`, which Sales still does not have. */
    const caps = costingCaps.capabilitiesFromGrants(
      [{ departmentSlug: "sales", role: "owner" }], false,
    ).capabilities;
    expect(caps).toContain(CAPABILITIES.OUTPUT_READ);
    expect(caps).not.toContain(CAPABILITIES.COST_READ);
    expect(caps).not.toContain(CAPABILITIES.MARGIN_READ);
    expect(caps).not.toContain(CAPABILITIES.DRAFT_WRITE);
  });
});

/* ═══ 5 · ENQUIRY OWNERSHIP ════════════════════════════════════════════ */

describe("enquiry company ownership", () => {
  test("ownership is resolved from the actor's membership, never from the request", async () => {
    const a = await company("EnqOwn");
    const who = await salesUser({ companies: [a] });

    const fields = await ownershipFieldsFor(who.user);
    expect(String(fields.companyId)).toBe(String(a._id));
    expect(fields.companyOwnership.proven).toBe(true);
    expect(fields.companyOwnership.source).toBe("MEMBERSHIP_RECORD");
  });

  test("a single-company deployment stamps ownership without a membership row", async () => {
    const only = await company("EnqSolo");
    const who = await salesUser({ companies: [] });
    const fields = await ownershipFieldsFor(who.user);
    expect(String(fields.companyId)).toBe(String(only._id));
    /* Recorded as the weaker statement it is. */
    expect(fields.companyOwnership.proven).toBe(false);
    expect(fields.companyOwnership.source).toBe("SINGLE_COMPANY_DEPLOYMENT");
  });

  test("an ambiguous actor is REFUSED, not given an unowned enquiry", async () => {
    /* ── THE POLICY THIS TEST USED TO ENCODE ────────────────────────────
       It expected `companyId: null` and creation to continue. That is failing
       open: an unowned enquiry is a confidential commercial record belonging
       to nobody, and every future consumer then has to remember that "no
       company" means "not mine". Ownership is proven or the record is not
       created. */
    const a = await company("EnqAmbA");
    const b = await company("EnqAmbB");
    const who = await salesUser({ companies: [a, b] });

    await expect(ownershipFieldsFor(who.user)).rejects.toMatchObject({
      code: "COMPANY_SELECTION_REQUIRED", status: 409,
    });
  });

  test("no provable membership in a multi-company deployment is refused", async () => {
    await company("EnqNoneA");
    await company("EnqNoneB");
    const who = await salesUser({ companies: [] });
    await expect(ownershipFieldsFor(who.user)).rejects.toMatchObject({
      code: "TENANT_MEMBERSHIP_UNPROVEN", status: 403,
    });
  });

  test("a company-context lookup failure is a 503, not a membership answer", async () => {
    /* Collapsing every resolver failure into NO_MEMBERSHIP turned an outage
       into "ask an administrator for access" — unfixable advice for a problem
       that fixes itself. */
    const a = await company("EnqOutage");
    const who = await salesUser({ companies: [a] });
    jest.spyOn(SpCompanyMembership, "find").mockImplementation(() => { throw new Error("db down"); });
    await expect(ownershipFieldsFor(who.user)).rejects.toMatchObject({
      code: "COMPANY_CONTEXT_UNAVAILABLE", status: 503,
    });
    jest.restoreAllMocks();
  });

  test("an unauthenticated actor cannot create ownership at all", async () => {
    await expect(ownershipFieldsFor(null)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(ownershipFieldsFor({})).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
  });

  test("the backfill script exists, defaults to a dry run, and refuses a multi-company database", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "../../scripts/migrations/backfill-enquiry-company.js"), "utf8",
    );
    expect(src).toContain("--apply");
    expect(src).toContain("companies.length !== 1");
    expect(src).toMatch(/DRY RUN/);
  });
});
