// test/costing/board-margin-policy.test.js
//
// THE COMPANY'S PRICING FLOOR: ONE MANAGEMENT MARKUP.
//
// ── THE ONLY POLICY WHOSE ABSENCE STOPS A COSTING ───────────────────────────
// Overhead, labour, GST, development charges, contingency and duty are costs
// the engine adds or does not add: a company missing one still gets a costing
// with the gap named. This one is what every price is derived FROM —
//
//     floor selling price = true unit cost × (1 + markup/100)
//
// — so a company without it has no selling price at all. `engine.js` reads the
// markup as REQUIRED and refuses `undefined`.
//
// ── MARKUP, NOT MARGIN, AND THE DIFFERENCE IS MONEY ─────────────────────────
// This policy replaced a three-band margin model. On a ₹500 cost at 20%:
//
//     markup  →  500 × 1.20        = ₹600     ← what this calculates
//     margin  →  500 ÷ (1 − 0.20)  = ₹625     ← what it used to
//
// Nothing converts one into the other. A company's approved 20% margin is not
// a 20% markup, and re-reading it as one would move every floor price in the
// company without anybody deciding to — so a company on the old band has NO
// floor until its Board states a markup deliberately.
//
// ── AND THE LINEAGE IS ONE POLICY, NOT TWO ──────────────────────────────────
// The key stays `MARGIN_POLICY`: it is what every frozen version names, what
// the effective-date supersession index is built on, and what a company's
// approval history hangs off. A second key would have orphaned all of that and
// allowed two pricing policies in force at once. The CONTRACT is versioned
// instead — `MARGIN_BAND_V1` is history, `MARKUP_FLOOR_V2` is decided now.
//
// Three states, and they are different records:
//   no policy          → no price, refused by name
//   approved band      → a real historical decision that cannot price a NEW
//                        costing, refused by a DIFFERENT name
//   approved markup    → the floor
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
const AccessDepartment = require("../../models/Access/AccessDepartment");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const BoardPolicy = require("../../models/CMS_Models/Board/BoardPolicy");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const marginPolicy = require("../../services/centralCosting/marginPolicy.service");
/* The only route to a three-band policy: the service refuses to create one,
   which is the migration working. A suite proving history still reads has to
   be able to seed the thing the service will not make. */
const { seedHistoricalBandPolicy } = require("./helpers/sourceBacked");

let server, base, rs, seq = 0;

const KEY = "MARGIN_POLICY";
/* The retired band, kept only for the fixtures that seed HISTORY. */
const BAND = { minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32" };
/* The active shape: one figure. 20% because it is the acceptance example. */
const MARKUP = { floorMarkupPercent: "20" };

beforeAll(async () => {
  await mongoose.disconnect();
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: "wiredTiger" } });
  await mongoose.connect(rs.getUri(), { dbName: "board_margin" });
  const app = express();
  app.use(express.json());
  app.use("/api/cms/board/policies", require("../../routes/CMS_Routes/Board/policies"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/cms/board/policies`;
  await BoardPolicy.init();
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  await mongoose.disconnect();
  if (rs) await rs.stop();
});

const call = (path, { token, company, method = "GET", body } = {}) =>
  fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(company ? { "X-Costing-Company": String(company) } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }).then(async (r) => ({ status: r.status, body: JSON.parse((await r.text()) || "null") }));

const company = (name) => Acc_Company.create({
  companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01"),
});


/* ── A GRANT IS A DEPARTMENT AND A ROLE ──────────────────────────────────────
   Access Control writes both, and `services/board/boardAccess.js` requires
   both: a role row with nobody holding the department is a row, not a person —
   which is how "only employees with HR records hold Board" is enforced in the
   guard rather than only on the screen that writes the row.

   These fixtures used to write the role alone. Created on demand rather than in
   `beforeAll` because `test/setup.js` empties every collection after each
   test. */
const deptRow = (slug) => AccessDepartment.findOneAndUpdate(
  { slug },
  { $setOnInsert: { slug, key: slug, name: slug, dashboardPath: `/${slug}` } },
  { upsert: true, new: true },
).lean();

async function actor({ companies = [], grants = {}, isAdmin = false } = {}) {
  const n = ++seq;
  const email = `mg${n}@grav.test`;
  const emp = await Employee.create({
    firstName: "M", lastName: `G${n}`, email, biometricId: `MG${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  await DeptUser.create({
    name: "User", email, passwordHash: "x", isAdmin, isActive: true,
    departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
  });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "M" });
  }
  const held = [];
  for (const [departmentSlug, role] of Object.entries(grants)) {
    const dept = await deptRow(departmentSlug);
    held.push(dept._id);
    await DepartmentRole.create({
      departmentSlug, email, name: "User", role, isActive: true,
      departmentId: dept._id,
    });
  }
  if (held.length) {
    await Employee.updateOne({ _id: emp._id }, { $set: { additionalDepartmentIds: held } });
  }
  return {
    email,
    token: jwt.sign(
      { id: String(emp._id), email, name: `Board ${n}`, role: "employee", isAdmin, employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const startDraft = (me, co, body = {}) =>
  call(`/${KEY}/drafts`, { method: "POST", token: me.token, company: co._id, body });

const approveDraft = (me, co, id, effectiveFrom) =>
  call(`/${KEY}/drafts/${id}/approve`, {
    method: "POST", token: me.token, company: co._id, body: { effectiveFrom },
  });

async function publish(me, co, margin, { effectiveFrom = "2026-04-01", rationale = "Board minute." } = {}) {
  const started = await startDraft(me, co, { margin, rationale });
  if (started.status !== 201) return started;
  return approveDraft(me, co, started.body.version._id, effectiveFrom);
}

const read = (me, co) => call(`/${KEY}`, { token: me.token, company: co._id });
const effective = (res) =>
  (res.body.versions || []).find((v) => String(v._id) === String(res.body.effectiveId)) || null;

/* ═══ 1 · MISSING, A BAND, AND A MARKUP ARE THREE DIFFERENT RECORDS ══════ */

describe("missing, a legacy band and a markup are three different records", () => {
  test("no policy resolves as missing, and fills NOTHING", async () => {
    const co = await company("Undecided");
    const resolved = await marginPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("POLICY_MISSING");
    expect(resolved.floorMarkupPercent).toBeNull();
    /* ── NOT ZERO ─────────────────────────────────────────────────────
       The engine accepts a zero markup and would price every garment at cost.
       Filling nothing makes it refuse instead, which is the correct outcome. */
    expect(marginPolicy.overlayFor(resolved)).toEqual({
      floorMarkupPercent: undefined,
      minimumMarginPercent: undefined,
      targetMarginPercent: undefined,
      preferredMarginPercent: undefined,
      approvalThresholdMarginPercent: undefined,
      estimatedIncomeTaxRatePercent: undefined,
    });
    expect(resolved.missing[0].owner.department).toBe("Board");
    expect(resolved.missing[0].message).toMatch(/no floor price/);
  });

  test("an approved markup of 0% IS applied — it is a decision somebody signed", async () => {
    const co = await company("ApprovedNil");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, { floorMarkupPercent: "0" })).status).toBe(200);

    const resolved = await marginPolicy.resolveFor({ companyId: co._id });
    expect(resolved.state).toBe("APPLIED");
    /* Selling at cost is a decision a Board can take. It is not the same
       record as never having decided, and the floor it produces is the cost
       itself rather than an absence. */
    expect(marginPolicy.overlayFor(resolved).floorMarkupPercent).toBe("0");
    expect(marginPolicy.floorPriceMinorOn(50000, "0", { increment: 100 })).toBe(50000);
    expect(resolved.state).not.toBe("POLICY_MISSING");
  });

  test("a markup fills the one name the engine prices from", async () => {
    const co = await company("RealMarkup");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, { floorMarkupPercent: "20" })).status).toBe(200);
    const resolved = await marginPolicy.resolveFor({ companyId: co._id });
    /* The one active figure, and every retired name explicitly empty — so
       nothing downstream can find a band on a floor policy and price a tier
       from it. */
    expect(marginPolicy.overlayFor(resolved)).toEqual({
      floorMarkupPercent: "20",
      minimumMarginPercent: undefined,
      targetMarginPercent: undefined,
      preferredMarginPercent: undefined,
      approvalThresholdMarginPercent: undefined,
      estimatedIncomeTaxRatePercent: undefined,
    });
  });

  test("₹500 at 20% markup is a ₹600 floor — never ₹625", async () => {
    /* ── THE ACCEPTANCE EXAMPLE, PINNED ───────────────────────────────
       The single most important number in this policy. ₹625 is what the
       retired margin formula produced from the same two inputs, so it is
       asserted against BY NAME: a regression that reinstated the old
       arithmetic would still produce a plausible price, and only this
       comparison catches it. */
    expect(marginPolicy.floorPriceMinorOn(50000, "20", { increment: 100 })).toBe(60000);
    expect(marginPolicy.floorPriceMinorOn(50000, "20", { increment: 100 })).not.toBe(62500);
  });

  test("a legacy band is a real record that cannot price a new costing", async () => {
    /* ── AND IT IS NOT THE SAME REFUSAL AS HAVING NO POLICY ───────────
       A company on the old band HAS an approved decision. Telling it that it
       has none would be false, and would send the Board looking for something
       it already did. It is refused for a different reason, with different
       words: what it lacks is a markup. */
    const legacy = marginPolicy.floorOf({
      margin: {
        pricingContract: "MARGIN_BAND_V1",
        minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32",
      },
    });
    expect(legacy.state).toBe("LEGACY_BAND");
    expect(legacy.floorMarkupPercent).toBeNull();
    expect(legacy.missing[0].message).toMatch(/an old margin is not one/);
    /* ── AND NOTHING CONVERTS IT ──────────────────────────────────────
       18% margin is 21.95% markup. If any code did that arithmetic silently,
       this company's floor would move without an approval — so the resolved
       record carries no markup at all, converted or otherwise. */
    expect(JSON.stringify(legacy)).not.toMatch(/21\.9|22\.0|25\.0/);
  });
});

/* ═══ 2 · WHAT A MARKUP MUST STATE ════════════════════════════════════════ */

describe("what a pricing policy must state", () => {
  test("a markup, or it cannot be approved", async () => {
    const co = await company("Partial");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await publish(me, co, {});
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("BOARD_POLICY_INCOMPLETE");
    expect(r.body.error.details.gaps.map((g) => g.field)).toEqual(["floorMarkupPercent"]);
  });

  test("a negative markup is refused — a floor below cost is not a floor", async () => {
    const co = await company("Negative");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await startDraft(me, co, { margin: { floorMarkupPercent: "-5" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.field).toBe("floorMarkupPercent");
  });

  test("100% is a doubling, not a division by zero — accepted", async () => {
    /* ── THE BOUND THAT WENT AWAY WITH THE FORMULA ────────────────────
       A MARGIN of 100% was impossible: `cost / (1 - 1)` divides by zero. A
       markup of 100% is an ordinary doubling and 150% is an ordinary
       commercial decision, so the old ceiling would now refuse real
       policies. */
    const co = await company("Hundred");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, { floorMarkupPercent: "100" })).status).toBe(200);
    expect(marginPolicy.floorPriceMinorOn(50000, "100", { increment: 100 })).toBe(100000);
    expect(marginPolicy.floorPriceMinorOn(50000, "150", { increment: 100 })).toBe(125000);
  });

  test("the four retired band inputs are refused by name, not ignored", async () => {
    /* Refused rather than dropped: a body answered 200 while nothing it sent
       was stored would let somebody believe the company's floor had moved. */
    const co = await company("Retired");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    for (const field of [
      "minimumMarginPercent", "targetMarginPercent", "preferredMarginPercent",
      "approvalThresholdMarginPercent",
    ]) {
      const r = await startDraft(me, co, { margin: { [field]: "20" } });
      expect([field, r.status]).toEqual([field, 400]);
      expect([field, r.body.error.details.reason]).toEqual([field, "MARGIN_BAND_RETIRED"]);
      expect([field, r.body.error.details.use]).toEqual([field, "floorMarkupPercent"]);
    }
  });

  test("and so is the income-tax estimate, which is not a pricing input", async () => {
    const co = await company("Tax");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const r = await startDraft(me, co, { margin: { estimatedIncomeTaxRatePercent: "25" } });
    expect(r.status).toBe(400);
    expect(r.body.error.details.reason).toBe("NOT_A_PRICING_INPUT");
  });

  test("the markup is stored as an exact decimal string, not a float", async () => {
    const co = await company("Exact");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, { floorMarkupPercent: "17.5" })).status).toBe(200);
    const resolved = await marginPolicy.resolveFor({ companyId: co._id });
    expect(resolved.floorMarkupPercent).toBe("17.5");
    /* ₹500 at 17.5% is ₹587.50 exactly. */
    expect(marginPolicy.floorPriceMinorOn(50000, "17.5", { increment: 1 })).toBe(58750);
  });
});

/* ═══ 3 · WHAT THE OLD POLICY CARRIED, AND WHERE IT WENT ═════════════════ */

describe("the retired band, as history", () => {
  test("a version approved under the band still reads back exactly what it froze", async () => {
    /* ── THE WHOLE POINT OF EVOLVING THE LINEAGE ──────────────────────
       These priced real quotations under a policy the Board really approved.
       They are read, never recomputed and never reinterpreted: re-deriving
       them under the markup formula would rewrite history to say the company
       quoted prices it never quoted. */
    const co = await company("History");
    await seedHistoricalBandPolicy(co._id, {
      approvalThresholdMarginPercent: "20", estimatedIncomeTaxRatePercent: "25",
    });
    const resolved = await marginPolicy.resolveFor({ companyId: co._id });

    /* Every figure, unchanged, on the record it was approved on. */
    expect(resolved.band.minimumMarginPercent).toBe("18");
    expect(resolved.band.targetMarginPercent).toBe("25");
    expect(resolved.band.preferredMarginPercent).toBe("32");
    expect(resolved.band.approvalThresholdMarginPercent).toBe("20");
    expect(resolved.band.estimatedIncomeTaxRatePercent).toBe("25");

    /* And it still cannot price anything. Readable is not the same as
       applicable, and this record is the first without being the second. */
    expect(resolved.state).toBe("LEGACY_BAND");
    expect(marginPolicy.overlayFor(resolved).floorMarkupPercent).toBeUndefined();
  });

  test("the threshold is retired as an input and still says it was never enforced", async () => {
    /* ── THE HONEST HALF, KEPT ────────────────────────────────────────
       Nothing in this system ever read a threshold. It is gone as an input
       now, but a version that froze one must go on saying it changed
       nothing — otherwise a reader assumes a price below it passed an
       approval that never existed. */
    const co = await company("Threshold");
    await seedHistoricalBandPolicy(co._id, { approvalThresholdMarginPercent: "20" });
    const frozen = marginPolicy.freeze({ resolved: await marginPolicy.resolveFor({ companyId: co._id }) });
    expect(frozen.approvalThresholdMarginPercent).toBe("20");
    expect(frozen.approvalThresholdEnforced).toBe(false);
  });

  test("a new version freezes the markup, the contract and the method", async () => {
    const co = await company("Frozen");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, { floorMarkupPercent: "20" });
    const frozen = marginPolicy.freeze({ resolved: await marginPolicy.resolveFor({ companyId: co._id }) });
    expect(frozen.pricingContract).toBe("MARKUP_FLOOR_V2");
    expect(frozen.floorMarkupPercent).toBe("20");
    /* ── THE FORMULA, NAMED ON THE RECORD ─────────────────────────────
       A version holding a price and a percentage but not the method could be
       re-read years later under either formula, and the two differ by real
       money. */
    expect(frozen.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
    /* Who decided it, and from when. */
    expect(frozen.policyApprovedByName).toBeTruthy();
    expect(frozen.policyEffectiveFrom).toBeTruthy();
    expect(frozen.policyKey).toBe("MARGIN_POLICY");
    /* And no band figures on it, because no band priced it. */
    expect(frozen.minimumMarginPercent).toBeNull();
    expect(frozen.estimatedIncomeTaxRatePercent).toBeNull();
  });
});

/* ═══ 4 · THE LIFECYCLE ═══════════════════════════════════════════════════ */

describe("draft, approval and effective dating", () => {
  test("an approved policy cannot be edited; a change is a new version", async () => {
    const co = await company("Immutable");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    const started = await startDraft(me, co, { margin: MARKUP, rationale: "First." });
    await approveDraft(me, co, started.body.version._id, "2026-04-01");
    const r = await call(`/${KEY}/drafts/${started.body.version._id}`, {
      method: "PUT", token: me.token, company: co._id,
      body: { revision: 1, margin: { floorMarkupPercent: "5" } },
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("BOARD_POLICY_IMMUTABLE");
  });

  test("a future markup does not apply before its date, and does after", async () => {
    const co = await company("Future");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, MARKUP, { effectiveFrom: "2026-04-01" });
    await publish(me, co, { floorMarkupPercent: "35" }, { effectiveFrom: "2026-10-01" });

    /* ── AGAINST THE COSTING'S DATE, NEVER AGAINST NOW ────────────────
       A costing dated in September is priced at September's markup. This is
       what stops a management decision taken in October re-pricing a version
       frozen the month before. */
    const before = await marginPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-09-30") });
    expect(before.floorMarkupPercent).toBe("20");
    const after = await marginPolicy.resolveFor({ companyId: co._id }, { asOf: new Date("2026-10-01") });
    expect(after.floorMarkupPercent).toBe("35");
    /* And the floor moves with it: ₹500 costs ₹600 then and ₹675 after. */
    expect(marginPolicy.floorPriceMinorOn(50000, before.floorMarkupPercent, { increment: 100 })).toBe(60000);
    expect(marginPolicy.floorPriceMinorOn(50000, after.floorMarkupPercent, { increment: 100 })).toBe(67500);
  });

  test("two approvals cannot share an effective date", async () => {
    /* One company, one date, one pricing policy. Two would mean two floors
       for one costing and no way to choose. */
    const co = await company("SameDate");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    expect((await publish(me, co, MARKUP, { effectiveFrom: "2026-04-01" })).status).toBe(200);
    const clash = await publish(me, co, { floorMarkupPercent: "30" }, { effectiveFrom: "2026-04-01" });
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe("BOARD_POLICY_EFFECTIVE_DATE_TAKEN");
  });

  test("a later markup supersedes by date, and both stay readable as approved", async () => {
    const co = await company("Superseding");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, MARKUP, { effectiveFrom: "2026-04-01" });
    await publish(me, co, { floorMarkupPercent: "35" }, { effectiveFrom: "2026-07-01" });
    const hist = await read(me, co);
    expect(hist.body.versions.filter((v) => v.status === "BOARD_APPROVED")).toHaveLength(2);
    expect(effective(hist).margin.floorMarkupPercent).toBe("35");
  });

  test("a superseded markup stays on its own record, unchanged", async () => {
    /* Superseded is not deleted and not edited. The April decision is still
       what April's costings were priced under. */
    const co = await company("Superseded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await publish(me, co, MARKUP, { effectiveFrom: "2026-04-01" });
    await publish(me, co, { floorMarkupPercent: "35" }, { effectiveFrom: "2026-07-01" });
    const hist = await read(me, co);
    const april = hist.body.versions.find((v) => String(v.effectiveFrom).startsWith("2026-04-01"));
    expect(april.margin.floorMarkupPercent).toBe("20");
  });
});

/* ═══ 5 · THE LEGACY DOOR SHOWS HISTORY; IT DOES NOT CONVERT IT ══════════ */

describe("the migration door", () => {
  const withLegacy = (co, over) => CostingPolicy.create({
    companyId: co._id, baseCurrency: "INR", roundingMode: "HALF_UP", revision: 1, ...over,
  });

  test("a legacy band is shown as history, and is NOT offered as a seed", async () => {
    /* ── THE ONE THING THIS DOOR MUST NOT DO ──────────────────────────
       The old band is a margin. The new policy is a markup. Seeding one from
       the other would hand the Board a number to rubber-stamp that means
       something different from what it says, and every floor price in the
       company would move on an inference nobody approved. */
    const co = await company("Legacy");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, {
      minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32",
      estimatedIncomeTaxRatePercent: "25",
    });
    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.status).toBe(200);
    expect(offered.body.available).toBe(false);
    expect(offered.body.margin).toBeNull();
    /* What the company used to do, so the Board can see it while deciding. */
    expect(offered.body.historicalBand).toMatchObject({
      minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32",
    });
  });

  test("the equivalent markup is offered as an UNSIGNED suggestion, labelled as one", async () => {
    /* ── ARITHMETIC, OFFERED AS ARITHMETIC ────────────────────────────
       A 25% margin and a 33.33% markup produce the same price. Showing that
       helps the Board compare; applying it would be a decision nobody took,
       so it is carried with its status on it and it is not seeded anywhere. */
    const co = await company("Suggested");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, {
      minimumMarginPercent: "20", targetMarginPercent: "25", preferredMarginPercent: "32",
    });
    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    const sug = offered.body.suggestion;
    expect(sug.status).toBe("UNAPPROVED_SUGGESTION");
    /* 20% margin → 25% markup; 25% margin → 33.3333% markup. */
    expect(sug.fromMinimumMarginPercent).toBe("25");
    expect(Number(sug.fromTargetMarginPercent)).toBeCloseTo(33.3333, 3);
    expect(sug.note).toMatch(/not a recommendation|not applied until/i);
  });

  test("a draft seeded from the legacy policy carries NO markup at all", async () => {
    /* The Board types the number it means. A draft arriving pre-filled from
       a margin would be exactly the rubber-stamp this migration exists to
       prevent. */
    const co = await company("Seeded");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, {
      minimumMarginPercent: "18", targetMarginPercent: "25", preferredMarginPercent: "32",
    });
    const started = await startDraft(me, co, { seedFrom: "LEGACY_COSTING_POLICY", rationale: "Deciding." });
    expect(started.status).toBe(201);
    expect(started.body.version.status).toBe("DRAFT");
    expect(started.body.version.margin?.floorMarkupPercent).toBeUndefined();
    /* And it cannot be approved until somebody states one. */
    const approved = await approveDraft(me, co, started.body.version._id, "2026-04-01");
    expect(approved.status).toBe(400);
    expect(approved.body.error.details.gaps.map((g) => g.field)).toEqual(["floorMarkupPercent"]);
  });

  test("the schema's all-zero DEFAULT is still not offered", async () => {
    /* ── THE FAILURE THIS WHOLE MIGRATION IS ABOUT ────────────────────
       A company sitting on 0/0/0 has not chosen a nil floor; it has never
       opened the screen. */
    const co = await company("ZeroDefault");
    const me = await actor({ companies: [co], grants: { board: "owner" } });
    await withLegacy(co, {
      minimumMarginPercent: "0", targetMarginPercent: "0", preferredMarginPercent: "0",
    });
    const offered = await call(`/${KEY}/legacy`, { token: me.token, company: co._id });
    expect(offered.body.available).toBe(false);
    expect(offered.body.allZeroDefault).toBe(true);
    expect(offered.body.suggestion).toBeNull();
  });
});

describe("who may decide this", () => {
  test("an administrator with no Board grant reaches nothing", async () => {
    const co = await company("AdminOnly");
    const admin = await actor({ companies: [co], isAdmin: true });
    const r = await read(admin, co);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("BOARD_ACCESS_REQUIRED");
  });

  test("another company's band is not this company's", async () => {
    const mine = await company("Mine");
    const theirs = await company("Theirs");
    const me = await actor({ companies: [mine], grants: { board: "owner" } });
    const them = await actor({ companies: [theirs], grants: { board: "owner" } });
    await publish(them, theirs, BAND);
    expect(effective(await read(me, mine))).toBeNull();
    expect((await marginPolicy.resolveFor({ companyId: mine._id })).state).toBe("POLICY_MISSING");
  });
});

/* ═══ 7 · THE OTHER SIX ARE UNCHANGED ═════════════════════════════════════ */

test("adding a seventh policy changed nothing about the first six", async () => {
  const co = await company("Keys");
  const me = await actor({ companies: [co], grants: { board: "owner" } });
  const r = await call("/vocabulary", { token: me.token, company: co._id });
  expect(r.body.policyKeys).toEqual([
    "FINANCING", "OVERHEAD", "LABOUR_METHODOLOGY", "GST_TAX_POLICY",
    "DEVELOPMENT_CHARGE_POLICY", "CONTINGENCY_POLICY", "MARGIN_POLICY", "DUTY_POLICY",
  ]);
  for (const key of r.body.policyKeys) {
    expect((await call(`/${key}`, { token: me.token, company: co._id })).status).toBe(200);
  }
});
