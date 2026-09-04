// test/store-purchase/supplier-master.route.test.js
//
// Store & Purchase — Supplier Master boundary.
//
// ── WHAT THIS ROUTER WAS ────────────────────────────────────────────────────
// `Vendor` carried no company at all, and `vendor.js` had authentication and
// nothing else. Every signed-in employee of every company read, edited and
// re-statused one shared supplier table, and the register's "statistics"
// counted the whole system. The previous chunk closed the Item Master's
// supplier integration rather than keep pretending the reads were safe; this
// is the ownership that lets it be reopened.
//
// It also pins the metrics. The performance endpoint reported 85% on-time
// delivery and 90% payment-on-time as literals when it had no evidence, called
// order value "total spent", and inferred settlement from a PO array that
// Accounting owns. A number nobody measured is worse than a blank.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

require("../../models/ProjectManager");
const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const PurchaseOrder = require("../../models/CMS_Models/Inventory/Operations/PurchaseOrder");
const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/vendors", require("../../routes/CMS_Routes/Inventory/Vendor-Buyer/vendor"));
  app.use("/api/cms/raw-items", require("../../routes/CMS_Routes/Inventory/Products/rawItems"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const newKey = () => `sup-${++seq}-${Math.random().toString(36).slice(2)}`;

/* ── THE VERSION EVERY EXISTING-SUPPLIER WRITE MUST STATE ──────────────────
 * `expectedVersion` is required by the routes. Most tests here are not about
 * versioning, so this reads the current one for them — exactly as a real
 * client does after loading the supplier. A test that states its own version
 * (the concurrency and conflict cases) keeps it: the explicit value always
 * wins, so nothing here can mask a stale-version defect. */
const WRITE_TARGET = /^\/vendors\/[0-9a-fA-F]{24}(\/(deactivate|activate|blacklist|archive|assessment|bank-details))?(\?|$)/;

async function withVersion(path, options) {
  const { method = "GET", body, token } = options;
  if (method === "GET" || !body || typeof body !== "object") return options;
  if (!WRITE_TARGET.test(path)) return options;
  if (Object.prototype.hasOwnProperty.call(body, "expectedVersion")) return options;

  const id = path.split("/")[2].split("?")[0];
  const read = await rawCall(`/vendors/${id}`, { token });
  const version = read.body?.vendor?.recordVersion;
  if (version === undefined) return options;
  return { ...options, body: { ...body, expectedVersion: version } };
}

const call = async (path, options = {}) => rawCall(path, await withVersion(path, options));

const rawCall = (path, { method = "GET", body, token, idempotencyKey, company, scope } = {}) =>
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

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function person({ co, grant = null, role = "approver", name = "P" }) {
  const n = ++seq;
  const email = `sup${n}@test.example`;
  const emp = await Employee.create({
    firstName: name, lastName: `L${n}`, email, biometricId: `SUP${n}`,
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

/** A supplier owned by a company, or a legacy-global one when `co` is null. */
const supplier = async ({ co, name, over = {} } = {}) => Vendor.create({
  ...(co ? { companyId: co._id } : {}),
  companyName: name || `Mill ${++seq}`,
  ...over,
});

/* ═══ 1 · AUTHENTICATION AND CAPABILITY ══════════════════════════════════ */

describe("supplier reads and writes require Store authority", () => {
  test("an unauthenticated caller gets nothing", async () => {
    const res = await call("/vendors");
    expect(res.status).toBe(401);
  });

  test("a signed-in employee with no Store grant is refused", async () => {
    const a = await company("Acme");
    const outsider = await person({ co: a });          // no department grant
    const res = await call("/vendors", { token: outsider.token });
    expect(res.status).toBe(403);
  });

  test("a viewer reads suppliers but maintains none", async () => {
    const a = await company("Acme");
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    await supplier({ co: a });

    expect((await call("/vendors", { token: viewer.token })).status).toBe(200);

    const created = await call("/vendors", {
      method: "POST", token: viewer.token, idempotencyKey: newKey(),
      body: { companyName: "New Mill" },
    });
    expect(created.status).toBe(403);
    expect(created.body.error.details.required).toContain("sp.master.maintain");
  });
});

/* ═══ 2 · ONE COMPANY'S SUPPLIERS ════════════════════════════════════════ */

describe("a supplier belongs to exactly one company", () => {
  test("company A never sees, reads or edits company B's supplier", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const mine = await supplier({ co: a, name: "Acme Mills" });
    const theirs = await supplier({ co: b, name: "Borealis Mills" });

    const list = await call("/vendors", { token: storeA.token });
    expect(list.status).toBe(200);
    const names = list.body.vendors.map((v) => v.companyName);
    expect(names).toContain("Acme Mills");
    expect(names).not.toContain("Borealis Mills");

    /* Not forbidden — missing. A 403 would confirm the record exists. */
    const read = await call(`/vendors/${theirs._id}`, { token: storeA.token });
    expect(read.status).toBe(404);
    expect(JSON.stringify(read.body)).not.toMatch(/Borealis Mills/);

    const edited = await call(`/vendors/${theirs._id}`, {
      method: "PUT", token: storeA.token, idempotencyKey: newKey(), body: { companyName: "Taken" },
    });
    expect(edited.status).toBe(404);
    expect((await Vendor.findById(theirs._id).lean()).companyName).toBe("Borealis Mills");
  });

  test("statistics count this company only", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    await supplier({ co: a });
    await supplier({ co: b });
    await supplier({ co: b });

    const res = await call("/vendors", { token: storeA.token });
    expect(res.body.stats.total).toBe(1);
  });

  test("a new supplier takes its company from the session, not the body", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });

    /* A FOREIGN company is refused outright — see the tenant-input contract
       below. Here the body names this company, which is redundant rather than
       an attempt: the stored owner still comes from the session. */
    const res = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Server Owned", supplierCode: "SUP-OWN-1", companyId: String(a._id) },
    });
    expect(res.status).toBe(201);
    const stored = await Vendor.findById(res.body.vendor._id).lean();
    expect(String(stored.companyId)).toBe(String(a._id));   // session, not body
    expect(stored.siteId).toBeNull();
  });

  test("a site cannot be claimed from the body either", async () => {
    /* Stronger than ignoring it: the tenant middleware refuses outright,
       because there is no authoritative site model to validate against and
       stamping whatever id arrived would be trusting the browser with scope. */
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });

    const res = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Site Claimer", supplierCode: "SUP-SITE-1", siteId: String(new mongoose.Types.ObjectId()) },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe("SITE_NOT_CONFIGURED");
    expect(await Vendor.countDocuments({ companyName: "Site Claimer" })).toBe(0);
  });

  test("a legacy-global supplier is excluded from an ordinary list", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });
    await supplier({ co: null, name: "Legacy Global Mill" });

    const res = await call("/vendors", { token: storeA.token });
    expect(res.body.vendors.map((v) => v.companyName)).not.toContain("Legacy Global Mill");
  });

  test("a legacy supplier is readable only explicitly, and never writable", async () => {
    const a = await company("Acme");
    /* Approver holds sp.legacy.read; editor does not. */
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const editor = await person({ co: a, grant: "store", role: "editor" });
    const legacy = await supplier({ co: null, name: "Legacy Global Mill" });

    const denied = await call("/vendors", { token: editor.token, scope: "legacy" });
    expect(denied.status).toBe(403);

    const allowed = await call("/vendors", { token: approver.token, scope: "legacy" });
    expect(allowed.status).toBe(200);
    expect(allowed.body.vendors.map((v) => v.companyName)).toContain("Legacy Global Mill");

    const write = await call(`/vendors/${legacy._id}`, {
      method: "PUT", token: approver.token, idempotencyKey: newKey(), scope: "legacy", body: { companyName: "Adopted" },
    });
    expect(write.status).toBe(403);
    const stored = await Vendor.findById(legacy._id).lean();
    expect(stored.companyName).toBe("Legacy Global Mill");
    expect(stored.companyId == null).toBe(true);          // never silently adopted
  });
});

/* ═══ 3 · IDENTITY IS UNIQUE INSIDE A COMPANY, NOT ACROSS THE SYSTEM ═════ */

describe("supplier identity", () => {
  test("a supplier code is unique within a company and free across companies", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    const storeB = await person({ co: b, grant: "store" });

    const first = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Mill One", supplierCode: "SUP-1" },
    });
    expect(first.status).toBe(201);

    const dup = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Mill Two", supplierCode: "SUP-1" },
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("SUPPLIER_CODE_DUPLICATE");

    /* The same code is another company's to use. */
    const elsewhere = await call("/vendors", {
      method: "POST", token: storeB.token, idempotencyKey: newKey(),
      body: { companyName: "Their Mill", supplierCode: "SUP-1" },
    });
    expect(elsewhere.status).toBe(201);
  });

  test("a GSTIN is unique within a company, and blanks never collide", async () => {
    const a = await company("Acme");
    const storeA = await person({ co: a, grant: "store" });
    const gst = "29ABCDE1234F1Z5";

    expect((await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Mill One", supplierCode: "SUP-G1", gstNumber: gst },
    })).status).toBe(201);

    const dup = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Mill Two", supplierCode: "SUP-G2", gstNumber: gst.toLowerCase() },  // same identity
    });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe("SUPPLIER_GSTIN_DUPLICATE");

    /* Two suppliers with no GSTIN are two suppliers, not a duplicate. */
    for (const name of ["No GST One", "No GST Two"]) {
      const res = await call("/vendors", {
        method: "POST", token: storeA.token, idempotencyKey: newKey(),
        body: { companyName: name, supplierCode: `SUP-NOGST-${++seq}`, gstNumber: "" },
      });
      expect(res.status).toBe(201);
    }
  });

  test("a duplicate check cannot see another company's supplier", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const storeA = await person({ co: a, grant: "store" });
    await supplier({ co: b, over: { supplierCode: "SHARED-1", gstNumber: "29ABCDE1234F1Z5" } });

    const res = await call("/vendors", {
      method: "POST", token: storeA.token, idempotencyKey: newKey(),
      body: { companyName: "Mine", supplierCode: "SHARED-1", gstNumber: "29ABCDE1234F1Z5" },
    });
    expect(res.status).toBe(201);
  });
});

/* ═══ 4 · A GOVERNED LIFECYCLE, NOT A STATUS DROPDOWN ════════════════════ */

describe("supplier lifecycle", () => {
  const withSupplier = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a });
    return { a, store, v };
  };

  test("status cannot be set directly any more", async () => {
    const { store, v } = await withSupplier();
    const res = await call(`/vendors/${v._id}/status`, {
      method: "PATCH", token: store.token, body: { status: "Blacklisted" },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Active");
  });

  test("blacklisting states a reason, and records who and when", async () => {
    const { store, v } = await withSupplier();

    const noReason = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: {},
    });
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("BLACKLIST_REASON_REQUIRED");
    expect((await Vendor.findById(v._id).lean()).status).toBe("Active");

    const done = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { reason: "  Repeated short deliveries  " },
    });
    expect(done.status).toBe(200);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.status).toBe("Blacklisted");
    expect(stored.blacklist.reason).toBe("Repeated short deliveries");
    expect(String(stored.blacklist.byName || stored.blacklist.by)).toBeTruthy();
    expect(stored.blacklist.at).toBeTruthy();
  });

  test("archiving keeps the record readable and closes it to editing", async () => {
    const { store, v } = await withSupplier();

    const archived = await call(`/vendors/${v._id}/archive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { reason: "Merged into another supplier" },
    });
    expect(archived.status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Archived");

    /* Still readable — the history of what was bought from it stays. */
    expect((await call(`/vendors/${v._id}`, { token: store.token })).status).toBe(200);

    const edited = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(), body: { contactPerson: "Someone" },
    });
    expect(edited.status).toBe(409);
    expect(edited.body.code).toBe("SUPPLIER_ARCHIVED");
  });

  test("deactivate and reactivate are their own operations", async () => {
    const { store, v } = await withSupplier();

    expect((await call(`/vendors/${v._id}/deactivate`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Dormant" },
    })).status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Inactive");

    expect((await call(`/vendors/${v._id}/activate`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Trading again" },
    })).status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Active");
  });

  test("DELETE destroys nothing and does not call itself a deletion", async () => {
    const { store, v } = await withSupplier();
    const res = await call(`/vendors/${v._id}`, { method: "DELETE", token: store.token });

    expect(res.status).toBe(405);
    expect(res.body.code).toBe("SUPPLIER_DELETE_NOT_SUPPORTED");
    /* The point is that it must not REPORT a deletion or a deactivation it
       did not perform — the old handler answered "Vendor marked as inactive".
       Explaining that suppliers are not deleted is the opposite of that. */
    expect(res.body.message).not.toMatch(/marked as inactive|has been (deleted|removed)/i);
    expect(res.body.success).toBe(false);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored).toBeTruthy();
    expect(stored.status).toBe("Active");        // not silently deactivated either
  });

  test("every lifecycle change appends immutable history", async () => {
    const { store, v } = await withSupplier();
    await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Quality" },
    });
    await call(`/vendors/${v._id}/activate`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Resolved" },
    });

    const res = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.history.length).toBeGreaterThanOrEqual(2);

    const entry = res.body.history.find((h) => h.toState === "Blacklisted");
    expect(entry.fromState).toBe("Active");
    expect(entry.reason).toBe("Quality");
    expect(entry.actor).toBeTruthy();
    expect(entry.at).toBeTruthy();
  });

  test("a repeated lifecycle call under one key acts once", async () => {
    const { store, v } = await withSupplier();
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    /* Captured ONCE and resent unchanged: a retry is the same request, and
       re-reading the version would make it a different one. */
    const body = { reason: "Repeated short deliveries", expectedVersion: start.body.vendor.recordVersion };

    const first = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    const retry = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.status).toBe(200);

    const res = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(res.body.history.filter((h) => h.toState === "Blacklisted")).toHaveLength(1);
  });
});

/* ═══ 5 · WHAT THE SUPPLIER SCREENS MAY CLAIM ════════════════════════════ */

describe("supplier evidence is measured or absent", () => {
  test("performance states no invented figure when there is nothing to measure", async () => {
    /* 85% on-time and 90% payment-on-time were literals in the source. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a });

    const res = await call(`/vendors/${v._id}/performance`, { token: store.token });
    expect(res.status).toBe(200);

    const p = res.body.performance;
    expect(p.onTimeDelivery).toBeNull();
    expect(p.onTimeDeliveryCoverage).toEqual({ measured: 0, of: 0 });
    /* Settlement belongs to Accounting; Store must not infer it. */
    expect(p.paymentOnTime).toBeUndefined();
    expect(p.responseTime).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toMatch(/\b85\b|\b90\b|4\.2/);
  });

  test("order value is called order value, never money spent", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a });
    await PurchaseOrder.create({
      companyId: a._id, createdBy: new mongoose.Types.ObjectId(),
      poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
      vendor: v._id, vendorName: "Mill", status: "COMPLETED", totalAmount: 500,
      items: [], orderDate: new Date(),
    });

    const res = await call(`/vendors/${v._id}/performance`, { token: store.token });
    const p = res.body.performance;
    expect(p.orderedValue).toBe(500);
    expect(p.totalSpent).toBeUndefined();
    expect(p.amountPaid).toBeUndefined();
  });

  test("performance and orders count only this company's orders", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a });

    for (const [co, amount] of [[a, 100], [b, 999]]) {
      await PurchaseOrder.create({
        companyId: co._id, createdBy: new mongoose.Types.ObjectId(),
        poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
        vendor: v._id, vendorName: "Mill", status: "COMPLETED", totalAmount: amount,
        items: [], orderDate: new Date(),
      });
    }

    const res = await call(`/vendors/${v._id}/performance`, { token: store.token });
    expect(res.body.performance.totalOrders).toBe(1);
    expect(res.body.performance.orderedValue).toBe(100);
  });

  test("a rating typed by a person is not presented as measured quality", async () => {
    /* Provenance became part of this answer once the model stopped inventing
       a default: a stored value with no recorded author cannot be told apart
       from that old default, so it is legacy rather than anybody's opinion.
       See "a rating says where it came from" for the full contract. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { rating: 5 } });

    const res = await call(`/vendors/${v._id}/performance`, { token: store.token });
    expect(res.body.performance.qualityRating).toBeUndefined();
    expect(res.body.performance.statedRating.value).toBe(5);
    expect(res.body.performance.statedRating.source).toBe("LEGACY_UNVERIFIED");
  });
});

/* ═══ 6 · SENSITIVE FIELDS AND SEARCH ════════════════════════════════════ */

describe("supplier reads are careful about what they hand back", () => {
  test("bank details never appear in a list response", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await supplier({ co: a, over: { bankDetails: { accountNumber: "1234567890", bankName: "Test Bank" } } });

    const res = await call("/vendors", { token: store.token });
    expect(JSON.stringify(res.body)).not.toMatch(/1234567890/);
  });

  test("a search metacharacter is a character, not a pattern", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await supplier({ co: a, name: "Mill (North)" });
    await supplier({ co: a, name: "Southern Mill" });

    const res = await call("/vendors?search=" + encodeURIComponent("(North"), { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.vendors.map((v) => v.companyName)).toEqual(["Mill (North)"]);
  });

  test("the static routes are not captured by /:id", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    const types = await call("/vendors/types", { token: store.token });
    expect(types.status).toBe(200);
    expect(Array.isArray(types.body.types)).toBe(true);

    const products = await call("/vendors/common-products", { token: store.token });
    expect(products.status).toBe(200);
    expect(Array.isArray(products.body.products)).toBe(true);
  });

  test("a malformed id is a validation answer, not a database error", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const res = await call("/vendors/not-an-id", { token: store.token });
    expect([400, 404]).toContain(res.status);
    expect(JSON.stringify(res.body)).not.toMatch(/Cast to ObjectId|BSONError|mongoose/i);
  });
});

/* ═══ 7 · THE ORDINARY EDIT ══════════════════════════════════════════════ */

describe("an authorised person can edit a supplier", () => {
  const owned = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Mill One", supplierCode: "SUP-EDIT-1" },
    });
    expect(created.status).toBe(201);
    return { a, store, id: created.body.vendor._id };
  };

  test("identity, contact and tax details save", async () => {
    /* `status` was dropped from the destructuring but `if (status)` was left
       behind, so every ordinary edit threw ReferenceError and answered 500. */
    const { store, id } = await owned();

    const res = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: {
        companyName: "Mill One Renamed",
        contactPerson: "A Buyer", email: "BUYER@Mill.example", phone: "0123",
        gstNumber: "29ABCDE1234F1Z5", panNumber: "ABCDE1234F",
        address: { city: "Tirupur", state: "TN" },
      },
    });
    expect(res.status).toBe(200);

    const stored = await Vendor.findById(id).lean();
    expect(stored.companyName).toBe("Mill One Renamed");
    expect(stored.contactPerson).toBe("A Buyer");
    expect(stored.email).toBe("buyer@mill.example");
    expect(stored.gstNumber).toBe("29ABCDE1234F1Z5");
    expect(stored.gstNormalised).toBe("29ABCDE1234F1Z5");
    expect(stored.address.city).toBe("Tirupur");
  });

  test("a body-supplied status never moves the lifecycle", async () => {
    const { store, id } = await owned();
    const res = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Still Fine", status: "Blacklisted" },
    });
    /* One documented contract: the field is refused, not quietly dropped. */
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SUPPLIER_STATUS_NOT_EDITABLE");

    const stored = await Vendor.findById(id).lean();
    expect(stored.status).toBe("Active");
    expect(stored.companyName).toBe("Mill One");        // whole edit refused
  });

  test("the supplier code is stable identity and cannot be edited away", async () => {
    const { store, id } = await owned();
    const res = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Mill One", supplierCode: "SUP-DIFFERENT" },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("SUPPLIER_CODE_IMMUTABLE");
    expect((await Vendor.findById(id).lean()).supplierCode).toBe("SUP-EDIT-1");
  });

  test("re-sending the same supplier code is not a change", async () => {
    const { store, id } = await owned();
    const res = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Mill One B", supplierCode: "sup-edit-1" },
    });
    expect(res.status).toBe(200);
  });
});

/* ═══ 8 · SUPPLIER CODE IS REQUIRED, VALIDATED AND SCOPED ════════════════ */

describe("supplier code", () => {
  const create = (token, body) => call("/vendors", {
    method: "POST", token, idempotencyKey: newKey(), body,
  });

  test("a new supplier must state one", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const res = await create(store.token, { companyName: "No Code Mill" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SUPPLIER_CODE_REQUIRED");
    expect(await Vendor.countDocuments({ companyName: "No Code Mill" })).toBe(0);
  });

  test("the format is stated and enforced", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    for (const bad of ["", "   ", "a b", "code!", "x".repeat(33), "--", 5, {}]) {
      const res = await create(store.token, { companyName: `Mill ${++seq}`, supplierCode: bad });
      expect(res.status).toBe(400);
      expect(["SUPPLIER_CODE_REQUIRED", "SUPPLIER_CODE_INVALID"]).toContain(res.body.code);
    }
    /* Accepted, and normalised to one canonical form. */
    const ok = await create(store.token, { companyName: "Good Mill", supplierCode: " sup-ok_1 " });
    expect(ok.status).toBe(201);
    expect((await Vendor.findById(ok.body.vendor._id).lean()).supplierCode).toBe("SUP-OK_1");
  });

  test("a legacy supplier keeps no code, and none is invented for it", async () => {
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const legacy = await supplier({ co: null, name: "Legacy Mill" });

    const res = await call("/vendors", { token: approver.token, scope: "legacy" });
    expect(res.status).toBe(200);
    const row = res.body.vendors.find((v) => String(v._id) === String(legacy._id));
    expect(row.supplierCode || "").toBe("");
    expect((await Vendor.findById(legacy._id).lean()).supplierCode || "").toBe("");
  });
});

/* ═══ 9 · THE TENANT-INPUT CONTRACT ══════════════════════════════════════ */

describe("ownership fields supplied by the browser", () => {
  test("a foreign company is refused, not ignored", async () => {
    /* Silently ignoring it teaches a client the field works. */
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });

    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Claimed", supplierCode: "SUP-C1", companyId: String(b._id) },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.code || res.body.code).toBe("TENANT_MISMATCH");
    expect(await Vendor.countDocuments({ companyName: "Claimed" })).toBe(0);
  });

  test("this company's own id is accepted as redundant", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Redundant", supplierCode: "SUP-R1", companyId: String(a._id) },
    });
    expect(res.status).toBe(201);
  });

  test("an invented site fails closed", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Sited", supplierCode: "SUP-S1", siteId: String(new mongoose.Types.ObjectId()) },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.code).toBe("SITE_NOT_CONFIGURED");
    expect(await Vendor.countDocuments({ companyName: "Sited" })).toBe(0);
  });

  test("the same contract applies to editing", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-E9" } });

    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Moved", companyId: String(b._id) },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error?.code || res.body.code).toBe("TENANT_MISMATCH");
    expect(String((await Vendor.findById(v._id).lean()).companyId)).toBe(String(a._id));
  });
});

/* ═══ 10 · BANK DETAILS ══════════════════════════════════════════════════ */

describe("bank instructions are restricted everywhere", () => {
  const BANK = {
    accountName: "Mill One", accountNumber: "1234567890",
    bankName: "Test Bank", ifscCode: "TEST0001234", branch: "Main",
  };

  const seeded = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-B1", bankDetails: BANK } });
    return { a, store, viewer, v };
  };

  const leaks = (body) => /1234567890|TEST0001234/.test(JSON.stringify(body));

  test("the ordinary detail read carries no bank fields at all", async () => {
    /* It returned `vendor.toObject()` — the whole document, account number
       included — to anybody holding sp.read. */
    const { store, v } = await seeded();
    const res = await call(`/vendors/${v._id}`, { token: store.token });
    expect(res.status).toBe(200);
    expect(leaks(res.body)).toBe(false);
    expect(res.body.vendor.bankDetails).toBeUndefined();
  });

  test("no other supplier response carries them either", async () => {
    const { store, v } = await seeded();
    for (const path of [
      "/vendors",
      `/vendors/${v._id}/alias-items`,
      `/vendors/${v._id}/purchase-orders`,
      `/vendors/${v._id}/performance`,
      `/vendors/${v._id}/history`,
      `/vendors/${v._id}/items-supplied`,
    ]) {
      const res = await call(path, { token: store.token });
      expect(leaks(res.body)).toBe(false);
    }
  });

  test("the private read needs maintenance authority, not merely read", async () => {
    const { store, viewer, v } = await seeded();

    const denied = await call(`/vendors/${v._id}/bank-details`, { token: viewer.token });
    expect(denied.status).toBe(403);
    expect(leaks(denied.body)).toBe(false);

    const allowed = await call(`/vendors/${v._id}/bank-details`, { token: store.token });
    expect(allowed.status).toBe(200);
    expect(allowed.body.bankDetails.accountNumber).toBe("1234567890");
  });

  test("the private read is tenant-scoped and refuses legacy records", async () => {
    const { store } = await seeded();
    const b = await company("Borealis");
    const theirs = await supplier({ co: b, over: { bankDetails: BANK } });
    const legacy = await supplier({ co: null, over: { bankDetails: BANK } });

    const cross = await call(`/vendors/${theirs._id}/bank-details`, { token: store.token });
    expect(cross.status).toBe(404);
    expect(leaks(cross.body)).toBe(false);

    const approver = await person({ co: b, grant: "store", role: "approver" });
    const old = await call(`/vendors/${legacy._id}/bank-details`, { token: approver.token, scope: "legacy" });
    expect(old.status).toBeGreaterThanOrEqual(400);
    expect(leaks(old.body)).toBe(false);
  });
});

/* ═══ 11 · THE TRANSITION TABLE ══════════════════════════════════════════ */

describe("lifecycle transitions", () => {
  const at = async (status) => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: `SUP-${++seq}`, status } });
    return { a, store, v };
  };
  const move = (token, id, op, body = {}) =>
    call(`/vendors/${id}/${op}`, { method: "POST", token, idempotencyKey: newKey(), body });

  test("a legacy supplier cannot be activated — or written to at all", async () => {
    /* `activate` passed `forWrite: false`, so a legacy record opened under
       ?scope=legacy could be mutated through it. */
    const a = await company("Acme");
    const approver = await person({ co: a, grant: "store", role: "approver" });
    const legacy = await supplier({ co: null, over: { status: "Inactive" } });

    for (const op of ["activate", "deactivate", "blacklist", "archive"]) {
      const res = await call(`/vendors/${legacy._id}/${op}`, {
        method: "POST", token: approver.token, idempotencyKey: newKey(),
        scope: "legacy", body: { reason: "Trying it on" },
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
    }
    const stored = await Vendor.findById(legacy._id).lean();
    expect(stored.status).toBe("Inactive");
    expect(stored.companyId == null).toBe(true);
    expect(stored.lifecycleHistory || []).toHaveLength(0);
  });

  test("an archived supplier has no ordinary transition out", async () => {
    const { store, v } = await at("Archived");
    for (const op of ["activate", "deactivate", "blacklist"]) {
      const res = await move(store.token, v._id, op, { reason: "Reopening" });
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("SUPPLIER_TRANSITION_NOT_ALLOWED");
    }
    expect((await Vendor.findById(v._id).lean()).status).toBe("Archived");
  });

  test("removing a blacklist states its own reason", async () => {
    const { store, v } = await at("Blacklisted");

    const bare = await move(store.token, v._id, "activate", {});
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe("REACTIVATION_REASON_REQUIRED");
    expect((await Vendor.findById(v._id).lean()).status).toBe("Blacklisted");

    const done = await move(store.token, v._id, "activate", { reason: "Quality issue resolved" });
    expect(done.status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Active");
  });

  test("archiving states a reason", async () => {
    const { store, v } = await at("Active");
    const bare = await move(store.token, v._id, "archive", {});
    expect(bare.status).toBe(400);
    expect(bare.body.code).toBe("ARCHIVE_REASON_REQUIRED");
    expect((await Vendor.findById(v._id).lean()).status).toBe("Active");
  });

  test("the allowed moves all work", async () => {
    for (const [from, op, to] of [
      ["Active", "deactivate", "Inactive"],
      ["Active", "blacklist", "Blacklisted"],
      ["Active", "archive", "Archived"],
      ["Inactive", "activate", "Active"],
      ["Inactive", "blacklist", "Blacklisted"],
      ["Inactive", "archive", "Archived"],
    ]) {
      const { store, v } = await at(from);
      const res = await move(store.token, v._id, op, { reason: "Stated" });
      expect(res.status).toBe(200);
      expect((await Vendor.findById(v._id).lean()).status).toBe(to);
    }
  });

  test("a refusal and a no-op both leave the history alone", async () => {
    const { store, v } = await at("Active");

    const noop = await move(store.token, v._id, "activate", { reason: "Already active" });
    expect(noop.status).toBe(200);

    const refused = await move(store.token, v._id, "blacklist", {});
    expect(refused.status).toBe(400);

    const res = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(res.body.history).toHaveLength(0);
  });

  test("the success message is a sentence", async () => {
    const { store, v } = await at("Active");
    const res = await move(store.token, v._id, "blacklist", { reason: "Quality" });
    expect(res.body.message).not.toMatch(/blacklistd|archived\.d|activatedd/);
    expect(res.body.message).toMatch(/blacklisted/i);
  });
});

/* ═══ 12 · IDEMPOTENCY THAT SURVIVES AN INTERRUPTION ═════════════════════ */

describe("a retried supplier operation happens once", () => {
  test("creation under one key makes one supplier", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const key = newKey();
    const body = { companyName: "Retried Mill", supplierCode: "SUP-RETRY-1" };

    const first = await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key, body });
    expect(first.status).toBe(201);
    const retry = await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key, body });
    expect(retry.status).toBe(201);
    expect(String(retry.body.vendor._id)).toBe(String(first.body.vendor._id));

    expect(await Vendor.countDocuments({ companyId: a._id, supplierCode: "SUP-RETRY-1" })).toBe(1);
  });

  test("the same key with a different payload conflicts", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const key = newKey();

    await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key,
      body: { companyName: "One", supplierCode: "SUP-K1" } });
    const different = await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key,
      body: { companyName: "Two", supplierCode: "SUP-K2" } });

    expect(different.status).toBeGreaterThanOrEqual(400);
    expect(await Vendor.countDocuments({ companyId: a._id, supplierCode: "SUP-K2" })).toBe(0);
  });

  test("a lifecycle retry appends one history line, not two", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-LC1" } });
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const body = { reason: "Repeated short deliveries", expectedVersion: start.body.vendor.recordVersion };

    for (let i = 0; i < 3; i += 1) {
      const res = await call(`/vendors/${v._id}/blacklist`, {
        method: "POST", token: store.token, idempotencyKey: key, body,
      });
      expect(res.status).toBe(200);
    }

    const res = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(res.body.history.filter((h) => h.toState === "Blacklisted")).toHaveLength(1);
  });
});

/* ═══ 13 · TWO DECISIONS AT ONCE ═════════════════════════════════════════ */

describe("competing lifecycle decisions", () => {
  test("simultaneous deactivate and blacklist do not overwrite one another", async () => {
    /* Both used to load the same document, mutate their own copy and save;
       the later save replaced the earlier decision AND its history line. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-RACE-1" } });

    const results = await Promise.all([
      call(`/vendors/${v._id}/deactivate`, {
        method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Dormant" },
      }),
      call(`/vendors/${v._id}/blacklist`, {
        method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Quality" },
      }),
    ]);

    /* ── THE INVARIANT IS CONSISTENCY, NOT "EXACTLY ONE WINNER" ────────
     * This asserted one success and one failure, which is only true when the
     * two requests genuinely overlap. `Promise.all` does not guarantee that:
     * if they serialise, deactivate (Active→Inactive) and then blacklist
     * (Inactive→Blacklisted) are BOTH legal transitions and both correctly
     * succeed — so the old assertion failed intermittently on correct
     * behaviour, which is worse than no test.
     *
     * What must hold either way: every success left a history entry, every
     * failure left none, and the stored state is the one the last successful
     * transition produced. A lost update breaks all three. */
    const winners = results.filter((r) => r.status === 200 && !r.body.unchanged);
    const losers = results.filter((r) => r.status !== 200);

    expect(winners.length + losers.length).toBe(2);
    losers.forEach((r) => {
      expect(["SUPPLIER_STATE_CHANGED", "SUPPLIER_VERSION_CONFLICT"]).toContain(r.body.code);
      /* Whichever guard refused, it says what the record is now. */
      expect(r.body.currentStatus || r.body.currentVersion !== undefined).toBeTruthy();
    });

    const history = await call(`/vendors/${v._id}/history`, { token: store.token });
    /* One entry per successful transition — never more, never fewer. */
    expect(history.body.history).toHaveLength(winners.length);

    const current = await Vendor.findById(v._id).lean();
    /* The stored state is the one some successful request actually produced,
       not a state nobody asked for. */
    expect(winners.map((w) => w.body.vendor.status)).toContain(current.status);
    expect(history.body.history[0].toState).toBe(current.status);

  });

  test("four simultaneous archives archive once", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-RACE-2" } });

    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const version = start.body.vendor.recordVersion;
    const results = await Promise.all([1, 2, 3, 4].map(() =>
      call(`/vendors/${v._id}/archive`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { reason: "Closed", expectedVersion: version },
      })));

    /* The invariant is one CHANGE, not one 200. A request arriving after the
       winner committed finds the supplier already archived and says so — that
       is the documented no-op, and it writes no history. A request that races
       the winner loses the compare-and-set and is told the state changed. */
    const changed = results.filter((r) => r.status === 200 && !r.body.unchanged);
    const noops = results.filter((r) => r.status === 200 && r.body.unchanged);
    /* A loser is refused by EITHER guard: the version compare-and-set, or
       the lifecycle-state condition. Both are correct refusals, and counting
       only one of them made this test narrower than the contract. */
    const lost = results.filter((r) => ["SUPPLIER_STATE_CHANGED", "SUPPLIER_VERSION_CONFLICT"]
      .includes(r.body.code));

    expect(changed).toHaveLength(1);
    expect(noops.length + lost.length).toBe(3);
    expect((await Vendor.findById(v._id).lean()).status).toBe("Archived");

    const history = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(history.body.history).toHaveLength(1);
  });
});

/* ═══ 14 · THE AUTHORITATIVE AUDIT STREAM ════════════════════════════════ */

describe("supplier history is the established action history", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

  test("create, edit and lifecycle all reach it, tenant-scoped", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Audited Mill", supplierCode: "SUP-AUD-1" },
    });
    const id = created.body.vendor._id;

    await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(), body: { companyName: "Audited Mill B" },
    });
    await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Quality" },
    });

    const rows = await SpActionHistory.find({ entityType: "Vendor", entityId: id }).lean();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    rows.forEach((r) => {
      expect(String(r.companyId)).toBe(String(a._id));
      expect(r.actorEmail || r.actorName).toBeTruthy();
    });
    expect(rows.map((r) => r.action)).toEqual(
      expect.arrayContaining([expect.stringMatching(/CREATE/i), expect.stringMatching(/BLACKLIST/i)]),
    );
  });

  test("no bank value ever reaches the audit stream", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: {
        companyName: "Banked Mill", supplierCode: "SUP-AUD-2",
        bankDetails: { accountNumber: "9876543210", ifscCode: "TEST0009999" },
      },
    });
    /* Creation now refuses a bank payload outright — see "payment
       instructions have one door". Nothing was created, so nothing about
       those values could have reached the audit stream. */
    expect(created.status).toBe(400);
    expect(created.body.code).toBe("SUPPLIER_BANK_NOT_EDITABLE_HERE");

    const rows = await SpActionHistory.find({ entityType: "Vendor", companyId: a._id }).lean();
    expect(JSON.stringify(rows)).not.toMatch(/9876543210|TEST0009999/);
  });

  test("the history endpoint reads the action history under sp.history.read", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const viewer = await person({ co: a, grant: "store", role: "viewer" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-AUD-3" } });
    await call(`/vendors/${v._id}/archive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Closed" },
    });

    const res = await call(`/vendors/${v._id}/history`, { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.history[0].toState).toBe("Archived");
    expect(res.body.history[0].actor).toBeTruthy();

    /* A viewer holds sp.history.read in this grant table, so this proves the
       read is gated on that capability rather than on maintenance. */
    expect((await call(`/vendors/${v._id}/history`, { token: viewer.token })).status).toBe(200);
  });
});

/* ═══ 15 · RATING PROVENANCE ═════════════════════════════════════════════ */

describe("a rating says where it came from", () => {
  test("a new supplier has no rating at all", async () => {
    /* The model defaulted to 3 and the form pre-filled it, so "somebody's
       opinion" was in fact the application's invention. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Unrated Mill", supplierCode: "SUP-R0" },
    });
    expect(created.status).toBe(201);

    const stored = await Vendor.findById(created.body.vendor._id).lean();
    expect(stored.rating == null).toBe(true);

    const perf = await call(`/vendors/${created.body.vendor._id}/performance`, { token: store.token });
    expect(perf.body.performance.statedRating).toBeNull();
  });

  test("a recorded assessment carries its author and date", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-R1" } });

    const res = await call(`/vendors/${v._id}/assessment`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { rating: 4, reason: "Consistent quality over six orders" },
    });
    expect(res.status).toBe(200);

    const perf = await call(`/vendors/${v._id}/performance`, { token: store.token });
    expect(perf.body.performance.statedRating.value).toBe(4);
    expect(perf.body.performance.statedRating.source).toBe("RECORDED");
    expect(perf.body.performance.statedRating.by).toBeTruthy();
    expect(perf.body.performance.statedRating.at).toBeTruthy();
  });

  test("a rating with no recorded author is legacy, not an opinion", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    /* Exactly the shape the old default produced. */
    const v = await supplier({ co: a, over: { supplierCode: "SUP-R2", rating: 3 } });

    const perf = await call(`/vendors/${v._id}/performance`, { token: store.token });
    expect(perf.body.performance.statedRating.source).toBe("LEGACY_UNVERIFIED");
    expect(perf.body.performance.statedRating.by).toBeFalsy();
  });
});

/* ═══ 16 · EVIDENCE THAT MEANS WHAT ITS LABEL SAYS ═══════════════════════ */

describe("supplier evidence", () => {
  const orderFor = async (co, v, over = {}) => PurchaseOrder.create({
    companyId: co._id, createdBy: new mongoose.Types.ObjectId(),
    poNumber: `PO/2026-27/${String(++seq).padStart(4, "0")}`,
    vendor: v._id, vendorName: "Mill", items: [], orderDate: new Date("2026-06-01"),
    ...over,
  });

  test("an early partial receipt does not make a late order on time", async () => {
    /* The first dated receipt decided the whole order, so one carton arriving
       early made a shipment that finished a month late look punctual. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-EV1" } });

    await orderFor(a, v, {
      status: "COMPLETED", totalAmount: 100,
      expectedDeliveryDate: new Date("2026-06-10"),
      deliveries: [
        { deliveryDate: new Date("2026-06-02") },   // tiny, early
        { deliveryDate: new Date("2026-07-15") },   // the rest, late
      ],
    });

    const res = await call(`/vendors/${v._id}/performance`, { token: store.token });
    const p = res.body.performance;
    /* Either it measures the FINAL receipt (0%), or it says it can only see
       first-receipt timing and labels it so. It must not claim 100% on time. */
    if (p.onTimeDelivery !== null) {
      expect(p.onTimeDelivery).toBe(0);
      expect(p.onTimeDeliveryBasis).toBe("FINAL_RECEIPT");
    } else {
      expect(p.onTimeDeliveryBasis).toBe("NOT_MEASURED");
    }
  });

  test("the average is taken over the population its label names", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-EV2" } });

    await orderFor(a, v, { status: "COMPLETED", totalAmount: 300 });
    await orderFor(a, v, { status: "ISSUED", totalAmount: 900 });
    await orderFor(a, v, { status: "CANCELLED", totalAmount: 500 });

    const p = (await call(`/vendors/${v._id}/performance`, { token: store.token })).body.performance;
    expect(p.orderedValue).toBe(300);                     // completed only
    /* 300/1, not 300/3. */
    expect(p.averageCompletedOrderValue).toBe(300);
    expect(p.averageOrderValue).toBeUndefined();
  });

  test("purchase-order statistics are not computed from one page", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-EV3" } });
    for (let i = 0; i < 7; i += 1) {
      await orderFor(a, v, { status: "COMPLETED", totalAmount: 100 });
    }

    const res = await call(`/vendors/${v._id}/purchase-orders?limit=3`, { token: store.token });
    expect(res.status).toBe(200);
    expect(res.body.purchaseOrders).toHaveLength(3);
    /* The totals describe the supplier, not the page. */
    expect(res.body.stats.totalOrders).toBe(7);
    expect(res.body.stats.completedOrderValue).toBe(700);
    expect(res.body.pagination.total).toBe(7);
  });

  test("an invalid date filter is refused, not passed to the database", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-EV4" } });

    const res = await call(`/vendors/${v._id}/purchase-orders?startDate=not-a-date`, { token: store.token });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("INVALID_DATE_FILTER");
    expect(JSON.stringify(res.body)).not.toMatch(/CastError|Invalid Date|mongoose/i);
  });

  test("supplied quantities stay in their own units", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-EV5" } });
    const it = await RawItem.create({
      companyId: a._id, name: "Cotton", sku: `RAW-${++seq}`, unit: "m", quantity: 0, minStock: 0, maxStock: 10,
    });

    await orderFor(a, v, { status: "COMPLETED", totalAmount: 100, items: [
      { rawItem: it._id, itemName: "Cotton", unit: "m", quantity: 300, unitPrice: 2, totalPrice: 600 },
      { rawItem: it._id, itemName: "Cotton", unit: "box", quantity: 12, unitPrice: 2, totalPrice: 24 },
      { rawItem: it._id, itemName: "Cotton", unit: "", quantity: 5, unitPrice: 2, totalPrice: 10 },
    ] });

    const res = await call(`/vendors/${v._id}/items-supplied`, { token: store.token });
    const row = res.body.itemsSupplied[0];
    expect(row.quantityByUnit).toEqual(expect.arrayContaining([
      { unit: "m", quantity: 300 }, { unit: "box", quantity: 12 },
    ]));
    expect(row.linesWithNoRecordedUnit).toBe(1);
    /* The pooled quantity 300 + 12 + 5 = 317 must appear nowhere. Prices are
       set so that no legitimate money total is 317 either, or this assertion
       would pass or fail for the wrong reason. */
    expect(row.quantityByUnit.some((q) => q.quantity === 317)).toBe(false);
    expect(JSON.stringify(row.quantityByUnit)).not.toMatch(/317/);
  });
});

/* ═══ 17 · WHAT AN ORDINARY RESPONSE MAY CONTAIN ═════════════════════════ */

describe("the public supplier shape is an allowlist", () => {
  /* Everything internal, sensitive or incidental, on one record. */
  const loaded = async (co) => Vendor.create({
    companyId: co._id, companyName: "Full Mill", supplierCode: "SUP-DTO-1",
    gstNumber: "29ABCDE1234F1Z5", panNumber: "ABCDE1234F",
    email: "a@b.example", contactPerson: "A Buyer", phone: "1",
    bankDetails: { accountName: "Full Mill", accountNumber: "1234567890",
      bankName: "Test", ifscCode: "TEST0001234", branch: "Main" },
    rating: 4, ratingRecordedByName: "Someone", ratingRecordedAt: new Date(),
    isVerified: true, verifiedByName: "Verifier",
    verificationSignature: "data:image/png;base64,SIGNATURE",
    legacySource: "import-2024", migratedAt: new Date(),
    lifecycleHistory: [{ action: "create", toState: "Active",
      operationId: new mongoose.Types.ObjectId() }],
    createdBy: new mongoose.Types.ObjectId(), updatedBy: new mongoose.Types.ObjectId(),
  });

  const FORBIDDEN = [
    "bankDetails", "gstNormalised", "panNormalised", "emailNormalised",
    "lifecycleHistory", "verificationSignature", "__v",
  ];

  test("detail returns only the keys the API means to publish", async () => {
    /* `publicSupplier` copied the whole document and deleted one key, so
       anything added to the model later shipped by default. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await loaded(a);

    const res = await call(`/vendors/${v._id}`, { token: store.token });
    expect(res.status).toBe(200);

    FORBIDDEN.forEach((key) => {
      expect(Object.keys(res.body.vendor)).not.toContain(key);
    });
    expect(JSON.stringify(res.body)).not.toMatch(/1234567890|TEST0001234|SIGNATURE|29ABCDE1234F1Z5$/);

    /* An exact contract, so a field added to the model cannot leak silently. */
    expect(Object.keys(res.body.vendor).sort()).toEqual([
      "_id", "address", "alternatePhone", "archive", "blacklist", "companyName",
      "contactPerson", "createdAt", "email", "gstNumber", "hasBankDetails",
      "legacy", "notes", "panNumber", "phone", "primaryProducts", "rating",
      "ratingReason", "ratingRecordedAt", "ratingRecordedByName", "recordVersion",
      "selectable", "status", "supplierCode", "updatedAt", "vendorType",
    ]);
  });

  test("every other supplier response uses the same shape", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await loaded(a);

    const list = await call("/vendors", { token: store.token });
    const row = list.body.vendors.find((r) => String(r._id) === String(v._id));
    FORBIDDEN.forEach((key) => expect(Object.keys(row)).not.toContain(key));

    const lifecycle = await call(`/vendors/${v._id}/deactivate`, {
      method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Dormant" },
    });
    FORBIDDEN.forEach((key) => expect(Object.keys(lifecycle.body.vendor)).not.toContain(key));
  });
});

/* ═══ 18 · AN UNRELATED EDIT CANNOT ERASE PAYMENT INSTRUCTIONS ═══════════ */

describe("bank instructions survive an ordinary edit", () => {
  const BANK = { accountName: "Mill", accountNumber: "1234567890",
    bankName: "Test Bank", ifscCode: "TEST0001234", branch: "Main" };

  const seeded = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-BANK-1", bankDetails: BANK } });
    return { a, store, v };
  };

  test("the ordinary update refuses a bank object outright", async () => {
    /* The form initialised its bank fields from a detail response that never
       carries them, then submitted the resulting EMPTY object — so renaming a
       supplier wiped its payment instructions. */
    const { store, v } = await seeded();
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Renamed", bankDetails: { accountName: "", accountNumber: "" } },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SUPPLIER_BANK_NOT_EDITABLE_HERE");

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.bankDetails.accountNumber).toBe("1234567890");
    expect(stored.companyName).not.toBe("Renamed");     // whole edit refused
  });

  test("an edit that sends no bank object leaves them byte-for-byte", async () => {
    const { store, v } = await seeded();
    const before = (await Vendor.findById(v._id).lean()).bankDetails;

    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(), body: { companyName: "Renamed", phone: "999" },
    });
    expect(res.status).toBe(200);

    const after = (await Vendor.findById(v._id).lean()).bankDetails;
    expect(after).toEqual(before);
  });

  test("bank details are written only through the private endpoint", async () => {
    const { store, v } = await seeded();
    const viewer = await person({ co: await company("Other"), grant: "store", role: "viewer" });

    const denied = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: viewer.token, idempotencyKey: newKey(),
      body: { accountNumber: "9999999999" },
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect((await Vendor.findById(v._id).lean()).bankDetails.accountNumber).toBe("1234567890");

    const saved = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { accountName: "Mill", accountNumber: "5555555555", bankName: "New Bank",
        ifscCode: "NEWB0001234", branch: "Second" },
    });
    expect(saved.status).toBe(200);
    /* The write confirms, without echoing the value back into a response. */
    expect(JSON.stringify(saved.body)).not.toMatch(/5555555555/);
    expect((await Vendor.findById(v._id).lean()).bankDetails.accountNumber).toBe("5555555555");
  });

  test("the audit records which bank fields changed, never their values", async () => {
    const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
    const { store, v } = await seeded();

    await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { ...BANK, accountNumber: "7777777777" },
    });

    const rows = await SpActionHistory.find({ entityType: "Vendor", entityId: v._id }).lean();
    expect(JSON.stringify(rows)).not.toMatch(/7777777777|1234567890|TEST0001234/);
    const entry = rows.find((r) => /BANK_UPDATE/.test(r.action));
    expect(entry).toBeTruthy();
    expect((entry.changes || []).map((c) => c.field)).toContain("accountNumber");
  });
});

/* ═══ 19 · THE TENANT CONTRACT ON EVERY GOVERNED WRITE ═══════════════════ */

describe("a foreign company is refused on every write, not just two", () => {
  test("lifecycle, assessment and bank update all apply it", async () => {
    const a = await company("Acme");
    const b = await company("Borealis");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-TEN-1" } });

    const attempts = [
      ["deactivate", { reason: "Dormant", companyId: String(b._id) }],
      ["blacklist", { reason: "Quality", companyId: String(b._id) }],
      ["archive", { reason: "Closed", companyId: String(b._id) }],
      ["assessment", { rating: 4, reason: "Good", companyId: String(b._id) }],
    ];

    for (const [op, body] of attempts) {
      const res = await call(`/vendors/${v._id}/${op}`, {
        method: "POST", token: store.token, idempotencyKey: newKey(), body,
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.error?.code || res.body.code).toBe("TENANT_MISMATCH");
    }

    const bank = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { accountNumber: "1", companyId: String(b._id) },
    });
    expect(bank.status).toBeGreaterThanOrEqual(400);
    expect(bank.body.error?.code || bank.body.code).toBe("TENANT_MISMATCH");

    /* Nothing moved. */
    const stored = await Vendor.findById(v._id).lean();
    expect(stored.status).toBe("Active");
    expect(stored.rating == null).toBe(true);
  });
});

/* ═══ 20 · MUTATION AND AUDIT RECOVER TOGETHER ═══════════════════════════ */

describe("an interrupted write is recoverable, once", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
  const actionHistory = require("../../services/storePurchase/actionHistory.service");

  afterEach(() => jest.restoreAllMocks());

  test("create: history fails, the retry recovers instead of colliding", async () => {
    /* The supplier saved, history failed, and the retry hit the duplicate
       supplier code — reporting a conflict for work it had itself done. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const key = newKey();
    const body = { companyName: "Interrupted Mill", supplierCode: "SUP-RECOVER-1" };

    const boom = jest.spyOn(actionHistory, "record")
      .mockRejectedValueOnce(new Error("history unavailable"));

    const first = await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key, body });
    expect(first.status).toBeGreaterThanOrEqual(500);
    boom.mockRestore();

    const retry = await call("/vendors", { method: "POST", token: store.token, idempotencyKey: key, body });
    expect(retry.status).toBe(201);
    expect(retry.body.code).not.toBe("SUPPLIER_CODE_DUPLICATE");

    /* One supplier, and the history that was missing is now there — once. */
    expect(await Vendor.countDocuments({ companyId: a._id, supplierCode: "SUP-RECOVER-1" })).toBe(1);
    const rows = await SpActionHistory.find({
      entityType: "Vendor", action: /SUPPLIER_CREATE/, companyId: a._id,
    }).lean();
    expect(rows).toHaveLength(1);
  });

  test("lifecycle: history fails, the retry backfills without moving state twice", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-RECOVER-2" } });
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const body = { reason: "Repeated short deliveries", expectedVersion: start.body.vendor.recordVersion };

    jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
    const first = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();

    const retry = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.status).toBe(200);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.status).toBe("Blacklisted");
    /* One transition, one history line — not two of either. */
    expect(stored.lifecycleHistory.filter((h) => h.toState === "Blacklisted")).toHaveLength(1);
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /BLACKLIST/,
    }).lean();
    expect(rows).toHaveLength(1);
  });

  test("assessment: an uncertain response does not record it twice", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-RECOVER-3" } });
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const body = { rating: 4, reason: "Consistent quality", expectedVersion: start.body.vendor.recordVersion };

    for (let i = 0; i < 3; i += 1) {
      const res = await call(`/vendors/${v._id}/assessment`, {
        method: "POST", token: store.token, idempotencyKey: key, body,
      });
      expect(res.status).toBe(200);
    }
    const rows = await SpActionHistory.find({
      entityType: "Vendory", entityId: v._id,
    }).lean();
    const assessments = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /ASSESS/,
    }).lean();
    expect(assessments).toHaveLength(1);
  });

  test("an ordinary update retried does not repeat its audit event", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-RECOVER-4" } });
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const body = { companyName: "Renamed Once", expectedVersion: start.body.vendor.recordVersion };

    for (let i = 0; i < 3; i += 1) {
      const res = await call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: key, body,
      });
      expect(res.status).toBe(200);
    }
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /UPDATE/,
    }).lean();
    expect(rows).toHaveLength(1);
  });
});

/* ═══ 21 · SELECTABILITY NEEDS A CODE ════════════════════════════════════ */

describe("only a complete, active, owned supplier may be selected", () => {
  test("a company-owned supplier with no code is visible but not selectable", async () => {
    /* Transitional records — a legacy supplier part-way through migration —
       are exactly the ones a buyer must not bind a new order to. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const incomplete = await supplier({ co: a, over: { supplierCode: "", status: "Active" } });

    const detail = await call(`/vendors/${incomplete._id}`, { token: store.token });
    expect(detail.status).toBe(200);
    expect(detail.body.vendor.selectable).toBe(false);

    const list = await call("/vendors", { token: store.token });
    expect(list.body.vendors.map((v) => String(v._id))).toContain(String(incomplete._id));

    /* And the Item Master will not offer it. */
    const offered = await call("/raw-items/suppliers", { token: store.token });
    expect(offered.body.suppliers.map((s) => String(s.id))).not.toContain(String(incomplete._id));
  });
});

/* ═══ 22 · HISTORY RECORDS WHAT CHANGED ══════════════════════════════════ */

describe("the update audit names every changed field", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

  test("more than companyName and gstNumber", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-HIST-1", contactPerson: "Old", phone: "1" } });

    await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "New Buyer", phone: "2", vendorType: "Fabric Supplier", notes: "n" },
    });

    const row = (await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /UPDATE/,
    }).lean())[0];
    const fields = (row.changes || []).map((c) => c.field);
    expect(fields).toEqual(expect.arrayContaining(["contactPerson", "phone", "vendorType"]));
  });

  test("history pages rather than silently truncating", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-HIST-2" } });

    for (let i = 0; i < 5; i += 1) {
      await call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { contactPerson: `Buyer ${i}` },
      });
    }

    const page = await call(`/vendors/${v._id}/history?limit=2`, { token: store.token });
    expect(page.status).toBe(200);
    expect(page.body.history).toHaveLength(2);
    expect(page.body.pagination.total).toBeGreaterThanOrEqual(5);
    expect(page.body.pagination.hasMore).toBe(true);
  });
});

/* ═══ 23 · ATOMICITY IS REPORTED FROM WHAT ACTUALLY HAPPENED ═════════════ */

describe("the unit of work's mode reaches the response", () => {
  const unitOfWork = require("../../services/storePurchase/unitOfWork.service");
  afterEach(() => jest.restoreAllMocks());

  test("create reports the mode the write actually ran in", async () => {
    /* Every response read `outcome.atomicityDegraded`, which `run` never
       returns — it returns `{result, mode}`. So the field was always
       undefined and every response claimed full atomicity, including on a
       standalone deployment where history is written separately. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Mode Mill", supplierCode: "SUP-MODE-1" },
    });
    expect(res.status).toBe(201);
    /* Whatever this deployment does, the answer must match it. */
    const mode = await unitOfWork.transactionMode();
    expect(res.body.atomicityDegraded).toBe(mode !== "TRANSACTIONAL");
  });

  test("a marked-mode write says so", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    jest.spyOn(unitOfWork, "transactionsAvailable").mockResolvedValue(false);

    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Marked Mill", supplierCode: "SUP-MODE-2" },
    });
    expect(res.status).toBe(201);
    expect(res.body.atomicityDegraded).toBe(true);
  });

  test("lifecycle runs through the unit of work, not a bare update", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-MODE-3" } });

    const spy = jest.spyOn(unitOfWork, "run");
    const res = await call(`/vendors/${v._id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { reason: "Quality" },
    });
    expect(res.status).toBe(200);
    /* The transition, its history and its effect marker are one operation. */
    expect(spy).toHaveBeenCalled();
    expect(res.body).toHaveProperty("atomicityDegraded");
  });

  test("a stale lifecycle request writes no history and marks no effect", async () => {
    const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-MODE-4" } });

    const [first, second] = await Promise.all([
      call(`/vendors/${v._id}/deactivate`, {
        method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Dormant" },
      }),
      call(`/vendors/${v._id}/blacklist`, {
        method: "POST", token: store.token, idempotencyKey: newKey(), body: { reason: "Quality" },
      }),
    ]);

    const rows = await SpActionHistory.find({ entityType: "Vendor", entityId: v._id }).lean();
    /* Exactly one decision, exactly one entry — the loser wrote nothing. */
    expect(rows).toHaveLength(1);
    const winner = [first, second].find((r) => r.status === 200 && !r.body.unchanged);
    expect(rows[0].resultingState).toBe(winner.body.vendor.status);
  });
});

/* ═══ 24 · ORDINARY UPDATES NEED A KEY ═══════════════════════════════════ */

describe("supplier updates are governed writes", () => {
  test("a missing idempotency key is refused before anything is written", async () => {
    /* The route writes audit history, so an ungoverned retry duplicates the
       record of who changed what. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-KEY-1" } });

    /* Deliberately no key — that is what this test is about. */
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, body: { companyName: "No Key" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect((await Vendor.findById(v._id).lean()).companyName).not.toBe("No Key");
  });

  test("the same key with a different payload is refused", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-KEY-2" } });
    const key = newKey();

    const first = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: key, body: { companyName: "One" },
    });
    expect(first.status).toBe(200);

    const different = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: key, body: { companyName: "Two" },
    });
    expect(different.status).toBeGreaterThanOrEqual(400);
    expect((await Vendor.findById(v._id).lean()).companyName).toBe("One");
  });
});

/* ═══ 25 · THE PUBLIC CONTRACT IS COMPLETE, NOT MERELY SAFE ══════════════ */

describe("the public supplier contract", () => {
  test("it carries every intentional field the screens need", async () => {
    /* The allowlist was safe but incomplete: `alternatePhone` was accepted,
       stored and edited, then dropped on the way out — so the field appeared
       blank after every save. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: {
      supplierCode: "SUP-DTO-2", alternatePhone: "0987654321",
      rating: 4, ratingRecordedByName: "A Buyer", ratingRecordedAt: new Date(),
      ratingReason: "Six consistent orders",
    } });

    const res = await call(`/vendors/${v._id}`, { token: store.token });
    expect(res.body.vendor.alternatePhone).toBe("0987654321");
    /* The rating cannot be explained without what it was based on. */
    expect(res.body.vendor.ratingReason).toBe("Six consistent orders");
    expect(res.body.vendor.ratingRecordedByName).toBe("A Buyer");
  });

  test("the register can tell a recorded assessment from a legacy value", async () => {
    /* The list projection dropped `ratingRecordedAt`, so an assessment
       recorded a minute ago rendered as an unverifiable legacy number. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await supplier({ co: a, over: { supplierCode: "SUP-P1", rating: 4,
      ratingRecordedAt: new Date(), ratingRecordedByName: "A Buyer" } });
    await supplier({ co: a, over: { supplierCode: "SUP-P2", rating: 3 } });
    await supplier({ co: a, over: { supplierCode: "SUP-P3" } });

    const res = await call("/vendors", { token: store.token });
    const byCode = Object.fromEntries(res.body.vendors.map((v) => [v.supplierCode, v]));

    expect(byCode["SUP-P1"].ratingRecordedAt).toBeTruthy();
    expect(byCode["SUP-P1"].ratingRecordedByName).toBe("A Buyer");
    expect(byCode["SUP-P2"].rating).toBe(3);
    expect(byCode["SUP-P2"].ratingRecordedAt == null).toBe(true);
    expect(byCode["SUP-P3"].rating == null).toBe(true);

    /* And still no secrets in a list. */
    expect(JSON.stringify(res.body)).not.toMatch(/gstNormalised|lifecycleHistory|bankDetails/);
  });
});

/* ═══ 26 · THE EDIT AUDIT COVERS WHAT CAN BE EDITED ══════════════════════ */

describe("changing any editable field is recorded", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

  test("an address-only change produces a meaningful entry", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: {
      supplierCode: "SUP-AUD-A", address: { city: "Tirupur", state: "TN" },
    } });

    await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { address: { city: "Coimbatore", state: "TN" } },
    });

    const row = (await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /UPDATE/,
    }).lean())[0];
    expect(row).toBeTruthy();
    const fields = (row.changes || []).map((c) => c.field);
    expect(fields.some((f) => /address/.test(f))).toBe(true);
  });

  test("a primary-products change is recorded too", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: {
      supplierCode: "SUP-AUD-B", primaryProducts: ["Cotton Fabric"],
    } });

    await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { primaryProducts: ["Cotton Fabric", "Zippers"] },
    });

    const row = (await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /UPDATE/,
    }).lean())[0];
    expect((row.changes || []).map((c) => c.field)).toContain("primaryProducts");
  });
});

/* ═══ 27 · ACTIVITY PAGES WITHOUT DUPLICATING OR SKIPPING ════════════════ */

describe("supplier activity pagination is stable", () => {
  test("a new event between pages neither duplicates nor hides one", async () => {
    /* Offset paging over an append-only stream: a new entry arriving between
       page 1 and page 2 shifts every later row down, so the last row of page
       one reappears at the top of page two. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-CUR-1" } });

    for (let i = 0; i < 4; i += 1) {
      await call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { contactPerson: `Buyer ${i}` },
      });
    }

    const first = await call(`/vendors/${v._id}/history?limit=2`, { token: store.token });
    expect(first.body.history).toHaveLength(2);
    expect(first.body.pagination.nextCursor).toBeTruthy();
    /* Every row is addressable, for a stable React key as well as paging. */
    first.body.history.forEach((h) => expect(h.id).toBeTruthy());

    /* A new event lands before the next page is asked for. */
    await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "Late Arrival" },
    });

    const second = await call(
      `/vendors/${v._id}/history?limit=2&cursor=${encodeURIComponent(first.body.pagination.nextCursor)}`,
      { token: store.token },
    );
    const firstIds = first.body.history.map((h) => h.id);
    const secondIds = second.body.history.map((h) => h.id);
    expect(secondIds.filter((id) => firstIds.includes(id))).toHaveLength(0);
  });
});

/* ═══ 28 · THE REGISTER'S OWN DTO ════════════════════════════════════════ */

describe("list rows are an explicit contract", () => {
  test("they carry what the register displays, and nothing internal", async () => {
    /* The register reads `vendor.address.city`, which the projection never
       returned, and `selectable`, which was computed only on the detail
       route — so every row rendered as unselectable-looking or blank. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    await supplier({ co: a, over: {
      supplierCode: "SUP-LIST-1", address: { city: "Tirupur", state: "TN" },
      rating: 4, ratingRecordedAt: new Date(), ratingRecordedByName: "A Buyer",
      ratingReason: "Six consistent orders",
      bankDetails: { accountNumber: "1234567890" },
    } });

    const res = await call("/vendors", { token: store.token });
    const row = res.body.vendors[0];

    expect(row.address.city).toBe("Tirupur");
    expect(row.selectable).toBe(true);
    expect(row.legacy).toBe(false);
    expect(row.ratingReason).toBe("Six consistent orders");

    for (const forbidden of ["bankDetails", "gstNormalised", "panNormalised",
      "emailNormalised", "lifecycleHistory", "verificationSignature",
      "createdBy", "updatedBy", "__v", "companyId"]) {
      expect(Object.keys(row)).not.toContain(forbidden);
    }
    expect(JSON.stringify(res.body)).not.toMatch(/1234567890/);
  });

  test("an Active owned supplier with no code is visible but not selectable", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const incomplete = await supplier({ co: a, over: { supplierCode: "" } });

    const res = await call("/vendors", { token: store.token });
    const row = res.body.vendors.find((v) => String(v._id) === String(incomplete._id));
    expect(row).toBeTruthy();
    expect(row.selectable).toBe(false);
  });
});

/* ═══ 29 · CREATION CANNOT WRITE PAYMENT INSTRUCTIONS ════════════════════ */

describe("payment instructions have one door", () => {
  test("a create payload carrying bankDetails is refused", async () => {
    /* Ordinary editing refuses them and the UI says they are restricted —
       while creation quietly accepted and stored them, so the whole
       restriction could be stepped around by setting them at registration. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: {
        companyName: "Backdoor Mill", supplierCode: "SUP-BD-1",
        bankDetails: { accountNumber: "9999999999", ifscCode: "TEST0001234" },
      },
    });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SUPPLIER_BANK_NOT_EDITABLE_HERE");
    expect(await Vendor.countDocuments({ companyName: "Backdoor Mill" })).toBe(0);
  });
});

/* ═══ 30 · INPUT IS TYPED AND BOUNDED ════════════════════════════════════ */

describe("malformed input is refused, never a 500", () => {
  const edit = async (body) => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: `SUP-V${++seq}` } });
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(), body,
    });
    return { res, v };
  };

  test("an empty company name is a validation error, not silently ignored", async () => {
    const { res, v } = await edit({ companyName: "   " });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/Cast|mongoose/i);
    expect((await Vendor.findById(v._id).lean()).companyName).toBeTruthy();
  });

  test("a non-array primaryProducts is refused", async () => {
    const { res } = await edit({ primaryProducts: "Cotton" });
    expect(res.status).toBe(400);
  });

  test("non-string product entries do not throw", async () => {
    const { res } = await edit({ primaryProducts: ["Cotton", 5, null, {}] });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/trim is not a function/i);
  });

  test("a malformed address is refused rather than crashing on trim", async () => {
    for (const address of ["a string", 5, { city: 5 }, { city: {} }, []]) {
      const { res } = await edit({ address });
      expect(res.status).toBe(400);
      expect(res.status).not.toBe(500);
    }
  });

  test("text fields are bounded", async () => {
    const { res } = await edit({ notes: "x".repeat(5001) });
    expect(res.status).toBe(400);
  });

  test("an assessment reason is bounded", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-VA1" } });
    const res = await call(`/vendors/${v._id}/assessment`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { rating: 4, reason: "y".repeat(5001) },
    });
    expect(res.status).toBe(400);
  });

  test("clearing an optional field is intentional and works", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-VC1", notes: "old" } });
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(), body: { notes: "" },
    });
    expect(res.status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).notes).toBe("");
  });
});

/* ═══ 31 · RECOVERY AND CONCURRENCY ON EVERY WRITE ═══════════════════════ */

describe("bank updates recover and do not race", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
  const actionHistory = require("../../services/storePurchase/actionHistory.service");
  afterEach(() => jest.restoreAllMocks());

  test("an interrupted bank update recovers without saving twice", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-BR1" } });
    const key = newKey();
    const start = await call(`/vendors/${v._id}`, { token: store.token });
    const body = { accountName: "Mill", accountNumber: "5555555555",
      bankName: "Bank", ifscCode: "TEST0001234", branch: "Main",
      expectedVersion: start.body.vendor.recordVersion };

    jest.spyOn(actionHistory, "record").mockRejectedValueOnce(new Error("history unavailable"));
    const first = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();

    const retry = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.status).toBe(200);

    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /BANK_UPDATE/,
    }).lean();
    expect(rows).toHaveLength(1);
    expect((await Vendor.findById(v._id).lean()).bankDetails.accountNumber).toBe("5555555555");
  });

  test("a key cannot replay onto a different supplier", async () => {
    /* Same operation, same body, different record: without the target in the
       fingerprint the second call replays the first's answer and the second
       supplier is never touched — while the caller is told it was. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const one = await supplier({ co: a, over: { supplierCode: "SUP-T1" } });
    const two = await supplier({ co: a, over: { supplierCode: "SUP-T2" } });
    const key = newKey();
    const startOne = await call(`/vendors/${one._id}`, { token: store.token });
    const body = { reason: "Dormant", expectedVersion: startOne.body.vendor.recordVersion };

    const first = await call(`/vendors/${one._id}/deactivate`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);

    const second = await call(`/vendors/${two._id}/deactivate`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    /* Either it is refused as a conflict, or it acts on the right supplier —
       never a silent replay that leaves `two` untouched at 200. */
    if (second.status === 200) {
      expect((await Vendor.findById(two._id).lean()).status).toBe("Inactive");
    } else {
      expect(second.status).toBeGreaterThanOrEqual(400);
      expect((await Vendor.findById(two._id).lean()).status).toBe("Active");
    }
  });
});

/* ═══ 32 · OPTIMISTIC CONCURRENCY ON EVERY EDIT ══════════════════════════ */

describe("a stale decision loses cleanly", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");

  const seeded = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: `SUP-VER${++seq}` } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });
    return { a, store, v, version: read.body.vendor.recordVersion };
  };

  test("the version is published so a caller can quote it back", async () => {
    const { version } = await seeded();
    expect(Number.isInteger(version)).toBe(true);
  });

  test("an edit decided against an older version is refused", async () => {
    /* Controlled: the first write is completed BEFORE the second is sent, so
       both were genuinely decided against the same snapshot. `Promise.all`
       proves nothing here — the two calls may simply serialise. */
    const { store, v, version } = await seeded();

    const first = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "First Writer", expectedVersion: version },
    });
    expect(first.status).toBe(200);

    const stale = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "Second Writer", expectedVersion: version },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("SUPPLIER_VERSION_CONFLICT");
    expect(Number.isInteger(stale.body.currentVersion)).toBe(true);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.contactPerson).toBe("First Writer");     // no mutation
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: /UPDATE/,
    }).lean();
    expect(rows).toHaveLength(1);                          // no history
  });

  test("lifecycle, assessment and bank all honour the version", async () => {
    for (const send of [
      (t, id, ver) => call(`/vendors/${id}/deactivate`, {
        method: "POST", token: t, idempotencyKey: newKey(),
        body: { reason: "Dormant", expectedVersion: ver },
      }),
      (t, id, ver) => call(`/vendors/${id}/assessment`, {
        method: "POST", token: t, idempotencyKey: newKey(),
        body: { rating: 4, reason: "Good", expectedVersion: ver },
      }),
      (t, id, ver) => call(`/vendors/${id}/bank-details`, {
        method: "PUT", token: t, idempotencyKey: newKey(),
        body: { accountNumber: "1234512345", expectedVersion: ver },
      }),
    ]) {
      const { store, v, version } = await seeded();
      /* Move the record on, so the caller's version is genuinely stale. */
      await call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { notes: "moved on", expectedVersion: version },
      });

      const stale = await send(store.token, v._id, version);
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("SUPPLIER_VERSION_CONFLICT");
    }
  });

  test("a successful write moves the version on", async () => {
    const { store, v, version } = await seeded();
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "A", expectedVersion: version },
    });
    expect(res.body.vendor.recordVersion).toBe(version + 1);
  });
});

/* ═══ 33 · A MARKER ALWAYS ENDS THE REQUEST ══════════════════════════════ */

describe("an applied effect never falls through into ordinary execution", () => {
  const idempotency = require("../../services/storePurchase/idempotency.service");
  afterEach(() => jest.restoreAllMocks());

  /** A RECOVER claim whose marker carries no usable evidence. */
  const withIncompleteMarker = () => {
    const real = idempotency.begin;
    jest.spyOn(idempotency, "begin").mockImplementation(async (args) => {
      const claim = await real(args);
      /* `PROCEED` is the first-claim outcome; `CLAIMED` was never a value
         this service returns, so the guard silently never fired. */
      if (claim.outcome !== "PROCEED") return claim;
      return {
        outcome: "RECOVER",
        record: { ...claim.record, recoveryReceipt: undefined },
        /* No entityId: exactly the incomplete marker the old code ignored. */
        effect: { entityType: "Vendor", entityId: null },
      };
    });
  };

  test("an incomplete marker is reconciliation-required, not a fresh mutation", async () => {
    /* Every handler entered recovery only when `recovering.entityId` existed
       and otherwise carried on and mutated — so an interrupted write with a
       half-written marker was performed a second time. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-MK1", contactPerson: "Original" } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    withIncompleteMarker();
    const res = await call(`/vendors/${v._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "Should Not Land", expectedVersion: read.body.vendor.recordVersion },
    });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe("RECOVERY_RECONCILIATION_REQUIRED");
    expect((await Vendor.findById(v._id).lean()).contactPerson).toBe("Original");
  });

  test("the same rule holds for creation, assessment and bank", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-MK2" } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });
    const version = read.body.vendor.recordVersion;

    withIncompleteMarker();

    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Ghost Mill", supplierCode: "SUP-MK3" },
    });
    expect(created.status).toBe(409);
    expect(await Vendor.countDocuments({ companyName: "Ghost Mill" })).toBe(0);

    const assessed = await call(`/vendors/${v._id}/assessment`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { rating: 5, reason: "Should not land", expectedVersion: version },
    });
    expect(assessed.status).toBe(409);
    expect((await Vendor.findById(v._id).lean()).rating == null).toBe(true);

    const banked = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { accountNumber: "9999999999", expectedVersion: version },
    });
    expect(banked.status).toBe(409);
    expect((await Vendor.findById(v._id).lean()).bankDetails?.accountNumber || "").toBe("");
  });

  test("a marker naming another supplier does not release the key or mutate", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const target = await supplier({ co: a, over: { supplierCode: "SUP-MK4", contactPerson: "Untouched" } });
    const other = await supplier({ co: a, over: { supplierCode: "SUP-MK5" } });
    const read = await call(`/vendors/${target._id}`, { token: store.token });

    const real = idempotency.begin;
    jest.spyOn(idempotency, "begin").mockImplementation(async (args) => {
      const claim = await real(args);
      /* `PROCEED` is the first-claim outcome; `CLAIMED` was never a value
         this service returns, so the guard silently never fired. */
      if (claim.outcome !== "PROCEED") return claim;
      return {
        outcome: "RECOVER", record: claim.record,
        effect: { entityType: "Vendor", entityId: other._id },
      };
    });

    const res = await call(`/vendors/${target._id}`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { contactPerson: "Wrong Target", expectedVersion: read.body.vendor.recordVersion },
    });
    expect(res.status).toBe(409);
    expect((await Vendor.findById(target._id).lean()).contactPerson).toBe("Untouched");
  });
});

/* ═══ 34 · VALIDATION BEFORE COERCION ════════════════════════════════════ */

describe("malformed values are refused, never coerced", () => {
  test("a non-string company name on create is a validation error", async () => {
    /* `companyName.trim()` ran BEFORE the shape check, so a number or object
       threw and answered 500 with nothing the caller could act on. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    for (const bad of [5, {}, [], true, { toString: () => "x" }]) {
      const res = await call("/vendors", {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { companyName: bad, supplierCode: `SUP-C${++seq}` },
      });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe("SUPPLIER_FIELD_INVALID");
      expect(JSON.stringify(res.body)).not.toMatch(/trim is not a function|\[object Object\]/);
    }
  });

  test("a malformed bank value is refused, not silently blanked", async () => {
    /* `text()` turned every non-string into "", so sending a number erased
       the stored instruction and reported success. */
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: {
      supplierCode: "SUP-BV1",
      bankDetails: { accountName: "Mill", accountNumber: "1234567890", bankName: "B", ifscCode: "TEST0001234", branch: "M" },
    } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    for (const bad of [5, {}, [], true]) {
      const res = await call(`/vendors/${v._id}/bank-details`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { accountNumber: bad, expectedVersion: read.body.vendor.recordVersion },
      });
      expect(res.status).toBe(400);
    }
    expect((await Vendor.findById(v._id).lean()).bankDetails.accountNumber).toBe("1234567890");
  });

  test("an assessment reason must be text, not anything stringifiable", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-AV1" } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    const res = await call(`/vendors/${v._id}/assessment`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { rating: 4, reason: { note: "x" }, expectedVersion: read.body.vendor.recordVersion },
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toMatch(/\[object Object\]/);
  });

  test("clearing a bank field is possible, deliberately", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: {
      supplierCode: "SUP-BV2", bankDetails: { branch: "Old", accountNumber: "1234567890" },
    } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    const res = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: newKey(),
      body: { branch: "", expectedVersion: read.body.vendor.recordVersion },
    });
    expect(res.status).toBe(200);
    expect((await Vendor.findById(v._id).lean()).bankDetails.branch).toBe("");
  });
});

/* ═══ 35 · DUPLICATE ERRORS SPEAK THE SUPPLIER CONTRACT ══════════════════ */

describe("index collisions answer with the stable supplier codes", () => {
  test("a racing duplicate is a 409, not the old vendor wording", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const gst = "29ZZZZZ1234Z1Z5";

    await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "One", supplierCode: "SUP-DUP-A", gstNumber: gst },
    });
    const again = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Two", supplierCode: "SUP-DUP-B", gstNumber: gst },
    });

    expect(again.status).toBe(409);
    expect(again.body.code).toBe("SUPPLIER_GSTIN_DUPLICATE");
    expect(JSON.stringify(again.body)).not.toMatch(/Vendor with this GST number/);
  });
});

/* ═══ 36 · THE BANK ENDPOINT'S ACTUAL PROTECTION ═════════════════════════ */

describe("payment instructions: what is genuinely enforced", () => {
  const BANK = { accountName: "Mill", accountNumber: "1234567890",
    bankName: "B", ifscCode: "TEST0001234", branch: "M" };

  test("it is route separation, not a separate permission — and says so", () => {
    /* The code called it "restricted" while using the same capability as
       ordinary editing. The claim is withdrawn in the source; this pins that
       the withdrawal stays until a real decision is made. */
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "..", "..", "routes", "CMS_Routes", "Inventory", "Vendor-Buyer", "vendor.js"),
      "utf8",
    );
    expect(src).toMatch(/AN UNRESOLVED SECURITY DECISION/);
    expect(src).toMatch(/separation of ROUTE, not of\s+\* permission/);
  });

  test("no bank value reaches any other response, including recovery", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-SEC1", bankDetails: BANK } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    const key = newKey();
    const body = { accountNumber: "5555555555", expectedVersion: read.body.vendor.recordVersion };
    const first = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBe(200);
    const replay = await call(`/vendors/${v._id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });

    for (const payload of [first.body, replay.body]) {
      expect(JSON.stringify(payload)).not.toMatch(/5555555555|1234567890|TEST0001234/);
    }
  });
});

/* ═══ 37 · THE RECEIPT IS PERSISTED, IN THE SHARED SHAPE ═════════════════ */

describe("every supplier write persists a valid recovery receipt", () => {
  const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");
  /* Lane B's constant, not a literal: they own the version and have already
     bumped it once during this work. */
  const { RECOVERY_RECEIPT_VERSION, readFact } = SpIdempotencyRecord;

  /** Read back from Mongo, so strict casting has already been applied. */
  const receiptFor = async (key) => {
    const rec = await SpIdempotencyRecord.findOne({ key }).lean();
    return { record: rec, receipt: rec?.recoveryReceipt || null };
  };

  const owned = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const key = newKey();
    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: key,
      body: { companyName: "Receipt Mill", supplierCode: `SUP-RC${++seq}` },
    });
    expect(created.status).toBe(201);
    return { a, store, id: created.body.vendor._id, createKey: key,
      version: created.body.vendor.recordVersion };
  };

  test("create persists one, with every required field", async () => {
    /* The receipt was nested inside `entry`, and `unitOfWork.run` only reads
       a TOP-LEVEL `receipt` — so the marker was written with none at all and
       every recovery had to reconcile. A mocked mutation return could not
       show that; only the persisted record can. */
    const { id, createKey } = await owned();
    const { record, receipt } = await receiptFor(createKey);

    expect(record.effectAppliedAt || record.status).toBeTruthy();
    expect(receipt).toBeTruthy();
    /* The shared schema's required fields. */
    expect(receipt.v).toBe(RECOVERY_RECEIPT_VERSION);
    expect(receipt.action).toBe("SUPPLIER_CREATE");
    expect(String(receipt.entityId)).toBe(String(id));
    /* Mapped onto fields the schema actually defines. */
    expect(receipt.documentNumber).toMatch(/^SUP-RC/);
    expect(receipt.resultingState).toBe("Active");
    /* Fields the schema does NOT define must not be sent — Mongoose strips
       them silently, so a receipt that "worked" would be quietly lossy. */
    expect(receipt.supplierCode).toBeUndefined();
    expect(receipt.changes).toBeUndefined();
  });

  test("update persists one", async () => {
    const { store, id, version } = await owned();
    const key = newKey();
    const res = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: key,
      body: { contactPerson: "A Buyer", phone: "1234", expectedVersion: version },
    });
    expect(res.status).toBe(200);

    const { receipt } = await receiptFor(key);
    expect(receipt).toBeTruthy();
    expect(receipt.v).toBe(RECOVERY_RECEIPT_VERSION);
    expect(receipt.action).toBe("SUPPLIER_UPDATE");
    expect(String(receipt.entityId)).toBe(String(id));
    /* Field NAMES only, in the schema's own `fields` array. */
    expect(receipt.fields).toEqual(expect.arrayContaining(["contactPerson", "phone"]));
    expect(JSON.stringify(receipt)).not.toMatch(/A Buyer|1234/);
  });

  test("a lifecycle transition persists one", async () => {
    const { store, id, version } = await owned();
    const key = newKey();
    const res = await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key,
      body: { reason: "Repeated short deliveries", expectedVersion: version },
    });
    expect(res.status).toBe(200);

    const { receipt } = await receiptFor(key);
    expect(receipt.v).toBe(RECOVERY_RECEIPT_VERSION);
    expect(receipt.action).toBe("SUPPLIER_BLACKLIST");
    expect(receipt.previousState).toBe("Active");
    expect(receipt.resultingState).toBe("Blacklisted");
    expect(receipt.reason).toBe("Repeated short deliveries");
  });

  test("a bank update persists one, naming fields only", async () => {
    const { store, id, version } = await owned();
    const key = newKey();
    const res = await call(`/vendors/${id}/bank-details`, {
      method: "PUT", token: store.token, idempotencyKey: key,
      body: { accountNumber: "1234567890", ifscCode: "TEST0001234", expectedVersion: version },
    });
    expect(res.status).toBe(200);

    const { receipt } = await receiptFor(key);
    expect(receipt.v).toBe(RECOVERY_RECEIPT_VERSION);
    expect(receipt.action).toBe("SUPPLIER_BANK_UPDATE");
    expect(receipt.fields).toEqual(expect.arrayContaining(["accountNumber", "ifscCode"]));
    /* Not one value, anywhere in the receipt. */
    expect(JSON.stringify(receipt)).not.toMatch(/1234567890|TEST0001234/);
  });

  test("an assessment records what the shared receipt can carry", async () => {
    const { store, id, version } = await owned();
    const key = newKey();
    const res = await call(`/vendors/${id}/assessment`, {
      method: "POST", token: store.token, idempotencyKey: key,
      body: { rating: 4, reason: "Six consistent orders", expectedVersion: version },
    });
    expect(res.status).toBe(200);

    const { receipt } = await receiptFor(key);
    expect(receipt.v).toBe(RECOVERY_RECEIPT_VERSION);
    expect(receipt.action).toBe("SUPPLIER_ASSESS");
    expect(String(receipt.entityId)).toBe(String(id));
    expect(receipt.reason).toBe("Six consistent orders");
    /* The rating rides in the typed `facts` slot Lane B added — the gap I
       reported last pass, now closed. */
    /* Stored as text because a numeric fact cannot survive the shared
       double-build (see the route's note). Exactly recoverable either way. */
    expect(Number(readFact((receipt.facts || []).find((f) => f.key === "rating")))).toBe(4);
    /* And every receipt states its own entity type. */
    expect(receipt.entityType).toBe("Vendor");
    expect(receipt.occurredAt).toBeTruthy();
  });
});

/* ═══ 38 · RECOVERY BEFORE THE VERSION CHECK ═════════════════════════════ */

describe("an interrupted write recovers even though the version moved", () => {
  const actionHistory = require("../../services/storePurchase/actionHistory.service");
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
  afterEach(() => jest.restoreAllMocks());

  const seeded = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const created = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "Interrupt Mill", supplierCode: `SUP-IR${++seq}` },
    });
    return { a, store, id: created.body.vendor._id, version: created.body.vendor.recordVersion };
  };

  /** The effect lands; the history write then fails. */
  const interrupt = () => jest.spyOn(actionHistory, "record")
    .mockRejectedValueOnce(new Error("history unavailable"));

  test("update: the retry recovers and does not answer VERSION_CONFLICT", async () => {
    /* The version check ran BEFORE recovery, so the retry — carrying the same
       `expectedVersion: 0` the first attempt used — was rejected as stale
       against the version its own effect had produced. A caller could never
       get past it. */
    const { store, id, version } = await seeded();
    const key = newKey();
    const body = { contactPerson: "Recovered Buyer", expectedVersion: version };

    interrupt();
    const first = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();

    const stored = await Vendor.findById(id).lean();
    expect(stored.recordVersion).toBe(version + 1);      // the effect landed

    const retry = await call(`/vendors/${id}`, {
      method: "PUT", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.body.code).not.toBe("SUPPLIER_VERSION_CONFLICT");
    expect(retry.status).toBe(200);
    expect(retry.body.recovered).toBe(true);

    /* Exactly one history entry, and it describes the original event. */
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: id, action: "SUPPLIER_UPDATE",
    }).lean();
    expect(rows).toHaveLength(1);
    expect((rows[0].changes || []).map((c) => c.field)).toContain("contactPerson");
  });

  test("lifecycle: the same, and the state is not moved twice", async () => {
    const { store, id, version } = await seeded();
    const key = newKey();
    const body = { reason: "Quality", expectedVersion: version };

    interrupt();
    const first = await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(first.status).toBeGreaterThanOrEqual(500);
    jest.restoreAllMocks();

    const retry = await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.body.code).not.toBe("SUPPLIER_VERSION_CONFLICT");
    expect(retry.status).toBe(200);

    const stored = await Vendor.findById(id).lean();
    expect(stored.status).toBe("Blacklisted");
    expect(stored.recordVersion).toBe(version + 1);      // once, not twice
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: id, action: "SUPPLIER_BLACKLIST",
    }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].previousState).toBe("Active");
    expect(rows[0].resultingState).toBe("Blacklisted");
    expect(rows[0].reason).toBe("Quality");
  });

  test("recovered history describes the ORIGINAL event, not the later state", async () => {
    /* The supplier changes again between the interrupted effect and the
       retry. A recovery that read "current status" would record the wrong
       transition. */
    const { store, id, version } = await seeded();
    const key = newKey();
    const body = { reason: "Quality", expectedVersion: version };

    interrupt();
    await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    jest.restoreAllMocks();

    /* Somebody archives it in the meantime. */
    const now = await call(`/vendors/${id}`, { token: store.token });
    const archived = await call(`/vendors/${id}/archive`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { reason: "Closed", expectedVersion: now.body.vendor.recordVersion },
    });
    expect(archived.status).toBe(200);

    const retry = await call(`/vendors/${id}/blacklist`, {
      method: "POST", token: store.token, idempotencyKey: key, body,
    });
    expect(retry.status).toBe(200);

    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: id, action: "SUPPLIER_BLACKLIST",
    }).lean();
    expect(rows).toHaveLength(1);
    /* Active → Blacklisted, as it happened — NOT Blacklisted → Archived. */
    expect(rows[0].previousState).toBe("Active");
    expect(rows[0].resultingState).toBe("Blacklisted");
  });
});

/* ═══ 39 · expectedVersion IS REQUIRED ═══════════════════════════════════ */

describe("every existing-supplier write states the version it decided against", () => {
  const targets = (id, ver) => [
    ["PUT", `/vendors/${id}`, { contactPerson: "X", ...(ver === undefined ? {} : { expectedVersion: ver }) }],
    ["POST", `/vendors/${id}/deactivate`, { reason: "Dormant", ...(ver === undefined ? {} : { expectedVersion: ver }) }],
    ["POST", `/vendors/${id}/assessment`, { rating: 4, reason: "Good", ...(ver === undefined ? {} : { expectedVersion: ver }) }],
    ["PUT", `/vendors/${id}/bank-details`, { accountNumber: "1234512345", ...(ver === undefined ? {} : { expectedVersion: ver }) }],
  ];

  test("a missing or malformed version is a stable 400", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });

    for (const bad of [undefined, null, 1.5, -1, "0", NaN, {}, []]) {
      const v = await supplier({ co: a, over: { supplierCode: `SUP-EV${++seq}` } });
      for (const [method, path, body] of targets(v._id, bad)) {
        /* `rawCall`, so the harness cannot supply the version this test is
           deliberately withholding or corrupting. */
        const res = await rawCall(path, {
          method, token: store.token, idempotencyKey: newKey(), body,
        });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("SUPPLIER_FIELD_INVALID");
      }
    }
  });

  test("a no-op still has to satisfy the version", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: "SUP-NOOP1", status: "Inactive" } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });

    /* Already inactive: a no-op, and still refused on a stale version. */
    const stale = await call(`/vendors/${v._id}/deactivate`, {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { reason: "Dormant", expectedVersion: read.body.vendor.recordVersion + 5 },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("SUPPLIER_VERSION_CONFLICT");
  });

  test("creation needs no version — there is no supplier yet", async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const res = await call("/vendors", {
      method: "POST", token: store.token, idempotencyKey: newKey(),
      body: { companyName: "No Version Needed", supplierCode: "SUP-NV1" },
    });
    expect(res.status).toBe(201);
  });
});

/* ═══ 40 · CONCURRENT COMPARE-AND-SET, NOT SEQUENTIAL STALENESS ══════════ */

describe("two requests from the same version: exactly one lands", () => {
  const SpActionHistory = require("../../models/CMS_Models/StorePurchase/SpActionHistory");
  const SpIdempotencyRecord = require("../../models/CMS_Models/StorePurchase/SpIdempotencyRecord");

  const seeded = async () => {
    const a = await company("Acme");
    const store = await person({ co: a, grant: "store" });
    const v = await supplier({ co: a, over: { supplierCode: `SUP-CAS${++seq}` } });
    const read = await call(`/vendors/${v._id}`, { token: store.token });
    return { a, store, v, version: read.body.vendor.recordVersion };
  };

  /**
   * Both requests are issued together AND both carry the same explicit
   * version, so they are decided against the same snapshot by construction.
   * Sending one after the other completes only proves stale rejection; it
   * says nothing about whether the compare-and-set is atomic.
   */
  const raceTwo = (first, second) => Promise.all([first, second]);

  test("ordinary update", async () => {
    const { store, v, version } = await seeded();

    const results = await raceTwo(
      call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { contactPerson: "Writer One", expectedVersion: version },
      }),
      call(`/vendors/${v._id}`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { contactPerson: "Writer Two", expectedVersion: version },
      }),
    );

    const won = results.filter((r) => r.status === 200);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].body.code).toBe("SUPPLIER_VERSION_CONFLICT");
    expect(lost[0].body.currentVersion).toBe(version + 1);

    const stored = await Vendor.findById(v._id).lean();
    /* Incremented ONCE — a lost update would leave it at version+1 with the
       loser's value, or at version+2 with both applied. */
    expect(stored.recordVersion).toBe(version + 1);
    expect(stored.contactPerson).toBe(won[0].body.vendor.contactPerson);

    /* Only the winner's history, and only the winner's effect marker. */
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: "SUPPLIER_UPDATE",
    }).lean();
    expect(rows).toHaveLength(1);
    const markers = await SpIdempotencyRecord.find({
      resultEntityId: v._id, operation: "SUPPLIER_UPDATE", effectAppliedAt: { $ne: null },
    }).lean();
    expect(markers).toHaveLength(1);
  });

  test("bank update", async () => {
    const { store, v, version } = await seeded();

    const results = await raceTwo(
      call(`/vendors/${v._id}/bank-details`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { accountNumber: "1111111111", expectedVersion: version },
      }),
      call(`/vendors/${v._id}/bank-details`, {
        method: "PUT", token: store.token, idempotencyKey: newKey(),
        body: { accountNumber: "2222222222", expectedVersion: version },
      }),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.recordVersion).toBe(version + 1);
    /* One of the two, never a blend and never the loser's overwriting the
       winner's. */
    expect(["1111111111", "2222222222"]).toContain(stored.bankDetails.accountNumber);
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: "SUPPLIER_BANK_UPDATE",
    }).lean();
    expect(rows).toHaveLength(1);
  });

  test("assessment", async () => {
    const { store, v, version } = await seeded();

    const results = await raceTwo(
      call(`/vendors/${v._id}/assessment`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { rating: 2, reason: "First judgement", expectedVersion: version },
      }),
      call(`/vendors/${v._id}/assessment`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { rating: 5, reason: "Second judgement", expectedVersion: version },
      }),
    );

    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(1);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.recordVersion).toBe(version + 1);
    /* The rating and the reason belong to the SAME assessment — a lost
       update could pair one person's score with another's stated basis. */
    expect(
      (stored.rating === 2 && stored.ratingReason === "First judgement")
      || (stored.rating === 5 && stored.ratingReason === "Second judgement"),
    ).toBe(true);
    const rows = await SpActionHistory.find({
      entityType: "Vendor", entityId: v._id, action: "SUPPLIER_ASSESS",
    }).lean();
    expect(rows).toHaveLength(1);
  });

  test("lifecycle", async () => {
    const { store, v, version } = await seeded();

    const results = await raceTwo(
      call(`/vendors/${v._id}/deactivate`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { reason: "Dormant", expectedVersion: version },
      }),
      call(`/vendors/${v._id}/blacklist`, {
        method: "POST", token: store.token, idempotencyKey: newKey(),
        body: { reason: "Quality", expectedVersion: version },
      }),
    );

    const won = results.filter((r) => r.status === 200 && !r.body.unchanged);
    const lost = results.filter((r) => r.status === 409);
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);

    const stored = await Vendor.findById(v._id).lean();
    expect(stored.recordVersion).toBe(version + 1);
    expect(stored.status).toBe(won[0].body.vendor.status);

    const rows = await SpActionHistory.find({ entityType: "Vendor", entityId: v._id }).lean();
    const lifecycleRows = rows.filter((r) => /ACTIVATE|DEACTIVATE|BLACKLIST|ARCHIVE/.test(r.action));
    expect(lifecycleRows).toHaveLength(1);
    expect(lifecycleRows[0].resultingState).toBe(stored.status);
  });
});
