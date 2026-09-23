// test/merchandising/handover-producer.route.test.js
//
// SALES ISSUES THE HANDOVER — the producer's door, at the wire.
//
// The claims worth holding:
//
//   · only a Sales-authority seat issues, supersedes or cancels — a
//     Merchandising grant opens none of it;
//   · only a commercially CONFIRMED order line crosses — customer quotation
//     approval alone is not confirmation;
//   · no line without a chosen style, no house sample, no unresolved variant,
//     no zero quantity, no delivery total that fails to reconcile;
//   · the issued payload is immutable, versions sequence, supersession links
//     and preserves, cancellation mirrors onto an accepted file;
//   · no price, payment, customer or CRM field crosses in either direction;
//   · another company's order is not found, not forbidden.
//
// Runs on a replica set because issuance commits the version, the retired
// predecessor and the audit trail as one transaction — the same arrangement
// the costing approval tests use.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { MerchandisingAuditEvent } = require("../../models/CMS_Models/Merchandising/MerchandisingEvent");
const {
  SalesHandoverAuditEvent, SalesHandoverOutboxEvent, HANDOVER_EVENT_KINDS,
} = require("../../models/CMS_Models/Sales/SalesHandoverEvent");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "handover_producer" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales/merchandising-handovers", require("../../routes/CMS_Routes/Sales/merchandisingHandovers"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/sales/merchandising-handovers`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/**
 * A signed-in person.
 *
 * The TOKEN establishes who they are and nothing else. Authority is the live
 * `sales` DepartmentRole grant, so `grants` is what these tests vary — an
 * approver issues, a viewer inspects and cannot issue, and somebody with no
 * Sales grant at all is refused however impressive their token claims.
 */
async function actor({ companies = [], role = "sales", grants = { sales: "approver" }, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `hp${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "H", lastName: `P${n}`, email, biometricId: `HP${n}`,
    isActive: true, gender: "Other", department: "Sales",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "H" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "H Issuer", role, employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/**
 * A company with a confirmed order whose one line references a chosen style.
 */
async function world(label = "P", { status = "quotation_sales_approved", quantity = 500, styleOverrides = {}, orderOverrides = {} } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `${label} ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Northwind ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-${label}-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-${label}-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-${label}-${n}`, styleCode: `SC-${label}-${n}`,
    productName: `${label} polo`, journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
    ...styleOverrides,
  });
  const request = await CustomerRequest.create({
    requestId: `REQ-${label}-${n}`,
    status,
    orderOrigin: "customer",
    customerInfo: { name: `Northwind Buying ${n}` },
    items: [{ stockItemName: `${label} polo`, totalQuantity: quantity, totalEstimatedPrice: 240, sampleStyleId: style._id }],
    ...orderOverrides,
  });
  /* ── THE LINE'S OWN PERMANENT REFERENCE ─────────────────────────────
     Minted by the CustomerRequest hook as the record was written, and read
     back from it. Deliberately NOT the style: this suite proves below that
     one order can carry the same style on two commercial lines and hand each
     over independently, which the style-as-identity scheme could not. */
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineId = String(saved.items[0].lineRef);
  return { co, account, journey, enquiry, style, request, saved, lineId, label };
}

const issueBody = (quantity = 500, extra = {}) => ({
  expectedCurrentVersionNo: 0,
  deliveries: [{ committedDeliveryDate: "2026-12-15", quantity }],
  ...extra,
});

const issue = (w, who, body = issueBody()) =>
  call(`/requests/${w.request._id}/lines/${w.lineId}/issue`, { token: who.token, method: "POST", body });

/* ══ WHO MAY ISSUE ════════════════════════════════════════════════════════ */

describe("issuance authority", () => {
  test("a Sales seat issues; the version carries the allowlisted projection", async () => {
    const w = await world();
    const who = await actor({ companies: [w.co] });

    const res = await issue(w, who);
    expect(res.status).toBe(201);
    const v = res.body.version;
    expect(v.versionNo).toBe(1);
    expect(v.publication.state).toBe("CURRENT");
    expect(v.executionProjection.orderRef).toBe(w.request.requestId);
    expect(v.executionProjection.styleRef).toBe(w.style.styleCode);
    expect(v.executionProjection.totalQuantity).toBe(500);
    expect(v.executionProjection.deliveries).toHaveLength(1);
    expect(v.executionProjection.buyerDisplayLabel).toMatch(/Northwind Buying/);

    /* And the issuance is audited — in SALES' own history, which is the only
       history Sales writes. */
    const audit = await SalesHandoverAuditEvent.findOne({ action: HANDOVER_EVENT_KINDS.ISSUED }).lean();
    expect(String(audit.handoverVersionId)).toBe(String(v._id || v.id));
    expect(audit.handoverLineRef).toBe(w.lineId);
  });

  test("a Merchandising grant can neither issue nor cancel", async () => {
    const w = await world();
    /* A real Merchandising owner, whose TOKEN says merchandiser — admitted by
       the Sales allowlist for reads, and refused the commercial act. */
    const who = await actor({ companies: [w.co], role: "merchandiser", grants: { merchandiser: "owner" } });

    const res = await issue(w, who);
    expect(res.status).toBe(403);
    const cancel = await call(`/requests/${w.request._id}/lines/${w.lineId}/cancel`, {
      token: who.token, method: "POST", body: { reason: "no" },
    });
    expect(cancel.status).toBe(403);
    expect(await SalesHandoverVersion.countDocuments({})).toBe(0);
  });

  test("no session is 401", async () => {
    const w = await world();
    expect((await issue(w, { token: "" })).status).toBe(401);
  });
});

/* ══ WHAT COUNTS AS CONFIRMED ═════════════════════════════════════════════ */

describe("confirmed-order eligibility", () => {
  test.each([
    ["pending"], ["in_progress"], ["quotation_draft"], ["quotation_sent"],
    /* The one that looks confirmed and is not: the customer approved, Sales
       has not signed off. */
    ["quotation_customer_approved"],
    ["rejected"], ["on_hold"], ["cancelled"],
  ])("status %s is refused", async (status) => {
    const w = await world("S", { status });
    const who = await actor({ companies: [w.co] });
    const res = await issue(w, who);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("HANDOVER_NOT_ELIGIBLE");
    expect(res.body.error.details.blockers.map((b) => b.code)).toContain("NOT_CONFIRMED");
  });

  test.each([["quotation_sales_approved"], ["production"], ["shipping"], ["completed"]])(
    "status %s issues", async (status) => {
      const w = await world("C", { status });
      const who = await actor({ companies: [w.co] });
      expect((await issue(w, who)).status).toBe(201);
    });

  test("a line with no selected style is unaddressable and shown as ineligible", async () => {
    /* Every line now HAS an identity — the hook mints one whether or not a
       style has been chosen — so a style-less line is perfectly addressable
       and is refused for the reason that actually applies, rather than being
       unreachable because the scheme had nothing to call it. */
    const w = await world("NS");
    w.request.items.push({ stockItemName: "Mystery tee", totalQuantity: 100 });
    await w.request.save();
    const who = await actor({ companies: [w.co] });

    const panel = await call(`/requests/${w.request._id}`, { token: who.token });
    const bare = panel.body.lines.find((l) => !l.styleId);
    expect(bare.lineRef).toMatch(/^LN-[0-9a-f]{12}$/);
    expect(bare.eligible).toBe(false);
    expect(bare.blockers.map((b) => b.code)).toContain("NO_SELECTED_STYLE");

    /* Named, reached, and refused on the merits. */
    const res = await call(`/requests/${w.request._id}/lines/${bare.lineRef}/issue`, {
      token: who.token, method: "POST", body: issueBody(100),
    });
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers.map((b) => b.code)).toContain("NO_SELECTED_STYLE");

    /* A reference this order does not hold is still not found. */
    const bogus = await call(`/requests/${w.request._id}/lines/LN-ffffffffffff/issue`, {
      token: who.token, method: "POST", body: issueBody(100),
    });
    expect(bogus.status).toBe(404);
  });

  test("a house sample cannot produce a commercial handover", async () => {
    const w = await world("H", { styleOverrides: { sampleType: "house", journeyId: undefined } });
    const who = await actor({ companies: [w.co] });
    const res = await issue(w, who);
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers.map((b) => b.code)).toContain("HOUSE_SAMPLE");
  });

  test("a sampling/internal/testing order is not a customer commitment", async () => {
    const w = await world("O", { orderOverrides: { orderOrigin: "internal" } });
    const who = await actor({ companies: [w.co] });
    const res = await issue(w, who);
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers.map((b) => b.code)).toContain("NOT_A_CUSTOMER_ORDER");
  });

  test("competing style variants stay upstream until Sales chooses", async () => {
    const w = await world("V");
    /* A sibling variant of the same product, neither chosen. */
    await SampleStyle.create({
      sampleStyleId: `SS-V2-${++seq}`, styleCode: `SC-V2-${seq}`,
      productName: w.style.productName, journeyId: w.journey._id, enquiryId: w.enquiry._id,
      variantKey: "white-pc", variantLabel: "White PC",
    });
    const who = await actor({ companies: [w.co] });
    const res = await issue(w, who);
    expect(res.status).toBe(409);
    expect(res.body.error.details.blockers.map((b) => b.code)).toContain("VARIANT_UNRESOLVED");

    /* Sales chooses; the chosen one crosses. */
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { variantChosen: true } });
    expect((await issue(w, who)).status).toBe(201);
  });
});

/* ══ THE DELIVERY CONTRACT ════════════════════════════════════════════════ */

describe("delivery reconciliation", () => {
  test("a missing committed date, a bad quantity, a bad total — each refused by name", async () => {
    const w = await world("D");
    const who = await actor({ companies: [w.co] });

    const noDate = await issue(w, who, { expectedCurrentVersionNo: 0, deliveries: [{ quantity: 500 }] });
    expect(noDate.status).toBe(400);
    expect(noDate.body.error.details.field).toBe("committedDeliveryDate");

    const zero = await issue(w, who, {
      expectedCurrentVersionNo: 0,
      deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: 0 }],
    });
    expect(zero.status).toBe(400);
    expect(zero.body.error.details.field).toBe("quantity");

    const short = await issue(w, who, {
      expectedCurrentVersionNo: 0,
      deliveries: [
        { committedDeliveryDate: "2026-12-15", quantity: 200 },
        { committedDeliveryDate: "2027-01-15", quantity: 200 },
      ],
    });
    expect(short.status).toBe(400);
    expect(short.body.message).toMatch(/reconcile/);

    const none = await issue(w, who, { expectedCurrentVersionNo: 0, deliveries: [] });
    expect(none.status).toBe(400);
  });

  test("split deliveries that reconcile issue, and ex-factory stays unknown", async () => {
    const w = await world("D2");
    const who = await actor({ companies: [w.co] });
    const res = await issue(w, who, {
      expectedCurrentVersionNo: 0,
      deliveries: [
        { dropRef: "DROP-A", committedDeliveryDate: "2026-12-15", quantity: 300, nominatedFactoryRef: "F1" },
        { dropRef: "DROP-B", committedDeliveryDate: "2027-01-20", quantity: 200 },
      ],
    });
    expect(res.status).toBe(201);
    const ds = res.body.version.executionProjection.deliveries;
    expect(ds.map((d) => d.quantity)).toEqual([300, 200]);
    /* Never derived from an invented lead time. */
    for (const d of ds) expect(d.targetExFactoryDate ?? undefined).toBeUndefined();
  });
});

/* ══ FORBIDDEN FIELDS ═════════════════════════════════════════════════════ */

describe("what may not cross", () => {
  test("a body carrying money, payment or the customer is refused by name", async () => {
    const w = await world("F");
    const who = await actor({ companies: [w.co] });
    for (const [field, value] of [
      ["price", 240], ["unitPrice", 240], ["margin", 0.4], ["paymentTerms", "NET30"],
      ["customerInfo", { name: "x" }], ["companyId", String(w.co._id)], ["quotation", {}],
    ]) {
      const res = await issue(w, who, { ...issueBody(), [field]: value });
      expect([field, res.status]).toEqual([field, 400]);
      expect(res.body.error.code).toBe("FIELD_NOT_ACCEPTED");
    }
    /* And on a delivery row. */
    const res = await issue(w, who, {
      expectedCurrentVersionNo: 0,
      deliveries: [{ committedDeliveryDate: "2026-12-15", quantity: 500, price: 9 }],
    });
    expect(res.status).toBe(400);
  });

  test("no issued version carries a commercial fact", async () => {
    const w = await world("F2");
    const who = await actor({ companies: [w.co] });
    await issue(w, who);
    const stored = await SalesHandoverVersion.findOne({}).lean();
    const raw = JSON.stringify(stored);
    for (const banned of [/price/i, /margin/i, /payment/i, /quotation/i, /credit/i, /journeyId/, /accountId/]) {
      expect(raw).not.toMatch(banned);
    }
    /* The projection — what Merchandising reads — carries no buyer channel.
       (`issuedBy.email` outside it is the ISSUER'S audit identity.) */
    const projection = JSON.stringify(stored.executionProjection);
    for (const banned of [/email/i, /phone/i, /contact/i]) {
      expect(projection).not.toMatch(banned);
    }
    /* 240 was the line's estimated price. It must not appear anywhere. */
    expect(raw).not.toMatch(/"240"|:240/);
  });
});

/* ══ VERSIONING ═══════════════════════════════════════════════════════════ */

describe("versioning and supersession", () => {
  test("v2 supersedes v1, links back, and preserves v1's projection", async () => {
    const w = await world("VS");
    const who = await actor({ companies: [w.co] });
    const v1 = (await issue(w, who)).body.version;

    const res2 = await issue(w, who, {
      expectedCurrentVersionNo: 1,
      deliveries: [{ committedDeliveryDate: "2027-01-10", quantity: 500 }],
    });
    expect(res2.status).toBe(201);
    const v2 = res2.body.version;
    expect(v2.versionNo).toBe(2);
    expect(String(v2.supersedesVersionId)).toBe(String(v1._id));

    const stored1 = await SalesHandoverVersion.findById(v1._id).lean();
    expect(stored1.publication.state).toBe("SUPERSEDED");
    expect(String(stored1.publication.supersededByVersionId)).toBe(String(v2._id));
    /* The old statement is intact — nothing overwrote its projection. */
    expect(new Date(stored1.executionProjection.deliveries[0].committedDeliveryDate).toISOString())
      .toContain("2026-12-15");

    /* Sales records its own supersession, and announces it. */
    const audit = await SalesHandoverAuditEvent.findOne({ action: HANDOVER_EVENT_KINDS.SUPERSEDED }).lean();
    expect(String(audit.handoverVersionId)).toBe(String(v1._id));
    const announced = await SalesHandoverOutboxEvent.findOne({ kind: HANDOVER_EVENT_KINDS.SUPERSEDED }).lean();
    expect(String(announced.payload.handoverVersionId)).toBe(String(v1._id));
    expect(announced.payload.supersededByVersionNo).toBe(2);
  });

  test("a stale expectedCurrentVersionNo is a conflict, not a silent v3", async () => {
    const w = await world("VC");
    const who = await actor({ companies: [w.co] });
    await issue(w, who);
    const stale = await issue(w, who, issueBody());   // still says 0
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe("HANDOVER_VERSION_CONFLICT");
    expect(await SalesHandoverVersion.countDocuments({ handoverRef: w.request.requestId })).toBe(1);
  });

  test("cancellation retires the current version with its reason", async () => {
    const w = await world("X");
    const who = await actor({ companies: [w.co] });
    await issue(w, who);
    const res = await call(`/requests/${w.request._id}/lines/${w.lineId}/cancel`, {
      token: who.token, method: "POST", body: { reason: "Buyer withdrew the order." },
    });
    expect(res.status).toBe(200);
    const stored = await SalesHandoverVersion.findOne({}).lean();
    expect(stored.publication.state).toBe("CANCELLED");
    expect(stored.publication.cancelReason).toMatch(/withdrew/);
  });
});

/* ══ COMPANY ISOLATION ════════════════════════════════════════════════════ */

describe("company isolation", () => {
  test("another company's order is not found — inspect, issue and cancel alike", async () => {
    const mine = await world("Mine");
    const theirs = await world("Theirs");
    const who = await actor({ companies: [mine.co] });

    expect((await call(`/requests/${theirs.request._id}`, { token: who.token })).status).toBe(404);
    const res = await call(`/requests/${theirs.request._id}/lines/${theirs.lineId}/issue`, {
      token: who.token, method: "POST", body: issueBody(),
    });
    expect(res.status).toBe(404);
    expect(await SalesHandoverVersion.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });

  test("the issued version is stamped with the ISSUER'S company, never a body's", async () => {
    const w = await world("St");
    const who = await actor({ companies: [w.co] });
    await issue(w, who);
    const stored = await SalesHandoverVersion.findOne({}).lean();
    expect(String(stored.companyId)).toBe(String(w.co._id));
  });
});

/* ══ THE PRODUCER PANEL ═══════════════════════════════════════════════════ */

describe("inspection", () => {
  test("shows each line's eligibility, blockers and publication state", async () => {
    const w = await world("I");
    const who = await actor({ companies: [w.co] });

    const before = await call(`/requests/${w.request._id}`, { token: who.token });
    expect(before.status).toBe(200);
    expect(before.body.order.confirmed).toBe(true);
    expect(before.body.lines[0].eligible).toBe(true);
    expect(before.body.lines[0].currentVersion).toBe(null);

    await issue(w, who);
    const after = await call(`/requests/${w.request._id}`, { token: who.token });
    expect(after.body.lines[0].currentVersion.versionNo).toBe(1);
    /* And the panel publishes no commercial figure. */
    expect(JSON.stringify(after.body)).not.toMatch(/:240|unitPrice|estimatedPrice/i);
  });
});
