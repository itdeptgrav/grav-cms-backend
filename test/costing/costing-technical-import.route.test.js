// test/costing/costing-technical-import.route.test.js
//
// Central Costing — Chunk 4A. IMPORTING WHAT THE TECHNICAL RECORD ALREADY SAYS.
//
// The materials and operations of a garment are recorded twice today: once by
// Merchandising and R&D on the SampleStyle, and again by whoever types them
// into a costing. This proves the import that removes the second typing — and,
// more importantly, what it refuses to do.
//
// The claims that matter are the refusals. A sample's measured consumption is
// not a per-garment quantity until something establishes that it is, and this
// never divides by an assumed sample size. An allowance already inside a
// measured quantity is not applied again. An operation that priced to zero
// because no salary could be resolved is missing, not free. Two sibling
// variant styles are a choice, not an ordering. And a style renamed tomorrow
// does not change what a version froze today.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const IeStyleFile = require("../../models/CMS_Models/IndustrialEngineering/IeStyleFile");
const IeBulletinVersion = require("../../models/CMS_Models/IndustrialEngineering/IeBulletinVersion");
/* Lazy: requiring the IE service at module scope pulls `Enquiry.js` into
   evaluation before `constants/crm.js` has finished, and the enum it reads is
   not defined yet. The same cycle is why `approvedTechnicalSource.service.js`
   requires this service lazily too. */
const technicalRevisionKeyOf = (...a) =>
  require("../../services/industrialEngineering/ieBulletinVersion.service")
    .technicalRevisionKeyOf(...a);
const StockItem = require("../../models/CMS_Models/Inventory/Products/StockItem");
const RawItem = require("../../models/CMS_Models/Inventory/Products/RawItem");
const Operation = require("../../models/CMS_Models/Inventory/Configurations/Operation");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const {
  seedHistoricalAdhoc, approveGstPolicy, approveLabourPolicy, prepareForCosting, prepareWithLines } = require("./helpers/sourceBacked");
const { encryptSalaryFields } = require("../../utils/salaryEncryption");

let server, base, seq = 0;

const { MongoMemoryReplSet } = require("mongodb-memory-server");
let rs;

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "costing_technical" });

  const app = express();
  app.use(express.json());
  app.use("/api/cms/inventory/supplier-offers", require("../../routes/CMS_Routes/Inventory/Sourcing/supplierOffers"));
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `tech-${++seq}-${Math.random().toString(36).slice(2)}`;

const call = (path, { method = "GET", body, token, idempotencyKey, company } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor(companies = []) {
  const n = ++seq;
  const email = `tech-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "T", lastName: `L${n}`, email, biometricId: `TC${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "T" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "T", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY = {
  baseCurrency: "INR", roundingMode: "HALF_UP", sellingPriceIncrementMinor: 100,
  /* ── NO OVERHEAD ON THIS BODY ─────────────────────────────────────
     It was here, and the costing policy refuses it now: overhead is a Board
     policy with an effective date and an approver. The fixture approves one
     through `configureProduction`, at the same 12% of DIRECT_PLUS_FIXED this
     line used to set — so every figure this suite asserts is unchanged.

     ── AND NO MARGIN BAND EITHER ─────────────────────────────────────
     The band moved to the Board on the same terms, and the costing policy
     refuses it now. `configureProduction` approves 18/25/32, which is the
     band this body used to carry, so every price this suite asserts is
     unchanged. */
  revision: 0,
};

const PRODUCT = "Oxford Shirt";

/**
 * A raw item in the register, so a material row has an identity to resolve.
 *
 * Company-scoped: the technical importer reads the Item Master under the
 * costing's own company, and an item belonging to nobody is an item nobody
 * can import.
 */
const rawItem = async (name, co) => {
  const n = ++seq;
  return RawItem.create({
    name: `${name} ${n}`, sku: `RAW-${n}`, unit: "Metre", companyId: co._id,
    variants: [{ variantCombination: ["Navy"] }, { variantCombination: ["Ecru"] }],
  });
};

/**
 * A whole world: company, enquiry, journey, style, and an ENQUIRY_STYLE costing.
 *
 * `styleOver` shapes the technical record under test; `journeyCompany` exists
 * so a style can be given a parent belonging to somebody else.
 */
/**
 * THE TWO APPROVALS A COSTING NOW NEEDS BEFORE IT MAY READ R&D AT ALL.
 *
 * ── WHY EVERY STYLE IN THIS FILE GETS THEM ──────────────────────────────────
 * These tests are about MERGE RULES — planned versus measured, an allowance
 * applied once, a basis nothing establishes. They were written when R&D's own
 * approval was enough to make a figure costable. It is not any more:
 * Merchandising must have approved the selection, and Industrial Engineering
 * must have confirmed the exact R&D revision, before a single consumption
 * reaches a preview.
 *
 * So the authority is granted here, once, rather than asserted 51 times — and
 * a test that is ABOUT an authority being absent says so by passing
 * `confirm: false` or by leaving the style with no approved revision, which is
 * what several of them already do.
 *
 * Built from whatever revision the style actually ended up with, so a fixture
 * that overrides `techSheet` still gets a confirmation OF THAT revision rather
 * than of one this helper invented.
 */
async function confirmTechnically(co, styleDoc) {
  const style = await SampleStyle.findById(styleDoc._id)
    .select("techSheet materials bomApproval").lean();

  /* Merchandising's pre-order selection authority: the approved BOM. Only
     added when the style has materials to select — a style with none is a
     fixture about something else. */
  if (String(style.bomApproval?.status || "") !== "approved") {
    await SampleStyle.updateOne({ _id: styleDoc._id }, {
      $set: {
        bomApproval: {
          status: "approved", round: 1,
          decidedAt: new Date("2026-08-04"),
          decidedByName: "Merch Lead", decidedByEmail: "merch@grav.test",
        },
      },
    });
  }

  const revisions = style.techSheet?.technicalRevisions || [];
  const approved = revisions.filter((r) => r.outcome === "approved");
  if (!approved.length) return null;   // nothing for IE to have confirmed
  const rev = approved.reduce((best, r) => (r.revision > (best?.revision ?? -1) ? r : best), null);

  const file = await IeStyleFile.create({
    companyId: co._id, sampleStyleId: styleDoc._id, openedFromOrderId: null,
    source: {
      technicalRevision: rev.revision, submittedAt: rev.submittedAt,
      approvedAt: rev.decidedAt, snapshot: rev.snapshot,
      operationCount: (rev.snapshot?.operations || []).length,
    },
    status: "DRAFT", revision: 1, bulletin: { rows: [] },
  });

  /* IE's own authored route, one row per operation the snapshot carried, each
     with an approved standard time. */
  const rows = (rev.snapshot?.operations || []).map((o, i) => ({
    rowId: `r${i + 1}`, sequence: i + 1,
    ieOperationId: new mongoose.Types.ObjectId(), ieOperationRevision: 1,
    operationCode: o.operationCode || `OP-${i + 1}`,
    operationName: o.name || o.operationCode || `Operation ${i + 1}`,
    machineType: o.machineType || "SNLS",
    proposedSamMinutes: (Number(o.minutes) || 0) + (Number(o.seconds) || 0) / 60,
    standardTimeMinutes: (Number(o.minutes) || 0) + (Number(o.seconds) || 0) / 60,
  }));

  const version = await IeBulletinVersion.create({
    companyId: co._id, ieStyleFileId: file._id, sampleStyleId: styleDoc._id,
    versionNo: 1, state: "APPROVED", revision: 1, fileRevisionAtSubmit: 1,
    rows,
    totals: {
      garmentSamMinutes: rows.reduce((a, r) => a + (r.standardTimeMinutes || 0), 0),
      samRowCount: rows.length,
    },
    sourceFingerprint: "fp", sourceApprovalDigest: "ad", sourceRequirementDigest: "",
    technicalSource: {
      sampleStyleId: styleDoc._id,
      technicalRevision: rev.revision,
      technicalRevisionKey: technicalRevisionKeyOf({
        revision: rev.revision, submittedAt: rev.submittedAt,
        decidedAt: rev.decidedAt, outcome: "approved",
      }),
      submittedAt: rev.submittedAt, approvedAt: rev.decidedAt,
      snapshot: rev.snapshot,
      materialCount: (rev.snapshot?.materials || []).length,
      operationCount: (rev.snapshot?.operations || []).length,
      fileSourceRevision: rev.revision, frozenAt: new Date(),
    },
    submittedBy: new mongoose.Types.ObjectId(), submittedByName: "Maker",
    submittedAt: new Date("2026-08-10"),
    approvedBy: new mongoose.Types.ObjectId(), approvedByName: "Checker",
    approvedAt: new Date("2026-08-11"),
  });
  await IeStyleFile.updateOne({ _id: file._id }, {
    $set: { currentApprovedBulletinVersionId: version._id, currentApprovedVersionNo: 1 },
  });
  return { file, version };
}

async function world({ styleOver = {}, journeyCompany = null, extraStyles = [], briefed = true, confirm = true } = {}) {
  const co = await company("Tech");
  const me = await actor([co]);
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
  await require("./helpers/sourceBacked").approveMarginPolicy(co._id);

  const accountId = new mongoose.Types.ObjectId();
  const journey = await SalesJourney.create({
    journeyId: `J-${++seq}`, name: `Journey ${seq}`, accountId,
    ownerId: me.emp._id, companyId: (journeyCompany || co)._id,
  });
  const enquiry = await Enquiry.create({
    enquiryId: `E-${++seq}`, journeyId: journey._id, accountId,
    companyId: co._id, title: "Winter order",
    products: [{ product: PRODUCT, quantity: 500 }],
  });

  const fabric = await rawItem("Oxford Fabric", co);
  const button = await rawItem("Horn Button", co);

  const style = await SampleStyle.create({
    sampleStyleId: `SS-${++seq}`, styleCode: `SC-${seq}`,
    productName: PRODUCT, journeyId: journey._id, enquiryId: enquiry._id, accountId,
    ...styleOver,
  });
  const siblings = [];
  for (const over of extraStyles) {
    siblings.push(await SampleStyle.create({
      sampleStyleId: `SS-${++seq}`, styleCode: `SC-${seq}`,
      productName: PRODUCT, journeyId: journey._id, enquiryId: enquiry._id, accountId,
      variantKey: `v${seq}`, ...over,
    }));
  }

  /* Merchandising's approval and IE's confirmation, before anything is costed. */
  if (confirm) {
    await confirmTechnically(co, style);
    for (const sib of siblings) await confirmTechnically(co, sib);
  }

  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    /* No label: the display details of an enquiry costing are taken from the
       enquiry itself, and the API refuses a client-supplied one. */
    body: { context: { type: "ENQUIRY_STYLE", primaryId: String(enquiry._id), externalKey: PRODUCT } },
  });
  expect(made.status).toBe(201);

  /* ── AND WHAT SALES ASKED TO BE COSTED ────────────────────────────────
     The style, the quantities and the unit. It used to be `?styleId=` on the
     preview and `technicalStyleId` on the calculation — this screen choosing
     which garment the customer was being quoted. Sales confirms it on the
     enquiry now, so the fixture states it where they do.

     `brief(w, styleId, quantities)` below re-points it, which is how a test
     that used to pass a different `styleId` says the same thing. */
  /* `briefed: false` leaves the enquiry with no confirmed brief — the state
     every costing starts in, and the one several tests below are about. */
  if (briefed) await brief({ enquiry, style }, style._id);

  return { co, me, journey, enquiry, style, siblings, fabric, button, costingId: made.body.costing.id };
}

/** Sales confirms a brief for one style, at one set of quantities. */
async function brief({ enquiry, style }, styleId, quantities = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }]) {
  const doc = await Enquiry.findById(enquiry._id);
  const chosen = await SampleStyle.findById(styleId).select("styleCode sampleStyleId variantLabel productName").lean();
  doc.costingBriefs = [{
    briefId: `brief-ti-${++seq}`,
    sampleStyleId: chosen._id,
    styleCode: String(chosen.styleCode || ""),
    styleReference: String(chosen.sampleStyleId || ""),
    variantLabel: String(chosen.variantLabel || ""),
    productName: String(chosen.productName || PRODUCT),
    quantities: quantities.map((q, i) => ({
      key: String(q.key || `q${i + 1}`),
      label: String(q.label || q.key || `q${i + 1}`),
      quantity: String(q.quantity),
      isPrimary: q.isPrimary === true || (quantities.length === 1 && i === 0),
    })),
    quantityUom: "Pieces",
    currency: "INR",
    state: "CONFIRMED",
    confirmedAt: new Date("2026-06-01"),
    confirmedBy: { id: new mongoose.Types.ObjectId(), name: "A Fixture Salesperson" },
    revision: 1,
  }];
  if (!doc.costingBriefs[0].quantities.some((q) => q.isPrimary)) {
    doc.costingBriefs[0].quantities[0].isPrimary = true;
  }
  doc.markModified("costingBriefs");
  await doc.save();
}

const source = (w) => call(`/${w.costingId}/technical-source`, { token: w.me.token, company: w.co._id });
/* ── THE PREVIEW TAKES NO STYLE ANY MORE ──────────────────────────────────
 * `?styleId=` chose which style it assembled, which made this the screen a
 * style was picked on. Sales confirms that on the enquiry; a test that used to
 * pass one calls `brief(w, styleId)` first. */
const preview = (w, styleId) => {
  if (styleId) return brief(w, styleId).then(() => call(`/${w.costingId}/technical-preview`,
    { token: w.me.token, company: w.co._id }));
  return call(`/${w.costingId}/technical-preview`, { token: w.me.token, company: w.co._id });
};

/** A measured consumption row, as R&D records it. */
const consumed = (item, over = {}) => ({
  rawItemId: item._id, rawItemName: item.name,
  quantity: 1.45, unit: "Metre", allowancePercent: 5, ...over,
});
/** A planned pick, as Merchandising records it. */
const planned = (item, over = {}) => ({
  rawItemId: item._id, rawItemName: item.name, rawItemSku: item.sku,
  quantity: 1.4, unit: "Metre", ...over,
});
/** An operation R&D timed and the server priced. */
const operation = (over = {}) => ({
  type: "Collar attach", operationCode: "OP-COLLAR", machine: "SNLS",
  minutes: 1, seconds: 20, totalSeconds: 80,
  salaryDept: "Production", salaryDesig: "Operator",
  operatorSalary: 18000, operatorCost: 1.92, ...over,
});


/* ═══ 1 · FINDING THE RIGHT STYLE ═════════════════════════════════════════ */

/* ── ONE QUOTATION HELPER, FOR BOTH HALVES OF THIS FILE ────────────────────
 * It sat inside the second describe. The first half needs it too now: an
 * imported line used to carry its own rate and the route took it, and nothing
 * carries a rate any more — the assembly reads the material's price off the
 * Store register, so a world with no quotation blocks for a reason none of
 * these tests is about. */
async function quoteFor(w, over = {}) {
  const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
  const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");
  /* A REAL supplier: the applicability rule refuses a quotation whose
     supplier is not active, and a dangling reference reads as inactive. */
  const supplier = await Vendor.create({
    companyId: w.co._id, companyName: "Mill Assembly", vendorType: "Supplier", status: "Active",
  });
  return SupplierOffer.create({
    companyId: w.co._id,
    supplierId: supplier._id,
    supplierName: supplier.companyName,
    itemId: w.fabric._id,
    purchaseUom: "Metre",
    currency: "INR",
    unitPriceMinor: 41250,
    priceBasis: "TAX_EXCLUSIVE",
    freightTerms: "INCLUSIVE_LANDED",
    gstRatePercent: 12,
    quotationReference: "Q-ASM",
    /* An Indian mill. Stated, because a quotation that never answered the
       customs question blocks the costing rather than being read as domestic
       — this suite is about assembly, not about customs. `over` still lets a
       test make it an import. */
    sourcing: { type: "DOMESTIC" },
    status: "ACTIVE",
    effectiveFrom: new Date("2026-01-01"),
    ...over,
  });
}

describe("the style a costing is about", () => {
  test("the enquiry's product finds its own style", async () => {
    const w = await world({ styleOver: { materials: { rawItems: [] } } });
    const r = await source(w);
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(1);
    expect(r.body.candidates[0].styleId).toBe(String(w.style._id));
    expect(r.body.candidates[0].productName).toBe(PRODUCT);
    /* Proved through the journey, and the answer says so — a reader should
       know what the ownership check was worth. */
    expect(r.body.candidates[0].ownershipProof).toBe("SALES_JOURNEY");
    expect(r.body.several).toBe(false);
  });

  test("a style whose journey belongs to another company is not returned", async () => {
    const other = await company("Rival");
    const w = await world({ journeyCompany: other });
    const r = await source(w);
    expect(r.status).toBe(200);
    /* Not listed as unavailable — not listed. Distinguishing "another
       company's" from "does not exist" tells the caller which ids are real. */
    expect(r.body.candidates).toEqual([]);

    const p = await preview(w, String(w.style._id));
    expect(p.status).toBe(404);
  });

  /* ── AN UNOWNED JOURNEY IS NOT A FOREIGN ONE ─────────────────────────────
     Every SalesJourney and Enquiry in the live deployment predates
     `companyId` and carries none. A journey that names NO company has proved
     nothing — neither ownership nor foreignness — and ending the search there
     refused styles whose own enquiry proved the very same company. That is
     what made the R&D operation-route picker return nothing for a style whose
     journey plainly existed. */
  test("a journey carrying no company falls through to the enquiry", async () => {
    const w = await world();
    await SalesJourney.updateOne({ _id: w.journey._id }, { $unset: { companyId: "" } });

    const r = await source(w);
    expect(r.status).toBe(200);
    expect(r.body.candidates).toHaveLength(1);
    expect(r.body.candidates[0].styleId).toBe(String(w.style._id));
    /* And it says which parent proved it, so the reader is never left
       guessing what the answer rests on. */
    expect(r.body.candidates[0].ownershipProof).toBe("ENQUIRY");

    const p = await preview(w, String(w.style._id));
    expect(p.status).toBe(200);
  });

  test("but a journey naming ANOTHER company still refuses, never falling through", async () => {
    /* The distinction the whole rule turns on. The journey is the spine: when
       it names a company that is the answer, and reading ownership off a
       second parent after the authoritative one said "not yours" would be a
       tenant leak dressed as a fallback. The enquiry here belongs to the
       caller — and must not save it. */
    const other = await company("Rival");
    const w = await world({ journeyCompany: other });
    const enquiry = await Enquiry.findById(w.enquiry._id).lean();
    expect(String(enquiry.companyId)).toBe(String(w.co._id));

    expect((await source(w)).body.candidates).toEqual([]);
    expect((await preview(w, String(w.style._id))).status).toBe(404);
  });

  test("neither parent carrying a company proves nothing at all", async () => {
    const w = await world();
    await SalesJourney.updateOne({ _id: w.journey._id }, { $unset: { companyId: "" } });
    await Enquiry.updateOne({ _id: w.enquiry._id }, { $unset: { companyId: "" } });

    /* ── FAILS CLOSED, ON BOTH READS ──────────────────────────────────
       An unowned record is not everybody's. The candidate list is empty, and
       the preview — which no longer accepts a style id, so there is nothing
       to steer it with — resolves NO style, NO brief and publishes nothing
       that identifies either one.

       The second half used to assert a 404 on `?styleId=`. That parameter is
       gone, so what is asserted is what can still be attacked: the response
       body. */
    expect((await source(w)).body.candidates).toEqual([]);
    const p = await preview(w);
    expect(p.body.assembly?.styleId ?? null).toBeNull();
    /* The enquiry cannot be read in this company, so the brief is not
       resolved either — and the blocker names Sales rather than confirming
       anything about the style. */
    expect(p.body.brief).toBeNull();
    expect(p.body.briefBlocker?.code).toBe("COSTING_BRIEF_REQUIRED");
    /* And no identity of the style, the journey or the enquiry leaks. */
    const body = JSON.stringify(p.body);
    expect(body).not.toContain(String(w.style._id));
    expect(body).not.toContain(String(w.journey._id));
  });

  test("a style holding BUSINESS REFERENCES resolves the same way", async () => {
    /* `journeyId`/`enquiryId` are declared as ObjectIds but the same fields
       are written from imports carrying `SJ-…`/`ENQ-…`. A lookup that only
       matched `_id` refused those silently, as a record that does not exist. */
    const w = await world();
    /* Only `journeyId` — `enquiryId` is how the candidate list finds the
       style in the first place, and swapping it too would test that lookup
       rather than the ownership resolver this is about. */
    await SampleStyle.collection.updateOne(
      { _id: w.style._id },
      { $set: { journeyId: w.journey.journeyId } },
    );

    const r = await source(w);
    expect(r.body.candidates).toHaveLength(1);
    expect(r.body.candidates[0].styleId).toBe(String(w.style._id));
    expect(r.body.candidates[0].ownershipProof).toBe("SALES_JOURNEY");
  });

  test("a business reference belonging to another company is still refused", async () => {
    const other = await company("Rival");
    const w = await world({ journeyCompany: other });
    await SampleStyle.collection.updateOne(
      { _id: w.style._id },
      { $set: { journeyId: w.journey.journeyId } },
    );
    /* The reference form must not become a way round the company check. */
    expect((await source(w)).body.candidates).toEqual([]);
  });

  test("sibling variant styles are still reported, and are no longer this screen's choice", async () => {
    /* ── WHAT MOVED, AND WHAT DID NOT ──────────────────────────────────
       The candidate LIST is a technical-source read and is unchanged: two
       real siblings, each with enough identity to tell them apart.

       What moved is the CHOOSING. It used to be a 409 carrying the
       candidates, so whoever was costing picked between them on a style code
       and a variant label — with no idea which garment the customer was being
       quoted. Sales confirms that on the enquiry, and the claim that they
       must choose is asserted in `sales-costing-brief.test.js`. */
    const w = await world({
      briefed: false,
      styleOver: { variantLabel: "Navy PC", sample: { consumptionRawItems: [] } },
      extraStyles: [{ variantLabel: "White PC" }],
    });
    const r = await source(w);
    expect(r.body.candidates).toHaveLength(2);
    expect(r.body.several).toBe(true);
    /* Enough on each to choose between them without opening both. */
    expect(r.body.candidates.map((c) => c.variantLabel).sort()).toEqual(["Navy PC", "White PC"]);
    expect(r.body.candidates[0].styleCode).toBeTruthy();

    /* And the preview is blocked on SALES, by name — not answered about
       whichever sorted first, and not offering a chooser. */
    const p = await preview(w);
    expect(p.status).toBe(409);
    expect(p.body.preview).toBeUndefined();
    expect(p.body.error.code).toBe("COSTING_BRIEF_REQUIRED");
    expect(p.body.error.details.owner.department).toBe("Sales");
    /* ── AND THE CANDIDATES ARE NOT PUBLISHED WITH IT ────────────────
       A list of styles to pick from, attached to a refusal, is an invitation
       to pick one. The count is enough to explain why it is waiting. */
    expect(p.body.error.details.candidates).toBeUndefined();
    expect(p.body.error.details.styleCount).toBe(2);
  });

  test("a style id from outside this costing's candidates is refused", async () => {
    const w = await world();
    const stranger = await world();
    const r = await preview(w, String(stranger.style._id));
    /* The query parameter is not a way to read a style this costing has
       nothing to do with. */
    expect(r.status).toBe(404);
  });

  test("a historical manual costing says it is not about an enquiry style", async () => {
    const co = await company("Adhoc");
    const me = await actor([co]);
    await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: POLICY });
    /* Seeded, not created: manual creation is closed, and these records
       predate the rule. They stay readable — this endpoint is one of the
       reads that has to keep working on them. */
    const historical = await seedHistoricalAdhoc(co._id, { label: "No style" });
    const r = await call(`/${historical._id}/technical-source`, { token: me.token, company: co._id });
    /* Not an empty list, which would read as "this style has no technical
       data" about a costing that has no style at all. */
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe("COSTING_TECHNICAL_CONTEXT_NOT_SUPPORTED");
  });
});


/* ═══ 2 · PLANNED AND MEASURED ARE ONE MATERIAL ═══════════════════════════ */

describe("two records of the same material are not two costs", () => {
  test("an approved sample supersedes the planned estimate, on one row", async () => {
    const w = await world({});
    const fabric = w.fabric;
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.rawItems": [planned(fabric)],
        "sample.consumptionRawItems": [consumed(fabric)],
        "sample.status": "approved",
        "sample.approvedAt": new Date("2026-08-01"),
      },
    });

    const r = await preview(w, String(w.style._id));
    expect(r.status).toBe(200);
    /* ONE row. Two would put the fabric in the costing twice and double the
       garment's material cost. */
    expect(r.body.preview.materials).toHaveLength(1);

    const m = r.body.preview.materials[0];
    expect(m.chosenFrom).toBe("SAMPLE_MEASURED");
    expect(m.quantity).toBe(1.45);
    expect(m.supersededByApprovedSample).toBe(true);
    /* And the alternative stays visible — an import somebody can check. */
    expect(m.planned.quantity).toBe(1.4);
    expect(m.measured.quantity).toBe(1.45);
    expect(m.chosenReason).toMatch(/approved sample supersedes/i);
  });

  test("an unapproved sample does not supersede — the planned pick still stands", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.rawItems": [planned(w.fabric)],
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.status": "submitted",
      },
    });

    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    /* Evidence, not a decision. */
    expect(m.chosenFrom).toBe("BOM_PLANNED");
    expect(m.quantity).toBe(1.4);
    expect(m.measured.quantity).toBe(1.45);
    expect(m.chosenReason).toMatch(/not approved yet/i);
  });

  test("the planned pick stands until the sample is actually approved", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.rawItems": [planned(w.fabric)],
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.status": "submitted",
        "bomApproval.status": "approved",
      },
    });
    const before = (await preview(w, String(w.style._id))).body.preview.materials[0];
    expect(before.chosenFrom).toBe("BOM_PLANNED");
    expect(before.quantity).toBe(1.4);

    /* Sales approves. THAT is what establishes what the measured figure was
       measured against — it is what runs the sync writing it onto the product
       as a per-garment BOM quantity. Nothing else does. */
    await SampleStyle.updateOne({ _id: w.style._id },
      { $set: { "sample.status": "approved", "sample.approvedAt": new Date() } });

    const after = (await preview(w, String(w.style._id))).body.preview.materials[0];
    expect(after.chosenFrom).toBe("SAMPLE_MEASURED");
    expect(after.quantity).toBe(1.45);
    expect(after.supersededByApprovedSample).toBe(true);
  });

  test("the allowance inside a measured quantity is not applied a second time", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric, { quantity: 1.45, allowancePercent: 5 })],
        "sample.status": "approved", "sample.approvedAt": new Date(),
      },
    });

    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    /* What R&D typed IS the effective consumed amount — sampleStyles.js
       passes it to the product BOM with allowancePercent 0 precisely so it
       is not multiplied again. 1.45, never 1.5225. */
    expect(m.quantity).toBe(1.45);
    expect(m.measured.allowancePercent).toBe(5);
    expect(m.measured.allowanceAlreadyInQuantity).toBe(true);
  });

  test("a planned pick carries no allowance at all, and none is invented", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "materials.rawItems": [planned(w.fabric)], "bomApproval.status": "approved" },
    });
    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    expect(m.quantity).toBe(1.4);
    /* Null, not 0. "None recorded" and "recorded as none" are different
       claims about what Merchandising did. */
    expect(m.planned.quantity).toBe(1.4);
    expect(m.measured).toBeNull();
  });
});


/* ═══ 3 · NO DENOMINATOR IS ASSUMED ═══════════════════════════════════════ */

describe("a quantity whose basis nothing establishes", () => {
  test("measured consumption on an unapproved sample, with no product BOM, is not importable", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.status": "submitted",
      },
    });

    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    /* A sample round may have made three garments; nothing stores how many.
       The figure is shown, never divided. */
    expect(m.basis).toBe("NEEDS_CONFIRMATION");
    expect(m.basisLabel).toBe("Quantity basis needs confirmation");
    expect(m.importable).toBe(false);
    expect(m.blockers.map((b) => b.code)).toContain("BASIS_UNKNOWN");
    /* And the figure itself is still visible — refusing to guess is not
       refusing to show. */
    expect(m.measured.quantity).toBe(1.45);
  });

  test("an unowned StockItem cannot confirm the quantity basis", async () => {
    const w = await world({});
    /* A product whose BOM carries exactly this quantity — and which belongs
       to nobody, because StockItem has no company field at all. */
    const item = await StockItem.create({
      name: "Oxford Shirt FG", reference: `FG-${Date.now()}`, category: "Shirt",
      createdBy: w.me.emp._id,
      variants: [{
        sku: "FG-1", cost: 0, salesPrice: 0,
        rawItems: [{
          rawItemId: w.fabric._id, rawItemName: w.fabric.name, unit: "Metre",
          requiredQuantity: 1.45, allowancePercent: 0, quantity: 1.45,
          unitCost: 0, totalCost: 0,
        }],
      }],
    });
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.status": "submitted",
        "production.stockItemId": item._id,
      },
    });

    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    /* ── A PROOF THAT CANNOT BE SCOPED IS NOT A PROOF ────────────────────
       The id comes from a Sales record with no company of its own, and
       StockItem has none either — so a stale or tampered `stockItemId` could
       have another company's BOM decide whether this row was importable.
       The sample is unapproved and nothing else establishes the basis, so
       the answer is the honest one. */
    expect(m.basis).toBe("NEEDS_CONFIRMATION");
    expect(m.importable).toBe(false);
  });

  test("a foreign RawItem is neither resolved nor described", async () => {
    const w = await world({});
    const other = await company("Rival");
    const theirs = await rawItem("Secret Silk", other);
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.rawItems": [{
          rawItemId: theirs._id,
          /* The sample's OWN recorded name — this company's data, kept. */
          rawItemName: "As recorded here", quantity: 1.4, unit: "Metre",
        }],
        "bomApproval.status": "approved",
      },
    });

    const m = (await preview(w, String(w.style._id))).body.preview.materials[0];
    /* A stale or tampered id can name any item in the deployment. Unscoped,
       this endpoint would read another company's item name, SKU, unit and
       variant colours back to whoever can open a costing. */
    expect(m.itemInRegister).toBe(false);
    expect(m.importable).toBe(false);
    expect(m.blockers.map((b) => b.code)).toContain("NO_ITEM");
    const serialised = JSON.stringify(m);
    expect(serialised).not.toContain("Secret Silk");
    expect(serialised).not.toContain(theirs.sku);
    expect(m.registeredUnit).toBe("");
    expect(m.variantLabel).toBe("");
  });
});


/* ═══ 4 · MISSING STAYS MISSING ═══════════════════════════════════════════ */

describe("nothing absent becomes zero", () => {
  test("a material with no quantity or no unit is not importable", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.rawItems": [
          planned(w.fabric, { quantity: undefined }),
          planned(w.button, { unit: "" }),
        ],
        "bomApproval.status": "approved",
      },
    });

    const rows = (await preview(w, String(w.style._id))).body.preview.materials;
    const noQty = rows.find((r) => r.rawItemId === String(w.fabric._id));
    const noUnit = rows.find((r) => r.rawItemId === String(w.button._id));
    expect(noQty.quantity).toBeNull();
    expect(noQty.blockers.map((b) => b.code)).toContain("NO_QUANTITY");
    expect(noQty.importable).toBe(false);
    expect(noUnit.blockers.map((b) => b.code)).toContain("NO_UNIT");
    /* The register's unit is offered as context, never filled in as though
       somebody had recorded it. */
    expect(noUnit.registeredUnit).toBe("Metre");
    /* Null on the merged row because nothing usable was chosen — not the
       register's unit quietly standing in for the one nobody recorded. */
    expect(noUnit.unit).toBeNull();
    expect(noUnit.planned.unit).toBe("");
  });

  test("an operation that priced to nothing is missing a rate, not free", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [
          operation(),
          operation({ type: "Hem", operationCode: "OP-HEM",
            salaryDept: "", salaryDesig: "", operatorSalary: 0, operatorCost: 0 }),
        ],
      },
    });

    const ops = (await preview(w, String(w.style._id))).body.preview.operations;
    const priced = ops.find((o) => o.operationCode === "OP-COLLAR");
    const unpriced = ops.find((o) => o.operationCode === "OP-HEM");

    expect(priced.operatorCost).toBe(1.92);
    expect(priced.importable).toBe(true);
    /* costOperations returns 0 when it resolved no salary basis, and 0 is
       also a real value. Reported as null with a blocker — a garment's
       hemming in a costing at nothing is worse than one nobody costed. */
    expect(unpriced.operatorCost).toBeNull();
    expect(unpriced.importable).toBe(false);
    /* ── AND THE REFUSAL NAMES THE FIX ────────────────────────────────
       This asserted the generic NO_RATE. An operation with no salary group
       is not a mystery — it is an unmapped operation, and the person who can
       fix it is a manager in the operation register. The blocker says so and
       says where. */
    expect(unpriced.blockers.map((b) => b.code)).toContain("NO_SALARY_GROUP");
    const blocker = unpriced.blockers.find((b) => b.code === "NO_SALARY_GROUP");
    expect(blocker.message).toMatch(/not mapped to a salary group/i);
    expect(blocker.message).toMatch(/Registered operations/);
  });

  test("a salary mapping added after sample approval is used on the next costing read", async () => {
    const w = await world({});
    const n = ++seq;
    const code = `LATE-MAP-${n}`;
    const department = `Production-${n}`;
    const designation = `Operator-${n}`;

    await Operation.create({
      name: `Late mapped operation ${n}`,
      operationCode: code,
      totalSam: 1,
      durationSeconds: 60,
      machineType: "SNLS",
      salaryDept: department,
      salaryDesig: designation,
    });
    await Employee.collection.insertOne({
      firstName: "Mapped",
      lastName: "Operator",
      email: `mapped-${n}@test.example`,
      biometricId: `MAP${n}`,
      isActive: true,
      gender: "Other",
      department,
      designation,
      salary: encryptSalaryFields({ netSalary: 20000 }),
    });
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.status": "approved",
        "sample.approvedAt": new Date("2026-08-01"),
        "sample.operations": [operation({
          type: `Late mapped operation ${n}`,
          operationCode: code,
          minutes: 1,
          seconds: 0,
          totalSeconds: 60,
          salaryDept: "",
          salaryDesig: "",
          operatorSalary: 0,
          operatorCost: 0,
        })],
      },
    });

    const mapped = (await preview(w, String(w.style._id))).body.preview.operations[0];
    expect(mapped.salaryDept).toBe(department);
    expect(mapped.salaryDesig).toBe(designation);
    expect(mapped.operatorSalary).toBe(20000);
    expect(mapped.operationId).toBeTruthy();
    expect(mapped.blockers).toEqual([]);
    expect(mapped.importable).toBe(true);
  });

  test("an operation with no time recorded is refused, and only for the time", async () => {
    /* A salary IS on this row, so the rate is not what is missing. Reporting
       NO_RATE as well would send somebody to Production to fix a salary basis
       that is already set. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "sample.operations": [operation({ minutes: 0, seconds: 0, totalSeconds: 0, operatorCost: 0 })] },
    });
    const o = (await preview(w, String(w.style._id))).body.preview.operations[0];
    expect(o.blockers.map((b) => b.code)).toEqual(["NO_TIME"]);
    expect(o.importable).toBe(false);
  });

  test("a legacy operator cost is not required when the salary is there", async () => {
    /* ── THE PREREQUISITE THIS REMOVES ────────────────────────────────────
       `operatorCost` is the SAMPLE's own `salary / 12,480 x SAM`, written by
       older code. The preview refused to import an operation without it —
       even with the SAM and the salary the company policy calculation
       actually uses both present on the record. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "sample.operations": [operation({ operatorCost: null })] },
    });
    const o = (await preview(w, String(w.style._id))).body.preview.operations[0];
    expect(o.blockers).toEqual([]);
    expect(o.importable).toBe(true);
    expect(o.operatorCost).toBeNull();
    expect(o.operatorSalary).toBe(18000);
  });

  test("no salary and no legacy cost is still a refusal", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({
          operatorCost: null, operatorSalary: 0, salaryDept: "", salaryDesig: "",
        })],
      },
    });
    const o = (await preview(w, String(w.style._id))).body.preview.operations[0];
    /* No salary group at all, so the refusal is the mapping one — and it is
       the ONLY blocker: the time is fine and reporting NO_RATE beside it
       would send somebody looking for a rate that is not the problem. */
    expect(o.blockers.map((b) => b.code)).toEqual(["NO_SALARY_GROUP"]);
    expect(o.importable).toBe(false);
  });

  test("a mapped operation whose group pays nothing is a RATE problem, not a mapping one", async () => {
    /* The two are different desks. The group is named, so the register is
       right; what is missing is a readable salary for it. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({
          operatorCost: null, operatorSalary: 0,
          salaryDept: "Tailoring", salaryDesig: "Operator",
        })],
      },
    });
    const o = (await preview(w, String(w.style._id))).body.preview.operations[0];
    expect(o.blockers.map((b) => b.code)).toEqual(["NO_RATE"]);
    expect(o.importable).toBe(false);
  });

  test("an ambiguous operation code is refused BY CODE, not as a missing rate", async () => {
    /* The register holds duplicate codes. `costOperations` resolves such a
       row to nothing and stamps the code; the preview has to name it, because
       "reconcile the duplicate" is unactionable without knowing which one. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({
          operatorCost: null, operatorSalary: 0, salaryDept: "", salaryDesig: "",
          ambiguousOperationCode: "TS008",
        })],
      },
    });
    const o = (await preview(w, String(w.style._id))).body.preview.operations[0];
    expect(o.blockers.map((b) => b.code)).toEqual(["AMBIGUOUS_CODE"]);
    expect(o.blockers[0].message).toMatch(/^TS008: /);
    expect(o.blockers[0].message).toMatch(/More than one registered operation shares this code/);
    expect(o.blockers[0].operationCode).toBe("TS008");
    expect(o.importable).toBe(false);
  });

  test("the unresolved-group list is gone, and its three real questions became families", async () => {
    /* ── WHAT THIS TEST USED TO ASSERT ────────────────────────────────
       That the preview named four groups — outside services, embellishment,
       packaging and one-time development — because none had a technical
       record, and a section rendering ₹0 would read as "none needed".

       Three of them have records now, and are assessed as cost FAMILIES from
       those records. The fourth, `embellishment`, was outside processes under
       another name: no record, no department, and answerable only by somebody
       in Costing declaring it away. Keeping a second checklist over the same
       three questions is how one panel comes to say "answered" while the
       other says "open". */
    const w = await world({});
    const p = (await preview(w, String(w.style._id))).body.preview;
    expect(p.unresolved).toBeUndefined();
    expect(p.completeness.complete).toBe(false);
    expect(p.completeness.label).toBe("Pre-production estimated cost");
    expect(p.completeness.outstanding.some((o) => o.scope === "UNRESOLVED")).toBe(false);
  });

  test("the preview publishes the three department-owned applicability answers", async () => {
    /* A state each, and nothing else. Absent is a question nobody asked, and
       it must never read as "no". */
    const w = await world({});
    const p = (await preview(w, String(w.style._id))).body.preview;
    expect(p.applicability.packaging.state).toBe("UNANSWERED");
    expect(p.applicability.outsideProcesses.state).toBe("UNANSWERED");
    expect(p.applicability.development.state).toBe("UNANSWERED");

    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "materials.packagingDecision": {
          required: false, reason: "The customer supplies all packaging.",
          decidedBy: { id: new mongoose.Types.ObjectId(), name: "A Merchandiser" },
          decidedAt: new Date("2026-05-04"),
        },
      },
    });
    const after = (await preview(w, String(w.style._id))).body.preview;
    expect(after.applicability.packaging.state).toBe("NOT_REQUIRED");
    expect(after.applicability.packaging.reason).toBe("The customer supplies all packaging.");
    expect(after.applicability.packaging.decidedByName).toBe("A Merchandiser");
  });
});


/* ═══ 5 · THE PREVIEW CREATES NOTHING ═════════════════════════════════════ */

describe("looking is not deciding", () => {
  test("opening the preview twice creates no version and changes nothing", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { "materials.rawItems": [planned(w.fabric)], "bomApproval.status": "approved" },
    });

    const before = await CostingVersion.countDocuments({ costingId: w.costingId });
    const first = await preview(w, String(w.style._id));
    const second = await preview(w, String(w.style._id));
    const after = await CostingVersion.countDocuments({ costingId: w.costingId });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    /* Somebody must be able to read what the technical record says without
       that being a decision. */
    expect(after).toBe(before);
    expect(second.body.preview.materials).toEqual(first.body.preview.materials);
  });
});


/* ═══ 6 · WHAT THE VERSION FREEZES ════════════════════════════════════════ */

describe("frozen technical provenance", () => {
  /* Exactly what the workspace posts: identity, consumption and unit from the
     technical record, plus the stable key. */
  const importedLines = (w, over = {}) => [
    { lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Oxford fabric",
      unitRate: { amountMinor: 41250, currency: "INR" },
      itemId: String(w.fabric._id), quantityPerUnit: "1.45", quantityUom: "Metre",
      technicalKey: `${w.fabric._id}::`, technicalEvidence: "SAMPLE_MEASURED",
      ...(over.fabric || {}) },
    { lineKey: "collar", category: "OPERATION", behaviour: "PER_UNIT", label: "Collar attach",
      unitRate: { amountMinor: 192, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
      technicalKey: "op::OP-COLLAR",
      ...(over.collar || {}) },
  ];
  const SCEN = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

  async function costed(w) {
    /* ── AND A QUOTATION, BECAUSE THE SERVER PRICES THE ROW NOW ─────────
       `importedLines` carried its own rate and the route took it. Nothing
       carries a rate any more: the assembly reads the material's price off
       the Store register, so a world with no quotation blocks before any
       provenance is frozen. The GST treatment is the Board's answer to
       whether that rate is recoverable. */
    await approveGstPolicy(w.co._id);
    await quoteFor(w);
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.operations": [operation()],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
        "bomApproval.decidedAt": new Date("2026-07-20"), "bomApproval.decidedByName": "P Manager",
      },
    });
    /* The brief the world seeded already names this style and one run size,
       and the server assembles the very rows `importedLines` used to send —
       so preparing the estimate freezes the same technical provenance the
       posted body used to produce. */
    return prepareWithLines(w.costingId, importedLines(w), {
      door: async () => {
        const shut = await call(`/${w.costingId}/versions`, {
          method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
          body: { lines: importedLines(w) },
        });
        expect(shut.status).toBe(409);
        expect(shut.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
      },
    });
  }

  test("the style, both approval gates and each row are frozen", async () => {
    const w = await world({});
    const r = await costed(w);
    expect(r.status).toBe(201);

    const refs = r.body.versions[0].cost.sourceReferences;
    const styleRef = refs.find((x) => x.sourceType === "BOM" && x.snapshot.some((f) => f.key === "styleCode"));
    const snap = Object.fromEntries(styleRef.snapshot.map((f) => [f.key, f.text ?? f.num]));

    /* An id is not evidence. Which BOM round, which sample round, and when
       each was decided is what makes this a record of a decision. */
    expect(snap.styleCode).toBe(w.style.styleCode);
    expect(snap.bomApprovalStatus).toBe("approved");
    expect(snap.bomApprovalRound).toBe(2);
    expect(snap.bomApprovalDecidedBy).toBe("P Manager");
    expect(snap.sampleStatus).toBe("approved");
    expect(snap.sampleApprovedAt).toBeTruthy();
    /* Signed off by a real gate, so the reference says VERIFIED rather than
       claiming it about an unapproved draft. */
    expect(styleRef.confidence).toBe("VERIFIED");

/* ── AND IT IS FOUND BY WHAT IT IS, NOT BY WHAT A CLIENT CALLED IT ────
       The reference used to be keyed `"fabric"` — the `lineKey` the browser
       put on the line it posted. The server assembles the row now, so the
       key is its own: `mat:<itemId>::`. Looking it up by the client's name
       would be asserting that a client still names the record. */
    const matRef = refs.find((x) => x.sourceType === "BOM"
      && x.snapshot.some((f) => f.key === "quantity"));
    const mat = Object.fromEntries(matRef.snapshot.map((f) => [f.key, f.text ?? f.num]));
    expect(mat.quantity).toBe(1.45);
    expect(mat.unit).toBe("Metre");
    expect(mat.evidence).toBe("SAMPLE_MEASURED");
    expect(mat.allowancePercent).toBe(5);
    /* Told apart from a planned 1.40 plus 5%, which is a different claim
       about where the number came from. */
    expect(mat.allowanceInQuantity).toBe("yes");

    const opRef = refs.find((x) => x.sourceType === "OPERATION");
    const op = Object.fromEntries(opRef.snapshot.map((f) => [f.key, f.text ?? f.num]));
    expect(op.operationCode).toBe("OP-COLLAR");
    expect(op.samMinutes).toBeCloseTo(1.3333, 3);
    expect(op.operatorCost).toBe(1.92);
    expect(op.costBasis).toBe("PER_GARMENT");
    expect(op.rateBasis).toMatch(/26 days x 8 hours/);
  });

  test("editing the style afterwards does not change the frozen version", async () => {
    const w = await world({});
    const r = await costed(w);
    const versionId = r.body.versions[0].id;
    const frozen = r.body.versions[0].cost.sourceReferences
      .find((x) => x.sourceType === "BOM" && x.snapshot.some((f) => f.key === "quantity")).snapshot
      .find((f) => f.key === "quantity").num;
    expect(frozen).toBe(1.45);

    /* R&D re-measures and the style is renamed. */
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: { styleCode: "SC-RENAMED", "sample.consumptionRawItems": [consumed(w.fabric, { quantity: 9.99 })] },
    });

    const again = await call(`/${w.costingId}/versions`, { token: w.me.token, company: w.co._id });
    const v = again.body.versions.find((x) => x.id === versionId);
    const still = v.cost.sourceReferences
      .find((x) => x.sourceType === "BOM" && x.snapshot.some((f) => f.key === "quantity"))
      .snapshot.find((f) => f.key === "quantity").num;
    /* A snapshot, not a reference. Otherwise every historical costing
       silently re-costs itself the moment somebody edits a sample. */
    expect(still).toBe(1.45);
    const styleSnap = v.cost.sourceReferences
      .find((x) => x.snapshot.some((f) => f.key === "styleCode")).snapshot
      .find((f) => f.key === "styleCode").text;
    expect(styleSnap).toBe(w.style.styleCode);
    expect(styleSnap).not.toBe("SC-RENAMED");
  });

  test("a client cannot name the style a line came from, at all", async () => {
    /* ── WHAT THIS TEST USED TO ASSERT ────────────────────────────────
       That a line claiming a technical origin without `technicalStyleId` was
       refused — "frozen provenance that names nothing is worse than none,
       because it reads as evidence". The safeguard was about a field the
       browser filled in.

       The field is gone. Which style a costing is about comes from the Sales
       brief, so a payload naming one is refused outright and the provenance
       can never name nothing: it names whatever Sales confirmed. */
    const w = await world({});
    const r = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: importedLines(w), technicalStyleId: String(w.style._id) },
    });
    /* Refused at the door now — the route reads no body at all, so a payload
       naming a style never reaches the parser. The parser's own refusal,
       which names Sales, is asserted directly: the rule keeps a test even
       with no route that can carry a style to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(r.body.error.details.owner.department).toBe("Sales");

    const { refuseCommercialInputs } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try {
      refuseCommercialInputs({ technicalStyleId: String(w.style._id) });
    } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_BRIEF_MOVED");
    expect(told.details.fields).toContain("technicalStyleId");
    expect(told.details.owner.department).toBe("Sales");
  });

  test("a historical manual costing is refused a new version, and freezes nothing new", async () => {
    /* ── THE OLD TEST, AND WHY THE BOUNDARY MOVED ─────────────────────────
       This proved that a typed costing froze no technical references — true,
       and beside the point once typing one became impossible. A manual
       costing with no provenance is not a lesser costing to be labelled; it
       is a costing nobody should be able to approve, so the answer is not an
       empty `sourceReferences` array but a refusal.

       The old intent survives as the second assertion: nothing was written,
       so there is no new unprovenanced version in the history. */
    const w = await world({});
    await Costing.updateOne({ _id: w.costingId }, { $set: { "context.type": "ADHOC" } });
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });
    const r = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: {
        lines: [{ lineKey: "x", category: "MATERIAL", behaviour: "PER_UNIT", label: "Typed",
          unitRate: { amountMinor: 100, currency: "INR" }, quantityPerUnit: "1", quantityUom: "Metre" }],
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ADHOC_READ_ONLY");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });
});

/* ═══ 7 · THE CALCULATED LINE IS BOUND TO ITS SOURCE ══════════════════════
 *
 * The first implementation snapshotted provenance and calculated from
 * whatever the browser posted. A real technical key beside a different
 * consumption produced an immutable costing that contradicted its own
 * evidence — worse than an unprovenanced one, because the citation is what
 * makes it believable.
 */

describe("an imported line must still be the line that was imported", () => {
  const SCEN = [{ key: "q500", label: "500", quantity: "500", isPrimary: true }];

  const imported = (w, over = {}) => [
    { lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Oxford fabric",
      unitRate: { amountMinor: 41250, currency: "INR" },
      itemId: String(w.fabric._id), quantityPerUnit: "1.45", quantityUom: "Metre",
      technicalKey: `${w.fabric._id}::`, technicalEvidence: "SAMPLE_MEASURED",
      ...(over.fabric || {}) },
    { lineKey: "collar", category: "OPERATION", behaviour: "PER_UNIT", label: "Collar attach",
      unitRate: { amountMinor: 192, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
      technicalKey: "op::OP-COLLAR", ...(over.collar || {}) },
  ];

  async function ready(over = {}) {
    const w = await world({});
    /* ── AND A QUOTATION, BECAUSE THE SERVER PRICES THE ROW NOW ─────────
       The imported lines below carried their own rate, and the route took
       it. Nothing carries a rate any more: the assembly reads the material's
       price off the Store quotation register, so a world with no quotation
       has no material cost and blocks — which would make every test in this
       section fail for a reason none of them is about. The GST treatment is
       the Board's answer to whether that rate is recoverable, and a taxable
       quotation cannot be priced without it. */
    await approveGstPolicy(w.co._id);
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.operations": [operation()],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
        ...over,
      },
    });
    await quoteFor(w);
    return w;
  }

  /* ── THE STYLE AND THE QUANTITIES ARE THE BRIEF'S ────────────────────
     `technicalStyleId` and `scenarios` travelled on this body. Which garment
     the customer is being quoted, and at what run sizes, are commercial
     decisions Sales confirms on the enquiry — so the fixture states them
     there and posts only the lines. A test that used to send a DIFFERENT
     `technicalStyleId` passes it here instead, and the brief re-points. */
  const calc = async (w, lines, body = {}) => {
    const { technicalStyleId, scenarios, ...rest } = body;
    await brief(w, technicalStyleId || w.style._id, scenarios || SCEN);
    /* ── THE DOOR, THEN THE PARSER, THEN THE ASSEMBLY ─────────────────
       The retired route ran all three and answered from whichever saw the
       problem. It refuses a browser client before any of them now, so the
       door is checked here and the lines are then offered to the two steps
       that own the rules this suite is about. */
    if (Object.keys(rest).length) {
      return call(`/${w.costingId}/versions`, {
        method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
        body: { lines, ...rest },
      });
    }
    return prepareWithLines(w.costingId, lines, {
      door: async () => {
        const shut = await call(`/${w.costingId}/versions`, {
          method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
          body: { lines },
        });
        expect(shut.status).toBe(409);
        expect(shut.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
      },
    });
  };

  test("an untouched imported line calculates, and the frozen facts match it", async () => {
    const w = await ready();
    const r = await calc(w, imported(w));
    expect(r.status).toBe(201);

    const v = r.body.versions[0];
    /* ── FOUND BY WHAT THEY ARE, NOT BY WHAT A CLIENT CALLED THEM ──────
       `"fabric"` and `"collar"` were the `lineKey`s the browser put on the
       lines it posted. The server assembles the rows now and names them
       itself — `mat:<itemId>::` and `op:op::OP-COLLAR`. Looking them up by
       the old names would be asserting that a client still names the record,
       which is the thing this migration removed. */
    const fabricLine = v.cost.inputs.find((l) => l.category === "MATERIAL");
    const collarLine = v.cost.inputs.find((l) => l.category === "OPERATION");
    const refs = v.cost.sourceReferences;
    const snapOf = (type) => Object.fromEntries(
      refs.find((x) => x.sourceType === type
        && x.snapshot.some((f) => f.key === (type === "OPERATION" ? "operationCode" : "quantity")))
        .snapshot.map((f) => [f.key, f.text ?? f.num]),
    );

    /* ── THE ASSERTION THAT WOULD HAVE CAUGHT THE ORIGINAL DEFECT ────────
       What was calculated and what was frozen are read from the same
       version and compared to each other. They agreed by luck before; they
       agree by construction now. */
    const mat = snapOf("BOM");
    expect(String(fabricLine.quantityPerUnit)).toBe(String(mat.quantity));
    expect(fabricLine.quantityUom).toBe(mat.unit);

    const op = snapOf("OPERATION");
    expect(collarLine.unitRate.amountMinor).toBe(192);
    /* 1.92 rupees, frozen as rupees and calculated as paise — the same money. */
    expect(op.operatorCost).toBe(1.92);
    expect(collarLine.unitRate.amountMinor).toBe(Math.round(op.operatorCost * 100));
    expect(String(collarLine.quantityPerUnit)).toBe("1");
  });

  test("the source is read once, and the freeze reuses that read", () => {
    /* ── A STRUCTURAL PROPERTY, PINNED AS ONE ──────────────────────────
       Binding refuses any difference between the submitted line and the
       record, so a second read cannot currently produce a divergence — which
       means no behavioural test can distinguish one read from two. What CAN
       be pinned is the shape: the freeze takes the preview it is handed and
       does not fetch its own. Two reads would let a change land between them,
       and a version calculated from one answer and provenanced with another
       is the defect this whole correction closes. */
    const src = require("fs")
      .readFileSync(require("path").join(__dirname, "../../services/centralCosting/versionCreation.service.js"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ");
    const body = src.slice(src.indexOf("function freezeTechnicalSource"));
    const end = body.indexOf("\nfunction buildVersionBody");
    const freeze = body.slice(0, end > 0 ? end : undefined);
    expect(freeze).not.toMatch(/buildPreview/);
    expect(freeze).not.toMatch(/await/);
    expect(src).toMatch(/freezeTechnicalSource\(\s*\{ \.\.\.sourcedInput, lines: bound\.lines \}, bound\.preview/);
  });

  test("a same-company style for another product is refused", async () => {
    const w = await ready();
    /* The same company, the same journey, its own enquiry — a different
       product. Ownership says yes; this costing is not about it. */
    const other = await SampleStyle.create({
      sampleStyleId: `SS-${Date.now()}`, styleCode: "SC-TROUSER",
      productName: "Formal Trouser",
      journeyId: w.journey._id, enquiryId: w.enquiry._id, accountId: w.journey.accountId,
      sample: { status: "approved", approvedAt: new Date(), consumptionRawItems: [consumed(w.fabric)] },
    });

    /* ── THE SAME PROTECTION, AT THE BRIEF ────────────────────────────
       This used to post `technicalStyleId` naming the trouser and be refused
       with STYLE_NOT_FOR_THIS_COSTING. There is no such field. The equivalent
       attack is a brief for the trouser: it is keyed by the trouser's style
       and carries the trouser's product name, so the shirt costing — which
       looks up the confirmed brief for ITS product — simply does not find one
       and refuses, naming Sales.

       Freezing a trouser's fabric consumption into a shirt's costing, with
       provenance that looks perfect, is what this still prevents. */
    await brief({ enquiry: w.enquiry, style: other }, other._id);
    const r = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: imported(w) },
    });
    /* Refused at the door, which is the same answer said earlier: a browser
       client cannot prepare an estimate at all, so it certainly cannot
       prepare one for a style Sales has not confirmed. That the
       ORCHESTRATION refuses an unconfirmed style is asserted in
       `sales-estimate-preparation.test.js`. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);
  });

  test("a foreign style cannot become the style a costing is about", async () => {
    /* ── WHERE THIS IS ENFORCED NOW ────────────────────────────────────
       It read: "the version route enforces the style itself, not only the
       preview route" — a payload naming another company's style met
       `COSTING_TECHNICAL_STYLE_MISMATCH`, deliberately the same refusal
       whatever the id, because a message that varied would say which style
       ids are real.

       No payload names a style any more. Which garment a costing is about
       comes from the brief Sales confirmed, and the confirmation is where a
       foreign style is refused — one gate earlier, and the only one there
       is. A costing can no longer be pointed at a style by anybody. */
    const w = await ready();
    const stranger = await world({});

    /* The brief is written straight to the document here, bypassing the
       confirm route that would refuse a foreign style — so the orchestration
       is asked the question the hostile case actually poses: a brief that
       already names another company's style. It must refuse rather than cost
       somebody else's garment. */
    await brief(w, String(stranger.style._id), SCEN);
    const r = await prepareForCosting(w.costingId);

    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);
    /* And the refusal names no id: missing and foreign answer identically,
       or a message would say which style ids are real. */
    expect(JSON.stringify(r.body)).not.toContain(String(stranger.style._id));
  });

  const altered = [
    ["consumption", { fabric: { quantityPerUnit: "3.0" } }, "consumption per garment"],
    ["unit", { fabric: { quantityUom: "Yard" } }, "unit"],
    ["item", { fabric: { itemId: "6a9ba7d0c9e3612ace2ff131" } }, "item"],
    ["variant", { fabric: { variantId: "6a9ba7d0c9e3612ace2ff131" } }, "variant"],
    ["evidence basis", { fabric: { technicalEvidence: "BOM_PLANNED" } }, "evidence basis"],
    ["behaviour", { fabric: { behaviour: "FIXED_PER_RUN", amount: { amountMinor: 100, currency: "INR" } } }, "behaviour"],
  ];
  for (const [what, over, differs] of altered) {
    test(`a submitted ${what} that differs from the record is refused`, async () => {
      const w = await ready();
      const r = await calc(w, imported(w, over));
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe("COSTING_TECHNICAL_SOURCE_CHANGED");
      expect(r.body.error.details.differs).toBe(differs);
      /* Actionable: every one of these is fixed the same way. */
      expect(r.body.error.details.action).toBe("REFRESH_TECHNICAL_PREVIEW");
      expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);
    });
  }

  test("a material key posted as a different kind of cost is refused", async () => {
    const w = await ready();
    const r = await calc(w, imported(w, { fabric: { category: "SERVICE" } }));
    expect(r.status).toBe(409);
    expect(r.body.error.details.differs).toBe("category");
    expect(r.body.error.details.expected).toBe("MATERIAL");
  });

  test("the operation rate is derived server-side, never taken from the browser", async () => {
    const w = await ready();
    /* A rate ten times the real one, posted with a valid technical key. */
    const r = await calc(w, imported(w, { collar: { unitRate: { amountMinor: 1920, currency: "INR" } } }));
    expect(r.status).toBe(201);
    const line = r.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION");
    /* `operatorCost` is entirely derived — salary over the minutes in a
       month, times the SAM. There is no judgement in it and no reason for a
       client to be its authority. */
    expect(line.unitRate.amountMinor).toBe(192);
  });

  test("an operation quantity above one is refused, not multiplied through", async () => {
    const w = await ready();
    const r = await calc(w, imported(w, { collar: { quantityPerUnit: "18" } }));
    /* The rate is already per garment. Eighteen of them is eighteen times
       the stitching, and it would look entirely plausible. */
    expect(r.status).toBe(409);
    expect(r.body.error.details.differs).toBe("quantity per unit");
  });

  test("a source that changed between preview and calculation forces a recheck", async () => {
    const w = await ready();
    /* The person previewed 1.45. R&D re-measures before they press
       calculate. */
    await SampleStyle.updateOne({ _id: w.style._id },
      { $set: { "sample.consumptionRawItems": [consumed(w.fabric, { quantity: 1.6 })] } });

    const r = await calc(w, imported(w));
    /* Using the new figure would cost something nobody reviewed; using the
       old one would freeze a number the source no longer says. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_TECHNICAL_SOURCE_CHANGED");
    /* ── BOTH SIDES ARE NOW EXACT DECIMAL STRINGS ─────────────────────
       `expected` carried a raw number while `submitted` was already a string.
       The comparison is against the EFFECTIVE consumption now — the base plus
       R&D's allowance — which is computed in exact decimal and reported as
       the string it was computed to. A quantity that survives a round trip
       only as a float is a quantity that can disagree with itself, and the
       two halves of a mismatch message should not be different types. */
    expect(r.body.error.details.expected).toBe("1.6");
    expect(r.body.error.details.submitted).toBe("1.45");
  });

  test("a deleted technical row cannot be frozen as though it were still usable", async () => {
    const w = await ready();
    await SampleStyle.updateOne({ _id: w.style._id }, { $set: { "sample.consumptionRawItems": [] } });

    const r = await calc(w, imported(w));
    /* Not a version calculated from the old client value and snapshotted as
       "the record no longer carries this row" — that reads as a note beside a
       number, when it is a reason the number should not exist. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_TECHNICAL_SOURCE_CHANGED");
    expect(r.body.error.details.differs).toBe("the row itself");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);
  });

  test("an undeclared line beside imported ones is refused, not carried", async () => {
    /* ── THE TRUST PATH THIS CLOSES ──────────────────────────────────────
       Every plain row used to be carried through, which meant the refusal for
       a source-backed costing could be sidestepped by leaving the technical
       key off. It also double-counts in silence: a second "thread" row sits
       beside the assembled one and the garment carries it twice. */
    const w = await ready();
    const r = await calc(w, [
      ...imported(w),
      { lineKey: "thread", category: "MATERIAL", behaviour: "PER_UNIT", label: "Thread",
        unitRate: { amountMinor: 1200, currency: "INR" }, quantityPerUnit: "0.02", quantityUom: "Cone" },
    ]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    expect(r.body.error.details.lineKeys).toEqual(["thread"]);
    /* ── AND IT NAMES WHERE THE FACT BELONGS ────────────────────────
       This used to read `remedy: "PROVISIONAL_OVERRIDE"` — "declare it, and
       it is accepted". That remedy is retired, and offering it would now be
       a route back into the screen the refusal exists to close. What the
       refusal points at instead is the desk that owns the fact and the
       record they keep it in. */
    expect(r.body.error.details.remedy).toBe("RECORD_IN_OWNING_APPLICATION");
    expect(r.body.error.details.family).toBe("materials");
    expect(r.body.error.details.owner.department).toBeTruthy();
    expect(r.body.error.details.owner.recordedIn).toBeTruthy();
  });
});


/* ═══ 8 · "STILL MISSING" CAN BE ANSWERED ═════════════════════════════════ */

/* ═══ THE UNRESOLVED-GROUP MACHINERY, AND WHY THERE IS NONE ══════════════
 *
 * Two describes stood here — "an unresolved group stops being unresolved" and
 * "completing the technical build-up" — and between them they were the whole
 * contract of a group checklist: which line answered which group, that a
 * dyeing line did not clear the embroidery requirement, that a blank row
 * answered nothing, that "not applicable" needed a reason and was frozen as a
 * decision, and that removing it reopened the group.
 *
 * Both of the inputs they turned on are gone. No route accepts a hand-entered
 * cost line, and no route accepts a Costing-side applicability decision:
 * whether the customer supplies the packaging is Merchandising's fact,
 * whether anything goes outside is Production's, whether the goods are
 * imported is Store's.
 *
 * The claims that survived moved to where the behaviour now lives:
 *   · the refusal, and the desks it names — `costing-completeness.test.js`
 *   · a departmental decision answering a family, with its author and date —
 *     `costing-applicability.test.js`
 *   · the read-only "who owns this open family" rows — the frontend's
 *     `assembledInputs.test.mjs`
 *
 * Historical versions carrying a frozen `not-applicable:<group>` reference are
 * asserted in `costing-completeness.test.js`, and are untouched.
 * ═══════════════════════════════════════════════════════════════════════ */

describe("assembling a costing from its authoritative sources", () => {
  const assembly = require("../../services/centralCosting/assembly.service");

  const assembled = (w, styleId) =>
    call(`/${w.costingId}/technical-preview${styleId ? `?styleId=${styleId}` : ""}`,
      { token: w.me.token, company: w.co._id });

  test("a uniquely linked R&D technical record is assembled without being asked for", async () => {
    const w = await world({});
    const r = await assembled(w);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("ASSEMBLED");
    /* Nothing was named: one candidate is unambiguous, so it is used. */
    expect(r.body.preview).toBeTruthy();
    expect(r.body.preview.style.styleId).toBe(String(w.style._id));
  });

  test("the Product BOM is never a source", async () => {
    /* Deliberate and load-bearing. The product BOM is DOWNSTREAM of an
       approved sample — it is what manufacturing will build, and it inherits
       from the SampleStyle with the allowance already flattened out of it.
       Costing from it would cost the record the technical record produced,
       one step removed. */
    const fs = require("fs");
    const path = require("path");
    const dir = path.join(__dirname, "../../services/centralCosting");
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".js"))) {
      const src = fs.readFileSync(path.join(dir, file), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
      expect(src).not.toMatch(/require\([^)]*ProductBom[^)]*\)/i);
      expect(src).not.toMatch(/\bProductBom\b/i);
    }
  });

  test("no technical record is a named workflow state, not an empty preview", async () => {
    /* `preview: null` meant three different things and left the screen to
       guess which — so somebody was sent to type consumption figures they
       would have been guessing at. */
    /* No brief either: a style that does not exist cannot have been briefed,
       and seeding one would be the fixture asserting an impossible state. */
    const w = await world({ briefed: false });
    await SampleStyle.deleteMany({ _id: w.style._id });

    const r = await assembled(w);
    expect(r.status).toBe(200);
    expect(r.body.state).toBe("AWAITING_RND_TECHNICAL_DATA");
    expect(r.body.preview).toBeNull();

    const blocker = r.body.missing.find((m) => m.key === "technical");
    expect(blocker.message).toMatch(/Awaiting R&D technical record/);
    /* Named with its owner, so the answer is "ask R&D", not "add a line". */
    expect(blocker.owner.department).toBe("R&D");
    expect(blocker.blocking).toBe(true);
  });

  test("several technical records are a question for SALES, never settled by ordering", async () => {
    /* The claim is unchanged — nothing picks between siblings by sort order.
       What changed is who is asked: this was a 409 handing the candidates to
       whoever was costing. Which garment the customer is being quoted is
       Sales', so the refusal names them and publishes no chooser. */
    const w = await world({
      briefed: false,
      styleOver: { variantLabel: "Navy PC" },
      extraStyles: [{ variantLabel: "White PC" }],
    });
    const r = await assembled(w);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_BRIEF_REQUIRED");
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.details.styleCount).toBeGreaterThan(1);
    expect(r.body.error.details.candidates).toBeUndefined();
  });

  test("a foreign style cannot steer this preview, because nothing can", async () => {
    /* ── HOW THIS USED TO BE ATTACKED, AND WHY IT CANNOT BE ────────────
       `?styleId=` chose which style the preview assembled, so a foreign id
       was a steering vector and the route had to refuse it — carefully,
       BEFORE reporting any workflow state, because answering "awaiting R&D
       technical record" for a foreign id confirms this costing has no record
       of its own.

       The parameter is gone. The style comes from the Sales brief, which is
       read from the costing's own enquiry, so there is no id for a caller to
       supply. The refusal claim it replaced — that a style outside this
       enquiry cannot be briefed — is asserted at the Sales boundary in
       `sales-costing-brief.test.js`. */
    const w = await world({});
    const theirs = await world({});

    const steered = await call(
      `/${w.costingId}/technical-preview?styleId=${theirs.style._id}`,
      { token: w.me.token, company: w.co._id },
    );
    expect(steered.status).toBe(200);
    /* This costing's OWN style, whatever the query said. */
    expect(steered.body.assembly.styleId).toBe(String(w.style._id));
    expect(steered.body.brief.sampleStyleId).toBe(String(w.style._id));
    /* And nothing of theirs appears anywhere in the answer. */
    expect(JSON.stringify(steered.body)).not.toContain(String(theirs.style._id));
  });

  test("company policy is applied automatically and reported with its owner", async () => {
    const w = await world({});
    const r = await assembled(w);
    const rules = Object.fromEntries(r.body.policy.rules.map((x) => [x.key, x]));
    /* ── FINANCING IS NOT ONE OF THESE ANY MORE ───────────────────────
       These are the STANDING rules — one rate the company applies to every
       costing. Financing stopped being one: what it costs to wait to be paid
       depends on the payment terms of the order in front of you, so it is a
       cost line with its own provenance rather than a company setting to
       display beside overhead. */
    expect(Object.keys(rules).sort()).toEqual(["contingency", "overhead"]);

    /* ── AND CONTINGENCY IS THE BOARD'S NOW ───────────────────────────
       Whether the company adds a standard cushion to what it quotes became a
       Board policy with a mode, an approver and an effective date. The desk
       named here is the one that can actually close the gap, which is the
       whole purpose of naming a desk.

       Overhead still reads as Finance's on this row. That is a leftover from
       its own migration — the rate it displays is already the Board's — and
       correcting it is that policy's business, not this one's. */
    expect(rules.contingency.owner.department).toBe("Board");
    expect(rules.overhead.owner.department).toBe("Finance");
  });

  test("an unset policy rule stays missing and never becomes zero", async () => {
    const w = await world({});
    const r = await assembled(w);
    const contingency = r.body.policy.rules.find((x) => x.key === "contingency");
    /* Null, never "0%" — a company that has not set a rule does not get one
       of nothing. */
    expect(contingency.value).toBeNull();
    expect(contingency.state).toBe("MISSING");
    expect(r.body.missing.some((m) => m.key === "policy-contingency")).toBe(true);
  });

  test("financing is not reported as an unconfigured company setting", async () => {
    /* ── BECAUSE IT WOULD NAME THE WRONG DESK ─────────────────────────
       It used to arrive here as "Company financing policy is not configured",
       owned by Finance. Both halves of that were wrong once financing became
       an order-specific figure: the rate is the BOARD'S, and the half that is
       missing is at least as often Sales' unconfirmed payment terms. The
       gap is raised by the assembly with the owning department named — see
       the financing tests — rather than as a policy field nobody filled in. */
    const w = await world({});
    const r = await assembled(w);
    expect(r.body.policy.rules.some((x) => x.key === "financing")).toBe(false);
    expect(r.body.missing.some((m) => m.key === "policy-financing")).toBe(false);
  });

  test("every cost family names the source that is supposed to answer it", async () => {
    const w = await world({});
    const r = await assembled(w);
    const families = r.body.coverage.families;
    expect(families.length).toBeGreaterThan(0);
    for (const f of families) {
      expect(f.authority).toBeTruthy();
      expect(f.owner?.department).toBeTruthy();
    }
    const byKey = Object.fromEntries(families.map((f) => [f.key, f]));
    /* The audit's answers, in code. */
    expect(byKey.materials.authority).toBe("AUTOMATIC");
    expect(byKey.operations.owner.department).toBe("Production");
    expect(byKey.overhead.authority).toBe("POLICY");
    /* ── TWO FAMILIES GAINED A SOURCE, AND THREE STILL HAVE NONE ─────────
       Packaging and outside services were AWAITING_SOURCE here, which was
       honest at the time: nothing connected a garment to its packaging bill
       and no service quotation register existed. Both are recorded now — a
       requirement on the technical record, priced from a dated quotation —
       so both read AUTOMATIC and their owners name two desks apiece.

       Development followed in the chunk after: setup work is recorded on the
       same technical record and priced either from a supplier's quotation or
       from the development charge Finance published.

       Freight came after that, and customs duty last of all — Store's
       sourcing evidence and the item's tariff heading read against the
       Board's approved duty table.

       Every family in this list now names a source. The honesty of this test
       was always that it said which ones did not; what it says now is that
       none is left, and it asserts that rather than assuming it. */
    expect(byKey.packaging.authority).toBe("AUTOMATIC");
    expect(byKey.packaging.owner.department).toBe("R&D and Store");
    expect(byKey.services.authority).toBe("AUTOMATIC");
    expect(byKey.services.owner.department).toBe("R&D / Production and Store");
    expect(byKey.development.authority).toBe("AUTOMATIC");
    expect(byKey.development.owner.department).toBe("R&D and Store or Finance");
    /* Freight followed: delivery terms on the enquiry, shipment facts on the
       sample, and a transporter's own quotation for the lane. */
    expect(byKey.freight.authority).toBe("AUTOMATIC");
    expect(byKey.freight.owner.department).toBe("Sales, R&D and Store");
    /* And customs duty, which closed the list. Two desks: Store states where
       the goods come from and how they are classified, the Board approves
       what that heading and origin attract. */
    expect(byKey.duty.authority).toBe("AUTOMATIC");
    expect(byKey.duty.owner.department).toBe("Store / Purchase and Board");
    /* Nothing is awaiting a source that does not exist any more. */
    expect(Object.values(byKey).map((fam) => fam.authority)).not.toContain("AWAITING_SOURCE");
  });

  test("the preview and the save go through the same assembly", async () => {
    /* Two careful implementations of one thing is two answers to the same
       question, and the only way to learn they disagreed was to watch a
       number change on save. */
    const fs = require("fs");
    const binding = fs.readFileSync(
      require.resolve("../../services/centralCosting/technicalBinding.service"), "utf8");
    const routes = fs.readFileSync(
      require.resolve("../../routes/CMS_Routes/Costing/costings"), "utf8");
    expect(binding).toMatch(/assembly\.assemble\(/);
    expect(routes).toMatch(/assembly\.assemble\(/);
    expect(assembly.STATE.ASSEMBLED).toBe("ASSEMBLED");
  });

  test("an ad-hoc costing has no source, and that is not a failure", async () => {
    const w = await world({});
    await Costing.updateOne({ _id: w.costingId }, { $set: { "context.type": "ADHOC" } });
    const r = await assembled(w);
    /* The route still refuses a technical preview for a non-enquiry costing —
       the state exists for the assembly's own callers. */
    expect([200, 422]).toContain(r.status);
    expect(assembly.STATE.NOT_SOURCE_BACKED).toBe("NOT_SOURCE_BACKED");
  });
});
describe("provisional overrides are retired", () => {
  /* ── WHAT THIS BLOCK USED TO PROVE ─────────────────────────────────────
     Three things, each a real defect closed at the time: that an override
     needed a FAMILY and a REASON and froze as `PROVISIONAL` with its author;
     that freight — once it acquired a source — could not be typed however
     well declared; and that an override could not be claimed on a line the
     technical record already answered.

     The second of those was the shape of the answer all along. Every family
     bar customs duty has a source now, so "freight cannot be entered by hand"
     became "nothing can", and the family-and-reason contract has nothing left
     to protect: a complete override is refused exactly as readily as an
     incomplete one.

     What has NOT changed is that a version frozen under the old rule still
     carries its `PROVISIONAL` line and its `MANUAL_ENTRY` provenance, and
     still says who typed what and why. That is asserted in
     `costing-manual-input-retired.test.js`, which owns this subject now. */

  /* ── THE DOOR, THEN THE PARSER, THE ASSEMBLY AND THE BINDING ──────────
     The retired route ran all four and answered from whichever saw the
     problem first. It refuses a browser client before any of them now, so
     `prepareWithLines` checks the door and then offers the lines to the three
     steps that own the rules these tests are about. */
  const post = (w, lines) => prepareWithLines(w.costingId, lines, {
    door: async () => {
      const shut = await call(`/${w.costingId}/versions`, {
        method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
        body: { lines },
      });
      expect(shut.status).toBe(409);
      expect(shut.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    },
  });

  test("a complete, well-formed override is refused, and no version is written", async () => {
    const w = await world({});
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });

    const r = await post(w, [{
      lineKey: "cess", category: "DUTY", behaviour: "FIXED_PER_RUN",
      label: "Non-recoverable cess", amount: { amountMinor: 500000, currency: "INR" },
      override: { family: "duty", reason: "Broker's estimate for the imported trim" },
    }]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.reason).toBe("MANUAL_OVERRIDE_RETIRED");
    expect(r.body.error.details.family).toBe("duty");
    /* The refusal still names a desk rather than ending the conversation —
       and the desk it names changed when duty got a source. It used to say
       "Finance", which was where a typed cess figure would have been argued
       about; the answer now comes from Store's sourcing evidence and the
       Board's approved rate, so those are who it sends you to. */
    expect(r.body.error.details.owner.department).toBe("Store / Purchase and Board");
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });

  test("an incomplete one is refused the same way, not for the field it is missing", async () => {
    /* The old contract answered `OVERRIDE_REASON_REQUIRED` and
       `OVERRIDE_FAMILY_REQUIRED` here, so somebody could fill the gap in and
       succeed. Telling them which field to complete would now be an
       instruction to build a request that cannot be accepted. */
    const w = await world({});
    const line = (over) => ({
      lineKey: "cess", category: "DUTY", behaviour: "FIXED_PER_RUN",
      label: "Non-recoverable cess", amount: { amountMinor: 500000, currency: "INR" },
      override: over,
    });

    for (const over of [{ family: "duty" }, { reason: "Quoted by the broker" }, {}]) {
      const r = await post(w, [line(over)]);
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
      expect(r.body.error.details.reason).toBe("MANUAL_OVERRIDE_RETIRED");
    }
  });

  test("freight cannot be entered by hand, and the refusal still names the three desks", async () => {
    /* ── THE ESCAPE THIS FAMILY USED TO LEAVE OPEN ──────────────────
       While freight had no register, a declared override was the only way to
       answer it and was correctly accepted. It has one now — the enquiry's
       delivery terms, the sample's shipment facts and a transporter's dated
       quotation — and a typed figure beside that is a second answer carrying
       no lane, no carrier and no reference.

       The refusal used to be freight's own (`OVERRIDE_FAMILY_HAS_A_SOURCE`),
       raised by a merger that no longer exists because nothing is merged. It
       is the general one now, and it still has to arrive with an address on
       it — which is the half of that refusal worth keeping. */
    const w = await world({});
    const r = await post(w, [{
      lineKey: "carriage", category: "FREIGHT", behaviour: "FIXED_PER_RUN",
      label: "Outward freight", amount: { amountMinor: 500000, currency: "INR" },
      override: { family: "freight", reason: "Quoted by the transporter over the phone" },
    }]);

    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.family).toBe("freight");
    /* Sales states who bears it, R&D measures what ships, Store quotes the
       lane. */
    expect(r.body.error.details.owner.department).toMatch(/Sales/);
    expect(r.body.error.details.owner.department).toMatch(/Store/);
    expect(r.body.error.details.owner.recordedIn).toMatch(/freight quotations/i);
  });

  test("an override on a sourced line is refused too, and for the same reason", async () => {
    /* It used to have a refusal of its own — `OVERRIDE_ON_SOURCED_LINE`,
       "a line priced from a quotation or a technical record is not an
       override". True, and now a special case of a rule that covers every
       line: a costing does not take a typed figure anywhere. */
    const w = await world({});
    const r = await post(w, [{
      lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Fabric",
      unitRate: { amountMinor: 41250, currency: "INR" }, quantityPerUnit: "1.4", quantityUom: "Metre",
      technicalKey: `${w.fabric._id}::`,
      override: { family: "materials", reason: "trust me" },
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
  });
});

/* ═══ THE SERVER ASSEMBLES; THE BROWSER DECIDES ══════════════════════════ */

describe("assembly without any client lines", () => {
  const assembly = require("../../services/centralCosting/assembly.service");

  /* Its own fixtures — the neighbouring block's are scoped to it, and reusing
     them across describes is how a shared world starts leaking between
     tests. */
  /* A live supplier quotation for the fabric, so the assembly has a Store
     rate to attach. Without one the material line is correctly rateless and
     the calculation is correctly refused — proved separately below. */

  async function ready() {
    const w = await world({});
    /* Recoverability is a company answer, so the policy has to state it
       before a quotation-backed material can be costed. */
    /* ── AND THE GST TREATMENT IS AN APPROVED BOARD DECISION ─────────────
       It was a field on the costing policy, written straight to the
       collection here. `getPolicy` no longer reads that field, so a fixture
       setting it prices nothing — every taxable quotation is refused with
       TAX_TREATMENT_REQUIRED. The value is the same one; the record is the
       Board's. */
    await approveGstPolicy(w.co._id);
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.operations": [operation()],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    await quoteFor(w);
    return w;
  }

  const imported = (w) => [
    { lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Oxford fabric",
      unitRate: { amountMinor: 41250, currency: "INR" },
      itemId: String(w.fabric._id), quantityPerUnit: "1.45", quantityUom: "Metre",
      technicalKey: `${w.fabric._id}::`, technicalEvidence: "SAMPLE_MEASURED" },
  ];

  /* ── WHAT THIS PINS ───────────────────────────────────────────────────
     The previous pass produced a preview CONTRACT and stopped: the server
     could describe a technical record beautifully and still needed the
     browser to reconstruct it as cost lines before anything was costed. */
  const calcNoLines = (w, body = {}) => (Object.keys(body).length
    ? call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: [], ...body },
    })
    : prepareForCosting(w.costingId));

  test("zero client lines and one matching style produce server-generated lines", async () => {
    const w = await ready();
    const r = await calcNoLines(w);
    expect(r.status).toBe(201);

    const inputs = r.body.versions[0].cost.inputs;
    /* Materials AND operations, built by the server from the record. */
    expect(inputs.some((l) => l.category === "MATERIAL")).toBe(true);
    expect(inputs.some((l) => l.category === "OPERATION")).toBe(true);
    /* And they are technical rows, not invented ones. */
    const material = inputs.find((l) => l.category === "MATERIAL");
    expect(material.quantityPerUnit).toBeTruthy();
    expect(material.lineKey).toMatch(/^mat:/);
  });

  test("the assembled lines reach the engine and the frozen version", async () => {
    const w = await ready();
    const r = await calcNoLines(w);
    const v = r.body.versions[0];
    /* Costed, not merely listed: the scenario carries the lines and a total. */
    const scenario = v.cost.scenarios[0];
    expect(scenario.lines.some((l) => l.category === "OPERATION")).toBe(true);
    expect(scenario.totalCostMinor).toBeGreaterThan(0);
    /* And the technical source is frozen beside them. */
    expect((v.cost.sourceReferences || []).some((x) => x.sourceType === "BOM")).toBe(true);
  });

  test("a client rate for a technical row cannot change the result", async () => {
    /* The server re-reads the record and refuses a submitted consumption that
       differs from it — so a stale or hostile client changes nothing. */
    const w = await ready();
    const honest = await calcNoLines(w);
    const material = honest.body.versions[0].cost.inputs.find((l) => l.category === "MATERIAL");

    const forged = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: {
        lines: [{ ...imported(w)[0], quantityPerUnit: "99" }],
      },
    });
    expect(forged.status).toBeGreaterThanOrEqual(400);
    /* The honest version's consumption is the record's, whatever was sent. */
    expect(material.quantityPerUnit).not.toBe("99");
  });

  test("no technical record REFUSES the calculation, and names R&D", async () => {
    /* ── THE BYPASS THIS CLOSES ────────────────────────────────────────────
       The previous pass returned the client's own lines here and let them
       calculate, reasoned as "refusing them would make an awaiting-R&D
       costing unusable". That was backwards: the whole claim of a
       source-backed costing is that its consumption came from the sample, so
       a version built from typed lines while that record is missing is a
       manual costing wearing an enquiry product's name — and nothing on it
       said so. */
    const w = await world({});
    await SampleStyle.deleteMany({ _id: w.style._id });

    await expect(assembly.assembleLines(
      { companyId: w.co._id, actorId: "t", actorName: "T" },
      await Costing.findById(w.costingId).lean(),
      { policy: {} },
    )).rejects.toMatchObject({ code: "COSTING_AWAITING_SOURCE" });
  });

  test("a stale or hostile client cannot type its way past missing R&D data", async () => {
    const w = await world({ briefed: false });
    await SampleStyle.deleteMany({ _id: w.style._id });
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });

    const r = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: {
        lines: [{
          lineKey: "fabric", category: "MATERIAL", behaviour: "PER_UNIT", label: "Fabric",
          unitRate: { amountMinor: 41250, currency: "INR" },
          quantityPerUnit: "1.4", quantityUom: "Metre",
        }],
      },
    });
    /* ── TWO GATES NOW, AND THE FIRST ONE IS SALES' ───────────────────
       There is no technical record AND no brief. The costing refuses on the
       brief first, which is the honest order: nobody has asked for this to be
       costed, so the missing R&D record is not yet anybody's problem. The
       typed line is refused either way, and the point of the test — that a
       client cannot type its way past a missing source — holds at whichever
       gate it meets. */
    expect(r.status).toBe(409);
    /* Whichever gate it meets — and now the door counts as one: a stale
       client cannot type its way past missing R&D data because it cannot
       reach the calculation at all. */
    expect(["COSTING_BRIEF_REQUIRED", "COSTING_AWAITING_SOURCE", "COSTING_PREPARATION_MOVED_TO_SALES"])
      .toContain(r.body.error.code);
    expect(["Sales", "R&D"]).toContain(r.body.error.details.owner.department);
    /* And no version was created. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });

  test("an ambiguous technical record refuses the SAVE too, and names Sales", async () => {
    /* It used to refuse with the choices attached — the save path's copy of
       the chooser. Same refusal, different desk, and no chooser. */
    const w = await world({
      briefed: false,
      styleOver: { variantLabel: "Navy PC" },
      extraStyles: [{ variantLabel: "White PC" }],
    });
    const before = await CostingVersion.countDocuments({ costingId: w.costingId });
    /* Prepared the way Sales does: the retired route refuses a browser
       client, and this asks for nothing the orchestration does not resolve. */
    const r = await prepareForCosting(w.costingId);
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_BRIEF_REQUIRED");
    expect(r.body.error.details.owner.department).toBe("Sales");
    expect(r.body.error.details.candidates).toBeUndefined();
    /* And nothing was written. */
    expect(await CostingVersion.countDocuments({ costingId: w.costingId })).toBe(before);
  });

  test("a historical manual costing has no calculator left", async () => {
    /* ── THE CLAIM THIS TEST USED TO MAKE ─────────────────────────────────
       That the manual workflow was merely CONFINED to the ad-hoc context.
       That confinement was the last way to produce an approvable cost with
       nothing behind it — an ad-hoc costing was two lines to create and took
       any figure typed into it. The workflow is closed, not relocated. */
    const w = await world({});
    await Costing.updateOne({ _id: w.costingId }, { $set: { "context.type": "ADHOC" } });
    const r = await call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: {
        lines: [{
          lineKey: "thing", category: "MISC", behaviour: "FIXED_PER_RUN", label: "Sundry",
          amount: { amountMinor: 100000, currency: "INR" },
        }],
      },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_ADHOC_READ_ONLY");
  });

  test("preview and save assemble the same lines from unchanged sources", async () => {
    const w = await ready();
    const ctx = { companyId: w.co._id, actorId: "t", actorName: "T" };
    const costing = await Costing.findById(w.costingId).lean();

    const previewed = await assembly.assembleLines(ctx, costing, {
      styleId: String(w.style._id), policy: {},
    });
    const saved = await calcNoLines(w);
    expect(saved.status).toBe(201);

    const savedKeys = saved.body.versions[0].cost.inputs.map((l) => l.lineKey).sort();
    const previewKeys = previewed.generated.map((l) => l.lineKey).sort();
    /* Identical structure — the preview is not a second implementation of the
       save, which is what made a number change on save possible. */
    expect(savedKeys).toEqual(previewKeys);
  });

  test("missing contingency policy is reported", async () => {
    /* Omitted in the previous pass, so a company with no contingency rule was
       told nothing at all and the family read as answered. */
    const w = await ready();
    const assembled = await assembly.assemble(
      { companyId: w.co._id, actorId: "t" },
      await Costing.findById(w.costingId).lean(),
      {},
    );
    expect(assembled.missing.some((m) => m.key === "policy-contingency")).toBe(true);
    /* Financing is deliberately absent from this list: it is not a company
       field that is either configured or not. */
    expect(assembled.missing.some((m) => m.key === "policy-financing")).toBe(false);
  });

  test("an operation rate is provisional until the production assumptions exist", async () => {
    /* `salary / 12,480 x SAM` assumes every paid minute is productive, uses
       NET salary, and says nothing about machine cost. A company at 55%
       efficiency and one at 85% have labour costs a third apart, so the
       figure is an arithmetic result until somebody states the assumptions. */
    const bare = assembly.productionAssumptions({});
    expect(bare.configured).toBe(false);
    /* Sentences, not field names — the reader has to know what is missing and
       why it matters, and "employer burden" alone says neither. */
    expect(bare.missing.join(" ")).toMatch(/how much of a paid month is productive/);
    expect(bare.missing.join(" ")).toMatch(/only their take-home pay/);
    expect(bare.missing.join(" ")).toMatch(/where machine cost sits/);

    const w = await ready();
    const assembled = await assembly.assembleLines(
      { companyId: w.co._id, actorId: "t", actorName: "T" },
      await Costing.findById(w.costingId).lean(),
      { styleId: String(w.style._id), policy: {} },
    );
    expect(assembled.missing.some((m) => m.key === "policy-production-assumptions")).toBe(true);

    const configured = assembly.productionAssumptions({
      productiveMinutesPerMonth: 9000,
      employerBurdenPercent: "18",
      machineBurdenTreatment: "IN_OVERHEAD",
    });
    expect(configured.configured).toBe(true);

    /* ── AN ENUM IS NOT A MACHINE-COST SOURCE ──────────────────────────
       Choosing "inside the operation rate" states an intention and supplies
       no number: nothing here records a machine hourly rate. Treating that
       as resolved is the "answered because a field is set" failure this
       correction exists to remove. */
    const pretend = assembly.productionAssumptions({
      productiveMinutesPerMonth: 9000,
      employerBurdenPercent: "18",
      machineBurdenTreatment: "IN_OPERATION_RATE",
    });
    expect(pretend.configured).toBe(false);
    expect(pretend.missing.join(" ")).toMatch(/no machine-cost source exists/i);
  });

  test("there is no merger left to get wrong", async () => {
    /* ── WHAT THIS TEST USED TO PROVE ────────────────────────────────────
       `mergeOverrides` placed a hand-entered figure into the assembled set.
       An override sitting BESIDE an assembled material line doubles the
       fabric; one silently DISPLACING it hides a Store quotation behind a
       typed number. Neither failure announces itself in a total, so the
       merger refused anything it could not tell apart: a supplement that
       collided with an assembled key, and a replacement naming a line the
       assembly never produced.

       Four careful cases, all of them about placing a figure nothing can
       produce any more. The function is gone rather than left unreachable —
       a merger nothing calls is a door in a wall, and the next person who
       needs a number finds it before they find the reason it stopped being
       called. */
    expect(assembly.mergeOverrides).toBeUndefined();

    /* ── AND THE ASSEMBLY REFUSES ONE OUTRIGHT ─────────────────────
       Called directly, because this is the layer the merger lived in: an
       internal caller that built an input by hand never passes the request
       parser, and the refusal has to hold for it too. */
    const w = await ready();
    await expect(assembly.assembleLines(
      { companyId: w.co._id, actorId: "x" },
      await Costing.findById(w.costingId).lean(),
      {
        styleId: String(w.style._id),
        clientLines: [{
          lineKey: "cess-1", category: "DUTY", behaviour: "FIXED_PER_RUN",
          label: "Cess", amount: { amountMinor: 500000, currency: "INR" },
          override: { family: "duty", reason: "broker's estimate" },
        }],
        policy: {}, scenarios: [{ key: "q", quantity: "500", isPrimary: true }],
      },
    )).rejects.toMatchObject({ code: "COSTING_MANUAL_INPUT_RETIRED" });
  });
});

/* ═══ THE CANONICAL LABOUR RATE REACHES THE FROZEN VERSION ═══════════════ */

describe("policy labour cost, end to end", () => {
  const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

  /* The worked example, as a route test — a unit test of `labourCost.js`
     proves the arithmetic and proves nothing about what is SAVED, which is
     exactly where the defect was: the rate was calculated during assembly and
     then overwritten by the sample's own figure inside `bindOperation`. */
  async function withPolicy(over = {}) {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        /* SAM 1.5 minutes, net salary 18,000. */
        "sample.operations": [operation({ minutes: 1, seconds: 30, totalSeconds: 90, operatorSalary: 18000, operatorCost: 1.92 })],
        "sample.consumptionRawItems": [],
        "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* ── AND THE LABOUR METHODOLOGY IS THE BOARD'S NOW ────────────────
       How much of a paid month is productive, the employer burden, and where
       machine cost sits were fields on the costing policy and are an approved
       Board methodology. `getPolicy` no longer reads the old fields, so a
       fixture setting them leaves the rate at the sample's own legacy figure —
       which is exactly the defect these tests exist to catch. Same values,
       different record. */
    await approveLabourPolicy(w.co._id, {
      productiveMinutesPerMonth: 9000,
      employerBurdenPercent: "18",
      machineBurdenTreatment: "IN_OVERHEAD",
      ...over,
    });
    return w;
  }

  /* Prepared the way Sales does: `POST /:id/versions` was Calculate and
     refuses a browser client now. A body carrying anything BESIDES an empty
     `lines` is a payload-contract test and still goes to the retired door,
     whose refusal is the contract. */
  const save = (w) => prepareForCosting(w.costingId);

  test("the saved version uses the policy rate, not the sample's own", async () => {
    /* 18,000 x 1.18 = 21,240 employer cost.  21,240 / 9,000 = 2.36 per
       productive minute.  2.36 x 1.5 SAM = 3.54 per garment.
       The sample's figure is 18,000 / 12,480 x 1.5 = 2.16. */
    const w = await withPolicy();
    const r = await save(w);
    expect(r.status).toBe(201);

    const v = r.body.versions[0];
    const input = v.cost.inputs.find((l) => l.category === "OPERATION");
    /* The FROZEN input, not only the calculated line — the defect was that
       assembly computed 354 and `bindOperation` wrote 216 over it. */
    expect(input.unitRate.amountMinor).toBe(354);
    expect(input.unitRate.amountMinor).not.toBe(216);

    /* And the CALCULATED scenario, not only the input row. */
    const line = v.cost.scenarios[0].lines.find((l) => l.category === "OPERATION");
    expect(line.unitRateMinor).toBe(354);
    expect(line.perUnitMinor).toBe(354);
    /* 3.54 x 500 garments = 1,770.00 */
    expect(line.totalMinor).toBe(177000);
  });

  test("changing the policy changes the saved rate", async () => {
    const tight = await withPolicy({ productiveMinutesPerMonth: 7000 });
    const a = await save(tight);
    expect(a.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION").unitRate.amountMinor).toBe(455);

    const heavier = await withPolicy({ employerBurdenPercent: "35" });
    const b = await save(heavier);
    expect(b.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION").unitRate.amountMinor).toBe(405);
  });

  test("with no assumptions the sample's rate stands, and says it is legacy", async () => {
    /* Not silently presented as verified — the coverage assessment reports
       the operation family provisional and the version records which basis
       produced the number. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({ minutes: 1, seconds: 30, totalSeconds: 90, operatorSalary: 18000, operatorCost: 1.92 })],
        "sample.consumptionRawItems": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* ── AND THE GST TREATMENT IS AN APPROVED BOARD DECISION ─────────────
       It was a field on the costing policy, written straight to the
       collection here. `getPolicy` no longer reads that field, so a fixture
       setting it prices nothing — every taxable quotation is refused with
       TAX_TREATMENT_REQUIRED. The value is the same one; the record is the
       Board's. */
    await approveGstPolicy(w.co._id);

    const r = await save(w);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION").unitRate.amountMinor).toBe(192);
  });
});

/* ═══ THE OVERRIDE CONTRACT ══════════════════════════════════════════════ */

describe("a source-backed costing takes no figure from the browser", () => {
  const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

  async function assembled() {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation()],
        "sample.consumptionRawItems": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    await CostingPolicy.updateOne({ companyId: w.co._id }, {
      $set: { productiveMinutesPerMonth: 9000, employerBurdenPercent: "18",
        machineBurdenTreatment: "IN_OVERHEAD" },
    });
    return w;
  }

  /* ── THE DOOR, THEN THE PARSER, THE ASSEMBLY AND THE BINDING ──────────
     The retired route ran all four and answered from whichever saw the
     problem first. It refuses a browser client before any of them now, so
     `prepareWithLines` checks the door and then offers the lines to the three
     steps that own the rules these tests are about. */
  const post = (w, lines) => prepareWithLines(w.costingId, lines, {
    door: async () => {
      const shut = await call(`/${w.costingId}/versions`, {
        method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
        body: { lines },
      });
      expect(shut.status).toBe(409);
      expect(shut.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    },
  });

  test("a plain supplement and a declared one are both rejected", async () => {
    /* ── THE DISTINCTION THIS TEST USED TO DRAW ──────────────────────
       A plain row was refused and a DECLARED one accepted and frozen with
       its family, its reason and its author. That difference was the whole
       contract: a hand-entered figure had to say so.

       Both are refused now, and by different codes, which is the part worth
       keeping: an undeclared row is told where the fact belongs, and a
       declared one is told the declaration itself is retired. Somebody who
       had learned the old rule gets an answer aimed at what they did. */
    const w = await assembled();

    const plain = await post(w, [{
      lineKey: "cess", category: "DUTY", behaviour: "FIXED_PER_RUN", label: "Non-recoverable cess",
      amount: { amountMinor: 500000, currency: "INR" },
    }]);
    expect(plain.status).toBe(400);
    expect(plain.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    expect(plain.body.error.details.remedy).toBe("RECORD_IN_OWNING_APPLICATION");

    const declared = await post(w, [{
      lineKey: "cess", category: "DUTY", behaviour: "FIXED_PER_RUN", label: "Non-recoverable cess",
      amount: { amountMinor: 500000, currency: "INR" },
      override: { family: "duty", reason: "Broker's estimate for the imported trim" },
    }]);
    expect(declared.status).toBe(400);
    expect(declared.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    /* Duty's owning desks, since it acquired a source: Store states where the
       goods come from, the Board approves the rate. */
    expect(declared.body.error.details.owner.department).toBe("Store / Purchase and Board");
  });

  test("an `unresolvedGroup` tag is not a licence to carry money", async () => {
    /* ── THE SECOND BYPASS ────────────────────────────────────────────────
       Chunk 4B rows were let through on the strength of that tag alone. But
       the tag is a string the browser sets: it named a family and carried
       none of the contract that makes a hand-entered figure readable — no
       reason, no actor, no timestamp, and no statement of whether it
       supplements a gap or replaces an assembled line. The same manual-line
       bypass under a different field name. */
    const w = await assembled();
    const r = await post(w, [{
      lineKey: "packaging", category: "PACKAGING", behaviour: "PER_UNIT", label: "Poly bag",
      unitRate: { amountMinor: 600, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
      unresolvedGroup: "packaging",
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    /* Called out specifically — a row tagged with a family but carrying no
       reason is the case most likely to look deliberate. */
    expect(r.body.error.details.taggedWithoutOverride).toEqual(["packaging"]);
  });

  test("the same packaging cost declared as an override is refused, and sent to Store", async () => {
    /* ── AND THIS IS THE CASE THAT SHOWS WHY ─────────────────────────
       This test used to accept the row and check its attribution. But the
       figure in it — "quoted by the packaging supplier on 2 September" — is
       a real quotation somebody had in front of them and typed in. The
       refusal is not saying they are wrong about the price; it is saying the
       quotation belongs in the register, where the next costing can read it
       too and where its validity and its tier can be checked. */
    const w = await assembled();
    const r = await post(w, [{
      lineKey: "packaging", category: "PACKAGING", behaviour: "PER_UNIT", label: "Poly bag and tag",
      unitRate: { amountMinor: 600, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
      override: { family: "packaging", reason: "Quoted by the packaging supplier on 2 September" },
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");
    expect(r.body.error.details.family).toBe("packaging");
    expect(r.body.error.details.owner.department).toMatch(/Store/);
  });

  test("a plain line cannot duplicate an assembled operation", async () => {
    /* Silently carrying it would put the stitching in the costing twice. */
    const w = await assembled();
    const r = await post(w, [{
      lineKey: "op-again", category: "OPERATION", behaviour: "PER_UNIT", label: "Collar attach",
      unitRate: { amountMinor: 192, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
    }]);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("COSTING_MANUAL_LINE_REFUSED");
  });

  test("a replacement cannot displace an assembled line, named correctly or not", async () => {
    /* ── THE MOST DANGEROUS SHAPE, AND NOW THE PLAINEST REFUSAL ──────
       A replacement override stood IN PLACE OF the row the server assembled.
       Done right it kept the line count identical and changed the figure; the
       version still cited the technical record, and the total moved for a
       reason nobody reading the total could see. The old contract made it
       legible — the override had to name what it replaced, and naming a line
       the assembly never produced was refused.

       Both cases are the same refusal now, and neither reaches the assembly:
       `replacesLineKey` is rejected in the request contract whether or not
       the line it names exists. */
    const w = await assembled();
    const first = await post(w, []);
    const opKey = first.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION").lineKey;

    const real = await post(w, [{
      lineKey: "op-manual", category: "OPERATION", behaviour: "PER_UNIT", label: "Collar attach (quoted)",
      unitRate: { amountMinor: 500, currency: "INR" }, quantityPerUnit: "1", quantityUom: "pc",
      override: { family: "operations", reason: "Subcontracted at a fixed rate", replacesLineKey: opKey },
    }]);
    expect(real.status).toBe(400);
    expect(real.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");

    const invented = await post(w, [{
      lineKey: "x", category: "MISC", behaviour: "FIXED_PER_RUN", label: "Something",
      amount: { amountMinor: 100, currency: "INR" },
      override: { family: "materials", reason: "y", replacesLineKey: "op:does-not-exist" },
    }]);
    expect(invented.status).toBe(400);
    expect(invented.body.error.code).toBe("COSTING_MANUAL_INPUT_RETIRED");

    /* And the assembled operation is still there, untouched, in a version
       calculated from the sources alone. */
    const clean = await post(w, []);
    expect(clean.status).toBe(201);
    const ops = clean.body.versions[0].cost.inputs.filter((l) => l.category === "OPERATION");
    expect(ops).toHaveLength(1);
    expect(ops[0].lineKey).toBe(opKey);
  });
});

/* ═══ CHOOSING BETWEEN QUOTATIONS ════════════════════════════════════════ */

describe("more than one applicable quotation", () => {
  const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
  const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
  const Vendor = require("../../models/CMS_Models/Inventory/Vendor-Buyer/Vendor");

  async function twoQuotes() {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.consumptionRawItems": [consumed(w.fabric)],
        "sample.operations": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* ── AND THE GST TREATMENT IS AN APPROVED BOARD DECISION ─────────────
       It was a field on the costing policy, written straight to the
       collection here. `getPolicy` no longer reads that field, so a fixture
       setting it prices nothing — every taxable quotation is refused with
       TAX_TREATMENT_REQUIRED. The value is the same one; the record is the
       Board's. */
    await approveGstPolicy(w.co._id);

    const made = [];
    for (const [name, price] of [["Mill A", 41250], ["Mill B", 39900]]) {
      const v = await Vendor.create({
        companyId: w.co._id, companyName: name, vendorType: "Supplier", status: "Active",
      });
      made.push(await SupplierOffer.create({
        companyId: w.co._id, supplierId: v._id, supplierName: name,
        itemId: w.fabric._id, purchaseUom: "Metre", currency: "INR",
        unitPriceMinor: price, priceBasis: "TAX_EXCLUSIVE", gstRatePercent: 12,
        freightTerms: "INCLUSIVE_LANDED",
        quotationReference: `Q-${name.replace(/\s/g, "")}`,
        /* Two competing Indian mills — this test is about which one is
           chosen, so both state their sourcing. */
        sourcing: { type: "DOMESTIC" },
        status: "ACTIVE", effectiveFrom: new Date("2026-01-01"),
      }));
    }
    return { w, offers: made };
  }

  /* Prepared the way Sales does: `POST /:id/versions` was Calculate and
     refuses a browser client now. A body carrying anything BESIDES an empty
     `lines` is a payload-contract test and still goes to the retired door,
     whose refusal is the contract. */
  const save = (w, body = {}) => (Object.keys(body).length
    ? call(`/${w.costingId}/versions`, {
      method: "POST", token: w.me.token, company: w.co._id, idempotencyKey: newKey(),
      body: { lines: [], ...body },
    })
    : prepareForCosting(w.costingId));

  test("two applicable quotations block, and the block carries the choice", async () => {
    /* A blocking state with nothing to act on is a dead end — it is what sent
       people to the ad-hoc editor to type a rate by hand. */
    const { w } = await twoQuotes();
    const r = await call(`/${w.costingId}/technical-preview?styleId=${w.style._id}`,
      { token: w.me.token, company: w.co._id });
    expect(r.status).toBe(200);

    const gap = r.body.missing.find((m) => String(m.key).startsWith("quotation:"));
    expect(gap.blocking).toBe(true);
    expect(gap.owner.department).toBe("Store");
    expect(gap.candidates).toHaveLength(2);
    /* Enough to decide on, and nothing sensitive beyond the cost boundary
       this endpoint already gates. */
    for (const c of gap.candidates) {
      expect(c.offerId).toBeTruthy();
      expect(c.supplierName).toBeTruthy();
      expect(c.quotationReference).toBeTruthy();
      expect(c.purchaseUom).toBe("Metre");
    }
    /* And it names the line the decision belongs to. */
    expect(gap.lineKey).toMatch(/^mat:/);
  });

  test("the cheapest is never chosen automatically", async () => {
    const { w } = await twoQuotes();
    /* Saving without a decision is refused rather than settled by price:
       lead time, terms and quality history all bear on it and none is in a
       rate. */
    const r = await save(w);
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await CostingVersion.countDocuments({ costingId: w.costingId, versionNumber: 2 })).toBe(0);

    /* ── WHAT "NOT CHOSEN" MEANS NOW ──────────────────────────────────────
       This used to assert the cheaper rate did not appear anywhere in the
       response, which was a proxy for "nothing was picked" back when the
       refusal carried no candidates at all. The refusal offers the decision
       now — both quotations, with everything the picker renders — so the
       claim has to be made directly: both are present, in supplier order
       rather than price order, and neither is marked as selected. */
    const candidates = r.body.error.details.candidates;
    expect(candidates.map((c) => c.supplierName)).toEqual(["Mill A", "Mill B"]);
    expect(candidates.map((c) => c.appliedUnitPriceMinor)).toEqual([41250, 39900]);
    expect(candidates.some((c) => c.selected)).toBe(false);
    expect(r.body.error.details.chosenOfferId).toBeUndefined();
  });

  test("the calculation cannot carry the choice — it is Store's to record", async () => {
    /* ── WHERE THIS DECISION WENT ──────────────────────────────────────
       The payload used to carry `quotationChoices`, and this test proved the
       named quotation was honoured rather than the cheapest being quietly
       substituted — the DEARER one, deliberately.

       That claim still holds and is proved where the decision now lives:
       `sourcing-decisions.route.test.js` records the dearer quotation through
       Store and asserts the frozen provenance names it. What this asserts is
       the other half — that the costing will not take the decision from a
       request. */
    const { w, offers } = await twoQuotes();
    const preview = await call(`/${w.costingId}/technical-preview?styleId=${w.style._id}`,
      { token: w.me.token, company: w.co._id });
    const gap = preview.body.missing.find((m) => String(m.key).startsWith("quotation:"));

    const dearer = offers.find((o) => o.unitPriceMinor === 41250);
    const r = await save(w, { quotationChoices: { [gap.lineKey]: String(dearer._id) } });
    /* ── AND REFUSED ONE STEP EARLIER NOW ─────────────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser's own refusal, which names Store, is asserted
       directly — the rule keeps a test even with no route that can carry a
       choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try { refuseQuotationChoices({ quotationChoices: { [gap.lineKey]: String(dearer._id) } }); } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");
    expect(told.details.owner.department).toBe("Store");
  });

  test("a choice that no longer applies is refused, not honoured", async () => {
    const { w, offers } = await twoQuotes();
    const preview = await call(`/${w.costingId}/technical-preview?styleId=${w.style._id}`,
      { token: w.me.token, company: w.co._id });
    const gap = preview.body.missing.find((m) => String(m.key).startsWith("quotation:"));

    /* Withdrawn between the choice and the save. */
    const { beginOfferLifecycle } = SupplierOffer;
    const doc = await SupplierOffer.findById(offers[0]._id);
    doc.status = "WITHDRAWN";
    doc.withdrawnAt = new Date();
    doc.withdrawalReason = "Pulled.";
    await beginOfferLifecycle(doc, "WITHDRAW").save();

    /* Refused for TWO reasons now, and the payload one comes first: a
       calculation may not carry a choice at all. That the withdrawn quotation
       would also have been refused on its merits is asserted against Store's
       own path, where the decision is actually made. */
    const r = await save(w, { quotationChoices: { [gap.lineKey]: String(offers[0]._id) } });
    /* ── AND REFUSED ONE STEP EARLIER NOW ─────────────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser's own refusal, which names Store, is asserted
       directly — the rule keeps a test even with no route that can carry a
       choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try { refuseQuotationChoices({ quotationChoices: { [gap.lineKey]: String(offers[0]._id) } }); } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");

  });

  test("a foreign quotation cannot be chosen", async () => {
    const { w, offers } = await twoQuotes();
    const theirs = await twoQuotes();
    const preview = await call(`/${w.costingId}/technical-preview?styleId=${w.style._id}`,
      { token: w.me.token, company: w.co._id });
    const gap = preview.body.missing.find((m) => String(m.key).startsWith("quotation:"));

    const r = await save(w, { quotationChoices: { [gap.lineKey]: String(theirs.offers[0]._id) } });
    /* ── AND REFUSED ONE STEP EARLIER NOW ─────────────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser's own refusal, which names Store, is asserted
       directly — the rule keeps a test even with no route that can carry a
       choice to it. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { refuseQuotationChoices } = require("../../services/centralCosting/calculationInput");
    let told = null;
    try { refuseQuotationChoices({ quotationChoices: { [gap.lineKey]: String(theirs.offers[0]._id) } }); } catch (err) { told = err; }
    expect(told.code).toBe("COSTING_QUOTATION_CHOICE_MOVED");

    /* Company isolation on a chosen quotation is proved where choosing
       happens — see `sourcing-decisions.route.test.js`, which refuses a
       foreign offer with `SOURCING_DECISION_OFFER_NOT_APPLICABLE`. */
    expect(offers.length).toBe(2);
  });
});

/* ═══ NO LEGACY RATE, AND STILL COSTED ═══════════════════════════════════ */

describe("an operation with no legacy operatorCost", () => {
  const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

  test("the policy calculation stands on its own", async () => {
    /* SAM 1.5 and salary 18,000 on the record; the sample's own derived
       figure absent entirely. The old code refused the line for want of a
       field the policy calculation does not use. */
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({
          minutes: 1, seconds: 30, totalSeconds: 90,
          operatorSalary: 18000, operatorCost: null,
        })],
        "sample.consumptionRawItems": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* The Board's methodology, same values. See `withPolicy` above. */
    await approveLabourPolicy(w.co._id);

    /* Prepared the way Sales does: the retired route refuses a browser
       client, and this asks for nothing the orchestration does not resolve. */
    const r = await prepareForCosting(w.costingId);
    expect(r.status).toBe(201);

    const input = r.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION");
    /* 18,000 x 1.18 = 21,240;  / 9,000 = 2.36/min;  x 1.5 SAM = 3.54. */
    expect(input.unitRate.amountMinor).toBe(354);
    const line = r.body.versions[0].cost.scenarios[0].lines.find((l) => l.category === "OPERATION");
    expect(line.unitRateMinor).toBe(354);
  });

  test("with no policy and no legacy rate, the refusal names the missing input", async () => {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({ operatorSalary: 18000, operatorCost: null })],
        "sample.consumptionRawItems": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* ── AND THE GST TREATMENT IS AN APPROVED BOARD DECISION ─────────────
       It was a field on the costing policy, written straight to the
       collection here. `getPolicy` no longer reads that field, so a fixture
       setting it prices nothing — every taxable quotation is refused with
       TAX_TREATMENT_REQUIRED. The value is the same one; the record is the
       Board's. */
    await approveGstPolicy(w.co._id);

    /* Prepared the way Sales does: the retired route refuses a browser
       client, and this asks for nothing the orchestration does not resolve. */
    const r = await prepareForCosting(w.costingId);
    expect(r.status).toBeGreaterThanOrEqual(400);
    /* Which assumption, not "cannot be costed" — the fix is a policy edit and
       the person needs to know which field. */
    expect(r.body.error.details.reason).toBe("PRODUCTION_ASSUMPTIONS_NOT_CONFIGURED");
  });
});

/* ═══ WHAT THE SCREEN SHOWS IS WHAT THE VERSION FREEZES ══════════════════ */

describe("the assembled presentation contract", () => {
  const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");

  async function ready({ policy = {} } = {}) {
    const w = await world({});
    await SampleStyle.updateOne({ _id: w.style._id }, {
      $set: {
        "sample.operations": [operation({
          minutes: 1, seconds: 30, totalSeconds: 90, operatorSalary: 18000, operatorCost: 1.92,
        })],
        "sample.consumptionRawItems": [], "materials.rawItems": [],
        "sample.status": "approved", "sample.approvedAt": new Date("2026-08-01"),
        "bomApproval.status": "approved", "bomApproval.round": 2,
      },
    });
    /* The labour methodology is the Board's; the rest of `policy` — the
       margins, the currency, the rounding — is still the company's. */
    const { productiveMinutesPerMonth, employerBurdenPercent, machineBurdenTreatment, ...rest } = policy;
    if (productiveMinutesPerMonth || employerBurdenPercent || machineBurdenTreatment) {
      await approveLabourPolicy(w.co._id, {
        productiveMinutesPerMonth, employerBurdenPercent, machineBurdenTreatment,
      });
    }
    if (Object.keys(rest).length) {
      await CostingPolicy.updateOne({ companyId: w.co._id }, { $set: { ...rest } });
    }
    return w;
  }

  const CONFIGURED = {
    productiveMinutesPerMonth: 9000,
    employerBurdenPercent: "18",
    machineBurdenTreatment: "IN_OVERHEAD",
  };

  const view = (w) => call(`/${w.costingId}/technical-preview?styleId=${w.style._id}`,
    { token: w.me.token, company: w.co._id });

  /* Prepared the way Sales does: `POST /:id/versions` was Calculate and
     refuses a browser client now. A body carrying anything BESIDES an empty
     `lines` is a payload-contract test and still goes to the retired door,
     whose refusal is the contract. */
  const save = (w) => prepareForCosting(w.costingId);

  test("THE INVARIANT: the displayed rate is the rate that gets frozen", async () => {
    /* ── THE MISMATCH THIS PINS ────────────────────────────────────────────
       The preview returned the RAW sample facts and dropped the assembled
       rows, so the screen read `operatorCost` — the legacy
       `salary / 12,480 x SAM` — and showed ₹2.16 as verified while version
       creation froze the policy-derived ₹3.54. Two numbers for one operation,
       one on screen and one in the record, and nothing said they differed. */
    const w = await ready({ policy: CONFIGURED });

    const shown = await view(w);
    expect(shown.status).toBe(200);
    const op = shown.body.assembly.rows.operations[0];
    expect(op.rateMinor).toBe(354);
    expect(op.rateBasis).toBe("COMPANY_POLICY");
    expect(op.state).toBe("VERIFIED");
    /* The legacy figure is returned so a reader can SEE the two differ — it is
       never the displayed rate. */
    expect(op.legacyRateMinor).toBe(192);

    const saved = await save(w);
    expect(saved.status).toBe(201);
    const frozen = saved.body.versions[0].cost.inputs.find((l) => l.category === "OPERATION");

    /* The invariant, asserted directly. */
    expect(op.rateMinor).toBe(frozen.unitRate.amountMinor);
    expect(frozen.unitRate.amountMinor).toBe(354);
  });

  test("the legacy rate is never labelled verified", async () => {
    /* With no assumptions configured the sample's own figure stands — and the
       row says PROVISIONAL and why, rather than presenting a number that will
       change the moment Finance fills the policy in. */
    const w = await ready();
    const op = (await view(w)).body.assembly.rows.operations[0];
    expect(op.rateMinor).toBe(192);
    expect(op.rateBasis).toBe("LEGACY_SAMPLE_RATE");
    expect(op.state).toBe("PROVISIONAL");
    expect(op.note).toMatch(/production assumptions are not configured/i);
  });

  test("the contract carries every part the screen needs", async () => {
    const w = await ready({ policy: CONFIGURED });
    const a = (await view(w)).body.assembly;

    expect(a.state).toBe("ASSEMBLED");
    expect(a.styleId).toBe(String(w.style._id));
    expect(a.style).toBeTruthy();
    expect(Array.isArray(a.rows.materials)).toBe(true);
    expect(Array.isArray(a.rows.operations)).toBe(true);
    expect(Array.isArray(a.quotationDecisions)).toBe(true);
    expect(Array.isArray(a.missing)).toBe(true);
    expect(a.productionAssumptions.configured).toBe(true);
    expect(a.coverage).toBeTruthy();
    expect(a.policy.rules.length).toBeGreaterThan(0);

    /* Every operation row carries its workings, so the number can be checked
       rather than believed. */
    const op = a.rows.operations[0];
    expect(op.workings).toMatchObject({
      samMinutes: "1.5", netSalaryPerMonth: "18000",
      employerBurdenPercent: "18", costPerMinute: "2.360000",
    });
    expect(op.owner).toBe("Production");
  });

  test("the payload that calculates carries decisions, not generated rows", async () => {
    /* The whole point: the browser sends what a person decided. Zero lines,
       and the version still contains the assembled operation. */
    const w = await ready({ policy: CONFIGURED });
    const saved = await save(w);
    expect(saved.status).toBe(201);
    expect(saved.body.versions[0].cost.inputs.some((l) => l.category === "OPERATION")).toBe(true);
  });
});
