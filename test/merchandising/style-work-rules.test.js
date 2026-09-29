// test/merchandising/style-work-rules.test.js
//
// THE WORK RULES HAVE TWO FORMS, AND THEY MUST STAY ONE RULE.
//
// A queue that is sorted and paged by the database has to state its conditions
// as a QUERY. The same conditions also have to LABEL a row once it comes back,
// and that is a function. Two statements of one rule is how a dashboard number
// and the list behind it start disagreeing — the count says four, the list
// shows three, and nobody can tell which is wrong.
//
// So the development rule is written once in
// `styleDevelopment.developmentGaps` and mirrored as a Mongo predicate in
// `styleWork.developmentGapPredicate`, and this walks a matrix of stored rows
// through BOTH — the real database for the query, the real function for the
// label — and asserts they give the same answer every time.
"use strict";

const { readFileSync } = require("fs");
const { join } = require("path");

const mongoose = require("mongoose");

const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const styleDevelopment = require("../../services/merchandising/styleDevelopment.service");
const styleWork = require("../../services/merchandising/styleWork.service");

/** The charge table a company publishes: a key, a label, a method, a unit. No amount. */
const charges = new Map([
  ["pattern-development", {
    key: "pattern-development", label: "Pattern development",
    calculation: "FLAT_PER_RUN", unit: null,
  }],
  ["screen-making", {
    key: "screen-making", label: "Screen making",
    calculation: "PER_REQUIREMENT_UNIT", unit: "Screen",
  }],
]);

const serviceId = new mongoose.Types.ObjectId();

/**
 * Every shape a stored `DEVELOPMENT_TOOLING` row can take that the rule has an
 * opinion about — the complete ones and each way of being incomplete.
 */
const ROWS = [
  ["complete, in-house, flat charge",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development" }],
  ["complete, in-house, per-unit charge with a count",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 4 }],
  ["complete, bought outside",
    { developmentSource: "SUPPLIER_QUOTATION", serviceId, serviceName: "Screen printing" }],
  ["excluded, with a reason",
    { included: false, excludedReason: "This style is unbranded." }],

  ["excluded, and nobody said why", { included: false }],
  ["excluded, with an empty reason", { included: false, excludedReason: "" }],
  ["nobody said whether it is bought or made", {}],
  ["bought outside, naming no service", { developmentSource: "SUPPLIER_QUOTATION" }],
  ["in-house, naming no charge", { developmentSource: "COMPANY_POLICY" }],
  ["in-house, naming an empty charge",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "" }],
  ["in-house, naming a charge the company retired",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "gone-away" }],
  ["per-unit charge with no count",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making" }],
  ["per-unit charge with a zero count",
    { developmentSource: "COMPANY_POLICY", developmentChargeKey: "screen-making", quantity: 0 }],
];

/**
 * The stage matters now: an EMPTY Development section counts as unanswered,
 * and only on a style Merchandising has actually been handed. Every matrix row
 * below holds a requirement, so the empty branch is not what they exercise —
 * but they are stored at `materials` so that branch is live rather than
 * switched off by the fixture.
 */
const store = (rows, extra = {}) => SampleStyle.create({
  sampleStyleId: `SS-RULE-${Math.random().toString(36).slice(2, 10)}`,
  productName: "Rule tee",
  journeyId: new mongoose.Types.ObjectId(),
  stage: "materials",
  sample: { serviceRequirements: rows },
  ...extra,
});

describe("one rule, two forms", () => {
  test.each(ROWS)("%s — the query and the function agree", async (_name, fields) => {
    const stored = { rowId: "r1", purpose: styleDevelopment.PURPOSE, ...fields };
    const style = await store([stored]);

    /* What the FUNCTION says, from the same row the database holds — read
       back rather than reused, so a schema default cannot make the two
       disagree about what was actually stored. */
    const saved = await SampleStyle.findById(style._id).lean();
    const view = styleDevelopment.developmentRow(saved.sample.serviceRequirements[0]);
    const hasGap = styleDevelopment.developmentGaps(view, { charges }).length > 0;

    /* And what the SERVICE says, through the same derivation the queue uses. */
    const state = styleWork.developmentState(saved, { charges });
    expect(state.gapped > 0).toBe(hasGap);
    expect(state.unanswered).toBe(false);          // a row exists, so it is answered

    /* What the QUERY says, run against the real database. */
    const matched = await SampleStyle.countDocuments({
      _id: style._id,
      ...styleWork.developmentGapPredicate(charges),
    });

    expect(Boolean(matched)).toBe(hasGap);
  });

  /* ── AND THE SAME AGREEMENT FOR SILENCE ─────────────────────────────────
     An empty section is the one case where the two forms could most easily
     drift, because one is an `$elemMatch` negation and the other is an array
     length. Each stage is checked in both directions. */
  test.each([
    ["no requirements at all, at materials", [], "materials", true],
    ["no requirements at all, at rnd", [], "rnd", true],
    ["no requirements at all, at brief", [], "brief", false],
    ["only Production's outside process, at materials",
      [{ rowId: "p1", purpose: "OUTSIDE_PROCESS", serviceId: new mongoose.Types.ObjectId() }],
      "materials", true],
    ["an explicit not-applicable with its reason, at materials",
      [{ rowId: "d1", purpose: "DEVELOPMENT_TOOLING", included: false, excludedReason: "Unbranded." }],
      "materials", false],
  ])("%s", async (_name, rows, stage, expected) => {
    const style = await store(rows, { stage });
    const saved = await SampleStyle.findById(style._id).lean();

    const state = styleWork.developmentState(saved, { charges });
    expect(state.unanswered || state.gapped > 0).toBe(expected);

    const matched = await SampleStyle.countDocuments({
      _id: style._id,
      ...styleWork.developmentGapPredicate(charges),
    });
    expect(Boolean(matched)).toBe(expected);
  });

  test("with no charges configured at all, every in-house key is unknown", async () => {
    const none = new Map();
    const style = await SampleStyle.create({
      sampleStyleId: `SS-RULE-EMPTY-${Math.random().toString(36).slice(2, 10)}`,
      productName: "Rule tee",
      journeyId: new mongoose.Types.ObjectId(),
      sample: {
        serviceRequirements: [{
          rowId: "r1", purpose: styleDevelopment.PURPOSE,
          developmentSource: "COMPANY_POLICY", developmentChargeKey: "pattern-development",
        }],
      },
    });
    const saved = await SampleStyle.findById(style._id).lean();
    const view = styleDevelopment.developmentRow(saved.sample.serviceRequirements[0]);
    expect(styleDevelopment.developmentGaps(view, { charges: none }).length).toBeGreaterThan(0);
    expect(await SampleStyle.countDocuments({
      _id: style._id, ...styleWork.developmentGapPredicate(none),
    })).toBe(1);
  });
});

describe("the cursor", () => {
  test("round-trips a row's position, and refuses anything it did not issue", () => {
    const at = new Date("2026-09-07T10:11:12.000Z");
    const id = new mongoose.Types.ObjectId();
    const cursor = styleWork.encodeCursor({ updatedAt: at, _id: id });
    const back = styleWork.decodeCursor(cursor);
    expect(back.updatedAt.getTime()).toBe(at.getTime());
    expect(String(back.id)).toBe(String(id));

    for (const bad of ["nonsense", "!!!!", Buffer.from("abc.def").toString("base64url")]) {
      expect(() => styleWork.decodeCursor(bad)).toThrow(/page marker/);
    }
    /* An absent cursor is page one, which is not an error. */
    expect(styleWork.decodeCursor(undefined)).toBe(null);
    expect(styleWork.decodeCursor("")).toBe(null);
  });
});

describe("the projection", () => {
  const fields = styleWork.PROJECTION.split(/\s+/).filter(Boolean);

  test("it never asks for a whole subdocument array", () => {
    /* `sample.serviceRequirements` used to be taken wholesale to answer one
       question about completeness, dragging every requirement's specification,
       notes, billing unit, basis, evidence and owner into memory — Production's
       outside processes included. An allowlisted response built out of a
       wholesale read is one careless spread away from not being allowlisted. */
    for (const whole of [
      "sample.serviceRequirements",
      "sample",
      "materials",
      "materials.packagingSelections",
      "materialsChangeLog",
      "techSheet",
      "techSheet.technical",
      "techSheet.technical.materials",
      "bomApproval",
    ]) {
      expect(fields).not.toContain(whole);
    }
  });

  test("it asks for exactly the seven requirement fields the gap rule decides on", () => {
    const asked = fields
      .filter((f) => f.startsWith("sample.serviceRequirements."))
      .map((f) => f.replace("sample.serviceRequirements.", ""))
      .sort();
    expect(asked).toEqual([
      "developmentChargeKey", "developmentSource", "excludedReason",
      "included", "purpose", "quantity", "serviceId",
    ]);
  });

  test("it reads no other department's fact, at any depth", () => {
    /* The R&D measurement, its evidence, the packaging instruction, the
       supplier and the Journey all sit on the same document. None of them is
       needed to say what is outstanding, so none of them is loaded. */
    for (const banned of [
      /journeyId/, /enquiryId/, /accountId/, /consumption/i, /evidence/i,
      /allowance/i, /specification/i, /\bnotes\b/, /rawItemId/, /rawItemSku/,
      /billingUnit/, /\bbasis\b/, /\bowner\b/i, /serviceName/, /serviceCode/,
      /techSheet\.technical\.(status|revision|requirements|operations)/,
      /sample\.(rounds|shipment|packagingRequirements|consumptionRawItems|operations)/,
      /\bbrief\./, /variantKey/, /customer/i, /token/,
    ]) {
      expect(styleWork.PROJECTION).not.toMatch(banned);
    }
  });

  test("every field it does ask for is one the derivation or the allowlist needs", () => {
    expect(fields.sort()).toEqual([
      /* The allowlisted row identity. */
      "_id", "productName", "sampleStyleId", "styleCode", "updatedAt", "variantLabel",
      /* Whose desk the style is on. */
      "stage",
      /* The four work rules, and nothing beside them. */
      "bomApproval.note", "bomApproval.status",
      "materials.packagingSelections.status", "materials.status",
      "materialsChangeLog.status",
      "sample.serviceRequirements.developmentChargeKey",
      "sample.serviceRequirements.developmentSource",
      "sample.serviceRequirements.excludedReason",
      "sample.serviceRequirements.included",
      "sample.serviceRequirements.purpose",
      "sample.serviceRequirements.quantity",
      "sample.serviceRequirements.serviceId",
    ].sort());
  });
});

describe("the company bound", () => {
  const source = readFileSync(
    join(__dirname, "..", "..", "services", "companyContext", "merchandisingScope.service.js"),
    "utf8",
  );
  /* Prose explains why the unbounded query was removed; a raw scan would flag
     the explanation as the offence. */
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  test("every parent read carries the company clause", () => {
    const reads = code.match(/(SalesJourney|Enquiry)\.find\([^)]*\)/g) || [];
    expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(read).toMatch(/companyClause/);
  });

  test("no read enumerates unstamped parents across the whole database", () => {
    /* ── SCANNED WHERE THE READS ARE, NOT ACROSS THE FILE ────────────────
       The bound itself is what must never enumerate unstamped parents. The
       rest of the file builds the request's company SCOPE, and the legacy
       allowance it carries — `{companyId: null}` `$or`-ed with the actor's own
       company, the same allowance `salesScope` has always applied — is a
       filter fragment for other models, not a read. Scanning the whole file
       for the text would flag that as the offence it is not. */
    const start = code.indexOf("async function styleOwnershipClause");
    expect(start).toBeGreaterThan(-1);
    const bound = code.slice(start, code.indexOf("\nmodule.exports", start));

    /* The specific query this correction removed, and the shapes it could come
       back as. Enumerating every journey with no company grows with the
       DEPLOYMENT rather than with the caller's company. */
    expect(bound).not.toMatch(/companyId:\s*\{\s*\$in:\s*\[\s*null/);
    expect(bound).not.toMatch(/companyId:\s*null/);
    expect(bound).not.toMatch(/companyId:\s*\{\s*\$exists/);
    expect(bound).not.toMatch(/\.find\(\{\s*\}\)/);
  });

  test("the acting company only ever SELECTS among proven memberships", () => {
    /* The Merchandising screens carry a company across the whole journey. The
       header names one; it never authorises one, and it is never taken from a
       body or from the record being asked for. */
    expect(code).toMatch(/resolveCompanyForActor\(req\.user, \{\s*\n?\s*requestedCompanyId,/);
    expect(code).not.toMatch(/req\.body/);
    /* And with nothing named, it is the Sales scope itself — not a lookalike. */
    expect(code).toMatch(/const scope = await salesScope\.scopeFor\(req, \{ domainLabel \}\)/);
  });

  test("the queue reaches SampleStyle only through this bound", () => {
    const work = readFileSync(
      join(__dirname, "..", "..", "services", "merchandising", "styleWork.service.js"), "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");
    /* Every style query names the bound, so a count or a page cannot be run
       against the collection unscoped. */
    const queries = work.match(/SampleStyle\(\)\.(find|countDocuments)\(/g) || [];
    expect(queries.length).toBeGreaterThan(0);
    expect(work).toMatch(/styleOwnershipClause\(ctx\.companyId\)/);
    /* And no per-result ownership proof — that would be the N+1 this bound
       exists to replace. */
    expect(work).not.toMatch(/ownershipProofFor/);
  });
});

describe("the search term", () => {
  test("is escaped, so a regular expression cannot be smuggled through it", () => {
    expect(styleWork.searchClause("")).toBe(null);
    const clause = styleWork.searchClause("a.*b(");
    for (const branch of clause.$or) {
      const [rx] = Object.values(branch);
      expect(rx.source).toBe("a\\.\\*b\\(");
      expect(rx.test("a.*b(")).toBe(true);
      expect(rx.test("axxb(")).toBe(false);
    }
  });
});
