// test/costing/sales-costing-brief.test.js
//
// SALES ASKS FOR A COSTING. CENTRAL COSTING ANSWERS IT.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// Five commercial facts typed inside the Central Costing workspace: which of
// several SampleStyles the costing was about, the run sizes to price, which
// was primary, the unit, and the proposed selling price — plus the note. All
// of them arrived on the calculation payload, and none survived anywhere Sales
// could read back what they had asked for.
//
// ── THE CLAIMS ──────────────────────────────────────────────────────────────
//   · a brief is confirmable only against an APPROVED style;
//   · an absent or unconfirmed brief BLOCKS the costing and names Sales —
//     it never defaults a quantity, a unit, a price or a style;
//   · a payload carrying any of it is refused, not stripped;
//   · moving to a different style SUPERSEDES explicitly, and the earlier
//     brief keeps saying what it said;
//   · a brief cannot carry a cost, a rate, a policy or a margin;
//   · company isolation, and missing answers as foreign does.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const costingBrief = require("../../services/sales/costingBrief.service");
const salesBrief = require("../../services/centralCosting/salesBrief.service");
const calculationInput = require("../../services/centralCosting/calculationInput");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Account = require("../../models/CMS_Models/Sales/Account");

let seq = 0;

/** A company, an enquiry with one product, and two styles for it. */
async function world({ approved = true, second = false } = {}) {
  const n = ++seq;
  const co = await Acc_Company.create({
    companyName: `Brief ${n}`, booksFromDate: new Date("2026-04-01"),
  });
  const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
  const journey = await SalesJourney.create({
    journeyId: `SJ-BR-${n}`, companyId: co._id, name: `J${n}`,
    accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
  });
  const enquiry = await Enquiry.create({
    enquiryId: `ENQ-BR-${n}`, companyId: co._id, accountId: account._id,
    journeyId: journey._id, isActive: true,
    products: [{ product: "Oxford Shirt", quantity: 500 }],
  });

  const style = async (code, isApproved) => SampleStyle.create({
    sampleStyleId: `SS-BR-${n}${code}`, styleCode: `SC-BR-${n}${code}`,
    productName: "Oxford Shirt",
    /* Two styles of one product are two VARIANTS — the unique index is
       (journey, product, variant), which is the point: siblings are how a
       style choice becomes a question at all. */
    variantKey: code, variantLabel: code === "a" ? "Navy" : "White",
    journeyId: journey._id, enquiryId: enquiry._id,
    materials: { status: "selected", rawItems: [] },
    techSheet: {
      status: isApproved ? "approved" : "pending",
      technical: { status: isApproved ? "approved" : "draft", revision: 2 },
      ...(isApproved
        ? {
          technicalRevisions: [{
            revision: 2, outcome: "approved",
            submittedAt: new Date("2026-07-01"), submittedBy: { name: "R&D" },
            decidedAt: new Date("2026-07-02"), decidedByName: "Sales",
            snapshot: { materials: [] },
          }],
        }
        : {}),
    },
  });

  const a = await style("a", approved);
  const b = second ? await style("b", true) : null;

  return {
    co, enquiry, a, b,
    ctx: { companyId: co._id },
    actor: { id: new mongoose.Types.ObjectId(), name: "A Salesperson" },
  };
}

const save = (w, over = {}) => costingBrief.saveBrief(w.ctx, {
  enquiryId: w.enquiry._id,
  body: {
    sampleStyleId: String(w.a._id),
    quantities: [
      { key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "420" },
      { key: "q2000", quantity: "2000" },
    ],
    quantityUom: "Pieces",
    note: "Repeat buyer, two break points.",
    ...over,
  },
  actor: w.actor,
});

/* ═══ 1 · THE SHAPE, AND WHAT IT REFUSES ═════════════════════════════════ */

describe("what a brief may carry", () => {
  test("a cost, a rate, a policy or a margin is refused by name and by owner", () => {
    /* A salesperson who put a fabric rate in the body needs to be told that
       rates are Store's, not that they made a typo. */
    const cases = [
      ["rate", /a rate/], ["margin", /a margin/], ["overheadRatePercent", /an overhead rate/],
      ["supplierId", /a supplier/], ["samMinutes", /a standard time/],
      ["consumption", /a consumption/], ["inputGstTreatment", /a tax policy/],
    ];
    for (const [field, matcher] of cases) {
      expect(() => costingBrief.assertBriefShape({ [field]: 1 }))
        .toThrow(expect.objectContaining({ code: "FIELD_NOT_ACCEPTED" }));
      let err;
      try { costingBrief.assertBriefShape({ [field]: 1 }); } catch (e) { err = e; }
      expect(err.message).toMatch(matcher);
      expect(err.details.field).toBe(field);
    }
  });

  test("the confirmation verbs' own fields cannot be set by a save", () => {
    /* Confirming is an act with an actor and a date. A body that could set
       them could sign somebody else's name to a decision. */
    for (const field of ["state", "confirmedAt", "confirmedBy", "supersededAt", "briefId"]) {
      expect(() => costingBrief.assertBriefShape({ [field]: "x" }))
        .toThrow(expect.objectContaining({ code: "FIELD_NOT_ACCEPTED" }));
    }
  });

  test("a quantity of nothing prices nothing, and a zero is not a quantity", () => {
    expect(() => costingBrief.parseQuantities([{ key: "a", quantity: "0" }]))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: "QUANTITY_ZERO" }) }));
    expect(() => costingBrief.parseQuantities([]))
      .toThrow(expect.objectContaining({ details: expect.objectContaining({ reason: "QUANTITY_REQUIRED" }) }));
  });

  test("exactly one primary, and one is chosen rather than left to array order", () => {
    /* The coverage assessment is made against one run size. Two would be two
       assessments; none would be an arbitrary choice. */
    expect(() => costingBrief.parseQuantities([
      { key: "a", quantity: "1", isPrimary: true },
      { key: "b", quantity: "2", isPrimary: true },
    ])).toThrow(expect.objectContaining({
      details: expect.objectContaining({ reason: "PRIMARY_AMBIGUOUS" }),
    }));

    const out = costingBrief.parseQuantities([{ key: "a", quantity: "1" }, { key: "b", quantity: "2" }]);
    expect(out.filter((q) => q.isPrimary)).toHaveLength(1);
    expect(out[0].isPrimary).toBe(true);
  });

  test("a proposed price is optional, and absent is never nil", () => {
    /* A costing is routinely raised before anybody has proposed a price. */
    const [q] = costingBrief.parseQuantities([{ key: "a", quantity: "500" }]);
    expect("proposedSellingPriceExclTax" in q).toBe(false);
    const [p] = costingBrief.parseQuantities([{ key: "a", quantity: "500", proposedSellingPriceExclTax: "420" }]);
    expect(p.proposedSellingPriceExclTax).toBe("420");
  });
});

/* ═══ 2 · ONLY AN APPROVED STYLE MAY BE QUOTED ═══════════════════════════ */

describe("the approval gate", () => {
  test("the gate is the APPROVED REVISION, not the status field", () => {
    /* `readStyleFacts` costs a style from the frozen revision Sales approved,
       not from the live record R&D may already be drafting. Reading the
       status instead would let a style be quoted that the engine refuses. */
    const statusOnly = { techSheet: { technical: { status: "approved" } } };
    expect(costingBrief.approvalStateOf(statusOnly).quotable).toBe(false);

    const withRevision = {
      techSheet: {
        technical: { status: "approved" },
        technicalRevisions: [{ revision: 3, outcome: "approved" }],
      },
    };
    const state = costingBrief.approvalStateOf(withRevision);
    expect(state.quotable).toBe(true);
    expect(state.approvedRevision).toBe(3);
  });

  test("an unapproved style is listed WITH its reason, not hidden", async () => {
    /* An absent option reads as a style that does not exist. Somebody waiting
       on an approval needs to see which style it is. */
    const w = await world({ approved: false });
    const out = await costingBrief.readBriefs(w.ctx, { enquiryId: w.enquiry._id });
    expect(out.styles).toHaveLength(1);
    expect(out.styles[0].quotable).toBe(false);
    expect(out.styles[0].blockedReason).toMatch(/has not been approved/);
  });

  test("a style option carries no technical fact at all", async () => {
    /* Sales chooses WHICH style is being quoted; what is in it is R&D's and
       Production's record. */
    const w = await world();
    const [option] = (await costingBrief.readBriefs(w.ctx, { enquiryId: w.enquiry._id })).styles;
    const text = JSON.stringify(option);
    for (const leak of ["consumption", "allowance", "operation", "samMinutes", "rawItem", "cost", "rate"]) {
      expect(text.toLowerCase()).not.toContain(leak.toLowerCase());
    }
  });

  test("a brief for an unapproved style saves as a draft and refuses to confirm", async () => {
    /* Drafting against a style still in approval is normal work. Confirming
       it would ask Central Costing to price a record that does not exist. */
    const w = await world({ approved: false });
    const saved = await save(w);
    expect(saved.briefs).toHaveLength(1);
    expect(saved.briefs[0].state).toBe("DRAFT");

    await expect(costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: saved.briefs[0].briefId, actor: w.actor,
    })).rejects.toMatchObject({
      code: "COSTING_BRIEF_STYLE_NOT_APPROVED",
      details: { reason: "TECHNICAL_REVISION_NOT_APPROVED" },
    });
  });
});

/* ═══ 3 · CONFIRMING, AND SUPERSEDING ════════════════════════════════════ */

describe("confirming a brief", () => {
  test("it records who and when, and Central Costing then reads it", async () => {
    const w = await world();
    const saved = await save(w);
    const out = await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: saved.briefs[0].briefId, actor: w.actor,
    });
    const [brief] = out.confirmed;
    expect(brief.state).toBe("CONFIRMED");
    expect(brief.confirmedByName).toBe("A Salesperson");
    expect(brief.confirmedAt).toBeTruthy();

    const enquiry = await Enquiry.findById(w.enquiry._id).lean();
    const read = costingBrief.confirmedBriefOn(enquiry, "Oxford Shirt");
    expect(read.briefId).toBe(brief.briefId);
    expect(read.quantities.map((q) => q.quantity)).toEqual(["500", "2000"]);
    expect(read.quantityUom).toBe("Pieces");
  });

  test("confirming twice is idempotent, not a conflict", async () => {
    /* A retried request must not look like a second decision. */
    const w = await world();
    const saved = await save(w);
    const id = saved.briefs[0].briefId;
    await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: id, actor: w.actor });
    const again = await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: id, actor: w.actor });
    expect(again.confirmed).toHaveLength(1);
    expect(again.confirmed[0].briefId).toBe(id);
  });

  test("a confirmed brief cannot be edited — a version may already cite it", async () => {
    const w = await world();
    const saved = await save(w);
    await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: saved.briefs[0].briefId, actor: w.actor,
    });
    await expect(save(w, { quantities: [{ key: "q1", quantity: "999", isPrimary: true }] }))
      .rejects.toMatchObject({ code: "COSTING_BRIEF_NOT_CONFIRMABLE" });
  });

  test("moving to another style supersedes explicitly, and never retargets", async () => {
    /* ── THE CLAIM THAT MATTERS ──────────────────────────────────────
       Editing the confirmed brief to point at the new style would make every
       frozen costing version citing it describe a garment it was not
       calculated for. The old brief is closed, names its successor, and says
       why — and goes on saying which style it was for. */
    const w = await world({ second: true });
    const first = await save(w);
    const firstId = first.briefs[0].briefId;
    await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: firstId, actor: w.actor });

    const second = await costingBrief.saveBrief(w.ctx, {
      enquiryId: w.enquiry._id,
      body: {
        sampleStyleId: String(w.b._id),
        quantities: [{ key: "q1000", quantity: "1000", isPrimary: true }],
        quantityUom: "Pieces",
      },
      actor: w.actor,
    });
    const secondId = second.briefs.find((b) => b.briefId !== firstId).briefId;
    const out = await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: secondId,
      reason: "The customer chose the white body.", actor: w.actor,
    });

    expect(out.superseded).toEqual([firstId]);
    const old = out.briefs.find((b) => b.briefId === firstId);
    expect(old.state).toBe("SUPERSEDED");
    expect(old.supersededByBriefId).toBe(secondId);
    expect(old.supersessionReason).toBe("The customer chose the white body.");
    /* Still pointing at the style it was actually for. */
    expect(old.sampleStyleId).toBe(String(w.a._id));

    /* And exactly one live request remains, so nothing has to choose. */
    expect(out.confirmed.map((b) => b.briefId)).toEqual([secondId]);
  });

  test("a superseded brief cannot be confirmed again", async () => {
    const w = await world({ second: true });
    const first = await save(w);
    const firstId = first.briefs[0].briefId;
    await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: firstId, actor: w.actor });
    const second = await costingBrief.saveBrief(w.ctx, {
      enquiryId: w.enquiry._id,
      body: { sampleStyleId: String(w.b._id), quantities: [{ key: "q1", quantity: "1", isPrimary: true }] },
      actor: w.actor,
    });
    const secondId = second.briefs.find((b) => b.briefId !== firstId).briefId;
    await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: secondId, actor: w.actor });

    await expect(costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: firstId, actor: w.actor,
    })).rejects.toMatchObject({ code: "COSTING_BRIEF_SUPERSEDED" });
  });

  test("a superseded brief is still listed — the change must not be invisible", async () => {
    const w = await world({ second: true });
    const first = await save(w);
    const firstId = first.briefs[0].briefId;
    await costingBrief.confirmBrief(w.ctx, { enquiryId: w.enquiry._id, briefId: firstId, actor: w.actor });
    const second = await costingBrief.saveBrief(w.ctx, {
      enquiryId: w.enquiry._id,
      body: { sampleStyleId: String(w.b._id), quantities: [{ key: "q1", quantity: "1", isPrimary: true }] },
      actor: w.actor,
    });
    const secondId = second.briefs.find((b) => b.briefId !== firstId).briefId;
    const out = await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: secondId, actor: w.actor,
    });
    expect(out.briefs.map((b) => b.briefId).sort()).toEqual([firstId, secondId].sort());
  });
});

/* ═══ 4 · COMPANY ISOLATION ══════════════════════════════════════════════ */

describe("scope", () => {
  test("another company's enquiry is not found, rather than forbidden", async () => {
    /* Saying "that exists, elsewhere" is itself a disclosure. */
    const mine = await world();
    const theirs = await world();
    await expect(costingBrief.readBriefs(mine.ctx, { enquiryId: theirs.enquiry._id }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(costingBrief.saveBrief(mine.ctx, {
      enquiryId: theirs.enquiry._id,
      body: { sampleStyleId: String(theirs.a._id), quantities: [{ key: "q", quantity: "1" }] },
      actor: mine.actor,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await Enquiry.findById(theirs.enquiry._id).lean();
    expect(untouched.costingBriefs || []).toHaveLength(0);
  });

  test("a style from another enquiry cannot be briefed on this one", async () => {
    const mine = await world();
    const theirs = await world();
    await expect(costingBrief.saveBrief(mine.ctx, {
      enquiryId: mine.enquiry._id,
      body: { sampleStyleId: String(theirs.a._id), quantities: [{ key: "q", quantity: "1" }] },
      actor: mine.actor,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

/* ═══ 5 · WHAT CENTRAL COSTING DOES WITH IT ══════════════════════════════ */

describe("the costing reads it, and cannot be sent one", () => {
  const costingFor = (w) => ({
    context: { type: "ENQUIRY_STYLE", primaryId: w.enquiry._id, externalKey: "Oxford Shirt" },
  });

  test("no confirmed brief blocks the calculation and names Sales", async () => {
    /* ── AND NOTHING IS DEFAULTED ────────────────────────────────────
       Not a quantity, not a unit, not a price, and above all not a style —
       picking one by ordering is how a costing comes to describe the wrong
       garment. */
    const w = await world();
    await expect(salesBrief.requireConfirmedBrief(w.ctx, costingFor(w)))
      .rejects.toMatchObject({
        code: "COSTING_BRIEF_REQUIRED",
        details: { reason: "NO_CONFIRMED_BRIEF", owner: { department: "Sales" } },
      });

    /* A DRAFT is not an answer either. */
    await save(w);
    await expect(salesBrief.requireConfirmedBrief(w.ctx, costingFor(w)))
      .rejects.toMatchObject({ code: "COSTING_BRIEF_REQUIRED" });
  });

  test("a confirmed brief becomes the scenarios, the unit and the style", async () => {
    const w = await world();
    const saved = await save(w);
    await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: saved.briefs[0].briefId, actor: w.actor,
    });

    const brief = await salesBrief.requireConfirmedBrief(w.ctx, costingFor(w));
    const input = salesBrief.toCalculationInput(brief);
    expect(input.technicalStyleId).toBe(String(w.a._id));
    expect(input.note).toBe("Repeat buyer, two break points.");
    expect(input.scenarios.map((s) => s.quantity)).toEqual(["500", "2000"]);
    /* ── ONE UNIT FOR THE WHOLE BRIEF ─────────────────────────────────
       It used to be per scenario, which let one costing quote 500 pieces
       beside 500 metres. */
    expect(input.scenarios.every((s) => s.quantityUom === "Pieces")).toBe(true);
    expect(input.scenarios.filter((s) => s.isPrimary)).toHaveLength(1);
    /* Canonical money — integer minor units and a currency — converted in
       exact decimal from what Sales typed. */
    expect(input.scenarios[0].proposedSellingPriceExclTax)
      .toEqual({ amountMinor: 42000, currency: "INR" });
    expect("proposedSellingPriceExclTax" in input.scenarios[1]).toBe(false);

    /* The engine's own scenario validator accepts it unchanged, so there is
       one authority for the contract rather than two. */
    const validated = calculationInput.parseScenarios(input.scenarios);
    expect(validated).toHaveLength(2);
  });

  test("the frozen provenance names the brief AND its revision", async () => {
    /* So a reader can tell a costing made against Monday's requested
       quantities from one made against Thursday's. */
    const w = await world();
    const saved = await save(w);
    const out = await costingBrief.confirmBrief(w.ctx, {
      enquiryId: w.enquiry._id, briefId: saved.briefs[0].briefId, actor: w.actor,
    });
    const ref = salesBrief.briefProvenance(out.confirmed[0]);
    expect(ref.sourceType).toBe("SALES_COSTING_BRIEF");
    expect(ref.sourceKey).toBe(`costing-brief:${out.confirmed[0].briefId}`);
    /* A confirmed commercial decision with a named author, not a guess. */
    expect(ref.confidence).toBe("VERIFIED");
    const snap = Object.fromEntries(ref.snapshot.map((f) => [f.key, f.text]));
    expect(snap.briefId).toBe(out.confirmed[0].briefId);
    expect(Number(snap.briefRevision)).toBeGreaterThan(0);
    expect(snap.confirmedBy).toBe("A Salesperson");
    expect(snap.quantityUom).toBe("Pieces");
    /* And no cost, rate or margin travels with it. */
    expect(JSON.stringify(ref).toLowerCase()).not.toMatch(/margin|overhead|"rate"/);
  });

  test("a payload carrying the commercial inputs is refused, not stripped", async () => {
    /* ── SILENTLY DROPPING THEM WOULD BE WORSE ───────────────────────
       The costing would price the brief while the person who typed the
       quantities believes they were used, and the proposed price they think
       they recorded would be absent from the frozen record with nothing
       saying why. */
    for (const field of ["scenarios", "note", "technicalStyleId", "quantityUom"]) {
      let err;
      try {
        calculationInput.parseCalculationRequest(
          { lines: [], [field]: field === "scenarios" ? [{ key: "a", quantity: "1" }] : "x" },
          { currency: "INR", assembled: true },
        );
      } catch (e) { err = e; }
      expect(err.code).toBe("COSTING_BRIEF_MOVED");
      expect(err.details.fields).toContain(field);
      expect(err.details.owner.department).toBe("Sales");
      expect(err.details.briefAt).toBeTruthy();
    }
  });

  test("a calculation carrying none of it parses, and returns only lines", async () => {
    const parsed = calculationInput.parseCalculationRequest({ lines: [] }, { currency: "INR", assembled: true });
    expect(Object.keys(parsed)).toEqual(["lines"]);
  });

  test("two confirmed briefs for one product are reported, never silently ranked", async () => {
    /* Supersession guarantees one. If two ever coexist — a migration, a bad
       write — preferring the newest would silently choose which garment the
       company quoted. */
    const w = await world({ second: true });
    const now = new Date();
    await Enquiry.collection.updateOne({ _id: w.enquiry._id }, {
      $set: {
        costingBriefs: [
          { briefId: "one", sampleStyleId: w.a._id, productName: "Oxford Shirt", state: "CONFIRMED", confirmedAt: now, quantities: [] },
          { briefId: "two", sampleStyleId: w.b._id, productName: "Oxford Shirt", state: "CONFIRMED", confirmedAt: now, quantities: [] },
        ],
      },
    });
    const enquiry = await Enquiry.findById(w.enquiry._id).lean();
    expect(() => costingBrief.confirmedBriefOn(enquiry, "Oxford Shirt"))
      .toThrow(expect.objectContaining({
        details: expect.objectContaining({ reason: "CONFIRMED_BRIEF_AMBIGUOUS" }),
      }));
  });
});

/* ═══ 6 · LANE B'S POLICIES ARE NOT TOUCHED ══════════════════════════════ */

test("nothing in this task reads or writes a Board policy", () => {
  const { readFileSync } = require("fs");
  const bare = (rel) => readFileSync(require("path").join(__dirname, "../..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const rel of [
    "services/sales/costingBrief.service.js",
    "services/centralCosting/salesBrief.service.js",
  ]) {
    const src = bare(rel);
    expect(src).not.toMatch(/boardPolicy|BoardPolicy|gstPolicy|overheadPolicy|labourPolicy|financing\.service/);
    expect(src).not.toMatch(/require\(["'][^"']*(board|overheadPolicy|labourPolicy|gstPolicy|financing)/i);
    /* `costingBrief` names `overheadRatePercent` and `marginPercent` once
       each — in REFUSED_FIELDS, so a body carrying one is turned away by
       name and by owner. That is the opposite of reading a policy, and it is
       asserted positively rather than banned by a regex. */
    expect(src).not.toMatch(/policy\.(overheadRatePercent|minimumMarginPercent)/);
  }
});
