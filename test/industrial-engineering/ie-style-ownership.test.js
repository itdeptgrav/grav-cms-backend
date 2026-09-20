// test/industrial-engineering/ie-style-ownership.test.js
//
// THE STYLE OWNERSHIP RULE — STATED ONCE, PROVED TWO WAYS.
//
// `styleOwnershipClause` states the rule as a QUERY and `styleOwnerFrom` states
// the same rule ROW-WISE. The Chunk 1C audit used an approximate copy of the
// second and got a different answer from the endpoint — it fell back to an
// enquiry when a journey was named but unprovable, and it ignored `isActive`
// and the terminal statuses entirely.
//
// So the two are asserted here against each other over a fixture set covering
// every branch: the query is run, the predicate is run over every style in the
// collection, and the two id sets must be identical. A drift between them
// cannot survive this test.
"use strict";
process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const {
  styleOwnershipClause, styleOwnerFrom,
} = require("../../services/companyContext/merchandisingScope.service");

let seq = 0;

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});

const journey = (co) => SalesJourney.create({
  journeyId: `SJ-OWN-${++seq}`, ...(co ? { companyId: co._id } : {}),
  accountId: new mongoose.Types.ObjectId(), ownerId: new mongoose.Types.ObjectId(),
  ownerName: "Owner", name: "J", isActive: true,
});

/* `Enquiry.journeyId` is schema-required, so one is supplied. It is the
   ENQUIRY's own parent and is irrelevant here — what these tests turn on is the
   journey the STYLE names, or does not. */
const enquiry = (co) => Enquiry.create({
  enquiryId: `ENQ-OWN-${++seq}`, ...(co ? { companyId: co._id } : {}),
  journeyId: new mongoose.Types.ObjectId(),
  accountId: new mongoose.Types.ObjectId(), title: "E", isActive: true,
  products: [{ product: "Tee", quantity: 1 }],
});

const style = (label, fields = {}) => SampleStyle.create({
  sampleStyleId: `SS-OWN-${++seq}`, productName: `Tee ${label}`, styleCode: `ST-${label}`,
  materials: { status: "pending", rawItems: [] },
  techSheet: { technical: { status: "draft" } },
  ...fields,
});

/** The predicate, run against the collection exactly as a caller would. */
async function ownerOfEveryStyle() {
  const styles = await SampleStyle.find({}).select("_id journeyId enquiryId isActive status").lean();
  const [journeys, enquiries] = await Promise.all([
    SalesJourney.find({}).select("_id companyId").lean(),
    Enquiry.find({}).select("_id companyId").lean(),
  ]);
  const jc = new Map(journeys.map((j) => [String(j._id), j.companyId ? String(j.companyId) : ""]));
  const ec = new Map(enquiries.map((e) => [String(e._id), e.companyId ? String(e.companyId) : ""]));
  return new Map(styles.map((s) => [String(s._id), styleOwnerFrom(s, {
    journeyCompanyOf: (id) => jc.get(id) || null,
    enquiryCompanyOf: (id) => ec.get(id) || null,
  })]));
}

/** The ids the QUERY says belong to this company. */
async function clauseIdsFor(co) {
  const clause = await styleOwnershipClause(co._id);
  if (!clause) return new Set();
  const rows = await SampleStyle.find(clause).select("_id").lean();
  return new Set(rows.map((r) => String(r._id)));
}

/** The ids the PREDICATE says belong to this company. */
async function predicateIdsFor(co) {
  const owners = await ownerOfEveryStyle();
  return new Set([...owners.entries()]
    .filter(([, v]) => v.companyId === String(co._id))
    .map(([id]) => id));
}

describe("eligibility — the two clauses the query carries at its top level", () => {
  test("an inactive style is not eligible", async () => {
    const co = await company("Inactive");
    const j = await journey(co);
    const s = await style("Inactive", { journeyId: j._id, isActive: false });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({ eligible: false, reason: "NOT_ACTIVE" });
    expect(await clauseIdsFor(co)).toEqual(new Set());
    expect(await predicateIdsFor(co)).toEqual(new Set());
  });

  test("a completed style is not eligible", async () => {
    const co = await company("Completed");
    const j = await journey(co);
    const s = await style("Completed", { journeyId: j._id, status: "completed" });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({ eligible: false, reason: "TERMINAL_STATUS" });
    expect(await clauseIdsFor(co)).toEqual(new Set());
  });

  test("a cancelled style is not eligible", async () => {
    const co = await company("Cancelled");
    const j = await journey(co);
    const s = await style("Cancelled", { journeyId: j._id, status: "cancelled" });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({ eligible: false, reason: "TERMINAL_STATUS" });
    expect(await clauseIdsFor(co)).toEqual(new Set());
  });
});

describe("attribution — the journey is authoritative when named", () => {
  test("a style with a company journey belongs to that company", async () => {
    const co = await company("Owned");
    const j = await journey(co);
    const s = await style("Owned", { journeyId: j._id });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({
      eligible: true, companyId: String(co._id), reason: "SALES_JOURNEY",
    });
    expect(await clauseIdsFor(co)).toEqual(new Set([String(s._id)]));
  });

  test("a house style with no journey is attributed by its enquiry", async () => {
    const co = await company("House");
    const e = await enquiry(co);
    const s = await style("House", { enquiryId: e._id });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({
      eligible: true, companyId: String(co._id), reason: "ENQUIRY",
    });
    expect(await clauseIdsFor(co)).toEqual(new Set([String(s._id)]));
  });

  test("a MISSING journey plus a company enquiry is unprovable — no fallback", async () => {
    /* The bug the audit had. A style that NAMES a journey is matched by the
       journey branch or by nothing: the enquiry branch carries
       `journeyId: {$in:[null]}` precisely so this cannot fall through. */
    const co = await company("DanglingJourney");
    const e = await enquiry(co);
    const s = await style("DanglingJourney", {
      journeyId: new mongoose.Types.ObjectId(), enquiryId: e._id,
    });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({
      eligible: false, companyId: null, reason: "JOURNEY_UNPROVABLE",
    });
    expect(await clauseIdsFor(co)).toEqual(new Set());
    expect(await predicateIdsFor(co)).toEqual(new Set());
  });

  test("a journey with NO company plus a company enquiry is unprovable — no fallback", async () => {
    const co = await company("UnownedJourney");
    const j = await journey(null);
    const e = await enquiry(co);
    const s = await style("UnownedJourney", { journeyId: j._id, enquiryId: e._id });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({
      eligible: false, companyId: null, reason: "JOURNEY_UNPROVABLE",
    });
    expect(await clauseIdsFor(co)).toEqual(new Set());
  });

  test("journey and enquiry naming different companies — the journey wins", async () => {
    const owner = await company("JourneyOwner");
    const other = await company("EnquiryOther");
    const j = await journey(owner);
    const e = await enquiry(other);
    const s = await style("Split", { journeyId: j._id, enquiryId: e._id });

    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({
      eligible: true, companyId: String(owner._id), reason: "SALES_JOURNEY",
    });
    expect(await clauseIdsFor(owner)).toEqual(new Set([String(s._id)]));
    /* And the enquiry's company gets nothing — it is not a second claim. */
    expect(await clauseIdsFor(other)).toEqual(new Set());
  });

  test("a style with no parent at all is unprovable", async () => {
    const co = await company("Orphan");
    await journey(co);
    const s = await style("Orphan");
    const owners = await ownerOfEveryStyle();
    expect(owners.get(String(s._id))).toMatchObject({ eligible: false, reason: "NO_PARENT" });
  });
});

describe("the query and the row-wise rule are the same rule", () => {
  test("over every branch at once, the two id sets are identical", async () => {
    /* One collection holding every shape above, then both implementations run
       across it. This is the guarantee that stops a third approximate copy
       from being written the next time somebody needs a row-wise answer. */
    const co = await company("Equiv");
    const other = await company("EquivOther");
    const jOwned = await journey(co);
    const jUnowned = await journey(null);
    const jOther = await journey(other);
    const eOwned = await enquiry(co);

    await style("EqActive", { journeyId: jOwned._id });
    await style("EqInactive", { journeyId: jOwned._id, isActive: false });
    await style("EqCompleted", { journeyId: jOwned._id, status: "completed" });
    await style("EqCancelled", { journeyId: jOwned._id, status: "cancelled" });
    await style("EqHouse", { enquiryId: eOwned._id });
    await style("EqDangling", { journeyId: new mongoose.Types.ObjectId(), enquiryId: eOwned._id });
    await style("EqUnowned", { journeyId: jUnowned._id, enquiryId: eOwned._id });
    await style("EqForeign", { journeyId: jOther._id, enquiryId: eOwned._id });
    await style("EqOrphan");

    for (const target of [co, other]) {
      const fromQuery = await clauseIdsFor(target);
      const fromPredicate = await predicateIdsFor(target);
      expect([...fromPredicate].sort()).toEqual([...fromQuery].sort());
    }

    /* And the shapes that must be excluded really are — a test that passed
       because both sides were empty would prove nothing. */
    expect((await clauseIdsFor(co)).size).toBe(2);
  });
});
