// test/costing/sales-estimate-preparation.test.js
//
// SALES ASKS FOR AN ESTIMATE. THE ENGINE STAYS INVISIBLE.
//
// ── WHAT THIS REPLACED ──────────────────────────────────────────────────────
// "Calculate new version", in the Central Costing workspace, and "Start a
// costing" on its list. Between them they meant somebody had to open a
// calculation engine and press a button before Sales could learn what a
// garment costs.
//
// ── THE CLAIMS ──────────────────────────────────────────────────────────────
//   · no confirmed brief, or a missing departmental input, BLOCKS — and every
//     blocker comes back at once, named by the desk that answers it;
//   · the first costing and its version 1 are created together;
//   · an identical retry creates nothing;
//   · a moved source — brief, technical revision, Store decision, Board
//     policy — is detected, named, and produces a new draft;
//   · an approved version is never touched;
//   · reading writes nothing;
//   · the retired route refuses a browser client and names Sales;
//   · Sales sees the commercial answer and none of the evidence behind it.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const mongoose = require("mongoose");
const {
  seedSourceBacked, configureProduction, approveFinancingPolicy, CONFIRMED_TERMS,
  EVERY_FAMILY, confirmCostingBrief,
} = require("./helpers/sourceBacked");

const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const SampleStyle = require("../../models/CMS_Models/Sales/SampleStyle");

const prep = require("../../services/sales/costingPreparation.service");
const result = require("../../services/sales/costingResult.service");
const profitBridge = require("../../services/centralCosting/profitBridge");
const fingerprint = require("../../services/centralCosting/sourceFingerprint.service");
const sourceApps = require("../../services/centralCosting/sourceApps");

let seq = 0;

const CAPS = [
  "costing.draft.write", "costing.cost.read", "costing.margin.read",
  "costing.output.read", "costing.approve",
  /* ── AND THE GRANT TO ASK ────────────────────────────────────────────
     Preparing now requires `costing.prepare`, which no other capability
     implies. Every world in this suite is an AUTHORISED actor, so it holds
     it; the refusals are proved in `sales-prepare-authorisation.test.js`
     against actors resolved from real department grants. */
  "costing.prepare",
];

/** A company whose every family is sourced, and NO brief. */
async function world(over = {}) {
  const co = await Acc_Company.create({
    companyName: `Prep ${++seq}`, booksFromDate: new Date("2026-04-01"),
  });
  await CostingPolicy.create({
    companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP",
    sellingPriceIncrementMinor: 100, revision: 1,
  });
  await approveFinancingPolicy(co._id);
  const seeded = await seedSourceBacked(co._id, {
    ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null, ...over,
  });
  await configureProduction(co._id);

  return {
    co, seeded,
    product: seeded.product,
    ctx: {
      companyId: co._id, actorId: "a1", actorName: "A Salesperson",
      capabilitySet: new Set(CAPS),
    },
  };
}

const brief = (w, quantities) => confirmCostingBrief(w.co._id, {
  enquiryId: w.seeded.enquiry._id,
  styleId: w.seeded.style._id,
  ...(quantities ? { quantities } : {}),
});

const resolve = (w) => prep.resolve(w.ctx, { enquiryId: w.seeded.enquiry._id, product: w.product });
const prepare = (w, key = null) => prep.prepare(w.ctx, {
  enquiryId: w.seeded.enquiry._id, product: w.product,
  actionKey: key || `k-${++seq}`,
});

/* ═══ 1 · NOTHING TO COST YET ════════════════════════════════════════════ */

describe("before anybody has asked", () => {
  test("no confirmed brief is AWAITING INPUTS, and names Sales", async () => {
    const w = await world();
    const r = await resolve(w);
    expect(r.state).toBe(prep.STATE.AWAITING_INPUTS);
    expect(r.blockers[0].owner).toBe("Sales");
    expect(r.blockers[0].ownerApp).toBe("sales");
    /* A destination, not just a department name somebody must go and find. */
    expect(r.blockers[0].action.section).toBe("costing-brief");
  });

  test("preparing without one is refused, and writes nothing", async () => {
    const w = await world();
    await expect(prepare(w)).rejects.toMatchObject({ code: "COSTING_BRIEF_REQUIRED" });
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(0);
  });

  test("a DRAFT brief is not an answer either", async () => {
    const w = await world();
    await confirmCostingBrief(w.co._id, {
      enquiryId: w.seeded.enquiry._id, styleId: w.seeded.style._id, confirm: false,
    });
    await expect(prepare(w)).rejects.toMatchObject({ code: "COSTING_BRIEF_REQUIRED" });
  });

  test("reading writes nothing at all — a page load is not a calculation", async () => {
    /* A screen that created a version by being looked at would fill the
       history with estimates nobody asked for. */
    const w = await world();
    await brief(w);
    const before = await CostingVersion.countDocuments({ companyId: w.co._id });
    await resolve(w); await resolve(w); await resolve(w);
    expect(await CostingVersion.countDocuments({ companyId: w.co._id })).toBe(before);
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(0);
  });
});

/* ═══ 2 · A DEPARTMENT STILL OWES AN INPUT ═══════════════════════════════ */

describe("when a source is missing", () => {
  test("every blocker comes back at once, grouped by the desk that answers it", async () => {
    /* Somebody chasing two departments needs both, once — not the first one,
       twice.

       ── AND THE GAPS ARE THE ASSEMBLY'S, NOT THE COVERAGE'S ─────────
       A material with no usable quotation and a lane nobody has priced are
       what `missing` reports before anything is costed. The COVERAGE
       assessment answers a different question — "was every family addressed
       by this calculation?" — and is only meaningful once the engine has
       run, which is why it is frozen on the version rather than consulted
       here. */
    const w = await world({ withQuotation: false, freight: null });
    await brief(w);
    const out = await prepare(w);
    expect(out.outcome).toBe("BLOCKED");
    const blocking = out.blockers.filter((b) => b.blocking);
    expect(blocking.length).toBeGreaterThanOrEqual(1);
    /* Named by the desk that answers it, so a screen offers a destination
       rather than a department somebody must go and find. */
    expect(blocking.every((b) => b.owner)).toBe(true);
    /* And nothing was written: a version calculated over a missing source is
       a confident number answering a smaller question than it appears to. */
    expect(await CostingVersion.countDocuments({ companyId: w.co._id, "scenarios.0": { $exists: true } })).toBe(0);
  });

  test("a blocked estimate names owners, never a manual workaround", async () => {
    const w = await world({ withQuotation: false });
    await brief(w);
    const out = await prepare(w);
    const view = result.resultFor({ resolved: out, caps: w.ctx.capabilitySet });
    expect(view.blockers.every((b) => b.owner)).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/type a|enter a rate|manual/i);
  });
});

/* ═══ 3 · PREPARING, AND NOT PREPARING TWICE ═════════════════════════════ */

describe("preparing the estimate", () => {
  test("the first ask creates the costing AND its version 1", async () => {
    const w = await world();
    await brief(w);
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(0);

    const out = await prepare(w);
    expect(out.outcome).toBe("PREPARED");
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(1);

    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    /* The same durable creation claim the retired route wrote, so the
       duplicate protection is unchanged rather than reimplemented. */
    expect(costing.creationClaimId).toBeTruthy();
    const v = await CostingVersion.findOne({ costingId: costing._id }).sort({ versionNumber: -1 }).lean();
    expect(v.provenance.origin).toBe("SALES_PREPARATION");
    expect(v.scenarios.length).toBeGreaterThan(0);
  });

  test("an identical retry creates nothing — the FINGERPRINT decides, not the key", async () => {
    /* Sales refreshing the page, or pressing the button twice, must not fill
       the history with versions that say the same thing. */
    const w = await world();
    await brief(w);
    const first = await prepare(w);
    expect(first.outcome).toBe("PREPARED");

    const again = await prepare(w);
    expect(again.outcome).toBe("UNCHANGED");
    /* Under a DIFFERENT key, too — the key guards a lost response; the
       fingerprint guards a deliberate second press. */
    const third = await prepare(w, "a-different-key");
    expect(third.outcome).toBe("UNCHANGED");

    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    expect(await CostingVersion.countDocuments({ costingId: costing._id })).toBe(2);
  });

  test("one key pressed on two enquiries is two estimates, not one handed over twice", async () => {
    /* ── THE COLLISION THIS CLOSES ────────────────────────────────────────
       The creation claim is `{company, actor, operation, key}` hashed. Leave
       the SUBJECT out of it, as the HTTP middleware does, and the same action
       key used on a second enquiry hashes to the same claim.
       
       The middleware can afford that: it stores the target beside the claim
       and refuses the mismatch as `IDEMPOTENCY_KEY_REUSED`. Nothing stores a
       target on a costing's creation claim, so here the collision would not
       be caught — it would be RECOVERED, and the second enquiry would be
       handed the first enquiry's costing. The wrong garment, silently, under
       a claim asserting the action had already succeeded.

       Two enquiries, one key, one actor, one company: two costings. */
    const w = await world();
    await brief(w);
    const other = await seedSourceBacked(w.co._id, {
      ...EVERY_FAMILY, paymentTerms: { ...CONFIRMED_TERMS }, brief: null,
    });
    await confirmCostingBrief(w.co._id, {
      enquiryId: other.enquiry._id, styleId: other.style._id,
    });

    const key = "one-key-two-enquiries";
    const first = await prepare(w, key);
    const second = await prep.prepare(w.ctx, {
      enquiryId: other.enquiry._id,
      product: other.context.externalKey,
      actionKey: key,
    });

    expect(first.outcome).toBe("PREPARED");
    expect(second.outcome).toBe("PREPARED");
    expect(String(second.costingId)).not.toBe(String(first.costingId));
    expect(await Costing.countDocuments({ companyId: w.co._id })).toBe(2);

    /* And each names its own enquiry product — the point of the whole thing. */
    const a = await Costing.findById(first.costingId).lean();
    const b = await Costing.findById(second.costingId).lean();
    expect(String(a.context.primaryId)).toBe(String(w.seeded.enquiry._id));
    expect(String(b.context.primaryId)).toBe(String(other.enquiry._id));

    /* ── AND THE VERSION RECORDS WHAT ITS CLAIM WAS A CLAIM ON ─────────
       `creationClaimTarget` was declared on the schema and written by nothing
       for a long time — always "", so the cross-costing check leaned entirely
       on `costingId`. The orchestration writes it, and the comparison in
       `versionCreation.claimMismatch` reads it. */
    const va = await CostingVersion.findOne({ costingId: first.costingId })
      .sort({ versionNumber: -1 }).lean();
    expect(va.provenance.creationClaimTarget).toBe(`costing:${first.costingId}`);
  });

  test("the version freezes what it was calculated from", async () => {
    const w = await world();
    await brief(w);
    await prepare(w);
    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    const v = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();

    expect(v.provenance.sourceFingerprint).toBeTruthy();
    expect(v.provenance.sourceFingerprintParts.length).toBeGreaterThan(3);
    /* ── A TOKEN, NEVER A FIGURE ──────────────────────────────────────
       A quotation contributes its identity and revision; a Board policy its
       id and effective date. No rate, no salary, no percentage. */
    const parts = v.provenance.sourceFingerprintParts;
    expect(parts.some((p) => p.key === "brief")).toBe(true);
    expect(parts.every((p) => p.token.length <= 200)).toBe(true);
    expect(parts.map((p) => p.owner)).toContain("Sales");
  });
});

/* ═══ 4 · WHAT MAKES IT STALE ════════════════════════════════════════════ */

describe("when the inputs move", () => {
  async function costedWorld(over = {}) {
    const w = await world(over);
    await brief(w);
    await prepare(w);
    return w;
  }

  test("a changed brief revision is detected and named", async () => {
    const w = await costedWorld();
    const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities.push({
      key: "q2000", label: "2000", quantity: "2000", isPrimary: false,
    });
    enquiry.costingBriefs[0].revision += 1;
    enquiry.markModified("costingBriefs");
    await enquiry.save();

    const r = await resolve(w);
    expect(r.state).toBe(prep.STATE.INPUTS_CHANGED);
    expect(r.freshness.stale).toBe(true);
    expect(r.freshness.changed.map((c) => c.owner)).toContain("Sales");

    const out = await prepare(w);
    expect(out.outcome).toBe("REVISED");
  });

  test("a changed Store sourcing decision is detected", async () => {
    /* The most common way an estimate goes stale, and the rate never
       travels: the token is the offer's identity and revision. */
    const w = await costedWorld();
    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    const before = await CostingVersion.findOne({ costingId: costing._id })
      .sort({ versionNumber: -1 }).lean();

    /* ── A QUOTATION IS IMMUTABLE, SO STORE WITHDRAWS IT ──────────────
       Somebody was quoted it. Store supersedes or withdraws rather than
       editing, and a withdrawn quotation is exactly the change this is
       about: the material has no applicable rate any more. */
    const SupplierOffer = require("../../models/CMS_Models/Inventory/Sourcing/SupplierOffer");
    const offer = await SupplierOffer.findOne({ companyId: w.co._id, itemId: w.seeded.item._id });
    await SupplierOffer.collection.updateOne({ _id: offer._id }, { $set: { status: "WITHDRAWN" } });

    const r = await resolve(w);
    expect(r.freshness.stale).toBe(true);
    expect(r.freshness.changed.map((c) => c.owner)).toContain("Store / Purchase");
    /* And the frozen version is untouched by the discovery. */
    const after = await CostingVersion.findById(before._id).lean();
    expect(after.provenance.sourceFingerprint).toBe(before.provenance.sourceFingerprint);
  });

  test("a changed technical revision is detected, and named as R&D's", async () => {
    const w = await costedWorld();
    await SampleStyle.updateOne({ _id: w.seeded.style._id }, {
      $set: { "techSheet.technical.revision": 9 },
      $push: {
        "techSheet.technicalRevisions": {
          revision: 9, outcome: "approved",
          submittedAt: new Date("2026-08-01"), submittedBy: { name: "R&D" },
          decidedAt: new Date("2026-08-02"), decidedByName: "Sales",
          snapshot: { materials: [] },
        },
      },
    });
    const r = await resolve(w);
    expect(r.freshness.stale).toBe(true);
    expect(r.freshness.changed.map((c) => c.owner)).toContain("R&D");
  });

  test("a version frozen before fingerprints existed is not reported as stale", async () => {
    /* Every historical costing in the company lighting up is a warning
       nobody reads twice. */
    const w = await costedWorld();
    const costing = await Costing.findOne({ companyId: w.co._id }).lean();
    await CostingVersion.collection.updateOne(
      { costingId: costing._id, versionNumber: 2 },
      { $unset: { "provenance.sourceFingerprint": "", "provenance.sourceFingerprintParts": "" } },
    );
    const r = await resolve(w);
    expect(r.freshness.comparable).toBe(false);
    expect(r.freshness.stale).toBe(false);
  });

  test("an APPROVED version is never restated by a later source change", async () => {
    const w = await costedWorld();
    const costing = await Costing.findOne({ companyId: w.co._id });
    const v = await CostingVersion.findOne({ costingId: costing._id }).sort({ versionNumber: -1 });
    await CostingVersion.collection.updateOne({ _id: v._id }, { $set: { status: "APPROVED" } });
    const frozen = await CostingVersion.findById(v._id).lean();

    const enquiry = await Enquiry.findById(w.seeded.enquiry._id);
    enquiry.costingBriefs[0].revision += 1;
    enquiry.markModified("costingBriefs");
    await enquiry.save();

    const out = await prepare(w);
    expect(out.outcome).toBe("REVISED");
    /* A new DRAFT beside it; the approved one is byte-for-byte what it was. */
    expect(await CostingVersion.findById(v._id).lean()).toEqual(frozen);
  });
});

/* ═══ 5 · WHAT SALES MAY SEE ═════════════════════════════════════════════ */

describe("the Sales result", () => {
  test("carries the commercial answer and none of the evidence", async () => {
    const w = await world();
    await brief(w, [{ key: "q500", quantity: "500", isPrimary: true, proposedSellingPriceExclTax: "420" }]);
    const out = await prepare(w);
    const view = result.resultFor({ resolved: out, caps: w.ctx.capabilitySet });

    expect(view.scenarios[0].quantity).toBe("500");
    /* ── ONE FLOOR, NOT THREE TIERS ───────────────────────────────────
       This asserted `guidance.minimumPriceMinor` — the retired band. A new
       version is priced by one management markup, publishes one floor, and
       publishes the three tiers as null rather than synthesising them. */
    expect(view.scenarios[0].pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(view.scenarios[0].floorPriceMinor).toBeGreaterThan(0);
    expect(view.scenarios[0].guidance).toBeNull();
    expect(view.estimate.versionNumber).toBeGreaterThan(0);

    /* ── AND NOTHING PROTECTED ────────────────────────────────────────
       No supplier, no quotation reference, no material rate, no salary, no
       cost-per-minute, no Board percentage, no line at all. */
    const text = JSON.stringify(view).toLowerCase();
    for (const leak of [
      "supplier", "quotation", "offerid", "salary", "perminute",
      "overheadrate", "marginpercent", "rawitem", "linekey", "unitratemin",
    ]) {
      expect(text).not.toContain(leak);
    }
  });

  test("a cost figure is withheld from a reader who may not see cost", async () => {
    const w = await world();
    await brief(w);
    const out = await prepare(w);
    /* The same projection, a narrower capability set. */
    const salesOnly = result.resultFor({
      resolved: out, caps: new Set(["costing.output.read"]),
    });
    expect("unitCostMinor" in salesOnly.scenarios[0]).toBe(false);
    /* And the floor still travels — it is what they quote against. */
    expect(salesOnly.scenarios[0].floorPriceMinor).toBeGreaterThan(0);
    /* ── AND THE MARKUP THAT PRODUCED IT DOES NOT ─────────────────────
       The floor alone. The percentage is the Board's decision, and the cost
       is recoverable from floor minus markup — so neither crosses. */
    const salesBody = JSON.stringify(salesOnly);
    expect(salesBody).not.toContain("floorMarkupPercent");
    expect(salesBody).not.toContain("markupAmountMinor");
    expect(salesBody).not.toContain("trueUnitCostMinor");
  });

  test("the bridge is read where it is actually STORED, not where it is serialised", () => {
    /* ── THE SHAPE THIS TEST USED TO INVENT ───────────────────────────
       It passed `{ margin: { bridge: { scenarios: [...] } } }` — the name
       `visibility.js` gives the bridge in an API RESPONSE. The stored
       document has always called it `commercial.bridge`, and `resultFor`
       passes the stored document. So the old assertion proved the function
       could read a shape production never sends, while every real scenario
       came back unjudged.

       Both are accepted now, and the STORED one is what is asserted. */
    const stored = { commercial: { bridge: [
      { scenarioKey: "q", standing: "BELOW_FLOOR", floorPriceMinor: 60000, proposedPriceExclTaxMinor: 50000 },
    ] } };
    const fromStored = result.marginFor(stored, "q");
    expect(fromStored.priced).toBe(true);
    expect(fromStored.standing).toBe("BELOW_FLOOR");
    expect(fromStored.floorStatus).toBe("BELOW_FLOOR");
    expect(fromStored.approvalRequired).toBe(true);
  });

  test("the three floor states, and equal counts as at or above", () => {
    const at = (proposed, floor) =>
      result.marginFor({}, "q", { floorPriceMinor: floor, proposedPriceMinor: proposed });

    expect(at(70000, 60000).floorStatus).toBe("AT_OR_ABOVE_FLOOR");
    /* ── EXACTLY AT THE FLOOR IS ALLOWED ──────────────────────────────
       The floor is the lowest price the company will sell at, so selling AT
       it is permitted. A strict `>` would send perfectly good quotations
       for management approval. */
    expect(at(60000, 60000).floorStatus).toBe("AT_OR_ABOVE_FLOOR");
    expect(at(60000, 60000).approvalRequired).toBe(false);
    expect(at(59999, 60000).floorStatus).toBe("BELOW_FLOOR");
    expect(at(59999, 60000).approvalRequired).toBe(true);

    /* No floor to judge against is NOT "fine" — it is unavailable. */
    expect(at(70000, null).floorStatus).toBe("UNAVAILABLE");
    expect(at(70000, null).approvalRequired).toBe(false);
    expect(result.marginFor({}, "q").floorStatus).toBeNull();

    expect(result.FLOOR_STATUS_LABEL.AT_OR_ABOVE_FLOOR).toBe("At or above floor");
    expect(result.FLOOR_STATUS_LABEL.BELOW_FLOOR).toBe("Below floor — management approval required");
    expect(result.FLOOR_STATUS_LABEL.UNAVAILABLE).toBe("Floor unavailable / inputs incomplete");
  });

  test("the engine's own verdict outranks a comparison made here", () => {
    /* Where the engine judged the price, Sales is told what IT judged. A
       second opinion computed from today's figures could disagree with the
       record, and the record is what was actually decided. */
    const judged = { commercial: { bridge: [
      { scenarioKey: "q", standing: "AT_OR_ABOVE_FLOOR", floorPriceMinor: 60000, proposedPriceExclTaxMinor: 60000 },
    ] } };
    const out = result.marginFor(judged, "q", { floorPriceMinor: 99999, proposedPriceMinor: 1 });
    expect(out.floorStatus).toBe("AT_OR_ABOVE_FLOOR");
    expect(out.approvalRequired).toBe(false);
  });

  test("a frozen band version keeps its OWN vocabulary, and never gains a floor", () => {
    /* ── TWO POLICIES, TWO RULES, NOT ONE TRANSLATED INTO THE OTHER ───
       `BELOW_MINIMUM` is not `BELOW_FLOOR`. They were decided under
       different policies and mean different things, so a historical
       standing is never restated in floor words — `WITHIN_POLICY` and
       `MEETS_TARGET` would otherwise read as clearing a floor that did not
       exist when the version was approved.

       A band version keeps its own standing and the sentence written when
       it was judged, carries NO floor status, and is marked historical. */
    const band = (standing) => result.marginFor(
      { commercial: { bridge: [{ scenarioKey: "q", standing }] } }, "q",
      { pricingContract: "MARGIN_BAND_V1" },
    );

    for (const standing of ["BELOW_MINIMUM", "WITHIN_POLICY", "MEETS_TARGET", "NO_POLICY"]) {
      const out = band(standing);
      expect(out.standing).toBe(standing);
      expect(out.standingLabel).toBe(profitBridge.STANDING_LABEL[standing]);
      expect(out.historical).toBe(true);
      /* The three-state floor vocabulary applies to MARKUP_FLOOR_V2 alone. */
      expect(out.floorStatus).toBeNull();
      expect(out.floorStatusLabel).toBeNull();
      /* ── AND NEVER THE NEW APPROVAL INDICATOR ─────────────────────
         Management approval against a floor cannot be required by a version
         that was never judged against one. */
      expect(out.approvalRequired).toBe(false);
    }

    /* No floor is inferred for it even when one could arithmetically be
       computed from a proposed price. */
    const withFigures = result.marginFor({}, "q", {
      pricingContract: "MARGIN_BAND_V1", floorPriceMinor: 60000, proposedPriceMinor: 1,
    });
    expect(withFigures.floorStatus).toBeNull();
    expect(withFigures.approvalRequired).toBe(false);
    expect(withFigures.historical).toBe(true);
  });

  test("a floor-priced version is never marked historical", () => {
    const out = result.marginFor(
      { commercial: { bridge: [{ scenarioKey: "q", standing: "BELOW_FLOOR" }] } }, "q",
      { pricingContract: "MARKUP_FLOOR_V2" },
    );
    expect(out.historical).toBe(false);
    expect(out.floorStatus).toBe("BELOW_FLOOR");
    expect(out.approvalRequired).toBe(true);
  });

  test("a floor-priced scenario never falls back to the retired tiers", () => {
    const caps = new Set(["costing.output.read"]);
    /* ₹500 true cost at the approved 20% markup is ₹600 — never ₹625, which
       is what the retired margin formula produced from the same inputs. */
    const floor = result.scenarioFor(
      { key: "q", quantity: "500", floor: { floorPriceMinor: 60000, floorMarkupPercent: "20",
        trueUnitCostMinor: 50000, markupAmountMinor: 10000 } }, caps,
    );
    expect(floor.pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(floor.floorPriceMinor).toBe(60000);
    expect(floor.floorPriceMinor).not.toBe(62500);
    expect(floor.guidance).toBeNull();
    const body = JSON.stringify(floor);
    for (const secret of ["floorMarkupPercent", "trueUnitCostMinor", "markupAmountMinor"]) {
      expect(body).not.toContain(secret);
    }

    /* Even with no floor figure, it does NOT reach for a minimum. */
    const unpriced = result.scenarioFor({ key: "q", quantity: "500", floor: {} }, caps);
    expect(unpriced.pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(unpriced.floorPriceMinor).toBeNull();
    expect(unpriced.guidance).toBeNull();

    /* And a genuine band scenario keeps all three, with no floor invented. */
    const band = result.scenarioFor({ key: "q", quantity: "500", prices: {
      minimum: { priceMinor: 14000 }, target: { priceMinor: 15500 }, preferred: { priceMinor: 17000 },
    } }, caps);
    expect(band.pricingContract).toBe("MARGIN_BAND_V1");
    expect(band.guidance.minimumPriceMinor).toBe(14000);
    expect(band.floorPriceMinor).toBeNull();
  });
});

/* ═══ 6 · COMPANY ISOLATION ══════════════════════════════════════════════ */

describe("scope", () => {
  test("another company's enquiry is not found, rather than refused", async () => {
    const mine = await world();
    const theirs = await world();
    await brief(theirs);
    await expect(prep.resolve(mine.ctx, {
      enquiryId: theirs.seeded.enquiry._id, product: theirs.product,
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(prep.prepare(mine.ctx, {
      enquiryId: theirs.seeded.enquiry._id, product: theirs.product, actionKey: "x",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await Costing.countDocuments({ companyId: theirs.co._id })).toBe(0);
  });
});

/* ═══ 7 · THE READINESS MODEL, EXTENDED CLEANLY ══════════════════════════ */

describe("the brief as a readiness prerequisite", () => {
  test("it is CALCULATION-scoped and carries no cost family", async () => {
    /* Giving it a family would invent a cost that never appears in a
       build-up. */
    const r = sourceApps.REQUIREMENTS.find((x) => x.key === "SALES_COSTING_BRIEF");
    expect(r.scope).toBe(sourceApps.SCOPE.CALCULATION);
    expect(r.family).toBeNull();
    expect(r.sourceApp).toBe("SALES");
    /* And every other requirement still declares a family. */
    for (const other of sourceApps.REQUIREMENTS.filter((x) => x.scope === sourceApps.SCOPE.FAMILY)) {
      expect(other.family).toBeTruthy();
    }
  });
});

/* ═══ 8 · LANE B'S POLICIES ARE READ, NEVER WRITTEN ══════════════════════ */

test("nothing in this task writes a Board policy", () => {
  const { readFileSync } = require("fs");
  const bare = (rel) => readFileSync(require("path").join(__dirname, "../..", rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  for (const rel of [
    "services/sales/costingPreparation.service.js",
    "services/sales/costingResult.service.js",
    "services/centralCosting/sourceFingerprint.service.js",
  ]) {
    const src = bare(rel);
    expect(src).not.toMatch(/boardPolicy\.(createDraft|approve|save)/);
    expect(src).not.toMatch(/require\(["'][^"']*(board\/|contingencyPolicy|marginPolicy|overheadPolicy|labourPolicy|gstPolicy)/);
  }
  /* The fingerprint READS a Board policy's identity, which is the point — and
     never its value. */
  const fp = bare("services/centralCosting/sourceFingerprint.service.js");
  expect(fp).toMatch(/boardPolicyId/);
  expect(fp).not.toMatch(/ratePercent|Percent:/);
});

/* ═══ 6 · THE VERSION SHOWN IS THE ONE THAT PRICES THE CONFIRMED ORDER ════ */

describe("a revised commercial quantity", () => {
  /**
   * ── THE DEFECT THIS CLOSES ────────────────────────────────────────────────
   * `resultFor` read `approvedVersion || latestVersion`, so an APPROVED
   * version always won. That is right when both price the same order and wrong
   * the moment the commercial quantity moves.
   *
   * Live state on SJ-SB-1, 11 Sep: the enquiry's own product row said 500, the
   * commercial line said 750, version 2 was APPROVED for 500 at ₹599, and
   * version 3 was calculated for 750 at ₹590. The page chose version 2 — so it
   * reported "no floor price calculated for 750" while holding a ₹599 floor
   * for an order nobody was placing, and the ₹590 that HAD been calculated was
   * never sent to the client at all.
   *
   * The version is now chosen by the quantity first and its approval second.
   */
  const versionFor = (quantity, floorMinor, over = {}) => ({
    versionNumber: over.versionNumber || 1,
    status: over.status || "CALCULATED",
    baseCurrency: "INR",
    calculation: { calculatedAt: new Date("2026-09-11") },
    scenarios: [{
      key: over.key || `q${quantity}`,
      quantity: String(quantity),
      quantityUom: "Pieces",
      floor: { floorPriceMinor: floorMinor, markupPercent: 20 },
    }],
    commercial: { proposedPrices: [] },
  });

  /** The exact state from the failed rendered QA. */
  const contradictory = {
    state: "READY",
    brief: { quantities: [{ key: "commercial", quantity: "750", isPrimary: true }] },
    approvedVersion: versionFor(500, 59900, { versionNumber: 2, status: "APPROVED", key: "q500" }),
    latestVersion: versionFor(750, 59000, { versionNumber: 3, key: "commercial" }),
    blockers: [],
    freshness: { stale: false },
  };

  /* A Sales reader's own capability: the floor is published, the cost is not.
     Exactly what the Cost & Invoicing page asks with. */
  const caps = new Set(["costing.output.read"]);

  test("the calculated 750 version is shown, not the approved 500 one", async () => {
    const view = result.resultFor({ resolved: contradictory, caps });

    expect(view.confirmedQuantity).toBe(750);
    expect(view.estimate.versionNumber).toBe(3);
    /* And it is labelled honestly: showing it does not make it approved. */
    expect(view.estimate.isApproved).toBe(false);
  });

  test("only the confirmed quantity's floor travels — ₹590, never ₹599", async () => {
    const view = result.resultFor({ resolved: contradictory, caps });

    expect(view.scenarios).toHaveLength(1);
    expect(view.scenarios[0].quantity).toBe("750");
    expect(view.scenarios[0].floorPriceMinor).toBe(59000);

    /* ── THE 500-PIECE FIGURE IS NOWHERE IN THE RESPONSE ──────────────
       Not filtered on the client: a client that filtered would be the
       place somebody later "fixed" it back into view. */
    const body = JSON.stringify(view);
    expect(body).not.toContain("59900");
    expect(body).not.toContain('"500"');
  });

  test("a version carrying BOTH quantities publishes only the confirmed one", async () => {
    /* ── WHERE THE FILTER ACTUALLY BITES ──────────────────────────────
       Choosing the right VERSION is not enough. One version can carry
       several scenarios — a brief with two run sizes produces exactly
       that — so the version priced for 750 may also hold the 500 it was
       calculated beside. Sales is quoting one order, and the other
       order's floor must not arrive on the same response for a screen to
       pick the first of. */
    const both = {
      ...contradictory,
      approvedVersion: null,
      latestVersion: {
        versionNumber: 3,
        status: "CALCULATED",
        baseCurrency: "INR",
        calculation: { calculatedAt: new Date("2026-09-11") },
        scenarios: [
          { key: "q500", quantity: "500", quantityUom: "Pieces", floor: { floorPriceMinor: 59900 } },
          { key: "q750", quantity: "750", quantityUom: "Pieces", floor: { floorPriceMinor: 59000 } },
        ],
        commercial: { proposedPrices: [] },
      },
    };

    const view = result.resultFor({ resolved: both, caps });

    expect(view.scenarios).toHaveLength(1);
    expect(view.scenarios[0].quantity).toBe("750");
    expect(view.scenarios[0].floorPriceMinor).toBe(59000);
    const body = JSON.stringify(view);
    expect(body).not.toContain("59900");
    expect(body).not.toContain('"500"');
  });

  test("an approved version for the confirmed quantity still wins", async () => {
    /* The rule is quantity FIRST, approval second — not approval never. */
    const view = result.resultFor({
      resolved: {
        ...contradictory,
        approvedVersion: versionFor(750, 59000, { versionNumber: 4, status: "APPROVED", key: "commercial" }),
      },
      caps,
    });
    expect(view.estimate.versionNumber).toBe(4);
    expect(view.estimate.isApproved).toBe(true);
    expect(view.scenarios[0].quantity).toBe("750");
  });

  test("with nothing priced for the confirmed quantity, no floor is invented", async () => {
    /* Before version 3 existed. The approved 500 version is all there is,
       and the honest answer is that this order has no floor — never the
       other order's. */
    const view = result.resultFor({
      resolved: { ...contradictory, latestVersion: contradictory.approvedVersion },
      caps,
    });
    expect(view.confirmedQuantity).toBe(750);
    expect(view.scenarios.some((s) => s.quantity === "750")).toBe(false);
  });

  test("the frozen 500-piece version is not edited by any of this", async () => {
    /* Projection only. The historical record keeps every scenario it was
       calculated with — what changed is which of them Sales is shown. */
    const approved = contradictory.approvedVersion;
    result.resultFor({ resolved: contradictory, caps });
    expect(approved.scenarios).toHaveLength(1);
    expect(approved.scenarios[0].quantity).toBe("500");
    expect(approved.scenarios[0].floor.floorPriceMinor).toBe(59900);
  });

  test("a costing with no confirmed brief publishes what it always did", async () => {
    /* Historical compatibility: no commercial line behind it, so there is no
       quantity to filter to and nothing is withheld. */
    const view = result.resultFor({
      resolved: { ...contradictory, brief: null },
      caps,
    });
    expect(view.confirmedQuantity).toBeNull();
    expect(view.scenarios).toHaveLength(1);
    expect(view.scenarios[0].quantity).toBe("500");
  });
});
