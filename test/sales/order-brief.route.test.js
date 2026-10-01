// test/sales/order-brief.route.test.js
//
// The order brief, through its real route, against real models.
//
// The labelling rules are unit-tested with plain objects in
// services/orderBrief/assembleOrderBrief.test.js. This suite exists for the
// two things plain objects cannot catch:
//
//   1. FIELD PATHS. Every record here is created with Model.create(), so a
//      strict schema silently drops any field under a name the model does not
//      have. If the read model looked for a field by the wrong name, the value
//      would simply be absent and an assertion below would fail — which is the
//      point.
//   2. TENANCY. A CustomerRequest has no companyId. Whether another company's
//      order can be read is decided by proofs that only run against a
//      database.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  recordChange: async () => ({}), historyFor: async () => [], diff: () => ({}),
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const mw = (req, res, next) => {
    if (!global.__ACTOR__) return res.status(401).json({ success: false });
    req.user = global.__ACTOR__;
    next();
  };
  mw.withRoles = () => mw;
  return mw;
});

const express = require("express");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
const SalesHandoverVersion = require("../../models/CMS_Models/Sales/SalesHandoverVersion");
const ExecutionFile = require("../../models/CMS_Models/Merchandising/ExecutionFile");
const { PackagingRevision, MaterialTrimRevision } = require("../../models/CMS_Models/Merchandising/SelectionRevision");

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/sales/order-brief", require("../../routes/CMS_Routes/OrderBrief/orderBrief"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/sales/order-brief`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});
afterEach(() => {
  global.__ACTOR__ = null;
});

let seq = 0;
const D = (s) => new Date(`2026-${s}T10:00:00Z`);

async function get(id) {
  const res = await fetch(`${base}/requests/${id}`);
  return { status: res.status, body: await res.json(), headers: res.headers };
}

/** A Sales user who is a member of `co`, as the real scope resolves them. */
async function memberOf(co) {
  const n = ++seq;
  const email = `ob-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "O", lastName: `B${n}`, email, biometricId: `OB${n}`,
    isActive: true, gender: "Other", department: "Sales",
  });
  await DeptUser.create({
    name: "Sales", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: `O B${n}` });
  return { id: String(emp._id), email, name: `O B${n}`, employeeId: emp.biometricId };
}

const company = (label) => Acc_Company.create({ companyName: `${label} ${++seq}`, booksFromDate: D("04-01") });

const quotation = (over = {}) => ({
  quotationNumber: `QT-${++seq}`,
  revision: 1,
  status: "sales_approved",
  grandTotal: 118000,
  customerApproval: { approved: true, approvedAt: D("08-01"), approvedBy: new mongoose.Types.ObjectId() },
  salesApproval: { approved: true, approvedAt: D("08-02") },
  poProof: { poNumber: "PO-7781", poDate: D("07-30"), poValue: 118000, url: "https://drive.example/po.pdf", name: "po.pdf", uploadedAt: D("08-02") },
  items: [{ itemName: "Polo shirt", quantity: 500, unitPrice: 200 }],
  ...over,
});

/**
 * A complete, real order: company, buyer account with defaults, journey, the
 * enquiry the order was raised from, an approved style, the order itself,
 * a current handover, and Merchandising's approved packaging.
 */
async function world({ withStyle = true, sole = true } = {}) {
  const co = await company("Grav");
  if (!sole) await company("Other");

  const account = await Account.create({
    companyId: co._id, companyName: `Acme Retail ${seq}`, status: "active",
    garmentSalesProfile: {
      defaultAqlLevel: "AQL 4.0",
      packagingManualRef: "Acme packaging manual 2025",
      requiredCertifications: ["oeko_tex"],
    },
  });
  const journey = await SalesJourney.create({
    journeyId: `SJ-OB-${++seq}`, companyId: co._id, name: "Polo programme",
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
    po: { number: "PO-7781", file: { name: "po.pdf", url: "https://drive.example/po.pdf" }, recordedAt: D("08-03"), recordedBy: { name: "Sana" } },
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-OB-${seq}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: "Polos", isActive: true,
    products: [{ product: "Polo shirt", quantity: 500, fabricPreference: "Pique", gsm: "220" }],
  });

  const style = withStyle ? await SampleStyle.create({
    sampleStyleId: `SS-OB-${seq}`, styleCode: `SC-OB-${seq}`, variantKey: "navy",
    productName: "Polo shirt", journeyId: journey._id, enquiryId: enquiry._id,
    stage: "rnd", materials: { status: "selected", rawItems: [] },
    sample: {
      status: "approved", approvedAt: D("07-25"),
      rounds: [{ roundNo: 1, type: "pp", outcome: "accepted", judgedAt: D("07-25") }],
    },
    customerApproval: {
      approved: true, decidedAt: D("07-26"), decidedBy: { name: "Sana" }, note: "Keep collar",
      log: [{ approved: true, decidedAt: D("07-26") }],
    },
    techSheet: {
      status: "approved",
      file: { name: "tp.pdf", url: "https://drive.example/tp.pdf" },
      technical: { status: "approved", revision: 2 },
      technicalRevisions: [{
        revision: 2, outcome: "approved",
        submittedAt: D("07-23"), submittedBy: { name: "Ravi" }, decidedAt: D("07-24"),
        file: { name: "tp.pdf", url: "https://drive.example/tp.pdf" },
        snapshot: { materials: [{ rawItemName: "Pique 220gsm", specification: "100% cotton", unit: "m" }] },
      }],
    },
  }) : null;

  const request = await CustomerRequest.create({
    requestId: `CR-OB-${seq}`,
    customerId: new mongoose.Types.ObjectId(),
    customerInfo: { name: "Acme Retail", email: "buyer@acme.test", phone: "999", deliveryDeadline: D("10-15") },
    salesOrigin: { enquiryId: enquiry._id },
    status: "quotation_sales_approved",
    quotations: [quotation()],
    items: [{
      ...(style ? { sampleStyleId: style._id } : {}),
      stockItemName: "Polo shirt", stockItemReference: "POLO-1", totalQuantity: 500,
      variants: [{ attributes: [{ name: "Size", value: "M" }], quantity: 500 }],
    }],
  });
  const lineRef = request.items[0].lineRef;

  return { co, account, journey, enquiry, style, request, lineRef };
}

async function issueHandover(w, { versionNo = 1, state = "CURRENT", issuedAt = D("08-05"), packing = "Single polybag", _id } = {}) {
  return SalesHandoverVersion.create({
    ...(_id ? { _id } : {}),
    companyId: w.co._id,
    handoverRef: w.request.requestId,
    handoverLineRef: w.lineRef,
    versionNo,
    sourceRecord: {
      app: "sales", recordType: "customer_request", recordId: w.request._id,
      sourceVersion: w.request.updatedAt.toISOString(), issuedAt,
    },
    executionProjection: {
      orderRef: w.request.requestId, orderLineRef: w.lineRef, styleRef: "SC-OB", productName: "Polo shirt",
      ...(w.style ? { sampleStyleId: w.style._id } : {}),
      totalQuantity: 500,
      breakdown: [{ lineSplitRef: "S1", sizeRange: "M", quantity: 500, attributes: [{ name: "Colour", value: "Navy" }] }],
      deliveries: [{ dropRef: "D1", committedDeliveryDate: D("10-10"), quantity: 500 }],
      packingRequirement: packing,
      testingRequirement: "AQL 2.5 final inspection",
    },
    publication: { state },
    issuedBy: { name: "Sana" },
  });
}

/* ═══════════════════════════════════════════════════════════════════════════ */

test("a complete order: every source is read through its real field", async () => {
  const w = await world();
  const v = await issueHandover(w);
  const file = await ExecutionFile.create({
    fileNumber: `MEF-OB-${seq}`, companyId: w.co._id, handoverRef: w.request.requestId,
    handoverLineRef: w.lineRef, currentHandoverVersionId: v._id, lifecycleStatus: "OPEN",
    currentExecutionProjection: v.executionProjection,
  });
  await PackagingRevision.create({
    companyId: w.co._id, fileId: file._id, revisionNo: 1, state: "APPROVED",
    approvedAt: D("08-11"), approvedBy: { name: "Meera" },
    rows: [{ rowRef: "P1", group: "POLYBAG", componentName: "Polybag 12x16" }],
    instructions: { cartonMarks: "ACME / PO-7781" },
  });
  await MaterialTrimRevision.create({
    companyId: w.co._id, fileId: file._id, revisionNo: 1, state: "SUBMITTED",
    rows: [{ rowRef: "T1", group: "FABRIC", componentName: "Pique body", colourOrShade: "Navy" }],
  });

  global.__ACTOR__ = await memberOf(w.co);
  const { status, body, headers } = await get(w.request._id);

  expect(status).toBe(200);
  expect(headers.get("cache-control")).toBe("no-store");
  const b = body.brief;
  const l = b.lines[0];

  expect(b.ownership.basis).toBe("style");
  expect(b.link.basis).toBe("origin");

  expect(b.order.acceptedQuotation.status).toBe("confirmed");
  /* Both PO homes name PO-7781 with a document: agreed, and confirmed. */
  expect(b.order.purchaseOrder.status).toBe("confirmed");
  expect(b.order.purchaseOrder.value.poNumber).toBe("PO-7781");
  expect(b.order.compliance.value.requiredCertifications).toEqual(["oeko_tex"]);

  expect(l.lineRef).toMatch(/^LN-/);
  expect(l.handover.state).toBe("current");
  expect(l.handover.merchandising.fileNumber).toBe(file.fileNumber);
  expect(l.facts.quantity.status).toBe("confirmed");
  expect(l.facts.delivery.value.drops[0].dropRef).toBe("D1");
  expect(l.facts.quality.value.requirement).toBe("AQL 2.5 final inspection");
  expect(l.facts.sample.status).toBe("confirmed");
  expect(l.facts.sample.authority).toBe("buyer");
  expect(l.facts.techPack.authority).toBe("rnd");
  expect(l.facts.techPack.value.revision).toBe(2);

  /* Approved packaging from Merchandising, with its instructions. */
  expect(l.facts.packing.status).toBe("confirmed");
  expect(l.facts.packing.authority).toBe("merchandising");
  expect(l.facts.packing.value.instructions.cartonMarks).toBe("ACME / PO-7781");

  /* The submitted trim revision does not displace R&D's approved spec. */
  expect(l.facts.fabricTrims.authority).toBe("rnd");
  expect(l.facts.fabricTrims.alsoOnRecord.some((c) => c.authority === "merchandising" && c.status === "draft")).toBe(true);
});

test("the brief writes nothing", async () => {
  const w = await world();
  await issueHandover(w);
  global.__ACTOR__ = await memberOf(w.co);

  const before = await CustomerRequest.findById(w.request._id).lean();
  const counts = async () => Promise.all([
    CustomerRequest.countDocuments({}), SalesHandoverVersion.countDocuments({}),
    Enquiry.countDocuments({}), SampleStyle.countDocuments({}),
  ]);
  const c0 = await counts();

  expect((await get(w.request._id)).status).toBe(200);

  expect(await counts()).toEqual(c0);
  const after = await CustomerRequest.findById(w.request._id).lean();
  /* Not even a timestamp moved: a read model that touches its source would
     itself make the source look changed. */
  expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
});

test("another company cannot read the order, and learns nothing about it", async () => {
  const w = await world({ sole: false });
  const stranger = await company("Stranger");
  global.__ACTOR__ = await memberOf(stranger);

  const { status, body } = await get(w.request._id);
  /* The same answer a missing order gets. */
  expect(status).toBe(404);
  expect(JSON.stringify(body)).not.toMatch(/Acme|PO-7781|Polo/);
});

test("an order with no styles is shown only where the deployment has one company", async () => {
  const sole = await world({ withStyle: false, sole: true });
  global.__ACTOR__ = await memberOf(sole.co);
  const ok = await get(sole.request._id);
  expect(ok.status).toBe(200);
  expect(ok.body.brief.ownership.basis).toBe("sole_company");
  expect(ok.body.brief.lines[0].facts.sample.status).toBe("missing");
});

test("an order with no styles is not shown when several companies exist", async () => {
  const w = await world({ withStyle: false, sole: false });
  global.__ACTOR__ = await memberOf(w.co);
  expect((await get(w.request._id)).status).toBe(404);
});

test("an enquiry link that cannot be proved is reported, and its data is not used", async () => {
  const w = await world();
  /* Simulate the Lane A link without the order's own origin: the order no
     longer names its enquiry, and the enquiry points at it by
     customerRequestId — but the buyer account is not linked to the order's
     customer, so the link cannot be proved. */
  await CustomerRequest.updateOne({ _id: w.request._id }, { $unset: { "salesOrigin.enquiryId": "" } });
  await Enquiry.updateOne({ _id: w.enquiry._id }, { $set: { customerRequestId: w.request._id } });

  global.__ACTOR__ = await memberOf(w.co);
  const { status, body } = await get(w.request._id);

  expect(status).toBe(200);
  expect(body.brief.link.basis).toBe("unproved");
  /* The journey's PO and the account's defaults came through that link, so
     they are not shown. The quotation's own PO proof still is. */
  expect(body.brief.order.purchaseOrder.source.kind).toBe("quotation_po_proof");
  expect(body.brief.order.purchaseOrder.alsoOnRecord).toEqual([]);
  expect(body.brief.order.compliance.status).toBe("missing");
});

test("an older handover is visibly invalidated when the quotation is accepted again", async () => {
  const w = await world();
  const v1 = await issueHandover(w, { versionNo: 1, state: "SUPERSEDED", issuedAt: D("08-04"), packing: "Old packing" });
  await issueHandover(w, { versionNo: 2, state: "CURRENT", issuedAt: D("08-05") });
  expect(v1.publication.state).toBe("SUPERSEDED");

  /* Re-accepted after version 2 was issued. */
  await CustomerRequest.updateOne(
    { _id: w.request._id },
    { $set: { "quotations.0.salesApproval.approvedAt": D("08-20") } },
  );

  global.__ACTOR__ = await memberOf(w.co);
  const b = (await get(w.request._id)).body.brief;
  const l = b.lines[0];

  expect(l.handover.current.versionNo).toBe(2);
  expect(l.handover.history.map((h) => h.state)).toEqual(["SUPERSEDED", "CURRENT"]);
  expect(l.handover.stale).toBe(true);
  expect(l.handover.staleReasons[0].code).toBe("QUOTATION_REAPPROVED");
  expect(l.facts.delivery.status).toBe("draft");
  expect(l.facts.packing.value.requirement).toBe("Single polybag");
  expect(b.handover.anyStale).toBe(true);
});

test("no session is refused before anything is read", async () => {
  const w = await world();
  global.__ACTOR__ = null;
  expect((await get(w.request._id)).status).toBe(401);
});

test("an unknown or malformed id is not found", async () => {
  const w = await world();
  global.__ACTOR__ = await memberOf(w.co);
  expect((await get(new mongoose.Types.ObjectId())).status).toBe(404);
  expect((await get("not-an-id")).status).toBe(404);
});

test("a real edit-and-save after acceptance is detected from the timestamp Mongoose writes", async () => {
  const w = await world();
  global.__ACTOR__ = await memberOf(w.co);

  /* Accepted just now and nothing written since: the provable baseline. The
     acceptance time and the round's own updatedAt are the same write. */
  const doc = await CustomerRequest.findById(w.request._id);
  const acceptedNow = new Date(Date.now() - 60 * 1000);
  doc.quotations[0].customerApproval = { approved: true, approvedAt: acceptedNow };
  doc.quotations[0].salesApproval = { approved: false };
  doc.quotations[0].status = "customer_approved";
  /* Matched to the order line by id — the brief never matches by name. */
  doc.quotations[0].items[0].sampleStyleId = w.style._id;
  await doc.save();
  await CustomerRequest.collection.updateOne(
    { _id: w.request._id },
    { $set: { "quotations.0.updatedAt": acceptedNow } },
  );

  const before = (await get(w.request._id)).body.brief;
  expect(before.order.acceptedQuotation.value.contentSinceAcceptance).toBe("unchanged");
  expect(before.lines[0].facts.price.status).toBe("confirmed");

  /* The unguarded edit: rewrite the accepted round in place and save, as
     POST /requests/:id/quotation does. No approval is touched. */
  const edit = await CustomerRequest.findById(w.request._id);
  edit.quotations[0].items[0].unitPrice = 240;
  edit.quotations[0].grandTotal = 141600;
  await edit.save();

  const after = (await get(w.request._id)).body.brief;
  expect(after.order.acceptedQuotation.value.contentSinceAcceptance).toBe("edited");
  /* The acceptance still happened; its figures are no longer the buyer's. */
  expect(after.order.acceptedQuotation.status).toBe("confirmed");
  expect(after.lines[0].facts.price.status).toBe("draft");
  expect(after.lines[0].facts.price.needsReconfirmation).toBe(true);
  /* The buyer's PO still says ₹1,18,000, and that is the total that stands. */
  expect(after.order.acceptedTotal.status).toBe("confirmed");
  expect(after.order.acceptedTotal.value.grandTotal).toBe(118000);
  expect(after.summary.needsReconfirmation).toBeGreaterThan(0);
});
