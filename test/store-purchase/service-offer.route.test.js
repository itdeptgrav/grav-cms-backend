// test/store-purchase/service-offer.route.test.js
//
// Store & Purchase — THE SERVICE QUOTATION REGISTER, THROUGH THE ROUTES THE
// SCREEN ACTUALLY CALLS.
//
// ── WHY THIS SUITE IS SEPARATE FROM THE COSTING ONE ─────────────────────────
// The costing suite proves a quotation PRICES a costing. This proves Store can
// produce one at all: create a draft, publish it, revise it into a successor,
// withdraw it with a reason, and read the chain afterwards. Without that the
// register is a table nobody can fill in, and outside services still have no
// source in practice however good the calculation path is.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const ServiceSupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/ServiceSupplierOffer");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/service-offers", require("../../routes/CMS_Routes/Inventory/Sourcing/serviceOffers"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/inventory/service-offers`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, company, idempotencyKey } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Sp-Company": String(company) } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

const newKey = () => `svco-${++seq}-${Math.random().toString(36).slice(2)}`;

async function world(name = "Svc") {
  const co = await Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });
  const n = ++seq;
  const email = `svco-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `SV${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  const token = jwt.sign(
    { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
    process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
  );

  const supplier = await Vendor.create({
    companyId: co._id, companyName: `Wash House ${n}`, vendorType: "Supplier", status: "Active",
  });
  const service = await Service.create({
    companyId: co._id, serviceCode: `SVC-${n}`, name: `Garment Wash ${n}`,
    billingUnit: "Piece", sacCode: "998821",
    /* Present, and never used to cost anything — see the costing suite. */
    defaultRate: 99, status: "ACTIVE",
  });
  return { co, token, supplier, service };
}

const draftBody = (w, over = {}) => ({
  supplierId: String(w.supplier._id),
  serviceId: String(w.service._id),
  billingUnit: "Piece",
  currency: "INR",
  unitPriceMinor: 800,
  priceBasis: "TAX_EXCLUSIVE",
  gstRatePercent: 18,
  quotationReference: `Q-${++seq}`,
  ...over,
});

/* ═══ 1 · THE WHOLE LIFECYCLE, THROUGH THE ROUTES THE SCREEN CALLS ════════ */

describe("Store can record a service quotation and move it through its life", () => {
  test("create, publish, revise and withdraw", async () => {
    const w = await world();

    /* ── A DRAFT IS NOT A PRICE ────────────────────────────────────────── */
    const made = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, {
        minimumChargeMinor: 500000, minQuantity: 100, orderMultiple: 50, leadTimeDays: 7,
        sacCode: "998821", quotationDate: "2026-02-01",
        tiers: [{ minQuantity: 1, maxQuantity: 999, unitPriceMinor: 800 }, { minQuantity: 1000, unitPriceMinor: 650 }],
        document: { label: "Q-118.pdf", url: "https://drive.example/q118", storedAt: "Shared drive" },
      }),
    });
    expect(made.status).toBe(201);
    expect(made.body.offer.status).toBe("DRAFT");
    expect(made.body.offer.revision).toBe(1);
    /* Everything the form collects comes back, so the screen can render the
       record it just wrote rather than what it hoped it wrote. */
    expect(made.body.offer.minimumChargeMinor).toBe(500000);
    expect(made.body.offer.minQuantity).toBe(100);
    expect(made.body.offer.leadTimeDays).toBe(7);
    expect(made.body.offer.tiers).toHaveLength(2);
    expect(made.body.offer.document.label).toBe("Q-118.pdf");
    /* The supplier and the service are snapshotted from the masters, not from
       the request — the body named neither by name. */
    expect(made.body.offer.supplierName).toMatch(/^Wash House/);
    expect(made.body.offer.serviceName).toMatch(/^Garment Wash/);
    const id = made.body.offer.id;

    /* ── PUBLISHING PUTS IT IN FORCE ──────────────────────────────────── */
    const live = await call(`/${id}/activate`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    expect(live.status).toBe(200);
    expect(live.body.offer.status).toBe("ACTIVE");
    /* A price is in force from when it was quoted unless somebody said
       otherwise; the EXPIRY is never invented. */
    expect(live.body.offer.effectiveFrom).toBeTruthy();
    expect(live.body.offer.validUntil).toBeNull();

    /* ── A CORRECTION IS A NEW RECORD ─────────────────────────────────────
       The old one keeps saying what was quoted, because somebody was quoted
       it and a costing may already have frozen it. */
    const revised = await call(`/${id}/revise`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { unitPriceMinor: 900 }),
    });
    expect(revised.status).toBe(201);
    expect(revised.body.offer.revision).toBe(2);
    expect(revised.body.offer.supersedesOfferId).toBe(id);
    expect(revised.body.superseded.status).toBe("SUPERSEDED");
    /* The superseded record's PRICE is untouched. */
    const old = await call(`/${id}`, { token: w.token, company: w.co._id });
    expect(old.body.offer.unitPriceMinor).toBe(800);
    expect(old.body.offer.supersededByOfferId).toBe(revised.body.offer.id);

    /* ── WITHDRAWAL NEEDS A REASON ───────────────────────────────────────
       Without one it is indistinguishable from a mistake, and nobody can
       tell whether to go back to that supplier. */
    const second = revised.body.offer.id;
    await call(`/${second}/activate`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    const bare = await call(`/${second}/withdraw`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    expect(bare.status).toBe(400);

    const pulled = await call(`/${second}/withdraw`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: { reason: "Supplier retracted it." },
    });
    expect(pulled.status).toBe(200);
    expect(pulled.body.offer.status).toBe("WITHDRAWN");
    expect(pulled.body.offer.withdrawalReason).toBe("Supplier retracted it.");
  });

  test("the register lists and filters what Store recorded", async () => {
    const w = await world("List");
    const a = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: draftBody(w),
    });
    await call(`/${a.body.offer.id}/activate`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });
    await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: draftBody(w),
    });

    const all = await call("/", { token: w.token, company: w.co._id });
    expect(all.status).toBe(200);
    expect(all.body.offers).toHaveLength(2);

    /* By lifecycle state, and by the service it is for. */
    const active = await call("/?status=ACTIVE", { token: w.token, company: w.co._id });
    expect(active.body.offers).toHaveLength(1);
    const forService = await call(`/?serviceId=${w.service._id}`, { token: w.token, company: w.co._id });
    expect(forService.body.offers).toHaveLength(2);
    const other = await call(`/?serviceId=${new mongoose.Types.ObjectId()}`, { token: w.token, company: w.co._id });
    expect(other.body.offers).toHaveLength(0);
  });

  test("the picker and the costing save reach the same verdict", async () => {
    /* One resolver behind both. Two would let the register offer a supplier
       the costing then refuses. */
    const w = await world("Applicable");
    const made = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { minQuantity: 1000 }),
    });
    await call(`/${made.body.offer.id}/activate`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });

    const ok = await call(`/applicable?serviceId=${w.service._id}&quantity=2000&unit=Piece`,
      { token: w.token, company: w.co._id });
    expect(ok.status).toBe(200);
    expect(ok.body.applicable).toHaveLength(1);

    const short = await call(`/applicable?serviceId=${w.service._id}&quantity=500&unit=Piece`,
      { token: w.token, company: w.co._id });
    expect(short.body.applicable).toHaveLength(0);
    expect(short.body.excluded[0].code).toBe("BELOW_MOQ");
  });
});

/* ═══ 2 · WHAT THE REGISTER REFUSES ═══════════════════════════════════════ */

describe("a quotation cannot be recorded against something that is not ours", () => {
  test("another company's supplier or service is refused without disclosure", async () => {
    const w = await world("Mine");
    const theirs = await world("Theirs");

    const foreignSupplier = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { supplierId: String(theirs.supplier._id) }),
    });
    expect(foreignSupplier.status).toBe(400);
    /* The same words a nonexistent id gets — saying which would confirm a
       record the caller cannot see. */
    expect(foreignSupplier.body.error.message).toMatch(/not in this company's register/);

    const missingSupplier = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { supplierId: String(new mongoose.Types.ObjectId()) }),
    });
    expect(missingSupplier.body.error.message).toBe(foreignSupplier.body.error.message);

    const foreignService = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { serviceId: String(theirs.service._id) }),
    });
    expect(foreignService.status).toBe(400);
    expect(foreignService.body.error.message).toMatch(/not in this company's Service Master/);

    expect(await ServiceSupplierOffer.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("another company's quotation is not readable by id", async () => {
    const w = await world("ReadMine");
    const theirs = await world("ReadTheirs");
    const made = await call("/", {
      method: "POST", token: theirs.token, company: theirs.co._id, idempotencyKey: newKey(),
      body: draftBody(theirs),
    });
    const cross = await call(`/${made.body.offer.id}`, { token: w.token, company: w.co._id });
    expect(cross.status).toBe(404);
  });

  test("an inactive supplier or service cannot be quoted against", async () => {
    const w = await world("Inactive");
    await Vendor.updateOne({ _id: w.supplier._id }, { $set: { status: "Inactive" } });
    const r = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: draftBody(w),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/not an active supplier/);

    await Vendor.updateOne({ _id: w.supplier._id }, { $set: { status: "Active" } });
    await Service.updateOne({ _id: w.service._id }, { $set: { status: "INACTIVE" } });
    const s = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: draftBody(w),
    });
    expect(s.status).toBe(400);
    expect(s.body.error.message).toMatch(/not active in the Service Master/);
  });

  test("a price whose basis, unit or currency nobody stated is refused", async () => {
    const w = await world("Shape");
    for (const [over, pattern] of [
      [{ drop: "priceBasis" }, /includes GST, excludes it, or the supply is non-taxable/],
      [{ unitPriceMinor: 8.5 }, /whole number of minor units/],
      [{ currency: "XXX" }, /not a currency this register supports/],
    ]) {
      const body = draftBody(w, over);
      if (over.drop) delete body[over.drop];
      delete body.drop;
      const r = await call("/", {
        method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body,
      });
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(pattern);
    }

    /* ── AND A BLANK UNIT WITH NOTHING TO FALL BACK ON ──────────────────
       A blank billing unit takes the master's, which is the sensible
       prefill. Where the master has none either, there is nothing to apply a
       rate to and it is refused rather than recorded without one. */
    const noUnit = await Service.create({
      companyId: w.co._id, serviceCode: `SVC-NOUNIT-${++seq}`, name: `Unmeasured ${seq}`,
      billingUnit: "", status: "ACTIVE",
    });
    const r = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(),
      body: draftBody(w, { serviceId: String(noUnit._id), billingUnit: "" }),
    });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/how the supplier bills this/);
  });

  test("a published quotation's commercial terms cannot be rewritten", async () => {
    /* The register's whole claim is that a costing from March can still show
       what was quoted in March. */
    const w = await world("Frozen");
    const made = await call("/", {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: draftBody(w),
    });
    await call(`/${made.body.offer.id}/activate`, {
      method: "POST", token: w.token, company: w.co._id, idempotencyKey: newKey(), body: {},
    });

    const doc = await ServiceSupplierOffer.findById(made.body.offer.id);
    doc.unitPriceMinor = 1;
    await expect(doc.save()).rejects.toThrow(/cannot be changed once recorded/i);

    await expect(
      ServiceSupplierOffer.updateOne({ _id: made.body.offer.id }, { $set: { unitPriceMinor: 1 } }),
    ).rejects.toThrow(/cannot be updated through a query/i);

    /* And it cannot be deleted — a costing may have been priced from it. */
    await expect(
      ServiceSupplierOffer.deleteOne({ _id: made.body.offer.id }),
    ).rejects.toThrow(/cannot be deleted/i);
  });
});
