// test/costing/costing-version.route.test.js
//
// Central Costing — Chunk 2. THE PROTECTED CALCULATION API.
//
// The arithmetic is proved in costing-engine.test.js, without a database.
// This proves the things only the route can be wrong about: who may calculate,
// who may see what came out, that a version is numbered safely when two
// requests race, that a retry does not produce a second one, that history is
// never rewritten, and that importing a Sales costing sheet leaves Sales' own
// data exactly as it was.
"use strict";

process.env.SALARY_ENCRYPTION_KEY = process.env.SALARY_ENCRYPTION_KEY || "0".repeat(64);

const express = require("express");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");

const Employee = require("../../models/Employee");
const { Acc_Company } = require("../../models/Accountant_model/Acc_MasterModels");
const DeptUser = require("../../models/Access/DeptUser");
const DepartmentRole = require("../../models/Access/DepartmentRole");
const SpCompanyMembership = require("../../models/CMS_Models/StorePurchase/SpCompanyMembership");
const Enquiry = require("../../models/CMS_Models/Sales/Enquiry");
const Costing = require("../../models/CMS_Models/Costing/Costing");
const CostingVersion = require("../../models/CMS_Models/Costing/CostingVersion");
const CostingPolicy = require("../../models/CMS_Models/Costing/CostingPolicy");
const capabilityService = require("../../services/centralCosting/capabilities");
const { CAPABILITIES } = capabilityService;

const {
  seedSourceBacked, configureProduction, approveOverheadPolicy, approveMarginPolicy, EXPECTED, prepareForCosting, assembleForCosting } = require("./helpers/sourceBacked");

let server, base, seq = 0;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/costings", require("../../routes/CMS_Routes/Costing/costings"));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}/api/costings`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });
afterEach(() => { jest.restoreAllMocks(); });

const newKey = () => `v-${++seq}-${Math.random().toString(36).slice(2)}`;

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
  }).then(async (r) => {
    const raw = await r.text();
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { nonJson: true }; }
    return {
      status: r.status, body: parsed,
      replayed: r.headers.get("Idempotency-Replayed"),
      recovered: r.headers.get("Idempotency-Recovered"),
    };
  });

const company = (name) =>
  Acc_Company.create({ companyName: `${name} ${++seq}`, booksFromDate: new Date("2026-04-01") });

async function actor({ companies = [], admin = false, grant = null, role = "owner" } = {}) {
  const n = ++seq;
  const email = `chunk2-${n}@test.example`;
  const emp = await Employee.create({
    firstName: "A", lastName: `L${n}`, email, biometricId: `C2${n}`,
    isActive: true, gender: "Other", department: "Tech",
  });
  if (admin) {
    await DeptUser.create({
      name: "Admin", email, passwordHash: "x", isAdmin: true, isActive: true,
      departmentId: new mongoose.Types.ObjectId(), employeeRef: emp._id,
    });
  }
  if (grant) await DepartmentRole.create({ departmentSlug: grant, email, role, isActive: true });
  for (const co of companies) {
    await SpCompanyMembership.create({ companyId: co._id, email, employeeRef: emp._id, personName: "A" });
  }
  return {
    emp, email,
    token: jwt.sign(
      { id: String(emp._id), email, name: "A", role: "employee", employeeId: emp.biometricId },
      process.env.JWT_SECRET || "grav_clothing_secret_key", { expiresIn: "10m" },
    ),
  };
}

const POLICY_BODY = {
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
};

/* Every policy write carries the revision it was composed against — the
   optimistic-concurrency contract, so two editors cannot silently overwrite
   one another. A first write is composed against revision 0, "no policy". */
const policyBody = (revision = 0, over = {}) => ({ ...POLICY_BODY, ...over, revision });

/* ── WHAT THE FIXTURE DOES NOT SUPPLY, AND WHY THESE TWO ARE OVERRIDES ─────
 * The fixture assembles the two families that HAVE a source: the material
 * comes from the technical record priced off its supplier quotation, the
 * operation from the technical record priced off the company's own production
 * assumptions. Nothing is posted for either — a test that typed them would be
 * testing its own arithmetic.
 *
 * Cutting wastage and the pattern-room charge were supplements here — declared
 * overrides for families with "no authoritative record in this repository at
 * all". Development has one now, and the seed states it, so the suite still
 * gets the fixed-cost dilution it needs to exercise. Wastage belongs to the
 * materials family, whose consumption the technical record carries.
 *
 * `SUPPLEMENTS` is the empty list, kept as a name because the call sites read
 * it and a bare `[]` at each would hide that this suite posts nothing. */
const SUPPLEMENTS = [];

const SCENARIOS = [
  { key: "q500", label: "500 pcs", quantity: "500", isPrimary: true },
  { key: "q2000", label: "2000 pcs", quantity: "2000" },
];

/** A company with a policy, an admin actor, and a costing to work on. */
async function setup({ name = "Co" } = {}) {
  const co = await company(name);
  const me = await actor({ companies: [co], admin: true });
  await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: policyBody(0) });
  /* ── AN ADHOC COSTING IS NO LONGER A SHORTCUT ────────────────────────────
     It was two lines and no fixtures, and versions could be built from
     whatever the test posted — the same shortcut a user had, and the reason
     an approvable cost could be produced with no sources behind it. The
     fixture seeds what a real costing needs instead. */
  const seeded = await seedSourceBacked(co._id, { brief: { quantities: SCENARIOS, quantityUom: "Pieces" },
    /* The one-time charge that gives this suite its fixed-cost dilution,
       from the two records that answer it rather than from a typed row. */
    development: { internal: false, unit: "Lot", quantity: 1, rateMinor: 2500000 },
  });
  await configureProduction(co._id);
  const made = await call("/", {
    method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
    body: { context: seeded.context },
  });
  expect(made.status).toBe(201);
  return { co, me, seeded, costingId: made.body.costing.id };
}

/* ── PREPARED THE WAY SALES DOES ──────────────────────────────────────────
   `POST /:id/versions` was the Calculate button and refuses a browser client
   now (`COSTING_PREPARATION_MOVED_TO_SALES`). What these tests prove is about
   the ENGINE, and the engine is unchanged: the orchestration resolves the
   confirmed brief and every source and calls it.

   `lines` never reached the engine even before — the server assembles its own
   rows — so a body carrying only lines goes the Sales way. A body carrying
   anything ELSE is a payload-contract test, and those go to the retired door
   on purpose: its refusal is the contract now. */
const payloadContract = (body = {}) => Object.keys(body).some((k) => k !== "lines")
  /* A NON-EMPTY `lines` is a payload-contract test too. The engine assembles
     its own rows and ignored an empty list, but a list with something in it is
     a client trying to send a figure — which is exactly what those tests
     exist to see refused. */
  || (Array.isArray(body.lines) && body.lines.length > 0);

const calculate = (me, co, costingId, body = { lines: SUPPLEMENTS }, key = newKey()) => (
  payloadContract(body)
    ? call(`/${costingId}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body })
    : prepareForCosting(costingId, { actionKey: key }));

/** The retired door itself, for the tests that are about the door. */
const calculateAsRoute = (me, co, costingId, body = { lines: [] }, key = newKey()) =>
  call(`/${costingId}/versions`, { method: "POST", token: me.token, company: co._id, idempotencyKey: key, body });

/* ═══ 1 · COMPANY POLICY ═════════════════════════════════════════════════ */

describe("company costing policy", () => {
  test("it lives centrally, and only costing.policy.manage may change it", async () => {
    const co = await company("Policy");
    const me = await actor({ companies: [co], admin: true });

    const before = await call("/policy/current", { token: me.token, company: co._id });
    expect(before.status).toBe(200);
    /* ── NULL NOW, NOT "0" ────────────────────────────────────────────
       It read `"0"` with `configured: false`, and the flag was the only thing
       separating "nobody decided" from "we sell at cost" — a zero the ENGINE
       ACCEPTS. The band is a Board decision now and the default is gone: an
       unconfigured company carries nothing, which is what makes a costing
       refuse rather than price at cost. */
    expect(before.body.configured).toBe(false);
    expect(before.body.policy.targetMarginPercent).toBeNull();
    expect(before.body.policy.marginPolicy).toMatchObject({
      editable: false, ownedBy: "BOARD", boardPolicyInForce: false,
    });

    const saved = await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: policyBody(0) });
    expect(saved.status).toBe(200);
    expect(saved.body.policy.revision).toBe(1);

    /* A Sales grant carries costing.output.read only — no policy, and not even
       a read of the band. */
    const sales = await actor({ companies: [co], grant: "sales" });
    const salesRead = await call("/policy/current", { token: sales.token, company: co._id });
    expect(salesRead.status).toBe(403);

    const salesWrite = await call("/policy/current", { method: "PUT", token: sales.token, company: co._id, body: policyBody(1) });
    expect(salesWrite.status).toBe(403);
  });

  test("a cost reader sees the cost rules and not the margin band", async () => {
    const { co, me } = await setup({ name: "PolicySplit" });
    const reader = await actor({ companies: [co] });
    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: [CAPABILITIES.COST_READ], via: ["test"], isAdmin: false });

    const r = await call("/policy/current", { token: reader.token, company: co._id });
    expect(r.status).toBe(200);
    /* ── OVERHEAD IS NOT ONE OF THE COSTING POLICY'S RULES ANY MORE ────
       This company's overhead is an approved Board policy, so the costing
       policy's own field is null and the response says who owns it. What is
       still under test is the SPLIT: a cost reader sees the cost rules and
       not the margin band. */
    expect(r.body.policy.overheadRatePercent).toBeNull();
    expect(r.body.policy.overheadPolicy.ownedBy).toBe("BOARD");
    expect(r.body.policy.overheadPolicy.editable).toBe(false);
    expect(r.body.policy.contingencyRatePercent !== undefined).toBe(true);
    expect(r.body.policy).not.toHaveProperty("targetMarginPercent");
    expect(r.body.visibility.withheld).toContain("marginBand");
    expect(me).toBeTruthy();
  });

  test("a band cannot be set here at all, and nothing is stored", async () => {
    /* ── THIS USED TO ASSERT THE ORDERING RULE ────────────────────────
       It has not been dropped — it moved. `boardPolicy.validateMargin`
       enforces `0 ≤ min ≤ target ≤ preferred < 100` on the way in and
       `marginGaps` enforces it again at approval, both proved in
       `board-margin-policy.test.js`. What this endpoint enforces is that it is
       not a second writer for what the company sells at. */
    const co = await company("BadBand");
    const me = await actor({ companies: [co], admin: true });
    const r = await call("/policy/current", {
      method: "PUT", token: me.token, company: co._id,
      body: policyBody(0, { floorMarkupPercent: "40" }),
    });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("MARGIN_POLICY_MOVED");
    expect(await CostingPolicy.countDocuments({})).toBe(0);
  });

  test("policy is company-scoped and never taken from a payload", async () => {
    const a = await company("PolA");
    const b = await company("PolB");
    const mine = await actor({ companies: [a], admin: true });
    const theirs = await actor({ companies: [b], admin: true });

    await call("/policy/current", { method: "PUT", token: mine.token, company: a._id, body: policyBody(0) });
    const foreign = await call("/policy/current", {
      method: "PUT", token: mine.token, company: a._id,
      body: policyBody(1, { companyId: String(b._id) }),
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.error.code).toBe("TENANT_MISMATCH");

    const theirsRead = await call("/policy/current", { token: theirs.token, company: b._id });
    expect(theirsRead.body.configured).toBe(false);
    expect(await CostingPolicy.countDocuments({ companyId: a._id })).toBe(1);
  });
});

/* ═══ 2 · CALCULATING A VERSION ══════════════════════════════════════════ */

describe("POST /api/costings/:id/versions", () => {
  test("an authorised user gets a costed version, and the parent points at it", async () => {
    const { co, me, seeded, costingId } = await setup({ name: "Calc" });

    const r = await calculate(me, co, costingId);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].versionNumber).toBe(2); // version 1 was the empty draft
    expect(r.body.versions[0].status).toBe("DRAFT");
    expect(r.body.versions[0].calculated).toBe(true);
    expect(r.body.policyConfigured).toBe(true);

    /* ── 400 A GARMENT LESS THAN BEFORE, AND FOR A REASON ────────────
       Material 10000 and labour 354 come off the sources; the setup charge
       adds 5000 a garment at this run size; overhead is 12% of the
       direct-plus-fixed basis.

       The old figures included a further 400 — a 4% cutting-wastage line the
       fixture TYPED. Nothing records a wastage percentage for this style, so
       nothing assembles one, and a costing that no longer carries a number
       nobody could source is the change working rather than a regression. */
    const cost = r.body.versions[0].cost.scenarios.find((s) => s.key === "q500");
    expect(cost.totalCostMinor).toBe(8598240);
    expect(cost.unitCostMinor).toBe(17196);
    expect(cost.fixedPerUnitMinor).toBe(5600);
    const material = r.body.versions[0].cost.inputs.find((l) => l.lineKey === seeded.materialLineKey);
    expect(material.unitRate.amountMinor).toBe(EXPECTED.materialRateMinor);
    expect(material.confidence).toBe("SUPPLIER_QUOTATION");

    /* The pointer moved, atomically with the write. */
    expect(r.body.costing.currentVersion.number).toBe(2);
    const parent = await Costing.findById(costingId).lean();
    expect(parent.currentVersionNumber).toBe(2);
    expect(String(parent.currentVersionId)).toBe(r.body.versions[0].id);
  });

  test("the policy is COPIED into the version, so a later change cannot rewrite history", async () => {
    const { co, me, costingId } = await setup({ name: "Snap" });
    const first = await calculate(me, co, costingId);
    const firstMarkup = first.body.versions[0].margin.band.floorMarkupPercent;
    expect(firstMarkup).toBe("25");

    /* ── THE BOARD RAISES THE TARGET MARGIN ──────────────────────────
       What the company sells for is a Board decision now, so the change that
       could re-price a frozen version is an approval rather than a policy
       save. Dated after the version was frozen, which is the only way a band
       changes — and the frozen copy is still unreachable by it. */
    await approveMarginPolicy(co._id, {
      floorMarkupPercent: "30",
      effectiveFrom: new Date(Date.now() - 1 * 24 * 3600 * 1000),
    });

    const reread = await call(`/${costingId}/versions`, { token: me.token, company: co._id });
    const v2 = reread.body.versions.find((v) => v.versionNumber === 2);
    expect(v2.margin.band.floorMarkupPercent).toBe("25");

    /* And the NEXT calculation uses the new rule — a policy is a standing
       instruction, not a record of an event. */
    const third = await calculate(me, co, costingId);
    expect(third.body.versions[0].margin.band.floorMarkupPercent).toBe("30");

    /* ── THE COSTING POLICY'S REVISION DOES NOT MOVE ──────────────────
       It used to, because the band lived on that row and every change to it
       was a save. The band is a Board decision now with its own version
       history, so raising it leaves this record untouched — and the snapshot
       still carries the revision it was frozen against, which is what makes a
       version traceable to the rules it copied. Asserted rather than dropped:
       a reader comparing the two versions should see WHY the number is the
       same on both. */
    expect(v2.margin.band.policyRevision).toBe(1);
    expect(third.body.versions[0].margin.band.policyRevision).toBe(1);
  });

  test("a calculation never touches an earlier version", async () => {
    const { co, me, costingId, seeded } = await setup({ name: "Freeze" });
    const first = await calculate(me, co, costingId);
    const before = await CostingVersion.findById(first.body.versions[0].id).lean();

    /* A second calculation after Sales added a run size to the brief. It used
       to add a typed packaging row, then a scenario on the payload; the claim
       is unchanged and is the one that matters — the FIRST version is
       untouched by whatever the second one does. */
    const enquiry = await Enquiry.findById(seeded.enquiry._id);
    enquiry.costingBriefs[0].quantities = [
      ...SCENARIOS.map((sc) => ({ ...sc, quantity: String(sc.quantity) })),
      { key: "q9000", label: "9000 pcs", quantity: "9000", isPrimary: false },
    ];
    enquiry.markModified("costingBriefs");
    await enquiry.save();
    await calculate(me, co, costingId, { lines: [] });

    const after = await CostingVersion.findById(first.body.versions[0].id).lean();
    expect(after).toEqual(before);
    const all = await CostingVersion.find({ costingId }).sort({ versionNumber: 1 }).lean();
    expect(all.map((v) => v.versionNumber)).toEqual([1, 2, 3]);
    expect(all[2].provenance.supersedesVersionNumber).toBe(2);
  });

  test("the currency is the company's, and a foreign one on a line is refused", async () => {
    const { co, me, costingId } = await setup({ name: "Curr" });
    const r = await calculate(me, co, costingId, {
      /* ── A PLAIN LINE, NOT AN OVERRIDE ────────────────────────────
         The currency check is in the request parser and applies to any line
         carrying a rate. Sent as an override it would meet the retirement
         refusal first — which is correct, and would stop this test proving
         the thing it is named for. */
      lines: [{
        lineKey: "extra", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag",
        unitRate: { amountMinor: 41250, currency: "USD" }, quantityPerUnit: "1",
      }],
    });
    /* ── AND IT IS REFUSED ONE STEP EARLIER NOW ───────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser rule this test is named for still stands and is
       exercised directly, which is the only way left to hand it a line. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(await CostingVersion.countDocuments({ costingId })).toBe(1);

    const { parseLine } = require("../../services/centralCosting/calculationInput");
    let refused = null;
    try {
      parseLine({
        lineKey: "extra", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag",
        unitRate: { amountMinor: 41250, currency: "USD" }, quantityPerUnit: "1",
      }, 0, "INR", new Set());
    } catch (err) { refused = err; }
    expect(refused.details.reason).toBe("CURRENCY_MISMATCH");
  });

  test("a rateless line never reaches the engine, and no version is written", async () => {
    /* ── WHAT THIS TEST USED TO PROVE, AND WHERE THAT LIVES NOW ───────
       It posted two DECLARED overrides with no rate on either, and asserted
       the engine reported both gaps at once — `INPUTS_INCOMPLETE` with two
       entries — rather than sending somebody back to the form twice.

       That behaviour is the ENGINE's and is unchanged; it is exercised
       directly in `costing-engine.test.js` ("every missing input is reported
       at once"), where it belongs, because the engine can be handed lines
       without a route accepting them.

       What the ROUTE does with these is now the earlier and stricter answer:
       a figure entered by hand is refused before anything is calculated. The
       claim this test still makes, and the one that matters here, is that
       nothing is written when it is. */
    const { co, me, costingId } = await setup({ name: "Missing" });
    const r = await calculate(me, co, costingId, {
      lines: [
        { lineKey: "a", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag", quantityPerUnit: "1.4" },
        { lineKey: "b", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN", label: "Setup" },
      ],
    });
    /* ── AND IT IS REFUSED ONE STEP EARLIER NOW ───────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser rule this test is named for still stands and is
       exercised directly, which is the only way left to hand it a line. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");
    expect(await CostingVersion.countDocuments({ costingId })).toBe(1);

    /* Handed straight to the engine, which is the only way in now — and it
       still names where each line belongs rather than ending the
       conversation. */
    let refused = null;
    try {
      await assembleForCosting(costingId, {
        lines: [
          { lineKey: "a", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag", quantityPerUnit: "1.4" },
          { lineKey: "b", category: "FIXED_SETUP", behaviour: "FIXED_PER_RUN", label: "Setup" },
        ],
      });
    } catch (err) { refused = err; }
    expect(refused.code).toBe("COSTING_MANUAL_LINE_REFUSED");
    expect(refused.details.lineKeys).toEqual(["a", "b"]);
    expect(refused.details.owner.department).toBeTruthy();
    expect(refused.details.remedy).toBe("RECORD_IN_OWNING_APPLICATION");
    expect(await CostingVersion.countDocuments({ costingId })).toBe(1);
  });

  test("a client cannot certify its own cost line", async () => {
    /* `VERIFIED` is a statement that the SERVER checked something against a
       master. Nothing in a request has been checked by anybody, so a payload
       that declares itself verified is refused rather than quietly
       downgraded — a caller that asked for it has to learn it did not happen.

       Stated on a plain line: the parser reaches the confidence check for any
       line, and an override would meet the retirement refusal first. */
    const { co, me, costingId } = await setup({ name: "Certify" });
    const r = await calculate(me, co, costingId, {
      lines: [{
        lineKey: "claimed", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag",
        unitRate: { amountMinor: 1200, currency: "INR" }, quantityPerUnit: "1",
        confidence: "VERIFIED",
      }],
    });
    /* ── AND IT IS REFUSED ONE STEP EARLIER NOW ───────────────────────
       The route reads no body at all: preparing an estimate is a Sales
       action, so a browser client is turned away before the payload is
       looked at. The parser rule this test is named for still stands and is
       exercised directly, which is the only way left to hand it a line. */
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe("COSTING_PREPARATION_MOVED_TO_SALES");

    const { parseLine } = require("../../services/centralCosting/calculationInput");
    let refused = null;
    try {
      parseLine({
        lineKey: "claimed", category: "PACKAGING", behaviour: "PER_UNIT", label: "Polybag",
        unitRate: { amountMinor: 1200, currency: "INR" }, quantityPerUnit: "1",
        confidence: "VERIFIED",
      }, 0, "INR", new Set());
    } catch (err) { refused = err; }
    expect(refused.details.reason).toBe("CONFIDENCE_NOT_CLIENT_SETTABLE");
  });

  test("writing needs costing.draft.write; authentication alone reaches nothing", async () => {
    const { co, costingId } = await setup({ name: "Perm" });
    const nobody = await actor({ companies: [co] });
    /* ── STILL THE ROUTE, DELIBERATELY ────────────────────────────────
       `requireCapability` runs before the handler, so an actor holding no
       grant meets 403 rather than the retirement refusal — which is the
       right order: "you may not do this" outranks "this is done elsewhere",
       and a 409 here would tell somebody unauthorised where to go instead. */
    const r = await calculateAsRoute(nobody, co, costingId);
    expect(r.status).toBe(403);
    expect((await call(`/${costingId}/versions`, { method: "POST", body: { lines: SUPPLEMENTS }, idempotencyKey: newKey() })).status).toBe(401);
  });
});

/* ═══ 3 · WHAT EACH CAPABILITY SEES OF A CALCULATED VERSION ══════════════ */

describe("visibility of a calculated version", () => {
  const withCapabilities = (list) =>
    jest.spyOn(capabilityService, "resolveCapabilities")
      .mockResolvedValue({ capabilities: list, via: ["test"], isAdmin: false });

  test("cost without margin: the build-up, and no prices", async () => {
    const { co, me, seeded, costingId } = await setup({ name: "SeeCost" });
    await calculate(me, co, costingId);

    const reader = await actor({ companies: [co] });
    withCapabilities([CAPABILITIES.COST_READ]);
    const r = await call(`/${costingId}`, { token: reader.token, company: co._id });

    expect(r.status).toBe(200);
    const v = r.body.versions[0];
    expect(v.cost.scenarios[0].unitCostMinor).toBe(17196);
    expect(v.cost.inputs.find((l) => l.lineKey === seeded.materialLineKey).unitRate.amountMinor).toBe(10000);
    expect(v).not.toHaveProperty("margin");
    expect(v).not.toHaveProperty("output");
    /* No price anywhere in the payload, in any form. */
    expect(JSON.stringify(r.body)).not.toContain("23500");
    expect(r.body.visibility.withheld.sort()).toEqual(["margin", "output"]);
  });

  test("margin without cost: the band, and no supplier rate", async () => {
    const { co, me, costingId } = await setup({ name: "SeeMargin" });
    await calculate(me, co, costingId);

    const reader = await actor({ companies: [co] });
    withCapabilities([CAPABILITIES.MARGIN_READ]);
    const r = await call(`/${costingId}`, { token: reader.token, company: co._id });

    const v = r.body.versions[0];
    expect(v.margin.band.floorMarkupPercent).toBe("25");
    expect(v.margin.band.pricingContract).toBe("MARKUP_FLOOR_V2");
    /* ── THE FLOOR'S OWN WORKING, BEHIND `margin.read` ────────────────
       What the garment cost, what the markup added, where it landed. This is
       the block the OUTPUT projection deliberately withholds — a reader
       entitled to quote a price is not entitled to the cost behind it. */
    const floor = v.margin.scenarios[0].floor;
    expect(floor.floorPriceMinor).toBeTruthy();
    expect(floor.floorMarkupPercent).toBe("25");
    expect(floor.calculationMethod).toBe("MARKUP_ON_TRUE_COST");
    /* ── AND NOT THE COST BEHIND IT ────────────────────────────────────
       `margin.read` is the commercial right, not the cost right. The unit
       cost is withheld outright, and so is the markup AMOUNT — floor minus
       markup is the cost, so publishing it would give the build-up away by
       subtraction through a block named after a different permission. */
    expect(floor.trueUnitCostMinor).toBeUndefined();
    expect(floor.markupAmountMinor).toBeUndefined();
    /* And the retired band's readback is empty, not three blank tiers. */
    expect(v.margin.scenarios[0].effective).toEqual({});
    expect(v).not.toHaveProperty("cost");
    /* The fabric rate is a supplier price and must not leak through the margin
       block, the warnings, or anywhere else. */
    expect(JSON.stringify(r.body)).not.toContain("10000");
    expect(JSON.stringify(r.body)).not.toContain("17196");
  });

  test("a Sales-only reader still sees nothing, because nothing is approved", async () => {
    const { co, me, costingId } = await setup({ name: "SalesBlind" });
    await calculate(me, co, costingId);

    const sales = await actor({ companies: [co], grant: "sales" });
    const detail = await call(`/${costingId}`, { token: sales.token, company: co._id });
    const missing = await call(`/${new mongoose.Types.ObjectId()}`, { token: sales.token, company: co._id });
    expect(detail.status).toBe(404);
    expect(detail.body).toEqual(missing.body);
    expect((await call("/", { token: sales.token, company: co._id })).body.costings).toEqual([]);
  });

  test("everybody still sees that the inputs were provisional", async () => {
    const { co, me, costingId } = await setup({ name: "Prov" });
    await calculate(me, co, costingId);
    const reader = await actor({ companies: [co] });
    withCapabilities([CAPABILITIES.MARGIN_READ]);
    const r = await call(`/${costingId}`, { token: reader.token, company: co._id });
    const w = r.body.versions[0].warnings.find((x) => x.code === "PROVISIONAL_INPUTS");
    expect(w).toBeTruthy();
    /* The names of the provisional lines are cost detail, and are not here. */
    expect(w).not.toHaveProperty("lineKeys");
  });
});

/* ═══ 4 · TENANCY ═══════════════════════════════════════════════════════ */

describe("company boundary", () => {
  test("another company cannot calculate on, or read, this costing", async () => {
    const { co, me, costingId } = await setup({ name: "TenantA" });
    await calculate(me, co, costingId);

    const other = await company("TenantB");
    const stranger = await actor({ companies: [other], admin: true });

    /* ── THROUGH THE ROUTE, BECAUSE THE ROUTE IS WHERE A STRANGER KNOCKS ─
       `prepareForCosting` reads the company off the costing, so it cannot
       express "somebody from another company asked". The route can, and its
       company scoping runs before the retirement refusal — a foreign costing
       is missing, which is the same answer a costing that never existed
       gets. That the ORCHESTRATION refuses across a tenancy is asserted in
       `sales-estimate-preparation.test.js`. */
    const write = await calculateAsRoute(stranger, other, costingId);
    const read = await call(`/${costingId}/versions`, { token: stranger.token, company: other._id });
    const missing = await call(`/${new mongoose.Types.ObjectId()}/versions`, { token: stranger.token, company: other._id });

    expect(write.status).toBe(404);
    expect(read.status).toBe(404);
    expect(read.body).toEqual(missing.body);
    expect(await CostingVersion.countDocuments({ companyId: other._id })).toBe(0);
  });
});

/* ═══ 5 · NUMBERING AND RETRIES ═════════════════════════════════════════ */

describe("version numbering", () => {
  test("concurrent calculations get distinct, consecutive numbers", async () => {
    const { co, me, costingId } = await setup({ name: "Race" });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => calculate(me, co, costingId)),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);

    const numbers = (await CostingVersion.find({ costingId }).sort({ versionNumber: 1 }).lean())
      .map((v) => v.versionNumber);
    /* Version 1 is the empty draft the costing was created with. */
    expect(numbers).toEqual([1, 2, 3, 4, 5, 6]);

    /* The pointer only ever moves forward, so a late writer cannot drag the
       costing back to a version that is no longer the newest. */
    const parent = await Costing.findById(costingId).lean();
    expect(parent.currentVersionNumber).toBe(6);
  });

  /* ══════════════════════════════════════════════════════════════════════
   * THREE TESTS ABOUT THE HTTP IDEMPOTENCY MIDDLEWARE USED TO SIT HERE
   *
   *   · a retry replays instead of calculating again
   *   · a lost response does not become a second version
   *   · the same key with a different calculation is a conflict
   *
   * They drove `POST /:id/versions` with one `Idempotency-Key` twice and read
   * the `Idempotency-Replayed` and `Idempotency-Recovered` headers, including
   * the case where the version commits and the bookkeeping that protects it
   * fails afterwards.
   *
   * That door refuses a browser client now, so the middleware behind it can no
   * longer be reached with a calculation. The guarantees did not go with it —
   * they moved to the orchestration, and they are asserted against it in
   * `sales-estimate-preparation.test.js`:
   *
   *   · an identical ask returns the version that exists rather than making a
   *     second, under the same key AND under a different one — the
   *     orchestration decides on the resolved source fingerprint, which is a
   *     stronger test than a key, because it also covers two people asking;
   *   · the costing and its first version are written under a creation claim
   *     with a unique partial index, so a lost response cannot become a
   *     second costing even if the bookkeeping write fails;
   *   · an approved version is never restated or superseded in place.
   *
   * The middleware itself is still exercised, on the routes that still take a
   * write: `legacy-import`, `submit` and `approve` below.
   * ═══════════════════════════════════════════════════════════════════════ */

});

/* ═══ 6 · LEGACY IMPORT ═════════════════════════════════════════════════ */

describe("importing a Sales costing sheet", () => {
  async function enquiryCosting(name) {
    const co = await company(name);
    const me = await actor({ companies: [], admin: true }); // single-company deployment
    await call("/policy/current", { method: "PUT", token: me.token, company: co._id, body: policyBody(0) });
    /* The 12% the assertion below adds. It is a Board policy now, so the
       fixture approves one instead of the policy body carrying a rate the
       endpoint refuses — same rate, same basis, same figure. */
    await approveOverheadPolicy(co._id);
    /* And the margin band, for the same reason and one more: without an
       approved band there is no price to solve for, so a legacy import cannot
       freeze a version at all. 18/25/32 is the band this suite's policy body
       used to carry, so every figure it asserts is unchanged. */
    await approveMarginPolicy(co._id);

    const enq = await Enquiry.create({
      enquiryId: `ENQ-${++seq}`,
      journeyId: new mongoose.Types.ObjectId(),
      accountId: new mongoose.Types.ObjectId(),
      title: "Staff uniforms",
      products: [{ product: "Blazer" }],
      isActive: true,
      costingSheets: [
        { productName: "Blazer", part: "raw",
          materials: [
            { item: "Cotton twill", unitCost: "412.50", consumption: "1.4", unit: "m", vendor: "Acme" },
            { item: "Lining", unitCost: "", consumption: "0.8", unit: "m" },
          ],
          miscellaneous: [{ name: "Testing", price: "25" }] },
        { productName: "Blazer", part: "operations",
          operations: [{ detail: "Stitching", sam: "18", rate: "9" }] },
      ],
    });

    const made = await call("/", {
      method: "POST", token: me.token, company: co._id, idempotencyKey: newKey(),
      body: { context: { type: "ENQUIRY_STYLE", primaryId: String(enq._id), externalKey: "Blazer" } },
    });
    expect(made.status).toBe(201);
    return { co, me, enq, costingId: made.body.costing.id };
  }

  const importIt = (me, co, costingId, key = newKey()) =>
    call(`/${costingId}/versions/legacy-import`, {
      method: "POST", token: me.token, company: co._id, idempotencyKey: key,
      body: { scenarios: [{ key: "q500", quantity: "500", isPrimary: true }] },
    });

  test("legacy rows become a frozen version, and Sales' own data is untouched", async () => {
    const { co, me, enq, costingId } = await enquiryCosting("Legacy");
    const before = await Enquiry.findById(enq._id).lean();

    const r = await importIt(me, co, costingId);
    expect(r.status).toBe(201);
    expect(r.body.versions[0].provenance.origin).toBe("LEGACY_IMPORT");
    /* 57,750 fabric + 16,200 stitching + 2,500 testing = 76,450, +12% = 85,624 */
    expect(r.body.versions[0].cost.scenarios[0].unitCostMinor).toBe(85624);
    expect(r.body.versions[0].cost.inputs.every((l) => l.confidence === "PROVISIONAL")).toBe(true);

    /* THE PRESERVATION REQUIREMENT: read, never written. */
    const after = await Enquiry.findById(enq._id).lean();
    expect(after).toEqual(before);
  });

  test("a row whose price cannot be read is reported, never imported as free", async () => {
    const { co, me, costingId } = await enquiryCosting("Unreadable");
    const r = await importIt(me, co, costingId);
    expect(r.body.import.unmapped).toEqual([
      expect.objectContaining({ label: "Lining", reason: "UNIT_COST_UNREADABLE" }),
    ]);
    expect(r.body.versions[0].cost.inputs.find((l) => l.label === "Lining")).toBeUndefined();
  });

  test("importing the same sheet twice does not create a second version", async () => {
    const { co, me, costingId } = await enquiryCosting("Twice");
    const first = await importIt(me, co, costingId);
    const second = await importIt(me, co, costingId); // a different idempotency key

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.recovered).toBe(true);
    expect(second.body.versions[0].id).toBe(first.body.versions[0].id);
    expect(await CostingVersion.countDocuments({ costingId })).toBe(2); // draft + import
  });

  test("an EDITED sheet is a new version, because the numbers changed", async () => {
    const { co, me, enq, costingId } = await enquiryCosting("Edited");
    await importIt(me, co, costingId);

    await Enquiry.updateOne(
      { _id: enq._id },
      { $set: { "costingSheets.0.materials.0.unitCost": "420.00" } },
    );

    const second = await importIt(me, co, costingId);
    expect(second.status).toBe(201);
    expect(second.body.recovered).toBe(false);
    expect(second.body.versions[0].versionNumber).toBe(3);
    expect(await CostingVersion.countDocuments({ costingId })).toBe(3);
  });

  test("the source is described without importing it", async () => {
    const { co, me, costingId } = await enquiryCosting("Describe");
    const r = await call(`/${costingId}/legacy-source`, { token: me.token, company: co._id });
    expect(r.body.legacySource).toMatchObject({
      available: true, productName: "Blazer",
      rowCounts: { materials: 2, operations: 1, miscellaneous: 1 },
    });
    expect(await CostingVersion.countDocuments({ costingId })).toBe(1);
  });
});
