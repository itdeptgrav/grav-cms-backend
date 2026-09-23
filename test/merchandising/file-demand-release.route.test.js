// test/merchandising/file-demand-release.route.test.js
//
// RELEASING DEMAND FROM THE FILE SOMEBODY IS ACTUALLY LOOKING AT.
//
// ── THE RULE UNDER TEST ─────────────────────────────────────────────────────
// The release authority asks for three identities: the CustomerRequest, the
// order line's permanent reference, and the exact approved costing version the
// quotation was priced from. The Execution File screen has none of them, and
// the browser must not guess, search for, or be asked to type one in.
//
// So the server resolves them from records the file already points at — the
// accepted Sales version names the order, the file names the line, the line's
// style names the quotation line, and the quotation line names the frozen
// costing version. Nothing is chosen: not the latest version, not a nearby
// line, not a similar scenario.
//
// ── AND THE AUTHORITY IS STILL THE AUTHORITY ────────────────────────────────
// Eligibility, provenance, recovery, idempotency and concurrency are not
// re-decided here. What this suite proves is that the door resolves the RIGHT
// identities, refuses when the answer has changed underneath the reader, shows
// no money, and opens for nobody it should not.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const fs = require("fs");
const path = require("path");
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
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const DemandRelease = require("../../models/CMS_Models/Merchandising/DemandRelease");
const SpendRequest = require("../../models/CMS_Models/Requests/SpendRequest");

const producer = require("../../services/sales/merchandisingHandover.service");
const delivery = require("../../services/integration/salesHandoverDelivery.service");
const approvedOutput = require("../../services/centralCosting/approvedOutput.service");
const projectionHandoff = require("../../services/centralCosting/projectionHandoff.service");
const fileRelease = require("../../services/merchandising/fileDemandRelease.service");
const orderDemandRelease = require("../../services/merchandising/orderDemandRelease.service");
const access = require("../../services/merchandising/access.service");
const costingCaps = require("../../services/centralCosting/capabilities");

let server, base, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "file_demand_release" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/executionRoute"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

afterEach(() => jest.restoreAllMocks());

const call = (p, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed };
  });

async function actor({ companies = [], grants = {} } = {}) {
  const n = ++seq;
  const email = `fd${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "F", lastName: `D${n}`, email, biometricId: `FD${n}`,
    isActive: true, gender: "Other", department: "Merch",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin: false, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({
      companyId: co._id, email, employeeRef: emp._id, personName: `Person ${n}`,
    });
  }
  for (const [departmentSlug, role] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `Person ${n}`, role, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    id: String(emp._id), email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Person ${n}`, role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

/** The frozen provenance a quotation line carries when Sales priced from a costing. */
const sourceStamp = ({ costing, version, style, styleCode, productName, quantity, priceMinor }) => ({
  source: "APPROVED_COSTING",
  costingId: costing._id,
  costingVersionId: version._id,
  costingVersionNumber: version.versionNumber,
  sampleStyleId: style._id,
  styleCode,
  productName,
  scenarioKey: "q1",
  quantity: String(quantity),
  priceTier: "floor",
  unitPriceMinor: priceMinor,
  currency: "INR",
  approvedAt: new Date(),
  fingerprint: approvedOutput.fingerprintOf({
    costingId: String(costing._id),
    versionId: String(version._id),
    scenarioKey: "q1",
    tier: "floor",
    priceMinor,
    currency: "INR",
  }),
});

/**
 * A confirmed, approved-costed order line, issued by Sales and ACCEPTED by
 * Merchandising — so an Execution File exists, exactly as it does on screen.
 */
async function world({ quantity = 500, withCostingSource = true } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `FD ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({
    companyId: co._id, companyName: `Buyer ${n}`, status: "active",
  });
  const journey = await SalesJourney.create({
    journeyId: `SJ-FD-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-FD-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Tee", quantity }],
  });
  const styleCode = `SC-FD-${n}`;
  const productName = `FD${n} polo`;
  const style = await SampleStyle.create({
    sampleStyleId: `SS-FD-${n}`, styleCode, companyId: co._id, productName,
    journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
  });

  const costing = await Costing.create({
    companyId: co._id,
    context: { type: "ENQUIRY_STYLE", primaryId: enquiry._id, externalKey: productName },
    contextSnapshot: { label: productName },
    baseCurrency: "INR", status: "DRAFT",
  });
  const version = await CostingVersion.create({
    companyId: co._id, costingId: costing._id, versionNumber: 1,
    status: "APPROVED", baseCurrency: "INR",
    calculation: { engineVersion: 1, calculatedAt: new Date() },
    scenarios: [{
      key: "q1", label: String(quantity), quantity: String(quantity), isPrimary: true,
      unitCostMinor: 12640, totalCostMinor: 12640 * quantity,
      floor: {
        floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
        trueUnitCostMinor: 12640, markupAmountMinor: 2528, floorPriceMinor: 15200,
      },
    }],
    sourceReferences: [{
      sourceType: "BOM", sourceKey: `SS-FD-${n}`, confidence: "VERIFIED",
      snapshot: [
        { key: "styleCode", text: styleCode },
        { key: "bomApprovalStatus", text: "approved" },
        { key: "bomApprovalRound", num: 2 },
        { key: "sampleStatus", text: "approved" },
      ],
    }],
    provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
  });

  const request = await CustomerRequest.create({
    requestId: `REQ-FD-${n}`,
    status: "quotation_sales_approved",
    orderOrigin: "customer",
    customerInfo: { name: `Buying Office ${n}` },
    items: [{ stockItemName: productName, totalQuantity: quantity, sampleStyleId: style._id }],
    quotations: withCostingSource
      ? [{
        quotationNumber: `Q-FD-${n}`, status: "sales_approved", currency: "INR",
        items: [{
          itemName: productName, sampleStyleId: style._id, quantity,
          unitPrice: 152, basePrice: 152,
          costingSource: sourceStamp({
            costing, version, style, styleCode, productName, quantity, priceMinor: 15200,
          }),
        }],
      }]
      : [],
  });
  const saved = await CustomerRequest.findById(request._id).lean();
  const lineRef = String(saved.items[0].lineRef);

  /* Sales issues, and the announcement is carried to Merchandising exactly as
     the Sales route does after its transaction commits. */
  const { correlationId } = await producer.issue({ companyId: co._id }, {
    requestId: String(request._id),
    lineId: lineRef,
    body: {
      expectedCurrentVersionNo: 0,
      deliveries: [{ committedDeliveryDate: "2026-12-15", quantity }],
    },
    actor: { name: "Sales Person" },
  });
  await delivery.deliverPending({ companyId: co._id, correlationId });

  const approver = await actor({ companies: [co], grants: { merchandiser: "approver" } });
  const t = { token: approver.token, company: co._id };

  const inbox = await call("/handovers", t);
  const handoverId = inbox.body.rows[0].id;
  const accepted = await call(`/handovers/${handoverId}/accept`, { ...t, method: "POST", body: {} });
  if (accepted.status !== 200 && accepted.status !== 201) {
    throw new Error(`accept refused: ${accepted.status} ${JSON.stringify(accepted.body).slice(0, 300)}`);
  }

  return {
    co, style, styleCode, productName, costing, version, request, approver, t,
    quantity,
    fileId: String(accepted.body.file.id),
    orderId: String(request._id),
    lineRef,
    costingVersionId: String(version._id),
  };
}

/** The projection handoff, stubbed so the suite tests the DOOR, not the engine. */
const stubHandoff = () => {
  jest.spyOn(projectionHandoff, "prepare").mockResolvedValue({
    available: true,
    requirements: [
      { requirementId: "mat:a::MATERIAL", selectable: true },
      { requirementId: "svc:b::SERVICE", selectable: true },
    ],
  });
  jest.spyOn(projectionHandoff, "handoff").mockImplementation(async () => ({
    mode: "CREATED",
    drafts: [{ requestId: String(new mongoose.Types.ObjectId()) },
      { requestId: String(new mongoose.Types.ObjectId()) }],
    productRequest: { requestId: String(new mongoose.Types.ObjectId()) },
    serviceRequest: { requestId: String(new mongoose.Types.ObjectId()) },
  }));
};

const get = (w, t = w.t) => call(`/files/${w.fileId}/demand-release`, t);
const post = (w, body, t = w.t) =>
  call(`/files/${w.fileId}/demand-release`, { ...t, method: "POST", body });

/* ═══ 1 · THE FILE RESOLVES THE EXACT COMMAND ═══════════════════════════ */

describe("resolving the command from the file alone", () => {
  test("it finds the exact order line and the frozen costing version", async () => {
    const w = await world();
    const resolved = await fileRelease.resolveCommandFor(
      { companyId: w.co._id, role: "approver" }, w.fileId,
    );

    expect(resolved.ok).toBe(true);
    /* The order behind the accepted Sales version — not the display ref. */
    expect(resolved.orderId).toBe(w.orderId);
    /* The file's permanent line, not a nearby one. */
    expect(resolved.lineRef).toBe(w.lineRef);
    /* The version the QUOTATION was frozen against. */
    expect(resolved.costingVersionId).toBe(w.costingVersionId);
    expect(resolved.expectedVersion).toMatch(/^[0-9a-f]{32}$/);
  });

  test("a second approved version does not become the answer", async () => {
    /* ── NOT "THE LATEST" ─────────────────────────────────────────────
       A newer approved costing exists for the same costing. The quotation
       was never restamped onto it, so the release must still name the one
       the customer was actually priced from. */
    const w = await world();
    const newer = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 2, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q1", label: "500", quantity: "500", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 5500000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "newer", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: w.styleCode },
          { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 },
          { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });

    const resolved = await fileRelease.resolveCommandFor(
      { companyId: w.co._id, role: "approver" }, w.fileId,
    );
    expect(resolved.costingVersionId).toBe(w.costingVersionId);
    expect(resolved.costingVersionId).not.toBe(String(newer._id));
  });

  test("a line never priced from an approved costing is a named blocker, not a guess", async () => {
    const w = await world({ withCostingSource: false });
    const res = await get(w);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(false);
    expect(res.body.blocked.reason).toBe(fileRelease.UNRESOLVED.NO_APPROVED_COSTING_SOURCE);
    expect(res.body.expectedVersion).toBeNull();
    expect(res.body.permitted.release).toBe(false);
  });
});

/* ═══ 2 · THE READ ═══════════════════════════════════════════════════════ */

describe("the file-scoped read", () => {
  test("it answers with the subject, the history and the handle, and writes nothing", async () => {
    const w = await world();
    const before = {
      releases: await DemandRelease.countDocuments({}),
      requests: await SpendRequest.countDocuments({}),
      order: (await CustomerRequest.findById(w.orderId).lean()).updatedAt,
    };

    const res = await get(w);
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
    expect(res.body.blocked).toBeNull();
    expect(res.body.subject.lineRef).toBe(w.lineRef);
    expect(res.body.subject.styleRef).toBe(w.styleCode);
    expect(res.body.subject.orderedQuantity).toBe("500");
    expect(res.body.releases).toEqual([]);
    expect(res.body.current).toBeNull();
    expect(res.body.permitted.release).toBe(true);
    expect(res.body.expectedVersion).toMatch(/^[0-9a-f]{32}$/);

    /* ── A READ IS A READ ─────────────────────────────────────────────── */
    expect(await DemandRelease.countDocuments({})).toBe(before.releases);
    expect(await SpendRequest.countDocuments({})).toBe(before.requests);
    expect((await CustomerRequest.findById(w.orderId).lean()).updatedAt)
      .toEqual(before.order);
  });

  test("it carries no cost, markup, supplier rate or policy value", async () => {
    const w = await world();
    const res = await get(w);
    const raw = JSON.stringify(res.body);

    for (const banned of [
      /unitCostMinor/i, /trueUnitCost/i, /markup/i, /floorPrice/i, /floorMarkup/i,
      /supplier/i, /rate/i, /policy/i, /margin/i, /priceMinor/i, /unitPrice/i,
      /salary/i, /overhead/i, /15200/, /12640/, /2528/,
    ]) {
      expect(raw).not.toMatch(banned);
    }
    /* And the internal identities the browser must never hold. */
    expect(raw).not.toContain(w.costingVersionId);
    expect(raw).not.toContain(w.orderId);
  });

  test("the identity-addressed routes still work, for compatibility", async () => {
    const w = await world();
    const res = await call(
      `/demand-release?orderId=${w.orderId}&lineRef=${w.lineRef}&costingVersionId=${w.costingVersionId}`,
      w.t,
    );
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });
});

/* ═══ 3 · THE COMMAND ════════════════════════════════════════════════════ */

describe("the file-scoped command", () => {
  test("it releases through the authority, with the identities the FILE resolved", async () => {
    const w = await world();
    stubHandoff();
    const read = await get(w);
    const authority = jest.spyOn(orderDemandRelease, "release");

    const res = await post(w, { expectedVersion: read.body.expectedVersion });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("RELEASED");

    /* One release row, naming the identities the FILE resolved. */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0].orderId)).toBe(w.orderId);
    expect(rows[0].lineRef).toBe(w.lineRef);
    expect(String(rows[0].costingVersionId)).toBe(w.costingVersionId);

    /* ── THE AUTHORITY WAS ASKED, AND ASKED CORRECTLY ─────────────────
       Entered exactly once, with the three identities resolved from the
       file — never from the request body, which carried only the handle.
       That real DRAFT spend requests come out of it is proved against the
       REAL handoff in `order-demand-release.integration.test.js`. */
    expect(authority).toHaveBeenCalledTimes(1);
    const [, command] = authority.mock.calls[0];
    expect(String(command.orderId)).toBe(w.orderId);
    expect(command.lineRef).toBe(w.lineRef);
    expect(String(command.costingVersionId)).toBe(w.costingVersionId);

    /* Drafts only — no purchase order, no supplier, no reservation. */
    expect(rows[0].demand.requirementCount).toBe(2);
    expect(rows[0].state).toBe("RELEASED");
  });

  test("a command with no echoed handle is refused before anything happens", async () => {
    const w = await world();
    const res = await post(w, {});
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(fileRelease.CODES.VERSION_REQUIRED);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a stale handle is refused, never silently replaced", async () => {
    /* ── THE SUBSTITUTION THIS PREVENTS ───────────────────────────────
       Between reading the screen and pressing the button, Sales repriced
       the line onto a different approved costing. Acting anyway would
       release demand against a version the person never saw. */
    const w = await world();
    stubHandoff();
    const read = await get(w);
    const stale = read.body.expectedVersion;

    const replacement = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 2, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q1", label: "500", quantity: "500", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 5500000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "repriced", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: w.styleCode },
          { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 },
          { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });
    /* Sales restamps the quotation line onto it. */
    await CustomerRequest.updateOne({ _id: w.orderId }, {
      $set: {
        "quotations.0.items.0.costingSource": sourceStamp({
          costing: w.costing, version: replacement, style: w.style,
          styleCode: w.styleCode, productName: w.productName,
          quantity: w.quantity, priceMinor: 13200,
        }),
        "quotations.0.items.0.unitPrice": 132,
        "quotations.0.items.0.basePrice": 132,
      },
    });

    const res = await post(w, { expectedVersion: stale });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(fileRelease.CODES.VERSION_CHANGED);
    /* Nothing was released against either version. */
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    /* ── AND THE REFUSAL HANDS BACK THE CURRENT ONE ───────────────────
       So the screen can re-read and the person decides again — against
       the replacement, deliberately. */
    const fresh = res.body.error.details.expectedVersion;
    expect(fresh).not.toBe(stale);
    const again = await get(w);
    expect(again.body.expectedVersion).toBe(fresh);

    const done = await post(w, { expectedVersion: fresh });
    expect(done.status).toBe(200);
    const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(String(row.costingVersionId)).toBe(String(replacement._id));
  });

  test("an interrupted claim is recovered through the file route", async () => {
    /* The authority's recovery, reached by file id. The claim is found by
       identity, its frozen command is replayed, and no second set is made. */
    const w = await world();
    stubHandoff();
    const read = await get(w);

    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });
    const crashed = await post(w, { expectedVersion: read.body.expectedVersion });
    expect(crashed.status).toBeGreaterThanOrEqual(400);

    const claim = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(claim.state).toBe("PENDING");
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    jest.restoreAllMocks();
    stubHandoff();

    const recovered = await post(w, { expectedVersion: read.body.expectedVersion });
    expect(recovered.status).toBe(200);
    expect(recovered.body.outcome).toBe("RECOVERED");
    expect(recovered.body.releaseId).toBe(String(claim._id));
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ═══ 4 · WHO MAY, AND WHOSE FILE ═══════════════════════════════════════ */

describe("authority and ownership", () => {
  test("a foreign file and a missing file are the same answer", async () => {
    const mine = await world();
    const theirs = await world();
    const gone = new mongoose.Types.ObjectId();

    const foreign = await call(`/files/${theirs.fileId}/demand-release`, mine.t);
    const missing = await call(`/files/${gone}/demand-release`, mine.t);
    const rubbish = await call("/files/not-an-id/demand-release", mine.t);

    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(rubbish.status).toBe(404);
    expect(foreign.body.error.message).toBe(missing.body.error.message);
    expect(rubbish.body.error.message).toBe(missing.body.error.message);
    /* Nothing about the other company's order crossed the boundary. */
    const raw = JSON.stringify(foreign.body);
    expect(raw).not.toContain(theirs.orderId);
    expect(raw).not.toContain(theirs.costingVersionId);
    expect(raw).not.toContain(theirs.styleCode);

    /* And the command answers identically. */
    const cmd = await call(`/files/${theirs.fileId}/demand-release`, {
      ...mine.t, method: "POST", body: { expectedVersion: "x".repeat(32) },
    });
    expect(cmd.status).toBe(404);
    expect(await DemandRelease.countDocuments({})).toBe(0);
  });

  test("a viewer and an editor may read but not release", async () => {
    const w = await world();
    const read = await get(w);

    for (const role of ["viewer", "editor"]) {
      const person = await actor({ companies: [w.co], grants: { merchandiser: role } });
      const t = { token: person.token, company: w.co._id };

      const seen = await get(w, t);
      expect(seen.status).toBe(200);
      expect(seen.body.permitted.release).toBe(false);

      const tried = await post(w, { expectedVersion: read.body.expectedVersion }, t);
      expect(tried.status).toBe(403);
    }
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("an owner may release, as an approver may", async () => {
    const w = await world();
    stubHandoff();
    const owner = await actor({ companies: [w.co], grants: { merchandiser: "owner" } });
    const t = { token: owner.token, company: w.co._id };
    const read = await get(w, t);
    expect(read.body.permitted.release).toBe(true);

    const res = await post(w, { expectedVersion: read.body.expectedVersion }, t);
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("RELEASED");
  });

  test("no Sales rank holds the release grant, at any level", async () => {
    /* Confirming an order is not committing to buy against it. */
    const C = costingCaps.CAPABILITY || costingCaps.CAPABILITIES || {};
    const grants = costingCaps.DEPARTMENT_CAPABILITIES || costingCaps.GRANTS || {};
    const sales = grants.sales || {};
    for (const rank of Object.keys(sales)) {
      const held = new Set(sales[rank] || []);
      expect(held.has(access.CAPABILITY.PROCUREMENT_RELEASE)).toBe(false);
      expect([...held].some((c) => String(c).includes("procurement"))).toBe(false);
    }
    /* And on the Merchandising ladder it starts at approver. */
    expect(access.ROLE_CAPABILITIES.viewer.has(access.CAPABILITY.PROCUREMENT_RELEASE)).toBe(false);
    expect(access.ROLE_CAPABILITIES.editor.has(access.CAPABILITY.PROCUREMENT_RELEASE)).toBe(false);
    expect(access.ROLE_CAPABILITIES.approver.has(access.CAPABILITY.PROCUREMENT_RELEASE)).toBe(true);
    expect(access.ROLE_CAPABILITIES.owner.has(access.CAPABILITY.PROCUREMENT_RELEASE)).toBe(true);
    expect(Object.keys(sales).length).toBeGreaterThan(0);
  });
});

/* ═══ 5 · NOTHING RELEASES BY ITSELF ════════════════════════════════════ */

describe("the command stays explicit", () => {
  /** A file with its prose removed — a comment naming a service is not a call. */
  const bare = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^[ \t]*\/\/.*$/gm, "");

  const read = (rel) => bare(fs.readFileSync(path.join(__dirname, "..", "..", rel), "utf8"));

  test("accepting a handover releases nothing", async () => {
    /* `world()` accepts a handover as its last step. If acceptance released,
       a row would already exist. */
    const w = await world();
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    const seen = await get(w);
    expect(seen.body.eligible).toBe(true);
    expect(seen.body.releases).toEqual([]);
  });

  test("only the two release routes call the release authority", async () => {
    const router = read("routes/CMS_Routes/Merchandising/executionRoute.js");
    const calls = (router.match(/(orderDemandRelease|fileDemandRelease)\.(release|releaseFromFile)\(/g) || []);
    expect(calls).toHaveLength(2);

    /* No other Merchandising service reaches for it — acceptance, lifecycle,
       selection approval and the pack all leave it alone. */
    for (const rel of [
      "services/merchandising/execution.service.js",
      "services/merchandising/executionPack.service.js",
      "services/merchandising/selection.service.js",
      "services/merchandising/approvalRegister.service.js",
      "services/merchandising/changeControl.service.js",
      "services/sales/merchandisingHandover.service.js",
    ]) {
      expect(read(rel)).not.toMatch(/orderDemandRelease\.release\(|fileDemandRelease\.releaseFromFile\(/);
    }
  });

  test("the file route holds no business rule of its own", async () => {
    /* Everything the authority DECIDES must be asked, not re-implemented. */
    const svc = read("services/merchandising/fileDemandRelease.service.js");
    for (const rule of [
      /CONFIRMED_STATUSES/, /fingerprintOf/, /assertPriorSettled/, /releaseKeyFor/,
      /idempotencyKey/, /createDraftsFromCosting/, /handoffCommand/,
    ]) {
      expect(svc).not.toMatch(rule);
    }

    /* ── AND IT NEVER TOUCHES THE RELEASE RECORD ITSELF ───────────────
       Reading the authority's answer — including the word PENDING, to know
       whether a recovery is offerable — is not the same as writing state.
       The wrapper opens no query on DemandRelease and writes nothing. */
    expect(svc).not.toMatch(/require\([^)]*DemandRelease['"]/);
    expect(svc).not.toMatch(/updateOne\(|findOneAndUpdate\(|deleteOne\(|\.save\(/);
    expect(svc).toMatch(/orderDemandRelease\.activeReleaseFor\(/);
    /* It delegates instead. */
    expect(svc).toMatch(/orderDemandRelease\.stateFor\(/);
    expect(svc).toMatch(/orderDemandRelease\.release\(/);
    expect(svc).toMatch(/execution\.loadOwnedFile\(/);
  });
});

/* ═══ 6 · A STARTED COMMAND OUTRANKS TODAY'S QUOTATION ══════════════════ */

describe("recovery survives a reprice", () => {
  /**
   * ── THE STRANDING THIS PREVENTS ───────────────────────────────────────────
   * The screen reads version A and gets handle A. A release commits a PENDING
   * claim for A. Sales then reprices the line onto B. The user retries with
   * handle A — and a wrapper that joined today's quotation first would answer
   * "version changed", so the committed A claim would never reach the
   * authority's recovery path and could sit unfinished for ever, with its
   * demand unaccounted for.
   */

  /** Sales reprices the line onto a second approved version, and A's live
   *  provenance is broken so a fresh A attempt could not verify. */
  async function repriceOntoB(w) {
    const b = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 2, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q1", label: "500", quantity: "500", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 5500000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "repriced", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: w.styleCode },
          { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 },
          { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });
    await CustomerRequest.updateOne({ _id: w.orderId }, {
      $set: {
        "quotations.0.items.0.costingSource": sourceStamp({
          costing: w.costing, version: b, style: w.style,
          styleCode: w.styleCode, productName: w.productName,
          quantity: w.quantity, priceMinor: 13200,
        }),
        "quotations.0.items.0.unitPrice": 132,
        "quotations.0.items.0.basePrice": 132,
      },
    });
    return b;
  }

  /** A committed PENDING claim for version A: the handoff died before it
   *  raised anything, so the claim is real and unfinished. */
  async function pendingOnA(w) {
    const read = await get(w);
    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });
    const crashed = await post(w, { expectedVersion: read.body.expectedVersion });
    expect(crashed.status).toBeGreaterThanOrEqual(400);

    const claim = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(claim.state).toBe("PENDING");
    expect(String(claim.costingVersionId)).toBe(w.costingVersionId);
    return { handleA: read.body.expectedVersion, claim };
  }

  test("the read still offers the A claim and handle A after the reprice", async () => {
    const w = await world();
    stubHandoff();
    const { handleA, claim } = await pendingOnA(w);
    jest.restoreAllMocks();
    stubHandoff();

    const b = await repriceOntoB(w);

    /* ── PROVED, NOT ASSUMED: A FRESH A ATTEMPT WOULD NOW FAIL ────────
       The quotation no longer names A, so the ordinary verification the
       authority runs on a new attempt could not admit it. If that were not
       true, the recovery below would prove nothing. */
    const fresh = await orderDemandRelease.stateFor(
      { companyId: w.co._id, role: "approver" },
      { orderId: w.orderId, lineRef: w.lineRef, costingVersionId: w.costingVersionId },
    );
    expect(fresh.subject).toBeNull();
    expect(fresh.blocked).toBeTruthy();

    /* ── AND YET THE FILE OFFERS THE RETRY ────────────────────────────── */
    const res = await get(w);
    expect(res.status).toBe(200);
    expect(res.body.expectedVersion).toBe(handleA);
    expect(res.body.recoverable).toEqual({ releaseId: String(claim._id), state: "PENDING" });
    expect(res.body.permitted.release).toBe(true);
    /* The row is visible in the history so the screen can say what is unfinished. */
    expect(res.body.releases.map((r) => r.state)).toContain("PENDING");
    /* Still nothing confidential, and still no internal identity. */
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(w.costingVersionId);
    expect(raw).not.toContain(String(b._id));
    expect(raw).not.toContain(w.orderId);
    expect(raw).not.toMatch(/markup|floorPrice|unitCost|supplier|policy|13200|15200/i);
  });

  test("handle A recovers the same claim and the same spend requests", async () => {
    const w = await world();
    stubHandoff();
    /* A first attempt that DID raise requests, then died before finishing. */
    const read = await get(w);
    const handleA = read.body.expectedVersion;
    const realUpdate = DemandRelease.updateOne.bind(DemandRelease);
    jest.spyOn(DemandRelease, "updateOne").mockImplementationOnce(() => {
      throw new Error("simulated crash after the requests were created");
    });
    const crashed = await post(w, { expectedVersion: handleA });
    expect(crashed.status).toBeGreaterThanOrEqual(400);
    DemandRelease.updateOne = realUpdate;
    jest.restoreAllMocks();
    stubHandoff();

    const claim = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(claim.state).toBe("PENDING");
    const frozenIds = [...claim.handoffCommand.requirementIds];
    expect(frozenIds.length).toBeGreaterThan(0);

    await repriceOntoB(w);

    const res = await post(w, { expectedVersion: handleA });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("RECOVERED");
    expect(res.body.releaseId).toBe(String(claim._id));

    /* ── ONE RELEASE, ONE DEMAND SET, THE FROZEN COMMAND ──────────────── */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("RELEASED");
    /* Still version A — the reprice did not move the started command. */
    expect(String(rows[0].costingVersionId)).toBe(w.costingVersionId);
    expect(rows[0].handoffCommand.requirementIds).toEqual(frozenIds);
    expect(rows[0].demand.requirementCount).toBe(2);
  });

  test("handle B cannot take a line whose A claim is still PENDING", async () => {
    const w = await world();
    stubHandoff();
    const { claim } = await pendingOnA(w);
    jest.restoreAllMocks();
    stubHandoff();

    await repriceOntoB(w);

    /* The read after a reprice offers A. B's handle is what a caller would
       have to construct deliberately — so it is computed here from the
       resolution the service itself would make for a line with no claim. */
    const identity = await fileRelease.resolveCommandFor(
      { companyId: w.co._id, role: "approver" }, w.fileId,
    );
    const handleB = identity.expectedVersion;
    const readNow = await get(w);
    expect(handleB).not.toBe(readNow.body.expectedVersion);

    const res = await post(w, { expectedVersion: handleB });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);

    /* ── THE A CLAIM IS EXACTLY AS IT WAS ─────────────────────────────── */
    const rows = await DemandRelease.find({ companyId: w.co._id }).lean();
    expect(rows).toHaveLength(1);
    expect(String(rows[0]._id)).toBe(String(claim._id));
    expect(rows[0].state).toBe("PENDING");
    expect(String(rows[0].costingVersionId)).toBe(w.costingVersionId);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);

    /* And handle A still finishes it. */
    const recovered = await post(w, { expectedVersion: readNow.body.expectedVersion });
    expect(recovered.status).toBe(200);
    expect(recovered.body.outcome).toBe("RECOVERED");
  });

  test("with no claim in force, a stale handle is still refused", async () => {
    /* The stale check did not go away — it moved behind the durable claim. */
    const w = await world();
    stubHandoff();
    const read = await get(w);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);

    await repriceOntoB(w);

    const res = await post(w, { expectedVersion: read.body.expectedVersion });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe(fileRelease.CODES.VERSION_CHANGED);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(0);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("another company cannot see or finish this claim", async () => {
    const w = await world();
    stubHandoff();
    const { handleA, claim } = await pendingOnA(w);
    jest.restoreAllMocks();
    stubHandoff();
    await repriceOntoB(w);

    const stranger = await world();
    const foreign = await call(`/files/${w.fileId}/demand-release`, stranger.t);
    const missing = await call(
      `/files/${new mongoose.Types.ObjectId()}/demand-release`, stranger.t,
    );
    expect(foreign.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(foreign.body.error.message).toBe(missing.body.error.message);

    const tried = await call(`/files/${w.fileId}/demand-release`, {
      ...stranger.t, method: "POST", body: { expectedVersion: handleA },
    });
    expect(tried.status).toBe(404);

    const after = await DemandRelease.findById(claim._id).lean();
    expect(after.state).toBe("PENDING");
  });
});

/* ═══ 7 · A RELEASED PREDECESSOR IS HISTORY, NOT A FULL STOP ════════════ */

describe("offering the successor after a reprice", () => {
  /**
   * ── WHAT USED TO GO WRONG ─────────────────────────────────────────────────
   * The read took its handle from whatever release was in force, PENDING or
   * RELEASED alike. That is right for PENDING and wrong for RELEASED: once A
   * was released and the price moved to B, the read kept publishing A's
   * handle, so pressing the button only ever answered "already released". The
   * browser could never obtain B's handle, and the successor flow the
   * authority already implements was unreachable from the file.
   */

  /** Give the released row's referenced requests a real, stated status. */
  async function seedPriorRequests(w, ids, status) {
    await SpendRequest.insertMany(ids.map((id, i) => ({
      _id: id,
      companyId: w.co._id,
      requestNumber: `SR-FD-${++seq}-${i}`,
      requestType: i === 0 ? "PRODUCT" : "SERVICE",
      status,
      title: "Released demand",
      purpose: "Confirmed order line",
      requestedBy: new mongoose.Types.ObjectId(),
      createdByEmployee: new mongoose.Types.ObjectId(),
      items: [{
        name: "Fabric", whyNeeded: "Confirmed order line",
        quantity: 100, unit: "Metre", rate: 100, amount: 10000,
      }],
    })));
  }

  async function repriceOntoB(w) {
    const b = await CostingVersion.create({
      companyId: w.co._id, costingId: w.costing._id, versionNumber: 2, status: "APPROVED",
      baseCurrency: "INR", calculation: { engineVersion: 1, calculatedAt: new Date() },
      scenarios: [{
        key: "q1", label: "500", quantity: "500", isPrimary: true,
        unitCostMinor: 11000, totalCostMinor: 5500000,
        floor: {
          floorMarkupPercent: "20", calculationMethod: "MARKUP_ON_TRUE_COST",
          trueUnitCostMinor: 11000, markupAmountMinor: 2200, floorPriceMinor: 13200,
        },
      }],
      sourceReferences: [{
        sourceType: "BOM", sourceKey: "successor", confidence: "VERIFIED",
        snapshot: [{ key: "styleCode", text: w.styleCode },
          { key: "bomApprovalStatus", text: "approved" },
          { key: "bomApprovalRound", num: 2 },
          { key: "sampleStatus", text: "approved" }],
      }],
      provenance: { origin: "SALES_PREPARATION", createdAt: new Date() },
    });
    await CustomerRequest.updateOne({ _id: w.orderId }, {
      $set: {
        "quotations.0.items.0.costingSource": sourceStamp({
          costing: w.costing, version: b, style: w.style,
          styleCode: w.styleCode, productName: w.productName,
          quantity: w.quantity, priceMinor: 13200,
        }),
        "quotations.0.items.0.unitPrice": 132,
        "quotations.0.items.0.basePrice": 132,
      },
    });
    return b;
  }

  /** Version A released, its demand referenced, and the handle that did it. */
  async function releasedOnA() {
    const w = await world();
    stubHandoff();
    const read = await get(w);
    const handleA = read.body.expectedVersion;
    const done = await post(w, { expectedVersion: handleA });
    expect(done.status).toBe(200);
    const row = await DemandRelease.findOne({ companyId: w.co._id }).lean();
    expect(row.state).toBe("RELEASED");
    return { w, handleA, row, priorIds: row.demand.spendRequestIds.map(String) };
  }

  test("with the quotation still on A, it reads as released and offers nothing", async () => {
    const { w, handleA, row } = await releasedOnA();
    const res = await get(w);

    expect(res.status).toBe(200);
    expect(res.body.expectedVersion).toBe(handleA);
    expect(res.body.current.releaseId).toBe(String(row._id));
    expect(res.body.current.state).toBe("RELEASED");
    expect(res.body.recoverable).toBeNull();
    /* Nothing further to do on this line. */
    expect(res.body.eligible).toBe(false);
    expect(res.body.permitted.release).toBe(false);
  });

  test("prior demand still open publishes B's handle but refuses the release", async () => {
    const { w, handleA, priorIds } = await releasedOnA();
    await seedPriorRequests(w, priorIds, "approved");
    const b = await repriceOntoB(w);

    const res = await get(w);
    expect(res.status).toBe(200);
    /* ── THE HANDLE MOVED ON ──────────────────────────────────────────── */
    expect(res.body.expectedVersion).not.toBe(handleA);
    /* ── BUT THE ANSWER IS STILL NO, AND IT SAYS WHY ─────────────────── */
    expect(res.body.permitted.release).toBe(false);
    expect(res.body.eligible).toBe(false);
    expect(res.body.blocked.reason).toBe(orderDemandRelease.BLOCKED.PRIOR_DEMAND_ACTIVE);
    /* ── AND THE RELEASED ROW IS STILL PRESENTED ──────────────────────── */
    expect(res.body.current.state).toBe("RELEASED");
    expect(res.body.releases).toHaveLength(1);
    /* Still no money and no internal identity. */
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(String(b._id));
    expect(raw).not.toContain(w.costingVersionId);
    expect(raw).not.toMatch(/markup|floorPrice|unitCost|supplier|13200|15200/i);

    /* And the command refuses too, with the same rule. */
    const tried = await post(w, { expectedVersion: res.body.expectedVersion });
    expect(tried.status).toBe(409);
    expect(tried.body.error.details.reason).toBe(orderDemandRelease.BLOCKED.PRIOR_DEMAND_ACTIVE);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("prior demand that cannot be found fails closed, and says so distinctly", async () => {
    /* ── MISSING IS NOT CLOSED ────────────────────────────────────────
       Only one of the two referenced requests exists. The other's state is
       unknown, and unknown must never read as "nothing is active". */
    const { w, priorIds } = await releasedOnA();
    await seedPriorRequests(w, [priorIds[0]], "rejected");
    await repriceOntoB(w);

    const res = await get(w);
    expect(res.body.permitted.release).toBe(false);
    expect(res.body.blocked.reason)
      .toBe(orderDemandRelease.BLOCKED.PRIOR_DEMAND_UNVERIFIABLE);
    /* Distinct from the "still open" answer. */
    expect(res.body.blocked.reason)
      .not.toBe(orderDemandRelease.BLOCKED.PRIOR_DEMAND_ACTIVE);

    const tried = await post(w, { expectedVersion: res.body.expectedVersion });
    expect(tried.status).toBe(409);
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    expect(await SpendRequest.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("with every prior request closed, the successor is offered and can be taken", async () => {
    const { w, handleA, row, priorIds } = await releasedOnA();
    await seedPriorRequests(w, priorIds, "rejected");
    const b = await repriceOntoB(w);

    const res = await get(w);
    expect(res.status).toBe(200);
    const handleB = res.body.expectedVersion;
    expect(handleB).not.toBe(handleA);
    expect(res.body.eligible).toBe(true);
    expect(res.body.permitted.release).toBe(true);
    expect(res.body.blocked).toBeNull();
    /* A is still shown as what is currently released. */
    expect(res.body.current.releaseId).toBe(String(row._id));

    /* ── AND POSTING B RAISES ONE SUCCESSOR, LINKED TO A ──────────────── */
    const done = await post(w, { expectedVersion: handleB });
    expect(done.status).toBe(200);
    expect(done.body.outcome).toBe("RELEASED_SUPERSEDING");

    const rows = await DemandRelease.find({ companyId: w.co._id })
      .sort({ releasedAt: 1 }).lean();
    expect(rows).toHaveLength(2);
    expect(rows[0].state).toBe("SUPERSEDED");
    expect(rows[1].state).toBe("RELEASED");
    expect(String(rows[1].costingVersionId)).toBe(String(b._id));
    expect(String(rows[1].supersedesReleaseId)).toBe(String(rows[0]._id));
    expect(String(rows[0].supersededByReleaseId)).toBe(String(rows[1]._id));
    /* Exactly one active slot. */
    expect(rows.filter((r) => ["PENDING", "RELEASED"].includes(r.state))).toHaveLength(1);
  });

  test("the old released handle still answers ALREADY_RELEASED and creates nothing", async () => {
    const { w, handleA, row, priorIds } = await releasedOnA();
    await seedPriorRequests(w, priorIds, "rejected");
    await repriceOntoB(w);

    const res = await post(w, { expectedVersion: handleA });
    expect(res.status).toBe(200);
    expect(res.body.outcome).toBe("ALREADY_RELEASED");
    expect(res.body.releaseId).toBe(String(row._id));

    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
    const after = await DemandRelease.findById(row._id).lean();
    expect(after.state).toBe("RELEASED");
    expect(String(after.costingVersionId)).toBe(w.costingVersionId);
  });

  test("a PENDING claim still outranks the repriced quotation", async () => {
    /* The dominance rule did not change when RELEASED stopped being dominant. */
    const w = await world();
    stubHandoff();
    const read = await get(w);
    const handleA = read.body.expectedVersion;

    jest.spyOn(projectionHandoff, "handoff").mockImplementationOnce(() => {
      throw new Error("simulated crash before any request was created");
    });
    const crashed = await post(w, { expectedVersion: handleA });
    expect(crashed.status).toBeGreaterThanOrEqual(400);
    jest.restoreAllMocks();
    stubHandoff();

    await repriceOntoB(w);

    const res = await get(w);
    expect(res.body.expectedVersion).toBe(handleA);
    expect(res.body.recoverable.state).toBe("PENDING");
    expect(res.body.permitted.release).toBe(true);

    const recovered = await post(w, { expectedVersion: handleA });
    expect(recovered.status).toBe(200);
    expect(recovered.body.outcome).toBe("RECOVERED");
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });

  test("a viewer and an editor see the successor state but get no release control", async () => {
    const { w, priorIds } = await releasedOnA();
    await seedPriorRequests(w, priorIds, "rejected");
    await repriceOntoB(w);

    const approverRead = await get(w);
    expect(approverRead.body.permitted.release).toBe(true);

    for (const role of ["viewer", "editor"]) {
      const person = await actor({ companies: [w.co], grants: { merchandiser: role } });
      const t = { token: person.token, company: w.co._id };

      const seen = await get(w, t);
      expect(seen.status).toBe(200);
      /* They can read the situation — eligible, and what is released. */
      expect(seen.body.eligible).toBe(true);
      expect(seen.body.current.state).toBe("RELEASED");
      /* But never the control. */
      expect(seen.body.permitted.release).toBe(false);

      const tried = await post(w, { expectedVersion: seen.body.expectedVersion }, t);
      expect(tried.status).toBe(403);
    }
    expect(await DemandRelease.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});
