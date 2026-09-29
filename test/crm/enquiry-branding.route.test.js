// test/crm/enquiry-branding.route.test.js
//
// BRANDING, EMBROIDERY AND PRINT ON AN ENQUIRY PRODUCT LINE.
//
// A product line used to describe its decoration as three booleans
// (`logo` / `embroidery` / `printing`) and one `brandingPlacement` string, and
// the customer's artwork had nowhere to live at all. A left-chest embroidered
// logo and a back print — one ordinary uniform order — collapsed into
// "embroidery: true, printing: true, placement: 'left chest, back'", and the
// files arrived later by email, or never.
//
// Each decoration is now its own requirement, with its own placement, size,
// colour notes, artwork-state and artwork. What these tests hold to:
//
//   · A requirement's identity is a server-minted `ref`, not a position and
//     not its type — one product legitimately carries two embroideries.
//   · A reference belongs to ITS product line. Claiming another line's is
//     refused, so one product's artwork can never be attached to another.
//   · The old fields are still written, re-derived from the structured rows,
//     so every screen still reading them keeps telling the truth.
//   · An old record still reads, and opening and saving it twice does not
//     duplicate its branding.
//   · The garment's `images` and a requirement's `artwork` never mix.
//
// Every test drives the real router over HTTP against isolated in-memory data.
"use strict";

const express = require("express");
const mongoose = require("mongoose");

jest.mock("../../Middlewear/SalesAuthMiddlewear", () => (req, res, next) => {
  const raw = req.headers["x-test-user"];
  if (!raw) return res.status(401).json({ success: false, message: "Authentication required." });
  req.user = JSON.parse(raw);
  next();
});
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const {
  BRANDING_REF_PATTERN, brandingRequirementsOf, legacyMirror,
} = require("../../models/CMS_Models/Sales/enquiryBrandingRequirement");

const SALES = { id: new mongoose.Types.ObjectId().toString(), name: "Anita Rao", role: "sales" };

let server;
let base;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/cms/crm/enquiries", require("../../routes/CMS_Routes/Sales/enquiries"));
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/crm/enquiries`;
});
afterAll(async () => { await new Promise((resolve) => server.close(resolve)); });

let CO;
let seq = 0;
beforeEach(async () => {
  await Promise.all([Enquiry.deleteMany({}), Account.deleteMany({})]);
  const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
  await Acc_Company.deleteMany({});
  CO = await Acc_Company.create({ companyName: "Test Co", booksFromDate: new Date("2026-04-01") });
});

async function call(path, { method = "GET", body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", "x-test-user": JSON.stringify(SALES) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
const patch = (enquiry, body) => call(`/${enquiry._id}`, { method: "PATCH", body });
const reload = (enquiry) => Enquiry.findById(enquiry._id).lean();
/** The rows as a browser holds them after a load — references included. */
const asLoaded = (doc) => doc.products.map(({ _id, ...row }) => ({ ...row }));

async function enquiryWith(products) {
  const n = ++seq;
  const account = await Account.create({ companyId: CO._id, companyName: `Buyer ${n}`, status: "active" });
  const e = await Enquiry.create({
    enquiryId: `ENQ-BR-${n}`, companyId: CO._id, accountId: account._id,
    journeyId: new mongoose.Types.ObjectId(), title: `Enquiry ${n}`, isActive: true, products,
  });
  return reload(e);
}

const cloudinary = (n) => ({ publicId: `pid-${n}`, name: `${n}.png`, url: `https://res.cloudinary.com/x/${n}.png` });
const drive = (n) => ({ fileId: `fid-${n}`, name: `${n}.jpg`, url: `https://drive/${n}` });

const CHEST = {
  type: "embroidery", placement: "Left chest", width: 8, height: 4, unit: "cm",
  colourNotes: "Pantone 280 C", artworkState: "provided", artwork: [cloudinary("logo")],
};
const BACK = {
  type: "screen_print", placement: "Back yoke", artworkState: "awaiting_customer",
  notes: "Customer will send the slogan artwork.",
};

/* ══ MANY DECORATIONS, EACH WITH ITS OWN ARTWORK ═══════════════════════════ */

test("a product line stores several branding requirements, each with its own artwork", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST, BACK];

  const res = await patch(e, { products: rows });
  expect(res.status).toBe(200);

  const saved = (await reload(e)).products[0];
  expect(saved.brandingRequirements).toHaveLength(2);
  const [chest, back] = saved.brandingRequirements;
  expect(chest.placement).toBe("Left chest");
  expect(chest.width).toBe(8);
  expect(chest.colourNotes).toBe("Pantone 280 C");
  expect(chest.artwork.map((a) => a.publicId)).toEqual(["pid-logo"]);
  expect(back.placement).toBe("Back yoke");
  expect(back.artworkState).toBe("awaiting_customer");
  expect(back.artwork || []).toHaveLength(0);
  // Every requirement is issued its own permanent reference.
  for (const r of saved.brandingRequirements) expect(r.ref).toMatch(BRANDING_REF_PATTERN);
  expect(saved.brandingRequirements[0].ref).not.toBe(saved.brandingRequirements[1].ref);
});

test("one requirement carries several artwork images", async () => {
  const e = await enquiryWith([{ product: "Tee" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [{ ...CHEST, artwork: [cloudinary("a"), cloudinary("b"), drive("c")] }];
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0].brandingRequirements[0];
  expect(saved.artwork).toHaveLength(3);
  // Both storage shapes survive — Cloudinary's publicId and Drive's fileId.
  expect(saved.artwork.map((a) => a.publicId || a.fileId)).toEqual(["pid-a", "pid-b", "fid-c"]);
});

test("the garment's reference images and a requirement's artwork never mix", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].images = [cloudinary("garment-front"), cloudinary("garment-back")];
  rows[0].brandingRequirements = [CHEST];
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0];
  expect(saved.images.map((i) => i.publicId)).toEqual(["pid-garment-front", "pid-garment-back"]);
  expect(saved.brandingRequirements[0].artwork.map((i) => i.publicId)).toEqual(["pid-logo"]);
  // Neither gallery has absorbed the other.
  expect(saved.images.some((i) => i.publicId === "pid-logo")).toBe(false);
});

/* ══ IDENTITY SURVIVES EDITING ════════════════════════════════════════════ */

test("a reference survives a rename, a reorder and an edit of another row", async () => {
  const e = await enquiryWith([{ product: "Polo" }, { product: "Cap" }]);
  let rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST, BACK];
  await patch(e, { products: rows });

  const before = (await reload(e)).products[0].brandingRequirements.map((r) => r.ref);

  // Rename the product, reverse its requirements, and change the other row.
  const loaded = await reload(e);
  rows = asLoaded(loaded);
  rows[0].product = "Polo — navy";
  rows[0].brandingRequirements = [...loaded.products[0].brandingRequirements].reverse()
    .map(({ _id, ...r }) => r);
  rows[1].quantity = 250;
  const res = await patch(e, { products: rows, renames: [{ from: "Polo", to: "Polo — navy" }] });
  expect(res.status).toBe(200);

  const after = (await reload(e)).products[0];
  expect(after.product).toBe("Polo — navy");
  expect(after.brandingRequirements.map((r) => r.ref)).toEqual([before[1], before[0]]);
  // The artwork went with its own requirement, not with a position.
  const chest = after.brandingRequirements.find((r) => r.ref === before[0]);
  expect(chest.placement).toBe("Left chest");
  expect(chest.artwork.map((a) => a.publicId)).toEqual(["pid-logo"]);
});

test("removing one requirement leaves the others exactly as they were", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  let rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST, BACK, { type: "woven_patch", placement: "Sleeve", artworkState: "reference_only" }];
  await patch(e, { products: rows });

  const loaded = await reload(e);
  const [chestRef, , sleeveRef] = loaded.products[0].brandingRequirements.map((r) => r.ref);
  rows = asLoaded(loaded);
  rows[0].brandingRequirements = loaded.products[0].brandingRequirements
    .filter((r) => r.ref !== loaded.products[0].brandingRequirements[1].ref)
    .map(({ _id, ...r }) => r);
  await patch(e, { products: rows });

  const after = (await reload(e)).products[0].brandingRequirements;
  expect(after.map((r) => r.ref)).toEqual([chestRef, sleeveRef]);
  expect(after[0].artwork.map((a) => a.publicId)).toEqual(["pid-logo"]);
  expect(after[1].placement).toBe("Sleeve");
});

/* ══ ONE PRODUCT'S ARTWORK CANNOT REACH ANOTHER ═══════════════════════════ */

test("a save claiming another product's branding reference is refused", async () => {
  const e = await enquiryWith([{ product: "Polo" }, { product: "Cap" }]);
  let rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST];
  await patch(e, { products: rows });

  const loaded = await reload(e);
  const poloRef = loaded.products[0].brandingRequirements[0].ref;

  // The cap claims the shirt's chest requirement — with its own artwork.
  rows = asLoaded(loaded);
  rows[0].brandingRequirements = loaded.products[0].brandingRequirements.map(({ _id, ...r }) => r);
  rows[1].brandingRequirements = [{ ...CHEST, ref: poloRef, artwork: [cloudinary("someone-elses")] }];

  const res = await patch(e, { products: rows });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("BRANDING_REF_FOREIGN");

  // Nothing moved, and nothing was saved onto either product.
  const after = (await reload(e)).products;
  expect(after[0].brandingRequirements[0].ref).toBe(poloRef);
  expect(after[0].brandingRequirements[0].artwork.map((a) => a.publicId)).toEqual(["pid-logo"]);
  expect(after[1].brandingRequirements || []).toHaveLength(0);
});

test("a forged or deleted branding reference is refused, not minted", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [{ ...CHEST, ref: "BR-0123456789ab" }];

  const res = await patch(e, { products: rows });
  expect(res.status).toBe(409);
  expect(res.body.code).toBe("BRANDING_REF_UNKNOWN");
  expect((await reload(e)).products[0].brandingRequirements || []).toHaveLength(0);
});

test("a malformed reference is refused", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [{ ...CHEST, ref: "not-a-reference" }];
  const res = await patch(e, { products: rows });
  expect(res.status).toBe(400);
  expect(res.body.code).toBe("BRANDING_REF_MALFORMED");
});

/* ══ OLD RECORDS ══════════════════════════════════════════════════════════ */

test("a record written with the old booleans still reads as requirements", async () => {
  const e = await enquiryWith([{
    product: "Shirt", logo: true, embroidery: true, brandingPlacement: "Left chest",
  }]);
  const projected = brandingRequirementsOf((await reload(e)).products[0]);

  expect(projected).toHaveLength(2);
  expect(projected.map((r) => r.type).sort()).toEqual(["embroidery", "logo_badge"]);
  for (const r of projected) {
    expect(r.placement).toBe("Left chest");
    expect(r.legacy).toBe(true);
    // A projection has no stored identity, and never claims artwork is in hand.
    expect(r.ref).toBeNull();
    expect(r.artworkState).toBe("reference_only");
  }
});

test("the old printing flag is never guessed into a print method", () => {
  const [row] = brandingRequirementsOf({ printing: true, brandingPlacement: "Back" });
  expect(row.type).toBe("other");
  expect(row.notes).toMatch(/Printing/);
});

test("opening and saving an old record twice does not duplicate its branding", async () => {
  const e = await enquiryWith([{
    product: "Shirt", embroidery: true, printing: true, brandingPlacement: "Left chest",
  }]);

  // First edit: the form opens on the projection and saves it back.
  let loaded = await reload(e);
  let rows = asLoaded(loaded);
  rows[0].brandingRequirements = brandingRequirementsOf(loaded.products[0])
    .map(({ ref, legacy, ...r }) => r);
  await patch(e, { products: rows });

  const first = (await reload(e)).products[0].brandingRequirements;
  expect(first).toHaveLength(2);
  expect(first.map((r) => r.legacyKey).sort()).toEqual(["embroidery", "printing"]);

  // Second edit: it now opens on the STORED rows — the projection is off.
  loaded = await reload(e);
  rows = asLoaded(loaded);
  rows[0].brandingRequirements = loaded.products[0].brandingRequirements.map(({ _id, ...r }) => r);
  rows[0].quantity = 300;
  await patch(e, { products: rows });

  const second = (await reload(e)).products[0].brandingRequirements;
  expect(second).toHaveLength(2);
  expect(second.map((r) => r.ref)).toEqual(first.map((r) => r.ref));
});

test("a stale screen that resends the projection twice still stores one row per old flag", async () => {
  const e = await enquiryWith([{ product: "Shirt", embroidery: true, brandingPlacement: "Chest" }]);
  const rows = asLoaded(e);
  // The same legacy row sent twice — what a double submit looks like.
  rows[0].brandingRequirements = [
    { type: "embroidery", placement: "Chest", artworkState: "reference_only", legacyKey: "embroidery" },
    { type: "embroidery", placement: "Chest", artworkState: "reference_only", legacyKey: "embroidery" },
  ];
  await patch(e, { products: rows });
  expect((await reload(e)).products[0].brandingRequirements).toHaveLength(1);
});

/* ══ THE OLD FIELDS KEEP TELLING THE TRUTH ════════════════════════════════ */

test("saving structured requirements re-derives the old booleans and placement", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST, BACK];
  // The browser sends stale booleans; the server derives them from the rows.
  rows[0].logo = true;
  rows[0].printing = false;
  rows[0].brandingPlacement = "whatever was typed before";
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0];
  expect(saved.embroidery).toBe(true);
  expect(saved.printing).toBe(true); // a screen print IS printing
  expect(saved.logo).toBe(false); // no logo badge or woven patch among them
  expect(saved.brandingPlacement).toBe("Left chest, Back yoke");
});

test("an ordinary edit that says nothing about branding never erases the old booleans", async () => {
  /* "Says nothing" is the whole point, and it is a different sentence from
     "sent empty". A row nobody edited goes up WITHOUT `brandingRequirements`
     — see productsForWire in the frontend — and keeps what it has. A row sent
     with an empty array is a deliberate clear and resets the mirrors; that is
     asserted in enquiry-start-development.route.test.js. */
  const e = await enquiryWith([{
    product: "Shirt", embroidery: true, brandingPlacement: "Left chest",
  }]);
  const rows = (await reload(e)).products.map(({ _id, brandingRequirements, ...row }) => ({ ...row }));
  rows[0].quantity = 750; // an ordinary quantity edit, branding untouched
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0];
  expect(saved.embroidery).toBe(true);
  expect(saved.brandingPlacement).toBe("Left chest");
});

test("legacyMirror says nothing when there is nothing to mirror", () => {
  expect(legacyMirror([])).toBeNull();
  expect(legacyMirror(undefined)).toBeNull();
});

/* ══ WHAT THE SERVER REFUSES TO STORE ═════════════════════════════════════ */

test("an unknown type or artwork state is dropped rather than stored", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [{
    type: "sublimation", placement: "Chest", artworkState: "approved", artwork: [cloudinary("a")],
  }];
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0].brandingRequirements[0];
  expect(saved.type).toBeUndefined();
  // "approved" is not a state Sales can claim — the row is stored as unanswered.
  expect(saved.artworkState).toBeUndefined();
  expect(saved.placement).toBe("Chest");
});

test("a blank editor row is not stored as a requirement", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [CHEST, { type: "", placement: "", artwork: [], unit: "cm" }];
  await patch(e, { products: rows });
  expect((await reload(e)).products[0].brandingRequirements).toHaveLength(1);
});

test("an image with nothing to resolve it is not stored as artwork", async () => {
  const e = await enquiryWith([{ product: "Polo" }]);
  const rows = asLoaded(e);
  rows[0].brandingRequirements = [{ ...CHEST, artwork: [{ name: "pasted.png" }, cloudinary("real")] }];
  await patch(e, { products: rows });

  const saved = (await reload(e)).products[0].brandingRequirements[0];
  expect(saved.artwork).toHaveLength(1);
  expect(saved.artwork[0].publicId).toBe("pid-real");
});
