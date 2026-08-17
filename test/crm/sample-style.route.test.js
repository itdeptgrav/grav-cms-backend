// test/crm/sample-style.route.test.js
//
// HTTP-level tests for /api/cms/crm/sample-styles — the shared record between
// the Sales journey Style & Sample stage and the R&D / Sampling app.
//
// Same bare-Express + global-fetch harness as enquiry.route.test.js. Covers the
// get-or-create-from-enquiry-products contract, the materials gate, the two R&D
// production phases, and the two Sales approval gates (incl. who may approve).
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
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

// Sales owner = an approver (role "sales"). Merch = authenticated but NOT an
// approver (no manager role, no email → isSalesManager false).
const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };
const MERCH = { id: new mongoose.Types.ObjectId().toString(), name: "Umung Arora", role: "merchandiser" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/sample-styles`;
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
async function makeJourneyWithProducts(products) {
  const acc = await Account.create({ companyName: "Coastal Kitchens", status: "active" });
  const ref = `SJ-2026-80${String(++seq).padStart(2, "0")}`;
  const journey = await SalesJourney.create({
    journeyId: ref, name: "Kitchen crew uniforms", accountId: acc._id,
    businessType: "uniform", ownerId: OWNER.id, ownerName: OWNER.name, currentStage: "styleSample",
  });
  await Enquiry.create({
    enquiryId: `ENQ-2026-90${String(seq).padStart(3, "0")}`,
    journeyId: journey._id, accountId: acc._id, status: "qualified",
    products,
  });
  return { ref, journey, acc };
}

describe("GET /by-journey/:ref — get-or-create from enquiry products", () => {
  test("creates one SampleStyle per product, snapshots the brief, is idempotent", async () => {
    const { ref } = await makeJourneyWithProducts([
      { product: "Chef Jacket", quantity: 100, colour: "White", fit: "Regular" },
      { product: "Apron", quantity: 50 },
    ]);

    const first = await call(`/by-journey/${ref}`);
    expect(first.status).toBe(200);
    expect(first.body.sampleStyles).toHaveLength(2);
    const chef = first.body.sampleStyles.find((s) => s.productName === "Chef Jacket");
    expect(chef.sampleStyleId).toMatch(/^SS-\d{4}-\d{4}$/);
    expect(chef.brief.colour).toBe("White");
    expect(chef.journeyRef).toBe(ref);
    expect(chef.techSheet.status).toBe("pending");
    expect(chef.materials.status).toBe("pending");

    // Second open must not duplicate.
    const second = await call(`/by-journey/${ref}`);
    expect(second.body.sampleStyles).toHaveLength(2);
    const count = await SampleStyle.countDocuments({ isActive: true });
    expect(count).toBe(2);
  });
});

describe("tech-sheet phase — materials gate + Sales approval", () => {
  test("blocks start until materials selected, then R&D → submit → Sales approves", async () => {
    const { ref } = await makeJourneyWithProducts([{ product: "Chef Jacket", quantity: 100 }]);
    const chef = (await call(`/by-journey/${ref}`)).body.sampleStyles[0];
    const id = chef.sampleStyleId;

    // Can't start the tech sheet before materials are selected.
    let r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "start" } });
    expect(r.status).toBe(400);

    // Merchandiser selects materials.
    r = await call(`/${id}/materials`, { method: "PATCH", body: { items: ["Poly-cotton poplin"] }, user: MERCH });
    expect(r.status).toBe(200);
    expect(r.body.sampleStyle.materials.status).toBe("selected");

    // R&D: start → submit.
    r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "start" } });
    expect(r.body.sampleStyle.techSheet.status).toBe("in_progress");
    r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "submit", file: { name: "TS.pdf" } } });
    expect(r.body.sampleStyle.techSheet.status).toBe("submitted");

    // A non-approver (merchandiser) cannot approve.
    r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "approve" }, user: MERCH });
    expect(r.status).toBe(403);

    // Sales approves.
    r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "approve" } });
    expect(r.status).toBe(200);
    expect(r.body.sampleStyle.techSheet.status).toBe("approved");
  });
});

describe("sample phase — gated on tech-sheet approval, ends at Sales approval", () => {
  test("blocks sampling until tech sheet approved; round → submit → approve completes", async () => {
    const { ref } = await makeJourneyWithProducts([{ product: "Chef Jacket", quantity: 100 }]);
    const id = (await call(`/by-journey/${ref}`)).body.sampleStyles[0].sampleStyleId;

    // Can't start sampling before the tech sheet is approved.
    let r = await call(`/${id}/sample`, { method: "POST", body: { action: "start" } });
    expect(r.status).toBe(400);

    // Fast-forward the tech sheet to approved.
    await call(`/${id}/materials`, { method: "PATCH", body: { items: ["Fabric"] }, user: MERCH });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "start" } });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "submit" } });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "approve" } });

    // R&D runs sampling.
    r = await call(`/${id}/sample`, { method: "POST", body: { action: "start" } });
    expect(r.body.sampleStyle.sample.status).toBe("in_progress");
    r = await call(`/${id}/sample`, { method: "POST", body: { action: "round", type: "proto", note: "first proto" } });
    expect(r.body.sampleStyle.sample.rounds).toHaveLength(1);
    r = await call(`/${id}/sample`, { method: "POST", body: { action: "round", type: "zzz" } });
    expect(r.status).toBe(400); // invalid round type
    r = await call(`/${id}/sample`, { method: "POST", body: { action: "submit" } });
    expect(r.body.sampleStyle.sample.status).toBe("submitted");

    // Sales approves the sample → style completed.
    r = await call(`/${id}/sample`, { method: "POST", body: { action: "approve" } });
    expect(r.status).toBe(200);
    expect(r.body.sampleStyle.sample.status).toBe("approved");
    expect(r.body.sampleStyle.status).toBe("completed");
  });
});

describe("routing stage — entering products does NOT auto-send to R&D", () => {
  test("styles start at 'brief'; move to 'rnd'; list filters by stage", async () => {
    const { ref } = await makeJourneyWithProducts([{ product: "Chef Jacket" }, { product: "Apron" }]);
    const created = (await call(`/by-journey/${ref}`)).body.sampleStyles;
    expect(created.every((s) => s.stage === "brief")).toBe(true);

    // R&D's list (stage=rnd) is empty until something is sent.
    let rnd = await call(`/?stage=rnd`);
    expect(rnd.body.sampleStyles.filter((s) => s.journeyRef === ref)).toHaveLength(0);

    // Route one style to R&D.
    const id = created[0].sampleStyleId;
    let r = await call(`/${id}/stage`, { method: "PATCH", body: { stage: "rnd" } });
    expect(r.body.sampleStyle.stage).toBe("rnd");

    // Invalid stage rejected.
    r = await call(`/${id}/stage`, { method: "PATCH", body: { stage: "nope" } });
    expect(r.status).toBe(400);

    // Now exactly that one shows up for R&D.
    rnd = await call(`/?stage=rnd`);
    const forThisJourney = rnd.body.sampleStyles.filter((s) => s.journeyRef === ref);
    expect(forThisJourney).toHaveLength(1);
    expect(forThisJourney[0].productName).toBe("Chef Jacket");
  });
});

describe("back-and-forth — send back with a reason resets downstream + logs history", () => {
  test("returning an approved-tech style to Materials resets tech + sample and records why", async () => {
    const { ref } = await makeJourneyWithProducts([{ product: "Chef Jacket" }]);
    const id = (await call(`/by-journey/${ref}`)).body.sampleStyles[0].sampleStyleId;

    // Push it forward to an approved tech sheet in R&D.
    await call(`/${id}/stage`, { method: "PATCH", body: { stage: "materials" } });
    await call(`/${id}/materials`, { method: "PATCH", body: { items: ["Poplin"] }, user: MERCH });
    await call(`/${id}/stage`, { method: "PATCH", body: { stage: "rnd" } });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "start" } });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "submit" } });
    await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "approve" } });

    // Back to Materials WITHOUT a reason → rejected.
    let r = await call(`/${id}/stage`, { method: "PATCH", body: { stage: "materials" } });
    expect(r.status).toBe(400);

    // With a reason → moves back, tech sheet reset, history recorded.
    r = await call(`/${id}/stage`, { method: "PATCH", body: { stage: "materials", reason: "Customer rejected poplin — try twill" } });
    expect(r.status).toBe(200);
    expect(r.body.sampleStyle.stage).toBe("materials");
    expect(r.body.sampleStyle.techSheet.status).toBe("pending"); // reset
    expect(r.body.sampleStyle.sample.status).toBe("not_started"); // reset
    const back = r.body.sampleStyle.history.find((h) => h.kind === "send_back");
    expect(back.note).toMatch(/twill/);
    expect(back.from).toBe("rnd");
    expect(back.to).toBe("materials");
  });
});

describe("validation", () => {
  test("unknown action is rejected", async () => {
    const { ref } = await makeJourneyWithProducts([{ product: "Chef Jacket" }]);
    const id = (await call(`/by-journey/${ref}`)).body.sampleStyles[0].sampleStyleId;
    const r = await call(`/${id}/tech-sheet`, { method: "POST", body: { action: "nope" } });
    expect(r.status).toBe(400);
  });
});
