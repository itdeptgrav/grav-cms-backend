// test/crm/enquiry.route.test.js
//
// HTTP-level tests for /api/cms/crm/enquiries (Enquiry/RFQ — Chunk 1).
//
// Same bare-Express + global-fetch harness as sales-journey.route.test.js: the
// real router on an ephemeral port, identity stubbed via `x-test-user`. Covers
// the get-or-create-on-first-open contract, seeding from account + lead, header
// edits, and the "a lost enquiry needs a reason" rule.
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
const Contact = require("../../models/CMS_Models/Sales/Contact");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Lead = require("../../models/CMS_Models/Sales/Lead");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");

const OWNER = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/enquiries`;
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

let jSeq = 0;
async function makeJourney(over = {}) {
  const acc = await Account.create({ companyName: over.companyName || "ITC Hotels", status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-2026-70${String(++jSeq).padStart(2, "0")}`,
    name: over.name || "New staff uniforms for ITC Bhubaneswar",
    accountId: acc._id,
    businessType: "uniform",
    ownerId: OWNER.id,
    ownerName: OWNER.name,
    currentStage: "enquiry",
    ...over.journey,
  });
  return { acc, journey };
}

describe("GET /enquiries/by-journey/:journeyRef — get-or-create", () => {
  test("creates an enquiry on first open, seeded from the account + owner", async () => {
    const { acc, journey } = await makeJourney();
    const { status, body } = await call(`/by-journey/${journey.journeyId}`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.enquiry.enquiryId).toMatch(/^ENQ-\d{4}-\d{5}$/);
    expect(String(body.enquiry.accountId)).toBe(String(acc._id));
    expect(String(body.enquiry.ownerId)).toBe(OWNER.id);
    expect(body.enquiry.status).toBe("new");
    expect(body.enquiry.customerName).toBe("ITC Hotels");
    expect(body.enquiry.journeyRef).toBe(journey.journeyId);
  });

  test("is idempotent — a second open returns the SAME enquiry, no duplicate", async () => {
    const { journey } = await makeJourney();
    const first = await call(`/by-journey/${journey.journeyId}`);
    const second = await call(`/by-journey/${journey.journeyId}`);

    expect(first.body.enquiry.enquiryId).toBe(second.body.enquiry.enquiryId);
    expect(await Enquiry.countDocuments({ journeyId: journey._id })).toBe(1);
  });

  test("seeds source + summary from the converting lead", async () => {
    const { journey } = await makeJourney();
    await Lead.create({
      leadId: "LEAD-2026-8001",
      company: "ITC Hotels",
      source: "referral",
      requirements: "Front office + housekeeping uniforms, ~1300 pcs.",
      conversion: { journeyId: journey._id },
    });
    const { body } = await call(`/by-journey/${journey.journeyId}`);
    expect(body.enquiry.source).toBe("referral");
    expect(body.enquiry.summary).toContain("housekeeping");
  });

  test("seeds products from the lead's requirementItems", async () => {
    const { journey } = await makeJourney();
    await Lead.create({
      leadId: "LEAD-2026-8010",
      company: "ITC Hotels",
      conversion: { journeyId: journey._id },
      requirementItems: [
        { product: "Front Office Blazer", quantity: 100 },
        { product: "Housekeeping Tunic", quantity: 250 },
      ],
    });
    const { body } = await call(`/by-journey/${journey.journeyId}`);
    expect(body.enquiry.products).toHaveLength(2);
    expect(body.enquiry.products[0].product).toBe("Front Office Blazer");
    expect(body.enquiry.products[0].quantity).toBe(100);
    expect(body.enquiry.products[1].quantity).toBe(250);
  });

  test("falls back to productInterest names when requirementItems is empty", async () => {
    const { journey } = await makeJourney();
    await Lead.create({
      leadId: "LEAD-2026-8011",
      company: "ITC Hotels",
      conversion: { journeyId: journey._id },
      productInterest: ["Polo", "Chef Coat"],
    });
    const { body } = await call(`/by-journey/${journey.journeyId}`);
    expect(body.enquiry.products.map((p) => p.product)).toEqual(["Polo", "Chef Coat"]);
  });

  test("prefers the account's primary contact as the enquiry contact", async () => {
    const { acc, journey } = await makeJourney();
    await Contact.create({ accountId: acc._id, firstName: "Riya", lastName: "Sen", jobTitle: "Purchase Manager", isPrimary: true });
    const { body } = await call(`/by-journey/${journey.journeyId}`);
    expect(body.enquiry.contact?.name).toBe("Riya Sen");
    expect(body.enquiry.contact?.jobTitle).toBe("Purchase Manager");
  });

  test("404 for an unknown journey", async () => {
    const { status } = await call(`/by-journey/SJ-2026-9999`);
    expect(status).toBe(404);
  });

  test("401 without identity", async () => {
    const { journey } = await makeJourney();
    const { status } = await call(`/by-journey/${journey.journeyId}`, { user: null });
    expect(status).toBe(401);
  });
});

describe("PATCH /enquiries/:id — header edits", () => {
  test("updates title, source and status", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const { status, body } = await call(`/${id}`, {
      method: "PATCH",
      body: { title: "Chef uniform replenishment 2027", source: "direct_rfq", status: "contacted" },
    });
    expect(status).toBe(200);
    expect(body.enquiry.title).toBe("Chef uniform replenishment 2027");
    expect(body.enquiry.source).toBe("direct_rfq");
    expect(body.enquiry.status).toBe("contacted");
  });

  test("rejects status=lost without a reason, accepts it with one", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const bad = await call(`/${id}`, { method: "PATCH", body: { status: "lost" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/reason/i);

    const ok = await call(`/${id}`, { method: "PATCH", body: { status: "lost", lostReason: "price_too_high" } });
    expect(ok.status).toBe(200);
    expect(ok.body.enquiry.status).toBe("lost");
    expect(ok.body.enquiry.lostReason).toBe("price_too_high");
  });

  test("clears the lost reason when the enquiry is no longer lost", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;
    await call(`/${id}`, { method: "PATCH", body: { status: "lost", lostReason: "no_response" } });

    const back = await call(`/${id}`, { method: "PATCH", body: { status: "qualified" } });
    expect(back.body.enquiry.status).toBe("qualified");
    expect(back.body.enquiry.lostReason == null).toBe(true);
  });

  test("replaces the products array and drops blank rows", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const { status, body } = await call(`/${id}`, {
      method: "PATCH",
      body: {
        products: [
          { product: "Front Office Shirt", quantity: 300 },
          { product: "", quantity: 999 }, // blank name — dropped
          { product: "Chef Coat", quantity: "150" }, // string qty — coerced
        ],
      },
    });
    expect(status).toBe(200);
    expect(body.enquiry.products).toHaveLength(2);
    expect(body.enquiry.products[0].product).toBe("Front Office Shirt");
    expect(body.enquiry.products[1].product).toBe("Chef Coat");
    expect(body.enquiry.products[1].quantity).toBe(150);
  });

  test("carries the per-product garment spec through, validating gender", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const { status, body } = await call(`/${id}`, {
      method: "PATCH",
      body: {
        products: [
          {
            product: "Chef Coat", quantity: 150, gender: "unisex", colour: "White",
            fabricComposition: "65/35 PC", gsm: "180 GSM", fit: "Regular", sizeRange: "S–XXL",
            logo: true, embroidery: true, printing: false, brandingPlacement: "Left chest",
            trims: "KAM snaps", existingUniform: "Plain white coats",
          },
          { product: "Polo", quantity: 500, gender: "banana" }, // invalid gender → dropped
        ],
      },
    });
    expect(status).toBe(200);
    const chef = body.enquiry.products[0];
    expect(chef.gender).toBe("unisex");
    expect(chef.colour).toBe("White");
    expect(chef.gsm).toBe("180 GSM");
    expect(chef.logo).toBe(true);
    expect(chef.embroidery).toBe(true);
    expect(chef.printing).toBe(false);
    expect(chef.brandingPlacement).toBe("Left chest");
    expect(body.enquiry.products[1].gender == null).toBe(true); // invalid enum not stored
  });

  test("saves indicative pricing and qualification, validating the enums", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const { status, body } = await call(`/${id}`, {
      method: "PATCH",
      body: {
        targetPrice: 750, estimatedPriceMin: 800, estimatedPriceMax: 900,
        opportunitySize: 2000000, winProbability: 70,
        priority: "high", seriousness: "hot", expectedOrderDate: "2026-10-01",
      },
    });
    expect(status).toBe(200);
    expect(body.enquiry.targetPrice).toBe(750);
    expect(body.enquiry.estimatedPriceMin).toBe(800);
    expect(body.enquiry.estimatedPriceMax).toBe(900);
    expect(body.enquiry.opportunitySize).toBe(2000000);
    expect(body.enquiry.winProbability).toBe(70);
    expect(body.enquiry.priority).toBe("high");
    expect(body.enquiry.seriousness).toBe("hot");
    expect(new Date(body.enquiry.expectedOrderDate).getUTCFullYear()).toBe(2026);
  });

  test("ignores invalid priority / seriousness values", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;
    const { body } = await call(`/${id}`, { method: "PATCH", body: { priority: "banana", seriousness: "lukewarm" } });
    expect(body.enquiry.priority == null).toBe(true);
    expect(body.enquiry.seriousness == null).toBe(true);
  });

  test("seeds our indicative estimate from the lead's unit price", async () => {
    const { journey } = await makeJourney();
    await Lead.create({ leadId: "LEAD-2026-8020", company: "ITC Hotels", conversion: { journeyId: journey._id }, estimatedUnitPrice: 850 });
    const { body } = await call(`/by-journey/${journey.journeyId}`);
    expect(body.enquiry.estimatedPriceMin).toBe(850);
    expect(body.enquiry.estimatedPriceMax).toBe(850);
  });

  test("enforces the status machine — rejects an illegal jump, allows a legal one", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    // new → development_started is illegal (must qualify first).
    const bad = await call(`/${id}`, { method: "PATCH", body: { status: "development_started" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/can't move/i);

    // Walk the funnel legally.
    await call(`/${id}`, { method: "PATCH", body: { status: "contacted" } });
    await call(`/${id}`, { method: "PATCH", body: { status: "requirement_gathering" } });
    const q = await call(`/${id}`, { method: "PATCH", body: { status: "qualified" } });
    expect(q.body.enquiry.status).toBe("qualified");
    const dev = await call(`/${id}`, { method: "PATCH", body: { status: "development_started" } });
    expect(dev.status).toBe(200);
    expect(dev.body.enquiry.status).toBe("development_started");
  });

  test("allows reopening a lost enquiry back into the funnel", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;
    await call(`/${id}`, { method: "PATCH", body: { status: "lost", lostReason: "no_response" } });
    const reopened = await call(`/${id}`, { method: "PATCH", body: { status: "contacted" } });
    expect(reopened.status).toBe(200);
    expect(reopened.body.enquiry.status).toBe("contacted");
  });

  test("a no-op status (saving other fields) is allowed", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;
    const { status, body } = await call(`/${id}`, { method: "PATCH", body: { status: "new", title: "Renamed" } });
    expect(status).toBe(200);
    expect(body.enquiry.title).toBe("Renamed");
    expect(body.enquiry.status).toBe("new");
  });

  test("saves references, drops empty rows, and defaults an unknown type to other", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;

    const { status, body } = await call(`/${id}`, {
      method: "PATCH",
      body: {
        references: [
          { type: "reference_image", label: "Front office board", url: "https://pin.it/abc" },
          { type: "banana", note: "Physical sample couriered 12 Aug" }, // unknown type → other
          { type: "logo", label: "", url: "", note: "" }, // fully empty → dropped
        ],
      },
    });
    expect(status).toBe(200);
    expect(body.enquiry.references).toHaveLength(2);
    expect(body.enquiry.references[0].type).toBe("reference_image");
    expect(body.enquiry.references[0].url).toBe("https://pin.it/abc");
    expect(body.enquiry.references[1].type).toBe("other");
    expect(body.enquiry.references[1].note).toContain("couriered");
  });

  test("ignores an invalid status value", async () => {
    const { journey } = await makeJourney();
    const { body: got } = await call(`/by-journey/${journey.journeyId}`);
    const id = got.enquiry._id;
    const { body } = await call(`/${id}`, { method: "PATCH", body: { status: "banana" } });
    expect(body.enquiry.status).toBe("new"); // unchanged
  });
});
