// test/crm/enquiry-product-identity.route.test.js
//
// G01 — AN ENQUIRY PRODUCT LINE KEEPS ITS PERMANENT REFERENCE THROUGH EDITS.
//
// `Enquiry.products[].productLineRef` is the pre-order line's identity: a
// Development File is rooted on it (immutably), and the proforma stamps it onto
// the confirmed order. `PATCH /api/cms/crm/enquiries/:id` used to rebuild every
// row through `sanitizeProducts`, which dropped the reference, so the model
// hook minted a NEW one for every row on every save. Editing one row's quantity
// orphaned every Development File on the enquiry.
//
// The route now keeps each row's reference by the reference alone — never by
// product name or array position — refuses forged, foreign and duplicate
// references, and refuses (rather than guesses) a save it cannot decide:
// removal is declared, never inferred from a row going missing.
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
/* The enquiries router pulls in push notifications and the CoWork sheet
   services. Same stubs the costing route tests use. */
jest.mock("../../config/firebaseAdmin", () => ({ messaging: () => ({ send: async () => ({}) }) }));
jest.mock("../../services/NotificationService", () => ({
  notify: async () => ({}), notifyUser: async () => ({}), send: async () => ({}),
}));
jest.mock("../../services/departmentNotify.service", () => ({
  notifyEvent: async () => ({}), APP_URL: "http://localhost",
}));
jest.mock("../../services/cowork.service", () => ({}), { virtual: true });
jest.mock("../../services/coworkSheets.service", () => ({}), { virtual: true });
/* Only the audit WRITE is stubbed; the route also computes a field diff for the
   change summary, and that pure function is kept real. */
jest.mock("../../services/changeLog", () => ({
  ...jest.requireActual("../../services/changeLog"),
  recordChange: jest.fn().mockResolvedValue(undefined),
}));

const Account = require("../../models/CMS_Models/Sales/Account");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { DevelopmentFile } = require("../../models/CMS_Models/Merchandising/Development");
const { PRODUCT_LINE_REF_PATTERN } = require("../../models/CMS_Models/Sales/enquiryProductLineIdentity");

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
  await Promise.all([Enquiry.deleteMany({}), Account.deleteMany({}), DevelopmentFile.deleteMany({})]);
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
const refs = (doc) => doc.products.map((p) => p.productLineRef);

/** An enquiry whose rows hold server-issued references — including the case
 *  every name-keyed lookup gets wrong: two lines called "Polo". */
async function enquiryWith(products) {
  const n = ++seq;
  const account = await Account.create({ companyId: CO._id, companyName: `Buyer ${n}`, status: "active" });
  const e = await Enquiry.create({
    enquiryId: `ENQ-ID-${n}`, companyId: CO._id, accountId: account._id,
    journeyId: new mongoose.Types.ObjectId(), title: `Enquiry ${n}`, isActive: true, products,
  });
  return reload(e);
}

/** A Development File rooted on one line — the downstream record that must
 *  survive the edit. Its `productLineRef` is immutable by schema. */
const fileFor = (enquiry, ref) => DevelopmentFile.create({
  developmentNumber: `DEV-${++seq}`, companyId: CO._id, journeyId: enquiry.journeyId, productLineRef: ref,
});

/** Does this Development File still resolve to a line on the enquiry? */
async function lineOf(file) {
  const e = await Enquiry.findOne({ journeyId: file.journeyId }).lean();
  return e.products.find((p) => p.productLineRef === file.productLineRef) || null;
}

/** The rows as the client holds them after a load: every field, reference included. */
const asLoaded = (doc) => doc.products.map(({ _id, ...row }) => ({ ...row }));

const TWO_POLOS = [
  { product: "Polo", quantity: 500, colour: "Sand" },
  { product: "Polo", quantity: 400, colour: "Navy" },
];

/* ══ EDITS KEEP IDENTITY — AND THE DEVELOPMENT FILE STAYS LINKED ═══════════ */

test("a quantity and specification edit keeps every row's reference", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }, { product: "Tee", quantity: 200 }]);
  const held = refs(e);
  const file = await fileFor(e, held[0]);

  const rows = asLoaded(e);
  rows[0].quantity = 650;
  rows[0].description = "Pique, 220 gsm";
  const res = await patch(e, { products: rows });

  expect(res.status).toBe(200);
  const after = await reload(e);
  expect(refs(after)).toEqual(held);
  const line = await lineOf(file);
  expect(line).not.toBeNull();
  expect(line.quantity).toBe(650);
});

test("a rename keeps the reference, so the Development File follows the new name", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const [ref] = refs(e);
  const file = await fileFor(e, ref);

  const rows = asLoaded(e);
  rows[0].product = "Polo — housekeeping";
  expect((await patch(e, { products: rows })).status).toBe(200);

  const line = await lineOf(file);
  expect(line?.product).toBe("Polo — housekeeping");
  expect(line.productLineRef).toBe(ref);
});

test("a reorder moves each reference with its own row, not its position", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }, { product: "Tee", quantity: 200 }]);
  const [poloRef, teeRef] = refs(e);
  const poloFile = await fileFor(e, poloRef);
  const teeFile = await fileFor(e, teeRef);

  const rows = asLoaded(e).reverse();
  expect((await patch(e, { products: rows })).status).toBe(200);

  const after = await reload(e);
  expect(refs(after)).toEqual([teeRef, poloRef]);
  expect((await lineOf(poloFile)).product).toBe("Polo");
  expect((await lineOf(teeFile)).product).toBe("Tee");
});

test("two rows with the same name keep their own references through edit, rename and reorder", async () => {
  const e = await enquiryWith(TWO_POLOS);
  const [sandRef, navyRef] = refs(e);
  const sandFile = await fileFor(e, sandRef);
  const navyFile = await fileFor(e, navyRef);

  /* Reorder, rename one, change the other's quantity — in one save. Only the
     reference can tell these two "Polo" rows apart. */
  const rows = asLoaded(e).reverse();
  rows[0].quantity = 450;          // Navy
  rows[1].product = "Polo (sand)"; // Sand
  expect((await patch(e, { products: rows })).status).toBe(200);

  const sand = await lineOf(sandFile);
  const navy = await lineOf(navyFile);
  expect(sand.colour).toBe("Sand");
  expect(sand.product).toBe("Polo (sand)");
  expect(sand.quantity).toBe(500);
  expect(navy.colour).toBe("Navy");
  expect(navy.quantity).toBe(450);
});

/* ══ NEW ROWS, AND DECLARED REMOVAL ═══════════════════════════════════════ */

test("a genuinely new row gets a new reference; the others are untouched", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const [held] = refs(e);

  const res = await patch(e, { products: [...asLoaded(e), { product: "Polo", quantity: 100 }] });

  expect(res.status).toBe(200);
  const after = await reload(e);
  expect(after.products[0].productLineRef).toBe(held);
  expect(after.products[1].productLineRef).toMatch(PRODUCT_LINE_REF_PATTERN);
  expect(after.products[1].productLineRef).not.toBe(held);
});

test("a declared removal removes that line and leaves the others' identity intact", async () => {
  const e = await enquiryWith(TWO_POLOS);
  const [sandRef, navyRef] = refs(e);
  const navyFile = await fileFor(e, navyRef);

  const res = await patch(e, {
    products: asLoaded(e).filter((r) => r.productLineRef !== sandRef),
    removedProductLineRefs: [sandRef],
  });

  expect(res.status).toBe(200);
  expect(refs(await reload(e))).toEqual([navyRef]);
  expect((await lineOf(navyFile)).colour).toBe("Navy");
});

test("a removal and a new row in one save is allowed when the removal is declared", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }, { product: "Tee", quantity: 200 }]);
  const [poloRef, teeRef] = refs(e);

  const res = await patch(e, {
    products: [asLoaded(e)[1], { product: "Shirt", quantity: 80 }],
    removedProductLineRefs: [poloRef],
  });

  expect(res.status).toBe(200);
  const after = await reload(e);
  expect(after.products[0].productLineRef).toBe(teeRef);
  expect(after.products[1].productLineRef).not.toBe(poloRef);
});

/* ══ WHAT IS REFUSED — AND A REFUSAL CHANGES NOTHING ═══════════════════════ */

async function expectUnchanged(e) {
  const after = await reload(e);
  expect(after.products).toEqual(e.products);
}

test("an old client that sends no references is refused, not silently re-minted", async () => {
  const e = await enquiryWith(TWO_POLOS);
  const file = await fileFor(e, refs(e)[0]);

  /* Exactly what the pre-G01 client sent: every field except identity. */
  const stale = asLoaded(e).map(({ productLineRef, ...row }) => row);
  const res = await patch(e, { products: stale });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("PRODUCT_LINES_STALE");
  expect(res.body.message).toMatch(/reload/i);
  expect(res.body.missingLines.map((m) => m.productLineRef).sort()).toEqual([...refs(e)].sort());
  expect(res.body.unreferencedRows).toBe(2);
  await expectUnchanged(e);
  expect(await lineOf(file)).not.toBeNull();
});

test("a stale screen that never saw a newer line cannot delete it by omission", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const staleView = asLoaded(e);                        // loaded before the add
  const added = await patch(e, { products: [...asLoaded(e), { product: "Tee", quantity: 200 }] });
  expect(added.status).toBe(200);
  const now = await reload(e);

  staleView[0].quantity = 600;                          // edits only what it knows
  const res = await patch(now, { products: staleView });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("PRODUCT_LINES_STALE");
  expect(res.body.missingLines.map((m) => m.product)).toEqual(["Tee"]);
  await expectUnchanged(now);
});

test("a duplicate reference is refused", async () => {
  const e = await enquiryWith(TWO_POLOS);
  const rows = asLoaded(e);
  rows[1].productLineRef = rows[0].productLineRef;

  const res = await patch(e, { products: rows });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("PRODUCT_LINE_REF_DUPLICATE");
  await expectUnchanged(e);
});

test("a forged reference is refused", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const rows = [...asLoaded(e), { productLineRef: "PL-0123456789ab", product: "Tee", quantity: 1 }];

  const res = await patch(e, { products: rows });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("PRODUCT_LINE_REF_UNKNOWN");
  await expectUnchanged(e);
});

test("a reference from another enquiry is refused", async () => {
  const other = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const rows = [...asLoaded(e), { ...asLoaded(other)[0] }];

  const res = await patch(e, { products: rows });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("PRODUCT_LINE_REF_UNKNOWN");
  await expectUnchanged(e);
});

test("a malformed reference is refused", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const rows = asLoaded(e);
  rows[0].productLineRef = "LINE-1";

  const res = await patch(e, { products: rows });

  expect(res.status).toBe(400);
  expect(res.body.code).toBe("PRODUCT_LINE_REF_MALFORMED");
  await expectUnchanged(e);
});

test("a revived version cannot claim the removed line's reference", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }, { product: "Tee", quantity: 200 }]);
  const [poloRef] = refs(e);
  await patch(e, { products: [asLoaded(e)[1]], removedProductLineRefs: [poloRef] });
  const now = await reload(e);

  /* "Remove & Create New Version" re-adds the product from the removed row's
     snapshot. It is a new line; the old reference is gone for good. */
  const res = await patch(now, { products: [...asLoaded(now), { productLineRef: poloRef, product: "Polo", quantity: 500 }] });

  expect(res.status).toBe(409);
  expect(res.body.code).toBe("PRODUCT_LINE_REF_UNKNOWN");
  await expectUnchanged(now);
});

/* ══ BEFORE REFERENCES EXISTED ════════════════════════════════════════════ */

test("an enquiry stored before references existed gets them on its first save", async () => {
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  // As the live record is: products written with no reference at all.
  await Enquiry.collection.updateOne({ _id: e._id }, { $unset: { "products.0.productLineRef": "" } });
  const legacy = await reload(e);
  expect(legacy.products[0].productLineRef).toBeUndefined();

  const res = await patch(legacy, { products: asLoaded(legacy) });

  expect(res.status).toBe(200);
  expect((await reload(e)).products[0].productLineRef).toMatch(PRODUCT_LINE_REF_PATTERN);
});

/* ══ THE CONFIRMED-ORDER LINE IS NOT THIS SLICE'S ═════════════════════════ */

test("an enquiry edit writes nothing to any CustomerRequest", async () => {
  const CustomerRequest = require("../../models/Customer_Models/CustomerRequest");
  const e = await enquiryWith([{ product: "Polo", quantity: 500 }]);
  const spy = jest.spyOn(CustomerRequest, "updateOne");
  const spyMany = jest.spyOn(CustomerRequest, "updateMany");
  try {
    const rows = asLoaded(e);
    rows[0].quantity = 700;
    expect((await patch(e, { products: rows })).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
    expect(spyMany).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
    spyMany.mockRestore();
  }
});
