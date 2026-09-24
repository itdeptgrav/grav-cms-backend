// test/sales/enquiry-branding-provision.test.js
//
// THE DECORATIONS REACH R&D.
//
// A style's `brief` is the snapshot R&D develops from. It carried branding as
// one sentence built from three booleans — "Logo, Embroidery" — plus a single
// placement string, which is all an enquiry could hold. The customer's artwork
// reached nobody: there was no field for it, on either record.
//
// This drives the real provisioning route and asserts what arrives on the
// SampleStyle: every requirement, with its placement, size, colour notes and
// the customer's artwork — including the Cloudinary `publicId` the brief's
// image schema used to strip, without which no thumbnail resolves.
//
// It also holds the line that matters most downstream: what arrives is the
// BUYER's reference material, and the brief says so. The approved asset for a
// style is its tech sheet, which has an approver and a date.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => {
  const jwtLib = require("jsonwebtoken");
  const mw = (req, res, next) => {
    const header = req.headers.authorization || "";
    if (!header.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Authentication required." });
    }
    try {
      req.user = jwtLib.verify(header.slice(7), process.env.JWT_SECRET || "grav_clothing_secret_key");
      next();
    } catch {
      res.status(401).json({ success: false, message: "Invalid token." });
    }
  };
  mw.withRoles = () => mw;
  mw.RND_ROLES = [];
  return mw;
});
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Account = require("../../models/CMS_Models/Sales/Account");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/sample-styles", require("../../routes/CMS_Routes/Sales/sampleStyles"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const token = () => jwt.sign(
  { id: new mongoose.Types.ObjectId().toString(), email: "sales@grav.test", name: "Anita", role: "sales", isAdmin: true },
  process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
);

const call = (path, { method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token()}` },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

/** An enquiry on a journey, with whatever product rows the test needs. */
async function world(products) {
  const n = ++seq;
  const co = await Acc_Company.create({ companyName: `Co ${n}`, booksFromDate: new Date("2026-04-01") });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-BR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "Anita",
  });
  await Enquiry.create({
    enquiryId: `ENQ-BR-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true, products,
  });
  return { journey };
}

const provision = (journey) =>
  call(`/api/cms/crm/sample-styles/by-journey/${journey.journeyId}/provision`, { method: "POST", body: {} });

const styleFor = (journey, productName) =>
  SampleStyle.findOne({ journeyId: journey._id, productName }).lean();

test("every branding requirement reaches the style brief, artwork and all", async () => {
  const { journey } = await world([{
    product: "Polo",
    quantity: 500,
    brandingRequirements: [
      {
        type: "embroidery", placement: "Left chest", width: 8, height: 4, unit: "cm",
        colourNotes: "Pantone 280 C", artworkState: "provided",
        artwork: [
          { publicId: "pid-logo", name: "logo.png", url: "https://res.cloudinary.com/x/logo.png" },
          { fileId: "fid-old", name: "old.jpg", url: "https://drive/old" },
        ],
      },
      {
        type: "screen_print", placement: "Back yoke", artworkState: "awaiting_customer",
        notes: "Customer will send the slogan.",
      },
    ],
  }]);

  const res = await provision(journey);
  expect(res.status).toBe(200);

  const style = await styleFor(journey, "Polo");
  const rows = style.brief.brandingRequirements;
  expect(rows).toHaveLength(2);

  const [chest, back] = rows;
  expect(chest.type).toBe("embroidery");
  expect(chest.placement).toBe("Left chest");
  expect(chest.width).toBe(8);
  expect(chest.unit).toBe("cm");
  expect(chest.colourNotes).toBe("Pantone 280 C");
  expect(chest.artworkState).toBe("provided");
  // Both storage shapes survive the hop. `publicId` is the one the brief's
  // image schema silently stripped before this work — no publicId, no
  // thumbnail, because the frontend's transform keys on exactly that field.
  expect(chest.artwork.map((a) => a.publicId || a.fileId)).toEqual(["pid-logo", "fid-old"]);
  expect(chest.artwork[0].publicId).toBe("pid-logo");

  expect(back.placement).toBe("Back yoke");
  expect(back.artworkState).toBe("awaiting_customer");
  expect(back.notes).toMatch(/slogan/);

  // Each requirement keeps the reference it was issued on the enquiry, so a
  // screen can point back at one decoration rather than at "the second row".
  const enquiry = await Enquiry.findOne({ journeyId: journey._id }).lean();
  expect(rows.map((r) => r.ref)).toEqual(enquiry.products[0].brandingRequirements.map((r) => r.ref));

  // And what arrived is the buyer's material, not an approved production file.
  expect(style.brief.artworkIsCustomerReference).toBe(true);
  expect(style.techSheet?.file?.url).toBeFalsy();
});

test("an old record provisions as readable requirements rather than as nothing", async () => {
  const { journey } = await world([{
    product: "Shirt", quantity: 200, embroidery: true, printing: true, brandingPlacement: "Left chest",
  }]);

  expect((await provision(journey)).status).toBe(200);

  const style = await styleFor(journey, "Shirt");
  const rows = style.brief.brandingRequirements;
  expect(rows).toHaveLength(2);
  expect(rows.map((r) => r.type).sort()).toEqual(["embroidery", "other"]);
  for (const r of rows) {
    expect(r.placement).toBe("Left chest");
    expect(r.legacy).toBe(true);
    // Projected rows never claim the customer's artwork is in hand.
    expect(r.artworkState).toBe("reference_only");
    expect(r.artwork || []).toHaveLength(0);
  }
  // The one-line summary an older R&D screen reads is still there.
  expect(style.brief.branding).toBe("Embroidery, Printing");
  expect(style.brief.brandingPlacement).toBe("Left chest");
});

test("one product's artwork never appears on another product's style", async () => {
  const { journey } = await world([
    {
      product: "Polo",
      brandingRequirements: [{
        type: "embroidery", placement: "Left chest", artworkState: "provided",
        artwork: [{ publicId: "pid-polo-logo", url: "https://res.cloudinary.com/x/polo.png" }],
      }],
    },
    {
      product: "Cap",
      brandingRequirements: [{
        type: "woven_patch", placement: "Front panel", artworkState: "reference_only",
      }],
    },
  ]);

  expect((await provision(journey)).status).toBe(200);

  const polo = await styleFor(journey, "Polo");
  const cap = await styleFor(journey, "Cap");
  expect(polo.brief.brandingRequirements[0].artwork.map((a) => a.publicId)).toEqual(["pid-polo-logo"]);
  expect(cap.brief.brandingRequirements[0].artwork || []).toHaveLength(0);
  const capArtwork = cap.brief.brandingRequirements.flatMap((r) => r.artwork || []);
  expect(capArtwork).toHaveLength(0);
});

test("re-provisioning refreshes the requirements instead of appending them", async () => {
  const { journey } = await world([{
    product: "Tee",
    brandingRequirements: [{ type: "embroidery", placement: "Left chest", artworkState: "reference_only" }],
  }]);
  await provision(journey);

  // Sales edits the decoration and hands the journey over again.
  const enquiry = await Enquiry.findOne({ journeyId: journey._id });
  enquiry.products[0].brandingRequirements[0].placement = "Right chest";
  enquiry.products[0].brandingRequirements.push({
    type: "heat_transfer", placement: "Sleeve", artworkState: "awaiting_customer",
  });
  await enquiry.save();
  await provision(journey);

  const style = await styleFor(journey, "Tee");
  expect(style.brief.brandingRequirements).toHaveLength(2);
  expect(style.brief.brandingRequirements[0].placement).toBe("Right chest");
  expect(style.brief.brandingRequirements[1].type).toBe("heat_transfer");
});

test("the garment's reference images stay the garment's on the style brief", async () => {
  const { journey } = await world([{
    product: "Polo",
    images: [{ publicId: "pid-garment", name: "front.png", url: "https://res.cloudinary.com/x/front.png" }],
    brandingRequirements: [{
      type: "embroidery", placement: "Left chest", artworkState: "provided",
      artwork: [{ publicId: "pid-logo", url: "https://res.cloudinary.com/x/logo.png" }],
    }],
  }]);
  await provision(journey);

  const style = await styleFor(journey, "Polo");
  expect(style.brief.images.map((i) => i.publicId)).toEqual(["pid-garment"]);
  expect(style.brief.brandingRequirements[0].artwork.map((i) => i.publicId)).toEqual(["pid-logo"]);
  expect(style.brief.images.some((i) => i.publicId === "pid-logo")).toBe(false);
});
