// test/costing/costing-applicability.test.js
//
// CENTRAL COSTING DOES NOT DECIDE WHETHER A BUSINESS FACT APPLIES.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// `technicalAcknowledgements` — a list of `{key, reason}` posted with a
// calculation, letting whoever was costing a garment declare a whole cost
// family irrelevant. It was careful about what a payload can be careful about:
// the reason was compulsory, the vocabulary was fixed, and the decision was
// frozen with its author's name.
//
// It was still the wrong desk. Whether the customer supplies the packaging is
// Merchandising's fact; whether anything is sent outside is Production's;
// whether the goods are imported is Store's. A person costing a garment has
// none of that in front of them, and the reason they typed was their best
// guess at somebody else's answer — frozen, permanently, as evidence.
//
// ── THE THREE CLAIMS ────────────────────────────────────────────────────────
//   · Each department records the applicability of the fact it owns, and
//     Costing consumes it read-only.
//   · Missing information is never equivalent to "not applicable".
//   · A family that is inherently required has no escape at all — not a
//     relocated one, not a hidden one, none.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");

const styleApplicability = require("../../services/styleApplicability");
const familyApplicability = require("../../services/centralCosting/familyApplicability.service");
const coverage = require("../../services/centralCosting/costCoverage");
const calculationInput = require("../../services/centralCosting/calculationInput");
const styleRoute = require("../../services/production/styleRoute.service");
const styleDevelopment = require("../../services/merchandising/styleDevelopment.service");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const SalesJourney = require("../../models/CMS_Models/Sales/SalesJourney");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");
const Account = require("../../models/CMS_Models/Sales/Account");
const Service = require("../../models/CMS_Models/Inventory/Services/Service");

let seq = 0;

/* ═══ 1 · THE SHAPE: THREE STATES, AND ONLY ONE OF THEM ANSWERS ══════════ */

describe("the answer a department records", () => {
  test("absent is a question nobody asked, and never a 'no'", () => {
    /* The single mistake worth designing against. A style nobody has opened
       looks exactly like one whose packaging was considered and ruled out,
       unless these are kept apart. */
    for (const stored of [undefined, null, {}, { reason: "orphaned" }, { required: "false" }]) {
      const v = styleApplicability.decisionView(stored);
      expect(v.state).toBe(styleApplicability.DECISION.UNANSWERED);
      expect(v.required).toBeNull();
    }
  });

  test("'yes' and 'no' are both answers, and only 'no' removes a cost", () => {
    expect(styleApplicability.decisionView({ required: true }).state)
      .toBe(styleApplicability.DECISION.REQUIRED);
    expect(styleApplicability.decisionView({ required: false, reason: "Ships loose." }).state)
      .toBe(styleApplicability.DECISION.NOT_REQUIRED);
  });

  test("saying 'no' needs a reason; saying 'yes' does not", () => {
    /* Without one this is a checkbox that turns a missing cost into no cost,
       and six months later nobody can tell a considered decision from a panel
       somebody clicked through. "Required" needs none: the rows that follow
       are the reason. */
    const blank = styleApplicability.parseDecision({ required: false, reason: "   " });
    expect(blank.ok).toBe(false);
    expect(blank.code).toBe("DECISION_REASON_REQUIRED");

    expect(styleApplicability.parseDecision({ required: true }).ok).toBe(true);
    expect(styleApplicability.parseDecision({ required: false, reason: "Customer supplies it." }).ok).toBe(true);
  });

  test("an unanswered question is refused, rather than read as 'no'", () => {
    for (const body of [{}, { reason: "Ships loose." }, { required: null }, { required: "false" }]) {
      const r = styleApplicability.parseDecision(body);
      expect(r.ok).toBe(false);
      expect(r.code).toBe("DECISION_REQUIRED");
    }
  });

  test("the actor is the server's, never the body's", () => {
    /* A decision that removes a cost is signed. A client that could name the
       signer could sign somebody else's name to it. */
    const r = styleApplicability.parseDecision(
      { required: false, reason: "Ships loose.", decidedBy: { id: "forged", name: "The Finance Director" } },
      { actor: { id: "real-actor", name: "A Merchandiser" } },
    );
    expect(r.ok).toBe(true);
    expect(r.value.decidedBy).toEqual({ id: "real-actor", name: "A Merchandiser" });
  });

  test("the published view survives a second read with its signature intact", () => {
    /* The stored sub-document nests the actor under `decidedBy`; the published
       projection flattens it. A view fed back in must come out unchanged, or a
       decision loses its author on the way through the source projection —
       which is an unattributed decision, the thing this whole retirement is
       about. */
    const once = styleApplicability.decisionView({
      required: false, reason: "Ships loose.",
      decidedBy: { id: new mongoose.Types.ObjectId(), name: "A Merchandiser" },
      decidedAt: new Date("2026-05-04"),
    });
    expect(styleApplicability.decisionView(once)).toEqual(once);
  });
});

/* ═══ 2 · WHICH FAMILIES MAY BE EXCUSED, AND BY WHOM ═════════════════════ */

describe("who may say a family does not apply", () => {
  test("four families have an owner, and five have none at all", () => {
    /* ── THE AUDIT, ENCODED ────────────────────────────────────────────
       materials  — a garment is made of something.
       operations — a blank route is missing Production work. Fully outsourced
                    manufacture would need a manufacturing-method decision and
                    the external service requirement to match, and this
                    repository records neither.
       overhead   — the Board's rate, including an approved zero.
       freight    — Sales' arrangement already produces a RECORDED ZERO line
                    for a customer who collects. That is an ANSWER.
       financing  — the same shape: Sales' stated condition produces a nil line
                    with its reason on it. */
    expect(Object.keys(familyApplicability.APPLICABILITY_OWNER).sort())
      .toEqual(["development", "duty", "packaging", "services"]);
    for (const key of ["materials", "operations", "overhead", "freight", "financing"]) {
      expect(familyApplicability.canBeInapplicable(key)).toBe(false);
    }
  });

  test("every owner names a department AND the record they say it in", () => {
    /* A blocking state with no address is a dead end, and a dead end is what
       sent people to declare the family away in Costing. */
    for (const [key, owner] of Object.entries(familyApplicability.APPLICABILITY_OWNER)) {
      expect(owner.department).toBeTruthy();
      expect(owner.recordedIn).toBeTruthy();
      expect(owner.unansweredMessage).toBeTruthy();
      /* And the message says nobody has answered — never that it is nil. */
      expect(owner.unansweredMessage).toMatch(/has not said/i);
      expect(coverage.FAMILY_KEYS).toContain(key);
    }
  });

  test("a decision on an inherently required family is dropped, not honoured", () => {
    /* Second layer, behind the payload refusal: an internal caller cannot
       excuse what no record in the company answers. */
    const a = coverage.assess({
      scenario: {},
      sourceDecisions: {
        materials: { key: "materials", reason: "No materials.", basis: "b" },
        operations: { key: "operations", reason: "Nobody makes it.", basis: "b" },
        overhead: { key: "overhead", reason: "No overhead.", basis: "b" },
        freight: { key: "freight", reason: "We absorb it.", basis: "b" },
        financing: { key: "financing", reason: "Paid up front.", basis: "b" },
      },
    });
    for (const key of ["materials", "operations", "overhead", "freight", "financing"]) {
      expect(a.families.find((f) => f.key === key).state).toBe(coverage.STATE.NEEDS_INPUT);
    }
    expect(a.costComplete).toBe(false);
  });
});

/* ═══ 3 · READING THEM OFF THE STYLE ═════════════════════════════════════ */

describe("the three decisions a style carries", () => {
  const decided = (reason) => ({
    required: false, reason,
    decidedBy: { id: new mongoose.Types.ObjectId(), name: "A Decider" },
    decidedAt: new Date("2026-05-04"),
  });

  test("only NOT_REQUIRED produces a decision — required and unanswered produce none", () => {
    expect(familyApplicability.styleDecisions(null)).toEqual({});
    expect(familyApplicability.styleDecisions({})).toEqual({});
    expect(familyApplicability.styleDecisions({
      materials: { packagingDecision: { required: true } },
      sample: {
        outsideProcessDecision: {},
        developmentDecision: { required: true },
      },
    })).toEqual({});
  });

  test("a stored style and a published projection read alike", () => {
    /* The assembly holds the projection; one caller holds the document. Two
       readers of one fact must not disagree about it. */
    const fromDoc = familyApplicability.styleDecisions({
      materials: { packagingDecision: decided("The customer supplies all packaging.") },
      sample: { outsideProcessDecision: decided("Cut, made and finished in-house.") },
    });
    const fromFacts = familyApplicability.styleDecisions({
      applicability: {
        packaging: styleApplicability.decisionView(decided("The customer supplies all packaging.")),
        outsideProcesses: styleApplicability.decisionView(decided("Cut, made and finished in-house.")),
        development: styleApplicability.decisionView(null),
      },
    });
    expect(Object.keys(fromDoc).sort()).toEqual(["packaging", "services"]);
    expect(fromFacts.packaging.reason).toBe(fromDoc.packaging.reason);
    expect(fromFacts.services.decidedByName).toBe("A Decider");
    expect(fromFacts.packaging.ownerDepartment).toBe("Merchandising");
    expect(fromFacts.services.ownerDepartment).toBe("Production");
  });

  test("the basis names the record that answered, not the version it was read on", () => {
    /* "Marked not applicable on this version" could not be checked by anybody.
       "Merchandising recorded that this style needs no packaging" can. */
    const d = familyApplicability.styleDecisions({
      materials: { packagingDecision: decided("Ships loose.") },
    });
    expect(d.packaging.basis).toMatch(/Merchandising recorded/);
    expect(d.packaging.recordedIn).toMatch(/Packaging components/);
  });
});

/* ═══ 4 · DUTY: STORE ANSWERS ONE OF THE TWO QUESTIONS IN IT ═════════════ */

describe("customs duty, and the tax question beside it", () => {
  const ctx = { companyId: new mongoose.Types.ObjectId() };
  const RECOVERABLE = { inputGstTreatment: "RECOVERABLE" };
  const evidence = require("../../services/storePurchase/sourcingEvidence.service");

  afterEach(() => jest.restoreAllMocks());

  const stub = (state) => jest.spyOn(evidence, "evidenceForItems")
    .mockResolvedValue({ items: [{ state, blocking: state !== "NOT_APPLICABLE", missing: [] }] });

  test("every material bought in India answers the customs half", async () => {
    stub(evidence.EVIDENCE.NOT_APPLICABLE);
    const d = await familyApplicability.dutyDecision(ctx, {
      itemIds: ["a"], policySnapshot: RECOVERABLE,
    });
    expect(d.key).toBe("duty");
    expect(d.reason).toMatch(/bought in India/);
    /* And it says what happened to the OTHER question, rather than leaving a
       reader to assume one decision closed both. */
    expect(d.reason).toMatch(/recoverable/i);
    expect(d.basis).toMatch(/Store recorded domestic sourcing/);
  });

  test("an unclassified or imported material answers nothing", async () => {
    for (const state of ["MISSING", "IN_PROGRESS", "NO_QUOTATION", "READY"]) {
      stub(state);
      /* READY is imported WITH its origin and heading — the duty is then a
         real cost nobody can compute yet, which is not the same as none. */
      expect(await familyApplicability.dutyDecision(ctx, {
        itemIds: ["a"], policySnapshot: RECOVERABLE,
      })).toBeNull();
    }
  });

  test("a domestic style with no stated GST treatment still leaves the family open", async () => {
    /* ── ONE DECISION MUST NOT ERASE TWO TAX QUESTIONS ─────────────────
       Store saying "bought in India" settles customs and says nothing about
       GST. A company that has not stated whether input GST is reclaimed has
       an unanswered question in this family, and closing it on Store's
       evidence alone would hide it. */
    stub(evidence.EVIDENCE.NOT_APPLICABLE);
    expect(await familyApplicability.dutyDecision(ctx, {
      itemIds: ["a"], policySnapshot: {},
    })).toBeNull();
  });

  test("a failed read is not a domestic supply", async () => {
    /* "We could not check" and "there is nothing to pay" are different facts,
       and only one of them is an answer. */
    jest.spyOn(evidence, "evidenceForItems").mockRejectedValue(new Error("db down"));
    expect(await familyApplicability.dutyDecision(ctx, {
      itemIds: ["a"], policySnapshot: RECOVERABLE,
    })).toBeNull();

    jest.restoreAllMocks();
    jest.spyOn(evidence, "evidenceForItems").mockResolvedValue({ items: [] });
    expect(await familyApplicability.dutyDecision(ctx, {
      itemIds: ["a"], policySnapshot: RECOVERABLE,
    })).toBeNull();
  });

  test("a style with no materials answers nothing either", async () => {
    expect(await familyApplicability.dutyDecision(ctx, {
      itemIds: [], policySnapshot: RECOVERABLE,
    })).toBeNull();
  });
});

/* ═══ 5 · THE PAYLOAD REFUSAL ════════════════════════════════════════════ */

describe("a calculation carrying an applicability decision", () => {
  /* No scenarios: the quantities come from the Sales costing brief now, and a
     payload carrying them is refused before this file's own refusal is even
     reached. */
  const parse = (body) => calculationInput.parseCalculationRequest(
    { lines: [], ...body }, { currency: "INR", assembled: true },
  );

  test("is refused, and told where the answer is recorded", () => {
    /* ── SILENTLY STRIPPING IT WOULD BE WORSE ──────────────────────────
       The costing would calculate from whatever the departments had actually
       decided, and the person who pressed Calculate would believe they had
       excluded something else. The version would be right and
       unexplainable. */
    let err;
    try {
      parse({ technicalAcknowledgements: [{ key: "packaging", reason: "Customer supplies it." }] });
    } catch (e) { err = e; }
    expect(err.code).toBe("COSTING_APPLICABILITY_DECISION_MOVED");
    expect(err.details.owners.packaging.department).toBe("Merchandising");
    expect(err.details.owners.packaging.recordedIn).toMatch(/Packaging components/);
  });

  test("an empty list is refused too — the next one will not be empty", () => {
    expect(() => parse({ technicalAcknowledgements: [] }))
      .toThrow(expect.objectContaining({ code: "COSTING_APPLICABILITY_DECISION_MOVED" }));
  });

  test("a family nobody may excuse is named as such, not merely relocated", () => {
    /* A client told only "not here" for materials would go looking for the
       other screen. */
    let err;
    try {
      parse({
        technicalAcknowledgements: [
          { key: "materials", reason: "No materials." },
          { key: "operations", reason: "Nobody makes it." },
          { key: "overhead", reason: "No overhead." },
        ],
      });
    } catch (e) { err = e; }
    for (const key of ["materials", "operations", "overhead"]) {
      expect(err.details.owners[key].inherentlyRequired).toBe(true);
      expect(err.details.owners[key].department).toBeNull();
    }
  });

  test("a calculation with none of it parses, and carries no acknowledgements at all", () => {
    const parsed = parse({});
    expect("acknowledgements" in parsed).toBe(false);
    /* And the parser exposes no builder for one. */
    expect(calculationInput.parseAcknowledgements).toBeUndefined();
    expect(calculationInput.MAX_ACKNOWLEDGEMENTS).toBeUndefined();
  });
});

/* ═══ 6 · THE DEPARTMENTAL DOORS ═════════════════════════════════════════ */

describe("recording the decision where its owner works", () => {
  async function world() {
    const n = ++seq;
    const co = await Acc_Company.create({
      companyName: `App ${n}`, booksFromDate: new Date("2026-04-01"),
    });
    const account = await Account.create({ companyId: co._id, companyName: `Buyer ${n}`, status: "active" });
    const journey = await SalesJourney.create({
      journeyId: `SJ-AP-${n}`, companyId: co._id, name: `J${n}`,
      accountId: account._id, ownerId: new mongoose.Types.ObjectId(), ownerName: "O",
    });
    const style = await SampleStyle.create({
      sampleStyleId: `SS-AP-${n}`, styleCode: `SC-AP-${n}`,
      productName: "Oxford Shirt", journeyId: journey._id,
      materials: { status: "selected", rawItems: [] },
      techSheet: { status: "pending" },
    });
    const service = await Service.create({
      companyId: co._id, name: `Enzyme wash ${n}`, serviceCode: `WSH-${n}`,
      billingUnit: "Piece", status: "ACTIVE",
    });
    return {
      co, style, service,
      ctx: { companyId: co._id, actorId: "a1", actorName: "A" },
      actor: { id: new mongoose.Types.ObjectId(), name: "A Production Manager" },
    };
  }

  test("Production records that nothing goes outside, and Costing reads it", async () => {
    const w = await world();
    const before = await styleRoute.readOutsideProcesses(w.ctx, { styleId: w.style._id });
    /* Nobody has been asked. Not "no". */
    expect(before.decision.state).toBe("UNANSWERED");

    const after = await styleRoute.saveOutsideProcessDecision(w.ctx, {
      styleId: w.style._id, required: false,
      reason: "Cut, made and finished entirely in-house.",
      actor: w.actor,
    });
    expect(after.decision.state).toBe("NOT_REQUIRED");
    expect(after.decision.decidedByName).toBe("A Production Manager");
    expect(after.decision.decidedAt).toBeTruthy();

    const style = await SampleStyle.findById(w.style._id).lean();
    const decisions = familyApplicability.styleDecisions(style);
    expect(decisions.services.reason).toBe("Cut, made and finished entirely in-house.");
    expect(decisions.services.ownerDepartment).toBe("Production");
  });

  test("'nothing goes outside' is refused while outside processes are recorded", async () => {
    /* The rows and the statement would contradict each other, and the costing
       would have to choose which to believe. */
    const w = await world();
    await styleRoute.saveOutsideProcesses(w.ctx, {
      styleId: w.style._id,
      outsideProcesses: [{
        serviceId: String(w.service._id), specification: "Two cycles",
        quantity: 1, billingUnit: "Piece", basis: "PER_GARMENT", included: true,
      }],
      actor: w.actor,
    });
    await expect(styleRoute.saveOutsideProcessDecision(w.ctx, {
      styleId: w.style._id, required: false, reason: "Nothing goes outside.", actor: w.actor,
    })).rejects.toMatchObject({ details: { reason: "OUTSIDE_PROCESSES_RECORDED" } });
  });

  test("a decision with no reason is refused at the door too", async () => {
    const w = await world();
    await expect(styleRoute.saveOutsideProcessDecision(w.ctx, {
      styleId: w.style._id, required: false, reason: "  ", actor: w.actor,
    })).rejects.toMatchObject({ details: { reason: "DECISION_REASON_REQUIRED" } });
    await expect(styleRoute.saveOutsideProcessDecision(w.ctx, {
      styleId: w.style._id, actor: w.actor,
    })).rejects.toMatchObject({ details: { reason: "DECISION_REQUIRED" } });
  });

  test("another company's style is not found, rather than forbidden", async () => {
    /* Saying "that exists, elsewhere" is itself a disclosure. */
    const mine = await world();
    const theirs = await world();
    await expect(styleRoute.saveOutsideProcessDecision(mine.ctx, {
      styleId: theirs.style._id, required: false, reason: "Not mine to say.", actor: mine.actor,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const untouched = await SampleStyle.findById(theirs.style._id).lean();
    expect(untouched.sample?.outsideProcessDecision?.required).toBeUndefined();
  });

  test("Merchandising records that no development work is needed", async () => {
    const w = await world();
    const before = await styleDevelopment.readDevelopment(w.ctx, { styleId: w.style._id });
    expect(before.decision.state).toBe("UNANSWERED");
    expect(before.development).toHaveLength(0);
    /* An empty list is not an answer, and the two are visibly different. */

    const after = await styleDevelopment.saveDevelopmentDecision(w.ctx, {
      styleId: w.style._id, required: false,
      reason: "Repeat style — the pattern and screens already exist.",
      actor: { id: new mongoose.Types.ObjectId(), name: "A Merchandiser" },
    });
    expect(after.decision.state).toBe("NOT_REQUIRED");

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(familyApplicability.styleDecisions(style).development.ownerDepartment).toBe("Merchandising");
  });

  test("one department's decision does not touch the other's, or their rows", async () => {
    /* Both live on the same style, and the outside-process and development
       rows share one array. A save that quietly rewrote the other half is the
       defect this door was split to avoid. */
    const w = await world();
    await styleRoute.saveOutsideProcesses(w.ctx, {
      styleId: w.style._id,
      outsideProcesses: [{
        serviceId: String(w.service._id), specification: "Two cycles",
        quantity: 1, billingUnit: "Piece", basis: "PER_GARMENT", included: true,
      }],
      actor: w.actor,
    });
    await styleDevelopment.saveDevelopmentDecision(w.ctx, {
      styleId: w.style._id, required: false, reason: "Repeat style.",
      actor: { id: new mongoose.Types.ObjectId(), name: "A Merchandiser" },
    });

    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.sample.serviceRequirements).toHaveLength(1);
    expect(style.sample.serviceRequirements[0].purpose).toBe("OUTSIDE_PROCESS");
    expect(style.sample.outsideProcessDecision?.required).toBeUndefined();
    expect(style.sample.developmentDecision.required).toBe(false);
  });

  test("a row-level exclusion is not a whole-style decision", async () => {
    /* "We considered a hang tag and dropped it" is a fact worth having and
       says nothing about whether the style is packed at all. */
    const w = await world();
    await styleRoute.saveOutsideProcesses(w.ctx, {
      styleId: w.style._id,
      outsideProcesses: [{
        serviceId: String(w.service._id), specification: "Two cycles",
        included: false, excludedReason: "Quoted too late for this order.",
        basis: "PER_GARMENT",
      }],
      actor: w.actor,
    });
    const style = await SampleStyle.findById(w.style._id).lean();
    expect(style.sample.serviceRequirements[0].included).toBe(false);
    expect(style.sample.serviceRequirements[0].excludedReason).toMatch(/too late/);
    /* And the family is still unanswered — nobody has said whether anything
       goes outside. */
    expect(familyApplicability.styleDecisions(style).services).toBeUndefined();
  });

  test("an excluded row does not block a 'nothing goes outside' decision", async () => {
    /* It is already decided against, so it is not a contradiction. */
    const w = await world();
    await styleRoute.saveOutsideProcesses(w.ctx, {
      styleId: w.style._id,
      outsideProcesses: [{
        serviceId: String(w.service._id), specification: "Two cycles",
        included: false, excludedReason: "Dropped.", basis: "PER_GARMENT",
      }],
      actor: w.actor,
    });
    const after = await styleRoute.saveOutsideProcessDecision(w.ctx, {
      styleId: w.style._id, required: false, reason: "Finished in-house.", actor: w.actor,
    });
    expect(after.decision.state).toBe("NOT_REQUIRED");
  });
});

/* ═══ 7 · LANE B'S POLICIES ARE READ, NEVER WRITTEN ══════════════════════ */

test("nothing in this task touches Board policy, financing, overhead or labour", () => {
  const { readFileSync } = require("fs");
  const bare = (rel) => readFileSync(require("path").join(__dirname, "../..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  /* The applicability table decides who may excuse a family. Overhead,
     financing and labour are not in it, and no file of this task's writes a
     Board record. */
  const resolver = bare("services/centralCosting/familyApplicability.service.js");
  expect(resolver).not.toMatch(/boardPolicy|BoardPolicy|overheadPolicy|labourPolicy|financing\.service/);
  /* It READS the company's GST treatment off the resolved policy snapshot —
     a read, and the only Board-derived value it touches. */
  expect(resolver).toMatch(/policySnapshot\.inputGstTreatment/);

  for (const rel of [
    "services/styleApplicability.js",
    "services/production/styleRoute.service.js",
    "services/merchandising/styleDevelopment.service.js",
  ]) {
    const src = bare(rel);
    /* No Board record is read or written by any of the three departmental
       doors. `styleDevelopment` names `overheadRatePercent` once — in its
       REFUSED_FIELDS list, so a body carrying one is turned away by name,
       which is the opposite of touching it. */
    expect(src).not.toMatch(/boardPolicy|BoardPolicy|labourEfficiencyPercent/);
    expect(src).not.toMatch(/require\(["'][^"']*(board|overheadPolicy|labourPolicy|financing)/i);
  }
});
