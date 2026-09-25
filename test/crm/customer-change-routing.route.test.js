// test/crm/customer-change-routing.route.test.js
//
// ROUTING A CUSTOMER'S REJECTION — OVER HTTP, AGAINST THE REAL ROUTER.
//
// The old recovery was two buttons. "Send to R&D for Rework" set
// `sample.status = "rejected"` whatever the customer had actually complained
// about, so a fabric problem came back as a second sample in the same fabric.
// "Change Product Design" wrote nothing at all — it navigated.
//
// What these tests hold is the part a screen cannot be trusted with: which
// approvals are reopened, which survive, and that a retry does not do it twice.
"use strict";

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
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));

/* The notifications are fire-and-forget; captured so the "who is told" rule
   can be asserted without a mail server. */
const notified = [];
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async (key, payload) => { notified.push({ key, payload }); return {}; },
  APP_URL: "http://localhost",
}));
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Account = require("../../models/CMS_Models/Sales/Account");
const CustomerChangeRequest = require("../../models/CMS_Models/Sales/CustomerChangeRequest");

const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", email: "anita@grav.test", role: "sales" };
const RND = { id: new mongoose.Types.ObjectId().toString(), name: "Dev", email: "dev@grav.test", role: "rnd" };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

let CO;
let seq = 0;
beforeEach(async () => {
  notified.length = 0;
  await Promise.all([
    SampleStyle.deleteMany({}), Enquiry.deleteMany({}),
    SalesJourney.deleteMany({}), Account.deleteMany({}), CustomerChangeRequest.deleteMany({}),
  ]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

const call = (path, { method = "GET", body, user = SALES } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

/**
 * A rejected style, fully developed: BOM approved, tech sheet approved, one
 * accepted sample round, and a customer who then said no.
 */
async function world({ company = null, decidedAt = new Date("2026-09-20T10:00:00Z") } = {}) {
  const n = ++seq;
  const co = company || CO;
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-CCR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "Anita",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-CCR-${n}`, companyId: co._id, accountId: account._id, journeyId: journey._id,
    title: `Enquiry ${n}`, isActive: true,
    products: [{ product: "Polo", quantity: 500, fulfilmentModel: "JOB_WORK" }],
  });
  const style = await SampleStyle.create({
    sampleStyleId: `SS-CCR-${n}`, styleCode: `SC-CCR-${n}`, productName: "Polo",
    journeyId: journey._id, enquiryId: enquiry._id, stage: "rnd",
    materials: { status: "selected", items: ["Cotton 180gsm"] },
    bomApproval: { status: "approved", round: 1, decidedAt: new Date("2026-09-01"), decidedByName: "PM" },
    techSheet: {
      status: "approved",
      revisions: [{ note: "first pass", at: new Date("2026-09-02") }],
      technical: { status: "approved", revision: 2 },
      technicalRevisions: [{ revision: 2, submittedAt: new Date("2026-09-02"), outcome: "approved" }],
    },
    sample: {
      status: "approved",
      rounds: [{ roundNo: 1, type: "proto", outcome: "accepted", madeAt: new Date("2026-09-03") }],
      revisions: [],
    },
    customerApproval: {
      approved: false, decidedAt, note: "The fabric feels thin.",
      log: [{ approved: false, decidedAt, note: "The fabric feels thin." }],
    },
    customerRejected: true,
  });
  return { co, account, journey, enquiry, style, decidedAt };
}

const route = (style, body, opts = {}) =>
  call(`/${style._id}/customer-changes`, { method: "POST", body, ...opts });

const reload = (style) => SampleStyle.findById(style._id).lean();

const BASE_BODY = {
  categories: ["SAMPLE_ROUND"],
  customerFeedback: "The stitching on the placket is untidy.",
};

/* ══ THE DESTINATION IS DECIDED, AND APPLIED, BY THE SERVER ═══════════════ */

test("a materials change reopens the BOM and keeps the approved one as history", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["MATERIALS_BOM"],
    customerFeedback: "The fabric feels thin — please use a heavier cotton.",
    expectedDecisionAt: w.decidedAt.toISOString(),
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.destination).toBe("MATERIALS_BOM");
  expect(res.body.changeRequest.owner).toBe("merchandiser");

  const after = await reload(w.style);
  expect(after.materials.status).toBe("pending");
  expect(after.bomApproval.status).toBe("none");
  expect(after.stage).toBe("materials");
  // The approved BOM's own record survives — round and decision are history.
  expect(after.bomApproval.round).toBe(1);
  expect(after.bomApproval.decidedByName).toBe("PM");
  // Downstream needs doing again, but nothing downstream was deleted.
  expect(after.techSheet.status).toBe("pending");
  expect(after.sample.status).toBe("not_started");
  expect(after.techSheet.technicalRevisions).toHaveLength(1);
  expect(after.sample.rounds).toHaveLength(1);
  expect(after.sample.rounds[0].outcome).toBe("accepted");
});

test("a tech-sheet change preserves the approved BOM", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["TECH_SHEET"],
    customerFeedback: "The collar sits too high.",
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.destination).toBe("TECH_SHEET");

  const after = await reload(w.style);
  expect(after.bomApproval.status).toBe("approved");
  expect(after.materials.status).toBe("selected");
  expect(after.techSheet.status).toBe("changes");
  expect(after.techSheet.technical.status).toBe("rework");
  // The earlier revision is kept, and the customer's words are on the new one.
  expect(after.techSheet.revisions).toHaveLength(2);
  expect(after.techSheet.revisions[1].note).toMatch(/collar/);
  expect(after.sample.status).toBe("not_started");
});

test("a new sample round preserves the BOM and the tech sheet", async () => {
  const w = await world();
  const res = await route(w.style, {
    ...BASE_BODY,
    expectedDecisionAt: w.decidedAt.toISOString(),
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.destination).toBe("SAMPLE_ROUND");
  // The NEXT round is named, not created — a round is something somebody made.
  expect(res.body.changeRequest.result.sampleRoundNo).toBe(2);

  const after = await reload(w.style);
  expect(after.bomApproval.status).toBe("approved");
  expect(after.techSheet.status).toBe("approved");
  expect(after.sample.status).toBe("rejected");
  expect(after.sample.rounds).toHaveLength(1);
  expect(after.sample.revisions).toHaveLength(1);
  expect(after.sample.revisions[0].note).toMatch(/placket/);
});

test("a new product version reopens nothing on the rejected style", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["BRIEF_NEW_VERSION"],
    customerFeedback: "This isn't the garment we asked for at all.",
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.destination).toBe("BRIEF_NEW_VERSION");
  expect(res.body.changeRequest.owner).toBe("sales");

  const after = await reload(w.style);
  expect(after.bomApproval.status).toBe("approved");
  expect(after.techSheet.status).toBe("approved");
  expect(after.sample.rounds).toHaveLength(1);
  // The customer's rejection stays exactly as recorded.
  expect(after.customerApproval.approved).toBe(false);
  expect(after.customerApproval.log).toHaveLength(1);
});

test("several categories route to the earliest affected stage", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["SAMPLE_ROUND", "TECH_SHEET", "MATERIALS_BOM"],
    customerFeedback: "Heavier fabric, and the collar needs reshaping.",
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.suggestedDestination).toBe("MATERIALS_BOM");
  expect(res.body.changeRequest.destination).toBe("MATERIALS_BOM");
  // Stored in dependency order, not the order they were ticked.
  expect(res.body.changeRequest.categories).toEqual(["MATERIALS_BOM", "TECH_SHEET", "SAMPLE_ROUND"]);
});

test("a destination downstream of the categories is refused", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["MATERIALS_BOM"],
    destination: "SAMPLE_ROUND",
    customerFeedback: "The fabric feels thin.",
  });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("DESTINATION_TOO_LATE");
  // And nothing was applied.
  const after = await reload(w.style);
  expect(after.sample.status).toBe("approved");
  expect(await CustomerChangeRequest.countDocuments({})).toBe(0);
});

test("routing further upstream than suggested is allowed", async () => {
  const w = await world();
  const res = await route(w.style, {
    categories: ["SAMPLE_ROUND"],
    destination: "MATERIALS_BOM",
    customerFeedback: "Actually the fabric is the problem too.",
  });
  expect(res.status).toBe(201);
  expect(res.body.changeRequest.suggestedDestination).toBe("SAMPLE_ROUND");
  expect(res.body.changeRequest.destination).toBe("MATERIALS_BOM");
});

/* ══ WHAT IT REFUSES ══════════════════════════════════════════════════════ */

test("a product the customer has not rejected cannot be routed", async () => {
  const w = await world();
  await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "customerApproval.approved": true } });
  const res = await route(w.style, BASE_BODY);
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("NOT_REJECTED");
});

test("a decision that moved since the screen loaded is refused", async () => {
  const w = await world();
  const res = await route(w.style, {
    ...BASE_BODY,
    expectedDecisionAt: new Date("2026-01-01T00:00:00Z").toISOString(),
  });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("DECISION_CHANGED");
  expect(await CustomerChangeRequest.countDocuments({})).toBe(0);
});

test("categories and the customer's own words are both required", async () => {
  const w = await world();
  expect((await route(w.style, { customerFeedback: "x" })).body.code).toBe("CATEGORY_REQUIRED");
  expect((await route(w.style, { categories: ["SAMPLE_ROUND"] })).body.code).toBe("FEEDBACK_REQUIRED");
});

test("only Sales can route a customer's changes", async () => {
  const w = await world();
  const res = await route(w.style, BASE_BODY, { user: RND });
  expect(res.status).toBe(403);
  expect(await CustomerChangeRequest.countDocuments({})).toBe(0);
});

test("an unauthenticated request is refused", async () => {
  const w = await world();
  expect((await route(w.style, BASE_BODY, { user: null })).status).toBe(401);
});

test("a style belonging to another company is not found", async () => {
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  const other = await Acc_Company.create({ companyName: "Other Co", booksFromDate: new Date("2026-04-01") });
  const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
  await SpCompanyMembership.create({
    companyId: CO._id, email: SALES.email, employeeRef: new mongoose.Types.ObjectId(SALES.id), personName: SALES.name,
  });
  const foreign = await world({ company: other });

  const res = await route(foreign.style, BASE_BODY);
  // Indistinguishable from a style that does not exist.
  expect(res.status).toBe(404);
  expect(await CustomerChangeRequest.countDocuments({})).toBe(0);
});

/* ══ RETRIES ══════════════════════════════════════════════════════════════ */

test("a retry with the same key does not route twice", async () => {
  const w = await world();
  const body = { ...BASE_BODY, idempotencyKey: "abc-123" };

  const first = await route(w.style, body);
  expect(first.status).toBe(201);
  const second = await route(w.style, body);
  expect(second.status).toBe(200);
  expect(second.body.replayed).toBe(true);
  expect(second.body.changeRequest.changeRef).toBe(first.body.changeRequest.changeRef);

  expect(await CustomerChangeRequest.countDocuments({})).toBe(1);
  // And the sample was not sent back a second time.
  const after = await reload(w.style);
  expect(after.sample.revisions).toHaveLength(1);
});

test("two retries racing still produce one request", async () => {
  const w = await world();
  const body = { ...BASE_BODY, idempotencyKey: "race-1" };
  const [a, b] = await Promise.all([route(w.style, body), route(w.style, body)]);
  expect([a.status, b.status].filter((s) => s === 201).length).toBeLessThanOrEqual(1);
  expect(await CustomerChangeRequest.countDocuments({})).toBe(1);
});

/* ══ THE RECORD, AND WHO IS TOLD ══════════════════════════════════════════ */

test("the request records the decision it answers and what it reopened", async () => {
  const w = await world();
  await route(w.style, {
    categories: ["MATERIALS_BOM"],
    customerFeedback: "Heavier cotton please.",
    internalInstructions: "Use the 200gsm we sourced for Acme.",
  });
  const saved = await CustomerChangeRequest.findOne({}).lean();

  expect(saved.changeRef).toMatch(/^CCR-[0-9a-f]{12}$/);
  expect(String(saved.enquiryId)).toBe(String(w.enquiry._id));
  expect(String(saved.sampleStyleId)).toBe(String(w.style._id));
  expect(saved.status).toBe("OPEN");
  expect(saved.sourceDecision.approved).toBe(false);
  expect(saved.sourceDecision.note).toBe("The fabric feels thin.");
  expect(saved.customerFeedback).toBe("Heavier cotton please.");
  expect(saved.internalInstructions).toMatch(/200gsm/);
  // Where the product stood BEFORE this reopened anything.
  expect(saved.previousStage).toBe("rnd");
  expect(saved.previousState.bomApprovalStatus).toBe("approved");
  expect(saved.previousState.sampleRounds).toBe(1);
});

test("the department that now owns the work is the one told", async () => {
  const w = await world();
  await route(w.style, { categories: ["MATERIALS_BOM"], customerFeedback: "Fabric." });
  await new Promise((r) => setTimeout(r, 30));
  expect(notified.map((n) => n.key)).toContain("customer_changes_to_materials");

  notified.length = 0;
  const w2 = await world();
  await route(w2.style, { categories: ["TECH_SHEET"], customerFeedback: "Collar." });
  await new Promise((r) => setTimeout(r, 30));
  expect(notified.map((n) => n.key)).toContain("customer_changes_to_rnd");
});

test("the style's timeline records where the changes went", async () => {
  const w = await world();
  await route(w.style, { categories: ["TECH_SHEET"], customerFeedback: "Collar sits high." });
  const after = await reload(w.style);
  const entry = after.history.find((h) => h.kind === "customer_changes_routed");
  expect(entry).toBeTruthy();
  expect(entry.to).toBe("TECH_SHEET");
  expect(entry.note).toMatch(/Tech sheet/i);
});

test("routed changes are listed newest first, for this product only", async () => {
  const w = await world();
  const other = await world();
  await route(w.style, { categories: ["SAMPLE_ROUND"], customerFeedback: "One." });
  await route(other.style, { categories: ["SAMPLE_ROUND"], customerFeedback: "Another product." });

  const res = await call(`/${w.style._id}/customer-changes`);
  expect(res.status).toBe(200);
  expect(res.body.changeRequests).toHaveLength(1);
  expect(res.body.changeRequests[0].customerFeedback).toBe("One.");
});

test("a later customer approval resolves the open change request", async () => {
  const w = await world();
  await route(w.style, { categories: ["SAMPLE_ROUND"], customerFeedback: "Redo the placket." });
  await SampleStyle.updateOne(
    { _id: w.style._id },
    { $set: { "sample.status": "approved", "sample.approvedAt": new Date("2026-09-22T10:00:00Z") } },
  );

  const res = await call(`/${w.style._id}/sample/customer-decision`, {
    method: "POST",
    body: { approved: true, note: "Revised sample accepted." },
  });
  expect(res.status).toBe(200);

  const request = await CustomerChangeRequest.findOne({}).lean();
  expect(request.status).toBe("RESOLVED");
  expect(request.resolvedAt).toBeTruthy();
  expect(request.resolvedBy.name).toBe(SALES.name);
});

test("the explicit resolution door refuses a request before revised customer approval", async () => {
  const w = await world();
  const routed = await route(w.style, { categories: ["SAMPLE_ROUND"], customerFeedback: "Redo the placket." });
  const res = await call(`/${w.style._id}/customer-changes/${routed.body.changeRequest.changeRef}/resolve`, {
    method: "POST",
    body: { note: "Trying too early." },
  });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("REVISED_SAMPLE_NOT_APPROVED");
  expect((await CustomerChangeRequest.findOne({}).lean()).status).toBe("OPEN");
});

/* ══ PRODUCT-WISE ISOLATION AND JOB WORK ══════════════════════════════════ */

test("routing one product leaves the other products in the enquiry alone", async () => {
  const w = await world();
  const sibling = await SampleStyle.create({
    sampleStyleId: `SS-SIB-${seq}`, styleCode: `SC-SIB-${seq}`, productName: "Cap",
    journeyId: w.journey._id, enquiryId: w.enquiry._id, stage: "rnd",
    materials: { status: "selected" },
    bomApproval: { status: "approved", round: 1 },
    techSheet: { status: "approved" },
    sample: { status: "approved", rounds: [{ roundNo: 1, type: "proto", outcome: "accepted" }] },
    customerApproval: { approved: true, decidedAt: new Date() },
  });

  await route(w.style, { categories: ["MATERIALS_BOM"], customerFeedback: "Fabric." });

  const untouched = await SampleStyle.findById(sibling._id).lean();
  expect(untouched.materials.status).toBe("selected");
  expect(untouched.bomApproval.status).toBe("approved");
  expect(untouched.techSheet.status).toBe("approved");
  expect(untouched.customerApproval.approved).toBe(true);
});

test("the order's Job Work classification is untouched by any route", async () => {
  for (const categories of [["MATERIALS_BOM"], ["TECH_SHEET"], ["SAMPLE_ROUND"], ["BRIEF_NEW_VERSION"]]) {
    const w = await world();
    await route(w.style, { categories, customerFeedback: "Change." });
    const enquiry = await Enquiry.findById(w.enquiry._id).lean();
    expect(enquiry.products[0].fulfilmentModel).toBe("JOB_WORK");
  }
});

/* ══ LEGACY RECORDS STAY READABLE ═════════════════════════════════════════ */

test("a rejection recorded the old way is still readable and can be routed now", async () => {
  // What the previous flow left behind: a rejected sample, a revision note,
  // and no change request at all.
  const w = await world();
  await SampleStyle.updateOne({ _id: w.style._id }, {
    $set: { "sample.status": "rejected" },
    $push: { "sample.revisions": { note: "Customer didn't like it — redo", at: new Date("2026-09-21") } },
  });

  const before = await reload(w.style);
  expect(before.sample.revisions).toHaveLength(1);
  expect(before.customerApproval.note).toBe("The fabric feels thin.");

  const res = await route(w.style, { categories: ["MATERIALS_BOM"], customerFeedback: "Heavier fabric." });
  expect(res.status).toBe(201);

  const after = await reload(w.style);
  // The legacy note is still there, beside the structured record.
  expect(after.sample.revisions[0].note).toMatch(/redo/);
  expect(await CustomerChangeRequest.countDocuments({})).toBe(1);
});
