// test/merchandising/material-catalogue.route.test.js
//
// THE DEVELOPMENT BOM NOW POINTS AT STORE'S CATALOGUE, AND THE POINTER IS
// CHECKED.
//
// Six claims:
//
//   1  THE KEYHOLE IS THIS COMPANY'S ONLY. Another company's items are not
//      listed and cannot be selected — and a foreign id answers exactly as an
//      invented one does, so the endpoint cannot be used to ask what somebody
//      else stocks.
//
//   2  IT ANSWERS WITH IDENTITY AND NOTHING ELSE. No balance, no minimum, no
//      vendor, no price, no discount, no budget head, no stock ledger. The
//      assertion is on the JSON text, so a field added to RawItem tomorrow
//      cannot arrive quietly.
//
//   3  IT IS MERCHANDISING'S GRANT, NOT STORE'S. Selecting materials opens it;
//      reading a file does not; and no Store capability is required or
//      consulted.
//
//   4  THE SERVER WRITES THE IDENTITY. A client may send any name it likes —
//      what is stored is what the catalogue says, read in the same
//      transaction.
//
//   5  THE CATALOGUE IS NOT COMPULSORY. A material Store has never registered
//      is still selectable, in the merchandiser's own words, and the row says
//      so by carrying no catalogue id.
//
//   6  ONE MATERIAL, ONE PLACE. The same item and variant twice for the same
//      placement is refused and names the row it collided with; the same item
//      at a different placement is ordinary and allowed.
//
// And the lifecycle this is bolted onto is unchanged: an empty draft still
// cannot be submitted, and nobody approves their own selection.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

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
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const {
  DevelopmentFile, DevelopmentBomRevision, BOM_STATE,
} = require("../../models/CMS_Models/Merchandising/Development");

let server, base, salesBase, rs, seq = 0;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "material_catalogue" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/merchandising", require("../../routes/CMS_Routes/Merchandising/developmentRoute"));
  app.use("/api/cms/sales/development-requests", require("../../routes/CMS_Routes/Sales/developmentRequests"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/merchandising`;
  salesBase = `http://127.0.0.1:${server.address().port}/api/cms/sales/development-requests`;
  await RawItem.syncIndexes();
  await DevelopmentFile.syncIndexes();
  await DevelopmentBomRevision.syncIndexes();
}, 120000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const req = (root) => (p, { token, company, method = "GET", body, key } = {}) =>
  fetch(`${root}${p}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => {
    const text = await r.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { status: r.status, body: parsed, text };
  });

const call = (p, o) => req(base)(p, o);
const sales = (p, o) => req(salesBase)(p, o);
const uniq = () => `k-${++seq}-${Date.now()}`;
const assert_deep = (actual, expected) => expect(actual).toEqual(expected);

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `cat-${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "C", lastName: `At${n}`, email, biometricId: `CT${n}`,
    isActive: true, gender: "Other", department: "Merchandising",
  });
  await DeptUser.create({
    name: `User ${n}`, email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "C" });
  }
  for (const [departmentSlug, r] of Object.entries(grants)) {
    await DepartmentRole.create({
      departmentSlug, email, name: `User ${n}`, role: r, isActive: true,
      departmentId: new mongoose.Types.ObjectId(),
    });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `User ${n}`, role: "merchandiser", employeeId: emp.biometricId, isAdmin },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "15m" },
    ),
  };
}

/**
 * A raw item as STORE holds one — with everything Merchandising must never
 * see written into it, so "not returned" is proved against a record that
 * really carries the fact.
 */
async function stock(co, over = {}) {
  const n = ++seq;
  return RawItem.create({
    companyId: co._id,
    name: over.name || `Recycled polyester mesh ${n}`,
    sku: over.sku || `FAB-MESH-${n}`,
    category: over.category || "Fabric",
    customCategory: over.customCategory || "",
    unit: over.unit || "Metre",
    attributes: over.attributes || [{ name: "GSM", values: ["135"] }, { name: "Color", values: ["Slate", "Black"] }],
    variants: over.variants || [
      { combination: ["Slate", "135"], sku: `FAB-MESH-${n}-SL`, quantity: 420, minStock: 100 },
      { combination: ["Black", "135"], sku: `FAB-MESH-${n}-BK`, quantity: 0, minStock: 100 },
    ],
    /* Everything below is Store's and must never cross. */
    quantity: 420,
    minStock: 100,
    maxStock: 2000,
    primaryVendor: new mongoose.Types.ObjectId(),
    alternateVendors: [new mongoose.Types.ObjectId()],
    discounts: [{ minQuantity: 500, price: 182.5 }],
    budgetLedgerName: "Fabric purchases",
    stockTransactions: [{
      type: "ADD", quantity: 420, previousQuantity: 0, newQuantity: 420,
      unitPrice: 194.75, supplier: "Meridian Mills", invoiceNumber: "INV-88",
    }],
    ...(over.raw || {}),
  });
}

async function world() {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Cat ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-C-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-C-${n}`, journeyId: journey._id, accountId: account._id,
    companyId: co._id, title: `Enquiry ${n}`, isActive: true,
    products: [{ product: `Tee ${n}`, quantity: 500 }],
  });
  const saved = await Enquiry.findById(enquiry._id).lean();
  return { co, journey, enquiry, productLineRef: String(saved.products[0].productLineRef) };
}

const at = (w, who) => ({ token: who.token, company: w.co._id });

async function cast(co) {
  return {
    viewer: await actor({ companies: [co], grants: { merchandiser: "viewer" } }),
    editor: await actor({ companies: [co], grants: { merchandiser: "editor" } }),
    approver: await actor({ companies: [co], grants: { merchandiser: "approver" } }),
    /* Sales asks; Merchandising selects. The request has to come from Sales
       or there is no Development File to select into. */
    sales: await actor({ companies: [co], grants: { sales: "approver" } }),
  };
}

/** A file with an open draft, ready to take rows. */
async function draftOn(w, c) {
  const asked = await sales(`/journeys/${w.journey._id}/lines/${w.productLineRef}`, {
    ...at(w, c.sales), method: "POST",
    body: {
      requirementSummary: "Lightweight running tee — mesh body, reflective trim, transfer labels.",
      requestedCategories: ["FABRIC", "TRIMS", "LABELS"],
      requiredByDate: "2026-10-15",
    },
  });
  if (asked.status >= 400) throw new Error(`Sales could not ask: ${asked.text}`);
  const file = await DevelopmentFile.findOne({
    companyId: w.co._id, journeyId: w.journey._id, productLineRef: w.productLineRef,
  }).lean();
  await call(`/development/${file._id}/accept`, { ...at(w, c.approver), method: "POST", key: uniq() });
  await call(`/development/${file._id}/bom`, { ...at(w, c.editor), method: "POST", key: uniq(), body: {} });
  return file;
}

const draftOf = (w, file) => DevelopmentBomRevision.findOne({
  companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.DRAFT,
}).lean();

const addRow = (w, c, file, body, revision) => call(`/development/${file._id}/bom/rows`, {
  ...at(w, c.editor), method: "POST", body: { expectedRevision: revision, ...body },
});

/* ══ 1 — THE KEYHOLE IS THIS COMPANY'S ONLY ═══════════════════════════════ */

describe("the catalogue is this company's, and says nothing about anyone else's", () => {
  test("another company's items are not listed", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const ours = await stock(mine.co, { name: "Aaa our mesh" });
    await stock(theirs.co, { name: "Aaa their mesh" });

    const res = await call("/catalogue/materials", at(mine, c.editor));
    expect(res.status).toBe(200);
    expect(res.body.rows.map((r) => r.rawItemId)).toEqual([String(ours._id)]);
    expect(res.text).not.toContain("their mesh");
  });

  /* Legacy-global items — the ones that predate company ownership — belong to
     nobody. A development row pointing at one would hold a reference this
     company cannot prove it owns, so they are excluded rather than adopted. */
  test("an item owned by nobody is not this company's either", async () => {
    const w = await world();
    const c = await cast(w.co);
    await RawItem.create({ name: "Unowned twill", sku: `ORPHAN-${++seq}`, category: "Fabric" });

    const res = await call("/catalogue/materials", at(w, c.editor));
    expect(res.body.rows).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test("a foreign id and an invented id give the same answer", async () => {
    const mine = await world();
    const theirs = await world();
    const c = await cast(mine.co);
    const file = await draftOn(mine, c);
    const foreign = await stock(theirs.co);
    const invented = new mongoose.Types.ObjectId();
    const draft = await draftOf(mine, file);

    const a = await addRow(mine, c, file, { category: "FABRIC", rawItemId: String(foreign._id) }, draft.revision);
    const b = await addRow(mine, c, file, { category: "FABRIC", rawItemId: String(invented) }, draft.revision);

    expect(a.status).toBe(404);
    expect(a.body.error.code).toBe("DEVELOPMENT_CATALOGUE_ITEM_NOT_FOUND");
    /* Identical, to the word: the refusal reveals nothing about which it was. */
    expect(b.status).toBe(a.status);
    expect(b.body.error.code).toBe(a.body.error.code);
    expect(b.body.message).toBe(a.body.message);
    /* And neither leaked the foreign item's name. */
    expect(a.text).not.toContain(foreign.name);
  });
});

/* ══ 2 — IDENTITY AND NOTHING ELSE ════════════════════════════════════════ */

describe("Store's sensitive facts do not come through the keyhole", () => {
  test("no balance, minimum, vendor, price, discount or ledger is returned", async () => {
    const w = await world();
    const c = await cast(w.co);
    const item = await stock(w.co);

    const res = await call("/catalogue/materials", at(w, c.editor));
    const row = res.body.rows[0];

    /* The identity IS there. */
    expect(row.name).toBe(item.name);
    expect(row.sku).toBe(item.sku);
    expect(row.unit).toBe("Metre");
    expect(row.variantCount).toBe(2);
    expect(row.variants[0].combination).toEqual(["Slate", "135"]);

    for (const banned of [
      "quantity", "minStock", "maxStock", "status", "primaryVendor", "alternateVendors",
      "vendorNicknames", "discounts", "stockTransactions", "budgetLedgerId",
      "budgetLedgerName", "unitPrice", "price", "supplier",
    ]) {
      expect(JSON.stringify(row)).not.toContain(`"${banned}"`);
    }
    /* Not merely absent from the keys — the VALUES are not in the payload. */
    expect(res.text).not.toContain("Meridian Mills");
    expect(res.text).not.toContain("194.75");
    expect(res.text).not.toContain("Fabric purchases");
  });

  /* ── THE FIELD THAT LOOKS SAFE AND IS NOT ──────────────────────────────
     `attributes` is free text, in its names as well as its values, and a
     real item master is where people put the fact they have nowhere else to
     put. A catalogue shaped by field name alone published a supplier's name
     through a field called `attributes`. These pin the screen. */
  test("an attribute named after a supplier, a price or a stock level is not returned", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Mesh with a talkative item master",
      attributes: [
        { name: "GSM", values: ["135"] },
        { name: "Colour", values: ["Slate"] },
        /* Every one of these is a real shape seen in item masters. */
        { name: "Vendor", values: ["Meridian Mills"] },
        { name: "Preferred supplier", values: ["Harbour Textiles"] },
        { name: "Landed cost", values: ["194.75"] },
        { name: "Purchase rate", values: ["182.50"] },
        { name: "MRP", values: ["420"] },
        { name: "MOQ", values: ["500"] },
        { name: "Lead time", values: ["21 days"] },
        { name: "Current stock", values: ["420"] },
        { name: "Reorder quantity", values: ["1000"] },
        { name: "Discount slab", values: ["5% over 500m"] },
        { name: "HSN", values: ["54077200"] },
        { name: "Budget head", values: ["Fabric purchases"] },
        { name: "Payment terms", values: ["45 days"] },
      ],
      variants: [{ combination: ["135", "Slate"], sku: "MESH-TALK-SL" }],
    });

    const res = await call("/catalogue/materials", at(w, c.editor));
    const row = res.body.rows[0];

    /* What a merchandiser legitimately needs is still there. */
    assert_deep(row.attributes.map((a) => a.name), ["GSM", "Colour"]);

    /* And not one of the others survives — neither its name nor its value. */
    for (const gone of [
      "Vendor", "Preferred supplier", "Landed cost", "Purchase rate", "MRP", "MOQ",
      "Lead time", "Current stock", "Reorder quantity", "Discount slab", "HSN",
      "Budget head", "Payment terms",
      "Meridian Mills", "Harbour Textiles", "194.75", "182.50", "420", "500",
      "21 days", "5% over 500m", "54077200", "Fabric purchases", "45 days",
    ]) {
      expect(res.text).not.toContain(gone);
    }
  });

  /* A variant's combination is one value per declared attribute, in attribute
     order — so an item whose attributes include a vendor has variants that
     read ["Slate", "Meridian Mills"], and a screen showing the combination
     prints the supplier as though it were a colourway. */
  test("a variant combination does not carry the value of a screened attribute", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Two-attribute mesh",
      attributes: [
        { name: "Colour", values: ["Slate", "Black"] },
        { name: "Vendor", values: ["Meridian Mills", "Harbour Textiles"] },
      ],
      variants: [
        { combination: ["Slate", "Meridian Mills"], sku: "TAM-SL-MM" },
        { combination: ["Black", "Harbour Textiles"], sku: "TAM-BK-HT" },
      ],
    });

    const res = await call("/catalogue/materials", at(w, c.editor));
    const row = res.body.rows[0];
    assert_deep(row.variants.map((v) => v.combination), [["Slate"], ["Black"]]);
    expect(res.text).not.toContain("Meridian Mills");
    expect(res.text).not.toContain("Harbour Textiles");
  });

  /* Once an item declares a screened attribute, its combinations are trusted
     only where each value's own attribute can be named — and legacy records
     do carry combinations longer than their attribute list. */
  test("on a screened item, a combination longer than its attributes loses the unnameable tail", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Legacy mesh",
      attributes: [
        { name: "Colour", values: ["Slate"] },
        { name: "Vendor", values: ["Meridian Mills"] },
      ],
      variants: [{ combination: ["Slate", "Meridian Mills", "194.75"], sku: "LEG-SL" }],
    });

    const res = await call("/catalogue/materials", at(w, c.editor));
    assert_deep(res.body.rows[0].variants[0].combination, ["Slate"]);
    expect(res.text).not.toContain("Meridian Mills");
    expect(res.text).not.toContain("194.75");
  });

  /* And the rule is written that way round on purpose. An item that declares
     nothing screened has nothing to leak through its combinations, so it
     keeps them whole — screening a supplier must cost the reader the
     supplier, not every colourway on every legacy record beside it. */
  test("an item that screens nothing keeps its combination whole", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Plain legacy tape",
      attributes: [{ name: "Width", values: ["12mm"] }],
      /* More values than declared attributes, and none of them screened. */
      variants: [{ combination: ["Silver-grey", "Glass-bead"], sku: "LEG-TAPE" }],
    });

    const res = await call("/catalogue/materials", at(w, c.editor));
    assert_deep(res.body.rows[0].variants[0].combination, ["Silver-grey", "Glass-bead"]);
    /* And it stays findable by those values. */
    const found = await call("/catalogue/materials?q=silver-grey", at(w, c.editor));
    expect(found.body.rows.map((r) => r.name)).toEqual(["Plain legacy tape"]);
  });

  /* The value never appears in the answer — but a HIT is itself a
     disclosure. Typing a supplier's name and being told which four fabrics
     it matched is the same fact, delivered by a different route. */
  test("searching a screened attribute's value finds nothing", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Discreet mesh", sku: "FAB-DISCREET",
      attributes: [
        { name: "Colour", values: ["Slate"] },
        { name: "Vendor", values: ["Meridian Mills"] },
      ],
      variants: [{ combination: ["Slate"], sku: "FAB-DISCREET-SL" }],
    });

    const bySupplier = await call("/catalogue/materials?q=Meridian", at(w, c.editor));
    expect(bySupplier.body.rows).toHaveLength(0);
    expect(bySupplier.body.total).toBe(0);

    /* And the safe attribute is still searchable, so the screen has not
       simply been made useless. */
    const byColour = await call("/catalogue/materials?q=Slate", at(w, c.editor));
    expect(byColour.body.rows.map((r) => r.sku)).toEqual(["FAB-DISCREET"]);
  });

  /* ── AND THE CONSEQUENCE OF SCREENING IS STATED, NOT HIDDEN ───────────
     A real item master files its SUPPLIERS as variants. Screened, those rows
     arrive identical and unnamed, and a screen that then demanded a choice
     between them would be demanding a guess. The item says so instead. */
  test("an item whose variants differ only by supplier reports that they cannot be told apart", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Machine oil",
      attributes: [{ name: "VENDOR", values: ["Fancy Corner", "Harbour Supplies"] }],
      variants: [
        { combination: ["Fancy Corner"], sku: "" },
        { combination: ["Harbour Supplies"], sku: "" },
      ],
    });

    const res = await call("/catalogue/materials", at(w, c.editor));
    const row = res.body.rows[0];
    expect(row.variantChoice).toBe("indistinguishable");
    expect(row.variants.every((v) => v.combination.length === 0)).toBe(true);
    expect(res.text).not.toContain("Fancy Corner");
  });

  test("an item with real colourways still asks for one to be chosen", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, {
      name: "Mesh",
      attributes: [{ name: "Colour", values: ["Slate", "Black"] }],
      variants: [
        { combination: ["Slate"], sku: "M-SL" },
        { combination: ["Black"], sku: "M-BK" },
      ],
    });
    const res = await call("/catalogue/materials", at(w, c.editor));
    expect(res.body.rows[0].variantChoice).toBe("required");
  });

  test("and such an item can be selected at item level, with no variant", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co, {
      name: "Machine oil",
      attributes: [{ name: "VENDOR", values: ["Fancy Corner", "Harbour Supplies"] }],
      variants: [{ combination: ["Fancy Corner"], sku: "" }, { combination: ["Harbour Supplies"], sku: "" }],
    });
    const draft = await draftOf(w, file);

    const res = await addRow(w, c, file, {
      category: "ACCESSORY", rawItemId: String(item._id), placement: "Machine maintenance",
    }, draft.revision);
    expect(res.status).toBe(201);

    const after = await draftOf(w, file);
    expect(after.rows[0].variantId).toBeNull();
    expect(after.rows[0].rawItemName).toBe("Machine oil");
    expect(after.rows[0].variantCombination).toEqual([]);
  });

  test("a variant carries which one it is, not how much of it there is", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co);
    const res = await call("/catalogue/materials", at(w, c.editor));
    for (const v of res.body.rows[0].variants) {
      expect(Object.keys(v).sort()).toEqual(["combination", "sku", "variantId"]);
    }
  });
});

/* ══ 3 — MERCHANDISING'S GRANT, NOT STORE'S ═══════════════════════════════ */

describe("who may open it", () => {
  test("selecting materials opens it; reading a file does not", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co);

    expect((await call("/catalogue/materials", at(w, c.editor))).status).toBe(200);

    const viewer = await call("/catalogue/materials", at(w, c.viewer));
    expect(viewer.status).toBe(403);
    /* A viewer can still read the file it is attached to. */
    expect((await call("/development", at(w, c.viewer))).status).toBe(200);
  });

  test("no Store grant is needed, and none is consulted", async () => {
    const w = await world();
    /* An editor in Merchandising with no Store role whatsoever. */
    const merchOnly = await actor({ companies: [w.co], grants: { merchandiser: "editor" } });
    await stock(w.co);
    expect((await call("/catalogue/materials", at(w, merchOnly))).status).toBe(200);

    /* And a Store grant alone does not open Merchandising's door. */
    const storeOnly = await actor({ companies: [w.co], grants: { store: "owner" } });
    expect((await call("/catalogue/materials", at(w, storeOnly))).status).toBe(403);
  });

  /* The catalogue is answered for ONE company, and which one is never
     guessed. A person who works in two must say; naming one they do not
     belong to is answered the same way as naming one that does not exist. */
  test("a caller in two companies must say which, and cannot name a third", async () => {
    const mine = await world();
    const other = await world();
    const stranger = await world();
    const both = await actor({
      companies: [mine.co, other.co], grants: { merchandiser: "editor" },
    });
    await stock(mine.co, { name: "Our mesh" });
    await stock(other.co, { name: "Their mesh" });

    const unstated = await call("/catalogue/materials", { token: both.token });
    expect(unstated.status).toBeGreaterThanOrEqual(400);
    expect(unstated.body.error.code).toBe("COMPANY_SELECTION_REQUIRED");

    const foreign = await call("/catalogue/materials", {
      token: both.token, company: stranger.co._id,
    });
    expect(foreign.status).toBeGreaterThanOrEqual(400);
    expect(foreign.body.error.code).toBe("TENANT_MEMBERSHIP_UNPROVEN");

    /* And a stated company answers with that company's shelves only. */
    const stated = await call("/catalogue/materials", { token: both.token, company: mine.co._id });
    expect(stated.body.rows.map((r) => r.name)).toEqual(["Our mesh"]);
  });
});

/* ══ 4 — SEARCH, FILTER, PAGE ═════════════════════════════════════════════ */

describe("finding one item among many", () => {
  test("search matches name, code, category and variant attributes", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, { name: "Recycled polyester mesh", sku: "FAB-MESH-135", category: "Fabric" });
    await stock(w.co, {
      name: "Reflective tape 12mm", sku: "TRM-REF-12", category: "Trims",
      attributes: [{ name: "Width", values: ["12mm"] }],
      variants: [{ combination: ["Silver-grey"], sku: "TRM-REF-12-SG" }],
    });

    const byName = await call("/catalogue/materials?q=reflective", at(w, c.editor));
    expect(byName.body.rows.map((r) => r.sku)).toEqual(["TRM-REF-12"]);

    const bySku = await call("/catalogue/materials?q=FAB-MESH", at(w, c.editor));
    expect(bySku.body.rows.map((r) => r.name)).toEqual(["Recycled polyester mesh"]);

    const byAttribute = await call("/catalogue/materials?q=silver-grey", at(w, c.editor));
    expect(byAttribute.body.rows.map((r) => r.sku)).toEqual(["TRM-REF-12"]);
  });

  test("a category filter reads Store's shelves, and suggests without deciding", async () => {
    const w = await world();
    const c = await cast(w.co);
    await stock(w.co, { name: "Mesh", category: "Fabric" });
    await stock(w.co, { name: "Zip", category: "Zippers" });
    await stock(w.co, { name: "Woven label", category: "Labels" });
    /* Files under a word Merchandising's vocabulary has no shelf for. */
    await stock(w.co, { name: "Enzyme wash", category: "Chemicals" });

    const trims = await call("/catalogue/materials?category=TRIM", at(w, c.editor));
    expect(trims.body.rows.map((r) => r.name)).toEqual(["Zip"]);
    expect(trims.body.rows[0].suggestedCategory).toBe("TRIM");

    const labels = await call("/catalogue/materials?category=LABEL", at(w, c.editor));
    expect(labels.body.rows.map((r) => r.name)).toEqual(["Woven label"]);

    /* The chemical is reachable — it is simply under no development
       category, and says so rather than being filed under a wrong one. */
    const all = await call("/catalogue/materials", at(w, c.editor));
    const wash = all.body.rows.find((r) => r.name === "Enzyme wash");
    expect(wash.suggestedCategory).toBeNull();
  });

  test("a category that is not a development category is refused by name", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/catalogue/materials?category=CHEMICALS", at(w, c.editor));
    expect(res.status).toBe(400);
    expect(res.body.error.details.allowed).toContain("FABRIC");
  });

  test("paging returns every row once, and the search narrows the count", async () => {
    const w = await world();
    const c = await cast(w.co);
    for (let i = 0; i < 7; i += 1) {
      await stock(w.co, { name: `Item ${String(i).padStart(2, "0")}`, sku: `PAGE-${i}` });
    }

    const seen = [];
    let cursor = "";
    let guard = 0;
    do {
      const page = await call(
        `/catalogue/materials?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        at(w, c.editor),
      );
      expect(page.status).toBe(200);
      seen.push(...page.body.rows.map((r) => r.rawItemId));
      cursor = page.body.nextCursor || "";
      guard += 1;
    } while (cursor && guard < 10);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);

    const first = await call("/catalogue/materials?limit=3", at(w, c.editor));
    expect(first.body.total).toBe(7);
    expect(first.body.hasMore).toBe(true);

    const narrowed = await call("/catalogue/materials?q=Item 03", at(w, c.editor));
    expect(narrowed.body.total).toBe(1);
    /* And the picker can tell "nothing matched" from "nothing registered". */
    expect(narrowed.body.catalogueSize).toBe(7);
  });

  test("a page marker this list did not issue is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const res = await call("/catalogue/materials?cursor=nonsense", at(w, c.editor));
    expect(res.status).toBe(400);
  });
});

/* ══ 5 — THE SERVER WRITES THE IDENTITY ═══════════════════════════════════ */

describe("what the catalogue says is what gets stored", () => {
  test("the item's own name and the variant's code overwrite whatever was sent", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co, { name: "Recycled polyester mesh 135gsm", sku: "FAB-MESH-135" });
    const variant = item.variants[0];
    const draft = await draftOf(w, file);

    const res = await addRow(w, c, file, {
      category: "FABRIC",
      rawItemId: String(item._id),
      variantId: String(variant._id),
      /* A client insisting on its own words. */
      rawItemName: "WHATEVER THE BROWSER FELT LIKE",
      rawItemSku: "NOT-A-REAL-CODE",
      variantCombination: ["Invented"],
      placement: "Body and sleeves",
    }, draft.revision);
    expect(res.status).toBe(201);

    const after = await draftOf(w, file);
    const row = after.rows.find((r) => r.rowRef === res.body.rowRef);
    expect(row.rawItemName).toBe("Recycled polyester mesh 135gsm");
    expect(row.rawItemSku).toBe(variant.sku);
    expect(row.variantCombination).toEqual(["Slate", "135"]);
    expect(String(row.rawItemId)).toBe(String(item._id));
    expect(String(row.variantId)).toBe(String(variant._id));
  });

  test("a variant belonging to another item is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const mesh = await stock(w.co, { name: "Mesh" });
    const tape = await stock(w.co, { name: "Tape" });
    const draft = await draftOf(w, file);

    const res = await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(mesh._id), variantId: String(tape.variants[0]._id),
    }, draft.revision);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("DEVELOPMENT_CATALOGUE_VARIANT_NOT_FOUND");

    const after = await draftOf(w, file);
    expect(after.rows).toHaveLength(0);
  });

  test("editing a row re-reads the catalogue rather than trusting the form", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co, { name: "Original name" });
    let draft = await draftOf(w, file);

    const added = await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id), placement: "Body",
    }, draft.revision);

    /* Store renames the item between the add and the edit. */
    await RawItem.updateOne({ _id: item._id }, { $set: { name: "Renamed by Store" } });

    draft = await draftOf(w, file);
    const edited = await call(`/development/${file._id}/bom/rows/${added.body.rowRef}`, {
      ...at(w, c.editor), method: "PATCH",
      body: {
        category: "FABRIC", rawItemId: String(item._id),
        rawItemName: "Original name", placement: "Body and sleeves",
        expectedRevision: draft.revision,
      },
    });
    expect(edited.status).toBe(200);

    const after = await draftOf(w, file);
    expect(after.rows[0].rawItemName).toBe("Renamed by Store");
  });
});

/* ══ 6 — THE CATALOGUE IS NOT COMPULSORY ══════════════════════════════════ */

describe("a material Store has never registered", () => {
  test("is selectable in the merchandiser's own words, and carries no id", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const draft = await draftOf(w, file);

    const res = await addRow(w, c, file, {
      category: "TRIM",
      rawItemName: "Reflective tape, buyer's nominated supplier",
      rawItemSku: "buyer ref RT-12",
      selectionNote: "Not in our catalogue yet — Store to register it if the sample is approved.",
      placement: "Back yoke",
    }, draft.revision);
    expect(res.status).toBe(201);

    const after = await draftOf(w, file);
    const row = after.rows[0];
    expect(row.rawItemId).toBeNull();
    expect(row.variantId).toBeNull();
    expect(row.rawItemName).toBe("Reflective tape, buyer's nominated supplier");
  });

  test("a row that names neither an item nor a material is refused", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const draft = await draftOf(w, file);

    const res = await addRow(w, c, file, { category: "TRIM", placement: "Back yoke" }, draft.revision);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.error.details.field).toBe("rawItemId");
  });

  test("selecting from the catalogue does not create or change a Store item", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co);
    const before = await RawItem.findById(item._id).lean();
    const draft = await draftOf(w, file);

    await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id), colourOrShade: "Slate",
    }, draft.revision);

    const after = await RawItem.findById(item._id).lean();
    expect(after.quantity).toBe(before.quantity);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(await RawItem.countDocuments({ companyId: w.co._id })).toBe(1);
  });
});

/* ══ 7 — ONE MATERIAL, ONE PLACE ══════════════════════════════════════════ */

describe("the same material twice", () => {
  test("is refused for the same placement, and names the row it collided with", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co, { name: "Reflective tape 12mm" });
    let draft = await draftOf(w, file);

    const first = await addRow(w, c, file, {
      category: "TRIM", rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      placement: "Back yoke",
    }, draft.revision);
    expect(first.status).toBe(201);

    draft = await draftOf(w, file);
    const again = await addRow(w, c, file, {
      category: "TRIM", rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      placement: "Back yoke",
    }, draft.revision);

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe("DEVELOPMENT_ROW_DUPLICATE");
    expect(again.body.message).toMatch(/Reflective tape 12mm/);
    expect(again.body.message).toMatch(/Back yoke/);
    expect(again.body.error.details.rowRef).toBe(first.body.rowRef);
  });

  test("is allowed at a different placement, because that is a second use of it", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co, { name: "Reflective tape 12mm" });
    let draft = await draftOf(w, file);

    await addRow(w, c, file, {
      category: "TRIM", rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      placement: "Back yoke",
    }, draft.revision);

    draft = await draftOf(w, file);
    const cuffs = await addRow(w, c, file, {
      category: "TRIM", rawItemId: String(item._id), variantId: String(item.variants[0]._id),
      placement: "Cuff tipping",
    }, draft.revision);
    expect(cuffs.status).toBe(201);

    const after = await draftOf(w, file);
    expect(after.rows).toHaveLength(2);
    expect(after.rows.map((r) => r.placement)).toEqual(["Back yoke", "Cuff tipping"]);
  });

  test("a different variant of the same item is a different material", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co);
    let draft = await draftOf(w, file);

    await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id),
      variantId: String(item.variants[0]._id), placement: "Body",
    }, draft.revision);

    draft = await draftOf(w, file);
    const other = await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id),
      variantId: String(item.variants[1]._id), placement: "Body",
    }, draft.revision);
    expect(other.status).toBe(201);
  });

  test("an unregistered material is never compared, because it has no identity to compare", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    let draft = await draftOf(w, file);

    await addRow(w, c, file, { category: "TRIM", rawItemName: "Hand-dyed cord", placement: "Hood" }, draft.revision);
    draft = await draftOf(w, file);
    const twice = await addRow(w, c, file, {
      category: "TRIM", rawItemName: "Hand-dyed cord", placement: "Hood",
    }, draft.revision);
    /* Two typed rows may genuinely be two different cords. Nothing here can
       prove otherwise, so nothing here refuses. */
    expect(twice.status).toBe(201);
  });

  test("editing a row does not collide with itself", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co);
    let draft = await draftOf(w, file);

    const added = await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id), placement: "Body",
    }, draft.revision);

    draft = await draftOf(w, file);
    const edited = await call(`/development/${file._id}/bom/rows/${added.body.rowRef}`, {
      ...at(w, c.editor), method: "PATCH",
      body: {
        category: "FABRIC", rawItemId: String(item._id), placement: "Body",
        colourOrShade: "Slate", expectedRevision: draft.revision,
      },
    });
    expect(edited.status).toBe(200);
  });
});

/* ══ 8 — THE LIFECYCLE IS UNCHANGED ═══════════════════════════════════════ */

describe("nothing about the draft, approval or maker-checker lifecycle moved", () => {
  test("an empty draft cannot be submitted", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const draft = await draftOf(w, file);

    const res = await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: draft.revision },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("DEVELOPMENT_BOM_EMPTY");
  });

  test("a catalogue row goes through submit and approval, and not by its author", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co);
    let draft = await draftOf(w, file);

    await addRow(w, c, file, {
      category: "FABRIC", rawItemId: String(item._id),
      variantId: String(item.variants[0]._id), placement: "Body",
    }, draft.revision);

    draft = await draftOf(w, file);
    const submitted = await call(`/development/${file._id}/bom/submit`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: draft.revision },
    });
    expect(submitted.status).toBe(200);

    draft = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.SUBMITTED,
    }).lean();

    /* The author cannot approve their own selection — unchanged. */
    const selfApproval = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.editor), method: "POST", key: uniq(),
      body: { expectedRevision: draft.revision },
    });
    expect(selfApproval.status).toBeGreaterThanOrEqual(400);

    const approved = await call(`/development/${file._id}/bom/approve`, {
      ...at(w, c.approver), method: "POST", key: uniq(),
      body: { expectedRevision: draft.revision },
    });
    expect(approved.status).toBe(200);

    /* And the approved revision still holds the catalogue reference. */
    const frozen = await DevelopmentBomRevision.findOne({
      companyId: w.co._id, developmentFileId: file._id, state: BOM_STATE.APPROVED,
    }).lean();
    expect(String(frozen.rows[0].rawItemId)).toBe(String(item._id));
  });

  test("consumption, rate, supplier and stock are still refused by name", async () => {
    const w = await world();
    const c = await cast(w.co);
    const file = await draftOn(w, c);
    const item = await stock(w.co);
    const draft = await draftOf(w, file);

    for (const [field, owner] of [
      ["quantity", /R&D/], ["rate", /Costing/], ["supplier", /Supply Chain/], ["stock", /Store/],
    ]) {
      const res = await addRow(w, c, file, {
        category: "FABRIC", rawItemId: String(item._id), [field]: 1,
      }, draft.revision);
      expect(res.body.error.code).toBe("DEVELOPMENT_FIELD_NOT_ALLOWED");
      expect(res.body.message).toMatch(owner);
    }
  });
});
