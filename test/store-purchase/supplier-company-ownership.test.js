// test/store-purchase/supplier-company-ownership.test.js
//
// A NEW SUPPLIER BELONGS TO THE COMPANY THAT CREATED IT.
//
// ── WHAT THE WALKTHROUGH PRODUCED ───────────────────────────────────────────
// A supplier registered through the Store UI came back immediately as
// "Not yet owned — this supplier predates company ownership". It could not be
// edited and could not be chosen in the quotation register: indistinguishable
// from one of the eighty records migrated from before ownership existed, which
// it was not. It had been created minutes earlier.
//
// The cause was `tenantContext.stamp`, which returned `{ companyId: undefined }`
// whenever the context carried no company and let mongoose simply leave the
// field off. Ownership is not optional on a new record: where it cannot be
// resolved, the create refuses rather than minting an orphan.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const tenantContext = require("../../services/storePurchase/tenantContext.service");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/vendors", require("../../routes/CMS_Routes/Inventory/Vendor-Buyer/vendor"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const call = (path, { method = "GET", body, token, idempotencyKey, company, scope } = {}) =>
  fetch(`${base}${path}${scope ? (path.includes("?") ? "&" : "?") + `scope=${scope}` : ""}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Store-Purchase-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const newKey = () => `own-${++seq}-${Math.random().toString(36).slice(2)}`;
const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function person({ co, grant = "store", role = "approver" }) {
  const n = ++seq;
  const email = `own${n}@test.example`;
  const emp = await Employee.create({
    firstName: "O", lastName: `L${n}`, email, biometricId: `OWN${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  if (co) await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "O" });
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "O", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const create = (who, co, over = {}) => call("/vendors", {
  method: "POST", token: who.token, company: co?._id, idempotencyKey: newKey(),
  /* The register requires a code — it is what identifies the supplier on
     orders and paperwork. The walkthrough's was `COST-DEMO`. */
  body: { companyName: `Costing Demo Supplier ${++seq}`, supplierCode: `COST-DEMO-${seq}`, ...over },
});

/* ═══ 1 · OWNERSHIP COMES FROM THE SESSION ════════════════════════════════ */

describe("a supplier created through the register", () => {
  test("belongs to the authenticated company immediately", async () => {
    const co = await company("Owner");
    const who = await person({ co });
    const r = await create(who, co);
    expect(r.status).toBe(201);

    const stored = await Vendor.findById(r.body.vendor?._id || r.body.vendor?.id).lean();
    expect(String(stored.companyId)).toBe(String(co._id));

    /* ── AND IT READS AS OWNED, NOT AS LEGACY ─────────────────────────
       `companyId` is deliberately not published — it is an internal id, and
       a reader only ever sees their own company's suppliers. What the
       register reads is `legacy`, and it is the answer, not an inference
       from a field the API never sends. */
    const read = await call(`/vendors/${stored._id}`, { token: who.token, company: co._id });
    expect(read.status).toBe(200);
    expect(read.body.vendor.legacy).toBe(false);
    expect(read.body.vendor.selectable).toBe(true);
    expect(read.body.vendor).not.toHaveProperty("companyId");
  });

  test("appears under this company's suppliers, and is usable straight away", async () => {
    const co = await company("Owner");
    const who = await person({ co });
    const made = await create(who, co);
    const id = made.body.vendor?._id || made.body.vendor?.id;

    const list = await call("/vendors", { token: who.token, company: co._id });
    expect(list.status).toBe(200);
    const rows = list.body.vendors || list.body.data || [];
    expect(rows.map((v) => String(v._id))).toContain(String(id));
  });

  test("a company named in the body is refused, not quietly substituted", async () => {
    /* Answering a foreign `companyId` with a silent substitution teaches a
       client the field works. */
    const co = await company("Owner");
    const other = await company("Foreign");
    const who = await person({ co });
    const r = await create(who, co, { companyId: String(other._id) });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(r.status).toBeLessThan(500);
  });

  test("another company cannot see it at all", async () => {
    const co = await company("Owner");
    const who = await person({ co });
    const made = await create(who, co);
    const id = made.body.vendor?._id || made.body.vendor?.id;

    const outsider = await person({ co: await company("Foreign") });
    const seen = await call(`/vendors/${id}`, { token: outsider.token });
    /* Missing and foreign are one answer. */
    expect([403, 404]).toContain(seen.status);
  });
});

/* ═══ 2 · AND AN UNRESOLVED COMPANY REFUSES RATHER THAN ORPHANS ═══════════ */

describe("the ownership stamp", () => {
  test("refuses when no company can be resolved", async () => {
    /* This returned `{ companyId: undefined }` and let the record be written
       unowned — which is what the walkthrough hit. */
    expect(() => tenantContext.stamp({ companyId: null })).toThrow();
    try {
      tenantContext.stamp({ companyId: null });
    } catch (err) {
      expect(err.details?.reason || err.reason).toBe("COMPANY_CONTEXT_UNRESOLVED");
    }
  });

  test("refuses inside legacy scope, which is a READ scope", async () => {
    /* Legacy scope selects the records nobody has claimed so they can be
       looked at and migrated. Creating a new one inside it would mint
       exactly the problem the migration exists to clear up. */
    const co = await company("Owner");
    expect(() => tenantContext.stamp({ companyId: co._id, legacyMode: true })).toThrow();
    try {
      tenantContext.stamp({ companyId: co._id, legacyMode: true });
    } catch (err) {
      expect(err.details?.reason || err.reason).toBe("LEGACY_SCOPE_IS_READ_ONLY");
    }
  });

  test("stamps the company, and the site only where one was resolved", async () => {
    const co = await company("Owner");
    expect(tenantContext.stamp({ companyId: co._id })).toEqual({ companyId: co._id });
    const site = new mongoose.Types.ObjectId();
    expect(tenantContext.stamp({ companyId: co._id, siteId: site }))
      .toEqual({ companyId: co._id, siteId: site });
  });
});

/* ═══ 3 · AND NOTHING CLAIMS THE LEGACY EIGHTY ════════════════════════════ */

test("legacy suppliers stay unowned and read-only", async () => {
  /* ── NO BROAD BACKFILL ────────────────────────────────────────────────
     A supplier nobody has claimed is not evidence of who created it. Claiming
     the lot would bind eighty records to a company on the strength of one
     person being signed in when somebody looked at them. */
  const co = await company("Owner");
  const who = await person({ co });
  const legacy = await Vendor.create({ companyName: `Legacy Mill ${++seq}` });

  /* Creating a new supplier does not touch it. */
  await create(who, co);
  const after = await Vendor.findById(legacy._id).lean();
  /* `null` is what the schema default records for a record nobody claimed —
     an absence somebody stored, not a field that failed to save. */
  expect(after.companyId ?? null).toBeNull();

  /* It is not in this company's list… */
  const list = await call("/vendors", { token: who.token, company: co._id });
  const rows = list.body.vendors || list.body.data || [];
  expect(rows.map((v) => String(v._id))).not.toContain(String(legacy._id));

  /* …and a write against it is refused rather than silently claiming it. */
  const edit = await call(`/vendors/${legacy._id}`, {
    method: "PUT", token: who.token, company: co._id,
    body: { companyName: "Renamed", expectedVersion: after.recordVersion ?? 0 },
  });
  expect(edit.status).toBeGreaterThanOrEqual(400);
  const unchanged = await Vendor.findById(legacy._id).lean();
  expect(unchanged.companyId ?? null).toBeNull();
  expect(unchanged.companyName).toBe(legacy.companyName);
});
