// test/crm/costing-request.route.test.js
//
// HTTP-level tests for /api/cms/crm/costing-requests (the Sales → Merchandising
// + IE costing hand-off). Same bare-Express + global-fetch harness as the other
// CRM route tests: the real router, identity stubbed via `x-test-user`.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});

const Account = require("../../models/CMS_Models/Sales/Account");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const CostingRequest = require("../../models/CMS_Models/Sales/CostingRequest");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };
const OTHER = { id: new mongoose.Types.ObjectId().toString(), name: "Vikram Shah", role: "sales" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/costing-requests", require("../../routes/CMS_Routes/Sales/costingRequests"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/costing-requests`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

async function call(path = "", { method = "GET", body, user = OWNER } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}

let seq = 0;
async function makeEnquiry(over = {}) {
  const acc = await Account.create({ companyName: over.companyName || "ITC Hotels", status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-2026-80${String(++seq).padStart(2, "0")}`,
    name: "New staff uniforms",
    accountId: acc._id,
    businessType: "uniform",
    ownerId: OWNER.id,
    ownerName: OWNER.name,
    currentStage: "enquiry",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-2026-90${String(seq).padStart(3, "0")}`,
    journeyId: journey._id,
    accountId: acc._id,
    ownerId: OWNER.id,
    ownerName: OWNER.name,
    status: "qualified",
    products: over.products || [
      { product: "Front Office Blazer", quantity: 120 },
      { product: "Housekeeping Kurta", quantity: 300 },
    ],
  });
  return { acc, journey, enquiry };
}

const MERCH = { employeeId: "E101", name: "Meera (Merch)" };
const IE = { employeeId: "E202", name: "Iqbal (IE)" };

describe("POST /costing-requests — record a costing request", () => {
  test("creates one for an enquiry, derives journey/account, snapshots lines, in_progress", async () => {
    const { acc, journey, enquiry } = await makeEnquiry();
    const { status, body } = await call("", {
      method: "POST",
      body: { enquiryId: enquiry._id, coworkDocumentId: "sheet-abc", merchandiser: MERCH, industrialEngineer: IE },
    });

    expect(status).toBe(201);
    expect(body.success).toBe(true);
    expect(String(body.request.enquiryId)).toBe(String(enquiry._id));
    expect(String(body.request.journeyId)).toBe(String(journey._id));
    expect(String(body.request.accountId)).toBe(String(acc._id));
    expect(body.request.purpose).toBe("enquiry_indicative");
    expect(body.request.status).toBe("in_progress");
    expect(body.request.coworkDocumentId).toBe("sheet-abc");
    expect(body.request.merchandiser.employeeId).toBe("E101");
    expect(body.request.industrialEngineer.employeeId).toBe("E202");
    expect(body.request.lines).toHaveLength(2);
    expect(body.request.lines[0]).toMatchObject({ product: "Front Office Blazer", quantity: 120 });
    expect(String(body.request.requestedBy.id)).toBe(OWNER.id);
  });

  test("a bare request with no sheet/team is 'requested', not 'in_progress'", async () => {
    const { enquiry } = await makeEnquiry();
    const { status, body } = await call("", { method: "POST", body: { enquiryId: enquiry._id } });
    expect(status).toBe(201);
    expect(body.request.status).toBe("requested");
  });

  test("rejects a missing enquiryId (400) and an unknown enquiry (404)", async () => {
    const missing = await call("", { method: "POST", body: {} });
    expect(missing.status).toBe(400);
    const unknown = await call("", { method: "POST", body: { enquiryId: new mongoose.Types.ObjectId().toString() } });
    expect(unknown.status).toBe(404);
  });

  test("requires authentication", async () => {
    const { enquiry } = await makeEnquiry();
    const res = await call("", { method: "POST", body: { enquiryId: enquiry._id }, user: null });
    expect(res.status).toBe(401);
  });
});

describe("GET /costing-requests/by-enquiry/:enquiryId", () => {
  test("returns the enquiry's requests, newest first", async () => {
    const { enquiry } = await makeEnquiry();
    await call("", { method: "POST", body: { enquiryId: enquiry._id, coworkDocumentId: "s1", merchandiser: MERCH } });
    await call("", { method: "POST", body: { enquiryId: enquiry._id, coworkDocumentId: "s2", merchandiser: MERCH } });

    const { status, body } = await call(`/by-enquiry/${enquiry._id}`);
    expect(status).toBe(200);
    expect(body.requests).toHaveLength(2);
    expect(body.requests[0].coworkDocumentId).toBe("s2"); // newest first
  });

  test("rejects an invalid enquiry id", async () => {
    const { status } = await call("/by-enquiry/not-an-id");
    expect(status).toBe(400);
  });
});

describe("GET /costing-requests/defaults — remembered team", () => {
  test("returns the team from the requester's most recent request", async () => {
    const { enquiry } = await makeEnquiry();
    await call("", { method: "POST", body: { enquiryId: enquiry._id, coworkDocumentId: "s", merchandiser: MERCH, industrialEngineer: IE } });

    const { status, body } = await call("/defaults");
    expect(status).toBe(200);
    expect(body.merchandiser.employeeId).toBe("E101");
    expect(body.industrialEngineer.employeeId).toBe("E202");
  });

  test("is scoped to the requester — another user sees their own (null here)", async () => {
    const { body } = await call("/defaults", { user: OTHER });
    expect(body.merchandiser).toBeNull();
    expect(body.industrialEngineer).toBeNull();
  });
});

describe("PATCH /costing-requests/:id", () => {
  test("advances status and records the result note", async () => {
    const { enquiry } = await makeEnquiry();
    const created = await call("", { method: "POST", body: { enquiryId: enquiry._id, coworkDocumentId: "s", merchandiser: MERCH } });
    const id = created.body.request._id;

    const { status, body } = await call(`/${id}`, { method: "PATCH", body: { status: "returned", resultNote: "Est. ₹820/pc, MOQ 100." } });
    expect(status).toBe(200);
    expect(body.request.status).toBe("returned");
    expect(body.request.resultNote).toBe("Est. ₹820/pc, MOQ 100.");
  });

  test("rejects an illegal status transition", async () => {
    const { enquiry } = await makeEnquiry();
    const created = await call("", { method: "POST", body: { enquiryId: enquiry._id, coworkDocumentId: "s", merchandiser: MERCH } });
    const id = created.body.request._id;
    await call(`/${id}`, { method: "PATCH", body: { status: "returned" } });
    // returned → requested is not allowed
    const bad = await call(`/${id}`, { method: "PATCH", body: { status: "requested" } });
    expect(bad.status).toBe(400);
  });
});

afterEach(async () => {
  await Promise.all([
    CostingRequest.deleteMany({}),
    Enquiry.deleteMany({}),
    SalesJourney.deleteMany({}),
    Account.deleteMany({}),
  ]);
});
