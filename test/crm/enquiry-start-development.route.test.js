// test/crm/enquiry-start-development.route.test.js
//
// START DEVELOPMENT IS DECIDED BY THE SERVER, AND OMITTED IS NOT EMPTY.
//
// Two corrections, both about trusting the browser:
//
// 1. READINESS. The rule — a picture of the garment, and every branding
//    requirement saying what it is, where it goes and whether the customer's
//    artwork is in hand — was enforced only by greying out a button. A PATCH
//    that sets `status: "development_started"` is an ordinary request: an old
//    build, a second tab, a retry from an offline queue or a script all reach
//    the route without passing the button. The route now judges the enquiry AS
//    SAVED and refuses with the product and the requirement that are not ready.
//
// 2. EMPTY-LIST SEMANTICS. An ABSENT `brandingRequirements` means "this client
//    did not edit branding here" and must preserve both the stored rows and
//    the legacy booleans. An EMPTY ARRAY means "a person removed every
//    requirement" and must clear the rows AND reset the old mirrors — without
//    that reset, the projection reads the booleans straight back and the
//    deleted requirement returns on the very next load.
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
  brandingRequirementsOf,
} = require("../../models/CMS_Models/Sales/enquiryBrandingRequirement");
const {
  READINESS_BLOCKER, evaluateEnquiryReadiness,
} = require("../../services/sales/enquiryProductReadiness.service");

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

async function call(path, { method = "GET", body, user = SALES } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(user ? { "x-test-user": JSON.stringify(user) } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: await res.json() };
}
const patch = (e, body, opts = {}) => call(`/${e._id}`, { method: "PATCH", body, ...opts });
const reload = (e) => Enquiry.findById(e._id).lean();
const asLoaded = (doc) => doc.products.map(({ _id, ...row }) => ({ ...row }));
/** What the current browser sends for a row nobody edited: no branding field. */
const untouched = (doc) => doc.products.map(({ _id, brandingRequirements, ...row }) => ({ ...row }));

const img = (n) => ({ publicId: `pid-${n}`, name: `${n}.png`, url: `https://res.cloudinary.com/x/${n}.png` });

const READY_REQUIREMENT = {
  type: "embroidery", placement: "Left chest", artworkState: "provided", artwork: [img("logo")],
};

async function enquiryWith(products, status = "qualified") {
  const n = ++seq;
  const account = await Account.create({ companyId: CO._id, companyName: `Buyer ${n}`, status: "active" });
  const e = await Enquiry.create({
    enquiryId: `ENQ-SD-${n}`, companyId: CO._id, accountId: account._id, status,
    journeyId: new mongoose.Types.ObjectId(), title: `Enquiry ${n}`, isActive: true, products,
  });
  return reload(e);
}

const start = (e) => patch(e, { status: "development_started" });

/* ══ 1. THE SERVER DECIDES ════════════════════════════════════════════════ */

test("a ready enquiry starts development", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  const res = await start(e);
  expect(res.status).toBe(200);
  expect((await reload(e)).status).toBe("development_started");
});

test("a product with no picture is refused, naming the product", async () => {
  const e = await enquiryWith([{ product: "Polo", brandingRequirements: [READY_REQUIREMENT] }]);
  const res = await start(e);

  expect(res.status).toBe(422);
  expect(res.body.code).toBe("ENQUIRY_NOT_READY");
  expect(res.body.products).toHaveLength(1);
  expect(res.body.products[0].product).toBe("Polo");
  expect(res.body.products[0].blockers.map((b) => b.code)).toContain(READINESS_BLOCKER.NO_PRODUCT_IMAGE);
  // Refused means nothing moved.
  expect((await reload(e)).status).toBe("qualified");
});

test("the refusal names the branding requirement by its permanent reference", async () => {
  const e = await enquiryWith([{
    product: "Polo", images: [img("front")],
    brandingRequirements: [
      READY_REQUIREMENT,
      { type: "screen_print", artworkState: "reference_only" }, // no placement
    ],
  }]);
  const saved = await reload(e);
  const badRef = saved.products[0].brandingRequirements[1].ref;

  const res = await start(e);
  expect(res.status).toBe(422);
  const blockers = res.body.products[0].blockers;
  const placement = blockers.find((b) => b.code === READINESS_BLOCKER.PLACEMENT);
  expect(placement).toBeTruthy();
  expect(placement.ref).toBe(badRef);
  expect(placement.label).toBe("Screen print");
  expect(placement.message).toMatch(/where it goes/i);
});

test("artwork marked provided with nothing attached is refused", async () => {
  const e = await enquiryWith([{
    product: "Polo", images: [img("front")],
    brandingRequirements: [{ type: "embroidery", placement: "Left chest", artworkState: "provided" }],
  }]);
  const res = await start(e);
  expect(res.status).toBe(422);
  expect(res.body.products[0].blockers.map((b) => b.code)).toContain(READINESS_BLOCKER.ARTWORK_MISSING);
});

test("awaiting customer artwork blocks, and is reported as the customer's action", async () => {
  const e = await enquiryWith([{
    product: "Polo", images: [img("front")],
    brandingRequirements: [{ type: "embroidery", placement: "Left chest", artworkState: "awaiting_customer" }],
  }]);
  const res = await start(e);
  expect(res.status).toBe(422);
  const b = res.body.products[0].blockers.find((x) => x.code === READINESS_BLOCKER.AWAITING_ARTWORK);
  expect(b).toBeTruthy();
  expect(b.pending).toBe(true);
});

test("an enquiry with no products at all is refused", async () => {
  const e = await enquiryWith([]);
  const res = await start(e);
  expect(res.status).toBe(422);
  expect(res.body.message).toMatch(/Add at least one product/i);
  expect(res.body.products).toEqual([]);
});

test("a legacy product with an unplaced old flag is refused on the projection", async () => {
  // The old booleans are all this record has; the gate judges them through the
  // same projection every screen renders, rather than skipping the row.
  const e = await enquiryWith([{ product: "Shirt", images: [img("front")], embroidery: true }]);
  const res = await start(e);
  expect(res.status).toBe(422);
  expect(res.body.products[0].blockers.map((b) => b.code)).toContain(READINESS_BLOCKER.PLACEMENT);
});

test("a legacy product whose old flags carry a placement is allowed through", async () => {
  const e = await enquiryWith([{
    product: "Shirt", images: [img("front")], embroidery: true, brandingPlacement: "Left chest",
  }]);
  expect((await start(e)).status).toBe(200);
});

test("the browser cannot vouch for itself — a readiness claim in the body is ignored", async () => {
  const e = await enquiryWith([{ product: "Polo", brandingRequirements: [READY_REQUIREMENT] }]);
  const res = await patch(e, {
    status: "development_started",
    ready: true, readiness: { ready: true }, blockers: [],
  });
  expect(res.status).toBe(422);
  expect((await reload(e)).status).toBe("qualified");
});

test("products sent in the same request are judged, and are not saved when refused", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  const rows = asLoaded(e);
  // The same PATCH removes the picture and starts development.
  rows[0].images = [];
  const res = await patch(e, { products: rows, status: "development_started" });

  expect(res.status).toBe(422);
  expect(res.body.products[0].blockers.map((b) => b.code)).toContain(READINESS_BLOCKER.NO_PRODUCT_IMAGE);
  const after = await reload(e);
  expect(after.status).toBe("qualified");
  expect(after.products[0].images).toHaveLength(1); // the edit was refused with it
});

test("a second click is safe", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  expect((await start(e)).status).toBe(200);
  // The enquiry is already there: the same request is no longer a transition,
  // so it neither re-runs the gate nor trips the status machine.
  const again = await patch(await reload(e), { status: "development_started" });
  expect(again.status).toBe(200);
  expect((await reload(e)).status).toBe("development_started");
});

test("a refused start leaves an already-started enquiry alone", async () => {
  // Moving BACKWARDS out of development is the status machine's business, not
  // readiness'. Readiness only ever guards the step into development.
  const e = await enquiryWith([{ product: "Polo" }], "development_started");
  const res = await patch(e, { status: "on_hold" });
  expect(res.status).toBe(200);
  expect((await reload(e)).status).toBe("on_hold");
});

test("an unauthenticated request cannot start development", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  const res = await patch(e, { status: "development_started" }, { user: null });
  expect(res.status).toBe(401);
  expect((await reload(e)).status).toBe("qualified");
});

test("one enquiry's readiness says nothing about another's", async () => {
  const ready = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  const notReady = await enquiryWith([{ product: "Cap" }]);
  expect((await start(ready)).status).toBe(200);
  expect((await start(notReady)).status).toBe(422);
  expect((await reload(ready)).status).toBe("development_started");
  expect((await reload(notReady)).status).toBe("qualified");
});

test("the gate and the reported reasons come from one evaluation", () => {
  // The route refuses on exactly what this service returns — no second list of
  // rules anywhere else in the backend.
  const verdict = evaluateEnquiryReadiness([{ product: "Polo" }]);
  expect(verdict.ready).toBe(false);
  expect(verdict.blocked[0].blockers[0].code).toBe(READINESS_BLOCKER.NO_PRODUCT_IMAGE);
  expect(evaluateEnquiryReadiness([]).ready).toBe(false);
});

/* ══ 2. OMITTED IS NOT EMPTY ══════════════════════════════════════════════ */

test("a row that omits branding keeps its structured requirements", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);
  const before = (await reload(e)).products[0].brandingRequirements;

  // An ordinary quantity edit, sent the way the screen sends untouched rows.
  const rows = untouched(await reload(e));
  rows[0].quantity = 750;
  expect(await patch(e, { products: rows }).then((r) => r.status)).toBe(200);

  const after = (await reload(e)).products[0];
  expect(after.quantity).toBe(750);
  expect(after.brandingRequirements).toHaveLength(1);
  expect(after.brandingRequirements[0].ref).toBe(before[0].ref);
  expect(after.brandingRequirements[0].artwork.map((a) => a.publicId)).toEqual(["pid-logo"]);
});

test("a row that omits branding keeps its legacy booleans", async () => {
  const e = await enquiryWith([{ product: "Shirt", embroidery: true, logo: true, brandingPlacement: "Left chest" }]);
  const rows = untouched(await reload(e));
  rows[0].quantity = 300;
  await patch(e, { products: rows });

  const after = (await reload(e)).products[0];
  expect(after.embroidery).toBe(true);
  expect(after.logo).toBe(true);
  expect(after.brandingPlacement).toBe("Left chest");
});

test("an explicit empty array removes the rows AND resets the old mirrors", async () => {
  const e = await enquiryWith([{
    product: "Polo", images: [img("front")],
    brandingRequirements: [READY_REQUIREMENT, { type: "screen_print", placement: "Back", artworkState: "reference_only" }],
  }]);
  // Saving the structured rows set the mirrors; now everything is removed.
  const rows = asLoaded(await reload(e));
  rows[0].brandingRequirements = [];
  expect(await patch(e, { products: rows }).then((r) => r.status)).toBe(200);

  const after = (await reload(e)).products[0];
  expect(after.brandingRequirements).toHaveLength(0);
  expect(after.embroidery).toBe(false);
  expect(after.printing).toBe(false);
  expect(after.logo).toBe(false);
  expect(after.brandingPlacement).toBeUndefined();
  // And nothing is projected back out of the booleans.
  expect(brandingRequirementsOf(after)).toHaveLength(0);
});

test("deleting the final requirement, reloading and editing again does not resurrect it", async () => {
  const e = await enquiryWith([{ product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] }]);

  // Delete the last one.
  let rows = asLoaded(await reload(e));
  rows[0].brandingRequirements = [];
  await patch(e, { products: rows });
  expect((await reload(e)).products[0].brandingRequirements).toHaveLength(0);

  // Reload and edit something else — the way the screen sends an untouched row.
  rows = untouched(await reload(e));
  rows[0].quantity = 120;
  await patch(e, { products: rows });

  const after = (await reload(e)).products[0];
  expect(after.quantity).toBe(120);
  expect(after.brandingRequirements).toHaveLength(0);
  expect(brandingRequirementsOf(after)).toHaveLength(0);
});

test("clearing a legacy row's projected branding sticks across a reload", async () => {
  // The hardest case: the record's only branding is the old booleans. The
  // editor opens on the projection; the person deletes both rows and saves.
  const e = await enquiryWith([{
    product: "Shirt", images: [img("front")], embroidery: true, printing: true, brandingPlacement: "Left chest",
  }]);
  const rows = asLoaded(await reload(e));
  rows[0].brandingRequirements = []; // deliberately cleared
  await patch(e, { products: rows });

  const after = (await reload(e)).products[0];
  expect(after.embroidery).toBe(false);
  expect(after.printing).toBe(false);
  expect(after.brandingPlacement).toBeUndefined();
  expect(brandingRequirementsOf(after)).toHaveLength(0);

  // Still gone after another ordinary save.
  const rows2 = untouched(await reload(e));
  rows2[0].quantity = 50;
  await patch(e, { products: rows2 });
  expect(brandingRequirementsOf((await reload(e)).products[0])).toHaveLength(0);
});

test("clearing one product's branding does not touch another's", async () => {
  const e = await enquiryWith([
    { product: "Polo", images: [img("front")], brandingRequirements: [READY_REQUIREMENT] },
    { product: "Cap", images: [img("cap")], brandingRequirements: [READY_REQUIREMENT] },
  ]);
  const loaded = await reload(e);
  const capRef = loaded.products[1].brandingRequirements[0].ref;

  const rows = asLoaded(loaded);
  rows[0].brandingRequirements = []; // cleared
  delete rows[1].brandingRequirements; // untouched
  await patch(e, { products: rows });

  const after = (await reload(e)).products;
  expect(after[0].brandingRequirements).toHaveLength(0);
  expect(after[0].embroidery).toBe(false);
  expect(after[1].brandingRequirements).toHaveLength(1);
  expect(after[1].brandingRequirements[0].ref).toBe(capRef);
  expect(after[1].embroidery).toBe(true);
});

test("an older client that never sends branding at all changes nothing about it", async () => {
  const e = await enquiryWith([{
    product: "Polo", images: [img("front")],
    brandingRequirements: [READY_REQUIREMENT], embroidery: true,
  }]);
  const loaded = await reload(e);
  const ref = loaded.products[0].brandingRequirements[0].ref;

  // A pre-branding build: the row it sends has no such field, and its own
  // stale booleans ride along.
  const rows = loaded.products.map(({ _id, brandingRequirements, ...row }) => ({ ...row, colour: "Navy" }));
  await patch(e, { products: rows });

  const after = (await reload(e)).products[0];
  expect(after.colour).toBe("Navy");
  expect(after.brandingRequirements).toHaveLength(1);
  expect(after.brandingRequirements[0].ref).toBe(ref);
});
